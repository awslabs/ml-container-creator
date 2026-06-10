// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Path Prover Brain Lambda
 *
 * Handles three actions for the Path Prover state machine:
 * - getNextConfig: Initial brain call to get the first config to prove
 * - pickNext: After a prove iteration, decides next or done
 * - classifyFailure: On error, classify and return structured result
 *
 * Budget controls: MAX_PROVES_PER_RUN (default 10), MAX_COST_PER_RUN (default 100 USD)
 *
 * Requirements: 8.1, 8.7, 8.8
 */

/**
 * Configuration dimensions used for gap identification.
 */
const CONFIG_DIMENSIONS = [
    'deployment_config',
    'model_family',
    'instance_family',
    'quantization',
    'tp_degree',
    'deployment_target'
]

/**
 * Error pattern matchers for failure classification.
 */
const ERROR_PATTERNS: Array<{ pattern: RegExp; category: string; retryable: boolean }> = [
    { pattern: /InsufficientInstanceCapacity/i, category: 'capacity', retryable: true },
    { pattern: /CapacityError/i, category: 'capacity', retryable: true },
    { pattern: /no capacity/i, category: 'capacity', retryable: true },
    { pattern: /timed?\s*out/i, category: 'timeout', retryable: true },
    { pattern: /timeout/i, category: 'timeout', retryable: true },
    { pattern: /deadline exceeded/i, category: 'timeout', retryable: true },
    { pattern: /OutOfMemory/i, category: 'oom', retryable: false },
    { pattern: /OOM/i, category: 'oom', retryable: false },
    { pattern: /CUDA out of memory/i, category: 'oom', retryable: false },
    { pattern: /Cannot allocate memory/i, category: 'oom', retryable: false },
    { pattern: /template.*error/i, category: 'code_bug', retryable: false },
    { pattern: /SyntaxError/i, category: 'code_bug', retryable: false },
    { pattern: /ReferenceError/i, category: 'code_bug', retryable: false },
    { pattern: /not supported.*model/i, category: 'model_incompatibility', retryable: false },
    { pattern: /model.*incompatible/i, category: 'model_incompatibility', retryable: false },
    { pattern: /LoRA.*not supported/i, category: 'model_incompatibility', retryable: false },
    { pattern: /not available.*region/i, category: 'service_limitation', retryable: false },
    { pattern: /service.*not supported/i, category: 'service_limitation', retryable: false },
    { pattern: /ValidationException/i, category: 'service_limitation', retryable: false }
]

/**
 * Approximate cost per hour for common instance families (USD).
 * Used for budget estimation.
 */
const INSTANCE_COST_PER_HOUR: Record<string, number> = {
    'g5': 1.21,
    'g6': 0.98,
    'g6e': 1.32,
    'p4d': 32.77,
    'p5': 65.00,
    'trn2': 21.50,
    'inf2': 1.58,
    'ml.g5.xlarge': 1.21,
    'ml.g5.2xlarge': 1.52,
    'ml.g5.12xlarge': 7.09,
    'ml.g5.48xlarge': 20.09
}

/**
 * Estimated hours per prove run (generate+build+deploy+test+benchmark+clean).
 */
const ESTIMATED_HOURS_PER_PROVE = 1.5

interface BrainEvent {
    action: string
    iteration?: number
    budgetSpent?: number
    maxProvesPerRun?: number
    maxCostPerRun?: number
    previousResults?: Array<Record<string, unknown>>
    currentConfig?: Record<string, unknown>
    lastResult?: string
    classification?: Record<string, unknown>
    error?: Record<string, unknown>
    config?: Record<string, unknown>
}

interface BrainResponse {
    done?: boolean
    reason?: string
    next?: Record<string, unknown>
    tuneRequested?: boolean
    iteration?: number
    budgetSpent?: number
    previousResults?: Array<Record<string, unknown>>
}

interface ClassificationResult {
    stage: string
    category: string
    retryable: boolean
}

export async function handler(event: BrainEvent): Promise<BrainResponse | ClassificationResult> {
    const action = event.action

    switch (action) {
        case 'getNextConfig':
            return handleGetNextConfig(event)
        case 'pickNext':
            return handlePickNext(event)
        case 'classifyFailure':
            return handleClassifyFailure(event)
        default:
            throw new Error(`Unknown action: ${action}`)
    }
}

/**
 * getNextConfig: Called at the start of the state machine.
 * Returns the first config to prove or {done: true} if nothing to do.
 */
function handleGetNextConfig(event: BrainEvent): BrainResponse {
    const iteration = event.iteration ?? 0
    const budgetSpent = event.budgetSpent ?? 0
    const maxProvesPerRun = event.maxProvesPerRun ?? 10
    const maxCostPerRun = event.maxCostPerRun ?? 100

    // Check budget before starting
    if (iteration >= maxProvesPerRun) {
        return { done: true, reason: 'max_proves_reached' }
    }
    if (budgetSpent >= maxCostPerRun) {
        return { done: true, reason: 'budget_exceeded' }
    }

    // In a real implementation, this would query Athena for gaps.
    // The prove request configs come from the execution input's
    // previousResults/gap list. For the state machine orchestration,
    // the initial config is passed in the execution input.
    const previousResults = event.previousResults ?? []

    // If there's no work to do (no gaps identified), we're done
    if (previousResults.length === 0 && iteration === 0) {
        return { done: true, reason: 'all_gaps_filled' }
    }

    // Get next unproven config from the list
    const nextConfig = getNextUnprovenConfig(previousResults, iteration)
    if (!nextConfig) {
        return { done: true, reason: 'all_gaps_filled' }
    }

    // Determine if tune stages are needed
    const tuneRequested = shouldExecuteTuneStages(nextConfig)

    return {
        done: false,
        next: nextConfig,
        tuneRequested,
        iteration: iteration + 1,
        budgetSpent: budgetSpent + estimateCost(nextConfig)
    }
}

