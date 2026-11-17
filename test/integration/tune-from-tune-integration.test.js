// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for --from-tune flag in do/adapter add and do/add-ic.
 *
 * Tests that the rendered scripts contain correct logic for:
 * - do/adapter add --from-tune reads TUNE_OUTPUT_PATH_LATEST from config
 * - do/adapter add --from-tune sft reads technique-specific TUNE_ADAPTER_PATH_SFT
 * - do/adapter add --from-tune errors when output type is full-model
 * - do/add-ic --from-tune reads TUNE_OUTPUT_PATH_LATEST from config
 *
 * Feature: managed-model-customization
 * Validates: Requirements 8.8, 8.9, 8.10
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: managed-model-customization — --from-tune integration (Req 8.8, 8.9, 8.10)', function () {
    this.timeout(120000);

    let result;
    let adapterScript;
    let addIcScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
            'enable-lora': true,
            'region': 'us-east-1',
            'instance-type': 'ml.g5.xlarge'
        });

        // Read the rendered scripts
        const adapterPath = result.file('do/adapter');
        adapterScript = fs.readFileSync(adapterPath, 'utf8');

        const addIcPath = result.file('do/add-ic');
        addIcScript = fs.readFileSync(addIcPath, 'utf8');
    });

    after(() => {
        if (result) result.cleanup();
    });

    // ── Helper to extract the _adapter_add section ───────────────────────

    function getAdapterAddSection() {
        const start = adapterScript.indexOf('_adapter_add()');
        const end = adapterScript.indexOf('\n_adapter_list()');
        if (start === -1) {
            return adapterScript;
        }
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

    // Wave 6 (ADR-013): --from-tune is resolved by the SHARED resolver
    // (_resolve_additive_source in the generated do/lib/script-contract.sh) for
    // both verbs, and the artifact kind is gated through the contract table. These
    // assert the generated project's BEHAVIOR by running its resolver/gate under
    // bash, plus the structural wiring of each verb onto it.
    function contractRun(body, env = {}) {
        const doDir = path.dirname(result.file('do/adapter'));
        const script = path.join(doDir, '_from_tune_probe');
        fs.writeFileSync(script, [
            '#!/bin/bash', '# @mlcc-script', '# type: utility', '# guard: none', 'set -euo pipefail',
            'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/script-contract.sh"', body, ''
        ].join('\n'), { mode: 0o755 });
        const childEnv = { ...process.env, ...env };
        delete childEnv.VIRTUAL_ENV;
        const r = spawnSync('/bin/bash', [script], { env: childEnv, encoding: 'utf8' });
        fs.rmSync(script, { force: true });
        return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    }
    const resolveTune = (tech, env, prefer = '') =>
        contractRun(`_resolve_additive_source from-tune '${tech}' n '${prefer}'`, env);

    // ── do/adapter add --from-tune reads correct config variable ─────────
    describe('do/adapter add --from-tune reads TUNE_OUTPUT_PATH_LATEST', () => {
        it('parses --from-tune flag in argument parsing', () => {
            const addSection = getAdapterAddSection();
            assert.ok(addSection.includes('--from-tune)'), 'Must parse --from-tune flag in argument parsing');
        });
        it('routes --from-tune through the shared resolver and uses its URI', () => {
            const addSection = getAdapterAddSection();
            assert.ok(addSection.includes('_resolve_additive_source from-tune "${from_tune_technique}"'));
            assert.ok(addSection.includes('weights_uri="${RESOLVED_URI}"'));
        });
        it('resolves TUNE_OUTPUT_PATH_LATEST when no technique is specified', () => {
            const r = resolveTune('', { TUNE_OUTPUT_PATH_LATEST: 's3://b/out/', TUNE_OUTPUT_TYPE_LATEST: 'adapter' });
            assert.strictEqual(r.code, 0, r.stderr);
            assert.match(r.stdout, /RESOLVED_URI=s3:\/\/b\/out\//);
            assert.match(r.stdout, /RESOLVED_KIND=lora_adapter/);
        });
        it('shows an error + do/tune remedy when TUNE_OUTPUT_PATH_LATEST is not set', () => {
            const r = resolveTune('', {});
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /TUNE_OUTPUT_PATH_LATEST is not set/);
            assert.match(r.stderr, /\.\/do\/tune --technique/);
        });
        it('displays the resolved tune output path', () => {
            assert.ok(getAdapterAddSection().includes('Using tune adapter output'));
        });
    });
    // ── do/adapter add --from-tune sft reads technique-specific path ─────
    describe('do/adapter add --from-tune sft reads technique-specific path', () => {
        it('checks for optional technique argument after --from-tune', () => {
            assert.ok(getAdapterAddSection().includes('from_tune_technique'));
        });
        it('reads TUNE_ADAPTER_PATH_<TECHNIQUE> (case-insensitive technique)', () => {
            const r = resolveTune('sft', { TUNE_ADAPTER_PATH_SFT: 's3://b/sft/' });
            assert.strictEqual(r.code, 0, r.stderr);
            assert.match(r.stdout, /RESOLVED_URI=s3:\/\/b\/sft\//);
        });
        it('reads the technique-dataset compound key TUNE_ADAPTER_PATH_<T>_<SLUG>', () => {
            const r = resolveTune('sft-ectsum', { TUNE_ADAPTER_PATH_SFT_ECTSUM: 's3://b/sft-ectsum/' });
            assert.match(r.stdout, /RESOLVED_URI=s3:\/\/b\/sft-ectsum\//);
        });
        it('errors naming the variable(s) tried when the technique path is not set', () => {
            const r = resolveTune('sft', {});
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /TUNE_ADAPTER_PATH_SFT/);
            assert.match(r.stderr, /\.\/do\/tune --technique sft/);
        });
    });
    // ── do/adapter add --from-tune refuses a full-model output ───────────
    describe('do/adapter add --from-tune errors when output type is full-model', () => {
        ['full-model', 'model'].forEach((t) => {
            it(`TUNE_OUTPUT_TYPE_LATEST=${t} resolves as full_model and the adapter gate refuses it (exit 3)`, () => {
                const r = contractRun([
                    'out=$(_resolve_additive_source from-tune \'\' n)', 'eval "$out"',
                    '_guard_artifact_kind "$RESOLVED_KIND" "$(_additive_accepts_kind adapter)" "use do/add-ic"'
                ].join('\n'), { TUNE_OUTPUT_PATH_LATEST: 's3://b/m/', TUNE_OUTPUT_TYPE_LATEST: t });
                assert.strictEqual(r.code, 3, r.stdout + r.stderr);
                assert.match(r.stdout, /Contract violation: artifact-kind/);
            });
        });
        it('the refusal guidance is derived from the ADR-013 contract (names the full-model verb per target)', () => {
            // Wave 11 R8.2: the literal ("use do/add-ic ...") became the derived
            // _additive_kind_guidance, which names do/add-ic on realtime and
            // do/add-pod on hyperpod-eks (asserted per target in additive-deploy-contract).
            const addSection = getAdapterAddSection();
            assert.ok(/_kind_guidance="[^"]*\$\(_additive_kind_guidance full_model/.test(addSection));
        });
        it('gates before any staging (kind check precedes the canonical promotion)', () => {
            // Bucket consolidation R3.4: the legacy Processing-Job staging was replaced
            // by the promotion into the canonical prefix (_adapter_promote_canonical).
            const addSection = getAdapterAddSection();
            const gate = addSection.indexOf('_guard_artifact_kind "${_resolved_kind}"');
            const stage = addSection.indexOf('_adapter_promote_canonical "${weights_uri}"');
            assert.ok(gate !== -1 && stage !== -1 && gate < stage);
        });
    });
    // ── do/add-ic --from-tune reads TUNE_OUTPUT_PATH_LATEST ──────────────
    describe('do/add-ic --from-tune reads TUNE_OUTPUT_PATH_LATEST', () => {
        it('parses --from-tune flag in argument parsing', () => {
            assert.ok(addIcScript.includes('--from-tune)'));
        });
        it('routes every source through the shared resolver into MODEL_DATA', () => {
            assert.ok(addIcScript.includes('_resolve_additive_source "${_IC_SOURCE_VERB}"'));
            assert.ok(addIcScript.includes('MODEL_DATA="${RESOLVED_URI}"'));
        });
        it('a full-model tune output resolves and passes the add-ic gate', () => {
            const r = contractRun([
                'out=$(_resolve_additive_source from-tune \'\' n "$(_additive_accepts_kind add-ic)")', 'eval "$out"',
                '_guard_artifact_kind "$RESOLVED_KIND" "$(_additive_accepts_kind add-ic)" "use do/adapter"',
                'echo "URI=$RESOLVED_URI"'
            ].join('\n'), { TUNE_OUTPUT_PATH_LATEST: 's3://b/m/', TUNE_OUTPUT_TYPE_LATEST: 'model' });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /URI=s3:\/\/b\/m\//);
        });
        it('an adapter tune output is refused by add-ic (ADR-013: a LoRA is not a full model)', () => {
            // Supersedes the pre-Wave-6 "add-ic works for both types" behavior (R6.1).
            const r = contractRun([
                'out=$(_resolve_additive_source from-tune \'\' n)', 'eval "$out"',
                '_guard_artifact_kind "$RESOLVED_KIND" "$(_additive_accepts_kind add-ic)" "use do/adapter"'
            ].join('\n'), { TUNE_OUTPUT_PATH_LATEST: 's3://b/a/', TUNE_OUTPUT_TYPE_LATEST: 'adapter' });
            assert.strictEqual(r.code, 3);
            assert.ok(addIcScript.includes('use: do/adapter add <name> --from-tune'));
        });
        it('--from-tune, --from-weights and --from-registry are mutually exclusive (exit 1)', () => {
            const mutualIdx = addIcScript.indexOf('❌ --from-weights, --from-tune, and --from-registry are mutually exclusive');
            assert.ok(mutualIdx > 0, 'Must have mutual exclusivity error check');
            assert.ok(addIcScript.substring(mutualIdx, mutualIdx + 400).includes('exit 1'));
        });
        it('includes --from-tune in usage/help text', () => {
            assert.ok(addIcScript.includes('--from-tune [technique]'));
        });
    });
    // ── Generated project structure ──────────────────────────────────────

    describe('Generated project has --from-tune support in both scripts', () => {

        it('do/adapter script is present', () => {
            result.assertFile('do/adapter');
        });

        it('do/add-ic script is present', () => {
            result.assertFile('do/add-ic');
        });

        it('do/adapter includes --from-tune in usage text', () => {
            assert.ok(
                adapterScript.includes('--from-tune'),
                'do/adapter must include --from-tune in usage'
            );
        });

        it('do/add-ic includes --from-tune in usage text', () => {
            assert.ok(
                addIcScript.includes('--from-tune'),
                'do/add-ic must include --from-tune in usage'
            );
        });

        it('do/adapter stores ADAPTER_SOURCE="tune" in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_SOURCE') && addSection.includes('"tune"'),
                'Must store ADAPTER_SOURCE="tune" in conf file'
            );
        });

        it('do/adapter stores ADAPTER_TUNE_TECHNIQUE in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_TUNE_TECHNIQUE'),
                'Must store ADAPTER_TUNE_TECHNIQUE in conf file'
            );
        });

        it('do/adapter stores ADAPTER_PARENT_MODEL_ARN in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_PARENT_MODEL_ARN'),
                'Must store ADAPTER_PARENT_MODEL_ARN in conf file for compat check'
            );
        });

        it('do/adapter stores ADAPTER_PARENT_MODEL_SLUG in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_PARENT_MODEL_SLUG'),
                'Must store ADAPTER_PARENT_MODEL_SLUG in conf file for compat check'
            );
        });

        it('do/adapter resolves parent model ARN from MODEL_PKG_ARN or list-models', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('MODEL_PKG_ARN') || addSection.includes('list-models'),
                'Must resolve parent model ARN from MODEL_PKG_ARN or deployment MPG'
            );
        });

        it('do/adapter uses MODEL_NAME as parent model slug', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('MODEL_NAME') && addSection.includes('parent_model_slug'),
                'Must use MODEL_NAME from do/config as the parent model slug'
            );
        });
    });
});
