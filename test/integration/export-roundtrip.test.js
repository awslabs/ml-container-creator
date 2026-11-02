// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 8 R8 / R10.4 — do/export round-trip, per deployment target.
 *
 * For every target in templates/do/targets.d (derived, not listed here):
 *   1. generate a project from a NON-DEFAULT answer set (real CLI, --offline),
 *   2. run the generated ./do/export --json (real bash + python3, runtime do/config),
 *   3. feed that JSON back with --config into a second generation,
 *   4. assert the answers are equal for every schema-covered (doConfigVar),
 *      non-secret parameter that applies to the target (R8.1);
 *   5. run ./do/export (CLI mode), parse the command against the schema cliFlags /
 *      envVars, assert it carries the same values as the JSON, and run it as a third
 *      generation whose answers must match too (R8.2).
 * The parameters come from the generated export map; every applicable one must be
 * exercised by FIXTURE or listed in NOT_EXERCISED with a reason, so a new do/config
 * parameter fails here until it is covered.
 */
import { describe, it, before, after } from 'mocha';
import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { listTargets, resolveTarget } from '../../src/lib/target-manifest-reader.js';
import { configKeyAliases } from '../../src/lib/generated/parameter-matrix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const EXPORT_MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'do', 'lib', 'python', 'export_map.json'), 'utf8')).parameters;

// Non-default values (valid per the schema's validation). Keyed by schema key.
const FIXTURE = {
    projectName: (t) => `rt-${t}`,
    deploymentConfig: () => 'transformers-vllm',
    modelName: () => 'Qwen/Qwen2.5-0.5B',
    deploymentTarget: (t) => t,
    instanceType: () => 'ml.g6.12xlarge',
    icGpuCount: () => 2,
    icCopyCount: () => 2,
    icMemorySize: () => 16384,
    icCpuCount: () => 4,
    icModelWeight: () => 0.5,
    enableLora: () => false,
    benchmarkConcurrency: () => 20,
    benchmarkInputTokensMean: () => 600,
    benchmarkOutputTokensMean: () => 200,
    benchmarkRequestCount: () => 50,
    benchmarkS3OutputPath: () => 's3://rt-bucket/bench/',
    baseImage: () => 'vllm/vllm-openai:v0.31.0',
    region: () => 'eu-west-1',
    codebuildComputeType: () => 'BUILD_GENERAL1_MEDIUM',
    endpointInitialInstanceCount: () => 2,
    endpointDataCapturePercent: () => 10,
    endpointVariantName: () => 'Blue',
    endpointVolumeSize: () => 200,
    capacityReservationArn: () => 'arn:aws:sagemaker:eu-west-1:111122223333:capacity-reservation/rt',
    asyncMaxConcurrent: () => 4,
    batchInstanceCount: () => 2,
    batchSplitType: () => 'RecordIO',
    batchStrategy: () => 'SingleRecord',
    batchJoinSource: () => 'Input',
    batchMaxConcurrent: () => 2,
    batchMaxPayload: () => 10,
    // eks runs without a cluster name (BYO kubeconfig) — exercises the no-cluster branch.
    hyperpodCluster: (t) => (t === 'eks' ? undefined : 'rt-cluster'),
    hyperpodNamespace: () => 'team-a',
    hyperpodReplicas: () => 2,
    fsxVolumeHandle: () => 'fs-0123456789abcdef0',
    hpGpuCount: () => 2,
    hpNodeSelector: () => 'node.kubernetes.io/instance-type=ml.g6.12xlarge',
    hpEfaEnabled: () => 'true',
    hpMemRequest: () => '64Gi',
    hpCpuRequest: () => '8',
    hpQueue: () => 'rt-queue',
    modelEnv: () => ({ RT_MODEL_FLAG: 'two words' }),
    serverEnv: () => ({ MAX_NUM_SEQS: '64' }),
    icEnv: () => ({ RT_IC_FLAG: 'on' })
};

// Applicable parameters this test cannot give a non-default value, and why.
const NOT_EXERCISED = {
    buildTarget: 'validation.enum has a single value (the default)',
    modelFormat: 'traditional-ML formats only; not valid with a transformers deployment config',
    benchmarkStreaming: 'only non-default value is false, which no CLI flag or envVar can express (unit-tested in test_export_config.py)',
    hfToken: 'secret — excluded from the round-trip (exported as a $HF_TOKEN reference, unit-tested)',
    ngcToken: 'secret — excluded from the round-trip (exported as a $NGC_API_KEY reference, unit-tested)'
};

function canonicalTargets(entry) {
    const out = new Set();
    for (const t of entry.deploymentTargets) {
        if (t === '*') return null;
        out.add(resolveTarget(t));
    }
    return out;
}

function applies(entry, target) {
    const set = canonicalTargets(entry);
    return set === null || set.has(target);
}

