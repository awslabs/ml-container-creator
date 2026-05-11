// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generation-time validation helper.
 * Called after deploy scripts are generated to validate payloads against service models.
 * Prints errors as warnings (non-blocking) with a summary line.
 *
 * - Skips silently if schema registry is not present
 * - Skips entirely if --no-validate flag is passed (check via options parameter)
 *
 * This is a standalone module — does NOT modify the main generator file.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import PayloadBuilder from './payload-builder.js';
import SchemaValidationEngine from './schema-validation-engine.js';
import ServiceModelParser from './service-model-parser.js';
import { getRegistryPath } from './schema-sync.js';

/**
 * Run schema validation at generation time (non-blocking).
 *
 * @param {Object} config - Configuration values (from generator answers or do/config)
 * @param {string} deploymentTarget - 'realtime-inference' | 'async-inference' | 'batch-transform'
 * @param {Object} [options]
 * @param {boolean} [options.noValidate] - If true, skip validation entirely
 * @param {string} [options.registryPath] - Override schema registry path
 * @returns {Promise<{ skipped: boolean, report: Object|null }>}
 */
export async function runGenerationValidation(config, deploymentTarget, options = {}) {
    // Skip entirely if --no-validate flag is passed
    if (options.noValidate) {
        return { skipped: true, report: null };
    }

    const registryPath = options.registryPath || getRegistryPath();

    // Skip silently if schema registry is not present
    if (!existsSync(registryPath) || !existsSync(path.join(registryPath, 'manifest.json'))) {
        return { skipped: true, report: null };
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
        // If we can't load models, skip validation silently
        return { skipped: true, report: null };
    }

    // Run validation
    const engine = new SchemaValidationEngine({
        registryPath,
        ignoreStaleness: true,
        serviceModels
    });

    const report = await engine.validate(context);
    const summary = report.getSummary();

    // Print errors as warnings (non-blocking)
    if (summary.errors > 0) {
        console.log('');
        console.log('\x1b[33m⚠️  Schema validation found issues:\x1b[0m');

        for (const error of report.schemaErrors) {
            const location = [error.operation, error.fieldPath].filter(Boolean).join(' → ');
            console.log(`  \x1b[33m⚠\x1b[0m ${location}: ${error.invalidValue || ''} ${error.remediationHint || ''}`);
        }

        for (const error of report.crossCuttingErrors) {
            const location = [error.operation, error.fieldPath].filter(Boolean).join(' → ');
            console.log(`  \x1b[33m⚠\x1b[0m ${location}: ${error.remediationHint || ''}`);
        }

        console.log('');
        console.log(`  ${summary.errors} issue(s) found. Run \x1b[36mdo/validate\x1b[0m before deployment.`);
    }

    return { skipped: false, report };
}

export default { runGenerationValidation };
