// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Stage Helpers
 *
 * Extracted logic from the CodeBuild buildspec and `do/ci` bash templates
 * into testable JavaScript functions. These functions mirror the bash
 * implementations for stage result parsing, skip logic, error summary
 * extraction, and structure validation.
 *
 * Used by unit and property-based tests to validate CI stage result
 * behavior without executing the bash template directly.
 */

/**
 * The ordered list of lifecycle stages executed in CodeBuild.
 */
export const STAGE_ORDER = [
    'generate',
    'validate',
    'build',
    'deploy_test',
    'register',
    'teardown',
    'update'
]

/**
 * Stages that always execute regardless of prior failures.
 * Teardown cleans up resources; Update writes results to DynamoDB.
 */
export const ALWAYS_RUN_STAGES = ['teardown', 'update']

/**
 * Parse a DynamoDB-format stageResults map into plain JavaScript objects.
 *
 * DynamoDB maps use typed descriptors like { S: "pass" }, { N: "12" }.
 * This function converts them to plain values.
 *
 * @param {object} stageResultsMap - DynamoDB map format, e.g.
 *   { generate: { M: { status: { S: "pass" }, durationSeconds: { N: "12" }, ... } } }
 * @returns {object} Plain object, e.g.
 *   { generate: { status: "pass", durationSeconds: 12, logPointer: "...", errorSummary: "" } }
 */
export function parseStageResults(stageResultsMap) {
    if (!stageResultsMap || typeof stageResultsMap !== 'object') {
        return {}
    }

    const result = {}

    for (const [stageName, stageValue] of Object.entries(stageResultsMap)) {
        // Handle DynamoDB M (map) wrapper
        const inner = stageValue && stageValue.M ? stageValue.M : stageValue

        if (!inner || typeof inner !== 'object') {
            result[stageName] = {
                status: 'unknown',
                durationSeconds: 0,
                logPointer: '',
                errorSummary: ''
            }
            continue
        }

        result[stageName] = {
            status: extractString(inner.status, 'unknown'),
            durationSeconds: extractNumber(inner.durationSeconds, 0),
            logPointer: extractString(inner.logPointer, ''),
            errorSummary: extractString(inner.errorSummary, '')
        }
    }

    return result
}

/**
 * Compute the overall test status from parsed stage results.
 *
 * Returns 'pass' if all stages passed or were skipped.
 * Returns 'fail-{stageName}' where stageName is the first failing stage
 * in execution order.
 *
 * @param {object} stageResults - Parsed stage results (plain objects)
 * @returns {string} 'pass' or 'fail-{first failing stage}'
 */
export function computeTestStatus(stageResults) {
    if (!stageResults || typeof stageResults !== 'object') {
        return 'pass'
    }

    for (const stage of STAGE_ORDER) {
        const result = stageResults[stage]
        if (result && result.status === 'fail') {
            return `fail-${stage}`
        }
    }

    return 'pass'
}

/**
 * Apply skip logic to stage results after a failure.
 *
 * When a stage fails, all subsequent stages (except teardown and update)
 * are marked as 'skip' with durationSeconds=0. Teardown and update
 * always execute.
 *
 * @param {object} stageResults - Mutable parsed stage results object
 * @param {string} failedStage - The name of the stage that failed
 * @returns {object} The modified stageResults (same reference)
 */
export function applySkipLogic(stageResults, failedStage) {
    if (!failedStage || !stageResults) {
        return stageResults || {}
    }

    const failedIndex = STAGE_ORDER.indexOf(failedStage)
    if (failedIndex === -1) {
        return stageResults
    }

    // Skip all stages after the failed one, except always-run stages
    for (let i = failedIndex + 1; i < STAGE_ORDER.length; i++) {
        const stage = STAGE_ORDER[i]
        if (ALWAYS_RUN_STAGES.includes(stage)) {
            continue
        }
        stageResults[stage] = {
            status: 'skip',
            durationSeconds: 0,
            logPointer: '',
            errorSummary: ''
        }
    }

    return stageResults
}

