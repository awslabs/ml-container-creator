// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * BL154 Train_Descriptor — schema conformance + drift (Wave 7, R1 / R2 / R8 / R10.4).
 *
 * Covers (behavior, not frozen snapshots):
 *   - R1.1: the SOURCE schema's knob entry IS a $ref to the tune descriptor's
 *     $defs/hyperparameter (a reference, not a hand copy), and resolves when both
 *     schemas are registered with ajv.
 *   - R1.4: the SHIPPED templates/do/training/manifest.schema.json equals what
 *     scripts/codegen-train-schema.js renders (drift test), carries no external $ref,
 *     and compiles standalone.
 *   - R2 (repo rule #4): the plain-Python validator's key constants
 *     (templates/do/lib/python/train_manifest.py) mirror the schemas.
 *   - R8: every shipped do/training/<t>/manifest.json validates, names its directory,
 *     points "$schema" at the shipped copy, declares no `default` that disagrees with
 *     its defaults.yaml, and declares every defaults.yaml key; manifest-backed
 *     techniques no longer ship prompts.json; at least one technique stays
 *     descriptor-less (the R6 reference).
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import Ajv from 'ajv/dist/2020.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTrainSchema, SOURCE_SCHEMA, SHIPPED_SCHEMA } from '../../scripts/codegen-train-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const TUNE_SCHEMA_PATH = resolve(ROOT, 'templates', 'code', 'tune.d', 'manifest.schema.json');
const TRAINING_DIR = resolve(ROOT, 'templates', 'do', 'training');
const VALIDATOR_PY = resolve(ROOT, 'templates', 'do', 'lib', 'python', 'train_manifest.py');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const source = readJson(SOURCE_SCHEMA);
const shipped = readJson(SHIPPED_SCHEMA);
const tune = readJson(TUNE_SCHEMA_PATH);
const EXPECTED_REF = '../templates/code/tune.d/manifest.schema.json#/$defs/hyperparameter';

function collectRefs(node, out = []) {
    if (Array.isArray(node)) {
        node.forEach((n) => collectRefs(n, out));
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (k === '$ref') out.push(v);
            else collectRefs(v, out);
        }
    }
    return out;
}

