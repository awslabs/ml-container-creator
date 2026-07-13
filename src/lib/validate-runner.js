// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation runner — the Node.js module invoked by do/validate.
 * Loads config, constructs payloads, runs SchemaValidationEngine, and prints a report.
 *
 * - Prints structured report (text format by default)
 * - Exits with code 1 if errors found, 0 if clean
 * - Includes service model version date and fields validated count on success
 * - Supports --smart flag for future MCP validator integration
 *
 * Requirements: 9.2, 9.3, 9.4
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PayloadBuilder from './payload-builder.js';
import SchemaValidationEngine from './schema-validation-engine.js';
import ServiceModelParser from './service-model-parser.js';
import CrossCuttingChecker from './cross-cutting-checker.js';
import HuggingFaceClient from './huggingface-client.js';
import { getRegistryPath, loadManifest, hasBenchmarkShape } from './schema-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse a do/config shell file into a key-value object.
 * Extracts lines matching: export KEY="value" or export KEY=value
 *
 * @param {string} configPath - Path to the do/config file
 * @returns {Object} Parsed configuration values
 */
export function parseDoConfig(configPath) {
    if (!existsSync(configPath)) {
        return null;
    }

    const content = readFileSync(configPath, 'utf8');
    const config = {};

    for (const line of content.split('\n')) {
        const match = line.match(/^export\s+([A-Z_][A-Z0-9_]*)=["']?([^"'\n]*)["']?/);
        if (match) {
            const [, key, value] = match;
            // Resolve shell default-value syntax: ${VAR:-default} → default
            // This handles lines like: export INSTANCE_TYPE="${INSTANCE_TYPE:-ml.g6e.12xlarge}"
            // Without this, the payload builder receives the shell expression instead of the resolved value.
            const resolved = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/g, '$1');
            config[key] = resolved;
        }
    }

    return config;
}

/**
 * Validate benchmark parameters against service model constraints.
 * Called when the CreateAIBenchmarkJob shape is available in the synced schema.
 *
 * Validates:
 * - Concurrency: integer, min 1
 * - S3OutputLocation: string, starts with s3://
 * - AIBenchmarkJobName: pattern ^[a-zA-Z0-9](-*[a-zA-Z0-9])*, max 63 chars
 *
 * Requirements: 8.1, 8.2, 8.3
 *
 * @param {Object} config - Parsed do/config values
 * @returns {Array<Object>} Array of validation findings
 */
