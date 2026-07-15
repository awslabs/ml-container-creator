// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Dependency Map
 *
 * Maps parameter keys to the template files they affect.
 * Used by `mcc update` to determine which files need regeneration
 * when a configuration field changes.
 *
 * Requirements: US-2 AC-2.3, AC-2.4
 */

/**
 * Mapping of parameter keys to the output files they affect.
 * Includes both snake_case and camelCase variants for compatibility.
 */
export const DEPENDENCY_MAP = {
    instance_type: ['do/config', 'do/ic/default.conf'],
    instanceType: ['do/config', 'do/ic/default.conf'],
    deployment_config: ['do/config', 'do/ic/default.conf', 'Dockerfile', 'do/build'],
    deploymentConfig: ['do/config', 'do/ic/default.conf', 'Dockerfile', 'do/build'],
    quantization_method: ['do/config', 'do/ic/default.conf', 'Dockerfile'],
    quantization: ['do/config', 'do/ic/default.conf', 'Dockerfile'],
    environment_variables: ['do/config', 'Dockerfile'],
    model_server_args: ['do/ic/default.conf'],
    scaling_min_copies: ['do/ic/default.conf'],
    icCopyCount: ['do/ic/default.conf'],
    scaling_max_copies: ['do/ic/default.conf'],
    base_image: ['Dockerfile', 'do/build'],
    baseImage: ['Dockerfile', 'do/build'],
    region: ['do/config'],
    awsRegion: ['do/config'],
    icGpuCount: ['do/ic/default.conf'],
    icMemorySize: ['do/ic/default.conf'],
    icCpuCount: ['do/ic/default.conf'],
    enableLora: ['do/ic/default.conf', 'Dockerfile'],
    maxLoras: ['do/ic/default.conf']
};

/**
 * Get the list of files affected by a set of changed parameter keys.
 * Returns a deduplicated, sorted array of file paths.
 *
 * @param {string[]} changedKeys - Array of parameter keys that changed
 * @returns {string[]} Sorted, deduplicated array of affected file paths
 */
export function getAffectedFiles(changedKeys) {
    const files = new Set();
    for (const key of changedKeys) {
        for (const file of DEPENDENCY_MAP[key] ?? []) files.add(file);
    }
    return [...files].sort();
}
