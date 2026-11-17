// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 6 (ADR-013 axis 1) — the shared `--from-*` source resolver.
 *
 * Exercises `_resolve_additive_source` from the REAL
 * templates/do/lib/script-contract.sh under /bin/bash (bash 3.2 on macOS) in a
 * sandbox where config vars and the Python helpers are stubbed:
 *   - R1.1 / R8.1 each --from-* returns the expected {RESOLVED_URI, RESOLVED_KIND, META}
 *   - R1.2        the result is identical regardless of DEPLOYMENT_TARGET
 *   - R4 / R8.4   per-source kind: registry=recorded, tune=output type,
 *                 train=recorded-or-unknown, weights/hub=unknown
 *   - R9 / R8.6   a genuinely failed resolution exits non-zero and surfaces the
 *                 helper's real stderr (never a silent empty)
 *   - bash 3.2    script-contract.sh loads cleanly and uses no bash-4-only syntax
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, runContract, parseResolved, DO_SRC, BASH } from '../helpers/additive-sandbox.js';

const CONTRACT_SRC = readFileSync(join(DO_SRC, 'lib/script-contract.sh'), 'utf8');

/** A stub .register_helper.py driven by env: STUB_MODE = ok | fail | error-json. */
const REGISTER_HELPER_STUB = `#!/usr/bin/env python3
import json, os, sys
mode = os.environ.get("STUB_MODE", "ok")
if mode == "fail":
    print("botocore.exceptions.ClientError: AccessDeniedException: not authorized to DescribeModelPackage", file=sys.stderr)
    sys.exit(1)
if mode == "error-json":
    print(json.dumps({"error": "Model package not found", "code": "GET_VERSION_FAILED"}))
    sys.exit(0)
md = {"parentModelVersionArn": "arn:aws:sagemaker:us-west-2:111122223333:model-package/proj/1",
      "modelName": "meta-llama/Llama-3.1-8B"}
kind = os.environ.get("STUB_KIND", "")
if kind:
    md["mlcc.artifact_kind"] = kind
print("some log noise")
print(json.dumps({"arn": sys.argv[sys.argv.index("--arn") + 1], "version": "7",
                  "modelDataUrl": os.environ.get("STUB_URI", "s3://bucket/registry/adapter"),
                  "metadata": md}))
`;

const TARGETS = ['realtime-inference', 'hyperpod-eks', 'eks', 'async-inference', 'batch-transform', ''];

