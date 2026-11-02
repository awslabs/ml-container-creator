// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Published-package CONTENTS guard.
 *
 * package.json "files" is a whitelist: anything the CLI loads at runtime that is
 * not listed is silently dropped from the npm tarball, and the CLI then fails
 * with ENOENT only on a global install (a repo checkout still has the file).
 * That is exactly how `bootstrap add` shipped broken — infra/bootstrap-modules/
 * was never whitelisted, so module-manifest.json was missing.
 *
 * Nothing here is a hand-maintained list. The test derives what MUST ship from:
 *   1. every `infra/...` path literal referenced by src/ and bin/ (runtime loads), and
 *   2. the CDK app sources the bootstrap runner compiles at deploy time
 *      (every *.ts, *.cjs, buckets.json under infra/bootstrap-modules, minus
 *      tests and build output), plus the files `npm install` / `tsc` / `cdk` need.
 * and checks them against `npm pack --dry-run --json`. It also asserts that the
 * account-specific CDK lookup cache and local build/cache dirs do NOT ship.
 */

import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BOOTSTRAP_DIR = 'infra/bootstrap-modules';

// Dirs under infra/bootstrap-modules that are build output, local caches, or tests.
const BOOTSTRAP_NON_SHIPPING_DIRS = new Set(['node_modules', 'dist', 'cdk.out', 'test', '.hyperpod-helm-cache']);

/** Recursively list files under a repo-relative dir (posix paths), skipping excluded dir names. */
function walk(relDir, skipDirs = new Set()) {
    const out = [];
    const abs = join(ROOT, relDir);
    for (const name of readdirSync(abs)) {
        const relPath = posix.join(relDir, name);
        const st = statSync(join(abs, name));
        if (st.isDirectory()) {
            if (!skipDirs.has(name)) out.push(...walk(relPath, skipDirs));
        } else {
            out.push(relPath);
        }
    }
    return out;
}

/**
 * Collect repo-relative `infra/...` paths that src/ and bin/ reference at runtime.
 * Handles both string forms used in the codebase:
 *   '../../infra/bootstrap-modules/module-runner.cjs'
 *   path.join(__dirname, '..', 'infra', 'bootstrap-modules', 'module-manifest.json')
 */
function runtimeInfraReferences() {
    const refs = new Set();
    const sources = [...walk('src', new Set(['node_modules'])), ...walk('bin')]
        .filter(f => /\.(c|m)?js$/.test(f));
    const literal = /['"`](?:\.\.\/)+(infra\/[^'"`$]+)['"`]/g;
    // Anchored to a '..' climb so unrelated `'infra'` string values (e.g. the
    // generated CLI option→group map) are not mistaken for path segments.
    const segments = /'\.\.',\s*'infra'((?:\s*,\s*'[^']+')+)/g;
    for (const file of sources) {
        const text = readFileSync(join(ROOT, file), 'utf8');
        for (const m of text.matchAll(literal)) refs.add(m[1].replace(/\/$/, ''));
        for (const m of text.matchAll(segments)) {
            const parts = [...m[1].matchAll(/'([^']+)'/g)].map(p => p[1]);
            refs.add(['infra', ...parts].join('/'));
        }
    }
    return [...refs].sort();
}

describe('npm package contents', function () {
    this.timeout(120000);

    let packed;

    before(() => {
        const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 64 * 1024 * 1024
        });
        packed = new Set(JSON.parse(raw)[0].files.map(f => f.path));
    });

    /** A path ships if it is a packed file, or a directory containing packed files. */
    const ships = p => packed.has(p) || [...packed].some(f => f.startsWith(`${p}/`));

    it('ships every infra/ path that src/ and bin/ load at runtime', () => {
        const refs = runtimeInfraReferences();
        assert.ok(refs.length > 0, 'expected to discover runtime infra/ references in src/ or bin/');
        for (const ref of refs) {
            assert.ok(existsSync(join(ROOT, ref)), `src/bin references ${ref}, which does not exist in the repo`);
        }
        const missing = refs.filter(r => !ships(r));
        assert.deepStrictEqual(missing, [],
            `Referenced at runtime but missing from the npm package (add to package.json "files"): ${missing.join(', ')}`);
    });

    it('ships the bootstrap-modules CDK app sources the runner compiles at deploy time', () => {
        const required = walk(BOOTSTRAP_DIR, BOOTSTRAP_NON_SHIPPING_DIRS).filter(f =>
            (/\.(ts|cjs)$/.test(f) && !f.endsWith('.d.ts')) || posix.basename(f) === 'buckets.json'
        );
        for (const name of ['module-manifest.json', 'cdk.json', 'package.json', 'package-lock.json', 'tsconfig.json']) {
            required.push(posix.join(BOOTSTRAP_DIR, name));
        }
        assert.ok(required.some(f => f.endsWith('bin/app.ts')), 'expected the CDK app entry point bin/app.ts');
        const missing = required.filter(f => !packed.has(f));
        assert.deepStrictEqual(missing, [], `bootstrap-modules files missing from the npm package: ${missing.join(', ')}`);
    });

    it('does not ship bootstrap-modules build output, caches, tests, or account-specific CDK context', () => {
        const leaked = [...packed].filter(f => {
            if (!f.startsWith(`${BOOTSTRAP_DIR}/`)) return false;
            const rel = relative(BOOTSTRAP_DIR, f).split('/');
            return BOOTSTRAP_NON_SHIPPING_DIRS.has(rel[0]) || f === `${BOOTSTRAP_DIR}/cdk.context.json`;
        });
        assert.deepStrictEqual(leaked, [], `should not be published: ${leaked.join(', ')}`);
    });
});
