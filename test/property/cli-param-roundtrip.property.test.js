// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Infrastructure Parameter CLI Round-Trip Property-Based Tests
 *
 * Property 1: Infrastructure parameter CLI round-trip
 *
 * For any infrastructure parameter (endpoint or iC) defined in the
 * Parameter_Matrix and for any valid value within its schema constraints,
 * passing that value via the corresponding CLI flag SHALL result in the
 * final configuration object containing that exact value at the correct key.
 *
 * Feature: cli-config-parameters, Property 1
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ConfigManager from '../../generators/app/lib/config-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Parameter definitions with generators ────────────────────────────────────

const ENDPOINT_PARAMS = [
    {
        name: 'endpointInitialInstanceCount',
        cliOption: 'endpoint-initial-instance-count',
        generator: () => fc.integer({ min: 1, max: 100 })
    },
    {
        name: 'endpointDataCapturePercent',
        cliOption: 'endpoint-data-capture-percent',
        generator: () => fc.integer({ min: 0, max: 100 })
    },
    {
        name: 'endpointVariantName',
        cliOption: 'endpoint-variant-name',
        generator: () => fc.stringMatching(/^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,10}[a-zA-Z0-9])?$/)
    },
    {
        name: 'endpointVolumeSize',
        cliOption: 'endpoint-volume-size',
        generator: () => fc.integer({ min: 1, max: 16384 })
    }
];

const IC_PARAMS = [
    {
        name: 'icCpuCount',
        cliOption: 'ic-cpu-count',
        generator: () => fc.double({ min: 0.25, max: 768, noNaN: true, noDefaultInfinity: true })
            .map(v => Math.round(v * 100) / 100)
    },
    {
        name: 'icMemorySize',
        cliOption: 'ic-memory-size',
        generator: () => fc.integer({ min: 128, max: 3145728 })
    },
    {
        name: 'icGpuCount',
        cliOption: 'ic-gpu-count',
        generator: () => fc.integer({ min: 0, max: 8 })
    },
    {
        name: 'icCopyCount',
        cliOption: 'ic-copy-count',
        generator: () => fc.integer({ min: 0, max: 100 })
    },
    {
        name: 'icModelWeight',
        cliOption: 'ic-model-weight',
        generator: () => fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
            .map(v => Math.round(v * 1000) / 1000)
    }
];

// ── Helper to create a mock generator ────────────────────────────────────────

function createMockGenerator(cliOptions = {}) {
    return {
        options: { ...cliOptions },
        args: [],
        destinationPath: (p) => p || '.'
    };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Infrastructure Parameter CLI Round-Trip Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 1: Infrastructure parameter CLI round-trip
    describe('Property 1: Infrastructure parameter CLI round-trip', () => {

        /**
         * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5
         */

        describe('Endpoint parameters round-trip via CLI', () => {
            for (const param of ENDPOINT_PARAMS) {
                it(`${param.name}: valid value passed via --${param.cliOption} appears in final config`, async function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    await fc.assert(fc.asyncProperty(
                        param.generator(),
                        async (value) => {
                            const mockGenerator = createMockGenerator({
                                [param.cliOption]: value
                            });

                            const configManager = new ConfigManager(mockGenerator);
                            await configManager.loadConfiguration();

                            assert.strictEqual(configManager.config[param.name], value,
                                `Config key "${param.name}" should equal CLI value ${JSON.stringify(value)}, ` +
                                `got ${JSON.stringify(configManager.config[param.name])}`);

                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });

        describe('IC parameters round-trip via CLI', () => {
            for (const param of IC_PARAMS) {
                it(`${param.name}: valid value passed via --${param.cliOption} appears in final config`, async function () {
                    this.timeout(FAST_PROPERTY_CONFIG.timeout);

                    await fc.assert(fc.asyncProperty(
                        param.generator(),
                        async (value) => {
                            const mockGenerator = createMockGenerator({
                                [param.cliOption]: value
                            });

                            const configManager = new ConfigManager(mockGenerator);
                            await configManager.loadConfiguration();

                            assert.strictEqual(configManager.config[param.name], value,
                                `Config key "${param.name}" should equal CLI value ${JSON.stringify(value)}, ` +
                                `got ${JSON.stringify(configManager.config[param.name])}`);

                            return true;
                        }
                    ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
                });
            }
        });
    });
});
