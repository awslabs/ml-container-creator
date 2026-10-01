// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Serve-manifest ↔ model-servers catalog version-drift conformance (BL129 follow-up)
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/sync-serving-versions.js` keeps the model-servers catalog current
 * (it discovers the latest image tags, updates each entry's
 * labels.framework_version, and prunes old versions). It NEVER touches the
 * serve-layer manifests (templates/code/serve.d/<engine>/manifest.json), where
 * BL129 version-gating lives (`min_version`, `version_features[].since`).
 *
 * That split is a silent-drift hazard (derive-dont-hardcode rule 4): a manifest
 * can declare a gate at a version that no shipped image can ever reach, so the
 * gated capability becomes dead config and no one notices. This test makes that
 * drift LOUD instead of silent.
 *
 * THE INVARIANT (behavioral, not a frozen snapshot)
 * -------------------------------------------------
 * For every engine that has BOTH a serve manifest and catalog entries:
 *   1. `min_version` and every `version_features[].since` are valid semver.
 *   2. Every gate (`min_version`, each `since`) is <= the NEWEST catalog
 *      version for that engine — otherwise the gate references a version no
 *      shipped image reaches, i.e. an unreachable/dead capability gate.
 *
 * This asserts reachability, not specific numbers: a legitimate catalog bump
 * that outpaces the gates still passes; only a manifest gate that points at a
 * future/unreachable version fails. When you add a new gated capability, set
 * its `since` to a version at or below the newest catalog image (or bump the
 * catalog first) and this test confirms it stays reachable.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listServeEngines } from '../../src/lib/serve-manifest-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SERVE_D = resolve(ROOT, 'templates', 'code', 'serve.d');
const CATALOG_PATH = resolve(ROOT, 'servers', 'lib', 'catalogs', 'model-servers.json');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Parse "a.b.c" → [a,b,c] numerically, or null if not a 3-part semver. */
function parseSemver(v) {
    if (typeof v !== 'string' || !SEMVER_RE.test(v.trim())) return null;
    return v.trim().split('.').map(Number);
}

/** Numeric semver compare (NOT lexical — 0.10.0 > 0.8.0). */
function semverCompare(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}

/** Newest (max) catalog framework_version for an engine, or null if none. */
function newestCatalogVersion(catalog, engine) {
    const entries = catalog[engine] || [];
    const versions = entries
        .map(e => e && e.labels && e.labels.framework_version)
        .filter(v => parseSemver(v) !== null);
    if (versions.length === 0) return null;
    return versions.reduce((max, v) => (semverCompare(v, max) > 0 ? v : max));
}

function readManifest(engine) {
    const p = resolve(SERVE_D, engine, 'manifest.json');
    return JSON.parse(readFileSync(p, 'utf8'));
}

describe('serve manifest ↔ catalog version-drift conformance', () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    // Serve engines that map to a catalog key. lmi/djl are DLC families with no
    // model-servers catalog entry; they carry no version gates, so they are
    // naturally excluded by the "has catalog entries" guard below.
    const engines = listServeEngines(SERVE_D);

    it('at least one engine is version-gated (guards against a vacuous test)', () => {
        const gated = engines.filter(e => {
            const m = readManifest(e);
            return m.min_version || (Array.isArray(m.version_features) && m.version_features.length > 0);
        });
        assert.ok(gated.length > 0,
            'expected at least one serve manifest to declare min_version/version_features');
    });

    for (const engine of ['vllm', 'sglang', 'tensorrt-llm', 'lmi']) {
        if (!engines.includes(engine)) continue;

        describe(`engine: ${engine}`, () => {
            const manifest = readManifest(engine);
            const newest = newestCatalogVersion(catalog, engine);
            const gates = [];
            if (manifest.min_version) gates.push(['min_version', manifest.min_version]);
            for (const f of manifest.version_features || []) {
                gates.push(['version_features.since', f && f.since]);
            }

            it('every declared gate is valid semver', () => {
                for (const [label, val] of gates) {
                    assert.ok(parseSemver(val) !== null,
                        `${engine} ${label}="${val}" must be x.y.z semver`);
                }
            });

            // Only meaningful when the engine has catalog entries AND gates.
            if (gates.length > 0) {
                it('has at least one catalog version to compare against', () => {
                    assert.ok(newest !== null,
                        `${engine} declares version gates but has no catalog framework_version — ` +
                        'either the catalog key is missing or sync-serving-versions pruned it');
                });

                it('no gate references a version newer than the newest shipped image (reachability)', () => {
                    if (newest === null) return; // covered by the assertion above
                    for (const [label, val] of gates) {
                        assert.ok(semverCompare(val, newest) <= 0,
                            `${engine} ${label}="${val}" is NEWER than the newest catalog image ` +
                            `(${newest}). That gate is unreachable — no shipped image can satisfy it. ` +
                            'Lower the gate to a shipped version, or bump the catalog first ' +
                            '(sync-serving-versions.js), then update the manifest.');
                    }
                });
            }
        });
    }
});