export function validateBenchmarkParams(config) {
    const findings = [];

    // Validate Concurrency (integer, min 1)
    if (config.BENCHMARK_CONCURRENCY !== null && config.BENCHMARK_CONCURRENCY !== undefined && config.BENCHMARK_CONCURRENCY !== '') {
        const concurrency = Number(config.BENCHMARK_CONCURRENCY);
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            findings.push({
                severity: 'error',
                operation: 'CreateAIBenchmarkJob',
                fieldPath: 'Concurrency',
                constraint: 'integer >= 1',
                invalidValue: config.BENCHMARK_CONCURRENCY,
                remediationHint: 'BENCHMARK_CONCURRENCY must be a positive integer (>= 1)'
            });
        }
    }

    // Validate S3OutputLocation (string, starts with s3://)
    if (config.BENCHMARK_S3_OUTPUT_PATH !== null && config.BENCHMARK_S3_OUTPUT_PATH !== undefined && config.BENCHMARK_S3_OUTPUT_PATH !== '') {
        const s3Path = config.BENCHMARK_S3_OUTPUT_PATH;
        // Skip dynamic shell expressions (e.g., s3://...$(aws ...))
        if (!s3Path.includes('$(') && !s3Path.startsWith('s3://')) {
            findings.push({
                severity: 'error',
                operation: 'CreateAIBenchmarkJob',
                fieldPath: 'OutputConfig.S3OutputLocation',
                constraint: 'must start with s3://',
                invalidValue: s3Path,
                remediationHint: 'BENCHMARK_S3_OUTPUT_PATH must start with "s3://". Example: s3://my-bucket/benchmark-results/'
            });
        }
    }

    // Validate AIBenchmarkJobName pattern (^[a-zA-Z0-9](-*[a-zA-Z0-9])*, max 63 chars)
    if (config.BENCHMARK_JOB_NAME !== null && config.BENCHMARK_JOB_NAME !== undefined && config.BENCHMARK_JOB_NAME !== '') {
        const jobName = config.BENCHMARK_JOB_NAME;
        // Skip dynamic shell expressions
        if (!jobName.includes('$(') && !jobName.includes('${')) {
            const namePattern = /^[a-zA-Z0-9](-*[a-zA-Z0-9])*$/;
            if (jobName.length > 63) {
                findings.push({
                    severity: 'error',
                    operation: 'CreateAIBenchmarkJob',
                    fieldPath: 'AIBenchmarkJobName',
                    constraint: 'max 63 characters',
                    invalidValue: jobName,
                    remediationHint: 'AIBenchmarkJobName must be at most 63 characters'
                });
            } else if (!namePattern.test(jobName)) {
                findings.push({
                    severity: 'error',
                    operation: 'CreateAIBenchmarkJob',
                    fieldPath: 'AIBenchmarkJobName',
                    constraint: 'pattern: ^[a-zA-Z0-9](-*[a-zA-Z0-9])*',
                    invalidValue: jobName,
                    remediationHint: 'AIBenchmarkJobName must start with alphanumeric and contain only alphanumeric characters and hyphens'
                });
            }
        }
    }

    // Validate input tokens mean (integer, min 1)
    if (config.BENCHMARK_INPUT_TOKENS_MEAN !== null && config.BENCHMARK_INPUT_TOKENS_MEAN !== undefined && config.BENCHMARK_INPUT_TOKENS_MEAN !== '') {
        const inputTokens = Number(config.BENCHMARK_INPUT_TOKENS_MEAN);
        if (!Number.isInteger(inputTokens) || inputTokens < 1) {
            findings.push({
                severity: 'error',
                operation: 'CreateAIWorkloadConfig',
                fieldPath: 'WorkloadSpec.parameters.prompt_input_tokens_mean',
                constraint: 'integer >= 1',
                invalidValue: config.BENCHMARK_INPUT_TOKENS_MEAN,
                remediationHint: 'BENCHMARK_INPUT_TOKENS_MEAN must be a positive integer (>= 1)'
            });
        }
    }

    // Validate output tokens mean (integer, min 1)
    if (config.BENCHMARK_OUTPUT_TOKENS_MEAN !== null && config.BENCHMARK_OUTPUT_TOKENS_MEAN !== undefined && config.BENCHMARK_OUTPUT_TOKENS_MEAN !== '') {
        const outputTokens = Number(config.BENCHMARK_OUTPUT_TOKENS_MEAN);
        if (!Number.isInteger(outputTokens) || outputTokens < 1) {
            findings.push({
                severity: 'error',
                operation: 'CreateAIWorkloadConfig',
                fieldPath: 'WorkloadSpec.parameters.output_tokens_mean',
                constraint: 'integer >= 1',
                invalidValue: config.BENCHMARK_OUTPUT_TOKENS_MEAN,
                remediationHint: 'BENCHMARK_OUTPUT_TOKENS_MEAN must be a positive integer (>= 1)'
            });
        }
    }

    return findings;
}

/**
 * Run the full validation pipeline.
 *
 * @param {Object} options
 * @param {string} [options.configDir] - Path to the do/ directory containing config
 * @param {string} [options.format] - Output format: 'text' (default) or 'json'
 * @param {boolean} [options.smart] - Enable smart-mode validators
 * @param {string} [options.registryPath] - Override schema registry path
 * @param {Object} [options.config] - Pre-parsed config (overrides configDir loading)
 * @returns {Promise<number>} Exit code (0 = pass, 1 = fail, 2 = cannot run)
 */
