// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 8 (R5 / R10.3) — do/validate is a target-aware dispatcher.
 *
 * Runs the REAL templates/do/validate under /bin/bash in a sandbox project with
 * the real Python helpers and descriptors, stub kubectl / aws, and (for the
 * SageMaker case) a stub Node validate-runner module at the dev-repo path the
 * script probes. Asserts:
 *   - which sections run is derived from targets.d (family / serving_config_source
 *     / cluster_contract), not a hardcoded target list;
 *   - a missing schema registry is "skipped", not exit 2;
 *   - k8s targets get cluster-contract findings and no SageMaker payload check;
 *   - --format json (space form) and --format=json both produce JSON;
 *   - a right-sizing block is exit 1.
 */
import { describe, it, afterEach } from 'mocha';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, sandboxEnv, runBash, REPO, DO_SRC } from '../helpers/additive-sandbox.js';

const PY_FILES = ['validate_report.py', 'deploy_schema.py'];

describe('Wave 8 — do/validate dispatcher (behavioral, bash 3.2)', function () {
    this.timeout(60000);
    let sb;
    afterEach(() => sb && sb.cleanup());

    function setup(configLines, { registry = false, runner = false, kubectlOk = true } = {}) {
        sb = makeSandbox({ scripts: ['validate'], pyHelpers: true });
        for (const py of PY_FILES) {
            sb.write(`do/lib/python/${py}`, readFileSync(join(DO_SRC, 'lib/python', py)), 0o644);
        }
        sb.write('do/lib/eks-contract.sh', readFileSync(join(DO_SRC, 'lib/eks-contract.sh')), 0o644);
        sb.write('.mlcc/instances.json', readFileSync(join(REPO, 'servers/lib/catalogs/instances.json')), 0o644);
        sb.write('do/config', [...configLines, ''].join('\n'), 0o644);
        sb.write('bin/kubectl', `#!/bin/bash\necho "kubectl $*" >> "${sb.root}/calls.log"\n${
            kubectlOk ? 'case "$1" in get) echo "csidriver.storage.k8s.io/s3.csi.aws.com";; esac\nexit 0\n'
                : 'echo "The connection to the server was refused" >&2; exit 1\n'}`);
        sb.write('bin/aws', `#!/bin/bash\necho "aws $*" >> "${sb.root}/calls.log"\nexit 255\n`);
        // Hide any globally installed mcc so the probe finds the sandbox runner (or none).
        sb.write('bin/npm', '#!/bin/bash\necho /nonexistent-npm-root\n');
        if (registry) {
            sb.write('home/.ml-container-creator/schemas/manifest.json', '{"lastSynced": "2099-01-01T00:00:00Z"}', 0o644);
        }
        if (runner) {
            // do/validate probes <project>/src/lib/validate-runner.js (dev-repo layout).
            sb.write('src/lib/validate-runner.js', [
                'export async function run(opts) {',
                '  console.log(JSON.stringify({ schemaErrors: [{ operation: "CreateInferenceComponent",',
                '    fieldPath: "Specification.ComputeResourceRequirements", remediationHint: "stub error" }],',
                '    crossCuttingErrors: [], warnings: [], advisoryFindings: [],',
                '    summary: { errors: 1, warnings: 0, advisory: 0, fieldsValidated: 3 }, metadata: {} }));',
                '  console.error("RUNNER_CONFIG_DIR=" + opts.configDir);',
                '  process.exit(1);',
                '}', ''
            ].join('\n'), 0o644);
        }
    }
    const validate = (args) => runBash(join(sb.doDir, 'validate'), args,
        sandboxEnv(sb, { HOME: join(sb.root, 'home') }), { timeout: 50000 });
    const calls = () => (existsSync(join(sb.root, 'calls.log')) ? readFileSync(join(sb.root, 'calls.log'), 'utf8') : '');
    const section = (report, name) => report.sections.find((s) => s.name === name);

    it('realtime-inference without a schema registry: service-model is skipped (not exit 2), other checks run', () => {
        setup(['export DEPLOYMENT_TARGET="realtime-inference"', 'export MODEL_SERVER="vllm"',
            'export INSTANCE_TYPE="ml.m5.xlarge"']);
        const r = validate(['--format', 'json', '--offline']);
        assert.notStrictEqual(r.code, 2, r.stdout + r.stderr);
        const rep = JSON.parse(r.stdout);
        assert.strictEqual(rep.target, 'realtime-inference');
        assert.strictEqual(section(rep, 'service-model').status, 'skipped');
        assert.match(section(rep, 'service-model').reason, /bootstrap sync-schemas/);
        assert.strictEqual(section(rep, 'right-sizing').status, 'ran');
        assert.strictEqual(section(rep, 'config').status, 'ran');
        assert.strictEqual(section(rep, 'cluster-contract').status, 'skipped');
        assert.ok(!/kubectl/.test(calls()), 'no cluster probe on a SageMaker target');
    });

    it('realtime-inference with a registry runs the Node payload check and merges its errors (exit 1)', () => {
        setup(['export DEPLOYMENT_TARGET="realtime-inference"', 'export MODEL_SERVER="vllm"',
            'export INSTANCE_TYPE="ml.m5.xlarge"'], { registry: true, runner: true });
        const r = validate(['--format=json', '--offline']);
        assert.strictEqual(r.code, 1, r.stdout + r.stderr);
        const sm = section(JSON.parse(r.stdout), 'service-model');
        assert.strictEqual(sm.status, 'ran');
        assert.ok(sm.findings.some((f) => f.severity === 'error' && /stub error/.test(f.message)));
    });

    it('eks: cluster-contract findings from the BL156 helper, no SageMaker payload check', () => {
        setup(['export DEPLOYMENT_TARGET="eks"', 'export MODEL_SERVER="vllm"', 'export HP_INSTANCE_TYPE="ml.m5.xlarge"',
            'export HP_CLUSTER_NAME="c"', 'export INSTANCE_TYPE="ml.m5.xlarge"'], { registry: true, runner: true });
        const r = validate(['--format', 'json', '--offline']);
        const rep = JSON.parse(r.stdout);
        const cc = section(rep, 'cluster-contract');
        assert.strictEqual(cc.status, 'ran', JSON.stringify(cc));
        assert.ok(cc.findings.some((f) => /Cluster contract/.test(f.message)), JSON.stringify(cc.findings));
        assert.strictEqual(section(rep, 'service-model').status, 'skipped');
        assert.match(section(rep, 'service-model').reason, /kubernetes/);
        assert.ok(!/RUNNER_CONFIG_DIR/.test(r.stderr), 'the Node runner must not run for a k8s target');
    });

    it('hyperpod-eks: an unreachable cluster skips the contract with the reason', () => {
        setup(['export DEPLOYMENT_TARGET="hyperpod-eks"', 'export MODEL_SERVER="vllm"', 'export HP_CLUSTER_NAME="c"',
            'export INSTANCE_TYPE="ml.m5.xlarge"'], { kubectlOk: false });
        const r = validate(['--offline']);
        assert.match(r.stdout, /Cluster contract \(read-only\): skipped — cluster not reachable/);
        assert.match(r.stdout, /SageMaker service-model payloads .*skipped/);
    });

    it('missing required settings warn (do/deploy prompts for them); a malformed IC conf errors; no target is exit 2', () => {
        setup(['export DEPLOYMENT_TARGET="batch-transform"', 'export MODEL_SERVER="vllm"', 'export INSTANCE_TYPE=""']);
        const r = validate(['--offline']);
        assert.strictEqual(r.code, 0, r.stdout);
        assert.match(r.stdout, /⚠️ +\[config-required\] BATCH_INPUT_PATH is required for batch-transform/);
        sb.cleanup();
        setup(['export DEPLOYMENT_TARGET="realtime-inference"', 'export MODEL_SERVER="vllm"',
            'export INSTANCE_TYPE="ml.m5.xlarge"']);
        sb.write('do/ic/default.conf', 'export IC_GPU_COUNT=two\n', 0o644);
        const bad = validate(['--offline']);
        assert.strictEqual(bad.code, 1, bad.stdout);
        assert.match(bad.stdout, /do\/ic\/default\.conf IC_GPU_COUNT='two'/);
        sb.cleanup();
        setup(['export MODEL_SERVER="vllm"']);
        const none = validate([]);
        assert.strictEqual(none.code, 2, none.stdout);
        assert.match(none.stdout, /could not run/);
    });

    it('a right-sizing block is a validation error (exit 1)', () => {
        setup(['export DEPLOYMENT_TARGET="eks"', 'export MODEL_SERVER="vllm"', 'export HP_INSTANCE_TYPE="ml.g5.xlarge"',
            'export HP_CLUSTER_NAME="c"', 'export INSTANCE_TYPE="ml.g5.xlarge"', 'export HP_GPU_COUNT="3"',
            'export HP_LORA_ENABLED="false"'], { kubectlOk: false });
        // TP 3 > the instance's GPUs (any 1-GPU instance) -> tp-divisibility block, no model needed
        const cat = JSON.parse(readFileSync(join(REPO, 'servers/lib/catalogs/instances.json'), 'utf8')).catalog;
        const oneGpu = Object.keys(cat).find((k) => cat[k].gpus === 1);
        sb.write('do/config', readFileSync(join(sb.doDir, 'config'), 'utf8').replace(/ml\.g5\.xlarge/g, oneGpu), 0o644);
        const r = validate(['--format', 'json', '--offline']);
        assert.strictEqual(r.code, 1, r.stdout + r.stderr);
        const rs = section(JSON.parse(r.stdout), 'right-sizing');
        assert.ok(rs.findings.some((f) => f.check === 'tp-divisibility' && f.severity === 'error'));
    });

    it('--help describes what is actually checked (no do/adapters claim)', () => {
        setup(['export DEPLOYMENT_TARGET="eks"']);
        const r = validate(['--help']);
        assert.strictEqual(r.code, 0);
        assert.match(r.stdout, /Right-sizing/);
        assert.match(r.stdout, /Cluster contract/);
        assert.match(r.stdout, /--format json\|text/);
        assert.ok(!/do\/adapters\/\*\.conf/.test(r.stdout));
    });
});

describe('Wave 8 — do/validate static guards', () => {
    const src = readFileSync(join(DO_SRC, 'validate'), 'utf8');
    it('has no bare except: and no hardcoded target list', () => {
        assert.ok(!/except:\s*$/m.test(src), 'bare except: must be narrowed');
        assert.ok(!/realtime-inference\|async-inference/.test(src));
        const py = readFileSync(join(DO_SRC, 'lib/python/validate_report.py'), 'utf8');
        for (const t of ['"eks"', '"hyperpod-eks"', '"realtime-inference"', '"batch-transform"', '"async-inference"']) {
            assert.ok(!py.includes(t), `validate_report.py must derive targets from targets.d, found ${t}`);
        }
    });
});
