// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 6 — do/adapter (incl. BL169 on Kubernetes) and do/add-ic on the shared
 * resolver + contract, executed end-to-end in a sandbox with stubbed aws /
 * kubectl / lora_vllm.py / .register_helper.py.
 *
 *   R5 / BL169  the k8s path ACCEPTS --from-* (was refused), resolves through the
 *               shared resolver, and hot-loads it via lora_vllm.py — Wave 6.1
 *               (BL189): by its IN-POD path under the model mount, never s3://;
 *               every Running pod (R1.6); rank pre-check vs the live limit (R3.2)
 *   R5.3 / R8.5 a full_model is refused on do/adapter; a lora_adapter on do/add-ic
 *   R2 / R8.3   --weights / --model-data are deprecated aliases of --from-weights
 *               (same resolved source + the notice); --model-data-url is untouched
 *   R9 / R8.6   a crashing / failing hot-load helper is SURFACED, not swallowed
 *   R6.2        do/add-ic --from-registry (stretch) resolves a full-model version
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSandbox, runBash, sandboxEnv, ACTIVE_STATUS_CONFIG, REPO } from '../helpers/additive-sandbox.js';

const AWS_STUB = `#!/bin/bash
# Stub aws CLI: cluster lookups succeed. S3 reads fail (advisory sniff → unknown)
# unless STUB_RANK is set, in which case adapter_config.json reads return r=STUB_RANK.
case "$1 $2" in
  "sagemaker describe-cluster") echo "arn:aws:eks:us-west-2:111122223333:cluster/hp-eks" ;;
  "eks update-kubeconfig") exit 0 ;;
  "s3 cp")
    if [ -n "\${STUB_RANK:-}" ] && [[ "$3" == */adapter_config.json ]]; then
      echo "{\\"r\\": \${STUB_RANK}, \\"rank_pattern\\": {}}"; exit 0
    fi
    echo "stub aws: $*" >&2; exit 1 ;;
  *) echo "stub aws: $*" >&2; exit 1 ;;
esac
`;
// kubectl stub (Wave 6.1): Running pod names (STUB_PODS), pod JSON carrying the
// live VLLM_MAX_LORA_RANK (STUB_LIVE_RANK), and the live InferenceEndpointConfig
// (S3 model source s3://core/models/m, prefetch STUB_PREFETCH; STUB_SOURCE=huggingface
// for an HF-sourced deployment).
const KUBECTL_STUB = `#!/bin/bash
pods="\${STUB_PODS:-proj-pod-0}"
case "$1 $2" in
  "get inferenceendpointconfig")
    if [ "\${STUB_SOURCE:-s3}" = "huggingface" ]; then
      echo '{"spec":{"modelSourceConfig":{"modelSourceType":"huggingface","prefetchEnabled":true}}}'
    else
      echo "{\\"spec\\":{\\"modelSourceConfig\\":{\\"modelSourceType\\":\\"s3\\",\\"s3Storage\\":{\\"bucketName\\":\\"core\\"},\\"modelLocation\\":\\"\${STUB_MODEL_LOCATION:-models/m}\\",\\"prefetchEnabled\\":\${STUB_PREFETCH:-false}}}}"
    fi ;;
  "get pod")
    case " $* " in
      *" -o json "*)
        echo "{\\"items\\":[{\\"spec\\":{\\"containers\\":[{\\"env\\":[{\\"name\\":\\"VLLM_MAX_LORA_RANK\\",\\"value\\":\\"\${STUB_LIVE_RANK:-64}\\"}]}]}}]}" ;;
      *) for p in $pods; do echo "$p"; done ;;
    esac ;;
  port-forward*) exec sleep 30 ;;
  *) case "$1" in port-forward) exec sleep 30 ;; *) exit 1 ;; esac ;;
esac
`;
// lora_vllm.py stub: records every call; LORA_STUB selects the outcome;
// LORA_FAIL_CALL=<n> fails the n-th load (multi-pod partial failure).
const LORA_STUB = `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["LORA_LOG"], "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
with open(os.environ["LORA_LOG"]) as f:
    n_loads = sum(1 for line in f if line.startswith("load "))
mode = os.environ.get("LORA_STUB", "ok")
cmd = sys.argv[1]
if mode == "crash":
    print("Traceback (most recent call last):\\nModuleNotFoundError: No module named 'requests'", file=sys.stderr)
    sys.exit(1)
if cmd == "list":
    print(json.dumps([{"name": "a1", "path": "/opt/ml/model/.mlcc-adapters/proj/a1"}]))
    sys.exit(0)
if mode == "409" and cmd == "load":
    print(json.dumps({"success": False, "error": "adapter exists", "status_code": 409}))
    sys.exit(1)
if cmd == "load" and str(n_loads) == os.environ.get("LORA_FAIL_CALL", ""):
    print(json.dumps({"success": False, "error": "boom", "status_code": 500}))
    sys.exit(1)
print(json.dumps({"success": True}))
`;
const REGISTER_STUB = `#!/usr/bin/env python3
import json, os, sys
md = {}
if os.environ.get("STUB_KIND"):
    md["mlcc.artifact_kind"] = os.environ["STUB_KIND"]
print(json.dumps({"arn": "x", "version": "3", "modelDataUrl": os.environ.get("STUB_URI", "s3://b/reg/adapter/"), "metadata": md}))
`;
// Fake boto3 (S3 only) for the promotion / serving-copy paths: objects live in the
// JSON file FAKE_S3 as {"<bucket>/<key>": "<content>"}; no AWS call is made.
const FAKE_BOTO3 = `import hashlib, io, json, os
class _C:
    def _l(self):
        p = os.environ.get("FAKE_S3", "")
        return json.load(open(p)) if p and os.path.exists(p) else {}
    def _s(self, d):
        json.dump(d, open(os.environ["FAKE_S3"], "w"))
    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        d = self._l(); pre = Bucket + "/" + Prefix
        return {"Contents": [{"Key": k[len(Bucket) + 1:], "Size": len(v), "ETag": hashlib.md5(v.encode()).hexdigest()}
                             for k, v in sorted(d.items()) if k.startswith(pre)], "IsTruncated": False}
    def get_object(self, Bucket, Key):
        d = self._l()
        if Bucket + "/" + Key not in d:
            raise KeyError(Key)
        return {"Body": io.BytesIO(d[Bucket + "/" + Key].encode())}
    def put_object(self, Bucket, Key, Body, ContentType=None):
        d = self._l(); d[Bucket + "/" + Key] = Body.decode() if isinstance(Body, bytes) else Body; self._s(d)
    def copy(self, src, bucket, key):
        # FAKE_S3_FAIL_COPY_AT=<n>: the n-th server-side copy fails (mid-promotion failure).
        at = os.environ.get("FAKE_S3_FAIL_COPY_AT", "")
        if at:
            cf = os.environ["FAKE_S3"] + ".copies"
            n = (int(open(cf).read()) if os.path.exists(cf) else 0) + 1
            open(cf, "w").write(str(n))
            if str(n) == at:
                raise RuntimeError("injected copy failure")
        d = self._l(); d[bucket + "/" + key] = d[src["Bucket"] + "/" + src["Key"]]; self._s(d)
    def delete_objects(self, Bucket, Delete):
        d = self._l()
        for o in Delete["Objects"]:
            d.pop(Bucket + "/" + o["Key"], None)
        self._s(d)
    # Binary-safe file transfer (tarball sources, --from-hub publish): bytes are
    # stored as latin-1 strings so they round-trip through the JSON store.
    def head_object(self, Bucket, Key):
        v = self._l()[Bucket + "/" + Key]
        return {"ContentLength": len(v), "ETag": hashlib.md5(v.encode("latin-1")).hexdigest()}
    def download_file(self, bucket, key, path):
        open(path, "wb").write(self._l()[bucket + "/" + key].encode("latin-1"))
    def upload_file(self, path, bucket, key):
        d = self._l(); d[bucket + "/" + key] = open(path, "rb").read().decode("latin-1"); self._s(d)
def client(service, region_name=None):
    return _C()
`;
function k8sConfig(extra = []) {
    return [
        ACTIVE_STATUS_CONFIG,
        'export DEPLOYMENT_TARGET="hyperpod-eks"',
        'export PROJECT_NAME="proj"',
        'export AWS_REGION="us-west-2"',
        'export HP_LORA_ENABLED="true"',
        'export HP_CLUSTER_NAME="hp"',
        'export HP_LOCAL_PORT="18080"',
        'export HP_PF_WAIT="0"',
        ...extra,
        ''
    ].join('\n');
}
// The deployment's canonical adapter home (model prefix + .mlcc-adapters, from the
// target descriptor) and the in-pod path it maps to.
const PFX = 's3://core/models/m/.mlcc-adapters/proj';
// BL199: parse an adapter URI with the ONE layout module (home_uri, version, canonical_uri).
const LAYOUT_PY = join(REPO, 'templates/do/lib/python/s3_layout.py');
const layoutParse = (uri) => JSON.parse(spawnSync('python3', [LAYOUT_PY, 'parse', '--uri', uri], { encoding: 'utf8' }).stdout);
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const POD = '/opt/ml/model/.mlcc-adapters/proj';
const URL = 'http://localhost:18080';
describe('Wave 6 / 6.1 — do/adapter on Kubernetes: --from-* sources, local-path hot-load (BL169 / BL189)', function () {
    this.timeout(120000);
    let sb;
    let log;
    before(() => {
        sb = makeSandbox({ scripts: ['adapter'], pyHelpers: true });
        sb.write('bin/aws', AWS_STUB);
        sb.write('bin/kubectl', KUBECTL_STUB);
        sb.write('do/lib/python/lora_vllm.py', LORA_STUB);
        sb.write('do/.register_helper.py', REGISTER_STUB);
        sb.write('do/lib/python/boto3/__init__.py', FAKE_BOTO3, 0o644);
        log = join(sb.root, 'lora.log');
    });
    after(() => sb.cleanup());
    const run = (args, { config = [], env = {} } = {}) => {
        sb.write('do/config', k8sConfig(config), 0o644);
        sb.write('lora.log', '', 0o644);
        const r = runBash(join(sb.doDir, 'adapter'), args,
            sandboxEnv(sb, { HOME: sb.root, LORA_LOG: log, ...env }), { timeout: 30000 });
        return { ...r, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
    };
    it('add --from-weights under the model prefix hot-loads the IN-POD path (never s3://)', () => {
        const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`]);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.deepStrictEqual(r.calls, [`load ad1 ${POD}/ad1 ${URL}`]);
        assert.match(r.stdout, /Pod path: \/opt\/ml\/model\/\.mlcc-adapters\/proj\/ad1/);
    });
    it('--weights is a deprecated alias: same hot-load + the notice on stderr', () => {
        const r = run(['add', 'ad1', '--weights', `${PFX}/ad1/`]);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.deepStrictEqual(r.calls, [`load ad1 ${POD}/ad1 ${URL}`]);
        assert.match(r.stderr, /--weights is deprecated; use --from-weights/);
    });
    it('R1.3: a source outside the model prefix needs the core bucket to promote — refused before any engine call', () => {
        const r = run(['add', 'tuned', '--from-tune'], {
            config: ['export TUNE_OUTPUT_PATH_LATEST="s3://b/tune/out/"', 'export TUNE_OUTPUT_TYPE_LATEST="adapter"']
        });
        assert.strictEqual(r.code, 1, r.stdout + r.stderr);
        assert.deepStrictEqual(r.calls, [], 'no s3:// path may ever reach the engine');
        assert.match(r.stdout, /coreS3Bucket/);
        assert.ok(!/Contract violation/.test(r.stdout), 'the k8s source-verb refusal must stay gone');
    });
    it('R1.3 / bucket R3: a raw tune output is promoted into the canonical prefix, then loaded by path (no copy)', () => {
        const state = join(sb.root, 'fake-s3.json');
        sb.write('fake-s3.json', JSON.stringify({
            'zz-art/proj/tune/sft/j/hf/adapter_config.json': '{"r": 16}',
            'zz-art/proj/tune/sft/j/hf/adapter_model.safetensors': 'w'
        }), 0o644);
        const r = run(['add', 'tuned', '--from-tune', 'sft'], {
            config: ['export TUNE_ADAPTER_PATH_SFT="s3://zz-art/proj/tune/sft/j/hf/"', 'export MODEL_NAME="org/m"',
                'export TUNE_MODEL_ID="org/m"', 'export CORE_S3_BUCKET="core"'],
            env: { STUB_MODEL_LOCATION: 'models/org/m', FAKE_S3: state }
        });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        // BL199: loaded from the content-addressed version directory; lora_name stays <name>.
        assert.strictEqual(r.calls.length, 1, r.calls.join('\n'));
        const [verb, loraName, path, url] = r.calls[0].split(' ');
        assert.deepStrictEqual([verb, loraName, url], ['load', 'tuned', URL]);
        const version = path.slice(`${POD}/tuned/`.length);
        assert.ok(path.startsWith(`${POD}/tuned/`) && layoutParse(`s3://core/models/org/m/.mlcc-adapters/proj/tuned/${version}/`).version === version, path);
        const after = JSON.parse(readFileSync(state, 'utf8'));
        const vkey = `core/models/org/m/.mlcc-adapters/proj/tuned/${version}/`;
        assert.ok(after[`${vkey}adapter_model.safetensors`], 'payload promoted');
        const m = JSON.parse(after[`${vkey}mlcc-adapter.json`]);
        assert.strictEqual(m.base_model, 'org/m');
        assert.strictEqual(m.technique, 'sft');
        assert.strictEqual(m.version, version);
        assert.ok(!m.serving_copy_of, 'the canonical home is not a serving copy');
        assert.match(r.stdout, /Promote: s3:\/\/zz-art\/proj\/tune\/sft\/j\/hf\/ → s3:\/\/core\/models\/org\/m\/\.mlcc-adapters\/proj\/tuned\//);
        assert.ok(r.stdout.includes(`Pod path: ${path}`), r.stdout);
    });
    it('promote <name> --from-tune <t> --update-config backfills the canonical prefix and keeps the old value (bucket R3.7)', () => {
        sb.write('do/lib/profile.sh', '_require_bucket() { eval "[ -n \\"\\${$1:-}\\" ]"; }\n', 0o644);
        const state = join(sb.root, 'fake-s3.json');
        sb.write('fake-s3.json', JSON.stringify({
            'zz-art/proj/tune/dpo/j/hf/adapter_config.json': '{"r": 64}',
            'zz-art/proj/tune/dpo/j/hf/adapter_model.safetensors': 'w'
        }), 0o644);
        const raw = 's3://zz-art/proj/tune/dpo/j/hf/';
        const r = run(['promote', 'dpo-a', '--from-tune', 'dpo', '--update-config'], {
            config: [`export TUNE_ADAPTER_PATH_DPO="${raw}"`, 'export TUNE_MODEL_ID="org/m"', 'export CORE_S3_BUCKET="core"'],
            env: { FAKE_S3: state }
        });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.deepStrictEqual(r.calls, [], 'promote never talks to the engine');
        const home = 's3://core/models/org/m/.mlcc-adapters/proj/dpo-a/';
        const canon = (r.stdout.match(/Canonical: (\S+)/) || [])[1];
        assert.ok(canon, r.stdout);
        const parsed = layoutParse(canon);
        assert.strictEqual(parsed.home_uri, home);
        assert.ok(parsed.version && canon === `${home}${parsed.version}/`, canon);
        const cfg = readFileSync(join(sb.doDir, 'config'), 'utf8');
        assert.match(cfg, new RegExp(`export TUNE_ADAPTER_PATH_DPO="${reEsc(canon)}"`));
        assert.match(cfg, new RegExp(`export TUNE_ADAPTER_SOURCE_DPO="${raw}"`));
        const after = JSON.parse(readFileSync(state, 'utf8'));
        assert.strictEqual(JSON.parse(after[`${canon.slice('s3://'.length)}mlcc-adapter.json`]).rank, 64);
        sb.write('do/lib/profile.sh', '# stub profile.sh\n', 0o644);
    });
    it('remove unloads and deletes ONLY a serving copy it made; a canonical adapter is kept', () => {
        const state = join(sb.root, 'fake-s3.json');
        const copy = 'core/models/org/m/.mlcc-adapters/proj/cp1/';
        const canon = 'core/models/org/m/.mlcc-adapters/proj/keep/';
        sb.write('fake-s3.json', JSON.stringify({
            // An unversioned (pre-BL199) serving copy and a versioned one: both are copies.
            [`${copy}adapter_model.safetensors`]: 'w',
            [`${copy}mlcc-adapter.json`]: JSON.stringify({ serving_copy_of: 's3://core/models/x/y/.mlcc-adapters/proj/cp1/' }),
            [`${copy}v0123456789ab/adapter_model.safetensors`]: 'w2',
            [`${copy}v0123456789ab/mlcc-adapter.json`]: JSON.stringify({ serving_copy_of: 's3://core/models/x/y/.mlcc-adapters/proj/cp1/v0123456789ab/' }),
            [`${canon}adapter_model.safetensors`]: 'w',
            [`${canon}mlcc-adapter.json`]: JSON.stringify({ content_hash: 'sha256:x' })
        }), 0o644);
        const env = { STUB_MODEL_LOCATION: 'models/org/m', FAKE_S3: state };
        const r1 = run(['remove', 'cp1'], { env });
        assert.strictEqual(r1.code, 0, r1.stdout + r1.stderr);
        assert.deepStrictEqual(r1.calls, [`unload cp1 ${URL}`]);
        assert.match(r1.stdout, /Deleted the serving copy/);
        const r2 = run(['remove', 'keep'], { env });
        assert.strictEqual(r2.code, 0, r2.stdout + r2.stderr);
        const after = JSON.parse(readFileSync(state, 'utf8'));
        assert.ok(!Object.keys(after).some(k => k.startsWith(copy)), 'serving copy deleted');
        assert.ok(after[`${canon}adapter_model.safetensors`], 'canonical adapter kept');
    });
    it('BL199: update with new content unloads + loads the NEW version path on every Running pod; the old version is kept', () => {
        const state = join(sb.root, 'fake-s3.json');
        sb.write('fake-s3.json', JSON.stringify({
            'zz-art/proj/tune/sft/j/hf/adapter_config.json': '{"r": 16}',
            'zz-art/proj/tune/sft/j/hf/adapter_model.safetensors': 'w1'
        }), 0o644);
        const opts = {
            config: ['export TUNE_ADAPTER_PATH_SFT="s3://zz-art/proj/tune/sft/j/hf/"', 'export MODEL_NAME="org/m"',
                'export TUNE_MODEL_ID="org/m"', 'export CORE_S3_BUCKET="core"'],
            env: { STUB_MODEL_LOCATION: 'models/org/m', FAKE_S3: state, STUB_PODS: 'p0 p1' }
        };
        const add = run(['add', 'upd', '--from-tune', 'sft'], opts);
        assert.strictEqual(add.code, 0, add.stdout + add.stderr);
        const v1Path = add.calls[0].split(' ')[2];
        assert.deepStrictEqual(add.calls, [`load upd ${v1Path} ${URL}`, `load upd ${v1Path} ${URL}`]);
        const v1Key = `core/models/org/m/.mlcc-adapters/proj/upd/${v1Path.split('/').pop()}/`;
        const v1Files = Object.entries(JSON.parse(readFileSync(state, 'utf8'))).filter(([k]) => k.startsWith(v1Key));
        // Same content → the same version path (vLLM still swaps it: unload + load).
        const same = run(['update', 'upd', '--from-tune', 'sft'], opts);
        assert.strictEqual(same.code, 0, same.stdout + same.stderr);
        assert.deepStrictEqual(same.calls, [`unload upd ${URL}`, `load upd ${v1Path} ${URL}`, `unload upd ${URL}`, `load upd ${v1Path} ${URL}`]);
        // New content → a new v<hash12> directory, loaded under the SAME lora_name on each pod.
        const s = JSON.parse(readFileSync(state, 'utf8'));
        s['zz-art/proj/tune/sft/j/hf/adapter_model.safetensors'] = 'w2';
        writeFileSync(state, JSON.stringify(s));
        const upd = run(['update', 'upd', '--from-tune', 'sft'], opts);
        assert.strictEqual(upd.code, 0, upd.stdout + upd.stderr);
        const v2Path = upd.calls[1].split(' ')[2];
        assert.notStrictEqual(v2Path, v1Path);
        assert.strictEqual(layoutParse(`s3://core/models/org/m/.mlcc-adapters/proj/upd/${v2Path.split('/').pop()}/`).home_uri,
            's3://core/models/org/m/.mlcc-adapters/proj/upd/');
        assert.deepStrictEqual(upd.calls, [`unload upd ${URL}`, `load upd ${v2Path} ${URL}`, `unload upd ${URL}`, `load upd ${v2Path} ${URL}`]);
        assert.match(upd.stdout, /2\/2 succeeded/);
        const after = JSON.parse(readFileSync(state, 'utf8'));
        assert.deepStrictEqual(Object.entries(after).filter(([k]) => k.startsWith(v1Key)), v1Files, 'the old version is untouched');
    });
    it('add --from-tune whose output is under the model prefix hot-loads it', () => {
        const r = run(['add', 'tuned', '--from-tune'], {
            config: [`export TUNE_OUTPUT_PATH_LATEST="${PFX}/tuned/"`, 'export TUNE_OUTPUT_TYPE_LATEST="adapter"']
        });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.deepStrictEqual(r.calls, [`load tuned ${POD}/tuned ${URL}`]);
    });
    it('add --from-registry hot-loads the registered adapter version (mapped to the pod path)', () => {
        const r = run(['add', 'reg', '--from-registry', 'arn:aws:sagemaker:us-west-2:1:model-package/proj/3'],
            { env: { STUB_KIND: 'lora_adapter', STUB_URI: `${PFX}/reg/` } });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.deepStrictEqual(r.calls, [`load reg ${POD}/reg ${URL}`]);
    });
    it('a full_model source is refused BEFORE any cluster call (kind gate, exit 3)', () => {
        const r = run(['add', 'full', '--from-tune'], {
            config: ['export TUNE_OUTPUT_PATH_LATEST="s3://b/tune/m/"', 'export TUNE_OUTPUT_TYPE_LATEST="model"']
        });
        assert.strictEqual(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stdout, /Contract violation: artifact-kind/);
        // Wave 11 R8.2: the guidance is derived from the ADR-013 tuple — on
        // hyperpod-eks a full model is served by do/add-pod.
        assert.match(r.stdout, /do\/add-pod <name>/);
        assert.deepStrictEqual(r.calls, [], 'nothing may be hot-loaded');
        assert.ok(!/Port-forward/.test(r.stdout), 'refusal precedes the port-forward');
    });
    it('a registry full_model is refused too (any source)', () => {
        const r = run(['add', 'full', '--from-registry', 'arn:aws:sagemaker:us-west-2:1:model-package/proj/4'],
            { env: { STUB_KIND: 'full_model' } });
        assert.strictEqual(r.code, 3);
        assert.match(r.stdout, /Contract violation: artifact-kind/);
    });
    it('an unknown kind (raw S3) degrades to the content check and still loads', () => {
        const r = run(['add', 'legacy', '--from-weights', `${PFX}/legacy/`]);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stderr, /artifact_kind unknown/);
        assert.match(r.stdout, /Content check/);
        assert.strictEqual(r.calls.length, 1);
    });
    it('update --from-weights unloads then loads; remove and list still work', () => {
        const u = run(['update', 'ad1', '--from-weights', `${PFX}/v2/`]);
        assert.strictEqual(u.code, 0, u.stdout + u.stderr);
        assert.deepStrictEqual(u.calls, [`unload ad1 ${URL}`, `load ad1 ${POD}/v2 ${URL}`]);
        const rm = run(['remove', 'ad1']);
        assert.strictEqual(rm.code, 0);
        assert.deepStrictEqual(rm.calls, [`unload ad1 ${URL}`]);
        const ls = run(['list']);
        assert.strictEqual(ls.code, 0);
        assert.match(ls.stdout, /a1\s+\/opt\/ml\/model\/\.mlcc-adapters\/proj\/a1/);
    });
    it('rejects two sources at once and a missing source', () => {
        const both = run(['add', 'x', '--from-weights', 's3://b/w/', '--from-tune']);
        assert.strictEqual(both.code, 1);
        assert.match(both.stdout, /mutually exclusive/);
        const none = run(['add', 'x']);
        assert.strictEqual(none.code, 1);
        assert.match(none.stdout, /requires a source/);
    });
    it('a failed resolution stops before the cluster with the resolver error', () => {
        const r = run(['add', 'x', '--from-tune', 'dpo']);
        assert.strictEqual(r.code, 1);
        assert.match(r.stderr, /Could not resolve --from-tune/);
        assert.deepStrictEqual(r.calls, []);
    });
    describe('Wave 6.1 R1.4 — deployments that cannot take mounted adapters refuse with the fix', () => {
        it('an HF-sourced hyperpod-eks deployment points at do/stage + redeploy', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], { env: { STUB_SOURCE: 'huggingface' } });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /not served from S3/);
            assert.match(r.stdout, /\.\/do\/stage/);
            assert.deepStrictEqual(r.calls, []);
        });
        it('a deployment still on prefetch points at the LoRA redeploy (and --surge-node)', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], { env: { STUB_PREFETCH: 'true' } });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /prefetchEnabled: true/);
            assert.match(r.stdout, /--surge-node/);
            assert.deepStrictEqual(r.calls, []);
        });
        it('plain eks without the S3 model mount names EKS_MODEL_MOUNT=s3', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], {
                config: ['export DEPLOYMENT_TARGET="eks"', 'export DEPLOYMENT_TARGET_EKS_STATUS="Running"']
            });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /EKS_MODEL_MOUNT=s3/);
            assert.deepStrictEqual(r.calls, []);
        });
        it('plain eks WITH the S3 model mount maps under STAGED_MODEL_PATH', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], {
                config: ['export DEPLOYMENT_TARGET="eks"', 'export DEPLOYMENT_TARGET_EKS_STATUS="Running"',
                    'export EKS_MODEL_MOUNT="s3"', 'export STAGED_MODEL_PATH="s3://core/models/m/"']
            });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.deepStrictEqual(r.calls, [`load ad1 ${POD}/ad1 ${URL}`]);
        });
    });
    describe('Wave 6.1 R1.6 — every Running pod', () => {
        it('loads on each pod and reports per pod', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], { env: { STUB_PODS: 'p0 p1' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.deepStrictEqual(r.calls, [`load ad1 ${POD}/ad1 ${URL}`, `load ad1 ${POD}/ad1 ${URL}`]);
            assert.match(r.stdout, /pod\/p0/);
            assert.match(r.stdout, /pod\/p1/);
            assert.match(r.stdout, /2\/2 succeeded/);
        });
        it('a failure on any pod exits non-zero and names the pod', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], { env: { STUB_PODS: 'p0 p1', LORA_FAIL_CALL: '2' } });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.strictEqual(r.calls.length, 2, 'the second pod is still attempted');
            assert.match(r.stdout, /1\/2 succeeded/);
            assert.match(r.stdout, /✗ pod\/p1/);
        });
        it('remove unloads from every pod', () => {
            const r = run(['remove', 'ad1'], { env: { STUB_PODS: 'p0 p1 p2' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.strictEqual(r.calls.length, 3);
        });
    });
    describe('Wave 6.1 R3.2 — rank pre-check against the LIVE limit, before any engine call', () => {
        it('an adapter above the live max_lora_rank is refused with the exact fix', () => {
            const r = run(['add', 'big', '--from-weights', `${PFX}/big/`], { env: { STUB_RANK: '128', STUB_LIVE_RANK: '64' } });
            assert.strictEqual(r.code, 1, r.stdout + r.stderr);
            assert.deepStrictEqual(r.calls, [], 'the engine is never called');
            assert.match(r.stdout, /Rank check: adapter r128 vs serving max_lora_rank 64 \(pod env\)/);
            assert.match(r.stdout, /VLLM_MAX_LORA_RANK=128/);
            assert.match(r.stdout, /\.\/do\/deploy --target hyperpod-eks --force/);
        });
        it('an adapter within the live limit loads', () => {
            const r = run(['add', 'ok', '--from-weights', `${PFX}/ok/`], { env: { STUB_RANK: '32', STUB_LIVE_RANK: '64' } });
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.strictEqual(r.calls.length, 1);
        });
    });
    describe('BL165 — hot-load helper failures are surfaced (R9.1 / R8.6)', () => {
        it('a crashing lora_vllm.py shows its traceback + guidance (no silent exit)', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], { env: { LORA_STUB: 'crash' } });
            assert.strictEqual(r.code, 1);
            assert.match(r.stdout, /lora_vllm\.py load failed/);
            assert.match(r.stdout, /No module named 'requests'/);
            assert.match(r.stdout, /Failed to load LoRA adapter 'ad1'/);
        });
        it('a vLLM 409 is reported as already-exists (previously aborted by set -e before the message)', () => {
            const r = run(['add', 'ad1', '--from-weights', `${PFX}/ad1/`], { env: { LORA_STUB: '409' } });
            assert.strictEqual(r.code, 1);
            assert.match(r.stdout, /already exists/);
            assert.match(r.stdout, /do\/adapter remove ad1/);
        });
        it('a crashing list helper is an error, not "No LoRA adapters loaded"', () => {
            const r = run(['list'], { env: { LORA_STUB: 'crash' } });
            assert.strictEqual(r.code, 1);
            assert.match(r.stdout, /Could not list LoRA adapters/);
            assert.ok(!/No LoRA adapters loaded/.test(r.stdout));
        });
    });
});
describe('Wave 6 — do/adapter (SMAI) --weights deprecated alias (R2.2)', function () {
    this.timeout(60000);
    it('add --weights prints the notice and parses as --from-weights', () => {
        const sb = makeSandbox({
            scripts: ['adapter'],
            config: [ACTIVE_STATUS_CONFIG, 'export DEPLOYMENT_TARGET="realtime-inference"', 'export ENABLE_LORA="true"',
                'export PROJECT_NAME="proj"', 'export AWS_REGION="us-west-2"', ''].join('\n')
        });
        try {
            sb.write('bin/aws', AWS_STUB);
            const r = runBash(join(sb.doDir, 'adapter'), ['add', 'ad1', '--weights', 's3://b/a.tar.gz'], sandboxEnv(sb));
            assert.match(r.stderr, /--weights is deprecated; use --from-weights/);
            // It gets past parsing + URI validation to the base-IC lookup (no IC in the sandbox).
            assert.match(r.stdout, /Adding adapter: ad1/);
            assert.match(r.stderr, /Cannot determine base inference component/, 'BL165: the base-IC error must not be swallowed by $(...)');
        } finally {
            sb.cleanup();
        }
    });
});

