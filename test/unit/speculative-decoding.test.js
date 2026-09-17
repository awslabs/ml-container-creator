// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL085 speculative-decoding CRD and serve-wrapper contracts.
 *
 * The HyperPod CRD carries both engine-specific environment-variable sets.
 * The image's selected wrapper alone turns its set into server arguments.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(__dirname, '../../templates');
const SERVE_TEMPLATE_PATH = resolve(templatesRoot, 'code/serve');
const CRD_TEMPLATE_PATH = resolve(templatesRoot, 'hyperpod/InferenceEndpointConfig.yaml.ejs');
const DEPLOY_TEMPLATE_PATH = resolve(templatesRoot, 'do/deploy.d/hyperpod-eks');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf8');
const CRD_TEMPLATE = readFileSync(CRD_TEMPLATE_PATH, 'utf8');
const DEPLOY_TEMPLATE = readFileSync(DEPLOY_TEMPLATE_PATH, 'utf8');

const TEMPLATE_VARS = {
    projectName: 'speculative-test',
    framework: 'transformers',
    modelName: 'meta-llama/Llama-3.1-8B-Instruct',
    modelServer: 'vllm',
    hyperPodNamespace: 'default',
    hyperPodReplicas: 1,
    instanceType: 'ml.g6.2xlarge',
    includeBenchmark: false
};

const ALGORITHMS = [
    { user: 'draft-model', vllm: 'draft_model', sglang: 'STANDALONE' },
    { user: 'eagle', vllm: 'eagle', sglang: 'EAGLE', eagleTopk: true },
    { user: 'eagle2', vllm: 'eagle2', sglang: 'EAGLE' },
    { user: 'eagle3', vllm: 'eagle3', sglang: 'EAGLE3', eagleTopk: true },
    { user: 'ngram', vllm: 'ngram', sglang: 'NGRAM' },
    { user: 'mtp', vllm: 'mtp', sglang: 'MTP' }
];

function renderServe(overrides = {}) {
    return ejs.render(SERVE_TEMPLATE, { ...TEMPLATE_VARS, ...overrides }, { filename: SERVE_TEMPLATE_PATH });
}

function renderCrd() {
    return ejs.render(CRD_TEMPLATE, TEMPLATE_VARS, { filename: CRD_TEMPLATE_PATH });
}

function substituteEnv(template, env) {
    return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => env[name] ?? '');
}

describe('BL085: HyperPod speculative CRD injection', () => {
    const crd = renderCrd();

    it('uses environmentVariables and leaves worker.args empty', () => {
        assert.ok(crd.includes('args: []'), 'the CRD must not inject speculative flags into worker.args');
        assert.ok(crd.includes('environmentVariables:'), 'the CRD must use worker.environmentVariables');
    });

    it('emits both engine-specific variable sets regardless of selected engine', () => {
        const expected = [
            'VLLM_SPECULATIVE_ALGORITHM',
            'VLLM_SPECULATIVE_MODEL',
            'VLLM_SPECULATIVE_NUM_TOKENS',
            'SGLANG_SPECULATIVE_ALGORITHM',
            'SGLANG_SPECULATIVE_DRAFT_MODEL_PATH',
            'SGLANG_SPECULATIVE_NUM_STEPS',
            'SGLANG_SPECULATIVE_EAGLE_TOPK'
        ];
        for (const name of expected) {
            assert.ok(crd.includes(`- name: ${name}`), `CRD must emit ${name}`);
            assert.ok(crd.includes(`value: "\${${name}}"`), `CRD must resolve ${name} at deploy time`);
        }
    });

    for (const algorithm of ALGORITHMS) {
        it(`renders ${algorithm.user} mappings for both vLLM and SGLang`, () => {
            const rendered = substituteEnv(crd, {
                VLLM_SPECULATIVE_ALGORITHM: algorithm.vllm,
                VLLM_SPECULATIVE_MODEL: 'acme/draft-model',
                VLLM_SPECULATIVE_NUM_TOKENS: '5',
                SGLANG_SPECULATIVE_ALGORITHM: algorithm.sglang,
                SGLANG_SPECULATIVE_DRAFT_MODEL_PATH: 'acme/draft-model',
                SGLANG_SPECULATIVE_NUM_STEPS: '4',
                SGLANG_SPECULATIVE_EAGLE_TOPK: algorithm.eagleTopk ? '8' : ''
            });
            assert.ok(rendered.includes(`value: "${algorithm.vllm}"`));
            assert.ok(rendered.includes(`value: "${algorithm.sglang}"`));
            assert.ok(rendered.includes('VLLM_SPECULATIVE_MODEL\n        value: "acme/draft-model"'));
            assert.ok(rendered.includes('SGLANG_SPECULATIVE_DRAFT_MODEL_PATH\n        value: "acme/draft-model"'));
            assert.ok(rendered.includes(`SGLANG_SPECULATIVE_EAGLE_TOPK\n        value: "${algorithm.eagleTopk ? '8' : ''}"`));
        });
    }

    it('leaves speculative values empty when disabled so neither wrapper receives an algorithm', () => {
        const rendered = substituteEnv(crd, {
            VLLM_SPECULATIVE_ALGORITHM: '',
            VLLM_SPECULATIVE_MODEL: '',
            VLLM_SPECULATIVE_NUM_TOKENS: '',
            SGLANG_SPECULATIVE_ALGORITHM: '',
            SGLANG_SPECULATIVE_DRAFT_MODEL_PATH: '',
            SGLANG_SPECULATIVE_NUM_STEPS: '',
            SGLANG_SPECULATIVE_EAGLE_TOPK: ''
        });
        assert.ok(rendered.includes('VLLM_SPECULATIVE_ALGORITHM\n        value: ""'));
        assert.ok(rendered.includes('SGLANG_SPECULATIVE_ALGORITHM\n        value: ""'));
        assert.ok(DEPLOY_TEMPLATE.includes('if [ -n "${HP_SPECULATIVE_ALGORITHM:-}" ]; then'));
        assert.ok(DEPLOY_TEMPLATE.includes('export SGLANG_SPECULATIVE_NUM_STEPS="${HP_SPECULATIVE_NUM_STEPS:-${HP_SPECULATIVE_NUM_TOKENS:-5}}"'));
    });

    it('contains the exact deploy-time mappings and only supplies SGLang top-k for eagle/eagle3', () => {
        for (const algorithm of ALGORITHMS) {
            assert.ok(DEPLOY_TEMPLATE.includes(`        ${algorithm.user})`));
            assert.ok(DEPLOY_TEMPLATE.includes(`export VLLM_SPECULATIVE_ALGORITHM="${algorithm.vllm}"`));
            assert.ok(DEPLOY_TEMPLATE.includes(`export SGLANG_SPECULATIVE_ALGORITHM="${algorithm.sglang}"`));
        }
        const eagle2Block = DEPLOY_TEMPLATE.slice(
            DEPLOY_TEMPLATE.indexOf('        eagle2)'),
            DEPLOY_TEMPLATE.indexOf('        eagle3)')
        );
        assert.ok(!eagle2Block.includes('SGLANG_SPECULATIVE_EAGLE_TOPK'), 'eagle2 must not receive SGLang EAGLE top-k');
    });
});

