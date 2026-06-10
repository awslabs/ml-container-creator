// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Path Prover Brain
 *
 * Implements the intelligence layer for the Path Prover agent mode.
 * This module identifies coverage gaps, finds nearest substitutions,
 * classifies failures, gates tune/adapter stages, and builds
 * Athena-compatible records with run_type='path_prove'.
 *
 * Feature: ci-benchmark-pipeline
 * Requirements: 8.1–8.12
 */

// ── Configuration Dimensions ─────────────────────────────────────────────────

/**
 * The ordered vector of config dimensions used for Hamming distance calculation.
 */
export const CONFIG_DIMENSIONS = [
    'deployment_config',
    'model_family',
    'instance_family',
    'quantization',
    'tp_degree',
    'deployment_target'
];

// ── Failure Classification ───────────────────────────────────────────────────

/**
 * Valid failure categories for Path Prover classification.
 */
export const FAILURE_CATEGORIES = [
    'capacity',
    'timeout',
    'oom',
    'code_bug',
    'model_incompatibility',
    'service_limitation'
];

/**
 * Error pattern matchers for failure classification.
 * Each entry maps a regex pattern to a category and retryable flag.
 */
const ERROR_PATTERNS = [
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
    { pattern: /killed.*memory/i, category: 'oom', retryable: false },
    { pattern: /template.*error/i, category: 'code_bug', retryable: false },
    { pattern: /SyntaxError/i, category: 'code_bug', retryable: false },
    { pattern: /ReferenceError/i, category: 'code_bug', retryable: false },
    { pattern: /TypeError/i, category: 'code_bug', retryable: false },
    { pattern: /script crash/i, category: 'code_bug', retryable: false },
    { pattern: /rendering failed/i, category: 'code_bug', retryable: false },
    { pattern: /not supported.*model/i, category: 'model_incompatibility', retryable: false },
    { pattern: /model.*incompatible/i, category: 'model_incompatibility', retryable: false },
    { pattern: /unsupported.*architecture/i, category: 'model_incompatibility', retryable: false },
    { pattern: /LoRA.*not supported/i, category: 'model_incompatibility', retryable: false },
    { pattern: /adapter.*not compatible/i, category: 'model_incompatibility', retryable: false },
    { pattern: /not available.*region/i, category: 'service_limitation', retryable: false },
    { pattern: /service.*not supported/i, category: 'service_limitation', retryable: false },
    { pattern: /API.*not available/i, category: 'service_limitation', retryable: false },
    { pattern: /feature.*not.*region/i, category: 'service_limitation', retryable: false },
    { pattern: /ValidationException/i, category: 'service_limitation', retryable: false }
];

// ── Gap Identification (Task 5.1) ────────────────────────────────────────────

/**
 * Identify coverage gaps given a set of proven configurations.
 *
 * A "gap" is a config dimension combination that has no records in Athena.
 * This function compares the known dimension space (all unique values seen
 * across proven configs) against what is actually proven, and returns
 * combinations that are missing.
 *
 * @param {object[]} provenConfigs - Array of proven config objects from Athena
 *   Each object must have keys matching CONFIG_DIMENSIONS plus `status`
 * @returns {object[]} Ordered list of gap configs to prove, sorted by
 *   coverage priority (more neighbors proven = higher priority)
 */
