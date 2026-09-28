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

    // BL107: the deploy-time algorithm→enum translation is now read from each
    // engine's serve-layer manifest (algorithm_map) instead of a hardcoded case
    // statement. Assert the manifest-driven mechanism is wired and the enum
    // outcomes still match, rather than inspecting retired case-arm source.
    it('translates the algorithm via the manifest algorithm_map (no hardcoded case)', () => {
        // The retired per-algorithm case arms must be gone.
        assert.ok(!DEPLOY_TEMPLATE.includes('export SGLANG_SPECULATIVE_ALGORITHM="STANDALONE"'),
            'the hardcoded SGLang enum case must be retired in favor of algorithm_map reads');
        // The manifest reader must be consulted for the algorithm_map.
        assert.ok(DEPLOY_TEMPLATE.includes('serve_manifest.py'),
            'deploy must read engine capabilities from the serve manifest');
        assert.ok(DEPLOY_TEMPLATE.includes('algorithm_map'),
            'deploy must translate the algorithm via the manifest algorithm_map');
        // The manifests themselves carry the expected enum outcomes.
        const vllmMap = JSON.parse(
            readFileSync(resolve(templatesRoot, 'code/serve.d/vllm/manifest.json'), 'utf8')
        ).algorithm_map;
        const sglangMap = JSON.parse(
            readFileSync(resolve(templatesRoot, 'code/serve.d/sglang/manifest.json'), 'utf8')
        ).algorithm_map;
        for (const algorithm of ALGORITHMS) {
            assert.strictEqual(vllmMap[algorithm.user], algorithm.vllm,
                `vLLM manifest must map ${algorithm.user} → ${algorithm.vllm}`);
            // SGLang omits ngram (unsupported); every other algorithm maps to its enum.
            if (algorithm.user === 'ngram') {
                assert.ok(!('ngram' in sglangMap), 'SGLang manifest must not map ngram');
            } else {
                assert.strictEqual(sglangMap[algorithm.user], algorithm.sglang,
                    `SGLang manifest must map ${algorithm.user} → ${algorithm.sglang}`);
            }
        }
    });

    it('supplies SGLang EAGLE top-k only for the eagle/eagle3 MLCC algorithms', () => {
        // The top-k gate keys off the MLCC algorithm name (eagle, eagle3) so
        // eagle2 — which also maps to the EAGLE enum — does not receive top-k.
        assert.ok(DEPLOY_TEMPLATE.includes('eagle|eagle3)'),
            'top-k must be gated on the eagle/eagle3 MLCC algorithm names');
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
