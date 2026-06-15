// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source Manifest Traceability Property-Based Tests
 *
 * Property 13: Source manifest traceability
 *
 * For any parameter set from multiple sources (CLI, config file, registry,
 * default), the source manifest SHALL contain an entry for each parameter
 * recording its final value and the source that provided it, with the source
 * matching the highest-precedence source that supplied a non-null value.
 *
 * Feature: cli-config-parameters, Property 13
 *
 * **Validates: Requirements 8.5**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ConfigManager from '../../src/lib/config-manager.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid env var key.
 */
const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/);

/**
 * Generate a valid env var value.
 */
const arbEnvValue = fc.string({ minLength: 1, maxLength: 30 });

/**
 * Generate a valid endpoint initial instance count (within schema bounds).
 */
const arbInstanceCount = fc.integer({ min: 1, max: 100 });

/**
 * Generate a valid data capture percent (within schema bounds).
 */
const arbDataCapturePercent = fc.integer({ min: 0, max: 100 });

/**
 * Generate a valid IC copy count (within schema bounds).
 */
const arbCopyCount = fc.integer({ min: 0, max: 100 });

// ── Helper to create a mock generator ────────────────────────────────────────

function createMockGenerator(cliOptions = {}) {
    return {
        options: { ...cliOptions },
        args: [],
        destDir: process.cwd()
    };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Source Manifest Traceability Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 13: Source manifest traceability
    describe('Property 13: Source manifest traceability', () => {

        /**
         * Validates: Requirements 8.5
         */

        it('manifest records correct source for CLI parameters', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbInstanceCount,
                arbDataCapturePercent,
                async (instanceCount, dataCapturePercent) => {
                    const mockGenerator = createMockGenerator({
                        'endpoint-initial-instance-count': instanceCount,
                        'endpoint-data-capture-percent': dataCapturePercent
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    const { manifest } = configManager.getFullConfiguration();

                    // Find manifest entries for CLI-provided parameters
                    const instanceCountEntry = manifest.find(
                        e => e.param === 'endpointInitialInstanceCount'
                    );
                    const dataCaptureEntry = manifest.find(
                        e => e.param === 'endpointDataCapturePercent'
                    );

                    assert.ok(instanceCountEntry,
                        'manifest should contain entry for endpointInitialInstanceCount');
                    assert.strictEqual(instanceCountEntry.source, 'cli',
                        'source should be "cli" for CLI-provided parameter');
                    assert.strictEqual(instanceCountEntry.value, instanceCount,
                        'value should match CLI-provided value');

                    assert.ok(dataCaptureEntry,
                        'manifest should contain entry for endpointDataCapturePercent');
                    assert.strictEqual(dataCaptureEntry.source, 'cli',
                        'source should be "cli" for CLI-provided parameter');
                    assert.strictEqual(dataCaptureEntry.value, dataCapturePercent,
                        'value should match CLI-provided value');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('manifest records correct source for config-file parameters', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbInstanceCount,
                arbCopyCount,
                async (instanceCount, copyCount) => {
                    const mockGenerator = createMockGenerator({
                        // Provide config-json inline to simulate config file
                        'config-json': JSON.stringify({
                            endpointConfig: { initialInstanceCount: instanceCount },
                            icConfig: { copyCount }
                        })
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    const { manifest } = configManager.getFullConfiguration();

                    const instanceCountEntry = manifest.find(
                        e => e.param === 'endpointInitialInstanceCount'
                    );
                    const copyCountEntry = manifest.find(
                        e => e.param === 'icCopyCount'
                    );

                    assert.ok(instanceCountEntry,
                        'manifest should contain entry for endpointInitialInstanceCount');
                    assert.strictEqual(instanceCountEntry.source, 'config-file',
                        'source should be "config-file" for config-file-provided parameter');
                    assert.strictEqual(instanceCountEntry.value, instanceCount,
                        'value should match config-file-provided value');

                    assert.ok(copyCountEntry,
                        'manifest should contain entry for icCopyCount');
                    assert.strictEqual(copyCountEntry.source, 'config-file',
                        'source should be "config-file" for config-file-provided parameter');
                    assert.strictEqual(copyCountEntry.value, copyCount,
                        'value should match config-file-provided value');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('CLI source overrides config-file source in manifest', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbInstanceCount,
                arbInstanceCount,
                async (cliValue, configFileValue) => {
                    // Ensure CLI and config-file values are different
                    fc.pre(cliValue !== configFileValue);

                    const mockGenerator = createMockGenerator({
                        'endpoint-initial-instance-count': cliValue,
                        'config-json': JSON.stringify({
                            endpointConfig: { initialInstanceCount: configFileValue }
                        })
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    const { manifest } = configManager.getFullConfiguration();

                    const entry = manifest.find(
                        e => e.param === 'endpointInitialInstanceCount'
                    );

                    assert.ok(entry,
                        'manifest should contain entry for endpointInitialInstanceCount');
                    assert.strictEqual(entry.source, 'cli',
                        'source should be "cli" since CLI has higher precedence than config-file');
                    assert.strictEqual(entry.value, cliValue,
                        'value should be CLI value since CLI has higher precedence');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('manifest records "default" source for parameters with only defaults', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                fc.constant(true),
                async () => {
                    const mockGenerator = createMockGenerator({});

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    const { manifest } = configManager.getFullConfiguration();

                    // Parameters with defaults should have 'default' source
                    const buildTargetEntry = manifest.find(
                        e => e.param === 'buildTarget'
                    );
                    assert.ok(buildTargetEntry,
                        'manifest should contain entry for buildTarget (has default)');
                    assert.strictEqual(buildTargetEntry.source, 'default',
                        'source should be "default" for parameter with only default value');
                    assert.strictEqual(buildTargetEntry.value, 'codebuild',
                        'value should be the default value');

                    const regionEntry = manifest.find(
                        e => e.param === 'awsRegion'
                    );
                    assert.ok(regionEntry,
                        'manifest should contain entry for awsRegion (has default)');
                    assert.strictEqual(regionEntry.source, 'default',
                        'source should be "default" for parameter with only default value');
                    assert.strictEqual(regionEntry.value, 'us-east-1',
                        'value should be the default value');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('manifest records correct source for registry env vars', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                fc.uniqueArray(
                    fc.tuple(arbEnvKey, arbEnvValue),
                    { minLength: 1, maxLength: 5, selector: ([k]) => k }
                ),
                async (registryPairs) => {
                    const mockGenerator = createMockGenerator({});

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    // Merge registry env vars
                    const registryModelEnvVars = {};
                    for (const [key, value] of registryPairs) {
                        registryModelEnvVars[key] = value;
                    }
                    configManager.mergeRegistryEnvVars(registryModelEnvVars, {});

                    const { manifest } = configManager.getFullConfiguration();

                    // Each registry env var should have 'registry' source
                    for (const [key, value] of registryPairs) {
                        const entry = manifest.find(
                            e => e.param === `modelEnvVars.${key}`
                        );
                        assert.ok(entry,
                            `manifest should contain entry for modelEnvVars.${key}`);
                        assert.strictEqual(entry.source, 'registry',
                            `source should be "registry" for registry-provided env var ${key}`);
                        assert.strictEqual(entry.value, value,
                            `value should match registry-provided value for ${key}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('CLI env vars override registry env vars in manifest', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                fc.uniqueArray(
                    fc.tuple(arbEnvKey, arbEnvValue, arbEnvValue),
                    { minLength: 1, maxLength: 5, selector: ([k]) => k }
                ),
                async (overlappingPairs) => {
                    // Build CLI model-env flags
                    const modelEnvFlags = overlappingPairs.map(
                        ([key, cliValue]) => `${key}=${cliValue}`
                    );

                    const mockGenerator = createMockGenerator({
                        'model-env': modelEnvFlags
                    });

                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    // Merge registry env vars with different values
                    const registryModelEnvVars = {};
                    for (const [key, , registryValue] of overlappingPairs) {
                        registryModelEnvVars[key] = registryValue;
                    }
                    configManager.mergeRegistryEnvVars(registryModelEnvVars, {});

                    const { manifest } = configManager.getFullConfiguration();

                    // CLI should win — manifest should show 'cli' source
                    for (const [key, cliValue] of overlappingPairs) {
                        const entry = manifest.find(
                            e => e.param === `modelEnvVars.${key}`
                        );
                        assert.ok(entry,
                            `manifest should contain entry for modelEnvVars.${key}`);
                        assert.strictEqual(entry.source, 'cli',
                            `source should be "cli" for CLI-provided env var ${key}`);
                        assert.strictEqual(entry.value, cliValue,
                            `value should be CLI value for ${key}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