export function identifyGaps(provenConfigs) {
    if (!provenConfigs || provenConfigs.length === 0) {
        return [];
    }

    // Extract unique values for each dimension from proven configs
    const dimensionValues = {};
    for (const dim of CONFIG_DIMENSIONS) {
        const values = new Set();
        for (const config of provenConfigs) {
            if (config[dim] !== undefined && config[dim] !== null) {
                values.add(String(config[dim]));
            }
        }
        dimensionValues[dim] = [...values];
    }

    // Build a set of proven config signatures for fast lookup
    const provenSignatures = new Set();
    for (const config of provenConfigs) {
        if (config.status === 'completed') {
            const sig = CONFIG_DIMENSIONS.map(d => String(config[d] ?? '')).join('|');
            provenSignatures.add(sig);
        }
    }

    // Generate all combinations from observed values and find gaps
    const gaps = [];
    const combinations = cartesianProduct(dimensionValues);

    for (const combo of combinations) {
        const sig = CONFIG_DIMENSIONS.map(d => String(combo[d] ?? '')).join('|');
        if (!provenSignatures.has(sig)) {
            // Count how many neighbors (distance=1) are proven — higher = more valuable
            let neighborCount = 0;
            for (const provenSig of provenSignatures) {
                const provenParts = provenSig.split('|');
                const comboParts = sig.split('|');
                let diff = 0;
                for (let i = 0; i < provenParts.length; i++) {
                    if (provenParts[i] !== comboParts[i]) diff++;
                }
                if (diff === 1) neighborCount++;
            }
            gaps.push({ ...combo, _neighborCount: neighborCount });
        }
    }

    // Sort by neighbor count descending (most surrounded gaps first)
    gaps.sort((a, b) => b._neighborCount - a._neighborCount);

    // Remove internal sorting field before returning
    return gaps.map(({ _neighborCount, ...config }) => config);
}

/**
 * Generate cartesian product of dimension value arrays.
 * @param {object} dimensionValues - Map of dimension name to array of values
 * @returns {object[]} Array of config objects representing all combinations
 */
function cartesianProduct(dimensionValues) {
    const dims = CONFIG_DIMENSIONS;
    const results = [];

    function generate(index, current) {
        if (index === dims.length) {
            results.push({ ...current });
            return;
        }
        const dim = dims[index];
        const values = dimensionValues[dim] || [];
        if (values.length === 0) {
            generate(index + 1, current);
            return;
        }
        for (const val of values) {
            current[dim] = val;
            generate(index + 1, current);
        }
    }

    generate(0, {});
    return results;
}

// ── Substitution Algorithm (Task 5.2) ────────────────────────────────────────

/**
 * Find the nearest proven substitution for a requested configuration.
 *
 * Uses Hamming distance on the config dimension vector. Only considers
 * configs with status='completed'. Never crosses the model_family boundary.
 *
 * @param {object} requestedConfig - The requested config with dimension fields
 * @param {object[]} provenConfigs - Array of proven configs from Athena
 * @returns {object} Result object:
 *   - If matches found: { substitutions: [{config, distance, explanation}...] } (top 3)
 *   - If no matches: { noMatch: true, message: string }
 */
export function findNearestSubstitution(requestedConfig, provenConfigs) {
    if (!requestedConfig || !provenConfigs || provenConfigs.length === 0) {
        return { noMatch: true, message: 'no coverage — no proven configs available' };
    }

    const requestedFamily = requestedConfig.model_family;

    // Filter to only completed configs in the same model_family
    const candidates = provenConfigs.filter(c =>
        c.status === 'completed' && c.model_family === requestedFamily
    );

    if (candidates.length === 0) {
        // Find nearest across families for the message
        const allCompleted = provenConfigs.filter(c => c.status === 'completed');
        if (allCompleted.length === 0) {
            return { noMatch: true, message: 'no coverage — no proven configs available' };
        }
        const minDistance = Math.min(
            ...allCompleted.map(c => hammingDistance(requestedConfig, c))
        );
        return {
            noMatch: true,
            message: `no coverage — nearest proven config is ${minDistance} dimensions away`
        };
    }

    // Compute distances and sort
    const scored = candidates.map(config => {
        const distance = hammingDistance(requestedConfig, config);
        const explanation = buildExplanation(requestedConfig, config);
        return { config, distance, explanation };
    });

    // Sort by distance ascending, then by recency (if run_timestamp available)
    scored.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        // Secondary sort: prefer more recent configs
        const aTime = a.config.run_timestamp || '';
        const bTime = b.config.run_timestamp || '';
        return bTime.localeCompare(aTime);
    });

    // Return top 3
    const substitutions = scored.slice(0, 3).map(({ config, distance, explanation }) => ({
        config,
        distance,
        explanation
    }));

    return { substitutions };
}

