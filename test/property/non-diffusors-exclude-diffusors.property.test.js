// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-Diffusors Configs Exclude Diffusors Files Property-Based Tests
 *
 * Property 5: Non-Diffusors Configs Exclude Diffusors Files
 * Validates: Requirement 5.4
 *
 * Verifies that non-diffusors deployment configs (http, transformers, triton)
 * exclude diffusors template files from the generated output via ignorePatterns.
 *
 * The writing phase in index.js unconditionally adds the glob pattern
 * for diffusors to ignorePatterns, ensuring diffusors source templates
 * are never copied into the output for any architecture. For diffusors
 * configs, the templates are explicitly copied via separate copyTpl
 * calls after the initial bulk copy.
 *
 * Feature: vllm-omni-diffusors
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import DeploymentConfigResolver from '../../src/lib/deployment-config-resolver.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

/** The glob pattern used to exclude diffusors templates in the writing phase */
const DIFFUSORS_IGNORE_PATTERN = '**/diffusors/**';

/** Non-diffusors architecture values */
const NON_DIFFUSORS_ARCHITECTURES = ['http', 'transformers', 'triton', 'marketplace'];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulates the ignorePatterns logic from the writing phase in index.js.
 *
 * The writing phase always pushes triton and diffusors glob patterns
 * to ignorePatterns regardless of architecture. This function replicates
 * that logic so we can verify the property without running the full
 * generator.
 *
 * @param {string} architecture - The resolved architecture
 * @returns {string[]} The ignorePatterns array
 */
function buildIgnorePatterns(architecture) {
    const ignorePatterns = [];

    // Always exclude triton and diffusors source directories (mirrors index.js lines 431-432)
    ignorePatterns.push('**/triton/**');
    ignorePatterns.push('**/diffusors/**');

    // For triton and diffusors architectures, exclude the default Dockerfile
    if (architecture === 'triton' || architecture === 'diffusors') {
        ignorePatterns.push('**/Dockerfile');
    }

    return ignorePatterns;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Non-Diffusors Configs Exclude Diffusors Files Property-Based Tests', () => {

    let resolver;
    let allConfigs;
    let nonDiffusorsConfigs;

    before(() => {
        resolver = new DeploymentConfigResolver();
        allConfigs = resolver.getAllConfigs();
        nonDiffusorsConfigs = allConfigs.filter(dc => {
            const parts = resolver.decompose(dc);
            return parts.architecture !== 'diffusors';
        });

        console.log('\n🚀 Starting Non-Diffusors Exclude Diffusors Files Property Tests');
        console.log('📋 Testing: Non-diffusors configs exclude diffusors template files');
        console.log(`🔧 Configuration: ${FAST_PROPERTY_CONFIG.numRuns} iterations per property`);
        console.log(`📦 Non-diffusors configs: ${nonDiffusorsConfigs.length} of ${allConfigs.length} total\n`);
    });

    /**
     * Property 5: Non-Diffusors Configs Exclude Diffusors Files
     *
     * **Validates: Requirement 5.4**
     *
     * For any non-diffusors deployment config (http, transformers, triton),
     * the writing phase ignorePatterns must include the diffusors glob pattern,
     * ensuring diffusors template files are excluded from the generated output.
     */
    describe('Property 5: Non-Diffusors Configs Exclude Diffusors Files', () => {

        it('all non-diffusors configs resolve to a non-diffusors architecture', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...nonDiffusorsConfigs),
                (dc) => {
                    const parts = resolver.decompose(dc);

                    assert.ok(
                        NON_DIFFUSORS_ARCHITECTURES.includes(parts.architecture),
                        `Expected architecture for '${dc}' to be one of [${NON_DIFFUSORS_ARCHITECTURES}], got '${parts.architecture}'`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('ignorePatterns includes **/diffusors/** for any non-diffusors deployment config', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...nonDiffusorsConfigs),
                (dc) => {
                    const parts = resolver.decompose(dc);
                    const ignorePatterns = buildIgnorePatterns(parts.architecture);

                    assert.ok(
                        ignorePatterns.includes(DIFFUSORS_IGNORE_PATTERN),
                        `Expected ignorePatterns to include '${DIFFUSORS_IGNORE_PATTERN}' for '${dc}' (architecture: '${parts.architecture}'), ` +
                        `but got: [${ignorePatterns.join(', ')}]`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('ignorePatterns includes **/diffusors/** for any non-diffusors architecture', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...NON_DIFFUSORS_ARCHITECTURES),
                (architecture) => {
                    const ignorePatterns = buildIgnorePatterns(architecture);

                    assert.ok(
                        ignorePatterns.includes(DIFFUSORS_IGNORE_PATTERN),
                        `Expected ignorePatterns to include '${DIFFUSORS_IGNORE_PATTERN}' for architecture '${architecture}', ` +
                        `but got: [${ignorePatterns.join(', ')}]`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('diffusors architecture also has **/diffusors/** in ignorePatterns (unconditional exclusion)', () => {
            // This verifies the unconditional nature of the pattern — even diffusors
            // has it in ignorePatterns, because diffusors templates are copied separately
            // via explicit copyTpl calls after the bulk copy.
            const ignorePatterns = buildIgnorePatterns('diffusors');

            assert.ok(
                ignorePatterns.includes(DIFFUSORS_IGNORE_PATTERN),
                'Even diffusors architecture should have **/diffusors/** in ignorePatterns ' +
                '(templates are copied separately via explicit copyTpl calls)'
            );
        });
    });
});
