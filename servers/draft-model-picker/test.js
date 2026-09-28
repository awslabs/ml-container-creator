#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the draft-model-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/draft-model-picker/test.js
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import fc from 'fast-check';
import Ajv from 'ajv';
import { listDraftModels, getDraftModel, recommendDraft, getDraftFromS3 } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

/**
 * Build an in-memory S3Accessor mock from a map of { key: body }.
 * listKeys returns keys under the URI prefix; getObject returns the body.
 */
function makeMockS3({ keys = {}, throwOnList = false, throwOnGet = false } = {}) {
    return {
        async listKeys(s3Uri) {
            if (throwOnList) throw new Error('boom');
            // Strip s3://bucket/ to get the prefix for filtering.
            const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(s3Uri);
            const prefix = m ? m[2].replace(/\/$/, '') : '';
            return Object.keys(keys).filter(k => !prefix || k.startsWith(prefix));
        },
        async getObject(key) {
            if (throwOnGet) throw new Error('boom');
            // key is "bucket/prefix/config.json" — strip leading bucket segment.
            const rel = key.split('/').slice(1).join('/');
            if (keys[rel] !== undefined) return keys[rel];
            const found = Object.keys(keys).find(k => key.endsWith(k));
            if (found) return keys[found];
            throw new Error('not found');
        }
    };
}

// ── listDraftModels ──────────────────────────────────────────────────────────

console.log('\ndraft-model-picker: listDraftModels\n');

test('returns all 6 catalog entries with no filter', () => {
    const result = listDraftModels();
    assert.strictEqual(result.count, 6);
    assert.strictEqual(result.models.length, 6);
});

test('each entry has hf_id, algorithm, target_model, engine_support', () => {
    const result = listDraftModels();
    for (const m of result.models) {
        assert.ok(m.hf_id, 'should have hf_id');
        assert.ok(m.algorithm, 'should have algorithm');
        assert.ok(m.target_model, 'should have target_model');
        assert.ok(Array.isArray(m.engine_support), 'engine_support should be array');
    }
});

test('filter by target_model returns subset', () => {
    const result = listDraftModels({ targetModel: 'Llama-3.1-8B' });
    assert.ok(result.count >= 1, 'should find at least one 8B draft');
    for (const m of result.models) {
        assert.ok(m.target_model.includes('Llama-3.1-8B'), 'all results should match filter');
    }
});

test('filter by algorithm=eagle3 returns only eagle3 entries', () => {
    const result = listDraftModels({ algorithm: 'eagle3' });
    assert.ok(result.count >= 1, 'should find eagle3 entries');
    for (const m of result.models) {
        assert.strictEqual(m.algorithm, 'eagle3');
    }
});

test('filter that matches nothing returns count=0', () => {
    const result = listDraftModels({ targetModel: 'nonexistent-model-xyz' });
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.models.length, 0);
});

// ── getDraftModel ────────────────────────────────────────────────────────────

console.log('\ndraft-model-picker: getDraftModel\n');

test('returns thoughtworks Eagle3 entry', () => {
    const model = getDraftModel('thoughtworks/Llama-3.1-8B-Instruct-Eagle3');
    assert.ok(model, 'should return a model');
    assert.strictEqual(model.hf_id, 'thoughtworks/Llama-3.1-8B-Instruct-Eagle3');
    assert.strictEqual(model.algorithm, 'eagle3');
    assert.strictEqual(model.target_model, 'meta-llama/Llama-3.1-8B-Instruct');
    assert.ok(model.engine_support.includes('vllm'), 'should support vllm');
    assert.ok(model.engine_support.includes('sglang'), 'should support sglang');
});

test('returns null for unknown hf_id', () => {
    const model = getDraftModel('does-not-exist/fake-draft');
    assert.strictEqual(model, null);
});

// ── recommendDraft ───────────────────────────────────────────────────────────

console.log('\ndraft-model-picker: recommendDraft\n');

test('recommends eagle3 model for Llama-3.1-8B-Instruct', () => {
    const result = recommendDraft('meta-llama/Llama-3.1-8B-Instruct');
    assert.ok(result, 'should return a recommendation');
    assert.strictEqual(result.algorithm, 'eagle3', 'top pick should be eagle3');
    assert.ok(result.hf_id, 'should have hf_id');
    assert.ok(Array.isArray(result.all_options), 'should have all_options');
});