/**
 * Validate that a stageResults object has the correct structure.
 *
 * A valid stageResults map must contain exactly 7 entries (one per
 * lifecycle stage) and each entry must have the required fields:
 * status, durationSeconds, logPointer.
 *
 * @param {object} stageResults - Parsed stage results to validate
 * @returns {object} Validation result
 * @returns {boolean} return.valid - Whether the structure is valid
 * @returns {string[]} return.errors - Array of validation error messages
 */
export function validateStageResultStructure(stageResults) {
    const errors = []

    if (!stageResults || typeof stageResults !== 'object') {
        return { valid: false, errors: ['stageResults is null or not an object'] }
    }

    const stageKeys = Object.keys(stageResults)

    // Check for exactly 7 entries
    if (stageKeys.length !== 7) {
        errors.push(`Expected 7 stage entries, found ${stageKeys.length}`)
    }

    // Check all required stages are present
    for (const stage of STAGE_ORDER) {
        if (!(stage in stageResults)) {
            errors.push(`Missing required stage: ${stage}`)
        }
    }

    // Check for unexpected stages
    for (const key of stageKeys) {
        if (!STAGE_ORDER.includes(key)) {
            errors.push(`Unexpected stage: ${key}`)
        }
    }

    // Validate each stage entry has required fields
    for (const stage of STAGE_ORDER) {
        const entry = stageResults[stage]
        if (!entry) continue

        if (!('status' in entry)) {
            errors.push(`Stage '${stage}' missing required field: status`)
        } else if (!['pass', 'fail', 'skip'].includes(entry.status)) {
            errors.push(`Stage '${stage}' has invalid status: '${entry.status}'`)
        }

        if (!('durationSeconds' in entry)) {
            errors.push(`Stage '${stage}' missing required field: durationSeconds`)
        } else if (typeof entry.durationSeconds !== 'number' || entry.durationSeconds < 0) {
            errors.push(`Stage '${stage}' has invalid durationSeconds: ${entry.durationSeconds}`)
        }

        if (!('logPointer' in entry)) {
            errors.push(`Stage '${stage}' missing required field: logPointer`)
        }

        // errorSummary is required when status is 'fail'
        if (entry.status === 'fail' && !('errorSummary' in entry)) {
            errors.push(`Stage '${stage}' has status 'fail' but missing errorSummary`)
        }

        // errorSummary must be at most 500 characters
        if (entry.errorSummary && entry.errorSummary.length > 500) {
            errors.push(`Stage '${stage}' errorSummary exceeds 500 characters (${entry.errorSummary.length})`)
        }
    }

    return { valid: errors.length === 0, errors }
}

/**
 * Extract error summaries from stage results for display.
 *
 * Returns an array of { stage, errorSummary } for all stages that failed.
 *
 * @param {object} stageResults - Parsed stage results
 * @returns {object[]} Array of { stage: string, errorSummary: string }
 */
export function extractErrorSummaries(stageResults) {
    if (!stageResults || typeof stageResults !== 'object') {
        return []
    }

    const summaries = []
    for (const stage of STAGE_ORDER) {
        const entry = stageResults[stage]
        if (entry && entry.status === 'fail' && entry.errorSummary) {
            summaries.push({
                stage,
                errorSummary: entry.errorSummary
            })
        }
    }
    return summaries
}

// --- Internal helpers ---

/**
 * Extract a string value from a DynamoDB typed descriptor or plain value.
 * @param {*} value - Either { S: "string" } or a plain string
 * @param {string} defaultValue - Default if value is missing
 * @returns {string}
 */
function extractString(value, defaultValue) {
    if (value === undefined || value === null) return defaultValue
    if (typeof value === 'string') return value
    if (value.S !== undefined) return value.S
    return defaultValue
}

/**
 * Extract a number value from a DynamoDB typed descriptor or plain value.
 * @param {*} value - Either { N: "12" } or a plain number
 * @param {number} defaultValue - Default if value is missing
 * @returns {number}
 */
function extractNumber(value, defaultValue) {
    if (value === undefined || value === null) return defaultValue
    if (typeof value === 'number') return value
    if (value.N !== undefined) return Number(value.N)
    return defaultValue
}
