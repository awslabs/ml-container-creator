// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Config Persistence
 *
 * JavaScript module that models the config persistence logic from the bash
 * `_update_config_var` function in `templates/do/train`. This module provides
 * a pure JavaScript implementation for property-based testing of the config
 * persistence behavior after job submission and completion.
 *
 * The config file uses the format:
 *   export VAR_NAME="value"
 *
 * Behavior:
 * - If the variable already exists: update its value in-place
 * - If the variable doesn't exist: append it to the end
 * - Existing variables in the config are preserved
 *
 * Requirements: 3.4, 5.1
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Update or add a config variable in a do/config-style file.
 * Mimics the bash _update_config_var() function from templates/do/train:
 *
 *   if grep -q "^export ${var_name}=" "${config_file}"; then
 *       sed -i.bak "s|^export ${var_name}=.*|export ${var_name}=\"${var_value}\"|" "${config_file}"
 *       rm -f "${config_file}.bak"
 *   else
 *       echo "export ${var_name}=\"${var_value}\"" >> "${config_file}"
 *   fi
 *
 * @param {string} configContent - Current content of the config file
 * @param {string} varName - Variable name (e.g., TRAIN_JOB_NAME)
 * @param {string} varValue - Variable value
 * @returns {string} Updated config content
 */
export function updateConfigVar(configContent, varName, varValue) {
    const pattern = new RegExp(`^export ${varName}=.*$`, 'm');

    if (pattern.test(configContent)) {
        // Variable exists — update in-place
        return configContent.replace(pattern, `export ${varName}="${varValue}"`);
    } else {
        // Variable doesn't exist — append
        let result = configContent;
        if (result.length > 0 && !result.endsWith('\n')) {
            result += '\n';
        }
        result += `export ${varName}="${varValue}"\n`;
        return result;
    }
}

/**
 * Read a config variable value from a do/config-style file content.
 *
 * @param {string} configContent - Content of the config file
 * @param {string} varName - Variable name to read
 * @returns {string|null} The variable value, or null if not found
 */
export function readConfigVar(configContent, varName) {
    const pattern = new RegExp(`^export ${varName}="([^"]*)"`, 'm');
    const match = configContent.match(pattern);
    return match ? match[1] : null;
}

/**
 * Simulate the config writes that happen after a successful training job submission.
 * This mirrors the behavior in do/train's _submit_job() function which calls:
 *   _update_config_var "TRAIN_JOB_NAME" "${JOB_NAME}"
 *
 * @param {string} configContent - Current content of the config file
 * @param {object} params - Submission parameters
 * @param {string} params.jobName - Generated job name (pattern: ${PROJECT_NAME}-train-${TIMESTAMP})
 * @returns {string} Updated config content
 */
export function persistTrainSubmission(configContent, { jobName }) {
    return updateConfigVar(configContent, 'TRAIN_JOB_NAME', jobName);
}

/**
 * Simulate the config writes that happen after a training job completes.
 * This mirrors the behavior in do/train's _handle_completion() function which calls:
 *   _update_config_var "TRAIN_OUTPUT_PATH" "${output_path}"
 *
 * @param {string} configContent - Current content of the config file
 * @param {object} params - Completion parameters
 * @param {string} params.outputPath - S3 path to the output artifacts
 * @returns {string} Updated config content
 */
export function persistTrainCompletion(configContent, { outputPath }) {
    return updateConfigVar(configContent, 'TRAIN_OUTPUT_PATH', outputPath);
}

/**
 * Generate a training job name following the pattern used by do/train.
 * Pattern: ${projectName}-train-YYYYMMDD-HHMMSS
 *
 * @param {string} projectName - Project name
 * @param {Date} [timestamp] - Optional timestamp (defaults to now)
 * @returns {string} Generated job name
 */
export function generateTrainJobName(projectName, timestamp = new Date()) {
    const year = timestamp.getFullYear().toString();
    const month = (timestamp.getMonth() + 1).toString().padStart(2, '0');
    const day = timestamp.getDate().toString().padStart(2, '0');
    const hours = timestamp.getHours().toString().padStart(2, '0');
    const minutes = timestamp.getMinutes().toString().padStart(2, '0');
    const seconds = timestamp.getSeconds().toString().padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    const timeStr = `${hours}${minutes}${seconds}`;
    return `${projectName}-train-${dateStr}-${timeStr}`;
}

/**
 * File-based version of updateConfigVar that reads/writes to disk.
 * Used for integration-style tests that need actual file I/O.
 *
 * @param {string} configPath - Path to the config file
 * @param {string} varName - Variable name
 * @param {string} varValue - Variable value
 */
export function updateConfigVarFile(configPath, varName, varValue) {
    const content = readFileSync(configPath, 'utf8');
    const updated = updateConfigVar(content, varName, varValue);
    writeFileSync(configPath, updated, 'utf8');
}

/**
 * File-based version of readConfigVar that reads from disk.
 *
 * @param {string} configPath - Path to the config file
 * @param {string} varName - Variable name to read
 * @returns {string|null} The variable value, or null if not found
 */
export function readConfigVarFile(configPath, varName) {
    const content = readFileSync(configPath, 'utf8');
    return readConfigVar(content, varName);
}
