// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 11 (R7.4) — the shared InferenceEndpointConfig render (templates/do/lib/hp-iec-render.sh).
 *
 * The render loop moved out of do/deploy.d/hyperpod-eks so do/add-pod renders a
 * second IEC from the SAME project template. Golden: with no add-pod override set,
 * the lib's output is BYTE-IDENTICAL to what the former inline loop produced for
 * the same rendered template + inputs (test/fixtures/hp-iec/base-iec.golden.yaml,
 * captured from the pre-move code). The add-pod overrides (name / location / role /
 * group) are asserted for exactly-one-match and refuse a drifted template (exit 3).
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { readFileSync, readdirSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, runBash, sandboxEnv, DO_SRC, REPO } from '../helpers/additive-sandbox.js';

const FIX = join(REPO, 'test/fixtures/hp-iec');
const BASE_ENV = {
    HP_INSTANCE_TYPE: 'ml.g5.12xlarge',
    HP_GPU_COUNT: '4',
    HP_CPU_REQUEST: '40',
    HP_MEM_REQUEST: '160Gi',
    ECR_IMAGE: '111111111111.dkr.ecr.us-east-1.amazonaws.com/x:my-model-latest',
    MODEL_SOURCE_CONFIG: 'modelSourceType: s3\nprefetchEnabled: false\ns3Storage:\n  bucketName: zz-core\n  region: us-east-1\nmodelLocation: models/meta-llama/Llama-3.1-8B',
    HP_TIER1_ENVVARS: '- name: MODEL_ID\n  value: "/opt/ml/model"',
    VLLM_EXTRA_ENVVARS: '- name: VLLM_MAX_MODEL_LEN\n  value: "8192"',
    HP_MODEL_NAME_OVERRIDE: '',
    PROJECT_NAME: 'my-model'
};

describe('Wave 11 — shared IEC render (lib/hp-iec-render.sh)', function () {
    this.timeout(60000);
    let sb;
    before(() => {
        sb = makeSandbox();
        cpSync(join(DO_SRC, 'lib/hp-iec-render.sh'), join(sb.doDir, 'lib/hp-iec-render.sh'));
        mkdirSync(join(sb.root, 'hyperpod'));
        cpSync(join(FIX, 'InferenceEndpointConfig.yaml'), join(sb.root, 'hyperpod/InferenceEndpointConfig.yaml'));
    });
    after(() => sb.cleanup());

    function render(extra = {}, tmpl = null) {
        const out = join(sb.root, `out-${Math.random().toString(36).slice(2)}`);
        mkdirSync(out);
        let src = 'hyperpod';
        if (tmpl) {
            src = `tmpl-${Math.random().toString(36).slice(2)}`;
            sb.write(`${src}/InferenceEndpointConfig.yaml`, tmpl, 0o644);
        }
        const script = sb.write('run.sh', [
            '#!/bin/bash', 'set -euo pipefail', `cd "${sb.root}"`,
            'source do/lib/hp-iec-render.sh', `_hp_render_iec "${out}" ${src}`, 'echo "N=${_HP_RENDER_N}"', ''
        ].join('\n'));
        const r = runBash(script, [], sandboxEnv(sb, { ...BASE_ENV, ...extra }));
        const files = r.code === 0 ? readdirSync(out) : [];
        return { ...r, files, text: files.length ? readFileSync(join(out, files[0]), 'utf8') : '' };
    }

    it('the base render is byte-identical to the pre-move inline loop (golden)', () => {
        const r = render();
        assert.strictEqual(r.code, 0, r.stderr);
        assert.match(r.stdout, /N=1/);
        assert.deepStrictEqual(r.files, ['001-InferenceEndpointConfig.yaml']);
        assert.strictEqual(r.text, readFileSync(join(FIX, 'base-iec.golden.yaml'), 'utf8'));
    });

    it('the deploy driver sources the lib instead of carrying its own render loop', () => {
        const driver = readFileSync(join(DO_SRC, 'deploy.d/hyperpod-eks'), 'utf8');
        assert.match(driver, /source "\$\{SCRIPT_DIR\}\/lib\/hp-iec-render\.sh"/);
        assert.match(driver, /_hp_render_iec "\$\{_HP_RENDER_DIR\}" hyperpod/);
        assert.ok(!/for manifest in hyperpod\/\*\.yaml/.test(driver), 'no duplicate loop in the driver');
    });

    it('add-pod overrides rename the IEC, endpoint and app label, relocate the weights, and label the role', () => {
        const r = render({ HP_IEC_NAME: 'my-model-ft1', HP_MODEL_LOCATION: 'models/mlcc-my-model/ft1', HP_IEC_ROLE: 'add-pod' });
        assert.strictEqual(r.code, 0, r.stderr);
        assert.match(r.text, /^ {2}name: my-model-ft1$/m);
        assert.match(r.text, /^ {2}endpointName: "my-model-ft1"$/m);
        assert.match(r.text, /^ {4}app: my-model-ft1$/m);
        assert.ok(!/^ {4}app: my-model$/m.test(r.text), 'never app=<project> (the base selectors must not see it)');
        assert.match(r.text, /modelLocation: models\/mlcc-my-model\/ft1$/m);
        assert.match(r.text, /^ {4}mlcc\.aws\/role: "add-pod"$/m);
        assert.match(r.text, /^ {4}mlcc\.aws\/project-name: "my-model"$/m);
    });

    it('--instance-group swaps instanceType for a nodeAffinity on the group label', () => {
        const r = render({ HP_IEC_NAME: 'my-model-ft1', HP_IEC_NODE_GROUP: 'grp-a' });
        assert.strictEqual(r.code, 0, r.stderr);
        assert.ok(!/^ {2}instanceType:/m.test(r.text), 'instanceType and nodeAffinity are mutually exclusive');
        assert.match(r.text, /key: sagemaker\.amazonaws\.com\/instance-group-name/);
        assert.match(r.text, /values: \["grp-a"\]/);
    });

    it('an override that matches zero or several lines refuses the render (exit 3)', () => {
        const base = readFileSync(join(FIX, 'InferenceEndpointConfig.yaml'), 'utf8');
        const noEndpoint = base.replace(/^ {2}endpointName:.*$/m, '');
        let r = render({ HP_IEC_NAME: 'x' }, noEndpoint);
        assert.strictEqual(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stderr, /expected exactly one spec\.endpointName/);
        const twoLocations = base.replace(/(__MODEL_SOURCE_CONFIG__)/, '$1\n    modelLocation: dup');
        r = render({ HP_IEC_NAME: 'x', HP_MODEL_LOCATION: 'models/y' }, twoLocations);
        assert.strictEqual(r.code, 3);
        assert.match(r.stderr, /modelLocation/);
    });
});