// ── SMAI (realtime-inference) adapter ICs end to end (Wave 6.1 Part B screen) ──
// aws stub: records every invocation (JSON argv per line in AWS_LOG); the base IC
// is InService with STUB_IC_ENV as its container Environment; create/update/delete
// of adapter ICs succeed (a deleted IC then reads as not found); `aws s3 cp <uri> -`
// (the rank pre-check) reads the fake S3 store. No AWS call is made.
const SMAI_AWS_STUB = `#!/bin/bash
python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "$@" >> "\${AWS_LOG}"
q=""; ic=""; prev=""
for a in "$@"; do
  case "$prev" in --query) q="$a" ;; --inference-component-name) ic="$a" ;; esac
  prev="$a"
done
case "$1 $2" in
  "sagemaker describe-inference-component")
    if [ -f "\${AWS_LOG}.deleted-$ic" ]; then echo "ValidationException: not found" >&2; exit 254; fi
    case "$q" in
      InferenceComponentStatus) echo "InService" ;;
      Specification.Container.Environment) echo "\${STUB_IC_ENV:-{\\}}" ;;
      *) echo "None" ;;
    esac ;;
  "sagemaker create-inference-component"|"sagemaker update-inference-component")
    rm -f "\${AWS_LOG}.deleted-$ic"
    echo '{"InferenceComponentArn": "arn:aws:sagemaker:us-west-2:111122223333:inference-component/x"}' ;;
  "sagemaker delete-inference-component") : > "\${AWS_LOG}.deleted-$ic" ;;
  "s3 ls") exit 0 ;;
  "s3 cp")
    if [ "$4" = "-" ]; then
      exec python3 -c 'import json, os, sys
d = json.load(open(os.environ["FAKE_S3"])); k = sys.argv[1][len("s3://"):]
sys.exit(1) if k not in d else sys.stdout.write(d[k])' "$3"
    fi
    exit 1 ;;
  *) exit 1 ;;
esac
`;
// hf CLI stub (--from-hub): writes a PEFT adapter + the repo files hf download brings.
const HF_STUB = `#!/bin/bash
dir=""; prev=""
for a in "$@"; do [ "$prev" = "--local-dir" ] && dir="$a"; prev="$a"; done
mkdir -p "$dir/.cache/huggingface"
printf '%s' '{"r": 16, "target_modules": ["q_proj", "v_proj"], "base_model_name_or_path": "google/gemma-4-E4B-it"}' > "$dir/adapter_config.json"
printf 'hub-weights' > "$dir/adapter_model.safetensors"
printf '# card' > "$dir/README.md"
printf '*.safetensors filter=lfs' > "$dir/.gitattributes"
`;
// The engine's max-LoRA-rank env var, derived from the serving-engine descriptor.
const loraRankVar = () => {
    const m = JSON.parse(readFileSync(join(REPO, 'templates/code/serve.d/vllm/manifest.json'), 'utf8'));
    return m.env_var_prefix + m.capability_map.lora_max_rank.suffix;
};
describe('Wave 6.1 Part B + BL199 — do/adapter on realtime-inference: every source is promoted to a content-addressed canonical version the adapter IC loads', function () {
    this.timeout(180000);
    const CORE_B = 'zz-core-smai';
    const ART_B = 'zz-art-smai';
    const TUNE_ID = 'huggingface-vlm-gemma-4-e4b-it';
    // Modeled on a real fresh-ai-ml SFT output (do/tune records .../output/model/checkpoints/hf/):
    // the PEFT pair plus the tokenizer / processor files the recipe writes next to it.
    const RAW = `${ART_B}/proj/tune/sft/proj-tune-sft-1/output/model/checkpoints/hf/`;
    const RAW_FILES = {
        'adapter_config.json': JSON.stringify({ r: 32, lora_alpha: 64, target_modules: ['q_proj', 'v_proj'], base_model_name_or_path: 'google/gemma-4-E4B-it' }),
        'adapter_model.safetensors': 'tuned-weights',
        'chat_template.jinja': '{{ messages }}',
        'processor_config.json': '{}',
        'tokenizer.json': '{}',
        'tokenizer_config.json': '{}'
    };
    let sb;
    let store;
    let awsLog;
    const allIcRequests = [];
    const pyLayout = join(REPO, 'templates/do/lib/python/s3_layout.py');
    // The canonical HOME, composed by the ONE layout module (never re-derived here).
    const canonical = (name) => JSON.parse(spawnSync('python3', [pyLayout, 'adapter-uri', '--bucket', CORE_B,
        '--model', TUNE_ID, '--project', 'proj', '--name', name, '--catalog', join(REPO, 'config/tune-catalog.json')],
    { encoding: 'utf8' }).stdout).uri;
    const keysUnder = (s, uri) => Object.keys(s).filter(k => k.startsWith(uri.slice('s3://'.length)))
        .map(k => k.slice(uri.length - 's3://'.length)).sort();
    const smaiConfig = (extra = []) => [
        ACTIVE_STATUS_CONFIG,
        'export DEPLOYMENT_TARGET="realtime-inference"',
        'export ENABLE_LORA="true"',
        'export PROJECT_NAME="proj"',
        'export AWS_REGION="us-west-2"',
        'export ENDPOINT_NAME="proj-endpoint"',
        'export INFERENCE_COMPONENT_NAME="proj-base-ic"',
        'export MODEL_NAME="google/gemma-4-E4B-it"',
        `export TUNE_MODEL_ID="${TUNE_ID}"`,
        `export TUNE_ADAPTER_PATH_SFT="s3://${RAW}"`,
        `export TRAIN_ADAPTER_PATH_SFT="s3://${RAW}"`,
        ...extra,
        ''
    ].join('\n');
    const seedRaw = (s = {}) => {
        for (const [f, v] of Object.entries(RAW_FILES)) s[RAW + f] = v;
        return s;
    };
    const tarball = (layout) => {
        const dir = mkdtempSync(join(tmpdir(), 'mlcc-smai-tar-'));
        const src = layout === 'nested' ? join(dir, 'my-adapter') : join(dir, 'flat');
        mkdirSync(src, { recursive: true });
        writeFileSync(join(src, 'adapter_config.json'), RAW_FILES['adapter_config.json']);
        writeFileSync(join(src, 'adapter_model.safetensors'), 'tar-weights');
        const out = join(dir, 'adapter.tar.gz');
        const args = layout === 'nested' ? ['-czf', out, '-C', dir, 'my-adapter'] : ['-czf', out, '-C', src, '.'];
        spawnSync('tar', args, { env: { ...process.env, COPYFILE_DISABLE: '1' } });
        const bytes = readFileSync(out).toString('latin1');
        rmSync(dir, { recursive: true, force: true });
        return bytes;
    };
    before(() => {
        sb = makeSandbox({ scripts: ['adapter'], pyHelpers: true, realProfile: true });
        sb.write('bin/aws', SMAI_AWS_STUB);
        sb.write('bin/hf', HF_STUB);
        sb.write('do/lib/python/boto3/__init__.py', FAKE_BOTO3, 0o644);
        // Bucket names reach do/adapter only through the profile (profile.sh → CORE_S3_BUCKET).
        sb.writeProfile({ coreS3Bucket: CORE_B, artifactsS3Bucket: ART_B, awsRegion: 'us-west-2' });
        store = join(sb.root, 'fake-s3.json');
        awsLog = join(sb.root, 'aws.log');
    });
    after(() => sb.cleanup());
    const run = (args, { config = [], env = {}, seed } = {}) => {
        sb.write('do/config', smaiConfig(config), 0o644);
        if (seed) writeFileSync(store, JSON.stringify(seed));
        writeFileSync(awsLog, '');
        rmSync(`${store}.copies`, { force: true });
        const r = runBash(join(sb.doDir, 'adapter'), args, sandboxEnv(sb, {
            HOME: sb.root, FAKE_S3: store, AWS_LOG: awsLog, MLCC_SKIP_SECRET_DISCOVERY: '1',
            STUB_IC_ENV: JSON.stringify({ [loraRankVar()]: '64' }), ...env
        }), { timeout: 60000 });
        const aws = readFileSync(awsLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
        const ic = aws.filter(a => a[0] === 'sagemaker' && /^(create|update)-inference-component$/.test(a[1]));
        allIcRequests.push(...ic);
        const spec = (verb) => {
            const c = ic.find(a => a[1] === verb);
            return c ? JSON.parse(c[c.indexOf('--specification') + 1]) : null;
        };
        return { ...r, aws, ic, spec, s3: JSON.parse(readFileSync(store, 'utf8')) };
    };
    const conf = (name) => readFileSync(join(sb.doDir, 'adapters', `${name}.conf`), 'utf8');
    const removeConf = (name) => rmSync(join(sb.doDir, 'adapters', `${name}.conf`), { force: true });

    // BL199: every IC ArtifactUrl is a content-addressed version <home>/v<hash12>/ of the home above.
    const versionOf = (url, name) => {
        const p = layoutParse(url);
        assert.strictEqual(p.home_uri, canonical(name), url);
        assert.ok(p.version && p.canonical_uri === url, `not a canonical version URI: ${url}`);
        return p.version;
    };
    const filesUnder = (s, uri) => Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith(uri.slice('s3://'.length))));
    const urls = {};

    it('--from-tune <t>: the raw output is copied server-side to a content-addressed version and the IC ArtifactUrl is that version', () => {
        const r = run(['add', 'tuned-sft', '--from-tune', 'sft', '--local'], { seed: seedRaw() });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /--local \/ --no-wait no longer apply/);
        const spec = r.spec('create-inference-component');
        const dest = spec.Container.ArtifactUrl;
        const version = versionOf(dest, 'tuned-sft');
        assert.strictEqual(spec.BaseInferenceComponentName, 'proj-base-ic');
        assert.ok(dest.endsWith('/') && !dest.slice('s3://'.length).includes('//'), dest);
        assert.deepStrictEqual(Object.keys(spec.Container), ['ArtifactUrl'], 'an adapter IC carries no image / env / compute of its own');
        // Same files as the old validated stage-from-tune prefix (adapter_config.json at the top) + the manifest.
        assert.deepStrictEqual(keysUnder(r.s3, dest), [...Object.keys(RAW_FILES), 'mlcc-adapter.json'].sort());
        const m = JSON.parse(r.s3[`${dest.slice('s3://'.length)  }mlcc-adapter.json`]);
        assert.strictEqual(m.source, `s3://${RAW}`);
        assert.strictEqual(m.rank, 32);
        assert.strictEqual(m.version, version);
        assert.match(m.content_hash, /^sha256:[0-9a-f]{64}$/);
        assert.ok(Object.keys(r.s3).some(k => k === `${RAW  }adapter_config.json`), 'the raw output is never moved');
        assert.match(conf('tuned-sft'), new RegExp(`ADAPTER_WEIGHTS_URI="${reEsc(dest)}"`));
        assert.match(conf('tuned-sft'), new RegExp(`ADAPTER_SOURCE_URI="s3://${RAW}"`));
        assert.match(r.stdout, /Rank check: adapter r32 vs serving max_lora_rank 64/);
        urls.v1 = dest;
    });

    it('re-adding the same tune output is idempotent: promotion "unchanged" (same version), the old IC is replaced', () => {
        const before = JSON.parse(readFileSync(store, 'utf8'));
        const r = run(['add', 'tuned-sft', '--from-tune', 'sft']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.match(r.stderr, /Promotion unchanged/);
        assert.deepStrictEqual(r.s3, before, 'nothing rewritten');
        assert.ok(r.aws.some(a => a[1] === 'delete-inference-component'), 'AC-1.7: re-tune replaces the IC');
        assert.strictEqual(r.spec('create-inference-component').Container.ArtifactUrl, urls.v1);
    });

    it('a promotion of new content that fails mid-copy creates no IC and never touches the version in use', () => {
        const v1Files = filesUnder(JSON.parse(readFileSync(store, 'utf8')), urls.v1);
        const seed = seedRaw(JSON.parse(readFileSync(store, 'utf8')));
        seed[`${RAW  }adapter_model.safetensors`] = 'tuned-weights-v2';
        const r = run(['add', 'tuned-sft', '--from-tune', 'sft'], { seed, env: { FAKE_S3_FAIL_COPY_AT: '2' } });
        assert.notStrictEqual(r.code, 0);
        assert.match(r.stderr, /injected copy failure/);
        assert.ok(!r.aws.some(a => a[1] === 'create-inference-component'), 'no IC points at a half-written prefix');
        assert.deepStrictEqual(filesUnder(r.s3, urls.v1), v1Files, 'the previous version is untouched');
        const home = canonical('tuned-sft').slice('s3://'.length);
        const versions = [...new Set(Object.keys(r.s3).filter(k => k.startsWith(home)).map(k => k.slice(home.length).split('/')[0]))];
        assert.strictEqual(versions.length, 2, versions.join(','));
        const partial = versions.find(v => !r.s3[`${home}${v}/mlcc-adapter.json`]);
        assert.ok(partial, 'the half-written new version has no manifest a later run could trust');
        // The retry copies again (not "unchanged") and completes the NEW version.
        const again = run(['add', 'tuned-sft', '--from-tune', 'sft']);
        assert.strictEqual(again.code, 0, again.stdout + again.stderr);
        assert.match(again.stderr, /Promotion copied/);
        const v2 = again.spec('create-inference-component').Container.ArtifactUrl;
        assert.strictEqual(v2, `${canonical('tuned-sft')}${partial}/`);
        assert.strictEqual(again.s3[`${v2.slice('s3://'.length)  }adapter_model.safetensors`], 'tuned-weights-v2');
        assert.deepStrictEqual(filesUnder(again.s3, urls.v1), v1Files);
        urls.v2 = v2;
    });

    it('--from-weights <prefix> (no trailing slash) is accepted and promoted', () => {
        const r = run(['add', 'w-prefix', '--from-weights', `s3://${RAW.replace(/\/$/, '')}`], { seed: seedRaw() });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const dest = r.spec('create-inference-component').Container.ArtifactUrl;
        versionOf(dest, 'w-prefix');
        assert.ok(keysUnder(r.s3, dest).includes('adapter_config.json'));
    });

    it('--from-weights <flat .tar.gz> is extracted: loose files at the top of the version, no archive', () => {
        const tgz = `${ART_B}/mlcc-screen-in/adapter.tar.gz`;
        const r = run(['add', 'w-tar', '--from-weights', `s3://${tgz}`], { seed: { [tgz]: tarball('flat') } });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const dest = r.spec('create-inference-component').Container.ArtifactUrl;
        versionOf(dest, 'w-tar');
        assert.deepStrictEqual(keysUnder(r.s3, dest), ['adapter_config.json', 'adapter_model.safetensors', 'mlcc-adapter.json']);
        assert.strictEqual(r.s3[`${dest.slice('s3://'.length)  }adapter_model.safetensors`], 'tar-weights');
    });

    it('--from-weights <.tar.gz with a top-level folder> is refused before any IC or S3 write', () => {
        const tgz = `${ART_B}/mlcc-screen-in/nested.tar.gz`;
        const r = run(['add', 'w-nested', '--from-weights', `s3://${tgz}`], { seed: { [tgz]: tarball('nested') } });
        assert.notStrictEqual(r.code, 0);
        assert.match(r.stderr, /no adapter_config\.json at its top level.*my-adapter\/adapter_config\.json/s);
        assert.strictEqual(r.ic.length, 0, 'no IC is created for an unservable layout');
        assert.deepStrictEqual(keysUnder(r.s3, canonical('w-nested')), []);
    });

    it('--from-weights <canonical version without a slash> is used as-is, normalized to ONE trailing slash (no copy)', () => {
        // Re-seed the tuned-sft versions (the w-* tests replaced the store).
        const seed = seedRaw();
        for (const v of [urls.v1, urls.v2]) {
            for (const f of [...Object.keys(RAW_FILES), 'mlcc-adapter.json']) seed[`${v.slice('s3://'.length)}${f}`] = 'x';
        }
        removeConf('canon');
        const r = run(['add', 'canon', '--from-weights', urls.v2.replace(/\/$/, '')], { seed });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.strictEqual(r.spec('create-inference-component').Container.ArtifactUrl, urls.v2);
        assert.deepStrictEqual(r.s3, seed);
    });

    it('backward compat: an UNVERSIONED canonical home (pre-BL199 / hand copy, no manifest) still loads, updates and removes', () => {
        // Modeled on the live fresh-ai-ml .mlcc-adapters/<project>/sft-w6/: loose PEFT files, no mlcc-adapter.json.
        const legacy = canonical('legacy-w6');
        const seed = JSON.parse(readFileSync(store, 'utf8'));
        seed[`${legacy.slice('s3://'.length)}adapter_config.json`] = RAW_FILES['adapter_config.json'];
        seed[`${legacy.slice('s3://'.length)}adapter_model.safetensors`] = 'hand-copy';
        removeConf('legacy-w6');
        const add = run(['add', 'legacy-w6', '--from-weights', legacy.replace(/\/$/, '')], { seed });
        assert.strictEqual(add.code, 0, add.stdout + add.stderr);
        assert.strictEqual(add.spec('create-inference-component').Container.ArtifactUrl, legacy, 'used as-is');
        assert.deepStrictEqual(add.s3, seed, 'no copy');
        assert.match(conf('legacy-w6'), new RegExp(`ADAPTER_WEIGHTS_URI="${reEsc(legacy)}"`));
        // Updating it from new weights moves the IC onto a versioned URI; the legacy files are untouched.
        const s = JSON.parse(readFileSync(store, 'utf8'));
        const legacyFiles = Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith(legacy.slice('s3://'.length))));
        const upd = run(['update', 'legacy-w6', '--from-weights', `s3://${RAW}`], { seed: seedRaw(s) });
        assert.strictEqual(upd.code, 0, upd.stdout + upd.stderr);
        const v = upd.spec('update-inference-component').Container.ArtifactUrl;
        versionOf(v, 'legacy-w6');
        assert.match(upd.stdout, new RegExp(`Previous version \\(kept for rollback\\): ${reEsc(legacy)}`));
        for (const [k, val] of Object.entries(legacyFiles)) assert.strictEqual(upd.s3[k], val, k);
        // Rolling back to the legacy home is an update to that URI (a canonical source is used as-is).
        const back = run(['update', 'legacy-w6', '--from-weights', legacy]);
        assert.strictEqual(back.code, 0, back.stdout + back.stderr);
        assert.strictEqual(back.spec('update-inference-component').Container.ArtifactUrl, legacy);
        const rm = run(['remove', 'legacy-w6']);
        assert.strictEqual(rm.code, 0, rm.stdout + rm.stderr);
        assert.ok(rm.aws.some(a => a[1] === 'delete-inference-component' && a.includes('proj-adapter-legacy-w6')));
        for (const [k, val] of Object.entries(legacyFiles)) assert.strictEqual(rm.s3[k], val, k);
    });

    it('--from-hub publishes the loose PEFT files (no tarball, no repo metadata) and the IC loads that version', () => {
        const r = run(['add', 'hub-a', '--from-hub', 'org/some-adapter'], { seed: {} });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const dest = r.spec('create-inference-component').Container.ArtifactUrl;
        versionOf(dest, 'hub-a');
        assert.deepStrictEqual(keysUnder(r.s3, dest), ['README.md', 'adapter_config.json', 'adapter_model.safetensors', 'mlcc-adapter.json']);
        assert.strictEqual(JSON.parse(r.s3[`${dest.slice('s3://'.length)  }mlcc-adapter.json`]).source, 'hf://org/some-adapter');
        urls.hub1 = dest;
    });

    it('BL199: update with UNCHANGED content is a no-op — no UpdateInferenceComponent, conf unchanged', () => {
        const before = conf('hub-a');
        const r = run(['update', 'hub-a', '--from-weights', urls.hub1]);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.ok(!r.aws.some(a => a[1] === 'update-inference-component'), 'no byte-identical update is sent');
        assert.match(r.stdout, /unchanged/);
        assert.match(r.stdout, /No UpdateInferenceComponent was sent/);
        assert.strictEqual(conf('hub-a'), before);
        // Re-publishing the same Hub files is the same version, so also a no-op.
        const hub = run(['update', 'hub-a', '--from-hub', 'org/some-adapter']);
        assert.strictEqual(hub.code, 0, hub.stdout + hub.stderr);
        assert.ok(!hub.aws.some(a => a[1] === 'update-inference-component'));
    });

    it('update with NEW content promotes a new version and points the IC at that NEW ArtifactUrl; the old version is kept', () => {
        const tgz = `${ART_B}/mlcc-screen-in/v2.tar.gz`;
        const seed = { ...JSON.parse(readFileSync(store, 'utf8')), [tgz]: tarball('flat') };
        const oldFiles = filesUnder(seed, urls.hub1);
        const r = run(['update', 'hub-a', '--from-weights', `s3://${tgz}`], { seed });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const spec = r.spec('update-inference-component');
        const dest = spec.Container.ArtifactUrl;
        versionOf(dest, 'hub-a');
        assert.notStrictEqual(dest, urls.hub1, 'a NEW ArtifactUrl');
        assert.deepStrictEqual(spec, { Container: { ArtifactUrl: dest } });
        assert.deepStrictEqual(keysUnder(r.s3, dest), ['adapter_config.json', 'adapter_model.safetensors', 'mlcc-adapter.json']);
        assert.deepStrictEqual(filesUnder(r.s3, urls.hub1), oldFiles, 'the previous version (with its README.md) is untouched');
        assert.match(conf('hub-a'), new RegExp(`ADAPTER_WEIGHTS_URI="${reEsc(dest)}"`));
    });

    it('remove deletes only the adapter IC; every version under the canonical home is kept', () => {
        const before = JSON.parse(readFileSync(store, 'utf8'));
        const r = run(['remove', 'tuned-sft']);
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.ok(r.aws.some(a => a[1] === 'delete-inference-component' && a.includes('proj-adapter-tuned-sft')));
        assert.deepStrictEqual(r.s3, before);
        assert.ok(!existsSync(join(sb.doDir, 'adapters', 'tuned-sft.conf')));
    });

    it('promote --dry-run names the version directory and every key it would copy, and writes nothing', () => {
        const seed = seedRaw();
        const r = run(['promote', 'dry-sft', '--from-tune', 'sft', '--dry-run'], { seed });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        assert.deepStrictEqual(r.s3, seed, 'read-only');
        const dest = (r.stdout.match(/Destination: (\S+)/) || [])[1];
        const version = versionOf(dest, 'dry-sft');
        assert.ok(r.stderr.includes(`version: ${version}`), r.stderr);
        for (const f of Object.keys(RAW_FILES)) {
            assert.ok(r.stderr.includes(`copy   s3://${RAW}${f}  ->  ${dest}${f}`), f);
        }
        assert.ok(r.stderr.includes(`write  ${dest}mlcc-adapter.json`));
        assert.match(r.stdout, /Dry run: nothing was written/);
        assert.strictEqual(r.ic.length, 0);
        // The real promotion lands exactly where the dry run said.
        const real = run(['promote', 'dry-sft', '--from-tune', 'sft']);
        assert.strictEqual(real.code, 0, real.stdout + real.stderr);
        assert.ok(real.stdout.includes(`Canonical: ${dest}`), real.stdout);
        const again = run(['promote', 'dry-sft', '--from-tune', 'sft', '--dry-run']);
        assert.match(again.stderr, /action: unchanged/);
    });

    it('--from-train records ADAPTER_SOURCE="train" exactly once', () => {
        removeConf('trained-sft');
        const r = run(['add', 'trained-sft', '--from-train', 'sft'], { seed: seedRaw() });
        assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        const lines = conf('trained-sft').split('\n').filter(l => l.startsWith('export ADAPTER_SOURCE='));
        assert.deepStrictEqual(lines, ['export ADAPTER_SOURCE="train"']);
    });

    it('every adapter IC request carried a canonical ArtifactUrl with one trailing slash (a version, except the legacy home)', () => {
        assert.ok(allIcRequests.length >= 8, `IC requests captured: ${allIcRequests.length}`);
        let versioned = 0;
        for (const a of allIcRequests) {
            const url = JSON.parse(a[a.indexOf('--specification') + 1]).Container.ArtifactUrl;
            const p = layoutParse(url);
            assert.strictEqual(p.canonical_uri, url, url);
            if (p.version) versioned += 1;
            else assert.ok(url.endsWith('/legacy-w6/'), `only the pre-BL199 home is unversioned: ${url}`);
        }
        assert.ok(versioned >= 6, `versioned ArtifactUrls: ${versioned}`);
    });
});

