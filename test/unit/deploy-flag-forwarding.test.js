// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the deploy per-target flag plumbing (see
 * .kiro/steering/derive-dont-hardcode.md). Four layers must agree on the set of
 * per-target deploy flags, or a caller-supplied value silently triggers an
 * interactive prompt / gets dropped:
 *
 *   1. deploy-config-builder.js  CLI_FLAG_TO_VARS   (Node builder — flag → {configVar, answerKey})
 *   2. .deploy_helper.py         flag_to_answer_key (Python helper argparse → answer key)
 *   3. deploy_prompts.py         _ANSWER_KEY_TO_VAR (answer key → config var)
 *   4. templates/do/deploy       forwards every flag to BOTH the Python helper
 *                                AND the Node builder invocation.
 *
 * This test parses the real source (no duplicated fixture) so it fails the moment
 * a new flag is added to one layer but not the others — turning a silent drift
 * into a loud, actionable failure.
 */

import assert from 'node:assert';
import { describe, it, before } from 'mocha';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── Parse helpers (regex over source — deliberately simple/robust) ────────────

/** CLI_FLAG_TO_VARS from deploy-config-builder.js → { '--flag': { configVar, answerKey } } */
function parseBuilderFlagTable(src) {
    const block = src.slice(
        src.indexOf('const CLI_FLAG_TO_VARS'),
        src.indexOf('};', src.indexOf('const CLI_FLAG_TO_VARS'))
    );
    const out = {};
    const re = /'(--[a-z-]+)':\s*\{\s*configVar:\s*'([A-Z0-9_]+)',\s*answerKey:\s*'([a-z0-9_]+)'\s*\}/g;
    let m;
    while ((m = re.exec(block)) !== null) {
        out[m[1]] = { configVar: m[2], answerKey: m[3] };
    }
    return out;
}

/** flag_to_answer_key from .deploy_helper.py → { attr: answerKey } */
function parseHelperFlagTable(src) {
    const start = src.indexOf('flag_to_answer_key');
    const block = src.slice(start, src.indexOf('}', start));
    const out = {};
    const re = /"([a-z0-9_]+)":\s*"([a-z0-9_]+)"/g;
    let m;
    while ((m = re.exec(block)) !== null) out[m[1]] = m[2];
    return out;
}

/** _ANSWER_KEY_TO_VAR from deploy_prompts.py → { answerKey: CONFIG_VAR } */
function parseAnswerKeyToVar(src) {
    const start = src.indexOf('_ANSWER_KEY_TO_VAR');
    const block = src.slice(start, src.indexOf('}', start));
    const out = {};
    const re = /"([a-z0-9_]+)":\s*"([A-Z0-9_]+)"/g;
    let m;
    while ((m = re.exec(block)) !== null) out[m[1]] = m[2];
    return out;
}

/** Convert a --kebab-flag to its snake_case answer key (matches both codebases). */
const flagToAnswerKey = (flag) => flag.replace(/^--/, '').replace(/-/g, '_');

describe('deploy flag forwarding — drift guard (ADR-008 / steering)', () => {
    let builder, deployScript, helperPy, promptsPy;
    let flagTable, flagNames;

    before(() => {
        builder = read('src/lib/deploy-config-builder.js');
        deployScript = read('templates/do/deploy');
        helperPy = read('templates/do/.deploy_helper.py');
        promptsPy = read('templates/do/lib/python/deploy_prompts.py');
        flagTable = parseBuilderFlagTable(builder);
        flagNames = Object.keys(flagTable);
    });

    it('the builder flag table parsed a non-trivial set of flags', () => {
        assert.ok(flagNames.length >= 10,
            `expected the per-target flag set, parsed only ${flagNames.length}`);
    });

    describe('templates/do/deploy forwards every builder flag to BOTH sub-invocations', () => {
        // Slice do/deploy into its two helper invocations so we check each site.
        const sites = () => {
            const helperStart = deployScript.indexOf('.deploy_helper.py" prompt');
            const builderStart = deployScript.indexOf('node "${_REAL_BUILDER}"');
            assert.ok(helperStart !== -1, 'do/deploy must invoke .deploy_helper.py prompt');
            assert.ok(builderStart !== -1, 'do/deploy must invoke the Node builder');
            // The helper block runs before the builder block in do/deploy.
            const helperBlock = deployScript.slice(helperStart, builderStart);
            const builderBlock = deployScript.slice(builderStart, builderStart + 4000);
            return { helperBlock, builderBlock };
        };

        it('forwards each flag to the Python helper invocation', () => {
            const { helperBlock } = sites();
            for (const flag of flagNames) {
                assert.ok(helperBlock.includes(`${flag} `) || helperBlock.includes(`${flag}"`),
                    `do/deploy must forward ${flag} to .deploy_helper.py`);
            }
        });

        it('forwards each flag to the Node builder invocation', () => {
            const { builderBlock } = sites();
            for (const flag of flagNames) {
                assert.ok(builderBlock.includes(`${flag} `) || builderBlock.includes(`${flag}"`),
                    `do/deploy must forward ${flag} to deploy-config-builder.js`);
            }
        });

        it('forwards the core --target and --instance-type to both', () => {
            const { helperBlock, builderBlock } = sites();
            for (const block of [helperBlock, builderBlock]) {
                assert.ok(block.includes('--target'), 'must forward --target');
                assert.ok(block.includes('--instance-type'), 'must forward --instance-type');
            }
        });
    });

    describe('the answer-key tables agree across builder, helper, and prompts', () => {
        it('every builder flag has a matching answer key in .deploy_helper.py flag_to_answer_key', () => {
            const helperTable = parseHelperFlagTable(helperPy);
            for (const flag of flagNames) {
                const ak = flagToAnswerKey(flag);
                assert.ok(Object.values(helperTable).includes(ak) || helperTable[ak] === ak,
                    `.deploy_helper.py flag_to_answer_key must define answer key '${ak}' (for ${flag})`);
            }
        });

        it('every builder answerKey resolves to a config var in deploy_prompts _ANSWER_KEY_TO_VAR', () => {
            const a2v = parseAnswerKeyToVar(promptsPy);
            for (const [flag, { answerKey, configVar }] of Object.entries(flagTable)) {
                assert.ok(answerKey in a2v,
                    `_ANSWER_KEY_TO_VAR must map answer key '${answerKey}' (for ${flag})`);
                // The builder configVar and the prompts config var must agree — this is
                // the exact mapping a caller-supplied flag flows through in both engines.
                assert.strictEqual(a2v[answerKey], configVar,
                    `config var mismatch for '${answerKey}': builder=${configVar} vs deploy_prompts=${a2v[answerKey]}`);
            }
        });
    });
});
