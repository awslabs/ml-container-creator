// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared marketplace refusal helper.
 *
 * This module is the single source of the deprecation message and detection
 * logic used by every enforcement point (generator entry, prompt runner), so
 * these tests pin the behavior directly rather than only through subprocess.
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import {
    isMarketplaceConfig,
    isMarketplaceModelName,
    marketplaceRefusalMessage,
    refuseMarketplaceAndExit
} from '../../src/lib/marketplace-refusal.js';

describe('marketplace-refusal helper', () => {

    describe('isMarketplaceConfig', () => {
        it('matches the bare marketplace config', () => {
            assert.equal(isMarketplaceConfig('marketplace'), true);
        });

        it('matches a marketplace-prefixed compound config', () => {
            assert.equal(isMarketplaceConfig('marketplace-realtime'), true);
        });

        it('does not match non-marketplace configs', () => {
            assert.equal(isMarketplaceConfig('transformers-vllm'), false);
            assert.equal(isMarketplaceConfig('predictor'), false);
        });

        it('does not match empty / undefined', () => {
            assert.equal(isMarketplaceConfig(''), false);
            assert.equal(isMarketplaceConfig(undefined), false);
        });
    });

    describe('isMarketplaceModelName', () => {
        it('matches a marketplace:// model name', () => {
            assert.equal(
                isMarketplaceModelName('marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/x/1'),
                true
            );
        });

        it('does not match other model sources', () => {
            assert.equal(isMarketplaceModelName('s3://bucket/model.tar.gz'), false);
            assert.equal(isMarketplaceModelName('registry://pkg'), false);
            assert.equal(isMarketplaceModelName('meta-llama/Llama-2-7b-hf'), false);
        });

        it('does not match non-string / undefined', () => {
            assert.equal(isMarketplaceModelName(undefined), false);
            assert.equal(isMarketplaceModelName(null), false);
        });
    });

    describe('marketplaceRefusalMessage', () => {
        it('states the deprecation and the BYOC rationale', () => {
            const msg = marketplaceRefusalMessage();
            assert.match(msg, /Marketplace deployments are no longer supported/);
            assert.match(msg, /bring your own\s+container/i);
        });

        it('suggests BYOC alternatives (HuggingFace / s3 / registry)', () => {
            const msg = marketplaceRefusalMessage();
            assert.match(msg, /HuggingFace model ID/);
            assert.match(msg, /s3:\/\//);
            assert.match(msg, /registry:\/\//);
        });
    });

    describe('refuseMarketplaceAndExit', () => {
        it('emits the message to the injected error sink and exits with code 1', () => {
            const errors = [];
            let exitCode;
            assert.throws(() => {
                refuseMarketplaceAndExit({
                    error: (line) => errors.push(line),
                    exit: (code) => { exitCode = code; }
                });
            });
            assert.equal(exitCode, 1);
            assert.ok(
                errors.some((l) => /no longer supported/.test(l)),
                'should have emitted the deprecation message'
            );
        });
    });
});