function answerKey(entry) {
    return configKeyAliases[entry.key] || entry.key;
}

function normalize(entry, value) {
    if (value === undefined || value === null) return null;
    if (entry.shape === 'env-map') return value;
    if (entry.type === 'integer' || entry.type === 'number') return Number(value);
    if (entry.type === 'boolean') return value === true || value === 'true';
    return String(value);
}

/**
 * `actual` carries the fixture `value`. Env maps may hold extra generator-derived
 * entries (e.g. --ic-gpu-count adds a tensor-parallel IC env var), so they are
 * compared as a superset; everything else must be equal.
 */
function assertCarries(entry, actual, value, message) {
    if (entry.shape === 'env-map') {
        for (const [k, v] of Object.entries(value)) assert.strictEqual((actual || {})[k], v, `${message} (${k})`);
        return;
    }
    assert.deepStrictEqual(normalize(entry, actual), normalize(entry, value), message);
}

function cleanEnv(home, extra = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(AWS_|ML_|MCC_|HF_|NGC_|VLLM_|SGLANG_|HP_|IC_)/.test(k)) continue;
        if (k === 'DEPLOYMENT_TARGET' || k === 'VIRTUAL_ENV') continue;
        env[k] = v;
    }
    return { ...env, HOME: home, VALIDATE_ENV_VARS: 'false', ...extra };
}

function generate(args, dir, home, extraEnv = {}) {
    try {
        execFileSync(process.execPath, [CLI, ...args, '--skip-prompts', '--offline', `--project-dir=${dir}`], {
            cwd: path.dirname(dir), env: cleanEnv(home, extraEnv), stdio: 'pipe', timeout: 90000
        });
    } catch (err) {
        throw new Error(`generation failed (${args.join(' ')}):\n${err.stdout}\n${err.stderr}`);
    }
    return JSON.parse(fs.readFileSync(path.join(dir, '.mlcc-generation-params.json'), 'utf8')).answers;
}

function runExport(dir, home, args = []) {
    return execFileSync('/bin/bash', [path.join(dir, 'do', 'export'), ...args], {
        cwd: dir, env: cleanEnv(home), encoding: 'utf8', timeout: 30000
    });
}

function shellSplit(command) {
    const out = execFileSync('python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.stdin.read())))'], {
        input: command, encoding: 'utf8'
    });
    return JSON.parse(out);
}

/** Build the original generation argv (+ env for boolean false) from the fixture. */
function originalArgs(target) {
    const args = [];
    const env = {};
    const expected = {};
    for (const entry of EXPORT_MAP) {
        if (!applies(entry, target) || !FIXTURE[entry.key]) continue;
        const value = FIXTURE[entry.key](target);
        if (value === undefined) continue;
        expected[entry.key] = value;
        if (entry.shape === 'env-map') {
            for (const [k, v] of Object.entries(value)) args.push(`${entry.cliFlag}=${k}=${v}`);
        } else if (entry.type === 'boolean') {
            if (value) args.push(entry.cliFlag);
            else env[entry.envVar] = 'false';
        } else {
            args.push(`${entry.cliFlag}=${value}`);
        }
    }
    return { args, env, expected };
}

/** Parse an exported CLI command into { key: value } using the schema flags. */
function parseCli(command) {
    const tokens = shellSplit(command);
    const values = {};
    const env = {};
    const byFlag = new Map(EXPORT_MAP.map((e) => [e.cliFlag, e]));
    const byEnv = new Map(EXPORT_MAP.filter((e) => e.envVar).map((e) => [e.envVar, e]));
    let i = 0;
    while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) {
        const [name, val] = [tokens[i].slice(0, tokens[i].indexOf('=')), tokens[i].slice(tokens[i].indexOf('=') + 1)];
        env[name] = val;
        const entry = byEnv.get(name);
        assert.ok(entry, `env assignment ${name} is not a schema envVar`);
        values[entry.key] = normalize(entry, val);
        i++;
    }
    assert.strictEqual(tokens[i], 'ml-container-creator', `unexpected command head: ${tokens[i]}`);
    const argv = [];
    for (const tok of tokens.slice(i + 1)) {
        if (tok === '--skip-prompts') continue;
        argv.push(tok);
        const eq = tok.indexOf('=');
        const flag = eq === -1 ? tok : tok.slice(0, eq);
        const entry = byFlag.get(flag);
        assert.ok(entry, `exported flag ${flag} is not a schema cliFlag`);
        const raw = eq === -1 ? true : tok.slice(eq + 1);
        if (entry.shape === 'env-map') {
            const kv = String(raw);
            values[entry.key] = { ...(values[entry.key] || {}), [kv.slice(0, kv.indexOf('='))]: kv.slice(kv.indexOf('=') + 1) };
        } else {
            values[entry.key] = normalize(entry, raw);
        }
    }
    return { values, env, argv };
}

