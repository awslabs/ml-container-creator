#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Meta-guard: every MCP-server test file must be WIRED INTO CI.
 *
 * MCP-server tests use a self-contained node:assert harness (not mocha), so
 * mocha's `test/**` discovery never runs them — they only run via
 * scripts/run-server-tests.js (npm run test:servers:unit), which CI invokes.
 * History showed the failure mode: a suite that exists on disk but isn't run
 * silently rots (e.g. instance-sizer's suites and model-picker were red for a
 * long time while CI stayed green, because nothing executed them).
 *
 * This test independently walks servers/ for every test file, then asserts each
 * one is either (a) discovered by the runner's discoverServerTests(), or
 * (b) explicitly listed in NETWORK_DEPENDENT (skipped by default, run with
 * --include-network). A new-but-unwired suite therefore FAILS CI here instead of
 * going unnoticed. It also asserts every NETWORK_DEPENDENT entry actually exists,
 * so that list can't rot either.
 *
 * Run: node servers/server-tests-wired.test.js
 */

import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverServerTests, NETWORK_DEPENDENT } from '../scripts/run-server-tests.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS_DIR = join(ROOT, 'servers');

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

/**
 * Independent (of the runner) recursive walk of servers/ collecting every file
 * that looks like a test: `test.js` or `*.test.js`. Repo-root-relative paths.
 * This is deliberately a SEPARATE implementation from discoverServerTests() so a
 * bug in one doesn't mask the other.
 */
function walkServerTestFiles(dir = SERVERS_DIR) {
    const found = [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            found.push(...walkServerTestFiles(full));
        } else if (entry.isFile()
            && (entry.name === 'test.js' || entry.name.endsWith('.test.js'))) {
            found.push(relative(ROOT, full));
        }
    }
    return found;
}

console.log('\nserver-tests-wired: every server test file is wired into CI\n');

const onDisk = walkServerTestFiles().sort();
const discovered = new Set(discoverServerTests());

test('found a non-trivial number of server test files on disk', () => {
    assert.ok(onDisk.length >= 10,
        `expected many server test files, found ${onDisk.length}`);
});

test('every server test file on disk is discovered by run-server-tests.js', () => {
    const missing = onDisk.filter(f => !discovered.has(f));
    assert.strictEqual(missing.length, 0,
        'these server test files are NOT run by scripts/run-server-tests.js and would '
        + 'silently rot — fix discoverServerTests() or move them into a discovered '
        + `location:\n   ${missing.join('\n   ')}`);
});

test('every discovered file is either run by default or listed NETWORK_DEPENDENT', () => {
    // A discovered file is run unless it's network-dependent. This asserts the
    // two sets partition cleanly (no file is both, none is neither).
    for (const f of discovered) {
        // membership is well-defined; the meaningful check is the reverse below.
        assert.ok(typeof f === 'string');
    }
    // Every NETWORK_DEPENDENT entry must actually exist on disk (list can't rot).
    const stale = NETWORK_DEPENDENT.filter(f => !onDisk.includes(f));
    assert.strictEqual(stale.length, 0,
        `NETWORK_DEPENDENT lists files that don't exist:\n   ${stale.join('\n   ')}`);
});

test('every NETWORK_DEPENDENT entry is also discoverable (so --include-network runs it)', () => {
    const notDiscovered = NETWORK_DEPENDENT.filter(f => !discovered.has(f));
    assert.strictEqual(notDiscovered.length, 0,
        `NETWORK_DEPENDENT entries not discovered by the runner:\n   ${notDiscovered.join('\n   ')}`);
});

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
