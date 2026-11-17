// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the tune-descriptor reader (src/lib/tune-manifest-reader.js).
 *
 * Feature: v2-w3-01-bl129
 *
 * Behavior-level (not frozen-snapshot): the reader surfaces a technique's
 * structural layer (reward_source, variants, dataset_contract, artifact_kind)
 * from tune.d/<technique>/manifest.json, and degrades to null/[]/{} on a missing
 * or malformed descriptor so callers can fail open. Derive-don't-hardcode: the
 * technique list is whatever ships under tune.d/, read dynamically.
 */

import assert from 'node:assert';
import { describe, it } from 'mocha';
import {
    listTuneTechniques,
    rewardSource,
    listVariants,
    readDatasetContract,
    readHyperparameters,
    artifactKind
} from '../../src/lib/tune-manifest-reader.js';
import { KNOWN_TECHNIQUES } from '../../src/lib/managed-techniques.js';

describe('tune-manifest-reader', () => {
    describe('listTuneTechniques', () => {
        it('lists exactly the KNOWN_TECHNIQUES that ship a descriptor', () => {
            // Derived, not frozen: the shipped descriptor set must equal the
            // shared enum (the conformance test guards the inverse too).
            assert.deepStrictEqual(listTuneTechniques(), [...KNOWN_TECHNIQUES].sort());
        });
    });

    describe('rewardSource', () => {
        it('reads judge for rlaif and rule for rlvr', () => {
            assert.strictEqual(rewardSource('rlaif'), 'judge');
            assert.strictEqual(rewardSource('rlvr'), 'rule');
        });
        it('returns null for a technique with no descriptor', () => {
            assert.strictEqual(rewardSource('nope'), null);
            assert.strictEqual(rewardSource(''), null);
        });
    });

    describe('listVariants', () => {
        it('reports both variants for a technique that ships lora+full', () => {
            assert.deepStrictEqual(listVariants('sft'), ['full', 'lora']);
        });
        it('reports a single variant for a lora-only technique (mtrl)', () => {
            assert.deepStrictEqual(listVariants('mtrl'), ['lora']);
        });
        it('returns [] for a missing technique', () => {
            assert.deepStrictEqual(listVariants('nope'), []);
        });
    });

    describe('readDatasetContract', () => {
        it('carries reward_model_style for a verl-5field technique', () => {
            const c = readDatasetContract('rlaif', 'lora');
            assert.strictEqual(c.schema, 'verl-5field');
            assert.strictEqual(c.format, 'parquet');
            assert.strictEqual(c.reward_model_style, 'model');
        });
        it('rlvr resolves to the rule style', () => {
            assert.strictEqual(readDatasetContract('rlvr', 'lora').reward_model_style, 'rule');
        });
        it('defaults to a sensible variant when none is given', () => {
            // mtrl is lora-only; the default resolves to it.
            assert.strictEqual(readDatasetContract('mtrl').schema, 'mtrl-rollout');
        });
        it('an sft (non-verl) contract carries no reward_model_style', () => {
            assert.ok(!('reward_model_style' in readDatasetContract('sft', 'lora')));
        });
        it('returns null for a missing technique', () => {
            assert.strictEqual(readDatasetContract('nope'), null);
        });
        it('normalizes the `full-rank` training-type alias to the `full` variant', () => {
            // do/tune's --training-type value is passed verbatim as the variant; the CLI
            // speaks `full-rank` but the descriptor key is `full`. The reader must map the
            // alias (parity with the Python reader's _VARIANT_ALIASES), else full-rank
            // resolves to null → empty capability/HP data. Assert the alias reaches the
            // SAME contract as `full` (and is not a null miss).
            assert.deepStrictEqual(readDatasetContract('sft', 'full-rank'), readDatasetContract('sft', 'full'));
            assert.notStrictEqual(readDatasetContract('sft', 'full-rank'), null);
        });
    });

    describe('readHyperparameters', () => {
        it('returns an object (empty {} pre-sync) and never throws', () => {
            const hp = readHyperparameters('rlaif', 'lora');
            assert.strictEqual(typeof hp, 'object');
            assert.ok(!Array.isArray(hp));
        });
        it('returns {} for a missing technique', () => {
            assert.deepStrictEqual(readHyperparameters('nope'), {});
        });
    });

    describe('artifactKind', () => {
        it('derives lora_adapter for a lora variant and full_model for a full variant', () => {
            assert.strictEqual(artifactKind('sft', 'lora'), 'lora_adapter');
            assert.strictEqual(artifactKind('sft', 'full'), 'full_model');
        });
        it('returns null for a missing technique/variant', () => {
            assert.strictEqual(artifactKind('nope'), null);
            assert.strictEqual(artifactKind('mtrl', 'full'), null);
        });
    });
});
