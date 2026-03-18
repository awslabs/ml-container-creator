// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest Validation Property-Based Tests
 *
 * Property-based tests verifying that manifest.json files across all
 * server directories have correct name/version matching package.json,
 * and that all catalog paths resolve to existing files.
 *
 * Feature: mcp-server-externalization
 */

<<<<<<< HEAD
import fc from 'fast-check'
import { describe, it } from 'mocha'
import assert from 'assert'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
=======
import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
<<<<<<< HEAD
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const serversRoot = resolve(__dirname, '../../servers')
=======
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const serversRoot = resolve(__dirname, '../../servers');
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Enumerate all server directories under servers/, excluding servers/lib/.
 * Returns an array of { name, dir } objects.
 */
function getServerDirs() {
    return readdirSync(serversRoot)
        .filter(entry => {
<<<<<<< HEAD
            if (entry === 'lib') return false
            const fullPath = resolve(serversRoot, entry)
            return statSync(fullPath).isDirectory()
=======
            if (entry === 'lib') return false;
            const fullPath = resolve(serversRoot, entry);
            return statSync(fullPath).isDirectory();
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
        })
        .map(entry => ({
            name: entry,
            dir: resolve(serversRoot, entry)
<<<<<<< HEAD
        }))
}

function loadJSON(filePath) {
    return JSON.parse(readFileSync(filePath, 'utf8'))
=======
        }));
}

function loadJSON(filePath) {
    return JSON.parse(readFileSync(filePath, 'utf8'));
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Manifest Validation Property-Based Tests', () => {

    // Feature: mcp-server-externalization, Property 7: Manifest name and version match package.json
    describe('Property 7: Manifest name and version match package.json', () => {
        /**
         * Validates: Requirements 4.2, 4.3, 8.5
         *
         * For any server directory under servers/ (excluding servers/lib/),
         * the name and version fields in manifest.json must equal the
         * name and version fields in package.json.
         */
        it('for every server, manifest.json name and version match package.json', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const serverDirs = getServerDirs()
            assert.ok(serverDirs.length > 0, 'Should find at least one server directory')
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const serverDirs = getServerDirs();
            assert.ok(serverDirs.length > 0, 'Should find at least one server directory');
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.constantFrom(...serverDirs),
                (server) => {
<<<<<<< HEAD
                    const manifestPath = resolve(server.dir, 'manifest.json')
                    const packagePath = resolve(server.dir, 'package.json')
=======
                    const manifestPath = resolve(server.dir, 'manifest.json');
                    const packagePath = resolve(server.dir, 'package.json');
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.ok(
                        existsSync(manifestPath),
                        `${server.name}: manifest.json should exist at ${manifestPath}`
<<<<<<< HEAD
                    )
                    assert.ok(
                        existsSync(packagePath),
                        `${server.name}: package.json should exist at ${packagePath}`
                    )

                    const manifest = loadJSON(manifestPath)
                    const pkg = loadJSON(packagePath)
=======
                    );
                    assert.ok(
                        existsSync(packagePath),
                        `${server.name}: package.json should exist at ${packagePath}`
                    );

                    const manifest = loadJSON(manifestPath);
                    const pkg = loadJSON(packagePath);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.strictEqual(
                        manifest.name,
                        pkg.name,
                        `${server.name}: manifest.json name "${manifest.name}" should match package.json name "${pkg.name}"`
<<<<<<< HEAD
                    )
=======
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                    assert.strictEqual(
                        manifest.version,
                        pkg.version,
                        `${server.name}: manifest.json version "${manifest.version}" should match package.json version "${pkg.version}"`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 8: Manifest catalog paths resolve to existing files
    describe('Property 8: Manifest catalog paths resolve to existing files', () => {
        /**
         * Validates: Requirements 4.6, 8.3
         *
         * For each server, load manifest.json, resolve each catalog path
         * relative to the server directory, and assert the file exists.
         */
        it('for every server, all manifest catalog paths resolve to existing files', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const serverDirs = getServerDirs()
            assert.ok(serverDirs.length > 0, 'Should find at least one server directory')

            // Build a list of { server, catalogName, catalogPath } entries
            const catalogEntries = []
            for (const server of serverDirs) {
                const manifestPath = resolve(server.dir, 'manifest.json')
                if (!existsSync(manifestPath)) continue

                const manifest = loadJSON(manifestPath)
                const catalogs = manifest.catalogs || {}
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const serverDirs = getServerDirs();
            assert.ok(serverDirs.length > 0, 'Should find at least one server directory');

            // Build a list of { server, catalogName, catalogPath } entries
            const catalogEntries = [];
            for (const server of serverDirs) {
                const manifestPath = resolve(server.dir, 'manifest.json');
                if (!existsSync(manifestPath)) continue;

                const manifest = loadJSON(manifestPath);
                const catalogs = manifest.catalogs || {};
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                for (const [catalogName, relativePath] of Object.entries(catalogs)) {
                    catalogEntries.push({
                        serverName: server.name,
                        serverDir: server.dir,
                        catalogName,
                        relativePath
<<<<<<< HEAD
                    })
=======
                    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                }
            }

            if (catalogEntries.length === 0) {
                // No catalog entries to validate — still a valid state
                // (e.g., if all servers have empty catalogs)
<<<<<<< HEAD
                return
=======
                return;
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
            }

            fc.assert(fc.property(
                fc.constantFrom(...catalogEntries),
                (entry) => {
<<<<<<< HEAD
                    const resolvedPath = resolve(entry.serverDir, entry.relativePath)
=======
                    const resolvedPath = resolve(entry.serverDir, entry.relativePath);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.ok(
                        existsSync(resolvedPath),
                        `${entry.serverName}: catalog "${entry.catalogName}" path "${entry.relativePath}" should resolve to existing file at ${resolvedPath}`
<<<<<<< HEAD
                    )

                    // Also verify the file is valid JSON
                    const content = readFileSync(resolvedPath, 'utf8')
                    let parsed
                    try {
                        parsed = JSON.parse(content)
                    } catch (err) {
                        assert.fail(
                            `${entry.serverName}: catalog "${entry.catalogName}" at ${resolvedPath} should be valid JSON: ${err.message}`
                        )
=======
                    );

                    // Also verify the file is valid JSON
                    const content = readFileSync(resolvedPath, 'utf8');
                    let parsed;
                    try {
                        parsed = JSON.parse(content);
                    } catch (err) {
                        assert.fail(
                            `${entry.serverName}: catalog "${entry.catalogName}" at ${resolvedPath} should be valid JSON: ${err.message}`
                        );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                    }

                    assert.ok(
                        parsed !== null && parsed !== undefined,
                        `${entry.serverName}: catalog "${entry.catalogName}" should parse to a non-null value`
<<<<<<< HEAD
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
=======
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
