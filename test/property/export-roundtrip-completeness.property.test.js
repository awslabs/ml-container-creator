// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Export Round-Trip Completeness Property-Based Tests
 *
 * Property 8: Export round-trip completeness
 *
 * For any configuration containing endpoint parameters, iC parameters, model env
 * vars and server env vars, do/export SHALL emit every non-default value in BOTH
 * renderers: --json as the canonical generator --config object (flat schema keys,
 * typed values) and the CLI command as one flag per value.
 *
 * Updated by Wave 8 (BL160, R6): do/export no longer bakes values into itself with
 * EJS (the nested endpointConfig / icConfig / modelEnvVars / serverEnvVars objects
 * this property used to check were the drifted, non --config keys). The property
 * now renders the real templates/do/config for each generated configuration and
 * runs the real do/lib/python/export_config.py over it.
 *
 * Feature: cli-config-parameters, Property 8
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6** (and Wave 8 R6.2-R6.4)
 */
import fc from 'fast-check';
import { describe, it, before, after } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';
import { resolvePrefixedEnvVars } from '../../src/lib/engine-prefix-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const CONFIG_TEMPLATE = fs.readFileSync(join(ROOT, 'templates/do/config'), 'utf8');
const PY_DIR = join(ROOT, 'templates/do/lib/python');
const EXPORT_MAP = JSON.parse(fs.readFileSync(join(PY_DIR, 'export_map.json'), 'utf8')).parameters;
const BY_KEY = Object.fromEntries(EXPORT_MAP.map((e) => [e.key, e]));

// Python driver: one process for all generated configs (keeps the property fast).
const DRIVER = `
import json, shlex, sys
sys.path.insert(0, sys.argv[1])
import export_config as ec
entries = ec.load_map()
out = []
for path in json.load(sys.stdin):
    declared = ec.read_declared(path)
    items = ec.resolve(entries, declared, {}, declared.get("DEPLOYMENT_TARGET") or "realtime-inference")
    cmd, notes = ec.render_cli(items)
    out.append({"json": json.loads(ec.render_json(items)), "argv": shlex.split(cmd)})
print(json.dumps(out))
`;

// ── Arbitrary generators ─────────────────────────────────────────────────────
const arbEndpointConfig = fc.record({
    endpointInitialInstanceCount: fc.oneof(fc.constant(null), fc.integer({ min: 2, max: 100 })),
    endpointDataCapturePercent: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 100 })),
    endpointVariantName: fc.oneof(fc.constant(null), fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,10}$/)),
    endpointVolumeSize: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 16384 }))
});
const arbIcConfig = fc.record({
    icCpuCount: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 768 })),
    icMemorySize: fc.oneof(fc.constant(null), fc.integer({ min: 128, max: 3145728 })),
    icGpuCount: fc.oneof(fc.constant(null), fc.integer({ min: 2, max: 8 })),
    icCopyCount: fc.oneof(fc.constant(null), fc.integer({ min: 2, max: 100 })),
    icModelWeight: fc.oneof(fc.constant(null), fc.double({ min: 0.01, max: 0.99, noNaN: true }))
});
const arbEnvVarKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,15}$/);
const arbEnvVarValue = fc.stringMatching(/^[a-zA-Z0-9._/-]{1,20}$/);
const arbModelEnvVars = fc.dictionary(arbEnvVarKey, arbEnvVarValue, { minKeys: 1, maxKeys: 3 });
const arbServerEnvVars = fc.dictionary(arbEnvVarKey, arbEnvVarValue, { minKeys: 1, maxKeys: 3 });

const arbFullConfig = fc.tuple(arbEndpointConfig, arbIcConfig, arbModelEnvVars, arbServerEnvVars)
    // A model-env key equal to an engine-prefixed server-env var would collide in do/config.
    .filter(([, , m, s]) => Object.keys(m).every((k) => !Object.keys(s).some((x) => `VLLM_${x}` === k)))
    .map(([endpoint, ic, modelEnvVars, serverEnvVars]) => ({
        ...endpoint, ...ic, modelEnvVars: { ...modelEnvVars }, serverEnvVars: { ...serverEnvVars }
    }));

const NUMERIC = ['endpointInitialInstanceCount', 'endpointDataCapturePercent', 'endpointVolumeSize',
    'icCpuCount', 'icMemorySize', 'icGpuCount', 'icCopyCount', 'icModelWeight'];

