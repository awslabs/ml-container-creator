// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Decomposition Property-Based Tests
 *
 * Property 18: Deployment config decomposition in do/register
 *
 * For any valid deployment config string from the canonical set,
 * decomposing it should produce a valid architecture and backend pair
 * that can be recomposed back to the original string.
 *
 * Feature: deployment-registry, Property 18: Deployment config decomposition
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import DeploymentConfigResolver from '../../generators/app/lib/deployment-config-resolver.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

const VALID_ARCHITECTURES = ['http', 'transformers', 'triton', 'diffusors'];

const resolver = new DeploymentConfigResolver();
const ALL_CONFIGS = resolver.getAllConfigs();

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid deployment config string from the canonical set.
 */
const arbValidDeploymentConfig = fc.constantFrom(...ALL_CONFIGS);

/**
 * Generate an invalid deployment config string that is NOT in the canonical set.
 */
const arbInvalidDeploymentConfig = fc.stringMatching(/^[a-z][a-z0-9-]{2,30}$/)
    .filter(s => !ALL_CONFIGS.includes(s));

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 18: Deployment config decomposition', () => {

    /**
     * Validates: Requirements 2.3
     */

    it('decomposing any canonical config produces a valid architecture and backend', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidDeploymentConfig,
            (config) => {
                const parts = resolver.decompose(config);

                assert.ok(
                    VALID_ARCHITECTURES.includes(parts.architecture),
                    `Architecture "${parts.architecture}" should be one of ${VALID_ARCHITECTURES.join(', ')}`
                );
                assert.ok(
                    typeof parts.backend === 'string' && parts.backend.length > 0,
                    `Backend should be a non-empty string, got "${parts.backend}"`
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('decomposing then recomposing yields the original config string', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidDeploymentConfig,
            (config) => {
                const parts = resolver.decompose(config);
                const recomposed = resolver.compose(parts);

                assert.strictEqual(
                    recomposed,
                    config,
                    `Recomposed "${recomposed}" should equal original "${config}"`
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('decomposing an invalid config string throws an error', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbInvalidDeploymentConfig,
            (config) => {
                assert.throws(
                    () => resolver.decompose(config),
                    /Unsupported deployment-config/,
                    `Should throw for invalid config "${config}"`
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