/** Extract a Python tuple-of-strings constant (NAME = ( "a", "b", ... )) from source. */
function pyTuple(name) {
    const src = readFileSync(VALIDATOR_PY, 'utf8');
    const m = src.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'));
    assert.ok(m, `${name} not found in train_manifest.py`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Minimal flat `key: value  # comment` parser for the shipped defaults.yaml files. */
function parseDefaults(path) {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = line.match(/^([A-Za-z0-9_]+):\s*([^#]*?)\s*(#.*)?$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

const MANIFEST_TECHNIQUES = readdirSync(TRAINING_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(TRAINING_DIR, d.name, 'manifest.json')))
    .map((d) => d.name)
    .sort();
const ALL_TECHNIQUES = readdirSync(TRAINING_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(TRAINING_DIR, d.name, 'train.py')))
    .map((d) => d.name)
    .sort();

describe('Feature: v2-w7-01 (BL154) — train descriptor schema conformance', () => {
    describe('R1.1: source schema references the tune knob contract', () => {
        it('the knob entry is a $ref to tune $defs/hyperparameter (not a copy)', () => {
            const knob = source.properties.hyperparameters.additionalProperties;
            assert.deepStrictEqual(knob, { $ref: EXPECTED_REF });
            assert.ok(tune.$defs.hyperparameter, 'tune schema must define $defs/hyperparameter');
        });

        it('carries no _synced / reward_source / dataset_contract (R1.2)', () => {
            for (const key of ['_synced', 'reward_source', 'dataset_contract']) {
                assert.ok(!(key in source.properties), `source schema must not declare ${key}`);
            }
        });

        it('resolves with ajv when both schemas are registered', () => {
            const ajv = new Ajv({ allErrors: true, strict: false });
            ajv.addSchema(tune);
            const rewritten = JSON.parse(JSON.stringify(source)
                .replace(EXPECTED_REF, `${tune.$id}#/$defs/hyperparameter`));
            const validate = ajv.compile(rewritten);
            const good = { schema_version: 1, technique: 'x', hyperparameters: { a: { type: 'integer', required: false } } };
            assert.ok(validate(good), JSON.stringify(validate.errors));
            const bad = { schema_version: 1, technique: 'x', hyperparameters: { a: { type: 'integer', required: false, choices: [1] } } };
            assert.ok(!validate(bad), 'an unknown knob key must be rejected via the referenced contract');
        });
    });

    describe('R1.4: generated self-contained shipped schema', () => {
        it('equals the codegen output (drift test — run `npm run codegen`)', () => {
            assert.strictEqual(readFileSync(SHIPPED_SCHEMA, 'utf8'), renderTrainSchema(),
                'templates/do/training/manifest.schema.json is stale; run npm run codegen');
        });

        it('is marked GENERATED and has only local $refs', () => {
            assert.match(shipped.$comment, /GENERATED by scripts\/codegen-train-schema\.js/);
            for (const ref of collectRefs(shipped)) {
                assert.ok(ref.startsWith('#'), `shipped schema has an external $ref: ${ref}`);
            }
        });

        it('inlines exactly the tune $defs/hyperparameter', () => {
            assert.deepStrictEqual(shipped.$defs.hyperparameter, tune.$defs.hyperparameter);
        });

        it('compiles standalone', () => {
            const ajv = new Ajv({ allErrors: true, strict: false });
            assert.doesNotThrow(() => ajv.compile(shipped));
        });
    });

    describe('R2 / repo rule #4: Python validator constants mirror the schemas', () => {
        it('KNOB_KEYS == tune $defs/hyperparameter properties', () => {
            assert.deepStrictEqual(pyTuple('KNOB_KEYS').sort(),
                Object.keys(tune.$defs.hyperparameter.properties).sort());
        });
        it('REQUIRED_KNOB_KEYS == tune $defs/hyperparameter required', () => {
            assert.deepStrictEqual(pyTuple('REQUIRED_KNOB_KEYS').sort(),
                [...tune.$defs.hyperparameter.required].sort());
        });
        it('KNOB_TYPES == tune $defs/hyperparameter type enum', () => {
            assert.deepStrictEqual(pyTuple('KNOB_TYPES').sort(),
                [...tune.$defs.hyperparameter.properties.type.enum].sort());
        });
        it('TOP_LEVEL_KEYS == source schema properties; required matches', () => {
            assert.deepStrictEqual(pyTuple('TOP_LEVEL_KEYS').sort(), Object.keys(source.properties).sort());
            assert.deepStrictEqual(pyTuple('REQUIRED_TOP_LEVEL_KEYS').sort(), [...source.required].sort());
        });
    });

    describe('R8: shipped technique manifests', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(shipped);

        it('at least one technique stays descriptor-less (R6 reference)', () => {
            const descriptorless = ALL_TECHNIQUES.filter((t) => !MANIFEST_TECHNIQUES.includes(t));
            assert.ok(descriptorless.length > 0, 'keep a descriptor-less technique (e.g. custom)');
        });

        for (const technique of MANIFEST_TECHNIQUES) {
            const dir = resolve(TRAINING_DIR, technique);
            const manifest = readJson(resolve(dir, 'manifest.json'));

            it(`${technique}: validates against the shipped schema`, () => {
                assert.ok(validate(manifest), JSON.stringify(validate.errors));
            });

            it(`${technique}: technique matches its directory and $schema points at the shipped copy`, () => {
                assert.strictEqual(manifest.technique, technique);
                assert.strictEqual(manifest.$schema, '../manifest.schema.json');
            });

            it(`${technique}: no prompts.json alongside the manifest`, () => {
                assert.ok(!existsSync(resolve(dir, 'prompts.json')),
                    `${technique}/prompts.json is retired once the manifest exists`);
            });

            it(`${technique}: every defaults.yaml key is declared; no default disagrees`, () => {
                const defaultsPath = resolve(dir, 'defaults.yaml');
                if (!existsSync(defaultsPath)) return;
                const defaults = parseDefaults(defaultsPath);
                const hp = manifest.hyperparameters;
                for (const key of Object.keys(defaults)) {
                    assert.ok(key in hp, `${technique}/defaults.yaml key '${key}' is not declared in the manifest`);
                }
                for (const [name, knob] of Object.entries(hp)) {
                    if ('default' in knob && name in defaults) {
                        assert.strictEqual(String(knob.default), defaults[name],
                            `${technique}.${name}: manifest default disagrees with defaults.yaml`);
                    }
                }
            });
        }
    });
});
