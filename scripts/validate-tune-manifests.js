#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * validate-tune-manifests.js — CI validation for per-technique tune descriptors (BL129).
 *
 * Discovers every tune descriptor at templates/code/tune.d/<technique>/manifest.json and
 * validates each against templates/code/tune.d/manifest.schema.json using the repo's
 * ajv-based validator. Fails CI (exit 1) if:
 *   - the schema itself is missing or invalid,
 *   - any manifest fails schema validation,
 *   - a manifest's `technique` field does not match its directory name (governance),
 *   - a manifest exists but is not validated (guarded by discovery — every
 *     tune.d/<technique>/manifest.json found is validated).
 *
 * Mirrors scripts/validate-serve-manifests.js (ADR-004 / BL105 precedent).
 *
 * Exit code 0 = all manifests valid; 1 = one or more problems (details printed).
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TUNE_D = resolve(ROOT, 'templates', 'code', 'tune.d');
const SCHEMA_PATH = resolve(TUNE_D, 'manifest.schema.json');

const errors = [];

function loadJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

// ── Load schema ────────────────────────────────────────────────────────────────
let schema;
if (!existsSync(SCHEMA_PATH)) {
    console.error(`❌ Manifest schema not found at ${SCHEMA_PATH}`);
    process.exit(1);
}
try {
    schema = loadJson(SCHEMA_PATH);
} catch (e) {
    console.error(`❌ Manifest schema is not valid JSON: ${e.message}`);
    process.exit(1);
}

// ajv 8 supports draft 2020-12 out of the box.
const ajv = new Ajv({ allErrors: true, strict: false });
let validate;
try {
    validate = ajv.compile(schema);
} catch (e) {
    console.error(`❌ Manifest schema failed to compile: ${e.message}`);
    process.exit(1);
}

// ── Discover manifests ───────────────────────────────────────────────────────
if (!existsSync(TUNE_D)) {
    console.error(`❌ tune.d directory not found at ${TUNE_D}`);
    process.exit(1);
}

const techniqueDirs = readdirSync(TUNE_D, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

const manifests = [];
for (const technique of techniqueDirs) {
    const manifestPath = join(TUNE_D, technique, 'manifest.json');
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
        manifests.push({ technique, path: manifestPath });
    }
}

if (manifests.length === 0) {
    console.error('❌ No tune descriptors found under templates/code/tune.d/*/manifest.json');
    process.exit(1);
}

// ── Validate each manifest ───────────────────────────────────────────────────
let validated = 0;
for (const { technique, path } of manifests) {
    let data;
    try {
        data = loadJson(path);
    } catch (e) {
        errors.push(`tune.d/${technique}/manifest.json: not valid JSON: ${e.message}`);
        continue;
    }

    const ok = validate(data);
    validated++;
    if (!ok) {
        errors.push(`tune.d/${technique}/manifest.json failed schema validation:`);
        for (const err of validate.errors || []) {
            const loc = err.instancePath || '(root)';
            errors.push(`   - ${loc} ${err.message}`);
        }
        continue;
    }

    // Governance cross-check: technique field should match the directory name.
    if (data.technique !== technique) {
        errors.push(
            `tune.d/${technique}/manifest.json: "technique" field "${data.technique}" does not match directory name "${technique}"`
        );
        continue;
    }

    console.log(`✓ tune.d/${technique}/manifest.json: valid`);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (errors.length) {
    console.error('\n❌ Tune descriptor validation failed:');
    for (const e of errors) console.error(e.startsWith('   ') ? e : `   ${e}`);
    process.exit(1);
}

console.log(`\n✅ All ${validated} tune descriptor(s) valid against the schema`);