describe('Wave 6 — do/add-ic on the resolver + contract (R6 / R2)', function () {
    this.timeout(60000);
    let sb;
    before(() => {
        sb = makeSandbox({ scripts: ['add-ic'] });
        sb.write('bin/aws', AWS_STUB);
        sb.write('do/.register_helper.py', REGISTER_STUB);
    });
    after(() => sb.cleanup());

    const run = (args, config = [], env = {}) => {
        sb.write('do/config', [ACTIVE_STATUS_CONFIG, 'export DEPLOYMENT_TARGET="realtime-inference"',
            'export PROJECT_NAME="proj"', 'export AWS_REGION="us-west-2"', ...config, ''].join('\n'), 0o644);
        // stdin is empty: the interactive prompts after resolution end the run.
        return runBash(join(sb.doDir, 'add-ic'), args, sandboxEnv(sb, env));
    };

    it('--from-weights and the deprecated --model-data resolve to the same model data', () => {
        const canonical = run(['ic1', '--from-weights', 's3://b/model.tar.gz']);
        const alias = run(['ic1', '--model-data', 's3://b/model.tar.gz']);
        const line = /📦 Using --from-weights model data: s3:\/\/b\/model\.tar\.gz/;
        assert.match(canonical.stdout, line);
        assert.match(alias.stdout, line);
        assert.ok(!/deprecated/.test(canonical.stderr));
        assert.match(alias.stderr, /--model-data is deprecated; use --from-weights/);
    });

    it('--from-tune with a full-model output is accepted', () => {
        const r = run(['ic1', '--from-tune'], ['export TUNE_OUTPUT_PATH_LATEST="s3://b/m/"', 'export TUNE_OUTPUT_TYPE_LATEST="model"']);
        assert.match(r.stdout, /📦 Using --from-tune model data: s3:\/\/b\/m\//);
    });

    it('a lora_adapter is refused with a pointer to do/adapter (exit 3)', () => {
        const r = run(['ic1', '--from-tune'], ['export TUNE_OUTPUT_PATH_LATEST="s3://b/a/"', 'export TUNE_OUTPUT_TYPE_LATEST="adapter"']);
        assert.strictEqual(r.code, 3, r.stdout + r.stderr);
        assert.match(r.stdout, /Contract violation: artifact-kind/);
        assert.match(r.stdout, /do\/adapter add <name> --from-tune/);
    });

    it('stretch R6.2: --from-registry resolves a full-model version; an adapter version is refused', () => {
        const ok = run(['ic1', '--from-registry', 'arn:aws:sagemaker:us-west-2:1:model-package/proj/5'], [],
            { STUB_KIND: 'full_model', STUB_URI: 's3://b/full/model.tar.gz' });
        assert.match(ok.stdout, /📦 Using --from-registry model data: s3:\/\/b\/full\/model\.tar\.gz/);
        const bad = run(['ic1', '--from-registry', 'arn:aws:sagemaker:us-west-2:1:model-package/proj/6'], [],
            { STUB_KIND: 'lora_adapter' });
        assert.strictEqual(bad.code, 3);
    });

    it('rejects two sources at once', () => {
        const r = run(['ic1', '--from-tune', '--from-weights', 's3://b/m/']);
        assert.strictEqual(r.code, 1);
        assert.match(r.stdout, /mutually exclusive/);
    });

    it('on hyperpod-eks the derived refusal points at do/adapter add <name> --from-tune (not --load-lora)', () => {
        sb.write('do/config', [ACTIVE_STATUS_CONFIG, 'export DEPLOYMENT_TARGET="hyperpod-eks"', ''].join('\n'), 0o644);
        const r = runBash(join(sb.doDir, 'add-ic'), ['ic1'], sandboxEnv(sb));
        assert.strictEqual(r.code, 3);
        assert.match(r.stdout, /do\/adapter add <name> --from-tune/);
        assert.ok(!/--load-lora/.test(r.stdout));
    });
});

describe('Wave 6 — R2.3 trap: --model-data-url is NOT renamed (regression guard)', () => {
    const register = readFileSync(join(REPO, 'templates/do/register'), 'utf8');
    const registerModel = readFileSync(join(REPO, 'templates/do/lib/python/register_model.py'), 'utf8');
    const registerHelper = readFileSync(join(REPO, 'templates/do/.register_helper.py'), 'utf8');

    it('do/register still forwards --model-data-url', () => {
        assert.ok(register.includes('"--model-data-url"'), 'do/register must keep --model-data-url');
        assert.ok(!register.includes('--from-weights'), 'the --from-weights rename must not reach do/register');
    });

    it('the register helper parser still defines --model-data-url (consumed by register_model.py)', () => {
        assert.match(registerHelper, /add_argument\("--model-data-url"/);
        assert.match(registerModel, /model_data_url/);
        assert.ok(!registerHelper.includes('--from-weights') && !registerModel.includes('--from-weights'));
    });
});