export async function run(options = {}) {
    const format = options.format || 'text';
    const smart = options.smart || false;
    const registryPath = options.registryPath || getRegistryPath();

    // Check schema registry exists
    if (!existsSync(registryPath) || !existsSync(path.join(registryPath, 'manifest.json'))) {
        console.log('⚠️  Schema registry not found.');
        console.log('   Run: ml-container-creator bootstrap sync-schemas');
        process.exit(2);
        return 2;
    }

    // Load config
    let config = options.config;
    if (!config && options.configDir) {
        const configPath = path.join(options.configDir, 'config');
        config = parseDoConfig(configPath);
        if (!config) {
            console.log('❌ Could not load do/config');
            process.exit(2);
            return 2;
        }
    }

    if (!config) {
        console.log('❌ No configuration provided');
        process.exit(2);
        return 2;
    }

    const deploymentTarget = config.DEPLOYMENT_TARGET || 'realtime-inference';

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
        console.log('⚠️  Could not load service models from registry');
        process.exit(2);
        return 2;
    }

    // Run validation engine
    const engine = new SchemaValidationEngine({
        registryPath,
        smartMode: smart,
        serviceModels
    });

    const report = await engine.validate(context);

    // Run model architecture compatibility check (Requirement 5.1-5.2)
    if (config.MODEL_NAME) {
        try {
            const catalogPath = path.resolve(__dirname, '../../servers/lib/catalogs/model-servers.json');
            if (existsSync(catalogPath)) {
                const modelServersCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

                // Fetch model's config.json from HuggingFace to get model_type
                const hfClient = new HuggingFaceClient({ timeout: 10000 });
                const modelConfig = await hfClient.fetchModelConfig(config.MODEL_NAME);
                const modelType = modelConfig?.model_type || null;

                if (modelType) {
                    // Extract baseImageVersion from BASE_IMAGE (e.g., "vllm/vllm-openai:v0.10.1" → "v0.10.1")
                    const baseImage = config.BASE_IMAGE || '';
                    const baseImageVersion = baseImage.includes(':') ? baseImage.split(':').pop() : '';
                    // Strip leading 'v' to match catalog's framework_version format (e.g., "v0.10.1" → "0.10.1")
                    const frameworkVersion = baseImageVersion.replace(/^v/, '');

                    const modelServer = config.MODEL_SERVER || '';

                    // Build context fields for the architecture checker
                    const archContext = {
                        config: {
                            modelType,
                            modelServer,
                            baseImageVersion: frameworkVersion
                        }
                    };

                    const checker = new CrossCuttingChecker();
                    const archFindings = checker.checkModelArchitectureCompatibility(archContext, modelServersCatalog);
                    for (const finding of archFindings) {
                        report.addFinding(finding);
                    }
                }
            }
        } catch {
            // Graceful degradation: if architecture check fails, continue without it
        }
    }

    // Run benchmark parameter validation (Requirements 8.1, 8.2, 8.3)
    if (config.BENCHMARK_CONCURRENCY || config.BENCHMARK_INPUT_TOKENS_MEAN ||
        config.BENCHMARK_OUTPUT_TOKENS_MEAN || config.BENCHMARK_S3_OUTPUT_PATH) {
        const benchmarkCheck = hasBenchmarkShape(registryPath);
        if (benchmarkCheck.available) {
            const benchmarkFindings = validateBenchmarkParams(config);
            for (const finding of benchmarkFindings) {
                report.addFinding(finding);
            }
        } else {
            console.log('⚠️  Benchmark validation skipped: service model does not include AI Benchmark operations. Run `bootstrap sync-schemas` to update.');
        }
    }

    const summary = report.getSummary();

    // Load manifest for version info
    const manifest = loadManifest(registryPath);

    // Output report
    if (format === 'json') {
        report.metadata.serviceModelVersionDate = manifest?.lastSynced || null;
        const output = report.toJSON();
        console.log(JSON.stringify(output, null, 2));
    } else {
        // Print static results immediately
        const text = report.toText();
        console.log(text);

        // On success, print version info
        if (summary.errors === 0) {
            const versionDate = manifest?.lastSynced
                ? new Date(manifest.lastSynced).toISOString().split('T')[0]
                : 'unknown';
            console.log('');
            console.log('✅ Validation passed');
            console.log(`   Service model version: ${versionDate}`);
            console.log(`   Fields validated: ${summary.fieldsValidated}`);
        }

        // If smart mode and results are streaming, display them after static
        if (smart && summary.advisory > 0) {
            console.log('');
            console.log('── Smart-mode findings ──');
            for (const finding of report.advisoryFindings) {
                console.log(`  ℹ ${finding.fieldPath || finding.operation}: ${finding.remediationHint || ''}`);
            }
        }
    }

    // Exit code
    const exitCode = summary.errors > 0 ? 1 : 0;
    process.exit(exitCode);
    return exitCode;
}

export default { run, parseDoConfig, validateBenchmarkParams };
