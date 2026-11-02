// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL144 — shared managed-technique enum unit tests (task 2).
 *
 * The badge/legend derivation, the post-generation unimplemented-technique warning, and
 * `do/tune`'s guard all key off this ONE source. These tests assert the derivation
 * PROPERTIES (not frozen literals) so a new technique is labeled without code changes,
 * and so moving a technique into the implemented set changes the warning behavior.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import {
    KNOWN_TECHNIQUES,
    IMPLEMENTED_TECHNIQUES,
    isKnownTechnique,
    isImplementedTechnique,
    techniqueBadge,
    partitionTechniques,
    buildLegend
} from '../../src/lib/managed-techniques.js';

describe('managed-techniques (BL144 shared enum)', () => {
    it('IMPLEMENTED is a subset of KNOWN', () => {
        for (const t of IMPLEMENTED_TECHNIQUES) {
            assert.ok(KNOWN_TECHNIQUES.includes(t), `${t} implemented but not known`);
        }
    });

    it('mtrl is known-but-unimplemented (BL139 deferral)', () => {
        assert.ok(KNOWN_TECHNIQUES.includes('mtrl'));
        assert.ok(!IMPLEMENTED_TECHNIQUES.includes('mtrl'));
    });

    it('membership predicates are case-insensitive', () => {
        assert.ok(isKnownTechnique('SFT'));
        assert.ok(isKnownTechnique('mtrl'));
        assert.ok(!isKnownTechnique('nope'));
        assert.ok(isImplementedTechnique('Rlvr'));
        assert.ok(!isImplementedTechnique('mtrl'));
    });

    it('badge is the uppercased id (derived, not a hand-map)', () => {
        assert.strictEqual(techniqueBadge('sft'), 'SFT');
        // A NOVEL id gets a badge with no code change — proves derive-not-hardcode.
        assert.strictEqual(techniqueBadge('foo'), 'FOO');
    });

    it('legend is derived over KNOWN and covers every known id', () => {
        const legend = buildLegend();
        for (const t of KNOWN_TECHNIQUES) {
            assert.ok(legend.includes(techniqueBadge(t)), `legend missing ${t}`);
        }
    });

    it('partitionTechniques splits implemented vs known-but-unimplemented, ignores unknown', () => {
        const { implemented, unimplemented } = partitionTechniques(['sft', 'dpo', 'mtrl', 'bogus']);
        assert.deepStrictEqual(implemented, ['sft', 'dpo']);
        assert.deepStrictEqual(unimplemented, ['mtrl']);
    });

    it('partitionTechniques is case-insensitive, de-duped, and KNOWN-ordered', () => {
        const { implemented, unimplemented } = partitionTechniques(['RLVR', 'rlvr', 'Sft']);
        // KNOWN order is sft, dpo, rlvr, rlaif, mtrl → sft before rlvr
        assert.deepStrictEqual(implemented, ['sft', 'rlvr']);
        assert.deepStrictEqual(unimplemented, []);
    });

    it('partitionTechniques tolerates non-array / empty input', () => {
        assert.deepStrictEqual(partitionTechniques(undefined), { implemented: [], unimplemented: [] });
        assert.deepStrictEqual(partitionTechniques([]), { implemented: [], unimplemented: [] });
    });
});
