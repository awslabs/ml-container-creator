// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL144 — tune-catalog reader unit tests (task 1.1).
 *
 * Exercises src/lib/tune-catalog-reader.js: listManagedModels() maps catalog entries to
 * {hfId, techniques, ...}, skips entries without a huggingFaceId, de-dupes, and returns
 * [] (never throws) on a missing/malformed catalog so the picker falls back cleanly.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listManagedModels } from '../../src/lib/tune-catalog-reader.js';

describe('tune-catalog-reader (BL144)', () => {
    let tmpDir;
    let catalogPath;

    beforeEach(() => {
        tmpDir = path.join(os.tmpdir(), `mcc-tune-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        catalogPath = path.join(tmpDir, 'tune-catalog.json');
    });

    afterEach(() => {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeCatalog(models) {
        writeFileSync(catalogPath, JSON.stringify({ version: 't', models }), 'utf8');
    }

    it('maps an entry with a huggingFaceId to {hfId, techniques, ...}', () => {
        writeCatalog({
            'huggingface-llm-qwen2-5-7b-instruct': {
                family: 'qwen-2.5',
                provider: 'alibaba',
                displayName: 'Qwen2.5-7B-Instruct',
                huggingFaceId: 'Qwen/Qwen2.5-7B-Instruct',
                techniques: { sft: {}, dpo: {}, rlvr: {}, rlaif: {} }
            }
        });

        const models = listManagedModels(catalogPath);
        assert.strictEqual(models.length, 1);
        const m = models[0];
        assert.strictEqual(m.hfId, 'Qwen/Qwen2.5-7B-Instruct');
        assert.strictEqual(m.displayName, 'Qwen2.5-7B-Instruct');
        assert.strictEqual(m.family, 'qwen-2.5');
        assert.strictEqual(m.provider, 'alibaba');
        assert.deepStrictEqual([...m.techniques].sort(), ['dpo', 'rlaif', 'rlvr', 'sft']);
    });

    it('skips entries without a huggingFaceId (not selectable in the picker)', () => {
        writeCatalog({
            withId: { huggingFaceId: 'org/with-id', techniques: { sft: {} } },
            noId: { displayName: 'hub-only', techniques: { sft: {} } },
            emptyId: { huggingFaceId: '', techniques: { dpo: {} } }
        });

        const models = listManagedModels(catalogPath);
        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].hfId, 'org/with-id');
    });

    it('de-dupes repeated huggingFaceId (first-seen wins)', () => {
        writeCatalog({
            a: { huggingFaceId: 'org/dup', displayName: 'first', techniques: { sft: {} } },
            b: { huggingFaceId: 'org/dup', displayName: 'second', techniques: { dpo: {} } }
        });

        const models = listManagedModels(catalogPath);
        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].displayName, 'first');
    });

    it('lowercases technique keys and tolerates an empty/absent techniques map', () => {
        writeCatalog({
            upper: { huggingFaceId: 'org/upper', techniques: { SFT: {}, Dpo: {} } },
            none: { huggingFaceId: 'org/none' }
        });

        const models = listManagedModels(catalogPath);
        const byId = Object.fromEntries(models.map(m => [m.hfId, m]));
        assert.deepStrictEqual([...byId['org/upper'].techniques].sort(), ['dpo', 'sft']);
        assert.deepStrictEqual(byId['org/none'].techniques, []);
    });

    it('skips glob/pattern ids defensively', () => {
        writeCatalog({
            glob: { huggingFaceId: 'org/*', techniques: { sft: {} } },
            real: { huggingFaceId: 'org/real', techniques: { sft: {} } }
        });

        const models = listManagedModels(catalogPath);
        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].hfId, 'org/real');
    });

    it('returns [] on a missing catalog file (no throw)', () => {
        assert.deepStrictEqual(listManagedModels(path.join(tmpDir, 'does-not-exist.json')), []);
    });

    it('returns [] on malformed JSON (no throw)', () => {
        writeFileSync(catalogPath, 'not valid json{{{', 'utf8');
        assert.deepStrictEqual(listManagedModels(catalogPath), []);
    });

    it('returns [] when models key is missing or not an object', () => {
        writeFileSync(catalogPath, JSON.stringify({ version: 't' }), 'utf8');
        assert.deepStrictEqual(listManagedModels(catalogPath), []);
        writeFileSync(catalogPath, JSON.stringify({ models: [] }), 'utf8');
        assert.deepStrictEqual(listManagedModels(catalogPath), []);
    });

    it('reads the real repo tune-catalog without throwing and finds managed models', () => {
        // No path override → reads config/tune-catalog.json. Behavioral, not a frozen
        // count: assert the shape holds and at least one managed model surfaces.
        const models = listManagedModels();
        assert.ok(Array.isArray(models));
        assert.ok(models.length > 0, 'expected managed models from the committed catalog');
        for (const m of models) {
            assert.ok(m.hfId && !m.hfId.includes('*'), 'every surfaced model has a concrete hfId');
            assert.ok(Array.isArray(m.techniques));
        }
    });
});
