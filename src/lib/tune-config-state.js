// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Config State
 *
 * Manages bash-style config files (do/config) that contain lines like:
 *   export VAR_NAME="value"
 *
 * Provides read/write access for tuning job state variables.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Read a variable value from a bash config file.
 * Looks for lines matching: export VAR_NAME="value", export VAR_NAME='value', or export VAR_NAME=value
 *
 * @param {string} configPath - Path to the config file
 * @param {string} varName - Variable name to read
 * @returns {string|null} The unquoted value, or null if not found
 */
export function readConfigVar(configPath, varName) {
    const content = readFileSync(configPath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        const prefix = `export ${varName}=`;
        if (trimmed.startsWith(prefix)) {
            let value = trimmed.slice(prefix.length);
            // Strip surrounding quotes (double or single)
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith('\'') && value.endsWith('\''))) {
                value = value.slice(1, -1);
            }
            return value;
        }
    }

    return null;
}

/**
 * Write or update a variable in a bash config file.
 * If the variable already exists, replaces that line.
 * If not, appends the new export line.
 *
 * @param {string} configPath - Path to the config file
 * @param {string} varName - Variable name to set
 * @param {string} value - Value to assign
 */
export function updateConfigVar(configPath, varName, value) {
    const content = readFileSync(configPath, 'utf8');
    const lines = content.split('\n');
    const prefix = `export ${varName}=`;
    const newLine = `export ${varName}="${value}"`;

    let found = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith(prefix)) {
            lines[i] = newLine;
            found = true;
            break;
        }
    }

    if (found) {
        writeFileSync(configPath, lines.join('\n'), 'utf8');
    } else {
        // Append to end of file
        let appendContent = content;
        if (appendContent.length > 0 && !appendContent.endsWith('\n')) {
            appendContent += '\n';
        }
        appendContent += `${newLine  }\n`;
        writeFileSync(configPath, appendContent, 'utf8');
    }
}

/**
 * Write tuning job submission state to config.
 *
 * @param {string} configPath - Path to the config file
 * @param {object} state - Submission state
 * @param {string} state.technique - Tuning technique (e.g., 'sft', 'dpo')
 * @param {string} state.trainingType - Training type (e.g., 'lora', 'full-rank')
 * @param {string} state.datasetPath - Dataset path (S3 or HF URI)
 * @param {string} state.jobName - Generated job name
 */
export function persistSubmissionState(configPath, { technique, trainingType, datasetPath, jobName }) {
    const techniqueUpper = technique.toUpperCase();
    updateConfigVar(configPath, `TUNE_JOB_NAME_${techniqueUpper}`, jobName);
    updateConfigVar(configPath, 'TUNE_TECHNIQUE', technique);
    updateConfigVar(configPath, 'TUNE_TRAINING_TYPE', trainingType);
    updateConfigVar(configPath, 'TUNE_DATASET_PATH', datasetPath);
}

/**
 * Write tuning job completion state to config.
 *
 * @param {string} configPath - Path to the config file
 * @param {object} state - Completion state
 * @param {string} state.technique - Tuning technique
 * @param {string} state.trainingType - Training type
 * @param {string} state.artifactPath - Output artifact path (S3 URI)
 * @param {string} state.outputType - Output type ('adapter' or 'model')
 * @param {string} [state.datasetSlug] - Dataset slug for named paths
 */
export function persistCompletionState(configPath, { technique, trainingType: _trainingType, artifactPath, outputType, datasetSlug }) {
    const techniqueUpper = technique.toUpperCase();

    updateConfigVar(configPath, 'TUNE_OUTPUT_PATH_LATEST', artifactPath);
    updateConfigVar(configPath, 'TUNE_OUTPUT_TYPE_LATEST', outputType);

    if (outputType === 'adapter') {
        updateConfigVar(configPath, `TUNE_ADAPTER_PATH_${techniqueUpper}`, artifactPath);
        if (datasetSlug) {
            const slugUpper = datasetSlug.toUpperCase().replace(/-/g, '_');
            updateConfigVar(configPath, `TUNE_ADAPTER_PATH_${techniqueUpper}_${slugUpper}`, artifactPath);
        }
    } else {
        updateConfigVar(configPath, `TUNE_MODEL_PATH_${techniqueUpper}`, artifactPath);
    }
}

/**
 * Generate a job name matching pattern: ${projectName}-tune-${technique}-YYYYMMDD-HHMMSS
 * Uses local time for the timestamp.
 *
 * @param {string} projectName - Project name
 * @param {string} technique - Tuning technique
 * @param {Date} [timestamp] - Optional timestamp (defaults to new Date())
 * @returns {string} Formatted job name
 */
export function generateJobName(projectName, technique, timestamp) {
    const ts = timestamp || new Date();

    const year = ts.getFullYear().toString();
    const month = (ts.getMonth() + 1).toString().padStart(2, '0');
    const day = ts.getDate().toString().padStart(2, '0');
    const hours = ts.getHours().toString().padStart(2, '0');
    const minutes = ts.getMinutes().toString().padStart(2, '0');
    const seconds = ts.getSeconds().toString().padStart(2, '0');

    const dateStr = `${year}${month}${day}`;
    const timeStr = `${hours}${minutes}${seconds}`;

    return `${projectName}-tune-${technique}-${dateStr}-${timeStr}`;
}
