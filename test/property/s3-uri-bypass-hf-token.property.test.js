// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 URI Bypasses HuggingFace Token Property-Based Tests
 *
 * Property 2: S3 URI Bypasses HuggingFace Token
 *
 * For any modelName starting with `s3://`, the generator SHALL NOT require
 * or inject a HuggingFace token into the generated project.
 *
 * Feature: ftp-benchmark-support, Property 2: S3 URI Bypasses HuggingFace Token
 *
 * Validates: Requirements FTP-2 (2.3)
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import PromptRunner from '../../src/lib/prompt-runner.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a PromptRunner instance with mocked dependencies sufficient
 * to call _secretStagesApply without side-effects.
 */
function createTestRunner() {
    const promptFn = async () => ({});
    const configManager = {
        parameterMatrix: {},
        getExplicitConfiguration: () => ({}),
        isAutoPrompt: () => false
    };

    const runner = new PromptRunner({
        configManager,
        options: {},
        registryConfigManager: null,
        baseConfig: {},
        promptFn
    });

    return runner;
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid S3 bucket name.
 * S3 bucket names: 3-63 chars, lowercase letters, numbers, hyphens, dots.
 */
const arbS3BucketName = fc.stringMatching(/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/)
    .filter(s => !s.includes('..') && !s.startsWith('-') && !s.endsWith('-'));

/**
 * Generate a valid S3 key path segment (non-empty, no leading slash).
 */
const arbS3KeySegment = fc.stringMatching(/^[a-zA-Z0-9_\-][a-zA-Z0-9_\-./]{0,30}$/)
    .filter(s => s.length > 0 && !s.includes('//'));

/**
 * Generate a full valid S3 URI in the form s3://bucket/path/
 */
const arbS3Uri = fc.tuple(arbS3BucketName, arbS3KeySegment).map(
    ([bucket, key]) => `s3://${bucket}/${key}/`
);

/**
 * Architectures that normally require an HF token (transformers, diffusors, triton+vllm).
 * We test against these to ensure S3 overrides even when architecture would need HF.
 */
const arbHfArchitecture = fc.constantFrom(
    { architecture: 'transformers', backend: 'vllm' },
    { architecture: 'transformers', backend: 'sglang' },
    { architecture: 'transformers', backend: 'tensorrt-llm' },
    { architecture: 'transformers', backend: 'lmi' },
    { architecture: 'diffusors', backend: 'diffusers' },
    { architecture: 'triton', backend: 'vllm' },
    { architecture: 'triton', backend: 'tensorrtllm' }
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: ftp-benchmark-support, Property 2: S3 URI Bypasses HuggingFace Token', () => {

    /**
     * Validates: Requirements FTP-2 (2.3)
     *
     * For any modelName starting with s3://, _secretStagesApply returns false
     * for 'hf-token' classification — meaning HF token is NOT required.
     */
    it('S3 URI in modelName bypasses HF token requirement for all HF-dependent architectures', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const runner = createTestRunner();
        const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };

        fc.assert(fc.property(
            arbS3Uri,
            arbHfArchitecture,
            (s3Uri, archConfig) => {
                const answers = {
                    ...archConfig,
                    modelName: s3Uri
                };

                const result = runner._secretStagesApply(classification, answers);

                assert.strictEqual(
                    result,
                    false,
                    `Expected HF token NOT required for S3 URI "${s3Uri}" with architecture=${archConfig.architecture}, backend=${archConfig.backend}`
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements FTP-2 (2.3)
     *
     * For any customModelName starting with s3://, _secretStagesApply returns false
     * for 'hf-token' classification — meaning HF token is NOT required.
     * (customModelName is an alternative field used when user provides a custom model name)
     */
    it('S3 URI in customModelName bypasses HF token requirement for all HF-dependent architectures', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const runner = createTestRunner();
        const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };

        fc.assert(fc.property(
            arbS3Uri,
            arbHfArchitecture,
            (s3Uri, archConfig) => {
                const answers = {
                    ...archConfig,
                    customModelName: s3Uri
                };

                const result = runner._secretStagesApply(classification, answers);

                assert.strictEqual(
                    result,
                    false,
                    `Expected HF token NOT required for customModelName S3 URI "${s3Uri}" with architecture=${archConfig.architecture}, backend=${archConfig.backend}`
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements FTP-2 (2.3)
     *
     * Sanity check — confirms that without an S3 URI, the same architectures
     * DO require an HF token (ensuring the test setup is correct).
     */
    it('non-S3 model names still require HF token for HF-dependent architectures', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const runner = createTestRunner();
        const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };

        // Generate HuggingFace-style model names (not starting with s3://)
        const arbHfModelName = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_\-]{1,30}\/[a-zA-Z0-9_\-.]{1,30}$/)
            .filter(s => !s.startsWith('s3://'));

        // Only test architectures that definitely need HF token (transformers and diffusors)
        const arbRequiringArch = fc.constantFrom(
            { architecture: 'transformers', backend: 'vllm' },
            { architecture: 'transformers', backend: 'sglang' },
            { architecture: 'diffusors', backend: 'diffusers' }
        );

        fc.assert(fc.property(
            arbHfModelName,
            arbRequiringArch,
            (modelName, archConfig) => {
                const answers = {
                    ...archConfig,
                    modelName
                };

                const result = runner._secretStagesApply(classification, answers);

                assert.strictEqual(
                    result,
                    true,
                    `Expected HF token REQUIRED for non-S3 model "${modelName}" with architecture=${archConfig.architecture}, backend=${archConfig.backend}`
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
