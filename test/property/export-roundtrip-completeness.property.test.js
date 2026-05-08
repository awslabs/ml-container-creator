// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Export Round-Trip Completeness Property-Based Tests
 *
 * Property 8: Export round-trip completeness
 *
 * For any configuration containing endpoint parameters, iC parameters,
 * model env vars, and server env vars, the do/export --json output SHALL
 * contain all four parameter families with values matching the generation-time
 * configuration, and the CLI command output SHALL include a flag for each
 * non-default parameter.
 *
 * Feature: cli-config-parameters, Property 8
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Load the actual do/export template ───────────────────────────────────────

const EXPORT_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/export');
const EXPORT_TEMPLATE = readFileSync(EXPORT_TEMPLATE_PATH, 'utf8');

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbEndpointConfig = fc.record({
    endpointInitialInstanceCount: fc.oneof(fc.constant(null), fc.integer({ min: 2, max: 100 })),
    endpointDataCapturePercent: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 100 })),
    endpointVariantName: fc.oneof(fc.constant(null), fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,10}$/)),
    endpointVolumeSize: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 16384 }))
});

const arbIcConfig = fc.record({
    icCpuCount: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 768 })),
    icMemorySize: fc.oneof(fc.constant(null), fc.integer({ min: 128, max: 3145728 })),
    icGpuCount: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 8 })),
    icCopyCount: fc.oneof(fc.constant(null), fc.integer({ min: 2, max: 100 })),
    icModelWeight: fc.oneof(fc.constant(null), fc.double({ min: 0.01, max: 0.99, noNaN: true }))
});

const arbEnvVarKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,15}$/);
const arbEnvVarValue = fc.stringMatching(/^[a-zA-Z0-9._/-]{1,20}$/);

const arbModelEnvVars = fc.dictionary(arbEnvVarKey, arbEnvVarValue, { minKeys: 1, maxKeys: 3 });
const arbServerEnvVars = fc.dictionary(arbEnvVarKey, arbEnvVarValue, { minKeys: 1, maxKeys: 3 });

/**
 * Generate a full configuration with all four parameter families populated.
 */
const arbFullConfig = fc.tuple(
    arbEndpointConfig,
    arbIcConfig,
    arbModelEnvVars,
    arbServerEnvVars
).map(([endpoint, ic, modelEnvVars, serverEnvVars]) => ({
    // Core required fields for template rendering
    projectName: 'test-project',
    deploymentConfig: 'transformers-vllm',
    framework: 'transformers',
    modelServer: 'vllm',
    modelName: 'meta-llama/Llama-2-7b',
    buildTarget: 'local',
    deploymentTarget: 'realtime-inference',
    instanceType: 'ml.g5.xlarge',
    awsRegion: 'us-east-1',
    roleArn: null,
    hfToken: null,
    fsxVolumeHandle: null,
    modelFormat: null,
    codebuildComputeType: null,
    // New parameter families
    ...endpoint,
    ...ic,
    modelEnvVars,
    serverEnvVars
}));

// ── Helper functions ─────────────────────────────────────────────────────────

function renderExportTemplate(config) {
    return ejs.render(EXPORT_TEMPLATE, config);
}

/**
 * Parse the rendered JSON section to extract what JSON fields would be produced.
 * Since the template renders EJS at generation time, the JSON values are
 * baked into the shell script. We can extract them from the rendered output.
 *
 * The rendered output uses \" for shell-level keys and unescaped quotes for
 * the inner JSON content rendered by EJS <%- %>.
 */
