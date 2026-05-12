// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secret Classification Registry Unit Tests
 *
 * Tests the getClassification lookup, getClassificationsForStage filtering,
 * and registry immutability.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import {
    SECRET_CLASSIFICATIONS,
    getClassification,
    getClassificationsForStage
} from '../../src/lib/secret-classification.js';

describe('secret-classification module', () => {

    describe('getClassification', () => {
        it('returns the hf-token entry for identifier "hf-token"', () => {
            const entry = getClassification('hf-token');
            assert.ok(entry, 'Expected an entry for hf-token');
            assert.strictEqual(entry.identifier, 'hf-token');
            assert.strictEqual(entry.displayName, 'HuggingFace Token');
            assert.strictEqual(entry.envVar, 'HF_TOKEN');
        });

        it('returns the ngc-token entry for identifier "ngc-token"', () => {
            const entry = getClassification('ngc-token');
            assert.ok(entry, 'Expected an entry for ngc-token');
            assert.strictEqual(entry.identifier, 'ngc-token');
            assert.strictEqual(entry.displayName, 'NVIDIA NGC Token');
            assert.strictEqual(entry.envVar, 'NGC_API_KEY');
        });

        it('returns undefined for an unknown identifier', () => {
            const entry = getClassification('unknown-secret');
            assert.strictEqual(entry, undefined);
        });

        it('returns undefined for an empty string identifier', () => {
            const entry = getClassification('');
            assert.strictEqual(entry, undefined);
        });
    });

    describe('getClassificationsForStage', () => {
        it('returns both hf-token and ngc-token for "build-time" stage', () => {
            const entries = getClassificationsForStage('build-time');
            const identifiers = entries.map(e => e.identifier);
            assert.ok(identifiers.includes('hf-token'), 'hf-token should be in build-time');
            assert.ok(identifiers.includes('ngc-token'), 'ngc-token should be in build-time');
        });

        it('returns only hf-token for "runtime" stage', () => {
            const entries = getClassificationsForStage('runtime');
            const identifiers = entries.map(e => e.identifier);
            assert.ok(identifiers.includes('hf-token'), 'hf-token should be in runtime');
            assert.ok(!identifiers.includes('ngc-token'), 'ngc-token should NOT be in runtime');
        });

        it('returns an empty array for an unknown stage', () => {
            const entries = getClassificationsForStage('deploy-time');
            assert.ok(Array.isArray(entries));
            assert.strictEqual(entries.length, 0);
        });

        it('returns an empty array for an empty string stage', () => {
            const entries = getClassificationsForStage('');
            assert.ok(Array.isArray(entries));
            assert.strictEqual(entries.length, 0);
        });
    });

    describe('registry immutability', () => {
        it('SECRET_CLASSIFICATIONS is frozen (cannot add new entries)', () => {
            const originalLength = SECRET_CLASSIFICATIONS.length;
            assert.throws(() => {
                SECRET_CLASSIFICATIONS.push({ identifier: 'new-secret' });
            }, TypeError);
            assert.strictEqual(SECRET_CLASSIFICATIONS.length, originalLength);
        });

        it('SECRET_CLASSIFICATIONS is frozen (cannot modify existing entries at top level)', () => {
            assert.throws(() => {
                SECRET_CLASSIFICATIONS[0] = { identifier: 'replaced' };
            }, TypeError);
            assert.strictEqual(SECRET_CLASSIFICATIONS[0].identifier, 'hf-token');
        });

        it('SECRET_CLASSIFICATIONS is frozen (cannot delete entries)', () => {
            assert.throws(() => {
                delete SECRET_CLASSIFICATIONS[0];
            }, TypeError);
            assert.ok(SECRET_CLASSIFICATIONS[0] !== undefined);
        });
    });

    describe('hf-token classification details (Requirement 5.2)', () => {
        it('has stages including both build-time and runtime', () => {
            const entry = getClassification('hf-token');
            assert.deepStrictEqual(entry.stages, ['build-time', 'runtime']);
        });

        it('has purpose describing gated model download', () => {
            const entry = getClassification('hf-token');
            assert.strictEqual(entry.purpose, 'Gated model download from HuggingFace Hub');
        });

        it('has correct CLI flag and env var mappings', () => {
            const entry = getClassification('hf-token');
            assert.strictEqual(entry.cliFlag, 'hf-token-arn');
            assert.strictEqual(entry.cliFlagPlaintext, 'hf-token');
            assert.strictEqual(entry.envVar, 'HF_TOKEN');
            assert.strictEqual(entry.envVarArn, 'HF_TOKEN_ARN');
        });
    });

    describe('ngc-token classification details (Requirement 5.3)', () => {
        it('has stages including only build-time', () => {
            const entry = getClassification('ngc-token');
            assert.deepStrictEqual(entry.stages, ['build-time']);
        });

        it('has purpose describing NGC registry image pull', () => {
            const entry = getClassification('ngc-token');
            assert.strictEqual(entry.purpose, 'Pulling base images from NVIDIA NGC registry');
        });

        it('has correct CLI flag and env var mappings', () => {
            const entry = getClassification('ngc-token');
            assert.strictEqual(entry.cliFlag, 'ngc-token-arn');
            assert.strictEqual(entry.cliFlagPlaintext, 'ngc-token');
            assert.strictEqual(entry.envVar, 'NGC_API_KEY');
            assert.strictEqual(entry.envVarArn, 'NGC_API_KEY_ARN');
        });
    });
});
