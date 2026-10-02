#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * validate-serve-manifests.js — CI validation for serve-layer plugin manifests (BL105).
 *
 * Discovers every serve-engine manifest at templates/code/serve.d/<engine>/manifest.json
 * and validates each against templates/code/serve.d/manifest.schema.json using the
 * repo's ajv-based validator. Fails CI (exit 1) if:
 *   - the schema itself is missing or invalid,
 *   - any manifest fails schema validation (Requirement 3.3),
 *   - a manifest exists but is not validated (guarded by discovery — every
 *     serve.d/<engine>/manifest.json found is validated) (Requirement 3.4).
 *
 * Exit code 0 = all manifests valid; 1 = one or more problems (details printed).
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SERVE_D = resolve(ROOT, 'templates', 'code', 'serve.d');
const SCHEMA_PATH = resolve(SERVE_D, 'manifest.schema.json');

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
if (!existsSync(SERVE_D)) {
    console.error(`❌ serve.d directory not found at ${SERVE_D}`);
    process.exit(1);
}

const engineDirs = readdirSync(SERVE_D, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

const manifests = [];
for (const engine of engineDirs) {
    const manifestPath = join(SERVE_D, engine, 'manifest.json');
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
        manifests.push({ engine, path: manifestPath });
    }
}

if (manifests.length === 0) {
    console.error('❌ No serve-engine manifests found under templates/code/serve.d/*/manifest.json');
    process.exit(1);
}

// ── Validate each manifest ───────────────────────────────────────────────────
let validated = 0;
for (const { engine, path } of manifests) {
    let data;
    try {
        data = loadJson(path);
    } catch (e) {
        errors.push(`serve.d/${engine}/manifest.json: not valid JSON: ${e.message}`);
        continue;
    }

    const ok = validate(data);
    validated++;
    if (!ok) {
        errors.push(`serve.d/${engine}/manifest.json failed schema validation:`);
        for (const err of validate.errors || []) {
            const loc = err.instancePath || '(root)';
            errors.push(`   - ${loc} ${err.message}`);
        }
        continue;
    }

    // Governance cross-check: engine field should match the directory name.
    if (data.engine !== engine) {
        errors.push(
            `serve.d/${engine}/manifest.json: "engine" field "${data.engine}" does not match directory name "${engine}"`
        );
        continue;
    }

    console.log(`✓ serve.d/${engine}/manifest.json: valid`);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (errors.length) {
    console.error('\n❌ Serve manifest validation failed:');
    for (const e of errors) console.error(e.startsWith('   ') ? e : `   ${e}`);
    process.exit(1);
}

console.log(`\n✅ All ${validated} serve-engine manifest(s) valid against the schema`);
