// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Validation Script Property-Based Tests
 *
 * Property-based tests verifying that the CI validation script
 * (scripts/validate-servers.js) correctly detects all artifact
 * violations in server directories.
 *
 * Feature: mcp-server-externalization, Property 12: CI validation script detects all artifact violations
 */

<<<<<<< HEAD
import fc from 'fast-check'
import { describe, it, afterEach } from 'mocha'
import assert from 'assert'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateServer } from '../../scripts/validate-servers.js'
=======
import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateServer } from '../../scripts/validate-servers.js';
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
<<<<<<< HEAD
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs = []

function createTempServerDir() {
    const dir = mkdtempSync(join(tmpdir(), 'ci-val-test-'))
    tempDirs.push(dir)
    return dir
}

function writeJSON(dir, filename, data) {
    writeFileSync(join(dir, filename), JSON.stringify(data, null, 4), 'utf8')
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true })
=======
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs = [];

function createTempServerDir() {
    const dir = mkdtempSync(join(tmpdir(), 'ci-val-test-'));
    tempDirs.push(dir);
    return dir;
}

function writeJSON(dir, filename, data) {
    writeFileSync(join(dir, filename), JSON.stringify(data, null, 4), 'utf8');
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

/**
 * Build a valid manifest object with all required fields.
 */
function validManifest(overrides = {}) {
    return {
        name: '@test/test-server',
        version: '1.0.0',
        description: 'A test server',
        modes: { static: false, smart: false, discover: false },
        catalogs: {},
        tool: { name: 'get_test_data' },
        ...overrides
<<<<<<< HEAD
    }
=======
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

/**
 * Build a valid package.json object.
 */
function validPackageJson(overrides = {}) {
    return {
        name: '@test/test-server',
        version: '1.0.0',
        ...overrides
<<<<<<< HEAD
    }
=======
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

/**
 * Build a valid region entry for use in catalog files.
 */
function validRegionEntry(code = 'us-east-1') {
    return {
        code,
        labels: ['US East (N. Virginia)']
<<<<<<< HEAD
    }
=======
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random non-empty alphanumeric string for names.
 */
<<<<<<< HEAD
const arbName = fc.stringMatching(/^[a-z][a-z0-9\-]{2,20}$/)
    .filter(s => s.length >= 3)
    .map(s => `@test/${s}`)
=======
const arbName = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/)
    .filter(s => s.length >= 3)
    .map(s => `@test/${s}`);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a valid semver version string.
 */
const arbVersion = fc.tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 })
<<<<<<< HEAD
).map(([a, b, c]) => `${a}.${b}.${c}`)
=======
).map(([a, b, c]) => `${a}.${b}.${c}`);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate a random manifest violation type.
 */
const arbManifestViolation = fc.constantFrom(
    'missing_name',
    'missing_version',
    'missing_description',
    'missing_modes',
    'missing_catalogs',
    'missing_tool',
    'wrong_name_type',
    'wrong_version_type',
    'wrong_modes_type',
    'bad_version_pattern'
<<<<<<< HEAD
)
=======
);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Property tests ───────────────────────────────────────────────────────────

