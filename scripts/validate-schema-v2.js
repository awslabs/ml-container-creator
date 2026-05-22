#!/usr/bin/env node
/**
 * validate-schema-v2.js — Validates parameter-schema-v2.json is well-formed
 * and reports coverage against the actual CLI options in bin/cli.js.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'parameter-schema-v2.json'), 'utf8'));
const cliSrc = fs.readFileSync(path.join(ROOT, 'bin', 'cli.js'), 'utf8');

// Extract CLI flags
const cliFlags = [];
const re = /\.addOption\(new Option\('(--[\w-]+)/g;
let m;
while ((m = re.exec(cliSrc)) !== null) cliFlags.push(m[1]);

const REQUIRED_FIELDS = ['type', 'description', 'cliFlag', 'configKey', 'phase', 'group', 'appliesTo', 'deprecated', 'since'];
const VALID_TYPES = ['string', 'integer', 'number', 'boolean', 'enum'];
const VALID_PHASES = ['project', 'model', 'infrastructure', 'features', 'build', 'auth'];
const VALID_GROUPS = ['project', 'model', 'infrastructure', 'inference-component', 'lora', 'benchmark', 'auth', 'build', 'async', 'batch', 'hyperpod', 'endpoint', 'testing'];

const errors = [];
const params = schema.parameters;

// Validate each parameter
for (const [key, param] of Object.entries(params)) {
    const prefix = `parameters.${key}`;

    for (const field of REQUIRED_FIELDS) {
        if (!(field in param)) errors.push(`${prefix}: missing required field '${field}'`);
    }

    if (param.type && !VALID_TYPES.includes(param.type)) {
        errors.push(`${prefix}: invalid type '${param.type}' (valid: ${VALID_TYPES.join(', ')})`);
    }

    if (param.phase && !VALID_PHASES.includes(param.phase)) {
        errors.push(`${prefix}: invalid phase '${param.phase}' (valid: ${VALID_PHASES.join(', ')})`);
    }

    if (param.type === 'enum' && !param.validation?.enum?.length) {
        errors.push(`${prefix}: type is 'enum' but validation.enum is missing or empty`);
    }

    if (param.type === 'integer' || param.type === 'number') {
        if (param.validation && param.validation.min !== undefined && param.validation.max !== undefined) {
            if (param.validation.min > param.validation.max) {
                errors.push(`${prefix}: validation.min (${param.validation.min}) > validation.max (${param.validation.max})`);
            }
        }
    }
}

// Coverage report
const schemaFlags = Object.values(params).map(p => p.cliFlag).filter(Boolean);
const covered = cliFlags.filter(f => schemaFlags.includes(f));
const missing = cliFlags.filter(f => !schemaFlags.includes(f));

console.log(`\n📋 Parameter Schema v2 Validation`);
console.log(`${'─'.repeat(50)}`);
console.log(`   Parameters defined: ${Object.keys(params).length}`);
console.log(`   CLI flags in bin/cli.js: ${cliFlags.length}`);
console.log(`   Covered by schema: ${covered.length}/${cliFlags.length} (${Math.round(covered.length/cliFlags.length*100)}%)`);
console.log(`   Remaining to add: ${missing.length}`);

if (errors.length) {
    console.log(`\n❌ Schema errors (${errors.length}):`);
    errors.forEach(e => console.log(`   • ${e}`));
    process.exit(1);
} else {
    console.log(`\n✅ Schema is well-formed`);
}

if (missing.length) {
    console.log(`\n❌ CLI flags not in schema (${missing.length}):`);
    missing.forEach(f => console.log(`   ${f}`));
    console.log(`\n   Action required: Add entries for these flags to config/parameter-schema-v2.json`);
    console.log(`   Template:`);
    console.log(`   "${camelCase(missing[0])}": {`);
    console.log(`       "type": "string|integer|number|boolean|enum",`);
    console.log(`       "description": "...",`);
    console.log(`       "cliFlag": "${missing[0]}",`);
    console.log(`       "cliArgName": "value",`);
    console.log(`       "envVar": null,`);
    console.log(`       "templateVar": null,`);
    console.log(`       "configKey": "${camelCase(missing[0])}",`);
    console.log(`       "default": null,`);
    console.log(`       "validation": {},`);
    console.log(`       "phase": "project|model|infrastructure|features|build|auth",`);
    console.log(`       "group": "...",`);
    console.log(`       "appliesTo": { "deploymentTargets": ["*"], "architectures": ["*"] },`);
    console.log(`       "widget": null,`);
    console.log(`       "prompt": null,`);
    console.log(`       "deprecated": false,`);
    console.log(`       "since": "0.x.0"`);
    console.log(`   }`);
    process.exit(1);
}

function camelCase(flag) {
    return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
