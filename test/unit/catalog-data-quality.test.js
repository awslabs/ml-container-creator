// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * BL191 — catalog data-quality guards.
 *
 * Behavioral checks over the shipped (production) catalogs. They assert shapes
 * and cross-catalog agreement, never frozen model ids or counts, so they stay
 * meaningful as the catalogs grow:
 *
 *   1. No production catalog ships a placeholder / example-domain URI
 *      (the BL146 spike found an `s3://acme-models/...` draft head in
 *      draft-models.json).
 *   2. Every tune-catalog entry resolves an HF architecture class, either on the
 *      entry itself (`architecture`) or via models.json[huggingFaceId], or it
 *      carries an explicit `architectureUnavailableReason` (e.g. gated repo).
 *      Values must come from the model's HF config.json `architectures[0]`;
 *      never fill this field from a guess.
 *   3. Where the same model's architecture is recorded in more than one catalog
 *      (tune-catalog, models.json, popular-transformers.json, model-sizes.json),
 *      the copies agree (steering rule 4: duplicates must be drift-checked).
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIB_CATALOGS = path.join(ROOT, 'servers', 'lib', 'catalogs');
const TUNE_CATALOG = path.join(ROOT, 'config', 'tune-catalog.json');
function readJson(p) {
    return JSON.parse(readFileSync(p, 'utf8'));
}
/** Every production catalog file: servers/lib/catalogs, per-server catalogs, the tune catalog. */
function productionCatalogFiles() {
    const files = readdirSync(LIB_CATALOGS)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(LIB_CATALOGS, f));
    const serversDir = path.join(ROOT, 'servers');
    for (const d of readdirSync(serversDir, { withFileTypes: true })) {
        const catDir = path.join(serversDir, d.name, 'catalogs');
        if (d.isDirectory() && d.name !== 'lib' && existsSync(catDir)) {
            for (const f of readdirSync(catDir)) {
                if (f.endsWith('.json')) files.push(path.join(catDir, f));
            }
        }
    }
    files.push(TUNE_CATALOG);
    return files;
}
/** Walk a parsed JSON value, yielding [jsonPath, string] for every string (keys included). */
function* walkStrings(value, at = '$') {
    if (typeof value === 'string') {
        yield [at, value];
    } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) yield* walkStrings(value[i], `${at}[${i}]`);
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            yield [`${at}{key}`, k];
            yield* walkStrings(v, `${at}.${k}`);
        }
    }
}
// Bucket / host tokens that mark a placeholder rather than a real, shipped location.
const PLACEHOLDER_TOKEN = /(^|[-_.])(acme|example|placeholder|changeme|dummy|fake|todo|xxx+|my|your)([-_.]|$)|[<>{}]/i;
// RFC 2606 / RFC 6761 reserved names.
const RESERVED_HOST = /(^|\.)(example\.(com|org|net)|[^.]+\.(example|test|invalid|localhost))$/i;
describe('catalog data quality (BL191)', () => {
    describe('no placeholder URIs in production catalogs', () => {
        const files = productionCatalogFiles();
        it('discovers the production catalogs', () => {
            assert.ok(files.length > 1, 'expected several catalog files');
            assert.ok(files.includes(path.join(LIB_CATALOGS, 'draft-models.json')));
        });
        for (const file of files) {
            const rel = path.relative(ROOT, file);
            it(`${rel}: every s3:// / http(s):// location is real, not a placeholder`, () => {
                const offenders = [];
                for (const [at, s] of walkStrings(readJson(file))) {
                    const m = /^(s3|https?):\/\/([^/?#]*)/i.exec(s.trim());
                    if (!m) continue;
                    const host = m[2];
                    if (host === '' || PLACEHOLDER_TOKEN.test(host) || RESERVED_HOST.test(host)) {
                        offenders.push(`${at} = ${s}`);
                    }
                }
                assert.deepStrictEqual(offenders, [], `placeholder location(s) in ${rel}`);
            });
        }
    });
    describe('tune-catalog architecture coverage', () => {
        const tune = readJson(TUNE_CATALOG).models || {};
        const models = readJson(path.join(LIB_CATALOGS, 'models.json'));
        const ARCH_CLASS = /^[A-Z][A-Za-z0-9_]*$/;
        it('has entries to check', () => {
            assert.ok(Object.keys(tune).length > 0);
        });
        for (const [key, entry] of Object.entries(tune)) {
            it(`${key}: architecture recorded (HF class) or an explicit reason`, () => {
                const own = entry.architecture;
                const reason = entry.architectureUnavailableReason;
                const unified = entry.huggingFaceId ? models[entry.huggingFaceId]?.architecture : undefined;
                if (own !== undefined) {
                    assert.ok(typeof own === 'string' && ARCH_CLASS.test(own),
                        `architecture must be an HF class name, got ${JSON.stringify(own)}`);
                }
                if (reason !== undefined) {
                    assert.ok(typeof reason === 'string' && reason.trim().length > 0,
                        'architectureUnavailableReason must be a non-empty string');
                    assert.strictEqual(own, undefined, 'carry either architecture or a reason, not both');
                }
                const resolved = own || unified;
                if (!resolved) {
                    assert.ok(reason, `no architecture on the entry or in models.json[${entry.huggingFaceId}], ` +
                        'and no architectureUnavailableReason (fill from HF config.json architectures[0])');
                } else {
                    assert.ok(ARCH_CLASS.test(resolved), `resolved architecture ${JSON.stringify(resolved)} is not a class name`);
                }
            });
        }
    });
    describe('architecture copies agree across catalogs', () => {
        const models = readJson(path.join(LIB_CATALOGS, 'models.json'));
        const popular = readJson(path.join(LIB_CATALOGS, 'popular-transformers.json'));
        const sizesRaw = readJson(path.join(LIB_CATALOGS, 'model-sizes.json'));
        const sizes = sizesRaw.models || sizesRaw;
        const tune = readJson(TUNE_CATALOG).models || {};
        function disagreements(pairs) {
            const out = [];
            for (const [id, arch, source] of pairs) {
                const unified = models[id]?.architecture;
                if (arch && unified && arch !== unified) out.push(`${id}: ${source}=${arch} vs models.json=${unified}`);
            }
            return out;
        }
        it('tune-catalog architecture matches models.json', () => {
            const pairs = Object.values(tune).map(e => [e.huggingFaceId, e.architecture, 'tune-catalog']);
            assert.deepStrictEqual(disagreements(pairs), []);
        });
        it('popular-transformers.json architecture matches models.json', () => {
            const pairs = Object.entries(popular).map(([id, e]) => [id, e && e.architecture, 'popular-transformers']);
            assert.deepStrictEqual(disagreements(pairs), []);
        });
        it('model-sizes.json architecture matches models.json (exact id or trailing-glob id)', () => {
            const pairs = Object.entries(sizes).map(([k, e]) => [k.replace(/\*$/, ''), e && e.architecture, 'model-sizes']);
            assert.deepStrictEqual(disagreements(pairs), []);
        });
    });
});