function extractJsonFields(rendered) {
    const fields = {};

    // Look for endpointConfig object - pattern: \"endpointConfig\":{...}
    const epMatch = rendered.match(/\\?"endpointConfig\\?":\{([^}]*)\}/);
    if (epMatch) {
        fields.endpointConfig = epMatch[1];
    }

    // Look for icConfig object
    const icMatch = rendered.match(/\\?"icConfig\\?":\{([^}]*)\}/);
    if (icMatch) {
        fields.icConfig = icMatch[1];
    }

    // Look for modelEnvVars object
    const mMatch = rendered.match(/\\?"modelEnvVars\\?":\{([^}]*)\}/);
    if (mMatch) {
        fields.modelEnvVars = mMatch[1];
    }

    // Look for serverEnvVars object
    const sMatch = rendered.match(/\\?"serverEnvVars\\?":\{([^}]*)\}/);
    if (sMatch) {
        fields.serverEnvVars = sMatch[1];
    }

    return fields;
}

/**
 * Extract CLI flags from the rendered CLI section.
 */
function extractCliFlags(rendered) {
    const flags = [];
    const flagPattern = /CMD="\$\{CMD\} (--[^"]+)"/g;
    let match;
    while ((match = flagPattern.exec(rendered)) !== null) {
        flags.push(match[1]);
    }
    return flags;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: cli-config-parameters, Property 8: Export round-trip completeness', () => {

    describe('JSON output contains all parameter families with matching values', () => {

        it('endpointConfig is present in JSON output when non-default endpoint params exist', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig.filter(c =>
                    (c.endpointInitialInstanceCount !== null && c.endpointInitialInstanceCount !== 1) ||
                    (c.endpointDataCapturePercent !== null && c.endpointDataCapturePercent !== 0) ||
                    (c.endpointVariantName !== null && c.endpointVariantName !== 'AllTraffic') ||
                    (c.endpointVolumeSize !== null)
                ),
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const fields = extractJsonFields(rendered);

                    assert.ok(fields.endpointConfig !== undefined,
                        'JSON output must contain endpointConfig when non-default endpoint params exist');

                    // Verify individual values
                    if (config.endpointInitialInstanceCount !== null && config.endpointInitialInstanceCount !== 1) {
                        assert.ok(fields.endpointConfig.includes(`"initialInstanceCount":${config.endpointInitialInstanceCount}`),
                            `endpointConfig must include initialInstanceCount=${config.endpointInitialInstanceCount}`);
                    }
                    if (config.endpointDataCapturePercent !== null && config.endpointDataCapturePercent !== 0) {
                        assert.ok(fields.endpointConfig.includes(`"dataCapturePercent":${config.endpointDataCapturePercent}`),
                            `endpointConfig must include dataCapturePercent=${config.endpointDataCapturePercent}`);
                    }
                    if (config.endpointVariantName !== null && config.endpointVariantName !== 'AllTraffic') {
                        assert.ok(fields.endpointConfig.includes(`"variantName":"${config.endpointVariantName}"`),
                            `endpointConfig must include variantName=${config.endpointVariantName}`);
                    }
                    if (config.endpointVolumeSize !== null) {
                        assert.ok(fields.endpointConfig.includes(`"volumeSize":${config.endpointVolumeSize}`),
                            `endpointConfig must include volumeSize=${config.endpointVolumeSize}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('icConfig is present in JSON output when non-default iC params exist', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig.filter(c =>
                    (c.icCpuCount !== null) ||
                    (c.icMemorySize !== null) ||
                    (c.icGpuCount !== null) ||
                    (c.icCopyCount !== null && c.icCopyCount !== 1) ||
                    (c.icModelWeight !== null && c.icModelWeight !== 1.0)
                ),
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const fields = extractJsonFields(rendered);

                    assert.ok(fields.icConfig !== undefined,
                        'JSON output must contain icConfig when non-default iC params exist');

                    // Verify individual values
                    if (config.icCpuCount !== null) {
                        assert.ok(fields.icConfig.includes(`"cpuCount":${config.icCpuCount}`),
                            `icConfig must include cpuCount=${config.icCpuCount}`);
                    }
                    if (config.icMemorySize !== null) {
                        assert.ok(fields.icConfig.includes(`"memorySize":${config.icMemorySize}`),
                            `icConfig must include memorySize=${config.icMemorySize}`);
                    }
                    if (config.icGpuCount !== null) {
                        assert.ok(fields.icConfig.includes(`"gpuCount":${config.icGpuCount}`),
                            `icConfig must include gpuCount=${config.icGpuCount}`);
                    }
                    if (config.icCopyCount !== null && config.icCopyCount !== 1) {
                        assert.ok(fields.icConfig.includes(`"copyCount":${config.icCopyCount}`),
                            `icConfig must include copyCount=${config.icCopyCount}`);
                    }
                    if (config.icModelWeight !== null && config.icModelWeight !== 1.0) {
                        assert.ok(fields.icConfig.includes('"modelWeight":'),
                            'icConfig must include modelWeight');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('modelEnvVars is present in JSON output when model env vars exist', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig.filter(c => Object.keys(c.modelEnvVars).length > 0),
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const fields = extractJsonFields(rendered);

                    assert.ok(fields.modelEnvVars !== undefined,
                        'JSON output must contain modelEnvVars when model env vars exist');

                    // Verify each key-value pair is present
                    for (const [key, value] of Object.entries(config.modelEnvVars)) {
                        assert.ok(fields.modelEnvVars.includes(`"${key}":"${value}"`),
                            `modelEnvVars must include ${key}=${value}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('serverEnvVars is present in JSON output when server env vars exist', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig.filter(c => Object.keys(c.serverEnvVars).length > 0),
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const fields = extractJsonFields(rendered);

                    assert.ok(fields.serverEnvVars !== undefined,
                        'JSON output must contain serverEnvVars when server env vars exist');

                    // Verify each key-value pair is present
                    for (const [key, value] of Object.entries(config.serverEnvVars)) {
                        assert.ok(fields.serverEnvVars.includes(`"${key}":"${value}"`),
                            `serverEnvVars must include ${key}=${value}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('JSON output uses camelCase keys consistent with ConfigManager conventions', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig.filter(c =>
                    (c.endpointInitialInstanceCount !== null && c.endpointInitialInstanceCount !== 1) &&
                    (c.icCpuCount !== null) &&
                    Object.keys(c.modelEnvVars).length > 0 &&
                    Object.keys(c.serverEnvVars).length > 0
                ),
                (config) => {
                    const rendered = renderExportTemplate(config);

                    // Verify camelCase keys are used (may be escaped or unescaped)
                    assert.ok(rendered.includes('endpointConfig'),
                        'Must use camelCase key "endpointConfig"');
                    assert.ok(rendered.includes('icConfig'),
                        'Must use camelCase key "icConfig"');
                    assert.ok(rendered.includes('modelEnvVars'),
                        'Must use camelCase key "modelEnvVars"');
                    assert.ok(rendered.includes('serverEnvVars'),
                        'Must use camelCase key "serverEnvVars"');
                    assert.ok(rendered.includes('initialInstanceCount'),
                        'Must use camelCase key "initialInstanceCount"');
                    assert.ok(rendered.includes('cpuCount'),
                        'Must use camelCase key "cpuCount"');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('CLI output includes a flag for each non-default parameter', () => {

        it('endpoint flags are included for non-default endpoint params', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig,
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const flags = extractCliFlags(rendered);

                    if (config.endpointInitialInstanceCount !== null && config.endpointInitialInstanceCount !== 1) {
                        assert.ok(flags.some(f => f === `--endpoint-initial-instance-count=${config.endpointInitialInstanceCount}`),
                            `CLI must include --endpoint-initial-instance-count=${config.endpointInitialInstanceCount}`);
                    }
                    if (config.endpointDataCapturePercent !== null && config.endpointDataCapturePercent !== 0) {
                        assert.ok(flags.some(f => f === `--endpoint-data-capture-percent=${config.endpointDataCapturePercent}`),
                            `CLI must include --endpoint-data-capture-percent=${config.endpointDataCapturePercent}`);
                    }
                    if (config.endpointVariantName !== null && config.endpointVariantName !== 'AllTraffic') {
                        assert.ok(flags.some(f => f === `--endpoint-variant-name=${config.endpointVariantName}`),
                            `CLI must include --endpoint-variant-name=${config.endpointVariantName}`);
                    }
                    if (config.endpointVolumeSize !== null) {
                        assert.ok(flags.some(f => f === `--endpoint-volume-size=${config.endpointVolumeSize}`),
                            `CLI must include --endpoint-volume-size=${config.endpointVolumeSize}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('iC flags are included for non-default iC params', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig,
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const flags = extractCliFlags(rendered);

                    if (config.icCpuCount !== null) {
                        assert.ok(flags.some(f => f === `--ic-cpu-count=${config.icCpuCount}`),
                            `CLI must include --ic-cpu-count=${config.icCpuCount}`);
                    }
                    if (config.icMemorySize !== null) {
                        assert.ok(flags.some(f => f === `--ic-memory-size=${config.icMemorySize}`),
                            `CLI must include --ic-memory-size=${config.icMemorySize}`);
                    }
                    if (config.icGpuCount !== null) {
                        assert.ok(flags.some(f => f === `--ic-gpu-count=${config.icGpuCount}`),
                            `CLI must include --ic-gpu-count=${config.icGpuCount}`);
                    }
                    if (config.icCopyCount !== null && config.icCopyCount !== 1) {
                        assert.ok(flags.some(f => f === `--ic-copy-count=${config.icCopyCount}`),
                            `CLI must include --ic-copy-count=${config.icCopyCount}`);
                    }
                    if (config.icModelWeight !== null && config.icModelWeight !== 1.0) {
                        assert.ok(flags.some(f => f.startsWith('--ic-model-weight=')),
                            'CLI must include --ic-model-weight flag');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('model-env flags are included for each model env var', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig.filter(c => Object.keys(c.modelEnvVars).length > 0),
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const flags = extractCliFlags(rendered);

                    for (const [key, value] of Object.entries(config.modelEnvVars)) {
                        assert.ok(flags.some(f => f === `--model-env=${key}=${value}`),
                            `CLI must include --model-env=${key}=${value}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('server-env flags are included for each server env var', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullConfig.filter(c => Object.keys(c.serverEnvVars).length > 0),
                (config) => {
                    const rendered = renderExportTemplate(config);
                    const flags = extractCliFlags(rendered);

                    for (const [key, value] of Object.entries(config.serverEnvVars)) {
                        assert.ok(flags.some(f => f === `--server-env=${key}=${value}`),
                            `CLI must include --server-env=${key}=${value}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('default-valued params are NOT included in CLI output', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            // Test with all defaults
            const defaultConfig = {
                projectName: 'test-project',
                deploymentConfig: 'transformers-vllm',
                framework: 'transformers',
                modelServer: 'vllm',
                modelName: 'meta-llama/Llama-2-7b',
                buildTarget: 'local',
                deploymentTarget: 'realtime-inference',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                roleArn: null,
                hfToken: null,
                fsxVolumeHandle: null,
                modelFormat: null,
                codebuildComputeType: null,
                endpointInitialInstanceCount: 1,
                endpointDataCapturePercent: 0,
                endpointVariantName: 'AllTraffic',
                endpointVolumeSize: null,
                icCpuCount: null,
                icMemorySize: null,
                icGpuCount: null,
                icCopyCount: 1,
                icModelWeight: 1.0,
                modelEnvVars: {},
                serverEnvVars: {}
            };

            const rendered = renderExportTemplate(defaultConfig);
            const flags = extractCliFlags(rendered);

            assert.ok(!flags.some(f => f.startsWith('--endpoint-')),
                'No --endpoint-* flags should appear for default values');
            assert.ok(!flags.some(f => f.startsWith('--ic-')),
                'No --ic-* flags should appear for default values');
            assert.ok(!flags.some(f => f.startsWith('--model-env')),
                'No --model-env flags should appear when modelEnvVars is empty');
            assert.ok(!flags.some(f => f.startsWith('--server-env')),
                'No --server-env flags should appear when serverEnvVars is empty');
        });
    });
});
