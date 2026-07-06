// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/lib/dlc-resolver.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DlcResolutionError, DLC_ACCOUNT_IDS, isDlcImage } from '../../src/lib/dlc-resolver.js';

describe('DLC Resolver', () => {
    describe('DLC_ACCOUNT_IDS', () => {
        it('contains known AWS DLC account IDs', () => {
            assert.ok(Array.isArray(DLC_ACCOUNT_IDS));
            assert.ok(DLC_ACCOUNT_IDS.length > 0);
            // Primary US account
            assert.ok(DLC_ACCOUNT_IDS.includes('763104351884'));
        });

        it('all entries are 12-digit strings', () => {
            for (const id of DLC_ACCOUNT_IDS) {
                assert.match(id, /^\d{12}$/);
            }
        });
    });

    describe('isDlcImage', () => {
        it('returns true for known DLC URIs', () => {
            const uri = '763104351884.dkr.ecr.us-west-2.amazonaws.com/huggingface-pytorch-tgi-inference:2.1.1';
            assert.strictEqual(isDlcImage(uri), true);
        });

        it('returns false for custom ECR URIs', () => {
            const uri = '123456789012.dkr.ecr.us-west-2.amazonaws.com/ml-container-creator:latest';
            assert.strictEqual(isDlcImage(uri), false);
        });

        it('returns false for empty/null input', () => {
            assert.strictEqual(isDlcImage(''), false);
            assert.strictEqual(isDlcImage(null), false);
            assert.strictEqual(isDlcImage(undefined), false);
        });
    });

    describe('DlcResolutionError', () => {
        it('has correct name and message', () => {
            const err = new DlcResolutionError('No compatible image', ['img1', 'img2']);
            assert.strictEqual(err.name, 'DlcResolutionError');
            assert.strictEqual(err.message, 'No compatible image');
            assert.deepStrictEqual(err.availableOptions, ['img1', 'img2']);
        });

        it('is an instance of Error', () => {
            const err = new DlcResolutionError('test');
            assert.ok(err instanceof Error);
        });

        it('defaults availableOptions to empty array', () => {
            const err = new DlcResolutionError('test');
            assert.deepStrictEqual(err.availableOptions, []);
        });
    });

    // Note: resolveDlcImage() requires MCP server connectivity.
    // Full resolution is tested in integration tests (test/integration/dlc-direct-generation.test.js).
    // Here we test the components that can be unit-tested without network.
});
