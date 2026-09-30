#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the MCP-server tests and is the SINGLE SOURCE OF TRUTH for which server
 * tests execute in CI. Two kinds of suite exist, both using a self-contained
 * node:assert harness (a local `test()` helper that tallies pass/fail and calls
 * `process.exit(failed > 0 ? 1 : 0)`) rather than mocha — so mocha's `test/**`
 * discovery never picked them up and they were historically orphaned from CI:
 *
 *   1. servers/<name>/test.js            — per-server smoke test
 *   2. servers/<name>/test/*.test.js     — deeper unit suites
 *
 * This runner DISCOVERS both by walking servers/ (no hardcoded file list, so a
 * newly added suite runs automatically and can't silently rot), runs each in its
 * own `node` process, and fails if ANY suite fails. It runs every discovered
 * suite even when one fails, so CI surfaces the COMPLETE failing set in one run.
 *
 * Network-dependent smoke tests (they hit live AWS/HTTP APIs and are
 * non-deterministic offline) are listed in NETWORK_DEPENDENT and SKIPPED by
 * default; run them explicitly with `--include-network`. The meta-guard test
 * (servers/server-tests-wired.test.js — run as part of discovery) asserts every
 * server test file is either discovered here or explicitly listed as network-
 * dependent, so a new-but-unwired suite fails CI instead of going unnoticed.
 *
 * Usage:
 *   node scripts/run-server-tests.js                 # default suites (no network)
 *   node scripts/run-server-tests.js --include-network
 * Exit code: 0 if all run suites pass, 1 if any fails or none are found.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS_DIR = join(ROOT, 'servers');

// Smoke tests that hit live network APIs (AWS/HF) and are not deterministic
// offline. Kept OUT of the default (blocking) set; run with --include-network.
// Paths are relative to the repo root. Keep this list minimal and justified —
// the meta-guard test cross-checks it so it can't drift.
export const NETWORK_DEPENDENT = [
    'servers/model-picker/test.js'
];

/**
 * Discover all server test files: servers/<name>/test.js and
 * servers/<name>/test/*.test.js. Returns repo-root-relative paths, sorted.
 * @returns {string[]}
 */
export function discoverServerTests() {
    const tests = [];
    let serverDirs;
    try {
        serverDirs = readdirSync(SERVERS_DIR, { withFileTypes: true });
    } catch {
        return tests;
    }
    for (const entry of serverDirs) {
        // 0. Cross-cutting meta tests: servers/*.test.js (e.g. the wiring guard)
        if (entry.isFile() && entry.name.endsWith('.test.js')) {
            tests.push(relative(ROOT, join(SERVERS_DIR, entry.name)));
            continue;
        }
        if (!entry.isDirectory()) continue;
        const serverDir = join(SERVERS_DIR, entry.name);

        // 1. Top-level tests directly in servers/<name>/: `test.js` (smoke) and
        //    any `*.test.js` (e.g. servers/lib/model-id-resolver.test.js).
        try {
            for (const f of readdirSync(serverDir)) {
                if (f === 'test.js' || f.endsWith('.test.js')) {
                    const p = join(serverDir, f);
                    if (statSync(p).isFile()) tests.push(relative(ROOT, p));
                }
            }
        } catch { /* unreadable server dir */ }

        // 2. Unit suites: servers/<name>/test/*.test.js
        const testDir = join(serverDir, 'test');
        try {
            if (statSync(testDir).isDirectory()) {
                for (const f of readdirSync(testDir)) {
                    if (f.endsWith('.test.js')) {
                        tests.push(relative(ROOT, join(testDir, f)));
                    }
                }
            }
        } catch { /* no test/ subdir */ }
    }
    return tests.sort();
}

function main() {
    const includeNetwork = process.argv.includes('--include-network');
    const all = discoverServerTests();
    if (all.length === 0) {
        console.error('run-server-tests: no server test files found');
        process.exit(1);
    }

    const network = new Set(NETWORK_DEPENDENT);
    const toRun = all.filter(t => includeNetwork || !network.has(t));
    const skipped = all.filter(t => !includeNetwork && network.has(t));

    const skipNote = skipped.length ? ` (skipping ${skipped.length} network-dependent)` : '';
    console.log(`Running ${toRun.length} server test file(s)${skipNote}…\n`);

    const failures = [];
    for (const rel of toRun) {
        const result = spawnSync(process.execPath, [join(ROOT, rel)], {
            stdio: 'inherit',
            cwd: ROOT
        });
        if (result.status !== 0) failures.push(rel);
    }

    console.log(`\n${'─'.repeat(60)}`);
    for (const s of skipped) console.log(`↷ skipped (network): ${s}`);
    if (failures.length > 0) {
        console.error(`❌ ${failures.length}/${toRun.length} server test file(s) failed:`);
        for (const f of failures) console.error(`   - ${f}`);
        process.exit(1);
    }
    console.log(`✅ all ${toRun.length} server test file(s) passed`);
}

// Run only when invoked directly (not when imported by the meta-guard test).
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
