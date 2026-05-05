// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Report Helpers
 *
 * Extracted logic from the `do/ci report` bash template into testable
 * JavaScript functions. These functions mirror the bash implementations
 * for coverage report generation, regression detection, and coverage
 * arithmetic.
 *
 * Used by unit and property-based tests to validate CI report behavior
 * without executing the bash template directly.
 */

/**
 * The 15 known deployment configurations across 4 architectures.
 */
export const KNOWN_DEPLOYMENT_CONFIGS = [
    'transformers-vllm',
    'transformers-sglang',
    'transformers-lmi',
    'transformers-djl',
    'transformers-tensorrt-llm',
    'http-flask',
    'http-fastapi',
    'http-nginx',
    'triton-fil',
    'triton-python',
    'triton-onnx',
    'triton-tensorrt',
    'diffusors-vllm',
    'diffusors-sglang',
    'diffusors-comfyui'
]

/**
 * Group an array of CI records by their deploymentConfig field.
 *
 * @param {object[]} records - Array of CI_Record objects
 * @returns {Map<string, object[]>} Map from deploymentConfig to array of records
 */
export function groupByDeploymentConfig(records) {
    const groups = new Map()
    for (const record of records) {
        const key = record.deploymentConfig || ''
        if (!groups.has(key)) {
            groups.set(key, [])
        }
        groups.get(key).push(record)
    }
    return groups
}

/**
 * Detect regressions — deployment configs that transitioned from pass to fail-*.
 *
 * A regression is defined as a record whose testStatus starts with 'fail-'
 * AND whose previousTestStatus was 'pass'. Records that were never 'pass'
 * or that transition from one failure to another are NOT regressions.
 *
 * @param {object[]} records - Array of CI_Record objects, each with testStatus and optionally previousTestStatus
 * @returns {object[]} Array of records that are regressions
 */
export function detectRegressions(records) {
    return records.filter(record => {
        const current = record.testStatus || ''
        const previous = record.previousTestStatus || ''
        return current.startsWith('fail-') && previous === 'pass'
    })
}

/**
 * Compute a full coverage report from CI records and the known config list.
 *
 * @param {object[]} records - Array of CI_Record objects from the CI_Table
 * @param {string[]} knownConfigs - Array of known deployment configuration names
 * @returns {object} Coverage report with summary statistics
 * @returns {number} return.total - Total number of known configs
 * @returns {number} return.tested - Number of configs with at least one CI_Record
 * @returns {number} return.passing - Number of configs where latest testStatus is 'pass'
 * @returns {number} return.failing - Number of configs where latest testStatus starts with 'fail-'
 * @returns {number} return.untested - Number of known configs with no CI_Record
 * @returns {number} return.coveragePercent - (tested / total) * 100, rounded to 1 decimal
 * @returns {object[]} return.configurations - Per-config status details
 * @returns {object[]} return.regressions - Records flagged as regressions
 * @returns {string[]} return.untestedConfigs - Known configs with no CI_Record
 */
export function computeCoverageReport(records, knownConfigs) {
    const grouped = groupByDeploymentConfig(records)

    // Determine which known configs have been tested
    const testedConfigSet = new Set()
    const passingSet = new Set()
    const failingSet = new Set()

    const configurations = []

    for (const config of knownConfigs) {
        const configRecords = grouped.get(config) || []
        if (configRecords.length === 0) {
            configurations.push({
                deploymentConfig: config,
                status: 'untested',
                recordCount: 0
            })
            continue
        }

        testedConfigSet.add(config)

        // Use the most recent record (by lastTestTimestamp) to determine status
        const sorted = [...configRecords].sort((a, b) => {
            const tsA = a.lastTestTimestamp || '1970-01-01T00:00:00Z'
            const tsB = b.lastTestTimestamp || '1970-01-01T00:00:00Z'
            return tsB.localeCompare(tsA)
        })
        const latest = sorted[0]
        const status = latest.testStatus || 'untested'

        if (status === 'pass') {
            passingSet.add(config)
        } else if (status.startsWith('fail-')) {
            failingSet.add(config)
        }

        configurations.push({
            deploymentConfig: config,
            status,
            recordCount: configRecords.length,
            latestRecord: latest
        })
    }

    const total = knownConfigs.length
    const tested = testedConfigSet.size
    const untested = total - tested
    const passing = passingSet.size
    const failing = failingSet.size
    const coveragePercent = total > 0
        ? Math.round((tested / total) * 1000) / 10
        : 0

    const untestedConfigs = knownConfigs.filter(c => !testedConfigSet.has(c))
    const regressions = detectRegressions(records)

    return {
        total,
        tested,
        passing,
        failing,
        untested,
        coveragePercent,
        configurations,
        regressions,
        untestedConfigs
    }
}
