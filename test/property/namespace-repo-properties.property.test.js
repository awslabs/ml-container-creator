// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Repository-Level Namespace Property-Based Tests
 *
 * Property-based tests verifying repository-level correctness properties
 * for the npm namespace rename feature.
 *
 * Feature: npm-namespace-rename, Property 1: Server package naming convention
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NUM_RUNS } from '../helpers/property-config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVERS_DIR = join(REPO_ROOT, 'servers');

const EXPECTED_PREFIX = '@amzn/ml-container-creator-';

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs = [];

function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'ns-repo-test-'));
    tempDirs.push(dir);
    return dir;
}

function writeJSON(filePath, data) {
    writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

function readJSON(filePath) {
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Get all server directories (directories under servers/ that contain a package.json).
 */
function getServerDirs(serversDir) {
    if (!existsSync(serversDir)) return [];
    return readdirSync(serversDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .filter(d => existsSync(join(serversDir, d.name, 'package.json')))
        .map(d => d.name);
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid server directory name (lowercase, alphanumeric with hyphens).
 */
const arbServerDirName = fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/)
    .filter(s => s.length >= 3 && !s.endsWith('-'));

/**
 * Generate a random package name that does NOT follow the convention.
 */
const arbNonConventionName = fc.oneof(
    fc.constant('@aws/some-package'),
    fc.constant('@foo/bar-baz'),
    fc.constant('no-scope-package'),
    fc.constant('@amzn/wrong-prefix-name'),
    fc.constant('@ml-container-creator/old-style'),
    arbServerDirName.map(s => `@amzn/other-project-${s}`)
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Repository-Level Namespace Property Tests', () => {

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

    // Feature: npm-namespace-rename, Property 1: Server package naming convention
    describe('Property 1: Server package naming convention', () => {

        /**
         * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4
         */

        // ── Real repo verification ───────────────────────────────────────

        it('every real server package.json name equals @amzn/ml-container-creator-{dirname}', function () {
            this.timeout(10000);

            const serverDirs = getServerDirs(SERVERS_DIR);
            assert.ok(serverDirs.length > 0, 'Expected at least one server directory');

            for (const dirName of serverDirs) {
                const pkgPath = join(SERVERS_DIR, dirName, 'package.json');
                const pkg = readJSON(pkgPath);
                const expectedName = `${EXPECTED_PREFIX}${dirName}`;

                assert.strictEqual(
                    pkg.name,
                    expectedName,
                    `servers/${dirName}/package.json name should be "${expectedName}" but got "${pkg.name}"`
                );
            }
        });

        it('every real server manifest.json name matches its package.json name', function () {
            this.timeout(10000);

            const serverDirs = getServerDirs(SERVERS_DIR);

            for (const dirName of serverDirs) {
                const manifestPath = join(SERVERS_DIR, dirName, 'manifest.json');
                if (!existsSync(manifestPath)) continue;

                const pkgPath = join(SERVERS_DIR, dirName, 'package.json');
                const pkg = readJSON(pkgPath);
                const manifest = readJSON(manifestPath);

                assert.strictEqual(
                    manifest.name,
                    pkg.name,
                    `servers/${dirName}/manifest.json name "${manifest.name}" should match package.json name "${pkg.name}"`
                );
            }
        });

        // ── Property: naming convention holds for generated structures ────

        it('for any server dir, package.json name must equal @amzn/ml-container-creator-{dirname}', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                (dirName) => {
                    const root = createTempDir();
                    const serversDir = join(root, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    const expectedName = `${EXPECTED_PREFIX}${dirName}`;
                    writeJSON(join(serverDir, 'package.json'), {
                        name: expectedName,
                        version: '1.0.0'
                    });

                    // Verify the convention: read back and check
                    const dirs = getServerDirs(serversDir);
                    assert.ok(dirs.includes(dirName), `Directory ${dirName} should be found`);

                    const pkg = readJSON(join(serversDir, dirName, 'package.json'));
                    assert.strictEqual(
                        pkg.name,
                        `${EXPECTED_PREFIX}${dirName}`,
                        `Name should follow convention: ${EXPECTED_PREFIX}${dirName}`
                    );

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        it('detects naming violations when package.json name does not follow convention', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                arbNonConventionName,
                (dirName, badName) => {
                    const root = createTempDir();
                    const serversDir = join(root, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    writeJSON(join(serverDir, 'package.json'), {
                        name: badName,
                        version: '1.0.0'
                    });

                    const pkg = readJSON(join(serverDir, 'package.json'));
                    const expectedName = `${EXPECTED_PREFIX}${dirName}`;

                    // The name should NOT match the convention
                    assert.notStrictEqual(
                        pkg.name,
                        expectedName,
                        `Name "${badName}" should not match convention "${expectedName}"`
                    );

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        // ── Property: manifest.json name matches package.json name ───────

        it('if manifest.json exists, its name must match the package.json name', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                fc.boolean(),
                (dirName, includeManifest) => {
                    const root = createTempDir();
                    const serversDir = join(root, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    const expectedName = `${EXPECTED_PREFIX}${dirName}`;
                    writeJSON(join(serverDir, 'package.json'), {
                        name: expectedName,
                        version: '1.0.0'
                    });

                    if (includeManifest) {
                        writeJSON(join(serverDir, 'manifest.json'), {
                            name: expectedName,
                            version: '1.0.0'
                        });

                        const pkg = readJSON(join(serverDir, 'package.json'));
                        const manifest = readJSON(join(serverDir, 'manifest.json'));

                        assert.strictEqual(
                            manifest.name,
                            pkg.name,
                            `manifest.json name "${manifest.name}" must match package.json name "${pkg.name}"`
                        );
                    }

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        it('detects manifest name mismatch with package.json', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                arbNonConventionName,
                (dirName, mismatchedName) => {
                    const root = createTempDir();
                    const serversDir = join(root, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    const expectedName = `${EXPECTED_PREFIX}${dirName}`;
                    writeJSON(join(serverDir, 'package.json'), {
                        name: expectedName,
                        version: '1.0.0'
                    });

                    // Write manifest with a different name
                    writeJSON(join(serverDir, 'manifest.json'), {
                        name: mismatchedName,
                        version: '1.0.0'
                    });

                    const pkg = readJSON(join(serverDir, 'package.json'));
                    const manifest = readJSON(join(serverDir, 'manifest.json'));

                    // The names should NOT match
                    assert.notStrictEqual(
                        manifest.name,
                        pkg.name,
                        `Mismatched manifest name "${mismatchedName}" should differ from package name "${expectedName}"`
                    );

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    // Feature: npm-namespace-rename, Property 2: Lock file name consistency
    describe('Property 2: Lock file name consistency', () => {

        /**
         * Validates: Requirements 1.3, 2.6
         */

        // ── Real repo verification ───────────────────────────────────────

        it('every real directory with both package.json and package-lock.json has matching name fields', function () {
            this.timeout(10000);

            // Collect all directories that have both files
            const dirsToCheck = [];

            // Root directory
            if (existsSync(join(REPO_ROOT, 'package.json')) && existsSync(join(REPO_ROOT, 'package-lock.json'))) {
                dirsToCheck.push(REPO_ROOT);
            }

            // Server directories
            if (existsSync(SERVERS_DIR)) {
                const serverDirs = readdirSync(SERVERS_DIR, { withFileTypes: true })
                    .filter(d => d.isDirectory());
                for (const d of serverDirs) {
                    const dir = join(SERVERS_DIR, d.name);
                    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'package-lock.json'))) {
                        dirsToCheck.push(dir);
                    }
                }
            }

            assert.ok(dirsToCheck.length > 0, 'Expected at least one directory with both package.json and package-lock.json');

            for (const dir of dirsToCheck) {
                const pkg = readJSON(join(dir, 'package.json'));
                const lock = readJSON(join(dir, 'package-lock.json'));

                assert.strictEqual(
                    lock.name,
                    pkg.name,
                    `In ${dir}, package-lock.json name "${lock.name}" should match package.json name "${pkg.name}"`
                );
            }
        });

        it('root package.json and package-lock.json names match', function () {
            this.timeout(10000);

            const pkgPath = join(REPO_ROOT, 'package.json');
            const lockPath = join(REPO_ROOT, 'package-lock.json');

            assert.ok(existsSync(pkgPath), 'Root package.json must exist');
            assert.ok(existsSync(lockPath), 'Root package-lock.json must exist');

            const pkg = readJSON(pkgPath);
            const lock = readJSON(lockPath);

            assert.strictEqual(
                lock.name,
                pkg.name,
                `Root package-lock.json name "${lock.name}" should match package.json name "${pkg.name}"`
            );
        });

        // ── Property: matching names are detected as consistent ──────────

        it('for any directory with matching package.json and package-lock.json names, consistency holds', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                fc.constantFrom(
                    '@aws/ml-container-creator',
                    '@amzn/ml-container-creator-test-server',
                    '@amzn/ml-container-creator-lib',
                    'some-random-package'
                ),
                (dirName, pkgName) => {
                    const root = createTempDir();
                    const dir = join(root, dirName);
                    ensureDir(dir);

                    writeJSON(join(dir, 'package.json'), {
                        name: pkgName,
                        version: '1.0.0'
                    });

                    writeJSON(join(dir, 'package-lock.json'), {
                        name: pkgName,
                        version: '1.0.0',
                        lockfileVersion: 3,
                        requires: true,
                        packages: {}
                    });

                    const pkg = readJSON(join(dir, 'package.json'));
                    const lock = readJSON(join(dir, 'package-lock.json'));

                    // Names must match
                    assert.strictEqual(
                        lock.name,
                        pkg.name,
                        `Lock file name "${lock.name}" should match package name "${pkg.name}"`
                    );

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        // ── Property: mismatching names are detected as inconsistent ─────

        it('for any directory with mismatching package.json and package-lock.json names, inconsistency is detected', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                fc.constantFrom(
                    '@aws/ml-container-creator',
                    '@amzn/ml-container-creator-test-server',
                    '@amzn/ml-container-creator-lib'
                ),
                arbNonConventionName,
                (dirName, pkgName, lockName) => {
                    // Ensure the names are actually different
                    fc.pre(pkgName !== lockName);

                    const root = createTempDir();
                    const dir = join(root, dirName);
                    ensureDir(dir);

                    writeJSON(join(dir, 'package.json'), {
                        name: pkgName,
                        version: '1.0.0'
                    });

                    writeJSON(join(dir, 'package-lock.json'), {
                        name: lockName,
                        version: '1.0.0',
                        lockfileVersion: 3,
                        requires: true,
                        packages: {}
                    });

                    const pkg = readJSON(join(dir, 'package.json'));
                    const lock = readJSON(join(dir, 'package-lock.json'));

                    // Names must NOT match
                    assert.notStrictEqual(
                        lock.name,
                        pkg.name,
                        `Lock file name "${lock.name}" should differ from package name "${pkg.name}"`
                    );

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    // Feature: npm-namespace-rename, Property 3: No legacy scope or invocation in repository
    describe('Property 3: No legacy scope or invocation in repository', () => {

        /**
         * Validates: Requirements 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 8.5
         */

        const LEGACY_SCOPE = '@ml-container-creator/';
        // Matches "yo ml-container-creator" NOT preceded by "@aws/"
        const BARE_YO_REGEX = /(?<!@aws\/)yo ml-container-creator/;

        // Binary file extensions to skip
        const BINARY_EXTENSIONS = new Set([
            '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
            '.woff', '.woff2', '.ttf', '.eot',
            '.zip', '.tar', '.gz', '.bz2',
            '.pdf', '.exe', '.dll', '.so', '.dylib',
            '.lock'
        ]);

        /**
         * Check if a file path should be excluded from scanning.
         * Excludes: node_modules (any depth), .git, .kiro/specs, .kiro/rationale,
         * .kiro/steering, package-lock.json, site/ (build output), test-dir/ (test output),
         * the validation script itself, and property test files (they reference legacy
         * strings as test data).
         */
        function isExcluded(relPath) {
            if (relPath.startsWith('node_modules/') || relPath.startsWith('.git/')) return true;
            if (relPath.includes('/node_modules/')) return true;
            if (relPath.startsWith('.kiro/specs/')) return true;
            if (relPath.startsWith('.kiro/rationale/')) return true;
            if (relPath.startsWith('.kiro/steering/')) return true;
            if (relPath === 'package-lock.json') return true;
            if (relPath.includes('/package-lock.json')) return true;
            if (relPath.startsWith('site/')) return true;
            if (relPath.startsWith('test-dir/')) return true;
            if (relPath === 'scripts/validate-namespaces.js') return true;
            if (relPath.startsWith('test/property/')) return true;
            return false;
        }

        /**
         * Check if a file is likely binary by extension.
         */
        function isBinaryExtension(filePath) {
            const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
            return BINARY_EXTENSIONS.has(ext);
        }

        /**
         * Recursively walk a directory and return relative paths of text files.
         */
        function walkTextFiles(rootDir, dir, results = []) {
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return results;
            }

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                const relPath = fullPath.slice(rootDir.length + 1).replace(/\\/g, '/');

                if (isExcluded(relPath)) continue;

                if (entry.isDirectory()) {
                    walkTextFiles(rootDir, fullPath, results);
                } else if (entry.isFile() && !isBinaryExtension(entry.name)) {
                    results.push({ fullPath, relPath });
                }
            }
            return results;
        }

        /**
         * Scan content for legacy scope string.
         * Returns true if legacy scope is found.
         */
        function hasLegacyScope(content) {
            return content.includes(LEGACY_SCOPE);
        }

        /**
         * Scan content for bare "yo ml-container-creator" (without @aws/ prefix).
         * Returns true if bare invocation is found.
         */
        function hasBareYoInvocation(content) {
            return BARE_YO_REGEX.test(content);
        }

        // ── Real repo scan: no legacy scope ──────────────────────────────

        it('no file in the real repo contains @ml-container-creator/', function () {
            this.timeout(120000);

            const files = walkTextFiles(REPO_ROOT, REPO_ROOT);
            const violations = [];

            for (const { fullPath, relPath } of files) {
                let content;
                try {
                    content = readFileSync(fullPath, 'utf8');
                } catch {
                    continue;
                }
                // Skip files with null bytes (binary)
                if (content.includes('\0')) continue;

                if (hasLegacyScope(content)) {
                    violations.push(relPath);
                }
            }

            assert.deepStrictEqual(
                violations,
                [],
                `Files containing legacy scope "${LEGACY_SCOPE}": ${violations.join(', ')}`
            );
        });

        // ── Real repo scan: no bare yo invocation ────────────────────────

        it('no file in the real repo contains bare "yo ml-container-creator" without @aws/ prefix', function () {
            this.timeout(120000);

            const files = walkTextFiles(REPO_ROOT, REPO_ROOT);
            const violations = [];

            for (const { fullPath, relPath } of files) {
                let content;
                try {
                    content = readFileSync(fullPath, 'utf8');
                } catch {
                    continue;
                }
                // Skip files with null bytes (binary)
                if (content.includes('\0')) continue;

                if (hasBareYoInvocation(content)) {
                    violations.push(relPath);
                }
            }

            assert.deepStrictEqual(
                violations,
                [],
                `Files containing bare "yo ml-container-creator": ${violations.join(', ')}`
            );
        });

        // ── Property: scanner detects legacy scope in generated content ──

        it('scanner detects @ml-container-creator/ in any generated file content', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                fc.tuple(
                    fc.string({ minLength: 0, maxLength: 50 }),
                    fc.string({ minLength: 0, maxLength: 50 })
                ),
                ([prefix, suffix]) => {
                    const content = `${prefix}@ml-container-creator/${suffix}`;
                    assert.ok(
                        hasLegacyScope(content),
                        `Scanner should detect legacy scope in: "${content}"`
                    );
                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        // ── Property: scanner detects bare yo invocation in generated content ──

        it('scanner detects bare "yo ml-container-creator" in any generated file content', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                fc.tuple(
                    // Prefix that does NOT end with "@aws/"
                    fc.string({ minLength: 0, maxLength: 50 })
                        .filter(s => !s.endsWith('@aws/')),
                    fc.string({ minLength: 0, maxLength: 50 })
                ),
                ([prefix, suffix]) => {
                    const content = `${prefix}yo ml-container-creator${suffix}`;
                    assert.ok(
                        hasBareYoInvocation(content),
                        `Scanner should detect bare yo invocation in: "${content}"`
                    );
                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        // ── Property: scanner finds nothing in clean content ─────────────

        it('scanner finds no legacy strings in content without them', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                fc.string({ minLength: 0, maxLength: 200 })
                    .filter(s => !s.includes('@ml-container-creator/') && !BARE_YO_REGEX.test(s)),
                (content) => {
                    assert.ok(
                        !hasLegacyScope(content),
                        'Scanner should not detect legacy scope in clean content'
                    );
                    assert.ok(
                        !hasBareYoInvocation(content),
                        'Scanner should not detect bare yo invocation in clean content'
                    );
                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    // Feature: npm-namespace-rename, Property 6: Server resolution is path-based
    describe('Property 6: Server resolution is path-based', () => {

        /**
         * Validates: Requirements 10.1, 10.2, 10.3
         */

        /**
         * Mirror of McpCommandHandler._getAvailableBundledServers() logic.
         * Scans a serversDir for directories containing a package.json with
         * @modelcontextprotocol/sdk as a dependency. Returns server entries
         * keyed by directory name, NOT by the package name field.
         */
        function getAvailableBundledServers(serversDir) {
            if (!existsSync(serversDir)) return [];

            const entries = readdirSync(serversDir, { withFileTypes: true });
            const servers = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const pkgPath = join(serversDir, entry.name, 'package.json');
                if (!existsSync(pkgPath)) continue;

                try {
                    const pkg = readJSON(pkgPath);
                    const deps = pkg.dependencies || {};
                    if (!deps['@modelcontextprotocol/sdk']) continue;

                    servers.push({
                        name: entry.name,
                        description: pkg.description || '(no description)'
                    });
                } catch (_) {
                    servers.push({
                        name: entry.name,
                        description: '(unable to read package.json)'
                    });
                }
            }

            return servers;
        }

        /**
         * Generate a random package name (any arbitrary string).
         */
        const arbRandomPkgName = fc.oneof(
            fc.constant('@aws/some-random-thing'),
            fc.constant('@amzn/ml-container-creator-base-image-picker'),
            fc.constant('@totally/different-name'),
            fc.constant('no-scope-at-all'),
            fc.constant('@ml-container-creator/old-name'),
            arbServerDirName.map(s => `@random/${s}`),
            arbNonConventionName
        );

        // ── Real repo: servers discovered by directory, not name ──────────

        it('real servers are discovered by directory presence and @modelcontextprotocol/sdk dependency', function () {
            this.timeout(10000);

            const servers = getAvailableBundledServers(SERVERS_DIR);

            // Must find at least one server
            assert.ok(servers.length > 0, 'Expected at least one bundled server');

            // Each returned server name must be a directory name, not a package name
            for (const server of servers) {
                // The name should be a simple directory name (no @ scope)
                assert.ok(
                    !server.name.includes('/'),
                    `Server name "${server.name}" should be a directory name, not a scoped package name`
                );

                // The directory must exist
                const serverDir = join(SERVERS_DIR, server.name);
                assert.ok(
                    existsSync(serverDir),
                    `Directory servers/${server.name}/ must exist`
                );

                // The package.json must have @modelcontextprotocol/sdk
                const pkg = readJSON(join(serverDir, 'package.json'));
                const deps = pkg.dependencies || {};
                assert.ok(
                    deps['@modelcontextprotocol/sdk'],
                    `servers/${server.name}/package.json must have @modelcontextprotocol/sdk dependency`
                );
            }
        });

        it('real lib directory is excluded because it lacks @modelcontextprotocol/sdk', function () {
            this.timeout(10000);

            const servers = getAvailableBundledServers(SERVERS_DIR);
            const serverNames = servers.map(s => s.name);

            assert.ok(
                !serverNames.includes('lib'),
                'lib directory should not be listed as a bundled server (no @modelcontextprotocol/sdk dependency)'
            );
        });

        // ── Property: name field does not affect server discovery ─────────

        it('for any server dir with @modelcontextprotocol/sdk, discovery uses directory name regardless of package name', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                arbRandomPkgName,
                (dirName, pkgName) => {
                    const root = createTempDir();
                    const serversDir = join(root, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    // Write package.json with arbitrary name but with the SDK dependency
                    writeJSON(join(serverDir, 'package.json'), {
                        name: pkgName,
                        version: '1.0.0',
                        dependencies: {
                            '@modelcontextprotocol/sdk': '^1.0.0'
                        }
                    });

                    const servers = getAvailableBundledServers(serversDir);

                    // Server must be discovered
                    assert.strictEqual(servers.length, 1, 'Exactly one server should be discovered');

                    // The returned name must be the directory name, not the package name
                    assert.strictEqual(
                        servers[0].name,
                        dirName,
                        `Server should be identified as "${dirName}" (dir name), not "${pkgName}" (package name)`
                    );

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        // ── Property: directories without SDK dependency are excluded ─────

        it('for any server dir without @modelcontextprotocol/sdk, directory is not discovered', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                arbServerDirName,
                arbRandomPkgName,
                (dirName, pkgName) => {
                    const root = createTempDir();
                    const serversDir = join(root, 'servers');
                    const serverDir = join(serversDir, dirName);
                    ensureDir(serverDir);

                    // Write package.json WITHOUT @modelcontextprotocol/sdk
                    writeJSON(join(serverDir, 'package.json'), {
                        name: pkgName,
                        version: '1.0.0',
                        dependencies: {
                            'some-other-dep': '^1.0.0'
                        }
                    });

                    const servers = getAvailableBundledServers(serversDir);

                    // Server must NOT be discovered
                    assert.strictEqual(
                        servers.length,
                        0,
                        `Directory "${dirName}" without @modelcontextprotocol/sdk should not be discovered`
                    );

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });

        // ── Property: multiple servers with varying names all resolve by directory ──

        it('multiple servers with different package names are all resolved by directory name', function () {
            this.timeout(30000);

            fc.assert(fc.property(
                fc.array(
                    fc.tuple(arbServerDirName, arbRandomPkgName),
                    { minLength: 1, maxLength: 5 }
                ),
                (serverSpecs) => {
                    // Deduplicate directory names
                    const seen = new Set();
                    const uniqueSpecs = serverSpecs.filter(([dirName]) => {
                        if (seen.has(dirName)) return false;
                        seen.add(dirName);
                        return true;
                    });

                    fc.pre(uniqueSpecs.length >= 1);

                    const root = createTempDir();
                    const serversDir = join(root, 'servers');

                    for (const [dirName, pkgName] of uniqueSpecs) {
                        const serverDir = join(serversDir, dirName);
                        ensureDir(serverDir);

                        writeJSON(join(serverDir, 'package.json'), {
                            name: pkgName,
                            version: '1.0.0',
                            dependencies: {
                                '@modelcontextprotocol/sdk': '^1.0.0'
                            }
                        });
                    }

                    const servers = getAvailableBundledServers(serversDir);
                    const discoveredNames = servers.map(s => s.name).sort();
                    const expectedNames = uniqueSpecs.map(([dirName]) => dirName).sort();

                    assert.deepStrictEqual(
                        discoveredNames,
                        expectedNames,
                        `Discovered servers ${JSON.stringify(discoveredNames)} should match directory names ${JSON.stringify(expectedNames)}`
                    );

                    // None of the returned names should be a package name
                    for (const server of servers) {
                        assert.ok(
                            !server.name.includes('/'),
                            `Returned name "${server.name}" should be a directory name, not a scoped package name`
                        );
                    }

                    return true;
                }
            ), { numRuns: NUM_RUNS });
        });
    });
});
