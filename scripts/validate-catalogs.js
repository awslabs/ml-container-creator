#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * validate-catalogs.js — Fast catalog data validation for pre-commit / CI.
 *
 * Catches the class of catalog-data defects that have repeatedly slipped
 * through to CI (invalid costTier enums, stray fields, missing snake_case
 * fields, malformed model-server entries) by validating the catalog data
 * files against their contracts BEFORE the heavier test suites run.
 *
 * Covers:
 *   - servers/lib/catalogs/model-servers.json  → enriched image-catalog schema
 *   - servers/lib/catalogs/instances.json      → enriched instances schema
 *     (both via the existing validate-servers.js harness)
 *   - servers/lib/catalogs/models.json         → the field contract enforced
 *     by the model-picker tests (snake_case required fields + enums)
 *
 * Exit code 0 = all valid; 1 = one or more problems (details printed).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const errors = [];

// ── 1. model-servers.json + instances.json via validate-servers.js ───────────
// Reuse the authoritative harness rather than duplicating its schema wiring.
try {
    execFileSync(process.execPath, [resolve(__dirname, 'validate-servers.js')], {
        cwd: ROOT,
        stdio: 'pipe',
        encoding: 'utf8'
    });
    console.log('✓ model-servers.json / instances.json: valid (via validate-servers.js)');
} catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    // Surface only the catalog-relevant failure lines.
    const relevant = out.split('\n').filter(l => /catalog|schema|❌/i.test(l));
    errors.push('validate-servers.js reported catalog problems:');
    for (const l of (relevant.length ? relevant : out.split('\n')).slice(0, 40)) {
        if (l.trim()) errors.push(`   ${l.trim()}`);
    }
}

// ── 2. models.json field contract (mirrors model-picker tests) ───────────────
const VALID_VALIDATION_LEVELS = ['tested', 'community-validated', 'experimental', 'untested'];

function validateModelsCatalog() {
    const p = resolve(ROOT, 'servers/lib/catalogs/models.json');
    let raw;
    try {
        raw = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
        errors.push(`models.json: not valid JSON: ${e.message}`);
        return;
    }
    const catalog = raw.models || raw;
    const entries = Object.entries(catalog);
    if (entries.length === 0) {
        errors.push('models.json: catalog is empty');
        return;
    }

    let bad = 0;
    for (const [modelId, entry] of entries) {
        const problems = [];
        if (typeof entry.family !== 'string' || entry.family.length === 0) {
            problems.push('family must be a non-empty string');
        }
        if (!(entry.chat_template === null || typeof entry.chat_template === 'string')) {
            problems.push('chat_template must be a string or null (snake_case required)');
        }
        if (typeof entry.gated !== 'boolean') {
            problems.push('gated must be a boolean');
        }
        if (!Array.isArray(entry.tags)) {
            problems.push('tags must be an array');
        }
        if (!(entry.architecture === null || typeof entry.architecture === 'string')) {
            problems.push('architecture must be a string or null');
        }
        if (typeof entry.framework_compatibility !== 'object'
            || entry.framework_compatibility === null
            || Array.isArray(entry.framework_compatibility)) {
            problems.push('framework_compatibility must be a non-null object (snake_case required)');
        }
        if (!VALID_VALIDATION_LEVELS.includes(entry.validation_level)) {
            problems.push(`validation_level must be one of ${VALID_VALIDATION_LEVELS.join(', ')} (snake_case required)`);
        }
        if (problems.length) {
            bad++;
            errors.push(`models.json entry "${modelId}":`);
            for (const pr of problems) errors.push(`   - ${pr}`);
        }
    }
    if (bad === 0) {
        console.log(`✓ models.json: ${entries.length} entries valid (field contract)`);
    }
}

validateModelsCatalog();

// ── Report ────────────────────────────────────────────────────────────────────
if (errors.length) {
    console.error('\n❌ Catalog validation failed:');
    for (const e of errors) console.error(e.startsWith(' ') || e.startsWith('   ') ? e : `   ${e}`);
    console.error('\n   Fix the catalog data above, then re-stage and commit.');
    process.exit(1);
}

console.log('\n✅ All catalog data files valid');
