// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 Graceful Degradation Property-Based Tests
 *
 * Property 3: For any build state where S3 cannot be used (download failure,
 * missing staged assets, or service unavailability), the build process SHALL
 * complete successfully by downloading from HuggingFace — the build never fails
 * solely due to S3 unavailability.
 *
 * Feature: s3-model-loading, Property 3: Graceful degradation
 * Validates: Requirements 2.4, 2.6, 2.8
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Logic under test ─────────────────────────────────────────────────────────

/**
 * Simulates the build process: tries S3, falls back to HF.
 * This mirrors the Dockerfile RUN conditional logic:
 *   - If MODEL_S3_URI is set and S3 works → use S3
 *   - If MODEL_S3_URI is set but S3 fails → fall back to HF
 *   - If MODEL_S3_URI is not set → download from HF directly
 */
function simulateBuildDownload(modelS3Uri, s3Available, hfAvailable) {
    if (modelS3Uri && s3Available) {
        return { source: 's3', success: true };
    } else if (modelS3Uri && !s3Available && hfAvailable) {
        return { source: 'huggingface', success: true, fallback: true };
    } else if (!modelS3Uri && hfAvailable) {
        return { source: 'huggingface', success: true };
    } else if (!modelS3Uri && !hfAvailable) {
        return { source: 'huggingface', success: false };
    } else {
        return { source: 'huggingface', success: false };
    }
}

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid S3 URIs representing staged models
const arbValidS3Uri = fc.tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}[a-z0-9]$/).filter(s => !s.includes('--')),
    fc.stringMatching(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/).filter(s => !s.includes('--'))
).map(([bucket, project]) => `s3://${bucket}/models/${project}/`);

// Model S3 URI: either a valid S3 URI (staged) or empty string (not staged)
const arbModelS3Uri = fc.oneof(arbValidS3Uri, fc.constant(''));

// S3 availability: boolean — S3 download succeeds or fails
const arbS3Available = fc.boolean();

// HF availability: boolean — HF download succeeds or fails (always true in practice)
const arbHfAvailable = fc.boolean();

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: s3-model-loading, Property 3: Graceful degradation', () => {

    describe('S3 failure never causes build failure when HF is available', () => {

        it('when S3 URI is provided but S3 fails, build still succeeds via HF fallback', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbValidS3Uri,
                (s3Uri) => {
                    // S3 fails, HF available
                    const result = simulateBuildDownload(s3Uri, false, true);
                    assert.strictEqual(result.success, true,
                        `build must succeed when S3 fails but HF is available.\n  S3 URI: "${s3Uri}"\n  Result: ${JSON.stringify(result)}`);
                    assert.strictEqual(result.source, 'huggingface',
                        `source must be "huggingface" when S3 fails.\n  Got: "${result.source}"`);
                    assert.strictEqual(result.fallback, true,
                        'fallback flag must be true when S3 fails and HF takes over');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('when no staged assets exist (empty URI), build succeeds via HF', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbS3Available,
                (s3Available) => {
                    // No S3 URI, HF available — should always succeed regardless of S3 state
                    const result = simulateBuildDownload('', s3Available, true);
                    assert.strictEqual(result.success, true,
                        `build must succeed when no staged assets exist and HF is available.\n  s3Available: ${s3Available}\n  Result: ${JSON.stringify(result)}`);
                    assert.strictEqual(result.source, 'huggingface',
                        `source must be "huggingface" when no S3 URI is set.\n  Got: "${result.source}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('build NEVER fails solely due to S3 being unavailable', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelS3Uri,
                (modelS3Uri) => {
                    // S3 is unavailable, HF is available
                    const result = simulateBuildDownload(modelS3Uri, false, true);
                    assert.strictEqual(result.success, true,
                        `build must NEVER fail solely due to S3 unavailability.\n  MODEL_S3_URI: "${modelS3Uri}"\n  Result: ${JSON.stringify(result)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('S3 is preferred when available', () => {

        it('when both S3 and HF are available, S3 is preferred', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbValidS3Uri,
                (s3Uri) => {
                    // Both available — S3 should be preferred
                    const result = simulateBuildDownload(s3Uri, true, true);
                    assert.strictEqual(result.source, 's3',
                        `S3 must be preferred when both are available.\n  S3 URI: "${s3Uri}"\n  Got source: "${result.source}"`);
                    assert.strictEqual(result.success, true,
                        'build must succeed when S3 is available');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Build only fails when HuggingFace itself is unavailable', () => {

        it('the only scenario where build fails is when HF is unavailable', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelS3Uri, arbS3Available, arbHfAvailable,
                (modelS3Uri, s3Available, hfAvailable) => {
                    const result = simulateBuildDownload(modelS3Uri, s3Available, hfAvailable);

                    if (result.success === false) {
                        // If the build failed, HF must be unavailable AND S3 must not have been usable
                        assert.strictEqual(hfAvailable, false,
                            `build can only fail when HF is unavailable.\n  MODEL_S3_URI: "${modelS3Uri}"\n  s3Available: ${s3Available}\n  hfAvailable: ${hfAvailable}\n  Result: ${JSON.stringify(result)}`);
                        // Additionally, S3 must not have been usable (either no URI or S3 down)
                        const s3Usable = !!(modelS3Uri && s3Available);
                        assert.strictEqual(s3Usable, false,
                            'if build failed, S3 must also not have been usable');
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('when HF is available, the build always succeeds regardless of S3 state', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelS3Uri, arbS3Available,
                (modelS3Uri, s3Available) => {
                    // HF always available
                    const result = simulateBuildDownload(modelS3Uri, s3Available, true);
                    assert.strictEqual(result.success, true,
                        `build must always succeed when HF is available.\n  MODEL_S3_URI: "${modelS3Uri}"\n  s3Available: ${s3Available}\n  Result: ${JSON.stringify(result)}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
