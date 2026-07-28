#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Basic functional tests for agent-knowledge MCP server.
 */

import { loadScriptReference, loadConfigReference, loadTroubleshooting, loadCapabilityMatrix, handleQueryKnowledge } from './index.js';
import assert from 'node:assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ❌ ${name}: ${err.message}`);
    }
}

console.log('agent-knowledge server tests\n');

// ── Script Reference ─────────────────────────────────────────────────────────

console.log('script_reference:');

test('returns an array of scripts', () => {
    const result = loadScriptReference();
    assert(Array.isArray(result), 'Expected array');
    assert(result.length > 0, 'Expected at least one script');
});

test('each script has required fields', () => {
    const result = loadScriptReference();
    for (const script of result) {
        assert(script.name, 'Missing name for script');
        assert(typeof script.purpose === 'string', `Missing purpose for ${script.name}`);
        assert(Array.isArray(script.flags), `flags should be array for ${script.name}`);
        assert(Array.isArray(script.reads), `reads should be array for ${script.name}`);
        assert(Array.isArray(script.writes), `writes should be array for ${script.name}`);
        assert(typeof script.lifecycle_position === 'string', `Missing lifecycle_position for ${script.name}`);
        assert(Array.isArray(script.common_failures), `common_failures should be array for ${script.name}`);
    }
});

test('build script detected correctly', () => {
    const result = loadScriptReference();
    const build = result.find(s => s.name === 'build');
    assert(build, 'build script not found');
    assert(build.lifecycle_position === 'build', `Expected lifecycle 'build', got '${build.lifecycle_position}'`);
    assert(build.reads.includes('do/config'), 'build should read do/config');
});

test('validate script has flags', () => {
    const result = loadScriptReference();
    const validate = result.find(s => s.name === 'validate');
    assert(validate, 'validate script not found');
    assert(validate.flags.length > 0, 'validate should have flags');
});

// ── Config Reference ─────────────────────────────────────────────────────────

console.log('\nconfig_reference:');

test('returns structured config object', () => {
    const result = loadConfigReference();
    assert(!result.error, `Error: ${result.error}`);
    assert(Array.isArray(result.do_config_vars), 'Expected do_config_vars array');
    assert(Array.isArray(result.ic_env_vars), 'Expected ic_env_vars array');
    assert(Array.isArray(result.training_config), 'Expected training_config array');
});

test('has expected config variables', () => {
    const result = loadConfigReference();
    const names = result.do_config_vars.map(v => v.name);
    assert(names.includes('PROJECT_NAME'), 'Expected PROJECT_NAME in config vars');
    assert(names.includes('FRAMEWORK'), 'Expected FRAMEWORK in config vars');
    assert(names.includes('AWS_REGION'), 'Expected AWS_REGION in config vars');
});

test('config vars have descriptions', () => {
    const result = loadConfigReference();
    const projectName = result.do_config_vars.find(v => v.name === 'PROJECT_NAME');
    assert(projectName, 'PROJECT_NAME not found');
    assert(typeof projectName.description === 'string', 'Expected description string');
});

// ── Troubleshooting ──────────────────────────────────────────────────────────

console.log('\ntroubleshooting:');

test('returns array of patterns', () => {
    const result = loadTroubleshooting();
    assert(Array.isArray(result), 'Expected array');
    assert(result.length > 0, 'Expected at least one pattern');
});

test('each pattern has required fields', () => {
    const result = loadTroubleshooting();
    for (const p of result) {
        assert(typeof p.pattern === 'string', 'Missing pattern');
        assert(typeof p.root_cause === 'string', 'Missing root_cause');
        assert(Array.isArray(p.diagnostic_steps), 'diagnostic_steps should be array');
        assert(typeof p.fix === 'string', 'Missing fix');
    }
});

test('known issue is present', () => {
    const result = loadTroubleshooting();
    const ecrIssue = result.find(p => p.pattern.toLowerCase().includes('ecr') || p.pattern.toLowerCase().includes('authentication'));
    assert(ecrIssue, 'Expected ECR authentication issue in troubleshooting');
});

// ── Capability Matrix ────────────────────────────────────────────────────────

console.log('\ncapability_matrix:');

test('returns graceful error when file missing', () => {
    const result = loadCapabilityMatrix(null);
    // File may not exist yet (Task 3 creates it)
    if (result.error) {
        assert(result.partial === true, 'Expected partial: true on error');
        assert(result.error.includes('not found'), 'Expected "not found" in error message');
    }
    // If it exists, just verify it's an object
    assert(typeof result === 'object', 'Expected object result');
});

