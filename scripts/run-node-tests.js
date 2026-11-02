#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs every test file under test/ that is written against Node's built-in
 * test runner (`import { describe, it } from 'node:test'`) and is the SINGLE
 * SOURCE OF TRUTH for which node:test suites execute in CI (BL194).
 *
 * Why this exists: the mocha scripts (`npm test`, `test:property`) glob
 * test/**, so mocha loads node:test files too, but node:test suites register
 * with Node's own runner, not mocha's. Mocha reports "0 passing" for them, and
 * a node:test failure never changes mocha's exit code (under --parallel the
 * suites don't even execute). Several real regressions slipped through CI that
 * way. This runner DISCOVERS the files by walking test/ and reading each
 * `*.test.js` source for a node:test import (no hardcoded list, so a new suite
 * runs automatically), then hands them all to `node --test`.
 *
 * The same discovery feeds .mocharc.cjs `ignore`, so mocha never loads these
 * files (no 0-test noise, no double execution). The meta-guard
 * test/unit/node-tests-wired.test.js independently scans test/ and fails if
 * any node:test file is not discovered here or not excluded from mocha.
 *
 * Environment mirrors the mocha suites: test/setup-env.js is preloaded via
 * --import (secret-discovery guard), and the 8 GB heap the property suite
 * needs is applied to every child process through NODE_OPTIONS.
 *
 * Network-dependent suites (live AWS/HTTP, non-deterministic offline) go in
 * NETWORK_DEPENDENT and are SKIPPED by default; run with --include-network.
 *
 * Usage:
 *   node scripts/run-node-tests.js                  # default set (no network)
 *   node scripts/run-node-tests.js --include-network
 *   node scripts/run-node-tests.js --list           # print discovered files
 * Exit code: 0 if all run suites pass, 1 if any fails or none are found.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

// Per-test timeout handed to `node --test`. Generous on purpose: the slowest
// node:test property suite takes ~20 s locally; mocha's property suite uses 60 s.
export const TEST_TIMEOUT_MS = 120000;

// Heap size the property suite needs (mirrors `test:property` in package.json).
const HEAP_FLAG = '--max-old-space-size=8192';

// node:test files that hit live network APIs. Repo-root-relative, POSIX paths.
// Keep minimal and justified; the meta-guard checks every entry exists.
export const NETWORK_DEPENDENT = [
    // Wave 11 (R13.2): live `aws s3 cp` of the catalog's HP-EKS payload templates.
    'test/unit/hp-payload-live-drift.test.js'
];

// Matches a static import, dynamic import, or require of 'node:test'.
const NODE_TEST_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]node:test['"]/m;

/**
 * True if the given source text imports Node's built-in test runner.
 * @param {string} source
 * @returns {boolean}
 */
export function importsNodeTest(source) {
    return NODE_TEST_IMPORT_RE.test(source);
}

function toPosix(p) {
    return p.split(sep).join('/');
}

/**
 * Discover node:test files: every `*.test.js` under test/ whose source imports
 * node:test. Returns repo-root-relative POSIX paths, sorted.
 * @returns {string[]}
 */
export function discoverNodeTests(dir = TEST_DIR) {
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
            found.push(...discoverNodeTests(full));
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
            if (importsNodeTest(readFileSync(full, 'utf8'))) {
                found.push(toPosix(relative(ROOT, full)));
            }
        }
    }
    return found.sort();
}

function main() {
    const args = process.argv.slice(2);
    const includeNetwork = args.includes('--include-network');
    const all = discoverNodeTests();

    if (args.includes('--list')) {
        for (const f of all) console.log(f);
        return;
    }
    if (all.length === 0) {
        console.error('run-node-tests: no node:test files found under test/');
        process.exit(1);
    }

    const network = new Set(NETWORK_DEPENDENT);
    const toRun = all.filter(t => includeNetwork || !network.has(t));
    const skipped = all.filter(t => !includeNetwork && network.has(t));

    const skipNote = skipped.length ? ` (skipping ${skipped.length} network-dependent)` : '';
    console.log(`Running ${toRun.length} node:test file(s)${skipNote}…\n`);

    const nodeOptions = [process.env.NODE_OPTIONS, HEAP_FLAG].filter(Boolean).join(' ');
    const result = spawnSync(process.execPath, [
        '--import', './test/setup-env.js',
        '--test',
        `--test-timeout=${TEST_TIMEOUT_MS}`,
        ...toRun
    ], {
        stdio: 'inherit',
        cwd: ROOT,
        env: { ...process.env, NODE_OPTIONS: nodeOptions }
    });

    for (const s of skipped) console.log(`↷ skipped (network): ${s}`);
    if (result.status !== 0) {
        console.error(`\n❌ node:test run failed (exit ${result.status === null ? result.signal : result.status})`);
        process.exit(1);
    }
    console.log(`\n✅ all ${toRun.length} node:test file(s) passed`);
}

// Run only when invoked directly (not when imported by .mocharc.cjs or the meta-guard).
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
