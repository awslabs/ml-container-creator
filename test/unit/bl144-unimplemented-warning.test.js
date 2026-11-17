// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL144 — post-generation unimplemented-technique warning unit tests (task 5).
 *
 * The warning fires for a selected model that advertises a KNOWN-but-unimplemented
 * technique (today `mtrl`), is non-blocking (returns a flag, never throws/exits), does
 * not alter the model id, and does not fire for implemented-only, serving-only, or
 * free-entry models. Derivation comes from the tune catalog + shared enum.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    unimplementedTechniquesFor,
    warnUnimplementedTechniques
} from '../../src/lib/unimplemented-technique-warning.js';

describe('unimplemented-technique warning (BL144 Req 6)', () => {
    let tmpDir;
    let catalogPath;

    beforeEach(() => {
        tmpDir = path.join(os.tmpdir(), `mcc-warn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        catalogPath = path.join(tmpDir, 'tune-catalog.json');
    });

    afterEach(() => {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeCatalog(models) {
        writeFileSync(catalogPath, JSON.stringify({ version: 't', models }), 'utf8');
    }

    function capture() {
        const lines = [];
        return { log: (m) => lines.push(m), lines };
    }

    it('fires for a model advertising an unimplemented technique (mtrl)', () => {
        writeCatalog({
            m: { huggingFaceId: 'org/mtrl-model', techniques: { sft: {}, mtrl: {} } }
        });
        const un = unimplementedTechniquesFor({ modelName: 'org/mtrl-model' }, catalogPath);
        assert.deepStrictEqual(un, ['mtrl']);

        const sink = capture();
        const printed = warnUnimplementedTechniques({ modelName: 'org/mtrl-model' }, { log: sink.log, catalogPath });
        assert.strictEqual(printed, true);
        const text = sink.lines.join('\n');
        assert.ok(text.includes('org/mtrl-model'), 'names the model');
        assert.ok(text.includes('MTRL'), 'names the unimplemented technique');
        assert.ok(/do\/train/.test(text), 'points to still-usable paths');
    });

    it('does NOT fire for an implemented-only model', () => {
        writeCatalog({
            m: { huggingFaceId: 'org/ok', techniques: { sft: {}, dpo: {}, rlvr: {}, rlaif: {} } }
        });
        assert.deepStrictEqual(unimplementedTechniquesFor({ modelName: 'org/ok' }, catalogPath), []);

        const sink = capture();
        assert.strictEqual(warnUnimplementedTechniques({ modelName: 'org/ok' }, { log: sink.log, catalogPath }), false);
        assert.strictEqual(sink.lines.length, 0);
    });

    it('does NOT fire for a serving-only / non-catalog model', () => {
        writeCatalog({ m: { huggingFaceId: 'org/managed', techniques: { sft: {} } } });
        // Selected model is not in the catalog at all.
        assert.deepStrictEqual(unimplementedTechniquesFor({ modelName: 'serving/only' }, catalogPath), []);
    });

    it('resolves free-entry via customModelName (sentinel in modelName)', () => {
        writeCatalog({ m: { huggingFaceId: 'org/mtrl-model', techniques: { mtrl: {} } } });
        const answers = { modelName: 'Custom (enter manually)', customModelName: 'org/mtrl-model' };
        assert.deepStrictEqual(unimplementedTechniquesFor(answers, catalogPath), ['mtrl']);
    });

    it('is non-blocking and leaves the model id unchanged', () => {
        writeCatalog({ m: { huggingFaceId: 'org/mtrl-model', techniques: { sft: {}, mtrl: {} } } });
        const answers = { modelName: 'org/mtrl-model' };
        warnUnimplementedTechniques(answers, { log: () => {}, catalogPath });
        assert.strictEqual(answers.modelName, 'org/mtrl-model', 'model id untouched');
    });

    it('does not throw when the catalog is missing', () => {
        const missing = path.join(tmpDir, 'nope.json');
        assert.deepStrictEqual(unimplementedTechniquesFor({ modelName: 'x' }, missing), []);
        assert.strictEqual(warnUnimplementedTechniques({ modelName: 'x' }, { log: () => {}, catalogPath: missing }), false);
    });

    it('handles empty/absent model selection gracefully', () => {
        writeCatalog({ m: { huggingFaceId: 'org/mtrl-model', techniques: { mtrl: {} } } });
        assert.deepStrictEqual(unimplementedTechniquesFor({}, catalogPath), []);
    });
});
