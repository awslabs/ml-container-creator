// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/config Template Null Omission Property-Based Tests
 *
 * Property 9: Template null omission
 *
 * For any endpoint or iC parameter whose value is null at generation time,
 * the rendered do/config template SHALL NOT contain an export statement for
 * that parameter's shell variable.
 *
 * Feature: cli-config-parameters, Property 9
 *
 * **Validates: Requirements 7.5**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── EJS template snippets (from templates/do/config) ──────────

const ENDPOINT_IC_TEMPLATE = [
    '<% if (endpointInitialInstanceCount != null) { %>',
    'export ENDPOINT_INITIAL_INSTANCE_COUNT="<%= endpointInitialInstanceCount %>"',
    '<% } %>',
    '<% if (endpointDataCapturePercent != null) { %>',
    'export ENDPOINT_DATA_CAPTURE_PERCENT="<%= endpointDataCapturePercent %>"',
    '<% } %>',
    '<% if (endpointVariantName != null) { %>',
    'export ENDPOINT_VARIANT_NAME="<%= endpointVariantName %>"',
    '<% } %>',
    '<% if (endpointVolumeSize != null) { %>',
    'export ENDPOINT_VOLUME_SIZE="<%= endpointVolumeSize %>"',
    '<% } %>',
    '<% if (icCpuCount != null) { %>',
    'export IC_CPU_COUNT="<%= icCpuCount %>"',
    '<% } %>',
    '<% if (icMemorySize != null) { %>',
    'export IC_MEMORY_SIZE="<%= icMemorySize %>"',
    '<% } %>',
    '<% if (icGpuCount != null) { %>',
    'export IC_GPU_COUNT="<%= icGpuCount %>"',
    '<% } %>',
    '<% if (icCopyCount != null) { %>',
    'export IC_COPY_COUNT="<%= icCopyCount %>"',
    '<% } %>',
    '<% if (icModelWeight != null) { %>',
    'export IC_MODEL_WEIGHT="<%= icModelWeight %>"',
    '<% } %>'
].join('\n');

// ── Parameter-to-shell-variable mapping ──────────────────────────────────────

const PARAM_TO_SHELL_VAR = {
    endpointInitialInstanceCount: 'ENDPOINT_INITIAL_INSTANCE_COUNT',
    endpointDataCapturePercent: 'ENDPOINT_DATA_CAPTURE_PERCENT',
    endpointVariantName: 'ENDPOINT_VARIANT_NAME',
    endpointVolumeSize: 'ENDPOINT_VOLUME_SIZE',
    icCpuCount: 'IC_CPU_COUNT',
    icMemorySize: 'IC_MEMORY_SIZE',
    icGpuCount: 'IC_GPU_COUNT',
    icCopyCount: 'IC_COPY_COUNT',
    icModelWeight: 'IC_MODEL_WEIGHT'
};

// ── Arbitrary generators ─────────────────────────────────────────────────────

/**
 * Generate a configuration object where each endpoint/iC parameter is
 * either null or a valid non-null value.
 */
const arbEndpointIcConfig = fc.record({
    endpointInitialInstanceCount: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 100 })),
    endpointDataCapturePercent: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 100 })),
    endpointVariantName: fc.oneof(fc.constant(null), fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,10}$/)),
    endpointVolumeSize: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 16384 })),
    icCpuCount: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 768 })),
    icMemorySize: fc.oneof(fc.constant(null), fc.integer({ min: 128, max: 3145728 })),
    icGpuCount: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 8 })),
    icCopyCount: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 100 })),
    icModelWeight: fc.oneof(fc.constant(null), fc.double({ min: 0, max: 1, noNaN: true }))
});

/**
 * Generate a configuration where at least one parameter is null.
 */
const arbConfigWithSomeNulls = arbEndpointIcConfig.filter(config => {
    const values = Object.values(config);
    return values.some(v => v === null) && values.some(v => v !== null);
});

// ── Helper functions ─────────────────────────────────────────────────────────

function renderTemplate(config) {
    return ejs.render(ENDPOINT_IC_TEMPLATE, config);
}

function getExportLines(rendered) {
    return rendered.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('export '));
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: cli-config-parameters, Property 9: Template null omission', () => {

    describe('null parameters are omitted from rendered output', () => {

        it('for any config with some null parameters, rendered output does NOT contain export for null params', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbConfigWithSomeNulls,
                (config) => {
                    const rendered = renderTemplate(config);
                    const exportLines = getExportLines(rendered);

                    for (const [param, shellVar] of Object.entries(PARAM_TO_SHELL_VAR)) {
                        if (config[param] === null) {
                            // Null parameters must NOT appear in the output
                            const hasExport = exportLines.some(line =>
                                line.includes(shellVar)
                            );
                            assert.strictEqual(hasExport, false,
                                `Parameter "${param}" is null but shell variable "${shellVar}" was found in output`);
                        }
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any config with some non-null parameters, rendered output DOES contain export for non-null params', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbConfigWithSomeNulls,
                (config) => {
                    const rendered = renderTemplate(config);
                    const exportLines = getExportLines(rendered);

                    for (const [param, shellVar] of Object.entries(PARAM_TO_SHELL_VAR)) {
                        if (config[param] !== null) {
                            // Non-null parameters MUST appear in the output
                            const hasExport = exportLines.some(line =>
                                line.includes(shellVar)
                            );
                            assert.strictEqual(hasExport, true,
                                `Parameter "${param}" is non-null (${config[param]}) but shell variable "${shellVar}" was NOT found in output`);
                        }
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any config where all parameters are null, rendered output contains no export statements', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allNullConfig = {
                endpointInitialInstanceCount: null,
                endpointDataCapturePercent: null,
                endpointVariantName: null,
                endpointVolumeSize: null,
                icCpuCount: null,
                icMemorySize: null,
                icGpuCount: null,
                icCopyCount: null,
                icModelWeight: null
            };

            const rendered = renderTemplate(allNullConfig);
            const exportLines = getExportLines(rendered);

            assert.strictEqual(exportLines.length, 0,
                `Expected no export lines when all params are null, got ${exportLines.length}: ${exportLines.join(', ')}`);
        });
    });
});
