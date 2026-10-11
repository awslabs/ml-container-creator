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
import { execFileSync } from 'node:child_process';

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

    // DSpark (Kimi-K3): the two sample-method env vars are emitted unconditionally
    // with the ${VAR:-} empty-default placeholder (BL127 pattern) so envsubst can
    // fill them at deploy time without an image rebuild.
    it('emits the DSpark sample-method placeholders unconditionally with ${VAR:-} defaults', () => {
        for (const name of ['VLLM_SPECULATIVE_DRAFT_SAMPLE_METHOD', 'VLLM_SPECULATIVE_REJECTION_SAMPLE_METHOD']) {
            assert.ok(crd.includes(`- name: ${name}`), `CRD must emit ${name}`);
            assert.ok(crd.includes(`value: "\${${name}:-}"`), `CRD must emit ${name} with an empty-default placeholder`);
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

// DSpark (Kimi-K3): the vLLM --speculative-config JSON builder gains two optional
// keys (draft_sample_method, rejection_sample_method) driven by new env vars.
// These tests execute the ACTUAL Python builder embedded in the rendered wrapper
// (extracted verbatim) to verify byte-exact backward compatibility when the new
// env vars are unset, and correct inclusion when they are set.
describe('DSpark: vLLM --speculative-config JSON builder', () => {
    const rendered = renderServe({ modelServer: 'vllm' });

    // Extract the python3 -c '<script>' body from the rendered wrapper. The
    // script is single-quoted and contains no single quotes of its own.
    function extractBuilder() {
        const marker = 'SPECULATIVE_CONFIG=$(python3 -c \'';
        const start = rendered.indexOf(marker);
        assert.notStrictEqual(start, -1, 'must find the SPECULATIVE_CONFIG python builder');
        const bodyStart = start + marker.length;
        const bodyEnd = rendered.indexOf('\'', bodyStart);
        assert.notStrictEqual(bodyEnd, -1, 'must find the closing quote of the python builder');
        return rendered.slice(bodyStart, bodyEnd);
    }

    const BUILDER = extractBuilder();

    // Run the builder as `python3 -c <BUILDER> <argv...>` and parse its JSON.
    // argv positions mirror the wrapper: [algorithm, model, num_tokens,
    // draft_sample_method, rejection_sample_method].
    function runBuilder(argv) {
        const out = execFileSync('python3', ['-c', BUILDER, ...argv], { encoding: 'utf8' });
        return { raw: out.trim(), json: JSON.parse(out) };
    }

    it('wrapper reads the two new optional env vars into the builder argv', () => {
        assert.ok(rendered.includes('${VLLM_SPECULATIVE_DRAFT_SAMPLE_METHOD:-}'),
            'wrapper must pass VLLM_SPECULATIVE_DRAFT_SAMPLE_METHOD to the builder');
        assert.ok(rendered.includes('${VLLM_SPECULATIVE_REJECTION_SAMPLE_METHOD:-}'),
            'wrapper must pass VLLM_SPECULATIVE_REJECTION_SAMPLE_METHOD to the builder');
    });

    it('never forwards the new component vars as standalone flags (continue-guard)', () => {
        assert.ok(rendered.includes(
            'VLLM_SPECULATIVE_ALGORITHM|VLLM_SPECULATIVE_MODEL|VLLM_SPECULATIVE_NUM_TOKENS|VLLM_SPECULATIVE_DRAFT_SAMPLE_METHOD|VLLM_SPECULATIVE_REJECTION_SAMPLE_METHOD'),
        'the continue-guard must skip both new speculative component vars');
    });

    it('backward compat: omits the two new keys when unset (eagle3-style config unchanged)', () => {
        const { json, raw } = runBuilder(['eagle3', 'acme/draft', '5', '', '']);
        assert.deepStrictEqual(json, {
            method: 'eagle3',
            num_speculative_tokens: 5,
            model: 'acme/draft'
        });
        // Byte-exact with the historical 3-arg output (no new keys, compact separators).
        assert.strictEqual(raw, '{"method":"eagle3","num_speculative_tokens":5,"model":"acme/draft"}');
        assert.ok(!raw.includes('draft_sample_method'));
        assert.ok(!raw.includes('rejection_sample_method'));
    });

    it('backward compat: 3-arg invocation (no new args at all) is byte-identical to legacy', () => {
        const { raw } = runBuilder(['ngram', '', '3']);
        assert.strictEqual(raw, '{"method":"ngram","num_speculative_tokens":3}');
    });

    it('includes both keys for a full dspark config', () => {
        const { json } = runBuilder([
            'dspark', 'RedHatAI/Kimi-K3-speculator.dspark', '8', 'probabilistic', 'block'
        ]);
        assert.deepStrictEqual(json, {
            method: 'dspark',
            num_speculative_tokens: 8,
            model: 'RedHatAI/Kimi-K3-speculator.dspark',
            draft_sample_method: 'probabilistic',
            rejection_sample_method: 'block'
        });
    });

    it('includes only the keys that are non-empty (partial set)', () => {
        const draftOnly = runBuilder(['dspark', 'm', '8', 'probabilistic', '']).json;
        assert.strictEqual(draftOnly.draft_sample_method, 'probabilistic');
        assert.ok(!('rejection_sample_method' in draftOnly));

        const rejOnly = runBuilder(['dspark', 'm', '8', '', 'block']).json;
        assert.strictEqual(rejOnly.rejection_sample_method, 'block');
        assert.ok(!('draft_sample_method' in rejOnly));
    });
});

describe('DSpark: deploy.d/hyperpod-eks wiring', () => {
    it('defaults the two VLLM sample-method vars to empty at the top of the speculative block', () => {
        assert.ok(DEPLOY_TEMPLATE.includes('export VLLM_SPECULATIVE_DRAFT_SAMPLE_METHOD=""'));
        assert.ok(DEPLOY_TEMPLATE.includes('export VLLM_SPECULATIVE_REJECTION_SAMPLE_METHOD=""'));
    });

    it('maps HP_SPECULATIVE_* → VLLM_SPECULATIVE_* for the two sample-method vars', () => {
        assert.ok(DEPLOY_TEMPLATE.includes(
            'export VLLM_SPECULATIVE_DRAFT_SAMPLE_METHOD="${HP_SPECULATIVE_DRAFT_SAMPLE_METHOD:-}"'));
        assert.ok(DEPLOY_TEMPLATE.includes(
            'export VLLM_SPECULATIVE_REJECTION_SAMPLE_METHOD="${HP_SPECULATIVE_REJECTION_SAMPLE_METHOD:-}"'));
    });

    it('excludes speculative vars from Tier-2 pass-through via the derived SPECULATIVE rule (ADR-010)', () => {
        // ADR-010 removed the hardcoded `managed` VLLM_* list. Speculative vars are
        // now excluded from the Tier-2 prefix pass-through by a derived rule — any
        // key containing "SPECULATIVE" is skipped — so they are never double-
        // injected as pass-through extras, for every engine. Assert the derivation
        // rule is present, not a frozen literal list.
        assert.ok(DEPLOY_TEMPLATE.includes('"SPECULATIVE" in k'),
            'Tier-2 pass-through must skip speculative vars via the derived substring rule');
        // The hardcoded managed-set literal must be gone (derive-dont-hardcode).
        assert.ok(!DEPLOY_TEMPLATE.includes('"VLLM_SPECULATIVE_DRAFT_SAMPLE_METHOD",'),
            'no hardcoded VLLM_* managed-set literal should remain');
    });
});

describe('DSpark: do/draft CLI flags and defaults', () => {
    const DRAFT = readFileSync(resolve(templatesRoot, 'do/draft'), 'utf8');

    it('parses --draft-sample-method and --rejection-sample-method', () => {
        assert.ok(DRAFT.includes('--draft-sample-method) shift; DRAFT_DRAFT_SAMPLE_METHOD="${1:-}"; _DRAFT_SAMPLE_METHOD_SET=true; shift ;;'));
        assert.ok(DRAFT.includes('--rejection-sample-method) shift; DRAFT_REJECTION_SAMPLE_METHOD="${1:-}"; _REJECTION_SAMPLE_METHOD_SET=true; shift ;;'));
    });

    it('writes both vars via _update_draft_var on set', () => {
        assert.ok(DRAFT.includes('_update_draft_var "HP_SPECULATIVE_DRAFT_SAMPLE_METHOD"     "${DRAFT_DRAFT_SAMPLE_METHOD}"'));
        assert.ok(DRAFT.includes('_update_draft_var "HP_SPECULATIVE_REJECTION_SAMPLE_METHOD" "${DRAFT_REJECTION_SAMPLE_METHOD}"'));
    });

    it('remove subcommand clears both new vars', () => {
        assert.ok(DRAFT.includes('_update_draft_var "HP_SPECULATIVE_DRAFT_SAMPLE_METHOD"     ""'));
        assert.ok(DRAFT.includes('_update_draft_var "HP_SPECULATIVE_REJECTION_SAMPLE_METHOD" ""'));
    });

    it('status subcommand displays both new vars when set', () => {
        assert.ok(DRAFT.includes('[ -n "${HP_SPECULATIVE_DRAFT_SAMPLE_METHOD:-}" ]'));
        assert.ok(DRAFT.includes('[ -n "${HP_SPECULATIVE_REJECTION_SAMPLE_METHOD:-}" ]'));
    });

    it('--help documents the new flags and lists dspark for vLLM', () => {
        assert.ok(DRAFT.includes('--draft-sample-method <m>'));
        assert.ok(DRAFT.includes('--rejection-sample-method <m>'));
        assert.ok(DRAFT.includes('eagle3, eagle2, eagle, draft-model, ngram, mtp, dspark'));
    });

    // Executable check of the dspark-default logic, mirroring the exact bash from
    // do/draft: defaults apply ONLY for --algorithm dspark, and ONLY when the user
    // did not explicitly pass the corresponding flag.
    function runDefaultLogic(algorithm, { draftSet = '', draftVal = '', draftFlag = false, rejSet = '', rejVal = '', rejFlag = false } = {}) {
        void draftSet; void rejSet;
        const script = `
DRAFT_ALGORITHM="${algorithm}"
DRAFT_DRAFT_SAMPLE_METHOD="${draftVal}"
DRAFT_REJECTION_SAMPLE_METHOD="${rejVal}"
_DRAFT_SAMPLE_METHOD_SET=${draftFlag}
_REJECTION_SAMPLE_METHOD_SET=${rejFlag}
if [ "\${DRAFT_ALGORITHM}" = "dspark" ]; then
    [ "\${_DRAFT_SAMPLE_METHOD_SET}" = "true" ]     || DRAFT_DRAFT_SAMPLE_METHOD="probabilistic"
    [ "\${_REJECTION_SAMPLE_METHOD_SET}" = "true" ] || DRAFT_REJECTION_SAMPLE_METHOD="block"
fi
echo "\${DRAFT_DRAFT_SAMPLE_METHOD}|\${DRAFT_REJECTION_SAMPLE_METHOD}"
`;
        return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    }

    it('dspark with no flags → defaults probabilistic|block', () => {
        assert.strictEqual(runDefaultLogic('dspark'), 'probabilistic|block');
    });

    it('dspark honors explicit overrides (does not clobber user-provided values)', () => {
        assert.strictEqual(
            runDefaultLogic('dspark', { draftFlag: true, draftVal: 'greedy', rejFlag: true, rejVal: 'typical' }),
            'greedy|typical'
        );
    });

    it('non-dspark algorithm leaves both empty (no defaults applied)', () => {
        assert.strictEqual(runDefaultLogic('eagle3'), '|');
    });
});

// ---------------------------------------------------------------------------
// BL125: TensorRT-LLM structured speculative_config.
// Unlike vLLM (--speculative-config JSON flag) and SGLang (discrete flags),
// trtllm-serve takes a YAML via --extra_llm_api_options with a speculative_config
// block. These tests prove the wrapper EMITS that config (not just that the
// manifest declares it), plus the manifest round-trips through the readers.
// ---------------------------------------------------------------------------
import { effectiveSupportedAlgorithms, listServeEngines } from '../../src/lib/serve-manifest-reader.js';

describe('BL125: TensorRT-LLM manifest declares speculative decoding honestly', () => {
    const SERVE_D = resolve(templatesRoot, 'code/serve.d');
    const manifest = JSON.parse(
        readFileSync(resolve(SERVE_D, 'tensorrt-llm/manifest.json'), 'utf8')
    );

    it('declares speculative_decoding: true', () => {
        assert.strictEqual(manifest.speculative_decoding, true);
    });

    it('supported_algorithms round-trips through the serve-manifest reader', () => {
        // Fail-open (no version) → the flat supported_algorithms set.
        const algos = effectiveSupportedAlgorithms('tensorrt-llm', null, SERVE_D);
        assert.deepStrictEqual([...algos].sort(), ['draft-model', 'eagle3', 'mtp', 'ngram']);
    });

    it('algorithm_map maps every supported algorithm to a TRT-LLM decoding_type', () => {
        // Every declared algorithm must have a map entry (no orphan declaration).
        for (const alg of manifest.supported_algorithms) {
            assert.ok(manifest.algorithm_map[alg],
                `algorithm_map must map '${alg}' to a TRT-LLM decoding_type`);
        }
        // The map values are TRT-LLM's actual decoding_type enum (1.2.x).
        const VALID_DECODING_TYPES = new Set(['Eagle', 'DraftTarget', 'NGram', 'MTP']);
        for (const [alg, enumName] of Object.entries(manifest.algorithm_map)) {
            assert.ok(VALID_DECODING_TYPES.has(enumName),
                `algorithm_map['${alg}'] = '${enumName}' must be a valid trtllm decoding_type`);
        }
    });

    it('algorithm_map keys are a subset of supported_algorithms (no over-declaration)', () => {
        for (const alg of Object.keys(manifest.algorithm_map)) {
            assert.ok(manifest.supported_algorithms.includes(alg),
                `algorithm_map key '${alg}' must be declared in supported_algorithms`);
        }
    });

    it('is discovered as a serve engine by the reader', () => {
        assert.ok(listServeEngines(SERVE_D).includes('tensorrt-llm'));
    });
});

describe('BL125: TensorRT-LLM serve wrapper emits speculative_config', () => {
    const rendered = renderServe({ modelServer: 'tensorrt-llm' });

    it('excludes the speculative component vars from the flat --flag loop', () => {
        assert.ok(rendered.includes(
            'TRTLLM_SPECULATIVE_ALGORITHM|TRTLLM_SPECULATIVE_MODEL|TRTLLM_SPECULATIVE_NUM_TOKENS|TRTLLM_SPECULATIVE_MAX_MATCHING_NGRAM_SIZE'),
        'the case-guard must skip the speculative component vars so they are not forwarded as --flags');
    });

    it('assembles a speculative_config YAML and passes it via --extra_llm_api_options', () => {
        assert.ok(rendered.includes('speculative_config:'),
            'wrapper must emit a speculative_config YAML block');
        assert.ok(rendered.includes('decoding_type:'),
            'wrapper must emit decoding_type');
        assert.ok(rendered.includes('extra_llm_api_options'),
            'wrapper must pass the YAML via --extra_llm_api_options');
    });

    it('reads the prefix from the manifest (ADR-004), not a hardcoded TRTLLM_ literal in the assembly', () => {
        // The assembly uses the EJS-interpolated prefix. With envVarPrefix omitted
        // the render falls back to TRTLLM_ (byte-identical), but the wrapper source
        // must reference the interpolated prefix, proving it is not hardcoded.
        const wrapperSrc = readFileSync(
            resolve(templatesRoot, 'code/serve.d/tensorrt-llm/tensorrt-llm.ejs'), 'utf8');
        assert.ok(wrapperSrc.includes('<%= _p %>SPECULATIVE_ALGORITHM'),
            'the wrapper source must interpolate the manifest prefix for the speculative var names');
    });

    // Execute the rendered speculative assembly as a shell fragment (the block from
    // the _spec_draft_model line through the --extra_llm_api_options append). This
    // proves EMISSION, the core Req 4 guard against "declared but not wired".
    function extractSpeculativeBlock() {
        const lines = rendered.split('\n');
        const start = lines.findIndex(l => l.startsWith('_spec_draft_model='));
        assert.notStrictEqual(start, -1, 'must find the speculative assembly block');
        const end = lines.findIndex((l, i) => i > start && l.includes('extra_llm_api_options" "${_spec_yaml}"'));
        assert.notStrictEqual(end, -1, 'must find the --extra_llm_api_options append');
        return lines.slice(start, end + 2).join('\n'); // +2 to include the closing fi
    }

    function runBlock(env) {
        const yaml = '/tmp/.bl125-trtllm-test.yaml';
        const envAssign = Object.entries(env)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
        const block = extractSpeculativeBlock().replace('/tmp/.trtllm-extra-llm-api-options.yaml', yaml);
        // Build the harness with explicit concatenation so the shell ${...}
        // expansions below are NOT interpolated by the JS template literal.
        const script = [
            'set -e',
            'SERVER_ARGS=()',
            'PREFIX="TRTLLM_"',
            'ARG_PREFIX="--"',
            envAssign ? `export ${envAssign}` : ':',
            block,
            'echo "ARGS:${SERVER_ARGS[*]}"',
            `if [ -f "${yaml}" ]; then echo "---YAML---"; cat "${yaml}"; rm -f "${yaml}"; fi`
        ].join('\n');
        return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    }

    it('Eagle: emits decoding_type Eagle + max_draft_len + speculative_model', () => {
        const out = runBlock({
            TRTLLM_SPECULATIVE_ALGORITHM: 'Eagle',
            TRTLLM_SPECULATIVE_MODEL: 'yuhuili/EAGLE3-LLaMA3.1-8B',
            TRTLLM_SPECULATIVE_NUM_TOKENS: '4'
        });
        assert.ok(out.includes('--extra_llm_api_options'), 'must append --extra_llm_api_options');
        assert.ok(out.includes('decoding_type: Eagle'));
        assert.ok(out.includes('max_draft_len: 4'));
        assert.ok(out.includes('speculative_model: yuhuili/EAGLE3-LLaMA3.1-8B'));
        assert.ok(out.includes('disable_overlap_scheduler: true'));
    });

    it('NGram: emits decoding_type NGram with default max_draft_len and no speculative_model', () => {
        const out = runBlock({
            TRTLLM_SPECULATIVE_ALGORITHM: 'NGram',
            TRTLLM_SPECULATIVE_MAX_MATCHING_NGRAM_SIZE: '4'
        });
        assert.ok(out.includes('decoding_type: NGram'));
        assert.ok(out.includes('max_draft_len: 5'), 'defaults max_draft_len to 5 when NUM_TOKENS unset');
        assert.ok(out.includes('max_matching_ngram_size: 4'));
        assert.ok(!out.includes('speculative_model:'),
            'NGram does not use a draft model — must not emit speculative_model');
    });

    it('absent request emits nothing (no YAML, no extra_llm_api_options arg)', () => {
        const out = runBlock({});
        assert.ok(!out.includes('--extra_llm_api_options'),
            'no speculative request → no --extra_llm_api_options');
        assert.ok(!out.includes('---YAML---'), 'no YAML file written when the algorithm is unset');
        assert.strictEqual(out.split('\n').find(l => l.startsWith('ARGS:')), 'ARGS:',
            'SERVER_ARGS must be empty for a non-speculative config');
    });

    it('rejects an s3:// draft model with exit code 1', () => {
        let threw = false;
        try {
            runBlock({ TRTLLM_SPECULATIVE_ALGORITHM: 'Eagle', TRTLLM_SPECULATIVE_MODEL: 's3://bucket/draft' });
        } catch (err) {
            threw = true;
            assert.ok(String(err.stderr || err.stdout || err).includes('not an s3:// URI'));
        }
        assert.ok(threw, 's3:// draft model must cause a non-zero exit');
    });
});