describe('Wave 6 — _resolve_additive_source (ADR-013 axis 1, R1/R4/R8.1/R8.4)', function () {
    this.timeout(60000);
    let sb;
    before(() => {
        sb = makeSandbox();
        sb.write('do/.register_helper.py', REGISTER_HELPER_STUB);
    });
    after(() => sb.cleanup());

    const resolve = (args, env = {}) => {
        const quoted = args.map(a => `'${a}'`).join(' ');
        const r = runContract(sb, `_resolve_additive_source ${quoted}`, env);
        return { ...r, v: r.code === 0 ? parseResolved(sb, r.stdout) : {} };
    };

    describe('--from-weights (raw S3 → unknown kind)', () => {
        it('passes the URI straight through with an unknown kind', () => {
            const r = resolve(['from-weights', 's3://bucket/adapters/a b/', 'x']);
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(r.v.RESOLVED_SOURCE, 'from-weights');
            assert.strictEqual(r.v.RESOLVED_URI, 's3://bucket/adapters/a b/', 'URI must survive shell quoting');
            assert.strictEqual(r.v.RESOLVED_KIND, '', 'raw S3 carries no recorded kind');
        });

        it('refuses a non-S3 value with a structured error (non-zero, stderr)', () => {
            const r = resolve(['from-weights', '/local/path', 'x']);
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /Could not resolve --from-weights/);
            assert.strictEqual(r.stdout.trim(), '', 'no partial KEY=VALUE output on failure');
        });
    });

    describe('--from-tune (kind from the recorded tune output)', () => {
        it('latest + TUNE_OUTPUT_TYPE_LATEST=adapter → lora_adapter', () => {
            const r = resolve(['from-tune', '', 'x'], {
                TUNE_OUTPUT_PATH_LATEST: 's3://b/tune/out/', TUNE_OUTPUT_TYPE_LATEST: 'adapter'
            });
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(r.v.RESOLVED_URI, 's3://b/tune/out/');
            assert.strictEqual(r.v.RESOLVED_KIND, 'lora_adapter');
        });

        ['model', 'full-model'].forEach((t) => {
            it(`latest + TUNE_OUTPUT_TYPE_LATEST=${t} → full_model`, () => {
                const r = resolve(['from-tune', '', 'x'], {
                    TUNE_OUTPUT_PATH_LATEST: 's3://b/tune/m/', TUNE_OUTPUT_TYPE_LATEST: t
                });
                assert.strictEqual(r.code, 0, r.stderr);
                assert.strictEqual(r.v.RESOLVED_KIND, 'full_model');
            });
        });

        it('latest with no recorded type → unknown (degrade, not block)', () => {
            const r = resolve(['from-tune', '', 'x'], { TUNE_OUTPUT_PATH_LATEST: 's3://b/tune/legacy/' });
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(r.v.RESOLVED_KIND, '');
        });

        it('a technique reads TUNE_ADAPTER_PATH_<T> as a lora_adapter', () => {
            const r = resolve(['from-tune', 'sft', 'x'], { TUNE_ADAPTER_PATH_SFT: 's3://b/sft-adapter/' });
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(r.v.RESOLVED_URI, 's3://b/sft-adapter/');
            assert.strictEqual(r.v.RESOLVED_KIND, 'lora_adapter');
            assert.strictEqual(r.v.RESOLVED_META_TECHNIQUE, 'sft');
        });

        it('a technique-dataset compound prefers TUNE_ADAPTER_PATH_<T>_<SLUG>, falling back to <T>', () => {
            const both = resolve(['from-tune', 'sft-ectsum', 'x'], {
                TUNE_ADAPTER_PATH_SFT_ECTSUM: 's3://b/compound/', TUNE_ADAPTER_PATH_SFT: 's3://b/tech/'
            });
            assert.strictEqual(both.v.RESOLVED_URI, 's3://b/compound/');
            const fallback = resolve(['from-tune', 'sft-ectsum', 'x'], { TUNE_ADAPTER_PATH_SFT: 's3://b/tech/' });
            assert.strictEqual(fallback.v.RESOLVED_URI, 's3://b/tech/');
        });

        it('a technique with only a full-model output resolves TUNE_MODEL_PATH_<T> as full_model', () => {
            const r = resolve(['from-tune', 'cpt', 'x'], { TUNE_MODEL_PATH_CPT: 's3://b/cpt-model/' });
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(r.v.RESOLVED_KIND, 'full_model');
        });

        it('the preferred kind picks the matching path when both are recorded', () => {
            const env = { TUNE_ADAPTER_PATH_SFT: 's3://b/a/', TUNE_MODEL_PATH_SFT: 's3://b/m/' };
            assert.strictEqual(resolve(['from-tune', 'sft', 'x', 'lora_adapter'], env).v.RESOLVED_KIND, 'lora_adapter');
            assert.strictEqual(resolve(['from-tune', 'sft', 'x', 'full_model'], env).v.RESOLVED_KIND, 'full_model');
        });

        it('no recorded tune output fails loudly, naming what was tried and the remedy', () => {
            const r = resolve(['from-tune', 'dpo', 'x']);
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /TUNE_ADAPTER_PATH_DPO/);
            assert.match(r.stderr, /\.\/do\/tune --technique dpo/);
            const latest = resolve(['from-tune', '', 'x']);
            assert.notStrictEqual(latest.code, 0);
            assert.match(latest.stderr, /TUNE_OUTPUT_PATH_LATEST is not set/);
        });
    });

    describe('--from-train (recorded-or-unknown kind)', () => {
        it('latest → TRAIN_OUTPUT_PATH_LATEST with an unknown kind', () => {
            const r = resolve(['from-train', '', 'x'], { TRAIN_OUTPUT_PATH_LATEST: 's3://b/train/' });
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(r.v.RESOLVED_URI, 's3://b/train/');
            assert.strictEqual(r.v.RESOLVED_KIND, '');
        });

        it('uses a recorded TRAIN_OUTPUT_TYPE_LATEST when present', () => {
            const r = resolve(['from-train', '', 'x'], {
                TRAIN_OUTPUT_PATH_LATEST: 's3://b/train/', TRAIN_OUTPUT_TYPE_LATEST: 'adapter'
            });
            assert.strictEqual(r.v.RESOLVED_KIND, 'lora_adapter');
        });

        it('a technique reads TRAIN_ADAPTER_PATH_<T>; missing → structured failure', () => {
            const ok = resolve(['from-train', 'sft', 'x'], { TRAIN_ADAPTER_PATH_SFT: 's3://b/t-sft/' });
            assert.strictEqual(ok.v.RESOLVED_URI, 's3://b/t-sft/');
            const missing = resolve(['from-train', 'orpo', 'x']);
            assert.notStrictEqual(missing.code, 0);
            assert.match(missing.stderr, /TRAIN_ADAPTER_PATH_ORPO is not set/);
        });
    });

    describe('--from-registry (shells to .register_helper.py get-version)', () => {
        const ARN = 'arn:aws:sagemaker:us-west-2:111122223333:model-package/proj/7';

        ['lora_adapter', 'full_model'].forEach((kind) => {
            it(`reads the recorded artifact_kind (${kind}) off the version`, () => {
                const r = resolve(['from-registry', ARN, 'x'], { STUB_KIND: kind });
                assert.strictEqual(r.code, 0, r.stderr);
                assert.strictEqual(r.v.RESOLVED_KIND, kind);
                assert.strictEqual(r.v.RESOLVED_META_VERSION_ARN, ARN);
                assert.match(r.v.RESOLVED_META_PARENT_ARN, /model-package\/proj\/1$/);
                assert.strictEqual(r.v.RESOLVED_META_MODEL_NAME, 'meta-llama/Llama-3.1-8B');
            });
        });

        it('a pre-BL164 version with no recorded kind → unknown (degrade)', () => {
            const r = resolve(['from-registry', ARN, 'x']);
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(r.v.RESOLVED_KIND, '');
        });

        it('normalizes a directory-style model data URL to a trailing slash; leaves .tar.gz alone', () => {
            assert.strictEqual(resolve(['from-registry', ARN, 'x'], { STUB_URI: 's3://b/dir' }).v.RESOLVED_URI, 's3://b/dir/');
            assert.strictEqual(
                resolve(['from-registry', ARN, 'x'], { STUB_URI: 's3://b/a.tar.gz' }).v.RESOLVED_URI, 's3://b/a.tar.gz');
        });

        it('BL165: a failing helper surfaces its real stderr (not a silent empty)', () => {
            const r = resolve(['from-registry', ARN, 'x'], { STUB_MODE: 'fail' });
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /Could not resolve --from-registry/);
            assert.match(r.stderr, /AccessDeniedException/, 'the helper error text must be shown');
            assert.strictEqual(r.stdout.trim(), '');
        });

        it('a helper error payload is reported as a registry error', () => {
            const r = resolve(['from-registry', ARN, 'x'], { STUB_MODE: 'error-json' });
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /registry error: Model package not found/);
        });

        it('requires a version ARN', () => {
            const r = resolve(['from-registry', 'not-an-arn', 'x']);
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /version ARN is required/);
        });
    });

    describe('--from-hub (reuses the caller-provided _download_from_hub)', () => {
        const HUB_STUB = [
            '_download_from_hub() {',
            '  echo "📥 Downloading adapter from HuggingFace Hub: $1"',
            '  weights_uri="s3://adapters/proj/$2/adapter.tar.gz"',
            '}'
        ].join('\n');

        it('stages via the helper, keeps stdout clean, and reports an unknown kind', () => {
            const r = runContract(sb, `${HUB_STUB}\n_resolve_additive_source from-hub org/repo my-ad`);
            assert.strictEqual(r.code, 0, r.stderr);
            assert.match(r.stderr, /Downloading adapter/, 'helper progress goes to stderr');
            assert.ok(!/Downloading/.test(r.stdout), 'stdout must stay a KEY=VALUE stream');
            const v = parseResolved(sb, r.stdout);
            assert.strictEqual(v.RESOLVED_URI, 's3://adapters/proj/my-ad/adapter.tar.gz');
            assert.strictEqual(v.RESOLVED_KIND, '');
            assert.strictEqual(v.RESOLVED_META_HF_REPO, 'org/repo');
        });

        it('fails loudly when the verb has no hub staging helper', () => {
            const r = resolve(['from-hub', 'org/repo', 'x']);
            assert.notStrictEqual(r.code, 0);
            assert.match(r.stderr, /_download_from_hub/);
        });

        it('a failing hub download propagates as a non-zero resolution', () => {
            const r = runContract(sb, '_download_from_hub() { echo "boom" >&2; exit 1; }\n' +
                'out=$(_resolve_additive_source from-hub org/repo x) || { echo "rc=$?"; exit 0; }\necho "unexpected"');
            assert.match(r.stdout, /rc=1/);
        });
    });

    it('an unknown source verb is a structured error', () => {
        const r = resolve(['from-nowhere', 'x', 'y']);
        assert.notStrictEqual(r.code, 0);
        assert.match(r.stderr, /unknown source verb/);
    });

    describe('R1.2 — target-uniform resolution', () => {
        const cases = [
            ['from-weights', 's3://b/w/', {}],
            ['from-tune', '', { TUNE_OUTPUT_PATH_LATEST: 's3://b/t/', TUNE_OUTPUT_TYPE_LATEST: 'adapter' }],
            ['from-tune', 'sft', { TUNE_ADAPTER_PATH_SFT: 's3://b/sft/' }],
            ['from-train', '', { TRAIN_OUTPUT_PATH_LATEST: 's3://b/tr/' }],
            ['from-registry', 'arn:aws:sagemaker:us-west-2:1:model-package/p/2', { STUB_KIND: 'lora_adapter' }]
        ];
        cases.forEach(([src, arg, env]) => {
            it(`--${src}${arg ? ` ${arg}` : ''} resolves identically on every target`, () => {
                const outs = TARGETS.map(t => resolve([src, arg, 'x'], { ...env, DEPLOYMENT_TARGET: t }));
                outs.forEach((o, i) => assert.strictEqual(o.code, 0, `${TARGETS[i]}: ${o.stderr}`));
                const first = outs[0].stdout;
                outs.forEach((o, i) => assert.strictEqual(o.stdout, first, `differs on target '${TARGETS[i]}'`));
            });
        });

        it('the resolver body never reads DEPLOYMENT_TARGET', () => {
            const start = CONTRACT_SRC.indexOf('_resolve_additive_source() {');
            const end = CONTRACT_SRC.indexOf('\n}\n', start);
            assert.ok(start !== -1 && end !== -1);
            assert.ok(!CONTRACT_SRC.slice(start, end).includes('DEPLOYMENT_TARGET'));
        });
    });
});

