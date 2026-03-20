// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Namespace Validation Property-Based Tests
 *
 * Property-based tests verifying that the namespace validation script
 * (scripts/validate-namespaces.js) correctly detects namespace violations
 * in package.json and manifest.json files.
 *
 * Feature: npm-namespace-rename, Property 4: Validator detects namespace violations
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    validateRootNamespace,
    validateServerNamespaces,
    validateManifestNamespaces,
    validatePublishSafety
} from '../../scripts/validate-namespaces.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs = [];

function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'ns-val-test-'));
    tempDirs.push(dir);
    return dir;
}

function writeJSON(filePath, data) {
    writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random npm scope that is NOT @aws/ — these are invalid for root.
 */
const arbInvalidRootPrefix = fc.oneof(
    fc.constant('@amzn/'),
    fc.constant('@ml-container-creator/'),
    fc.constant('@foo/'),
    fc.constant('@bar/'),
    fc.constant(''),
    fc.constant('no-scope-')
);

/**
 * Generate a random npm scope that is NOT @amzn/ — these are invalid for servers.
 */
const arbInvalidServerPrefix = fc.oneof(
    fc.constant('@aws/'),
    fc.constant('@ml-container-creator/'),
    fc.constant('@foo/'),
    fc.constant('@bar/'),
    fc.constant(''),
    fc.constant('no-scope-')
);

/**
 * Generate a random package name suffix.
 */
const arbNameSuffix = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/)
    .filter(s => s.length >= 3);

/**
 * Generate a random server directory name.
 */
