// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/config parser — shared reader for generated projects' do/config shell file.
 *
 * PATTERN: Shared utility (single source of truth for do/config parsing).
 *   Replaces three divergent copies that lived in update-command-handler.js,
 *   regenerate-command-handler.js, and validate-runner.js (plus a fourth
 *   replicated inside a test).
 * COLLABORATORS: imported by src/lib/update-command-handler.js,
 *   regenerate-command-handler.js, and validate-runner.js; reads a generated
 *   project's do/config file.
 * DATA-FLOW ROLE: consumes a do/config path, produces (1) a raw shell KEY→value
 *   map (parseDoConfig) and (2) a camelCase answers map (shellVarsToAnswers)
 *   the generator/writeProject consume.
 * See: docs/adr/ADR-005-command-handler-contract.md,
 *   docs/architecture/command-handlers.md
 */

import { existsSync, readFileSync } from 'node:fs';
import { statusVarToAnswerKey } from './target-manifest-reader.js';

// One line of a do/config file: `export KEY="value"`, `export KEY='value'`, or
// `export KEY=value`. Anchored so trailing junk is not silently captured.
const EXPORT_LINE = /^\s*export\s+([A-Z_][A-Z0-9_]*)=["']?([^"']*)["']?\s*$/;

// Shell default-value expansion: ${VAR:-default} → default. do/config lines like
// `export INSTANCE_TYPE="${INSTANCE_TYPE:-ml.g6e.12xlarge}"` carry the shell
// expression; callers that need the resolved value (e.g. the payload builder)
// pass { resolveShellDefaults: true }.
const SHELL_DEFAULT = /\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/g;

/**
 * Canonical shell-KEY → camelCase-answer mapping. This is the superset union of
 * the mappings that update-command-handler and regenerate-command-handler each
 * carried; keys unknown to this map are dropped (unchanged prior behavior).
 *
 * Note `container_image_uri` intentionally stays snake_case — the generator
 * answers object uses that exact key for CONTAINER_IMAGE_URI.
 *
 * The per-target `DEPLOYMENT_TARGET_<T>_STATUS` → `deploymentTarget<T>Status`
 * entries are DERIVED from the target descriptors (targets.d/<target>/manifest.json,
 * via target-manifest-reader.js `statusVarToAnswerKey`) rather than hand-listed —
 * so adding a deployment target does not require editing this map. The
 * non-status entries below remain hand-authored. See ADR-008.
 */
export const SHELL_VAR_TO_ANSWER = Object.freeze({
    PROJECT_NAME: 'projectName',
    DEPLOYMENT_CONFIG: 'deploymentConfig',
    DEPLOYMENT_TARGET: 'deploymentTarget',
    INSTANCE_TYPE: 'instanceType',
    MODEL_NAME: 'modelName',
    BASE_IMAGE: 'baseImage',
    REGION: 'region',
    AWS_REGION: 'awsRegion',
    ENDPOINT_NAME: 'endpointName',
    DEPLOY_MODE: 'deployMode',
    CONTAINER_IMAGE_URI: 'container_image_uri',
    ENDPOINT_STATUS: 'endpointStatus',
    IC_GPU_COUNT: 'icGpuCount',
    IC_COPY_COUNT: 'icCopyCount',
    IC_MEMORY_SIZE: 'icMemorySize',
    IC_CPU_COUNT: 'icCpuCount',
    ENABLE_LORA: 'enableLora',
    MAX_LORAS: 'maxLoras',
    QUANTIZATION: 'quantization',
    HF_TOKEN_ARN: 'hfTokenArn',
    NGC_TOKEN_ARN: 'ngcTokenArn',
    GENERATOR_VERSION: 'generatorVersion',
    // DERIVED: per-target DEPLOYMENT_TARGET_<T>_STATUS → deploymentTarget<T>Status
    ...statusVarToAnswerKey()
});

/**
 * Parse a do/config shell file into a raw KEY→value map.
 *
 * @param {string} configPath - Path to the do/config file.
 * @param {object} [options]
 * @param {boolean} [options.resolveShellDefaults=false] - When true, resolve
 *   `${VAR:-default}` expressions to their default value (used by the validate
 *   path so the payload builder gets resolved values, not shell expressions).
 * @returns {Object<string,string>|null} Parsed KEY→value map, or null when the
 *   file does not exist.
 */
export function parseDoConfig(configPath, { resolveShellDefaults = false } = {}) {
    if (!existsSync(configPath)) {
        return null;
    }
    const content = readFileSync(configPath, 'utf8');
    const result = {};
    for (const line of content.split('\n')) {
        const match = line.match(EXPORT_LINE);
        if (match) {
            const [, key, value] = match;
            result[key] = resolveShellDefaults
                ? value.replace(SHELL_DEFAULT, '$1')
                : value;
        }
    }
    return result;
}

/**
 * Convert a shell KEY→value map into a camelCase answers map, using the
 * canonical SHELL_VAR_TO_ANSWER mapping. Keys not in the map are dropped.
 *
 * @param {Object<string,string>} shellVars - Shell variable map.
 * @returns {Object<string,string>} camelCase answers map.
 */
export function shellVarsToAnswers(shellVars) {
    const answers = {};
    for (const [shellKey, value] of Object.entries(shellVars || {})) {
        const camelKey = SHELL_VAR_TO_ANSWER[shellKey];
        if (camelKey) {
            answers[camelKey] = value;
        }
    }
    return answers;
}
