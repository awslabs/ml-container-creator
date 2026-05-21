// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Config Parser
 *
 * JavaScript module that replicates the YAML config parsing logic from
 * do/train's _parse_config_python() function. Parses do/training/config.yaml
 * and extracts all supported fields into a structured object.
 *
 * This module mirrors the behavior of both the yq and Python fallback paths
 * in the bash script, providing a testable implementation of the parsing logic.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * Default values for optional fields, matching the bash script defaults.
 */
const DEFAULTS = {
    instance_count: '1',
    max_runtime_seconds: '86400',
    volume_size_gb: '50',
    enable_spot: 'false',
    max_wait_seconds: '172800',
    checkpoint_path: '',
    hyperparameters: {},
    metric_definitions: [],
    environment: {},
    tags: {}
};

/**
 * Convert a value to its string representation, matching the Python helper's
 * `s()` function behavior in _parse_config_python.
 *
 * @param {*} val - The value to convert
 * @param {string} defaultVal - Default value if val is null/undefined
 * @returns {string} String representation
 */
function toStringValue(val, defaultVal = '') {
    if (val === null || val === undefined) {
        return defaultVal;
    }
    if (typeof val === 'boolean') {
        return val ? 'true' : 'false';
    }
    return String(val);
}

/**
 * Parse a training config YAML file and extract all supported fields.
 *
 * This mirrors the behavior of _parse_config_python() in do/train:
 * - Scalar fields are converted to strings
 * - Boolean fields are converted to "true"/"false" strings
 * - Missing optional fields get default values
 * - Complex fields (hyperparameters, metric_definitions, environment, tags)
 *   are kept as their native types (objects/arrays)
 *
 * @param {string} configPath - Path to the YAML config file
 * @returns {object} Parsed config with all supported fields
 * @throws {Error} If the file cannot be read or parsed
 */
export function parseTrainingConfig(configPath) {
    const content = readFileSync(configPath, 'utf8');
    return parseTrainingConfigFromString(content);
}

/**
 * Parse a training config from a YAML string.
 * Useful for testing without file I/O.
 *
 * @param {string} yamlContent - YAML content string
 * @returns {object} Parsed config with all supported fields
 * @throws {Error} If the YAML cannot be parsed
 */
export function parseTrainingConfigFromString(yamlContent) {
    const cfg = yaml.load(yamlContent) || {};

    return {
        // Required fields (empty string if missing)
        image: toStringValue(cfg.image, ''),
        script: toStringValue(cfg.script, ''),
        instance_type: toStringValue(cfg.instance_type, ''),
        instance_count: toStringValue(cfg.instance_count, DEFAULTS.instance_count),
        dataset: toStringValue(cfg.dataset, ''),
        output_path: toStringValue(cfg.output_path, ''),

        // Optional scalar fields with defaults
        max_runtime_seconds: toStringValue(cfg.max_runtime_seconds, DEFAULTS.max_runtime_seconds),
        volume_size_gb: toStringValue(cfg.volume_size_gb, DEFAULTS.volume_size_gb),
        enable_spot: toStringValue(cfg.enable_spot, DEFAULTS.enable_spot),
        max_wait_seconds: toStringValue(cfg.max_wait_seconds, DEFAULTS.max_wait_seconds),
        checkpoint_path: toStringValue(cfg.checkpoint_path, DEFAULTS.checkpoint_path),

        // Complex fields (objects/arrays)
        hyperparameters: cfg.hyperparameters || DEFAULTS.hyperparameters,
        metric_definitions: cfg.metric_definitions || DEFAULTS.metric_definitions,
        environment: cfg.environment || DEFAULTS.environment,
        tags: cfg.tags || DEFAULTS.tags
    };
}

/**
 * List of all supported fields in the training config.
 */
export const SUPPORTED_FIELDS = [
    'image',
    'script',
    'instance_type',
    'instance_count',
    'dataset',
    'output_path',
    'max_runtime_seconds',
    'volume_size_gb',
    'enable_spot',
    'max_wait_seconds',
    'checkpoint_path',
    'hyperparameters',
    'metric_definitions',
    'environment',
    'tags'
];

/**
 * List of required fields that must be non-empty.
 */
export const REQUIRED_FIELDS = [
    'image',
    'script',
    'instance_type',
    'dataset',
    'output_path'
];
