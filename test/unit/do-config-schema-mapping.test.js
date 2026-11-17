// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 8 R7.4 — do/config <-> parameter-schema mapping drift test.
 *
 * The mapping lives in config/parameter-schema-v2.json (`doConfigVar` on each
 * user-input parameter + the top-level `doConfig.derived` reasons). This test runs
 * scripts/audit-do-config.js against templates/do/config and fails when:
 *   - a do/config export is unclassified (a user input lacks a schema mapping),
 *   - two parameters claim the same var,
 *   - the template fills a var from a name other than its parameter's templateVar,
 *   - a templateVar is not the answer key the generator populates,
 *   - the shipped export map (templates/do/lib/python/export_map.json) drifts from
 *     the schema.
 * Runtime-owned classification comes from regenerate's RUNTIME_OWNED_VARS sources
 * (no list here). Synthetic drift cases prove the detector actually fires.
 */
import { describe, it, before } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import { auditRepo, auditDoConfig, DO_CONFIG_TEMPLATE, SCHEMA_PATH } from '../../scripts/audit-do-config.js';
import { renderExportMap, EXPORT_MAP_PATH } from '../../scripts/codegen-export-map.js';
import { RUNTIME_OWNED_VARS } from '../../src/lib/regenerate-command-handler.js';
import { serveEnginePrefixes } from '../../src/lib/serve-manifest-reader.js';
import { parameterMatrix, configKeyAliases } from '../../src/lib/generated/parameter-matrix.js';

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const templateText = fs.readFileSync(DO_CONFIG_TEMPLATE, 'utf8');

function audit(overrides = {}) {
    return auditDoConfig({
        templateText,
        schema,
        runtimeOwned: RUNTIME_OWNED_VARS,
        enginePrefixes: serveEnginePrefixes(),
        parameterMatrix,
        configKeyAliases,
        ...overrides
    });
}

describe('Wave 8 R7.4 — do/config ↔ schema mapping', () => {
    let result;
    before(async () => {
        result = await auditRepo();
    });

    it('classifies every do/config export with no drift errors', () => {
        assert.deepStrictEqual(result.errors, [], result.errors.join('\n'));
    });

    it('covers a non-trivial set of exports in all four classes', () => {
        const classes = new Set(result.rows.map((r) => r.cls));
        for (const cls of ['user-input', 'secret', 'runtime-owned', 'derived']) {
            assert.ok(classes.has(cls), `expected at least one ${cls} var`);
        }
        assert.ok(result.rows.length > 40, `only ${result.rows.length} rows parsed — template parse regressed?`);
    });

    it('every sensitive parameter with a do/config var is classified secret', () => {
        for (const [key, p] of Object.entries(schema.parameters)) {
            if (!p.doConfigVar || !p.sensitive) continue;
            const row = result.rows.find((r) => r.name === p.doConfigVar);
            assert.ok(row, `${key}: ${p.doConfigVar} not found in templates/do/config`);
            assert.strictEqual(row.cls, 'secret', `${p.doConfigVar} must be a secret`);
        }
    });

    it('runtime-owned rows all come from the regenerate sources (no new list)', () => {
        const prefixes = serveEnginePrefixes();
        for (const r of result.rows.filter((x) => x.cls === 'runtime-owned')) {
            assert.ok(RUNTIME_OWNED_VARS.has(r.name) || prefixes.some((p) => r.name.startsWith(p)), r.name);
        }
    });

    it('the shipped export map equals the schema projection (run `npm run codegen`)', () => {
        assert.strictEqual(fs.readFileSync(EXPORT_MAP_PATH, 'utf8'), renderExportMap());
    });

    it('every export-map entry resolves its key through the --config loader', () => {
        const map = JSON.parse(renderExportMap());
        for (const entry of map.parameters) {
            const answerKey = configKeyAliases[entry.key] || entry.key;
            const isEnvMap = entry.shape === 'env-map';
            assert.ok(isEnvMap || parameterMatrix[answerKey], `${entry.key} -> ${answerKey} is not a loader key`);
        }
    });

    describe('detects synthetic drift', () => {
        it('an unmapped user-input export', () => {
            const { errors } = audit({ templateText: `${templateText}\nexport SOME_NEW_KNOB="<%= someNewKnob %>"\n` });
            assert.ok(errors.some((e) => e.includes('SOME_NEW_KNOB') && e.includes('unclassified')), errors.join('\n'));
        });

        it('two parameters claiming the same var', () => {
            const dup = JSON.parse(JSON.stringify(schema));
            dup.parameters.hyperpodNamespace.doConfigVar = 'HP_CLUSTER_NAME';
            const { errors } = audit({ schema: dup });
            assert.ok(errors.some((e) => e.includes('HP_CLUSTER_NAME is claimed by more than one parameter')), errors.join('\n'));
        });

        it('a var filled from a name other than its templateVar (the pre-Wave-8 HP_GPU_COUNT guard)', () => {
            const drifted = templateText.replace(
                /export HP_GPU_COUNT="<%= typeof hpGpuCount[^\n]*/,
                'export HP_GPU_COUNT="<%= typeof HP_GPU_COUNT !== \'undefined\' && HP_GPU_COUNT ? HP_GPU_COUNT : \'1\' %>"'
            );
            assert.notStrictEqual(drifted, templateText, 'fixture replacement did not apply');
            const { errors } = audit({ templateText: drifted });
            assert.ok(errors.some((e) => e.startsWith('HP_GPU_COUNT') && e.includes('\'hpGpuCount\'')), errors.join('\n'));
        });

        it('a templateVar that is not the generator answer key (the pre-Wave-8 asyncMaxConcurrent)', () => {
            const drift = JSON.parse(JSON.stringify(schema));
            drift.parameters.asyncMaxConcurrent.templateVar = 'asyncMaxConcurrent';
            const { errors } = audit({ schema: drift });
            assert.ok(errors.some((e) => e.includes('ASYNC_MAX_CONCURRENT_INVOCATIONS') && e.includes('other than')), errors.join('\n'));
            assert.ok(errors.some((e) => e.includes('\'asyncMaxConcurrent\' is not the generator answer key')), errors.join('\n'));
        });

        it('a stale derived entry', () => {
            const drift = JSON.parse(JSON.stringify(schema));
            drift.doConfig.derived.NO_LONGER_EXPORTED = 'gone';
            const { errors } = audit({ schema: drift });
            assert.ok(errors.some((e) => e.includes('NO_LONGER_EXPORTED')), errors.join('\n'));
        });

        it('an undeclared dynamic export loop', () => {
            const text = `${templateText}\n<% Object.entries(mysteryVars).forEach(([key, value]) => { %>\nexport <%= key %>=<%= value %>\n<% }); %>\n`;
            const { errors } = audit({ templateText: text });
            assert.ok(errors.some((e) => e.includes('\'mysteryVars\'')), errors.join('\n'));
        });
    });
});