test('all_options includes at least 2 entries for Llama-3.1-8B', () => {
    const result = recommendDraft('Llama-3.1-8B');
    assert.ok(result, 'should return a recommendation');
    assert.ok(result.all_options.length >= 2, 'should list multiple options');
});

test('returns null for unknown target', () => {
    const result = recommendDraft('some-unknown-model-xyz-404');
    assert.strictEqual(result, null);
});

test('partial name match works (Llama-3.3-70B)', () => {
    const result = recommendDraft('Llama-3.3-70B');
    assert.ok(result, 'should match on partial name');
    assert.ok(result.target_model.includes('Llama-3.3-70B'));
});

// ── getDraftFromS3 (BL114) ───────────────────────────────────────────────────

console.log('\ndraft-model-picker: getDraftFromS3 (BL114)\n');

await asyncTest('valid: prefix contains adapter_config.json → valid, has_adapter_config', async () => {
    const s3 = makeMockS3({ keys: { 'drafts/x/adapter_config.json': '{}', 'drafts/x/model.safetensors': 'bin' } });
    const r = await getDraftFromS3('s3://bucket/drafts/x/', { s3Client: s3 });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.has_adapter_config, true);
    assert.strictEqual(r.has_model_config, false);
    assert.strictEqual(r.s3_uri, 's3://bucket/drafts/x/');
    assert.strictEqual(r.error, undefined);
});

await asyncTest('valid: config.json only → valid, target_arch/target_model extracted', async () => {
    const config = JSON.stringify({ architectures: ['LlamaForCausalLM'], _name_or_path: 'meta-llama/Llama-3.1-8B' });
    const s3 = makeMockS3({ keys: { 'drafts/y/config.json': config } });
    const r = await getDraftFromS3('s3://bucket/drafts/y/', { s3Client: s3 });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.has_model_config, true);
    assert.strictEqual(r.has_adapter_config, false);
    assert.strictEqual(r.target_arch, 'LlamaForCausalLM');
    assert.strictEqual(r.target_model, 'meta-llama/Llama-3.1-8B');
});

await asyncTest('invalid: neither config present → valid=false, error=no_config', async () => {
    const s3 = makeMockS3({ keys: { 'drafts/z/README.md': 'hi', 'drafts/z/model.bin': 'bin' } });
    const r = await getDraftFromS3('s3://bucket/drafts/z/', { s3Client: s3 });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'no_config');
});

await asyncTest('unreachable: mock throws on list → valid=false, error=unreachable', async () => {
    const s3 = makeMockS3({ throwOnList: true });
    const r = await getDraftFromS3('s3://bucket/drafts/x/', { s3Client: s3 });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'unreachable');
});

await asyncTest('malformed: "not-an-s3-uri" → valid=false, error=malformed_uri, no S3 call', async () => {
    let called = false;
    const s3 = { async listKeys() { called = true; return []; }, async getObject() { return ''; } };
    const r = await getDraftFromS3('not-an-s3-uri', { s3Client: s3 });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'malformed_uri');
    assert.strictEqual(called, false, 'no S3 call should be attempted for a malformed URI');
});

await asyncTest('malformed: bare "s3://" → valid=false, error=malformed_uri', async () => {
    const r = await getDraftFromS3('s3://', {});
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'malformed_uri');
});

await asyncTest('config.json fetch failure does not invalidate a valid head', async () => {
    const s3 = makeMockS3({ keys: { 'd/config.json': '{}' }, throwOnGet: true });
    const r = await getDraftFromS3('s3://bucket/d/', { s3Client: s3 });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.has_model_config, true);
    assert.strictEqual(r.target_arch, undefined);
});

// ── Schema validation (BL114) ────────────────────────────────────────────────

console.log('\ndraft-model-picker: draft-models.schema.json (BL114)\n');

const SCHEMA = JSON.parse(readFileSync(resolve(__dirname, '../lib/schemas/draft-models.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true });
const validateCatalog = ajv.compile(SCHEMA);

function baseEntry(extra = {}) {
    return {
        algorithm: 'eagle3',
        target_model: 'meta-llama/Llama-3.1-8B-Instruct',
        target_arch: 'LlamaForCausalLM',
        engine_support: ['vllm', 'sglang'],
        ...extra
    };
}

test('schema: real catalog validates against schema', () => {
    const catalog = JSON.parse(readFileSync(resolve(__dirname, '../lib/catalogs/draft-models.json'), 'utf8'));
    assert.strictEqual(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors));
});

test('schema: entry with source=s3 + s3_uri validates (Requirement 3.1, 4.1)', () => {
    const catalog = {
        'acme/draft': baseEntry({ source: 's3', s3_uri: 's3://acme/drafts/eagle3/' })
    };
    assert.strictEqual(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors));
});

test('schema: HF-only entry (no source/s3_uri) still validates (Requirement 5.1)', () => {
    const catalog = { 'org/hf-draft': baseEntry() };
    assert.strictEqual(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors));
});

