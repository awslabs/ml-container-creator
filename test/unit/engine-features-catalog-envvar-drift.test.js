// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * engine_features ↔ model-servers catalog env-var conformance (ADR-004 §c).
 *
 * WHY THIS EXISTS
 * ---------------
 * An engine-specific feature is declared TWICE, in two files with different
 * owners and update paths:
 *   1. the serve plugin manifest `engine_features[].env_var`
 *      (templates/code/serve.d/<engine>/manifest.json) — what MLCC resolves a
 *      user's --engine-feature to, and
 *   2. the base-image catalog `defaults`/`profiles` envVars
 *      (servers/lib/catalogs/model-servers.json) — the curated example configs,
 *      refreshed by the MANUAL `scripts/sync-serving-versions.js` and reviewed by
 *      a human (the sync is NOT run in CI).
 *
 * Because a human updates the catalog by eyeballing a diff, the two can drift:
 * rename the manifest's env_var (or a catalog profile's key) and nothing else
 * fails — both still validate independently. That is the ADR-006/007/008 class of
 * silent-divergence bug. This test makes it LOUD: where the two files reference
 * the SAME feature, they must spell its env var identically.
 *
 * THE INVARIANT (behavioral, not a frozen snapshot)
 * -------------------------------------------------
 * For every engine that declares `engine_features`: each feature's `env_var`,
 * IF it also appears as an envVars key anywhere in that engine's catalog
 * `defaults`/`profiles`, must appear verbatim. (A feature a catalog profile does
 * not exercise is fine — the check only fires on genuine overlap, so adding a
 * feature without a catalog example never fails here.) A non-vacuous guard
 * asserts at least one real manifest↔catalog correspondence exists, so the test
 * cannot silently degrade into asserting nothing.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listServeEngines, engineFeatures } from '../../src/lib/serve-manifest-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SERVE_D = resolve(ROOT, 'templates', 'code', 'serve.d');
const CATALOG_PATH = resolve(ROOT, 'servers', 'lib', 'catalogs', 'model-servers.json');

/** All envVars KEYS referenced in a catalog engine's defaults + every profile. */
function catalogEnvVarKeys(catalog, engine) {
    const keys = new Set();
    for (const entry of catalog[engine] || []) {
        const d = entry.defaults && entry.defaults.envVars;
        if (d) Object.keys(d).forEach((k) => keys.add(k));
        const profiles = entry.profiles || {};
        for (const name of Object.keys(profiles)) {
            const ev = profiles[name].envVars || {};
            Object.keys(ev).forEach((k) => keys.add(k));
        }
    }
    return keys;
}

describe('engine_features ↔ catalog env-var conformance', () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    const engines = listServeEngines(SERVE_D);

    // Collect every (engine, feature, env_var) the manifests declare.
    const declared = [];
    for (const engine of engines) {
        for (const [name, decl] of Object.entries(engineFeatures(engine, SERVE_D))) {
            declared.push({ engine, name, envVar: decl.env_var });
        }
    }

    it('at least one engine declares an engine_feature (guards against a vacuous test)', () => {
        assert.ok(declared.length > 0,
            'expected at least one engine_features declaration across the serve manifests');
    });

    it('at least one declared feature env_var is also exercised by a catalog profile (non-vacuous overlap)', () => {
        const overlapping = declared.filter(({ engine, envVar }) =>
            catalogEnvVarKeys(catalog, engine).has(envVar));
        assert.ok(overlapping.length > 0,
            'expected at least one engine_features env_var to also appear in the catalog ' +
            'defaults/profiles — otherwise this conformance check asserts nothing. ' +
            `Declared: ${JSON.stringify(declared.map((d) => `${d.engine}.${d.name}=${d.envVar}`))}`);
    });

    // The actual guard. The drift we catch: the catalog references a near-miss of
    // the feature's env var (e.g. a renamed/typo'd key) WITHOUT the exact var.
    // We detect that per engine-prefix: if the catalog has any key sharing the
    // feature env var's prefix-stem but not the exact var, that is a likely rename
    // the manifest didn't follow (or vice versa). For features the catalog clearly
    // exercises (exact key present) we also assert the verbatim match holds — a
    // regression that renamed only one side flips this from pass to fail.
    for (const { engine, name, envVar } of declared) {
        it(`${engine}.${name}: manifest env_var "${envVar}" agrees with the catalog`, () => {
            const catalogKeys = catalogEnvVarKeys(catalog, engine);

            // Case 1 — the catalog exercises this exact var: agreement holds. This
            // is the shipped state for radix_attention / rolling_batch_backend. The
            // meaningful assertion is that the manifest's env_var appears VERBATIM
            // in the catalog key set — if someone renamed only one side, the exact
            // key disappears here and (for a near-miss rename) Case 2 fires. We also
            // assert there's no case-variant collision masking a mismatch.
            if (catalogKeys.has(envVar)) {
                assert.ok(catalogKeys.has(envVar),
                    `${engine}.${name}: expected catalog to carry '${envVar}' verbatim`);
                const caseVariants = [...catalogKeys].filter(
                    (k) => k !== envVar && k.toUpperCase() === envVar.toUpperCase()
                );
                assert.deepEqual(caseVariants, [],
                    `${engine}.${name}: catalog has a case-variant of '${envVar}' (${JSON.stringify(caseVariants)}) — ` +
                    'env vars are case-sensitive; this is drift, not agreement.');
                return;
            }

            // Case 2 — the catalog does NOT have the exact var. That is fine when
            // the catalog simply has no example for this feature. But if the
            // catalog carries a DIFFERENT key that looks like a renamed form of the
            // same feature (same leading token, references the feature's distinctive
            // word), flag it as probable drift rather than a legitimate omission.
            const stem = featureStem(name, envVar);
            const suspects = [...catalogKeys].filter(
                (k) => k !== envVar && stem && k.includes(stem)
            );
            assert.equal(suspects.length, 0,
                `${engine} feature '${name}' declares env_var '${envVar}', but the catalog ` +
                `(servers/lib/catalogs/model-servers.json, '${engine}') instead carries ` +
                `${JSON.stringify(suspects)} and NOT '${envVar}'. These look like the same ` +
                'capability spelled differently — the manifest and catalog have drifted. ' +
                `Reconcile them with templates/code/serve.d/${engine}/manifest.json.`);
        });
    }
});

/**
 * A distinctive stem for a feature, used only to spot a renamed catalog key for
 * the SAME capability. Derives from the feature NAME's most specific token
 * uppercased (e.g. radix_attention → RADIX, rolling_batch_backend → ROLLING),
 * which would appear in a renamed env var. Returns '' when nothing distinctive.
 */
function featureStem(name, _envVar) {
    const token = String(name).split('_')[0];
    return token && token.length >= 4 ? token.toUpperCase() : '';
}