function templateVars(config) {
    const prefixed = resolvePrefixedEnvVars('vllm', config.serverEnvVars);
    const serverEnvKeyMap = {};
    for (const k of Object.keys(config.serverEnvVars)) {
        serverEnvKeyMap[k] = Object.keys(resolvePrefixedEnvVars('vllm', { [k]: '' }))[0];
    }
    const orderedEnvVars = [
        ...Object.entries(config.modelEnvVars).map(([key, value]) => ({ key, value })),
        ...Object.entries(prefixed).map(([key, value]) => ({ key, value }))
    ];
    return {
        projectName: 'test-project', deploymentConfig: 'transformers-vllm', framework: 'transformers',
        modelServer: 'vllm', modelName: 'meta-llama/Llama-2-7b', buildTarget: 'codebuild',
        codebuildComputeType: 'BUILD_GENERAL1_LARGE', deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge', awsRegion: 'us-east-1', inferenceAmiVersion: null,
        hfToken: null, ngcApiKey: null, modelFormat: null, baseImage: '', enableLora: true,
        includeBenchmark: false, orderedEnvVars, icEnvVars: {},
        ...config,
        serverEnvVars: prefixed,
        serverEnvKeyMap
    };
}

describe('Feature: cli-config-parameters, Property 8: Export round-trip completeness', function () {
    this.timeout(PROPERTY_CONFIG.timeout * 4);
    let cases;
    let work;
    before(() => {
        work = fs.mkdtempSync(join(os.tmpdir(), 'mlcc-export-prop-'));
        const configs = fc.sample(arbFullConfig, { numRuns: PROPERTY_CONFIG.numRuns, seed: 8 });
        const paths = configs.map((config, i) => {
            const p = join(work, `config-${i}`);
            fs.writeFileSync(p, ejs.render(CONFIG_TEMPLATE, templateVars(config)));
            return p;
        });
        const results = JSON.parse(execFileSync('python3', ['-c', DRIVER, PY_DIR], {
            input: JSON.stringify(paths), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
        }));
        cases = configs.map((config, i) => ({ config, ...results[i] }));
    });
    after(() => {
        if (work) fs.rmSync(work, { recursive: true, force: true });
    });

    it('every non-default endpoint / IC value is in --json under its flat schema key, typed', () => {
        for (const { config, json } of cases) {
            for (const key of NUMERIC) {
                const value = config[key];
                const isDefault = value === null || value === BY_KEY[key].default;
                if (isDefault) {
                    assert.ok(!(key in json), `${key} is default/unset and must not be exported`);
                } else {
                    assert.strictEqual(json[key], value, `${key}: ${json[key]} !== ${value}`);
                }
            }
            if (config.endpointVariantName === null) assert.ok(!('endpointVariantName' in json));
            else assert.strictEqual(json.endpointVariantName, config.endpointVariantName);
        }
    });

    it('model-env and server-env maps round-trip with their original (unprefixed) keys', () => {
        for (const { config, json } of cases) {
            assert.deepStrictEqual(json.modelEnv, config.modelEnvVars);
            assert.deepStrictEqual(json.serverEnv, config.serverEnvVars);
        }
    });

    it('the CLI renderer carries the same values, one schema flag each', () => {
        for (const { json, argv } of cases) {
            assert.strictEqual(argv[0], 'ml-container-creator');
            for (const [key, value] of Object.entries(json)) {
                const entry = BY_KEY[key];
                if (entry.shape === 'env-map') {
                    for (const [k, v] of Object.entries(value)) {
                        assert.ok(argv.includes(`${entry.cliFlag}=${k}=${v}`), `${entry.cliFlag}=${k}=${v}`);
                    }
                } else if (entry.type === 'boolean') {
                    assert.ok(value ? argv.includes(entry.cliFlag) : !argv.includes(entry.cliFlag), key);
                } else {
                    assert.ok(argv.includes(`${entry.cliFlag}=${value}`), `${entry.cliFlag}=${value}`);
                }
            }
        }
    });

    it('--json uses only schema parameter keys (no nested legacy objects)', () => {
        for (const { json } of cases) {
            for (const key of Object.keys(json)) assert.ok(BY_KEY[key], `non-schema key ${key}`);
            for (const legacy of ['endpointConfig', 'icConfig', 'modelEnvVars', 'serverEnvVars', 'awsRegion']) {
                assert.ok(!(legacy in json), `legacy key ${legacy}`);
            }
        }
    });
});