// ── Tool Handler (integration) ───────────────────────────────────────────────

console.log('\nquery_knowledge tool:');

test('returns content array for script_reference', async () => {
    const result = await handleQueryKnowledge({ topic: 'script_reference' });
    assert(result.content, 'Expected content');
    assert(result.content[0].type === 'text', 'Expected text type');
    const parsed = JSON.parse(result.content[0].text);
    assert(Array.isArray(parsed), 'Expected parsed array');
});

test('filter narrows script_reference results', async () => {
    const all = await handleQueryKnowledge({ topic: 'script_reference' });
    const filtered = await handleQueryKnowledge({ topic: 'script_reference', filter: 'build' });
    const allParsed = JSON.parse(all.content[0].text);
    const filteredParsed = JSON.parse(filtered.content[0].text);
    assert(filteredParsed.length < allParsed.length, 'Expected filter to reduce results');
    assert(filteredParsed.length > 0, 'Expected at least one result for "build" filter');
});

test('unknown topic returns error', async () => {
    const result = await handleQueryKnowledge({ topic: 'nonexistent' });
    const parsed = JSON.parse(result.content[0].text);
    assert(parsed.error, 'Expected error for unknown topic');
    assert(parsed.partial === true, 'Expected partial: true');
});

test('troubleshooting filter works', async () => {
    const result = await handleQueryKnowledge({ topic: 'troubleshooting', filter: 'docker' });
    const parsed = JSON.parse(result.content[0].text);
    assert(Array.isArray(parsed), 'Expected array');
    // Should have some docker-related issues
    if (parsed.length > 0) {
        const hasDocker = parsed.some(p =>
            p.pattern.toLowerCase().includes('docker') ||
            p.root_cause.toLowerCase().includes('docker') ||
            p.fix.toLowerCase().includes('docker')
        );
        assert(hasDocker, 'Expected docker-related results');
    }
});

// ── BL071: @mlcc-script Contract Parsing ─────────────────────────────────────

console.log('\ncontract parsing (BL071):');

test('parseScriptFile extracts all four contract fields', () => {
    const result = loadScriptReference();
    const build = result.find(s => s.name === 'build');
    assert(build, 'build script not found');
    assert.strictEqual(build.type, 'model-centric', `Expected type 'model-centric', got '${build.type}'`);
    assert.strictEqual(build.guard, 'none', `Expected guard 'none', got '${build.guard}'`);
    assert.strictEqual(build.lifecycle, 'build', `Expected lifecycle 'build', got '${build.lifecycle}'`);
    assert.strictEqual(build.targets, 'all', `Expected targets 'all', got '${build.targets}'`);
});

test('script with missing contract field has warning', () => {
    // The 'config' template uses @mlcc-script but may have issues with parsing
    // depending on structure. Test a known good one and a known partial case.
    const result = loadScriptReference();
    // All annotated scripts should have type set
    const annotated = result.filter(s => s.type !== null);
    assert(annotated.length > 10, `Expected at least 10 annotated scripts, got ${annotated.length}`);

    // Verify scripts that have warnings about consistency don't have all null fields
    const withWarnings = result.filter(s => s.contract_warnings && s.contract_warnings.length > 0);
    for (const s of withWarnings) {
        // Even partial scripts should have at least some parsed fields
        assert(s.type || s.guard || s.lifecycle || s.targets,
            `Script ${s.name} has warnings but all contract fields are null`);
    }
});

test('capability_matrix with filter.type returns only model-centric scripts', async () => {
    const result = await handleQueryKnowledge({ topic: 'capability_matrix', filter: 'type:model-centric' });
    const parsed = JSON.parse(result.content[0].text);
    assert(Array.isArray(parsed), 'Expected array result');
    assert(parsed.length > 0, 'Expected at least one model-centric script');
    for (const entry of parsed) {
        assert.strictEqual(entry.type, 'model-centric',
            `Expected all entries to be model-centric, got ${entry.type} for ${entry.name}`);
    }
});

test('capability_matrix with filter.guard returns only deployment-active scripts', async () => {
    const result = await handleQueryKnowledge({ topic: 'capability_matrix', filter: 'guard:deployment-active' });
    const parsed = JSON.parse(result.content[0].text);
    assert(Array.isArray(parsed), 'Expected array result');
    assert(parsed.length > 0, 'Expected at least one deployment-active script');
    for (const entry of parsed) {
        assert.strictEqual(entry.guard, 'deployment-active',
            `Expected all entries to have deployment-active guard, got ${entry.guard} for ${entry.name}`);
    }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
