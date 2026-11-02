// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL129 Tune Descriptor — conformance + technique-set drift.
 *
 * Feature: v2-w3-01-bl129
 *
 * Covers (behavior, not frozen snapshot — per the tests-that-don't-rot rule):
 *   - Requirement 1.6 / 6.1: every tune.d/<technique>/ ships a schema-valid manifest
 *     (no technique can ship descriptor-less).
 *   - Requirement 1.3: peft → artifact_kind holds for every variant.
 *   - Requirement 1.2: reward_model_style ∈ {rule,model} and present IFF verl-5field.
 *   - Requirement 1.5: the SET of tune.d/* dirs equals KNOWN_TECHNIQUES — derived from
 *     src/lib/managed-techniques.js, NOT a hardcoded literal — so a new known technique
 *     can't ship without a descriptor and a stray dir can't linger.
 *   - Governance: the manifest `technique` field matches its directory name.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import Ajv from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_TECHNIQUES } from '../../src/lib/managed-techniques.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const TUNE_D = resolve(ROOT, 'templates', 'code', 'tune.d');
const SCHEMA_PATH = resolve(TUNE_D, 'manifest.schema.json');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

// Discover every shipped descriptor dir dynamically (derive-dont-hardcode).
const TECHNIQUE_DIRS = readdirSync(TUNE_D, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

function loadManifest(technique) {
    return JSON.parse(readFileSync(resolve(TUNE_D, technique, 'manifest.json'), 'utf8'));
}

describe('Feature: v2-w3-01-bl129 — tune descriptor conformance', () => {

    describe('Requirement 1.5: technique set derives from KNOWN_TECHNIQUES', () => {
        it('the set of tune.d/* dirs equals KNOWN_TECHNIQUES (no orphan, none missing)', () => {
            const dirs = [...TECHNIQUE_DIRS].sort();
            const known = [...KNOWN_TECHNIQUES].sort();
            assert.deepStrictEqual(dirs, known,
                `tune.d/ dirs [${dirs}] must equal KNOWN_TECHNIQUES [${known}] — ` +
                'add a descriptor for a new known technique, or remove a stray dir.');
        });
    });

    describe('Requirement 1.6 / 6.1: every descriptor is schema-valid', () => {
        for (const technique of TECHNIQUE_DIRS) {
            it(`tune.d/${technique}/manifest.json validates against the schema`, () => {
                const data = loadManifest(technique);
                const ok = validate(data);
                assert.ok(ok,
                    `tune.d/${technique}/manifest.json invalid: ${JSON.stringify(validate.errors, null, 2)}`);
            });

            it(`tune.d/${technique}/ technique field matches dir name (governance)`, () => {
                assert.strictEqual(loadManifest(technique).technique, technique);
            });
        }
    });

    describe('Requirement 1.3: peft → artifact_kind holds for every variant', () => {
        for (const technique of TECHNIQUE_DIRS) {
            it(`${technique}: each variant's artifact_kind is derived from peft`, () => {
                const { variants } = loadManifest(technique);
                for (const [name, v] of Object.entries(variants)) {
                    const expected = v.peft === 'lora' ? 'lora_adapter' : 'full_model';
                    assert.strictEqual(v.artifact_kind, expected,
                        `${technique}.${name}: peft=${v.peft} must yield artifact_kind=${expected}`);
                }
            });
        }
    });

    describe('Requirement 1.2: reward_model_style present IFF verl-5field, ∈ {rule,model}', () => {
        for (const technique of TECHNIQUE_DIRS) {
            it(`${technique}: reward_model_style is consistent with the dataset schema`, () => {
                const { variants } = loadManifest(technique);
                for (const [name, v] of Object.entries(variants)) {
                    const dc = v.dataset_contract;
                    if (dc.schema === 'verl-5field') {
                        assert.ok(['rule', 'model'].includes(dc.reward_model_style),
                            `${technique}.${name}: verl-5field must carry reward_model_style ∈ {rule,model}`);
                    } else {
                        assert.ok(!('reward_model_style' in dc),
                            `${technique}.${name}: non-verl-5field must NOT carry reward_model_style`);
                    }
                }
            });
        }
    });

    // BL173 (Wave-3 completion): the synced layer was populated from AWS recipe
    // override-params. Before BL173 the descriptors shipped with EMPTY
    // hyperparameters/_synced, which silently disabled the whole do/tune interactive
    // HP UX (BL128). These guards keep the synced layer present and well-formed so it
    // cannot regress to empty placeholders or to schema-invalid raw AWS types.
    describe('BL173: synced hyperparameter layer is populated + well-formed', () => {
        // A non-empty knob set is REQUIRED for the primary dataset-driven techniques
        // whose SMTJ recipes expose override-params. If a technique legitimately has
        // no synced knobs (its live recipe exposes none), add it here WITH A REASON
        // rather than fabricating knobs (tests-that-don't-rot rule 4).
        const REQUIRE_POPULATED = ['sft', 'dpo', 'rlvr', 'rlaif', 'mtrl'];
        // The schema's allowed knob `type` enum — the sync must normalize AWS's raw
        // types (float→number, array→string, …) to one of these.
        const ALLOWED_TYPES = new Set(['string', 'integer', 'number', 'boolean']);

        for (const technique of TECHNIQUE_DIRS) {
            if (!REQUIRE_POPULATED.includes(technique)) continue;
            it(`${technique}: the lora variant carries a non-empty synced knob set`, () => {
                const { variants } = loadManifest(technique);
                const lora = variants.lora;
                assert.ok(lora, `${technique}: expected a lora variant`);
                const hp = lora.hyperparameters || {};
                assert.ok(Object.keys(hp).length > 0,
                    `${technique}.lora.hyperparameters is EMPTY — run \`npm run sync:models\` ` +
                    'to populate the synced layer (BL173). An empty knob set silently ' +
                    'disables the do/tune interactive HP UX.');
                // _synced provenance must accompany a populated knob set (smtj at least).
                assert.ok(lora._synced && lora._synced.smtj,
                    `${technique}.lora._synced must carry at least an smtj provenance entry`);
            });

            it(`${technique}: every synced knob type is in the schema's allowed enum`, () => {
                const { variants } = loadManifest(technique);
                for (const [vname, v] of Object.entries(variants)) {
                    for (const [kn, ke] of Object.entries(v.hyperparameters || {})) {
                        assert.ok(ALLOWED_TYPES.has(ke.type),
                            `${technique}.${vname}.${kn}.type='${ke.type}' is not an allowed ` +
                            `type ${[...ALLOWED_TYPES].join('|')} — the sync must normalize ` +
                            'AWS raw types (e.g. float to number, array to string).');
                    }
                }
            });
        }
    });
});
