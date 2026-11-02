// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Meta-guard (BL194): every node:test file under test/ must be WIRED INTO CI.
 *
 * Files that import 'node:test' register with Node's built-in runner, not
 * mocha's, so the mocha scripts report 0 tests for them and their failures
 * never fail CI. They run only via scripts/run-node-tests.js (npm run
 * test:node, part of test:all / test:ci). This guard independently scans
 * test/ and fails if any node:test file is not discovered by the runner, not
 * excluded from mocha, or if the npm wiring into test:ci is removed.
 *
 * Pattern: servers/server-tests-wired.test.js. This file itself uses
 * node:test, so it is discovered and run by the runner it guards.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNodeTests, NETWORK_DEPENDENT } from '../../scripts/run-node-tests.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR = join(ROOT, 'test');
const require = createRequire(import.meta.url);

/**
 * Independent (of the runner) walk of test/: every JS file of any name whose
 * source contains the quoted module specifier node:test. Deliberately broader
 * than the runner's import regex and filename filter so a miss in one surfaces
 * here (e.g. a node:test suite not named *.test.js would never be discovered).
 */
function walkNodeTestFiles(dir = TEST_DIR) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') found.push(...walkNodeTestFiles(full));
        } else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
            const src = readFileSync(full, 'utf8');
            if (src.includes('\'node:test\'') || src.includes('"node:test"')) {
                found.push(relative(ROOT, full).split(sep).join('/'));
            }
        }
    }
    return found.sort();
}

describe('node:test files are wired into CI (BL194)', () => {
    const onDisk = walkNodeTestFiles();
    const discovered = discoverNodeTests();
    const discoveredSet = new Set(discovered);

    it('finds a non-trivial number of node:test files on disk', () => {
        assert.ok(onDisk.length >= 10, `expected many node:test files, found ${onDisk.length}`);
    });

    it('every node:test file on disk is discovered by run-node-tests.js', () => {
        const missing = onDisk.filter(f => !discoveredSet.has(f));
        assert.deepEqual(missing, [],
            'these files import node:test but are NOT run by scripts/run-node-tests.js and '
            + 'would silently rot. Name them *.test.js under test/, or fix discoverNodeTests():\n   '
            + `${missing.join('\n   ')}`);
    });

    it('mocha ignores every discovered node:test file (no 0-test loads)', () => {
        const mocharc = require(join(ROOT, '.mocharc.cjs'));
        const ignored = new Set(mocharc.ignore);
        const notIgnored = discovered.filter(f => !ignored.has(f));
        assert.deepEqual(notIgnored, [], `mocha would still load:\n   ${notIgnored.join('\n   ')}`);
    });

    it('every NETWORK_DEPENDENT entry exists and is discovered', () => {
        const stale = NETWORK_DEPENDENT.filter(f => !discoveredSet.has(f));
        assert.deepEqual(stale, [], `NETWORK_DEPENDENT entries not discovered:\n   ${stale.join('\n   ')}`);
    });

    it('test:node runs the runner and is part of test:all, which test:ci runs', () => {
        const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        assert.match(scripts['test:node'], /scripts\/run-node-tests\.js/);
        assert.match(scripts['test:all'], /npm run test:node\b/);
        assert.match(scripts['test:ci'], /npm run test:all\b/);
    });
});