test('schema: s3_uri not starting with s3:// is rejected', () => {
    const catalog = { 'org/bad': baseEntry({ s3_uri: 'https://not-s3/x' }) };
    assert.strictEqual(validateCatalog(catalog), false);
});

test('schema: invalid source enum value is rejected', () => {
    const catalog = { 'org/bad': baseEntry({ source: 'gcs' }) };
    assert.strictEqual(validateCatalog(catalog), false);
});

// ── Property tests (BL114, ≥100 iterations each) ─────────────────────────────

console.log('\ndraft-model-picker: property tests (BL114)\n');

// Feature: v18-w4-03-bl114, Property 1
await asyncTest('Property 1: validity = (adapter_config OR config) present; valid results carry stable shape', async () => {
    await fc.assert(fc.asyncProperty(
        fc.record({
            hasAdapter: fc.boolean(),
            hasConfig: fc.boolean(),
            noise: fc.array(fc.string({ minLength: 1 }).filter(s => !s.includes('/')), { maxLength: 5 })
        }),
        async ({ hasAdapter, hasConfig, noise }) => {
            const keys = {};
            if (hasAdapter) keys['p/adapter_config.json'] = '{}';
            if (hasConfig) keys['p/config.json'] = JSON.stringify({ architectures: ['LlamaForCausalLM'] });
            for (const n of noise) keys[`p/${n}.bin`] = 'x';
            const s3 = makeMockS3({ keys });
            const uri = 's3://bucket/p/';
            const r = await getDraftFromS3(uri, { s3Client: s3 });
            assert.strictEqual(r.valid, hasAdapter || hasConfig);
            if (r.valid) {
                assert.strictEqual(r.s3_uri, uri);
                assert.strictEqual(r.has_adapter_config, hasAdapter);
                assert.strictEqual(r.has_model_config, hasConfig);
            }
        }
    ), { numRuns: 100 });
});

// Feature: v18-w4-03-bl114, Property 2
await asyncTest('Property 2: schema accepts well-formed S3 entries and rejects malformed s3_uri', async () => {
    await fc.assert(fc.property(
        fc.record({
            source: fc.option(fc.constantFrom('hf', 's3', 'gcs', 'azure'), { nil: undefined }),
            s3_uri: fc.option(
                fc.oneof(
                    fc.constant('s3://bucket/drafts/x/'),
                    fc.constant('s3://b/k'),
                    fc.constant('https://bucket/x'),
                    fc.constant('gs://bucket/x'),
                    fc.string()
                ),
                { nil: undefined }
            )
        }),
        ({ source, s3_uri }) => {
            const entry = baseEntry();
            if (source !== undefined) entry.source = source;
            if (s3_uri !== undefined) entry.s3_uri = s3_uri;
            const ok = validateCatalog({ 'k/e': entry });
            const sourceOk = source === undefined || source === 'hf' || source === 's3';
            const uriOk = s3_uri === undefined || /^s3:\/\//.test(s3_uri);
            const expected = sourceOk && uriOk;
            assert.strictEqual(ok, expected,
                `source=${source} s3_uri=${JSON.stringify(s3_uri)} expected=${expected} got=${ok}`);
        }
    ), { numRuns: 100 });
});

// Feature: v18-w4-03-bl114, Property 3
await asyncTest('Property 3: existing HF-ID-only entries (no source/s3_uri) always validate', async () => {
    await fc.assert(fc.property(
        fc.record({
            algorithm: fc.constantFrom('eagle3', 'eagle2', 'eagle', 'draft-model', 'ngram', 'mtp'),
            target_model: fc.string({ minLength: 1 }),
            target_arch: fc.string({ minLength: 1 }),
            engine_support: fc.array(fc.constantFrom('vllm', 'sglang', 'lmi'), { minLength: 1, maxLength: 3 })
        }),
        (entry) => {
            const ok = validateCatalog({ 'org/hf-draft': entry });
            assert.strictEqual(ok, true, JSON.stringify(validateCatalog.errors));
        }
    ), { numRuns: 100 });
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