/**
 * Compute Hamming distance between two config vectors.
 * Counts the number of dimensions that differ.
 *
 * @param {object} configA - First config
 * @param {object} configB - Second config
 * @returns {number} Number of dimensions that differ
 */
export function hammingDistance(configA, configB) {
    let distance = 0;
    for (const dim of CONFIG_DIMENSIONS) {
        const valA = String(configA[dim] ?? '');
        const valB = String(configB[dim] ?? '');
        if (valA !== valB) {
            distance++;
        }
    }
    return distance;
}

/**
 * Build a human-readable explanation of which dimensions differ.
 *
 * @param {object} requested - The requested config
 * @param {object} suggested - The suggested substitution
 * @returns {string[]} Array of dimension difference explanations
 */
function buildExplanation(requested, suggested) {
    const diffs = [];
    for (const dim of CONFIG_DIMENSIONS) {
        const reqVal = String(requested[dim] ?? '');
        const sugVal = String(suggested[dim] ?? '');
        if (reqVal !== sugVal) {
            diffs.push(`${dim}: '${reqVal}' → '${sugVal}'`);
        }
    }
    return diffs;
}

// ── Tune/Adapter Stage Gating (Task 5.3) ─────────────────────────────────────

/**
 * Determine whether tune/adapter stages should execute for a prove request.
 *
 * Tune stages only execute when the prove request explicitly includes
 * fine-tuning (e.g., the gap involves a tune technique or the user
 * requested adapter serving).
 *
 * @param {object} proveRequest - The prove request object
 * @param {boolean} [proveRequest.include_tuning] - Explicitly request tuning
 * @param {boolean} [proveRequest.enable_lora] - Whether LoRA is enabled
 * @param {string} [proveRequest.tune_technique] - Tune technique (sft, dpo, etc.)
 * @returns {boolean} True if tune stages should execute
 */
export function shouldExecuteTuneStages(proveRequest) {
    if (!proveRequest) return false;

    // Explicit tuning request
    if (proveRequest.include_tuning === true) return true;

    // LoRA adapter serving requested
    if (proveRequest.enable_lora === true) return true;

    // Tune technique specified
    if (proveRequest.tune_technique && proveRequest.tune_technique !== 'none') return true;

    return false;
}

// ── Failure Classification (Task 5.4) ────────────────────────────────────────

/**
 * Classify a failure from error output.
 *
 * Parses error output for known patterns and returns a structured
 * classification with stage, category, and retryable flag.
 *
 * @param {string|object} errorOutput - Error output (string or structured object)
 * @param {string} [errorOutput.error] - Error message (if object)
 * @param {string} [errorOutput.stage] - Stage that failed (if object)
 * @returns {object} Classification: { stage, category, retryable }
 */
export function classifyFailure(errorOutput) {
    if (!errorOutput) {
        return { stage: 'unknown', category: 'code_bug', retryable: false };
    }

    // Extract error message and stage
    let errorMsg = '';
    let stage = 'unknown';

    if (typeof errorOutput === 'string') {
        errorMsg = errorOutput;
        stage = detectStage(errorOutput);
    } else if (typeof errorOutput === 'object') {
        errorMsg = errorOutput.error || errorOutput.message || JSON.stringify(errorOutput);
        stage = errorOutput.stage || detectStage(errorMsg);
    }

    // Match against known patterns
    for (const { pattern, category, retryable } of ERROR_PATTERNS) {
        if (pattern.test(errorMsg)) {
            return { stage, category, retryable };
        }
    }

    // Default: unrecognized errors are classified as code_bug (non-retryable)
    return { stage, category: 'code_bug', retryable: false };
}

/**
 * Detect which lifecycle stage produced an error from the error message.
 *
 * @param {string} errorMsg - The error message
 * @returns {string} The detected stage name
 */
