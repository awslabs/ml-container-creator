// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Config State Manager
 *
 * JavaScript module that mimics the bash _update_config_var() behavior
 * from do/tune for testing purposes. Manages config variables written
 * after job submission.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Update or add a config variable in a do/config-style file.
 * Mimics the bash _update_config_var() function:
 * - If the variable exists (line starts with `export VAR_NAME=`), replace it
 * - Otherwise, append a new line
 *
 * @param {string} configPath - Path to the config file
 * @param {string} varName - Variable name (e.g., TUNE_JOB_NAME_SFT)
 * @param {string} varValue - Variable value
 */
export function updateConfigVar(configPath, varName, varValue) {
    let content = readFileSync(configPath, 'utf8');
    const pattern = new RegExp(`^export ${varName}=.*$`, 'm');

    if (pattern.test(content)) {
        content = content.replace(pattern, `export ${varName}="${varValue}"`);
    } else {
        if (content.length > 0 && !content.endsWith('\n')) {
            content += '\n';
        }
        content += `export ${varName}="${varValue}"\n`;
    }

    writeFileSync(configPath, content, 'utf8');
}

/**
 * Read a config variable from a do/config-style file.
 *
 * @param {string} configPath - Path to the config file
 * @param {string} varName - Variable name to read
 * @returns {string|null} The variable value, or null if not found
 */
export function readConfigVar(configPath, varName) {
    const content = readFileSync(configPath, 'utf8');
    const pattern = new RegExp(`^export ${varName}="([^"]*)"`, 'm');
    const match = content.match(pattern);
    return match ? match[1] : null;
}

/**
 * Simulate the config writes that happen after a successful job submission.
 * This mirrors the behavior in do/tune's _submit_job() function.
 *
 * @param {string} configPath - Path to the config file
 * @param {object} params - Submission parameters
 * @param {string} params.technique - Technique (sft, dpo, rlaif, rlvr)
 * @param {string} params.trainingType - Training type (lora, full-rank)
 * @param {string} params.datasetPath - Dataset path (s3://... or hf://...)
 * @param {string} params.jobName - Generated job name
 */
export function persistSubmissionState(configPath, { technique, trainingType, datasetPath, jobName }) {
    const techniqueUpper = technique.toUpperCase();
    updateConfigVar(configPath, `TUNE_JOB_NAME_${techniqueUpper}`, jobName);
    updateConfigVar(configPath, 'TUNE_TECHNIQUE', technique);
    updateConfigVar(configPath, 'TUNE_TRAINING_TYPE', trainingType);
    updateConfigVar(configPath, 'TUNE_DATASET_PATH', datasetPath);
}

/**
 * Simulate the config writes that happen after a job completes successfully.
 * This mirrors the behavior in do/tune's _handle_completion() function.
 *
 * @param {string} configPath - Path to the config file
 * @param {object} params - Completion parameters
 * @param {string} params.technique - Technique (sft, dpo, rlaif, rlvr)
 * @param {string} params.trainingType - Training type (lora, full-rank)
 * @param {string} params.artifactPath - S3 path to the output artifact
 * @param {string} params.outputType - Output type (adapter, full-model)
 */
export function persistCompletionState(configPath, { technique, trainingType, artifactPath, outputType }) {
    const techniqueUpper = technique.toUpperCase();

    if (trainingType === 'lora') {
        updateConfigVar(configPath, `TUNE_ADAPTER_PATH_${techniqueUpper}`, artifactPath);
    } else if (trainingType === 'full-rank') {
        updateConfigVar(configPath, `TUNE_MODEL_PATH_${techniqueUpper}`, artifactPath);
    }

    updateConfigVar(configPath, 'TUNE_OUTPUT_PATH_LATEST', artifactPath);
    updateConfigVar(configPath, 'TUNE_OUTPUT_TYPE_LATEST', outputType);
}

/**
 * Generate a job name following the pattern used by do/tune.
 * Pattern: ${projectName}-tune-${technique}-YYYYMMDD-HHMMSS
 *
 * @param {string} projectName - Project name
 * @param {string} technique - Technique (sft, dpo, rlaif, rlvr)
 * @param {Date} [timestamp] - Optional timestamp (defaults to now)
 * @returns {string} Generated job name
 */
export function generateJobName(projectName, technique, timestamp = new Date()) {
    const year = timestamp.getFullYear().toString();
    const month = (timestamp.getMonth() + 1).toString().padStart(2, '0');
    const day = timestamp.getDate().toString().padStart(2, '0');
    const hours = timestamp.getHours().toString().padStart(2, '0');
    const minutes = timestamp.getMinutes().toString().padStart(2, '0');
    const seconds = timestamp.getSeconds().toString().padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    const timeStr = `${hours}${minutes}${seconds}`;
    return `${projectName}-tune-${technique}-${dateStr}-${timeStr}`;
}
