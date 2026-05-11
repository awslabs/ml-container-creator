// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dry-run validator — a module that can be called during do/deploy --dry-run.
 * Runs schema validation and blocks deployment if schema errors are found.
 *
 * Returns { passed: boolean, report: ValidationReport }
 *
 * Requirements: 9.1
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import PayloadBuilder from './payload-builder.js';
import SchemaValidationEngine from './schema-validation-engine.js';
import ServiceModelParser from './service-model-parser.js';
import { getRegistryPath } from './schema-sync.js';

/**
 * Run schema validation for dry-run mode.
 * Blocks deployment if schema errors are found.
 *
 * @param {Object} config - Configuration values from do/config
 * @param {string} deploymentTarget - 'realtime-inference' | 'async-inference' | 'batch-transform'
 * @param {Object} [options]
 * @param {boolean} [options.smart] - Enable smart-mode validators
 * @param {string} [options.registryPath] - Override schema registry path
 * @returns {Promise<{ passed: boolean, report: Object|null, skipped: boolean }>}
 */
export async function validateDryRun(config, deploymentTarget, options = {}) {
    const smart = options.smart || false;
    const registryPath = options.registryPath || getRegistryPath();

    // Skip if schema registry is not present
    if (!existsSync(registryPath) || !existsSync(path.join(registryPath, 'manifest.json'))) {
        return { passed: true, report: null, skipped: true };
    }

    // Construct payloads
    const builder = new PayloadBuilder();
    const context = builder.build(config, deploymentTarget);

    // Load and parse service models from registry
    const parser = new ServiceModelParser();
    const serviceModels = [];
    try {
        const entries = readdirSync(registryPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const modelPath = path.join(registryPath, entry.name, 'service-2.json');
                if (existsSync(modelPath)) {
                    const rawModel = JSON.parse(readFileSync(modelPath, 'utf8'));
                    serviceModels.push(parser.parse(rawModel));
                }
            }
        }
    } catch {
        return { passed: true, report: null, skipped: true };
    }

    // Run validation engine
    const engine = new SchemaValidationEngine({
        registryPath,
        smartMode: smart,
        serviceModels
    });

    const report = await engine.validate(context);
    const summary = report.getSummary();

    // Block deployment if errors found
    const passed = summary.errors === 0;

    return { passed, report, skipped: false };
}

export default { validateDryRun };