const arbServerDirName = fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/)
    .filter(s => s.length >= 3);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Namespace Validation Property-Based Tests', () => {

    afterEach(() => {
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // ignore cleanup errors
            }
        }
        tempDirs.length = 0;
    });

    // Feature: npm-namespace-rename, Property 4: Validator detects namespace violations
    describe('Property 4: Validator detects namespace violations', () => {

        /**
         * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6
         */

        // ── Test 1: Root package with invalid prefix is rejected ─────────

        it('rejects root package.json names not starting with @aws/', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbInvalidRootPrefix,
                arbNameSuffix,
                (prefix, suffix) => {
                    const dir = createTempDir();
                    const pkgPath = join(dir, 'package.json');
                    const name = `${prefix}${suffix}`;

                    writeJSON(pkgPath, { name, version: '1.0.0' });

                    const errors = validateRootNamespace(pkgPath);

                    assert.ok(
                        errors.length > 0,
                        `Should reject root name "${name}" (does not start with @aws/) but got no errors`
                    );

                    // Error message must contain the current name (Req 8.6)
                    const mentionsName = errors.some(e => e.includes(name));
                    assert.ok(
                        mentionsName,
                        `Error should mention the violating name "${name}". Errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 2: Root package with valid @aws/ prefix passes ──────────

        it('accepts root package.json names starting with @aws/', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbNameSuffix,
                (suffix) => {
                    const dir = createTempDir();
                    const pkgPath = join(dir, 'package.json');
                    const name = `@aws/${suffix}`;

                    writeJSON(pkgPath, { name, version: '1.0.0' });

                    const errors = validateRootNamespace(pkgPath);

                    assert.deepStrictEqual(
                        errors,
                        [],
                        `Should accept root name "${name}" but got errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 3: Server package with invalid prefix is rejected ───────

        it('rejects server package.json names not starting with @amzn/', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                arbInvalidServerPrefix,
                arbNameSuffix,
                (dirName, prefix, suffix) => {
                    const dir = createTempDir();
                    const serverDir = join(dir, dirName);
                    ensureDir(serverDir);

                    const name = `${prefix}${suffix}`;
                    writeJSON(join(serverDir, 'package.json'), { name, version: '1.0.0' });

                    const errors = validateServerNamespaces(dir);

                    assert.ok(
                        errors.length > 0,
                        `Should reject server name "${name}" in ${dirName}/ (does not start with @amzn/) but got no errors`
                    );

                    // Error message must contain the file path (Req 8.6)
                    const mentionsPath = errors.some(e => e.includes(dirName));
                    assert.ok(
                        mentionsPath,
                        `Error should mention the server directory "${dirName}". Errors: ${JSON.stringify(errors)}`
                    );

                    // Error message must contain the current name (Req 8.6)
                    const mentionsName = errors.some(e => e.includes(name));
                    assert.ok(
                        mentionsName,
                        `Error should mention the violating name "${name}". Errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 4: Server package with valid @amzn/ prefix passes ───────

        it('accepts server package.json names starting with @amzn/', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                arbNameSuffix,
                (dirName, suffix) => {
                    const dir = createTempDir();
                    const serverDir = join(dir, dirName);
                    ensureDir(serverDir);

                    const name = `@amzn/${suffix}`;
                    writeJSON(join(serverDir, 'package.json'), { name, version: '1.0.0' });

                    const errors = validateServerNamespaces(dir);

                    assert.deepStrictEqual(
                        errors,
                        [],
                        `Should accept server name "${name}" but got errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 5: Manifest with invalid prefix is rejected ─────────────

        it('rejects server manifest.json names not starting with @amzn/', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                arbInvalidServerPrefix,
                arbNameSuffix,
                (dirName, prefix, suffix) => {
                    const dir = createTempDir();
                    const serverDir = join(dir, dirName);
                    ensureDir(serverDir);

                    const name = `${prefix}${suffix}`;
                    writeJSON(join(serverDir, 'manifest.json'), { name, version: '1.0.0' });

                    const errors = validateManifestNamespaces(dir);

                    assert.ok(
                        errors.length > 0,
                        `Should reject manifest name "${name}" in ${dirName}/ (does not start with @amzn/) but got no errors`
                    );

                    // Error message must contain the file path (Req 8.6)
                    const mentionsPath = errors.some(e => e.includes(dirName));
                    assert.ok(
                        mentionsPath,
                        `Error should mention the server directory "${dirName}". Errors: ${JSON.stringify(errors)}`
                    );

                    // Error message must contain the current name (Req 8.6)
                    const mentionsName = errors.some(e => e.includes(name));
                    assert.ok(
                        mentionsName,
                        `Error should mention the violating name "${name}". Errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 6: Manifest with valid @amzn/ prefix passes ─────────────

        it('accepts server manifest.json names starting with @amzn/', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                arbNameSuffix,
                (dirName, suffix) => {
                    const dir = createTempDir();
                    const serverDir = join(dir, dirName);
                    ensureDir(serverDir);

                    const name = `@amzn/${suffix}`;
                    writeJSON(join(serverDir, 'manifest.json'), { name, version: '1.0.0' });

                    const errors = validateManifestNamespaces(dir);

                    assert.deepStrictEqual(
                        errors,
                        [],
                        `Should accept manifest name "${name}" but got errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 7: Missing name field is rejected ───────────────────────

        it('rejects package.json or manifest.json with missing name field', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                fc.constantFrom('package.json', 'manifest.json'),
                (dirName, fileType) => {
                    const dir = createTempDir();

                    if (fileType === 'package.json') {
                        // Test root package.json missing name
                        const pkgPath = join(dir, 'package.json');
                        writeJSON(pkgPath, { version: '1.0.0' });
                        const rootErrors = validateRootNamespace(pkgPath);
                        assert.ok(
                            rootErrors.length > 0,
                            'Should reject root package.json with missing name'
                        );

                        // Test server package.json missing name
                        const serverDir = join(dir, 'servers', dirName);
                        ensureDir(serverDir);
                        writeJSON(join(serverDir, 'package.json'), { version: '1.0.0' });
                        const serverErrors = validateServerNamespaces(join(dir, 'servers'));
                        assert.ok(
                            serverErrors.length > 0,
                            'Should reject server package.json with missing name'
                        );
                    } else {
                        // Test manifest.json missing name
                        const serverDir = join(dir, dirName);
                        ensureDir(serverDir);
                        writeJSON(join(serverDir, 'manifest.json'), { version: '1.0.0' });
                        const manifestErrors = validateManifestNamespaces(dir);
                        assert.ok(
                            manifestErrors.length > 0,
                            'Should reject manifest.json with missing name'
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: npm-namespace-rename, Property 5: Validator detects publish safety violations
    describe('Property 5: Validator detects publish safety violations', () => {

        /**
         * Validates: Requirements 9.1, 9.2, 9.3, 9.4
         */

        /**
         * Generator for the `private` field value: true, false, or undefined (missing).
         */
        const arbPrivateField = fc.constantFrom(true, false, undefined);

        // ── Test 1: Server packages without "private": true produce errors ──

        it('rejects server packages missing "private": true', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                fc.constantFrom(false, undefined),
                (dirName, privateValue) => {
                    const dir = createTempDir();
                    const serversDir = join(dir, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    // Root package.json (valid — not private)
                    const rootPkgPath = join(dir, 'package.json');
                    writeJSON(rootPkgPath, { name: '@aws/test-pkg', version: '1.0.0' });

                    // Server package.json with invalid private field
                    const serverPkg = { name: `@amzn/ml-container-creator-${dirName}`, version: '1.0.0' };
                    if (privateValue !== undefined) {
                        serverPkg.private = privateValue;
                    }
                    writeJSON(join(serverDir, 'package.json'), serverPkg);

                    const errors = validatePublishSafety(rootPkgPath, serversDir);

                    assert.ok(
                        errors.length > 0,
                        `Should reject server package with private=${JSON.stringify(privateValue)} but got no errors`
                    );

                    // Error message must contain the violating file path (Req 9.4)
                    const mentionsPath = errors.some(e => e.includes(dirName));
                    assert.ok(
                        mentionsPath,
                        `Error should mention the server directory "${dirName}". Errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 2: Server packages with "private": true don't produce errors ──

        it('accepts server packages with "private": true', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                (dirName) => {
                    const dir = createTempDir();
                    const serversDir = join(dir, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    // Root package.json (valid — not private)
                    const rootPkgPath = join(dir, 'package.json');
                    writeJSON(rootPkgPath, { name: '@aws/test-pkg', version: '1.0.0' });

                    // Server package.json with private: true
                    writeJSON(join(serverDir, 'package.json'), {
                        name: `@amzn/ml-container-creator-${dirName}`,
                        version: '1.0.0',
                        private: true
                    });

                    const errors = validatePublishSafety(rootPkgPath, serversDir);

                    assert.deepStrictEqual(
                        errors,
                        [],
                        `Should accept server package with private=true but got errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 3: Root package with "private": true produces errors ────────

        it('rejects root package with "private": true', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerDirName,
                (_dirName) => {
                    const dir = createTempDir();
                    const serversDir = join(dir, 'servers');
                    ensureDir(serversDir);

                    // Root package.json with private: true (violation)
                    const rootPkgPath = join(dir, 'package.json');
                    writeJSON(rootPkgPath, {
                        name: '@aws/test-pkg',
                        version: '1.0.0',
                        private: true
                    });

                    const errors = validatePublishSafety(rootPkgPath, serversDir);

                    assert.ok(
                        errors.length > 0,
                        'Should reject root package with private=true but got no errors'
                    );

                    // Error message must mention root (Req 9.4)
                    const mentionsRoot = errors.some(e =>
                        e.toLowerCase().includes('root') || e.includes('package.json')
                    );
                    assert.ok(
                        mentionsRoot,
                        `Error should mention root package. Errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 4: Root package without "private": true doesn't produce errors ─

        it('accepts root package without "private": true', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(false, undefined),
                (privateValue) => {
                    const dir = createTempDir();
                    const serversDir = join(dir, 'servers');
                    ensureDir(serversDir);

                    // Root package.json without private: true (valid)
                    const rootPkg = { name: '@aws/test-pkg', version: '1.0.0' };
                    if (privateValue !== undefined) {
                        rootPkg.private = privateValue;
                    }
                    const rootPkgPath = join(dir, 'package.json');
                    writeJSON(rootPkgPath, rootPkg);

                    const errors = validatePublishSafety(rootPkgPath, serversDir);

                    assert.deepStrictEqual(
                        errors,
                        [],
                        `Should accept root package with private=${JSON.stringify(privateValue)} but got errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        // ── Test 5: Combined — random private values across root and servers ─

        it('correctly identifies all publish safety violations with random private values', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbPrivateField,
                arbServerDirName,
                arbPrivateField,
                (rootPrivate, serverDirName, serverPrivate) => {
                    const dir = createTempDir();
                    const serversDir = join(dir, 'servers');
                    const serverDir = join(serversDir, serverDirName);
                    ensureDir(serverDir);

                    // Root package.json
                    const rootPkg = { name: '@aws/test-pkg', version: '1.0.0' };
                    if (rootPrivate !== undefined) {
                        rootPkg.private = rootPrivate;
                    }
                    const rootPkgPath = join(dir, 'package.json');
                    writeJSON(rootPkgPath, rootPkg);

                    // Server package.json
                    const serverPkg = { name: `@amzn/ml-container-creator-${serverDirName}`, version: '1.0.0' };
                    if (serverPrivate !== undefined) {
                        serverPkg.private = serverPrivate;
                    }
                    writeJSON(join(serverDir, 'package.json'), serverPkg);

                    const errors = validatePublishSafety(rootPkgPath, serversDir);

                    const rootShouldFail = rootPrivate === true;
                    const serverShouldFail = serverPrivate !== true;

                    if (rootShouldFail) {
                        const hasRootError = errors.some(e =>
                            e.toLowerCase().includes('root') || e.includes('must NOT')
                        );
                        assert.ok(
                            hasRootError,
                            `Root with private=true should produce error. Errors: ${JSON.stringify(errors)}`
                        );
                    }

                    if (serverShouldFail) {
                        const hasServerError = errors.some(e => e.includes(serverDirName));
                        assert.ok(
                            hasServerError,
                            `Server "${serverDirName}" with private=${JSON.stringify(serverPrivate)} should produce error. Errors: ${JSON.stringify(errors)}`
                        );
                    }

                    if (!rootShouldFail && !serverShouldFail) {
                        assert.deepStrictEqual(
                            errors,
                            [],
                            `No violations expected but got errors: ${JSON.stringify(errors)}`
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