/**
 * pickNext: Called after a prove iteration (success or failure).
 * Decides whether to continue or stop.
 */
function handlePickNext(event: BrainEvent): BrainResponse {
    const iteration = event.iteration ?? 1
    const budgetSpent = event.budgetSpent ?? 0
    const maxProvesPerRun = event.maxProvesPerRun ?? 10
    const maxCostPerRun = event.maxCostPerRun ?? 100
    const previousResults = event.previousResults ?? []

    // Update iteration count
    const newIteration = iteration + 1

    // Check budget controls
    if (newIteration > maxProvesPerRun) {
        return { done: true, reason: 'max_proves_reached' }
    }

    // Estimate cost of next prove and check budget
    const nextConfig = getNextUnprovenConfig(previousResults, newIteration - 1)
    if (!nextConfig) {
        return { done: true, reason: 'all_gaps_filled' }
    }

    const estimatedNextCost = estimateCost(nextConfig)
    if (budgetSpent + estimatedNextCost > maxCostPerRun) {
        return { done: true, reason: 'budget_exceeded' }
    }

    // Determine if tune stages are needed
    const tuneRequested = shouldExecuteTuneStages(nextConfig)

    return {
        done: false,
        next: nextConfig,
        tuneRequested,
        iteration: newIteration,
        budgetSpent: budgetSpent + estimatedNextCost,
        previousResults
    }
}

/**
 * classifyFailure: Parse error output and classify into a category.
 */
function handleClassifyFailure(event: BrainEvent): ClassificationResult {
    const error = event.error
    if (!error) {
        return { stage: 'unknown', category: 'code_bug', retryable: false }
    }

    // Extract error message
    let errorMsg = ''
    if (typeof error === 'string') {
        errorMsg = error
    } else {
        errorMsg = (error as Record<string, string>).Cause
            || (error as Record<string, string>).Error
            || JSON.stringify(error)
    }

    // Detect stage
    const stage = detectStage(errorMsg)

    // Match against patterns
    for (const { pattern, category, retryable } of ERROR_PATTERNS) {
        if (pattern.test(errorMsg)) {
            return { stage, category, retryable }
        }
    }

    return { stage, category: 'code_bug', retryable: false }
}

/**
 * Detect which lifecycle stage produced an error from the error message.
 */
function detectStage(errorMsg: string): string {
    const stagePatterns: Array<{ pattern: RegExp; stage: string }> = [
        { pattern: /\b(generate|generation)\b/i, stage: 'generate' },
        { pattern: /\b(build|docker)\b/i, stage: 'build' },
        { pattern: /\b(push|ecr|registry)\b/i, stage: 'push' },
        { pattern: /\b(deploy|endpoint|CreateEndpoint)\b/i, stage: 'deploy' },
        { pattern: /\b(test|invoke|invocation)\b/i, stage: 'test' },
        { pattern: /\b(tune|fine-?tun|customization)\b/i, stage: 'tune' },
        { pattern: /\b(adapter|lora)\b/i, stage: 'adapter' },
        { pattern: /\b(benchmark|bench)\b/i, stage: 'benchmark' },
        { pattern: /\b(clean|delete)\b/i, stage: 'clean' }
    ]

    for (const { pattern, stage } of stagePatterns) {
        if (pattern.test(errorMsg)) {
            return stage
        }
    }

    return 'unknown'
}

/**
 * Get the next unproven config from the list.
 */
function getNextUnprovenConfig(
    configs: Array<Record<string, unknown>>,
    index: number
): Record<string, unknown> | null {
    if (!configs || index >= configs.length) {
        return null
    }
    return configs[index] ?? null
}

/**
 * Determine whether tune/adapter stages should execute.
 */
function shouldExecuteTuneStages(config: Record<string, unknown>): boolean {
    if (!config) return false
    if (config.include_tuning === true) return true
    if (config.enable_lora === true) return true
    if (config.tune_technique && config.tune_technique !== 'none') return true
    return false
}

/**
 * Estimate cost of a prove run based on instance family.
 */
function estimateCost(config: Record<string, unknown>): number {
    const instanceFamily = String(config.instance_family ?? 'g5')
    const instanceType = String(config.instance_type ?? '')

    // Try specific instance type first, then family
    const costPerHour = INSTANCE_COST_PER_HOUR[instanceType]
        ?? INSTANCE_COST_PER_HOUR[instanceFamily]
        ?? 2.0 // Default fallback

    return costPerHour * ESTIMATED_HOURS_PER_PROVE
}
