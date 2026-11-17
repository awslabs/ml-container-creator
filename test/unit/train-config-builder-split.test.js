// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * BL154 (Wave 7, R7 / R11) — the do/train interactive builder split.
 *
 * Node keeps the JOB-level prompts; for a technique with a manifest.json it asks NO
 * hyperparameter questions (do/train runs the Python knob prompts next). For a
 * descriptor-less technique the prompts.json behavior is unchanged. The manifest is
 * only checked for EXISTENCE (never parsed), so even a malformed manifest switches
 * the branch — validation is the Python side's job.
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    collectHyperparameters,
    extractHyperparametersBlock,
    hasTrainManifest
} from '../../src/lib/train-config-builder.js';

function fakeInput() {
    const asked = [];
    const input = async ({ message, default: def }) => {
        asked.push(message);
        return def;
    };
    return { asked, input };
}

async function quiet(fn) {
    const orig = console.log;
    console.log = () => {};
    try {
        return await fn();
    } finally {
        console.log = orig;
    }
}

describe('Feature: v2-w7-01 (BL154) — train-config-builder Node/Python split', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mlcc-train-split-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function technique(name, files) {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, 'train.py'), '# train\n');
        for (const [file, body] of Object.entries(files)) {
            writeFileSync(join(dir, name, file), body);
        }
    }

    const PROMPTS = JSON.stringify({
        section_title: 'Tech settings',
        prompts: [{ name: 'beta', message: 'Beta?', default: '0.1', validate: 'float' }]
    });

    it('manifest-backed technique: asks no hyperparameter questions', async () => {
        technique('mytech', { 'manifest.json': '{}', 'defaults.yaml': 'epochs: 3\n' });
        const { asked, input } = fakeInput();
        const res = await quiet(() => collectHyperparameters({
            trainingPath: dir, technique: 'mytech', existingConfig: {}, prompts: { input }
        }));
        assert.strictEqual(res.manifestBacked, true);
        assert.deepStrictEqual(asked, []);
        assert.deepStrictEqual(res.hyperparameters, {});
    });

    it('manifest + leftover prompts.json (R11): the manifest wins, prompts.json ignored', async () => {
        technique('mytech', { 'manifest.json': 'not even json', 'prompts.json': PROMPTS });
        const { asked, input } = fakeInput();
        const res = await quiet(() => collectHyperparameters({
            trainingPath: dir, technique: 'mytech', existingConfig: {}, prompts: { input }
        }));
        assert.strictEqual(res.manifestBacked, true);
        assert.deepStrictEqual(asked, []);
    });

    it('descriptor-less technique with prompts.json (R7.3 / R11): unchanged questions', async () => {
        technique('old', { 'prompts.json': PROMPTS, 'defaults.yaml': 'epochs: 2\nbeta: 0.3\n' });
        const { asked, input } = fakeInput();
        const res = await quiet(() => collectHyperparameters({
            trainingPath: dir, technique: 'old', existingConfig: {}, prompts: { input }
        }));
        assert.strictEqual(res.manifestBacked, false);
        assert.deepStrictEqual(asked, ['Epochs?', 'Learning rate?', 'LoRA rank (r)?', 'Beta?']);
        assert.strictEqual(res.hyperparameters.epochs, '2');
        assert.strictEqual(res.hyperparameters.beta, '0.3');
    });

    it('hasTrainManifest is an existence check only', () => {
        technique('a', {});
        technique('b', { 'manifest.json': '' });
        assert.strictEqual(hasTrainManifest(dir, 'a'), false);
        assert.strictEqual(hasTrainManifest(dir, 'b'), true);
    });

    describe('extractHyperparametersBlock', () => {
        it('returns the block through its last indented line', () => {
            const text = [
                'technique: "sft"',
                '# Hyperparameters',
                'hyperparameters:',
                '  epochs: "3"',
                '',
                '  lora_r: "16"',
                '',
                '# ─── next section',
                'max_runtime_seconds: 86400'
            ].join('\n');
            assert.deepStrictEqual(extractHyperparametersBlock(text),
                ['hyperparameters:', '  epochs: "3"', '', '  lora_r: "16"']);
        });

        it('handles the flow-style one-liner and the absent key', () => {
            assert.deepStrictEqual(extractHyperparametersBlock('a: 1\nhyperparameters: {}\nb: 2\n'),
                ['hyperparameters: {}']);
            assert.strictEqual(extractHyperparametersBlock('a: 1\n'), null);
        });
    });
});