describe('BL085: speculative serve-wrapper translation', () => {
    it('builds vLLM --speculative-config JSON from VLLM_SPECULATIVE_* values', () => {
        const rendered = renderServe({ modelServer: 'vllm' });
        assert.ok(rendered.includes('VLLM_SPECULATIVE_ALGORITHM'));
        assert.ok(rendered.includes('VLLM_SPECULATIVE_MODEL'));
        assert.ok(rendered.includes('VLLM_SPECULATIVE_NUM_TOKENS'));
        assert.ok(rendered.includes('VLLM_SPECULATIVE_ALGORITHM|VLLM_SPECULATIVE_MODEL|VLLM_SPECULATIVE_NUM_TOKENS'));
        assert.ok(rendered.includes('"method": sys.argv[1]'));
        assert.ok(rendered.includes('"num_speculative_tokens": int(sys.argv[3])'));
        assert.ok(rendered.includes('--speculative-config "${SPECULATIVE_CONFIG}"'));
    });

    it('rejects S3 vLLM draft-model URIs with exit code 1', () => {
        const rendered = renderServe({ modelServer: 'vllm' });
        assert.ok(rendered.includes('_speculative_draft_model="${VLLM_SPECULATIVE_MODEL:-${HP_SPECULATIVE_MODEL:-}}"'));
        assert.ok(rendered.includes('[[ "${_speculative_draft_model}" == s3://* ]]'));
        const errorIndex = rendered.indexOf('not an s3:// URI');
        assert.ok(errorIndex !== -1);
        assert.ok(rendered.slice(errorIndex, errorIndex + 200).includes('exit 1'));
    });

    it('builds SGLang discrete flags from SGLANG_SPECULATIVE_* values', () => {
        const rendered = renderServe({ modelServer: 'sglang' });
        assert.ok(rendered.includes('SGLANG_SPECULATIVE_ALGORITHM'));
        assert.ok(rendered.includes('--speculative-algorithm "${SGLANG_SPECULATIVE_ALGORITHM}"'));
        assert.ok(rendered.includes('--speculative-draft-model-path "${SGLANG_SPECULATIVE_DRAFT_MODEL_PATH}"'));
        assert.ok(rendered.includes('--speculative-num-steps "${SGLANG_SPECULATIVE_NUM_STEPS}"'));
        assert.ok(rendered.includes('--speculative-eagle-topk "${SGLANG_SPECULATIVE_EAGLE_TOPK}"'));
        assert.ok(rendered.includes('SGLANG_SPECULATIVE_ALGORITHM|SGLANG_SPECULATIVE_DRAFT_MODEL_PATH|SGLANG_SPECULATIVE_NUM_STEPS|SGLANG_SPECULATIVE_EAGLE_TOPK'));
        assert.ok(!rendered.includes('NGRAM|MEDUSA'), 'SGLang NGRAM is supported by the current engine contract');
    });

    it('rejects S3 SGLang draft-model URIs with exit code 1', () => {
        const rendered = renderServe({ modelServer: 'sglang' });
        assert.ok(rendered.includes('_speculative_draft_model="${SGLANG_SPECULATIVE_DRAFT_MODEL_PATH:-${HP_SPECULATIVE_MODEL:-}}"'));
        assert.ok(rendered.includes('[[ "${_speculative_draft_model}" == s3://* ]]'));
        const errorIndex = rendered.indexOf('not an s3:// URI');
        assert.ok(errorIndex !== -1);
        assert.ok(rendered.slice(errorIndex, errorIndex + 200).includes('exit 1'));
    });
});
