// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance guard for the deploy per-target flag plumbing (see ADR-008 /
 * .kiro/steering/derive-dont-hardcode.md).
 *
 * The per-target answer_params arrays in targets.d/(all)/manifest.json are the
 * single source of truth. Everything else DERIVES from them:
 *
 *   deploy-config-builder.js  CLI_FLAG_TO_VARS   = flagToVars()
 *   .deploy_helper.py         flag_to_answer_key = deploy_answers.flag_to_answer_key()
 *   deploy_prompts.py         _ANSWER_KEY_TO_VAR = answer_key_to_var("input")
 *   templates/do/deploy       KEY_MAP heredoc    = answer_key_to_var("output")
 *   templates/do/deploy       arg-parse arms + _DEPLOY_FLAG_ARGS  = codegen-deploy-flags.js
 *
 * This test asserts (a) the two language readers agree, (b) the checked-in
 * generated bash regions match exactly what codegen would produce right now
 * (drift = loud failure), (c) both sub-invocations forward the flag array, and
 * (d) same-answerKey ⇒ same-configVar across targets (Option B honesty). It
 * supersedes the old drift guard that cross-checked four hand-written copies.
 */

import assert from 'node:assert';
import { describe, it, before } from 'mocha';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
    allAnswerParams,
    flagToVars,
    flagToAnswerKey,
    answerKeyToVar,
    flagParams
} from '../../src/lib/deploy-answers-reader.js';
import { REGIONS, renderRegion } from '../../scripts/codegen-deploy-flags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('deploy flag forwarding — descriptor conformance (ADR-008 / steering)', () => {
    let deployScript;

    before(() => {
        deployScript = read('templates/do/deploy');
    });

    // ── The descriptor set itself is coherent ────────────────────────────────

    describe('descriptor answer_params coherence', () => {
        it('parses a non-trivial per-target flag set', () => {
            assert.ok(flagParams().length >= 10,
                `expected the per-target flag set, parsed only ${flagParams().length}`);
        });

        it('same answerKey across targets ⇒ same configVar and flag (Option B honesty)', () => {
            const seen = new Map();
            for (const p of allAnswerParams()) {
                const prev = seen.get(p.answerKey);
                if (prev) {
                    assert.strictEqual(p.configVar, prev.configVar,
                        `answerKey '${p.answerKey}' maps to two configVars across targets`);
                    assert.strictEqual(p.flag || '', prev.flag || '',
                        `answerKey '${p.answerKey}' has two flags across targets`);
                } else {
                    seen.set(p.answerKey, { configVar: p.configVar, flag: p.flag });
                }
            }
        });

        it('every flag-input param has a flag; every non-flag-input param has none', () => {
            for (const p of allAnswerParams()) {
                const isFlagInput = p.roles.includes('flag-input');
                assert.strictEqual(Boolean(p.flag), isFlagInput,
                    `${p.target}/${p.answerKey}: flag presence must match flag-input role`);
            }
        });
    });

    // ── The two language readers agree ────────────────────────────────────────

    describe('Node and Python readers produce identical projections', () => {
        const py = (projection) => {
            const out = execFileSync('python3',
                [join(ROOT, 'templates/do/lib/python/deploy_answers.py'), projection],
                { encoding: 'utf8' });
            return JSON.parse(out);
        };

        it('answer-key-to-var input surface matches', () => {
            assert.deepStrictEqual(py('answer-key-to-var-input'), answerKeyToVar('input'));
        });

        it('answer-key-to-var output surface matches', () => {
            assert.deepStrictEqual(py('answer-key-to-var-output'), answerKeyToVar('output'));
        });

        it('flag-to-answer-key matches', () => {
            assert.deepStrictEqual(py('flag-to-answer-key'), flagToAnswerKey());
        });

        it('flag-to-vars matches', () => {
            assert.deepStrictEqual(py('flag-to-vars'), flagToVars());
        });
    });

    // ── The consumers derive (no re-introduced literal tables) ────────────────

    describe('consumers derive from the readers (no hardcoded tables reintroduced)', () => {
        it('deploy-config-builder.js uses flagToVars(), not a literal object', () => {
            const src = read('src/lib/deploy-config-builder.js');
            assert.match(src, /CLI_FLAG_TO_VARS\s*=\s*flagToVars\(\)/,
                'CLI_FLAG_TO_VARS must derive from flagToVars()');
        });

        it('deploy_prompts.py derives _ANSWER_KEY_TO_VAR from the reader', () => {
            const src = read('templates/do/lib/python/deploy_prompts.py');
            assert.match(src, /_ANSWER_KEY_TO_VAR[^\n]*=\s*deploy_answers\.answer_key_to_var\("input"\)/);
        });

        it('.deploy_helper.py derives flag_to_answer_key from the reader', () => {
            const src = read('templates/do/.deploy_helper.py');
            assert.match(src, /flag_to_answer_key[^\n]*=\s*deploy_answers\.flag_to_answer_key\(\)/);
        });

        it('do/deploy KEY_MAP heredoc derives from the reader', () => {
            assert.match(deployScript, /KEY_MAP\s*=\s*deploy_answers\.answer_key_to_var\('output'\)/);
        });
    });

    // ── The generated bash regions are in sync with codegen ───────────────────

    describe('templates/do/deploy generated regions match codegen output', () => {
        for (const region of REGIONS) {
            it(`region "${region.name}" is up to date (run npm run codegen if this fails)`, () => {
                const expected = renderRegion(region, flagParams());
                assert.ok(deployScript.includes(expected),
                    `The "${region.name}" region in templates/do/deploy is stale. ` +
                    'Re-run `npm run codegen` to regenerate it from the descriptors.');
            });
        }
    });

    // ── Both sub-invocations forward the flag array ───────────────────────────

    describe('do/deploy forwards the flag array to BOTH sub-invocations', () => {
        const sites = () => {
            const helperStart = deployScript.indexOf('.deploy_helper.py" prompt');
            const builderStart = deployScript.indexOf('node "${_REAL_BUILDER}"');
            assert.ok(helperStart !== -1, 'do/deploy must invoke .deploy_helper.py prompt');
            assert.ok(builderStart !== -1, 'do/deploy must invoke the Node builder');
            // Bound each invocation slice at its terminating `|| ...` / `2>` so the
            // check can't accidentally read into the other block (fixes the old
            // fixed-width 4000-char slice that could truncate as the script grows).
            const helperBlock = deployScript.slice(helperStart, builderStart);
            const builderTail = deployScript.slice(builderStart);
            const builderBlock = builderTail.slice(0, builderTail.indexOf(') || true') + 1);
            return { helperBlock, builderBlock };
        };

        it('the helper invocation forwards "${_DEPLOY_FLAG_ARGS[@]}"', () => {
            const { helperBlock } = sites();
            assert.ok(helperBlock.includes('"${_DEPLOY_FLAG_ARGS[@]}"'),
                'helper invocation must forward the flag array');
        });

        it('the builder invocation forwards "${_DEPLOY_FLAG_ARGS[@]}"', () => {
            const { builderBlock } = sites();
            assert.ok(builderBlock.includes('"${_DEPLOY_FLAG_ARGS[@]}"'),
                'builder invocation must forward the flag array');
        });

        it('both invocations forward the core --target and --instance-type', () => {
            const { helperBlock, builderBlock } = sites();
            for (const block of [helperBlock, builderBlock]) {
                assert.ok(block.includes('--target'), 'must forward --target');
                assert.ok(block.includes('--instance-type'), 'must forward --instance-type');
            }
        });

        it('the _DEPLOY_FLAG_ARGS array is built before the invocations', () => {
            const arrIdx = deployScript.indexOf('_DEPLOY_FLAG_ARGS=()');
            const helperIdx = deployScript.indexOf('.deploy_helper.py" prompt');
            assert.ok(arrIdx !== -1, 'do/deploy must build _DEPLOY_FLAG_ARGS');
            assert.ok(arrIdx < helperIdx, 'the array must be built before the helper invocation');
        });
    });
});