function detectStage(errorMsg) {
    const stagePatterns = [
        { pattern: /\b(generate|generation)\b/i, stage: 'generate' },
        { pattern: /\b(build|docker)\b/i, stage: 'build' },
        { pattern: /\b(push|ecr|registry)\b/i, stage: 'push' },
        { pattern: /\b(deploy|endpoint|CreateEndpoint|InferenceComponent)\b/i, stage: 'deploy' },
        { pattern: /\b(test|invoke|invocation|inference)\b/i, stage: 'test' },
        { pattern: /\b(tune|fine-?tun|customization)\b/i, stage: 'tune' },
        { pattern: /\b(adapter|lora)\b/i, stage: 'adapter' },
        { pattern: /\b(benchmark|bench)\b/i, stage: 'benchmark' },
        { pattern: /\b(register|dynamo)\b/i, stage: 'register' },
        { pattern: /\b(clean|delete)\b/i, stage: 'clean' }
    ];

    for (const { pattern, stage } of stagePatterns) {
        if (pattern.test(errorMsg)) {
            return stage;
        }
    }

    return 'unknown';
}

// ── Result Writing (Task 5.5) ────────────────────────────────────────────────

/**
 * Build a Path Prover Athena record from execution result and classification.
 *
 * All records have run_type='path_prove'. On success, status='completed'.
 * On non-retryable failure, status='unfeasible' with failure_reason populated.
 * On retryable failure, status='failed' with failure_reason populated.
 *
 * @param {object} result - The execution result
 * @param {boolean} result.success - Whether the prove run succeeded
 * @param {object} [result.metrics] - Benchmark metrics (on success)
 * @param {object} [result.config] - The config that was proven
 * @param {string} [result.error] - Error message (on failure)
 * @param {object|null} [classification] - Failure classification (from classifyFailure)
 * @param {string} [classification.stage] - Stage that failed
 * @param {string} [classification.category] - Error category
 * @param {boolean} [classification.retryable] - Whether failure is retryable
 * @returns {object} Athena-compatible record with run_type='path_prove'
 */
export function buildPathProverRecord(result, classification) {
    const record = {
        run_type: 'path_prove',
        run_timestamp: new Date().toISOString()
    };

    // Merge config dimensions if provided
    if (result.config) {
        for (const dim of CONFIG_DIMENSIONS) {
            if (result.config[dim] !== undefined) {
                record[dim] = result.config[dim];
            }
        }
        // Also copy non-dimension config fields
        if (result.config.config_id) record.config_id = result.config.config_id;
        if (result.config.model_name) record.model_name = result.config.model_name;
        if (result.config.instance_type) record.instance_type = result.config.instance_type;
    }

    if (result.success) {
        record.status = 'completed';
        // Merge metrics if available
        if (result.metrics) {
            Object.assign(record, result.metrics);
        }
    } else {
        // Failure case
        if (classification && classification.retryable === false) {
            record.status = 'unfeasible';
        } else {
            record.status = 'failed';
        }

        // Populate failure details
        record.failure_reason = result.error || 'Unknown failure';

        if (classification) {
            record.failure_stage = classification.stage;
            record.failure_category = classification.category;
            record.failure_retryable = classification.retryable;
        }
    }

    return record;
}

/**
 * Check if a config is known to be unfeasible (prevents repeated attempts).
 *
 * @param {object} config - The config to check
 * @param {object[]} existingRecords - Existing Athena records
 * @returns {object|null} The unfeasible record if found, null otherwise
 */
export function findUnfeasibleRecord(config, existingRecords) {
    if (!config || !existingRecords || existingRecords.length === 0) {
        return null;
    }

    for (const record of existingRecords) {
        if (record.status !== 'unfeasible') continue;
        if (record.run_type !== 'path_prove') continue;

        // Check if all dimensions match
        const allMatch = CONFIG_DIMENSIONS.every(dim =>
            String(record[dim] ?? '') === String(config[dim] ?? '')
        );

        if (allMatch) return record;
    }

    return null;
}