describe('Wave 8 R8 — do/export round-trip per deployment target', function () {
    this.timeout(240000);
    let work;
    let home;
    before(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-w8-roundtrip-'));
        home = path.join(work, 'home');
        fs.mkdirSync(home);
    });
    after(() => {
        if (work) fs.rmSync(work, { recursive: true, force: true });
    });

    it('derives a non-empty target list from targets.d', () => {
        assert.ok(listTargets().length >= 2);
    });

    for (const target of listTargets()) {
        describe(target, () => {
            let original;
            let expected;
            let exported;
            let cliCommand;
            const dirs = {};

            before(() => {
                dirs.a = path.join(work, `${target}-a`);
                dirs.b = path.join(work, `${target}-b`);
                dirs.c = path.join(work, `${target}-c`);
                const plan = originalArgs(target);
                expected = plan.expected;
                original = generate(plan.args, dirs.a, home, plan.env);
                exported = JSON.parse(runExport(dirs.a, home, ['--json']));
                const out = runExport(dirs.a, home);
                cliCommand = out.split('\n').find((l) => l.includes('ml-container-creator') && !l.startsWith('#'));
            });

            it('every applicable do/config parameter is exercised or explicitly excluded', () => {
                for (const entry of EXPORT_MAP) {
                    if (!applies(entry, target)) continue;
                    assert.ok(FIXTURE[entry.key] || NOT_EXERCISED[entry.key],
                        `${entry.key} (${entry.doConfigVar}) applies to ${target}: add a FIXTURE value or a NOT_EXERCISED reason`);
                }
            });

            it('the original answers carry the non-default fixture values', () => {
                for (const [key, value] of Object.entries(expected)) {
                    const entry = EXPORT_MAP.find((e) => e.key === key);
                    assertCarries(entry, original[answerKey(entry)], value, `${key}: generation did not record the fixture value`);
                }
            });

            it('do/export --json emits schema keys with typed values for every fixture parameter', () => {
                const schemaKeys = new Set(EXPORT_MAP.map((e) => e.key));
                for (const key of Object.keys(exported)) assert.ok(schemaKeys.has(key), `non-schema key ${key}`);
                for (const [key, value] of Object.entries(expected)) {
                    if (key === 'deploymentTarget' && value === 'realtime-inference') continue; // the schema default
                    const entry = EXPORT_MAP.find((e) => e.key === key);
                    assert.ok(key in exported, `${key} missing from do/export --json`);
                    assertCarries(entry, exported[key], value, `${key} exported as ${JSON.stringify(exported[key])}`);
                    if (entry.type === 'integer' || entry.type === 'number') assert.strictEqual(typeof exported[key], 'number');
                }
            });

            it('--config round-trip reproduces the answers (R8.1)', () => {
                const cfg = path.join(work, `${target}.json`);
                fs.writeFileSync(cfg, JSON.stringify(exported));
                const again = generate([`--config=${cfg}`], dirs.b, home);
                for (const entry of EXPORT_MAP) {
                    if (!applies(entry, target) || entry.sensitive) continue;
                    const k = answerKey(entry);
                    assert.deepStrictEqual(normalize(entry, again[k]), normalize(entry, original[k]),
                        `${entry.key}: ${JSON.stringify(original[k])} -> ${JSON.stringify(again[k])}`);
                }
            });

            it('the CLI command carries the same values and regenerates the same answers (R8.2)', () => {
                assert.ok(cliCommand, 'no command line in do/export output');
                const parsed = parseCli(cliCommand);
                const fromJson = {};
                for (const [key, value] of Object.entries(exported)) {
                    fromJson[key] = normalize(EXPORT_MAP.find((e) => e.key === key), value);
                }
                assert.deepStrictEqual(parsed.values, fromJson);
                const again = generate(parsed.argv, dirs.c, home, parsed.env);
                for (const entry of EXPORT_MAP) {
                    if (!applies(entry, target) || entry.sensitive) continue;
                    const k = answerKey(entry);
                    assert.deepStrictEqual(normalize(entry, again[k]), normalize(entry, original[k]), `${entry.key} via CLI`);
                }
            });

            it('exports do/config edits made after generation (runtime, not generate-time)', () => {
                const cfgPath = path.join(dirs.a, 'do', 'config');
                const before = fs.readFileSync(cfgPath, 'utf8');
                assert.ok(before.includes('export PROJECT_NAME='), 'PROJECT_NAME line missing');
                fs.writeFileSync(cfgPath, before.replace(/^export PROJECT_NAME=.*$/m, 'export PROJECT_NAME="edited-after-gen"'));
                try {
                    assert.strictEqual(JSON.parse(runExport(dirs.a, home, ['--json'])).projectName, 'edited-after-gen');
                } finally {
                    fs.writeFileSync(cfgPath, before);
                }
            });
        });
    }
});
