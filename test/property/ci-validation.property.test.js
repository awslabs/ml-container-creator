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

import fc from 'fast-check'
import { describe, it, afterEach } from 'mocha'
import assert from 'assert'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateServer } from '../../scripts/validate-servers.js'

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
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
    }
}

/**
 * Build a valid package.json object.
 */
function validPackageJson(overrides = {}) {
    return {
        name: '@test/test-server',
        version: '1.0.0',
        ...overrides
    }
}

/**
 * Build a valid region entry for use in catalog files.
 */
function validRegionEntry(code = 'us-east-1') {
    return {
        code,
        labels: ['US East (N. Virginia)']
    }
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random non-empty alphanumeric string for names.
 */
const arbName = fc.stringMatching(/^[a-z][a-z0-9\-]{2,20}$/)
    .filter(s => s.length >= 3)
    .map(s => `@test/${s}`)

/**
 * Generate a valid semver version string.
 */
const arbVersion = fc.tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 })
).map(([a, b, c]) => `${a}.${b}.${c}`)

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
)

// ── Property tests ───────────────────────────────────────────────────────────

describe('CI Validation Property-Based Tests', () => {

    afterEach(() => {
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true })
            } catch {
                // ignore cleanup errors
            }
        }
        tempDirs.length = 0
    })

    // Feature: mcp-server-externalization, Property 12: CI validation script detects all artifact violations
    describe('Property 12: CI validation script detects all artifact violations', () => {

        /**
         * Validates: Requirements 8.2, 8.4, 8.6, 8.7
         */


        // ── Test 1: Bad manifest schema ──────────────────────────────────

        it('detects manifest schema violations for randomly generated bad manifests', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbManifestViolation,
                (violationType) => {
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

                    assert.ok(
                        errors.length > 0,
                        `Should detect schema violation for "${violationType}" but got no errors`
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

        // ── Test 2: Missing catalogs ─────────────────────────────────────

        it('detects missing catalog files referenced in manifest', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            const arbCatalogName = fc.stringMatching(/^[a-z][a-z0-9\-]{1,15}$/)
                .filter(s => s.length >= 2)

            fc.assert(fc.property(
                fc.array(arbCatalogName, { minLength: 1, maxLength: 4 }),
                (catalogNames) => {
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

                    // Each missing catalog should produce a "not found" error
                    for (const name of uniqueNames) {
                        const hasNotFound = errors.some(e =>
                            e.includes('not found') && e.includes(name)
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

        // ── Test 3: Mismatched name/version ──────────────────────────────

        it('detects mismatched name or version between manifest and package.json', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbName,
                arbName,
                arbVersion,
                arbVersion,
                fc.constantFrom('name', 'version', 'both'),
                (manifestName, pkgName, manifestVersion, pkgVersion, mismatchType) => {
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

                    assert.ok(
                        errors.length > 0,
                        `Should detect mismatched ${mismatchType} but got no errors`
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

        // ── Test 4: Static mode with empty catalogs ──────────────────────

        it('detects static mode with empty catalogs', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbName,
                arbVersion,
                (name, version) => {
                    const dir = createTempServerDir()
                    const serverName = 'test-server'

                    const manifest = validManifest({
                        name,
                        version,
                        modes: { static: true, smart: false, discover: false },
                        catalogs: {}
                    })
                    writeJSON(dir, 'manifest.json', manifest)
                    writeJSON(dir, 'package.json', validPackageJson({ name, version }))

                    const errors = validateServer(dir, serverName)

                    assert.ok(
                        errors.length > 0,
                        'Should detect static mode with empty catalogs but got no errors'
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

        // ── Test 5: Valid server passes ──────────────────────────────────

        it('valid server directory passes validation with no errors', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbName,
                arbVersion,
                (name, version) => {
                    const dir = createTempServerDir()
                    const serverName = 'test-server'

                    // Create a valid server with a regions catalog
                    const catalogsDir = join(dir, 'catalogs')
                    ensureDir(catalogsDir)

                    const manifest = validManifest({
                        name,
                        version,
                        modes: { static: true, smart: false, discover: false },
                        catalogs: {
                            regions: './catalogs/regions.json'
                        }
                    })
                    writeJSON(dir, 'manifest.json', manifest)
                    writeJSON(dir, 'package.json', validPackageJson({ name, version }))
                    writeJSON(catalogsDir, 'regions.json', [validRegionEntry()])

                    const errors = validateServer(dir, serverName)

                    assert.deepStrictEqual(
                        errors,
                        [],
                        `Valid server should have no errors but got: ${JSON.stringify(errors)}`
                    )

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
