// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Validator Configuration Reader
 *
 * Reads smart-mode validator configuration from config/mcp.json.
 * When a smart-mode validator is configured, it is queried only when --smart is passed.
 * The actual MCP spawning is a FUTURE integration point — this module implements
 * configuration reading and provides a stub for the spawning.
 *
 * Expected format in config/mcp.json:
 * {
 *   "mcpServers": { ... existing servers ... },
 *   "smartValidators": [
 *     {
 *       "name": "bedrock-validator",
 *       "command": "node",
 *       "args": ["path/to/validator.js"],
 *       "timeout": 15000,
 *       "enabled": true
 *     }
 *   ]
 * }
 *
 * Requirements: 15.6
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Load smart-mode validator configuration from config/mcp.json.
 *
 * @param {string} [configPath] - Override path to mcp.json (defaults to config/mcp.json relative to project root)
 * @returns {{ validators: Array, loaded: boolean }}
 */
export function loadSmartValidatorConfig(configPath) {
    const resolvedPath = configPath || path.resolve('config', 'mcp.json');

    if (!existsSync(resolvedPath)) {
        return { validators: [], loaded: false };
    }

    try {
        const content = readFileSync(resolvedPath, 'utf8');
        const config = JSON.parse(content);

        const smartValidators = config.smartValidators || [];

        // Filter to only enabled validators
        const enabledValidators = smartValidators.filter(v => v.enabled !== false);

        return {
            validators: enabledValidators.map(v => ({
                name: v.name || 'unnamed-smart-validator',
                command: v.command || 'node',
                args: v.args || [],
                timeout: v.timeout || 15000,
                enabled: true
            })),
            loaded: true
        };
    } catch {
        return { validators: [], loaded: false };
    }
}

/**
 * Spawn a smart-mode validator child process and pass context via stdio.
 * FUTURE INTEGRATION POINT — currently returns an empty findings array.
 *
 * @param {Object} validatorConfig - Configuration for the validator
 * @param {string} validatorConfig.name - Validator name
 * @param {string} validatorConfig.command - Command to spawn
 * @param {Array} validatorConfig.args - Arguments for the command
 * @param {number} validatorConfig.timeout - Timeout in milliseconds
 * @param {Object} context - The full ValidationContext (JSON-serializable)
 * @param {Object} [options]
 * @param {Array} [options.priorFindings] - Findings from static validators
 * @returns {Promise<Array>} Array of findings from the MCP validator (currently empty stub)
 */
export async function spawnSmartValidator(validatorConfig, context, _options = {}) {
    // FUTURE: Spawn child process, pass context via stdio, collect findings
    // For now, return empty findings array as a stub
    return [];
}

export default { loadSmartValidatorConfig, spawnSmartValidator };
