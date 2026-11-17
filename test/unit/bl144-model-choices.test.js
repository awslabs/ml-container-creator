// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL144 — model-choice rendering unit tests (task 4 + task 6 render/derive slices).
 *
 * buildTransformerModelChoices renders choices so that:
 *   - the VALUE threaded downstream is always the bare model id (Req 2.6),
 *   - the row NAME carries inline brackets of the model's IMPLEMENTED techniques,
 *   - the highlighted-row DESCRIPTION is the capability legend (clean bottom text),
 *   - family separators group the managed models,
 *   - serving-only models get no bracket, and badges/legend derive from the shared enum
 *     (a NOVEL technique is labeled without code changes).
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import {
    buildTransformerModelChoices,
    CUSTOM_MODEL_SENTINEL,
    UNIMPLEMENTED_MARKER
} from '../../src/lib/prompts/model-prompts.js';

const CAPS = {
    'Qwen/Qwen2.5-7B-Instruct': ['sft', 'dpo', 'rlvr', 'rlaif']
};

/** Convenience: the non-separator choice rows. */
function rows(choices) {
    return choices.filter(c => c.type !== 'separator');
}

describe('buildTransformerModelChoices (BL144 render)', () => {
    it('managed row: value is bare id; implemented techniques inline in the name (Req 2.6, #3)', () => {
        const row = rows(buildTransformerModelChoices(['Qwen/Qwen2.5-7B-Instruct'], CAPS))[0];
        // VALUE is the bare id — no badge/bracket text leaks downstream.
        assert.strictEqual(row.value, 'Qwen/Qwen2.5-7B-Instruct');
        assert.ok(!/\[|SFT|DPO/.test(row.value), 'no bracket/badge in value');
        // NAME shows the actual implemented techniques inline, NOT a generic "managed".
        assert.ok(row.name.includes('Qwen/Qwen2.5-7B-Instruct'));
        assert.ok(row.name.includes('[SFT · DPO · RLVR · RLAIF]'), 'inline technique brackets');
        assert.ok(!/\[managed\]/.test(row.name), 'no redundant "managed" marker');
    });

    it('description is a STATIC legend, identical across models (badge carries capability)', () => {
        const implementedOnly = rows(buildTransformerModelChoices(['Qwen/Qwen2.5-7B-Instruct'], CAPS))[0];
        const withMtrl = rows(buildTransformerModelChoices(
            ['org/mtrl-model'],
            { 'org/mtrl-model': ['sft', 'mtrl'] }
        ))[0];
        // Same bottom text regardless of the model's capabilities.
        assert.strictEqual(implementedOnly.description, withMtrl.description);
        assert.ok(implementedOnly.description.includes('SFT=supervised fine-tuning'));
        // Legend carries the static `*` gloss so the marker is self-explaining.
        assert.ok(implementedOnly.description.includes(`${UNIMPLEMENTED_MARKER} = advertised`));
        assert.ok(!/Managed tuning:/.test(implementedOnly.description), 'no redundant per-row prefix');
    });

    it('provider separators group managed models — Qwen 2.5 + Qwen 3 under Alibaba (#2)', () => {
        const meta = {
            'Qwen/Qwen2.5-7B-Instruct': { family: 'qwen-2.5', provider: 'alibaba' },
            'Qwen/Qwen3-8B': { family: 'qwen-3', provider: 'alibaba' },
            'meta-llama/Llama-3.1-8B-Instruct': { family: 'llama-3', provider: 'meta' },
            'openai/gpt-oss-20b': { family: 'gpt-oss', provider: 'openai' }
        };
        const caps = {
            'Qwen/Qwen2.5-7B-Instruct': ['sft'],
            'Qwen/Qwen3-8B': ['sft'],
            'meta-llama/Llama-3.1-8B-Instruct': ['sft'],
            'openai/gpt-oss-20b': ['sft']
        };
        const choices = buildTransformerModelChoices(Object.keys(meta), caps, meta);
        // Provider headers (exclude the trailing HuggingFace free-entry header).
        const seps = choices.filter(c => c.type === 'separator').map(c => c.separator)
            .filter(s => s !== '── HuggingFace ──');
        // One Alibaba header spanning BOTH Qwen generations — grouped by provider.
        assert.deepStrictEqual(seps, ['── Alibaba ──', '── Meta ──', '── OpenAI ──']);
        assert.strictEqual(choices[0].separator, '── Alibaba ──');
    });

    it('groups by hub-document provider values, canonicalizing brand casing (Qwen, NVIDIA)', () => {
        const meta = {
            'Qwen/Qwen3.6-27B': { provider: 'Qwen' },
            'Qwen/Qwen3.5-9B': { provider: 'Qwen' },
            'nvidia/NVIDIA-Nemotron-3-Nano-30B': { provider: 'nvidia' }
        };
        const caps = {
            'Qwen/Qwen3.6-27B': ['sft'],
            'Qwen/Qwen3.5-9B': ['sft'],
            'nvidia/NVIDIA-Nemotron-3-Nano-30B': ['sft']
        };
        const choices = buildTransformerModelChoices(Object.keys(meta), caps, meta);
        const seps = choices.filter(c => c.type === 'separator').map(c => c.separator)
            .filter(s => s !== '── HuggingFace ──');
        // Qwen stays "Qwen" (title-cased already); nvidia → canonical "NVIDIA". No Unknown.
        assert.deepStrictEqual(seps, ['── Qwen ──', '── NVIDIA ──']);
        assert.ok(!seps.includes('── Unknown ──'));
    });

    it('no meta → no PROVIDER separators (only the trailing HuggingFace header)', () => {
        const choices = buildTransformerModelChoices(['Qwen/Qwen2.5-7B-Instruct'], CAPS);
        const seps = choices.filter(c => c.type === 'separator').map(c => c.separator);
        assert.deepStrictEqual(seps, ['── HuggingFace ──']);
    });

    it('serving-only model: no bracket, no legend, value is the bare id', () => {
        const row = rows(buildTransformerModelChoices(['mistralai/Mixtral-8x7B'], {}))[0];
        assert.strictEqual(row.value, 'mistralai/Mixtral-8x7B');
        assert.strictEqual(row.name, 'mistralai/Mixtral-8x7B');
        assert.ok(!/\[/.test(row.name));
        assert.ok(!/Legend/.test(row.description));
        assert.ok(/[Ss]erving/.test(row.description));
    });

    it('known-but-unimplemented technique (mtrl) → in brackets with the `*` marker', () => {
        const row = rows(buildTransformerModelChoices(
            ['org/mtrl-model'],
            { 'org/mtrl-model': ['sft', 'dpo', 'rlvr', 'rlaif', 'mtrl'] }
        ))[0];
        // Badge carries ALL advertised techniques: implemented plain, mtrl marked `*`.
        assert.ok(row.name.includes(`MTRL${UNIMPLEMENTED_MARKER}`), 'mtrl badged with marker');
        assert.ok(row.name.includes('SFT'), 'implemented techniques plain in the badge');
        assert.ok(!new RegExp(`SFT\\${UNIMPLEMENTED_MARKER}`).test(row.name), 'implemented techniques NOT marked');
        // Implemented first, marked ones last.
        assert.ok(row.name.indexOf('SFT') < row.name.indexOf(`MTRL${UNIMPLEMENTED_MARKER}`));
    });

    it('derive-not-hardcode: a known implemented technique gets a derived (uppercased) badge', () => {
        const row = rows(buildTransformerModelChoices(['org/x'], { 'org/x': ['sft'] }))[0];
        assert.ok(row.name.includes('[SFT]'), 'badge is the uppercased id, derived');
    });

    it('empty techniques array → managed model with no brackets, static legend, no throw', () => {
        const row = rows(buildTransformerModelChoices(['org/empty'], { 'org/empty': [] }))[0];
        assert.strictEqual(row.value, 'org/empty');
        assert.strictEqual(row.name, 'org/empty', 'no brackets when nothing advertised');
        // Still the static legend (same as every managed row).
        assert.ok(row.description.includes('SFT=supervised fine-tuning'));
    });

    it('Custom free-entry sits under a "HuggingFace" header as the last choice (#1, Req 1.6)', () => {
        const choices = buildTransformerModelChoices(['org/a', 'org/b'], {});
        const last = choices[choices.length - 1];
        const beforeLast = choices[choices.length - 2];
        assert.strictEqual(last.value, CUSTOM_MODEL_SENTINEL);
        assert.strictEqual(last.name, CUSTOM_MODEL_SENTINEL);
        assert.strictEqual(beforeLast.type, 'separator');
        assert.strictEqual(beforeLast.separator, '── HuggingFace ──');
    });
});
