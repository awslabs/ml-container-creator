// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discover Mode Source Discrimination Property Test
 *
 * Feature: mcp-catalog-consolidation, Property 9: Discover mode source discrimination
 *
 * For any model name, the Instance_Sizer in discover mode SHALL attempt a HuggingFace
 * API fetch if and only if the model name matches the pattern `org/model-name`
 * (contains exactly one `/` with no protocol prefix).
 *
 * Validates: Requirements 9.1, 9.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { isHuggingFacePattern, PROTOCOL_PREFIXES } from '../../servers/instance-sizer/lib/model-resolver.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 200,
    timeout: 30000,
    verbose: false
};

describe('Feature: mcp-catalog-consolidation, Property 9: Discover mode source discrimination', function () {
    this.timeout(30000);

    it('HuggingFace pattern matches org/model-name format (exactly one slash)', () => {
        // Generate valid HuggingFace model IDs: org/model-name
        const arbOrg = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{1,20}$/);
        const arbModel = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{1,30}$/);

        fc.assert(
            fc.property(arbOrg, arbModel, (org, model) => {
                const modelId = `${org}/${model}`;
                assert.ok(
                    isHuggingFacePattern(modelId),
                    `"${modelId}" should match HuggingFace pattern (org/model-name)`
                );
            }),
            FAST_PROPERTY_CONFIG
        );
    });

    it('protocol-prefixed models never match HuggingFace pattern', () => {
        const arbPrefix = fc.constantFrom(...PROTOCOL_PREFIXES);
        const arbSuffix = fc.string({ minLength: 1, maxLength: 30 });

        fc.assert(
            fc.property(arbPrefix, arbSuffix, (prefix, suffix) => {
                const modelId = `${prefix}${suffix}`;
                assert.ok(
                    !isHuggingFacePattern(modelId),
                    `"${modelId}" should NOT match HuggingFace pattern (has protocol prefix)`
                );
            }),
            FAST_PROPERTY_CONFIG
        );
    });

    it('models with zero slashes do not match HuggingFace pattern', () => {
        const arbNoSlash = fc.string({ minLength: 1, maxLength: 30 })
            .filter(s => !s.includes('/'));

        fc.assert(
            fc.property(arbNoSlash, (modelId) => {
                assert.ok(
                    !isHuggingFacePattern(modelId),
                    `"${modelId}" should NOT match (no slash)`
                );
            }),
            FAST_PROPERTY_CONFIG
        );
    });

    it('models with multiple slashes do not match HuggingFace pattern', () => {
        const arbMultiSlash = fc.tuple(
            fc.stringMatching(/^[a-z]{1,10}$/),
            fc.stringMatching(/^[a-z]{1,10}$/),
            fc.stringMatching(/^[a-z]{1,10}$/)
        ).map(([a, b, c]) => `${a}/${b}/${c}`);

        fc.assert(
            fc.property(arbMultiSlash, (modelId) => {
                assert.ok(
                    !isHuggingFacePattern(modelId),
                    `"${modelId}" should NOT match (multiple slashes)`
                );
            }),
            FAST_PROPERTY_CONFIG
        );
    });

    it('null and empty strings do not match', () => {
        assert.ok(!isHuggingFacePattern(null));
        assert.ok(!isHuggingFacePattern(''));
        assert.ok(!isHuggingFacePattern(undefined));
    });

    it('specific protocol prefixes are correctly excluded', () => {
        const testCases = [
            'jumpstart://meta-textgeneration-llama-2-7b',
            'jumpstart-hub://my-hub/my-model',
            's3://my-bucket/models/model.tar.gz',
            'registry://my-group/my-model'
        ];

        for (const modelId of testCases) {
            assert.ok(
                !isHuggingFacePattern(modelId),
                `"${modelId}" should NOT match HuggingFace pattern`
            );
        }
    });

    it('valid HuggingFace model IDs are correctly identified', () => {
        const testCases = [
            'meta-llama/Llama-2-7b-chat-hf',
            'mistralai/Mistral-7B-Instruct-v0.1',
            'stabilityai/stable-diffusion-3.5-medium',
            'black-forest-labs/FLUX.1-dev',
            'Qwen/Qwen2-7B-Instruct'
        ];

        for (const modelId of testCases) {
            assert.ok(
                isHuggingFacePattern(modelId),
                `"${modelId}" should match HuggingFace pattern`
            );
        }
    });
});
