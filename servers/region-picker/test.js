#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the region-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/region-picker/test.js
 */

import assert from 'node:assert';
import { filterRegions, AWS_REGIONS } from './index.js';

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

console.log('\nregion-picker: filterRegions\n');

// --- Static filtering by code substring ---
test('filters by code substring "us-east"', () => {
    const result = filterRegions('us-east', 10);
    const codes = result.choices.awsRegion;
    assert.ok(codes.length > 0, 'should return at least one result');
    for (const code of codes) {
        assert.ok(code.includes('us-east'), `${code} should contain "us-east"`);
    }
});

// --- Static filtering by label substring ---
test('filters by label substring "Europe"', () => {
    const result = filterRegions('Europe', 10);
    const codes = result.choices.awsRegion;
    assert.ok(codes.length > 0, 'should return at least one result');
    const europeRegions = AWS_REGIONS.filter(r => r.labels.some(l => l.toLowerCase().includes('europe')));
    const europeCodes = new Set(europeRegions.map(r => r.code));
    for (const code of codes) {
        assert.ok(europeCodes.has(code), `${code} should be a European region`);
    }
});

// --- Case-insensitive matching ---
test('case-insensitive matching "TOKYO"', () => {
    const result = filterRegions('TOKYO', 10);
    const codes = result.choices.awsRegion;
    assert.strictEqual(codes.length, 1);
    assert.strictEqual(codes[0], 'ap-northeast-1');
});

test('case-insensitive matching "Us-East"', () => {
    const result = filterRegions('Us-East', 10);
    const codes = result.choices.awsRegion;
    assert.ok(codes.length > 0);
    for (const code of codes) {
        assert.ok(code.startsWith('us-east'));
    }
});

// --- Limit enforcement ---
test('limit enforcement: limit=3 returns at most 3 results', () => {
    const result = filterRegions(undefined, 3);
    assert.ok(result.choices.awsRegion.length <= 3, 'should return at most 3 results');
    assert.strictEqual(result.choices.awsRegion.length, 3);
});

test('limit enforcement: limit=1 returns exactly 1 result', () => {
    const result = filterRegions('us', 1);
    assert.strictEqual(result.choices.awsRegion.length, 1);
});

// --- No search term returns all regions up to limit ---
test('no search term returns all regions up to limit', () => {
    const result = filterRegions(undefined, 50);
    assert.strictEqual(result.choices.awsRegion.length, AWS_REGIONS.length);
});

test('no search term with small limit truncates', () => {
    const result = filterRegions(undefined, 5);
    assert.strictEqual(result.choices.awsRegion.length, 5);
});

// --- Empty results for nonsense search term ---
test('nonsense search term returns empty choices', () => {
    const result = filterRegions('zzzznotaregion', 10);
    assert.deepStrictEqual(result.choices.awsRegion, []);
    assert.deepStrictEqual(result.values, {});
});

// --- Response format: values.awsRegion matches first choice ---
test('values.awsRegion matches first choice', () => {
    const result = filterRegions('eu', 10);
    assert.ok(result.choices.awsRegion.length > 0);
    assert.strictEqual(result.values.awsRegion, result.choices.awsRegion[0]);
});

test('values.awsRegion matches first choice with no search', () => {
    const result = filterRegions(undefined, 10);
    assert.strictEqual(result.values.awsRegion, result.choices.awsRegion[0]);
});

// --- All returned codes are valid AWS region codes ---
test('all returned codes are valid AWS region codes', () => {
    const validCodes = new Set(AWS_REGIONS.map(r => r.code));
    const result = filterRegions(undefined, 50);
    for (const code of result.choices.awsRegion) {
        assert.ok(validCodes.has(code), `${code} should be a valid region code`);
    }
});

// --- Colloquial / alias label search ---
test('colloquial search "bay area" matches us-west-1', () => {
    const result = filterRegions('bay area', 10);
    assert.ok(result.choices.awsRegion.includes('us-west-1'), 'bay area should match N. California');
});

test('colloquial search "korea" matches ap-northeast-2', () => {
    const result = filterRegions('korea', 10);
    assert.ok(result.choices.awsRegion.includes('ap-northeast-2'), 'korea should match Seoul');
});

test('colloquial search "latam" matches sa-east-1', () => {
    const result = filterRegions('latam', 10);
    assert.ok(result.choices.awsRegion.includes('sa-east-1'), 'latam should match São Paulo');
});

test('colloquial search "bombay" matches ap-south-1', () => {
    const result = filterRegions('bombay', 10);
    assert.ok(result.choices.awsRegion.includes('ap-south-1'), 'bombay should match Mumbai');
});

test('colloquial search "scandinavia" matches eu-north-1', () => {
    const result = filterRegions('scandinavia', 10);
    assert.ok(result.choices.awsRegion.includes('eu-north-1'), 'scandinavia should match Stockholm');
});

test('colloquial search "down under" matches ap-southeast-2', () => {
    const result = filterRegions('down under', 10);
    assert.ok(result.choices.awsRegion.includes('ap-southeast-2'), 'down under should match Sydney');
});

// --- Smart mode not activated without BEDROCK_SMART=true ---
test('smart mode not activated without BEDROCK_SMART=true', () => {
    // BEDROCK_SMART is not set in this test environment, so filterRegions
    // (which is the static path) should work without any Bedrock calls.
    // If smart mode were incorrectly activated, the import would have
    // attempted a Bedrock call and the static function wouldn't exist.
    assert.strictEqual(process.env.BEDROCK_SMART, undefined);
    const result = filterRegions('us-east', 10);
    assert.ok(result.choices.awsRegion.length > 0, 'static mode should return results');
});

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