describe('CI Validation Property-Based Tests', () => {

    afterEach(() => {
        for (const dir of tempDirs) {
            try {
<<<<<<< HEAD
                rmSync(dir, { recursive: true, force: true })
=======
                rmSync(dir, { recursive: true, force: true });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
            } catch {
                // ignore cleanup errors
            }
        }
<<<<<<< HEAD
        tempDirs.length = 0
    })
=======
        tempDirs.length = 0;
    });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

    // Feature: mcp-server-externalization, Property 12: CI validation script detects all artifact violations
    describe('Property 12: CI validation script detects all artifact violations', () => {

        /**
         * Validates: Requirements 8.2, 8.4, 8.6, 8.7
         */


        // ── Test 1: Bad manifest schema ──────────────────────────────────

        it('detects manifest schema violations for randomly generated bad manifests', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbManifestViolation,
                (violationType) => {
<<<<<<< HEAD
                    const dir = createTempServerDir()
                    const serverName = 'test-server'

                    // Start with a valid manifest and introduce a violation
                    const manifest = validManifest()

                    switch (violationType) {
                        case 'missing_name':
                            delete manifest.name
                            break
                        case 'missing_version':
                            delete manifest.version
                            break
                        case 'missing_description':
                            delete manifest.description
                            break
                        case 'missing_modes':
                            delete manifest.modes
                            break
                        case 'missing_catalogs':
                            delete manifest.catalogs
                            break
                        case 'missing_tool':
                            delete manifest.tool
                            break
                        case 'wrong_name_type':
                            manifest.name = 12345
                            break
                        case 'wrong_version_type':
                            manifest.version = true
                            break
                        case 'wrong_modes_type':
                            manifest.modes = 'not-an-object'
                            break
                        case 'bad_version_pattern':
                            manifest.version = 'not-a-version'
                            break
                    }

                    writeJSON(dir, 'manifest.json', manifest)
                    writeJSON(dir, 'package.json', validPackageJson())

                    const errors = validateServer(dir, serverName)
=======
                    const dir = createTempServerDir();
                    const serverName = 'test-server';

                    // Start with a valid manifest and introduce a violation
                    const manifest = validManifest();

                    switch (violationType) {
                    case 'missing_name':
                        delete manifest.name;
                        break;
                    case 'missing_version':
                        delete manifest.version;
                        break;
                    case 'missing_description':
                        delete manifest.description;
                        break;
                    case 'missing_modes':
                        delete manifest.modes;
                        break;
                    case 'missing_catalogs':
                        delete manifest.catalogs;
                        break;
                    case 'missing_tool':
                        delete manifest.tool;
                        break;
                    case 'wrong_name_type':
                        manifest.name = 12345;
                        break;
                    case 'wrong_version_type':
                        manifest.version = true;
                        break;
                    case 'wrong_modes_type':
                        manifest.modes = 'not-an-object';
                        break;
                    case 'bad_version_pattern':
                        manifest.version = 'not-a-version';
                        break;
                    }

                    writeJSON(dir, 'manifest.json', manifest);
                    writeJSON(dir, 'package.json', validPackageJson());

                    const errors = validateServer(dir, serverName);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.ok(
                        errors.length > 0,
                        `Should detect schema violation for "${violationType}" but got no errors`
<<<<<<< HEAD
                    )
                    const hasSchemaError = errors.some(e => e.includes('schema violation'))
                    assert.ok(
                        hasSchemaError,
                        `Errors should mention "schema violation" for "${violationType}" but got: ${JSON.stringify(errors)}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                    );
                    const hasSchemaError = errors.some(e => e.includes('schema violation'));
                    assert.ok(
                        hasSchemaError,
                        `Errors should mention "schema violation" for "${violationType}" but got: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── Test 2: Missing catalogs ─────────────────────────────────────

        it('detects missing catalog files referenced in manifest', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbCatalogName = fc.stringMatching(/^[a-z][a-z0-9\-]{1,15}$/)
                .filter(s => s.length >= 2)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const arbCatalogName = fc.stringMatching(/^[a-z][a-z0-9-]{1,15}$/)
                .filter(s => s.length >= 2);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                fc.array(arbCatalogName, { minLength: 1, maxLength: 4 }),
                (catalogNames) => {
<<<<<<< HEAD
                    const dir = createTempServerDir()
                    const serverName = 'test-server'

                    // Build catalogs object referencing files that don't exist
                    const catalogs = {}
                    const uniqueNames = [...new Set(catalogNames)]
                    for (const name of uniqueNames) {
                        catalogs[name] = `./catalogs/${name}.json`
                    }

                    const manifest = validManifest({ catalogs })
                    writeJSON(dir, 'manifest.json', manifest)
                    writeJSON(dir, 'package.json', validPackageJson())

                    const errors = validateServer(dir, serverName)

                    assert.ok(
                        errors.length > 0,
                        `Should detect missing catalog files but got no errors`
                    )
=======
                    const dir = createTempServerDir();
                    const serverName = 'test-server';

                    // Build catalogs object referencing files that don't exist
                    const catalogs = {};
                    const uniqueNames = [...new Set(catalogNames)];
                    for (const name of uniqueNames) {
                        catalogs[name] = `./catalogs/${name}.json`;
                    }

                    const manifest = validManifest({ catalogs });
                    writeJSON(dir, 'manifest.json', manifest);
                    writeJSON(dir, 'package.json', validPackageJson());

                    const errors = validateServer(dir, serverName);

                    assert.ok(
                        errors.length > 0,
                        'Should detect missing catalog files but got no errors'
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Each missing catalog should produce a "not found" error
                    for (const name of uniqueNames) {
                        const hasNotFound = errors.some(e =>
                            e.includes('not found') && e.includes(name)
<<<<<<< HEAD
                        )
                        assert.ok(
                            hasNotFound,
                            `Should report catalog "${name}" as not found. Errors: ${JSON.stringify(errors)}`
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                        );
                        assert.ok(
                            hasNotFound,
                            `Should report catalog "${name}" as not found. Errors: ${JSON.stringify(errors)}`
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── Test 3: Mismatched name/version ──────────────────────────────

        it('detects mismatched name or version between manifest and package.json', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbName,
                arbName,
                arbVersion,
                arbVersion,
                fc.constantFrom('name', 'version', 'both'),
                (manifestName, pkgName, manifestVersion, pkgVersion, mismatchType) => {
<<<<<<< HEAD
                    const dir = createTempServerDir()
                    const serverName = 'test-server'

                    let mName, pName, mVersion, pVersion

                    switch (mismatchType) {
                        case 'name':
                            // Ensure names differ
                            mName = manifestName
                            pName = manifestName === pkgName ? pkgName + '-different' : pkgName
                            mVersion = manifestVersion
                            pVersion = manifestVersion
                            break
                        case 'version':
                            // Ensure versions differ
                            mName = manifestName
                            pName = manifestName
                            mVersion = manifestVersion
                            pVersion = manifestVersion === pkgVersion ? '99.99.99' : pkgVersion
                            break
                        case 'both':
                            mName = manifestName
                            pName = manifestName === pkgName ? pkgName + '-different' : pkgName
                            mVersion = manifestVersion
                            pVersion = manifestVersion === pkgVersion ? '99.99.99' : pkgVersion
                            break
                    }

                    const manifest = validManifest({ name: mName, version: mVersion })
                    writeJSON(dir, 'manifest.json', manifest)
                    writeJSON(dir, 'package.json', validPackageJson({ name: pName, version: pVersion }))

                    const errors = validateServer(dir, serverName)
=======
                    const dir = createTempServerDir();
                    const serverName = 'test-server';

                    let mName, pName, mVersion, pVersion;

                    switch (mismatchType) {
                    case 'name':
                        // Ensure names differ
                        mName = manifestName;
                        pName = manifestName === pkgName ? `${pkgName  }-different` : pkgName;
                        mVersion = manifestVersion;
                        pVersion = manifestVersion;
                        break;
                    case 'version':
                        // Ensure versions differ
                        mName = manifestName;
                        pName = manifestName;
                        mVersion = manifestVersion;
                        pVersion = manifestVersion === pkgVersion ? '99.99.99' : pkgVersion;
                        break;
                    case 'both':
                        mName = manifestName;
                        pName = manifestName === pkgName ? `${pkgName  }-different` : pkgName;
                        mVersion = manifestVersion;
                        pVersion = manifestVersion === pkgVersion ? '99.99.99' : pkgVersion;
                        break;
                    }

                    const manifest = validManifest({ name: mName, version: mVersion });
                    writeJSON(dir, 'manifest.json', manifest);
                    writeJSON(dir, 'package.json', validPackageJson({ name: pName, version: pVersion }));

                    const errors = validateServer(dir, serverName);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.ok(
                        errors.length > 0,
                        `Should detect mismatched ${mismatchType} but got no errors`
<<<<<<< HEAD
                    )

                    const hasDoesNotMatch = errors.some(e => e.includes('does not match'))
                    assert.ok(
                        hasDoesNotMatch,
                        `Errors should mention "does not match" for ${mismatchType} mismatch. Errors: ${JSON.stringify(errors)}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                    );

                    const hasDoesNotMatch = errors.some(e => e.includes('does not match'));
                    assert.ok(
                        hasDoesNotMatch,
                        `Errors should mention "does not match" for ${mismatchType} mismatch. Errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── Test 4: Static mode with empty catalogs ──────────────────────

        it('detects static mode with empty catalogs', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbName,
                arbVersion,
                (name, version) => {
<<<<<<< HEAD
                    const dir = createTempServerDir()
                    const serverName = 'test-server'
=======
                    const dir = createTempServerDir();
                    const serverName = 'test-server';
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    const manifest = validManifest({
                        name,
                        version,
                        modes: { static: true, smart: false, discover: false },
                        catalogs: {}
<<<<<<< HEAD
                    })
                    writeJSON(dir, 'manifest.json', manifest)
                    writeJSON(dir, 'package.json', validPackageJson({ name, version }))

                    const errors = validateServer(dir, serverName)
=======
                    });
                    writeJSON(dir, 'manifest.json', manifest);
                    writeJSON(dir, 'package.json', validPackageJson({ name, version }));

                    const errors = validateServer(dir, serverName);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.ok(
                        errors.length > 0,
                        'Should detect static mode with empty catalogs but got no errors'
<<<<<<< HEAD
                    )

                    const hasStaticError = errors.some(e =>
                        e.toLowerCase().includes('static') && e.toLowerCase().includes('empty')
                    )
                    assert.ok(
                        hasStaticError,
                        `Errors should mention "static" and "empty". Errors: ${JSON.stringify(errors)}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                    );

                    const hasStaticError = errors.some(e =>
                        e.toLowerCase().includes('static') && e.toLowerCase().includes('empty')
                    );
                    assert.ok(
                        hasStaticError,
                        `Errors should mention "static" and "empty". Errors: ${JSON.stringify(errors)}`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        // ── Test 5: Valid server passes ──────────────────────────────────

        it('valid server directory passes validation with no errors', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbName,
                arbVersion,
                (name, version) => {
<<<<<<< HEAD
                    const dir = createTempServerDir()
                    const serverName = 'test-server'

                    // Create a valid server with a regions catalog
                    const catalogsDir = join(dir, 'catalogs')
                    ensureDir(catalogsDir)
=======
                    const dir = createTempServerDir();
                    const serverName = 'test-server';

                    // Create a valid server with a regions catalog
                    const catalogsDir = join(dir, 'catalogs');
                    ensureDir(catalogsDir);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    const manifest = validManifest({
                        name,
                        version,
                        modes: { static: true, smart: false, discover: false },
                        catalogs: {
                            regions: './catalogs/regions.json'
                        }
<<<<<<< HEAD
                    })
                    writeJSON(dir, 'manifest.json', manifest)
                    writeJSON(dir, 'package.json', validPackageJson({ name, version }))
                    writeJSON(catalogsDir, 'regions.json', [validRegionEntry()])

                    const errors = validateServer(dir, serverName)
=======
                    });
                    writeJSON(dir, 'manifest.json', manifest);
                    writeJSON(dir, 'package.json', validPackageJson({ name, version }));
                    writeJSON(catalogsDir, 'regions.json', [validRegionEntry()]);

                    const errors = validateServer(dir, serverName);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    assert.deepStrictEqual(
                        errors,
                        [],
                        `Valid server should have no errors but got: ${JSON.stringify(errors)}`
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