describe('Wave 6 — script-contract.sh is bash-3.2 safe (sourced by every do/ script)', function () {
    this.timeout(30000);
    it(`sources cleanly under ${BASH} with set -euo pipefail`, () => {
        const sb = makeSandbox();
        try {
            const r = runContract(sb, 'echo "loaded:${BASH_VERSINFO[0]}"; _additive_accepts_kind adapter');
            assert.strictEqual(r.code, 0, r.stderr);
            assert.match(r.stdout, /^loaded:\d+/);
            assert.ok(!/syntax error|invalid option|unbound variable/i.test(r.stderr), r.stderr);
            assert.ok(r.stdout.split('\n')[1].length > 0, 'the contract must answer a lookup');
        } finally {
            sb.cleanup();
        }
    });

    it('uses no bash-4-only syntax', () => {
        const code = CONTRACT_SRC.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
        const forbidden = [
            [/declare\s+-A/, 'declare -A (associative arrays)'],
            [/\b(mapfile|readarray)\b/, 'mapfile/readarray'],
            [/\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)/, '${var,,} / ${var^^} case modification'],
            [/\|&/, '|& pipe'],
            [/&>>/, '&>> append redirect'],
            [/\[\s*-1\s*\]/, 'negative array index']
        ];
        for (const [re, what] of forbidden) {
            assert.ok(!re.test(code), `script-contract.sh must not use ${what}`);
        }
    });
});
