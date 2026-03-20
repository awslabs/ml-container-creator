#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// CI validation script for npm namespace policy enforcement.
// Scans all package.json and manifest.json files to verify:
// - Root package uses @aws/ scope
// - Server packages use @amzn/ scope
// - No packages use the legacy @ml-container-creator/ scope
// - Publish safety (private field) is set correctly

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const repoRoot = resolve(__dirname, '..')
const serversRoot = resolve(repoRoot, 'servers')
const rootPkgPath = resolve(repoRoot, 'package.json')

/**
 * Safely parse a JSON file, returning null on failure and pushing an error.
 * @param {string} filePath - Absolute path to the JSON file
 * @param {string[]} errors - Array to push parse errors into
 * @returns {object|null}
 */
function safeParseJson(filePath, errors) {
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
        const rel = relative(repoRoot, filePath)
        errors.push(`${rel}: not valid JSON: ${err.message}`)
        return null
    }
}

/**
 * Validate that the root package.json name starts with @aws/.
 * @param {string} pkgPath - Absolute path to root package.json
 * @returns {string[]} Array of error strings (empty if valid)
 */
export function validateRootNamespace(pkgPath) {
    const errors = []

    if (!existsSync(pkgPath)) {
        errors.push('Root package.json not found')
        return errors
    }

    const pkg = safeParseJson(pkgPath, errors)
    if (!pkg) return errors

    if (!pkg.name) {
        errors.push('Root package.json: missing "name" field')
    } else if (!pkg.name.startsWith('@aws/')) {
        errors.push(`Root package.json: name "${pkg.name}" does not start with @aws/`)
    } else {
        console.log('✓ Root package.json: name starts with @aws/')
    }

    return errors
}

/**
 * Validate that every server pkg name starts with @amzn/.
 * Also validates servers/lib.
 * @param {string} serversDir - Absolute path to the servers/ directory
 * @returns {string[]} Array of error strings (empty if valid)
 */
export function validateServerNamespaces(serversDir) {
    const errors = []

    if (!existsSync(serversDir)) {
        errors.push('servers/ directory not found')
        return errors
    }

    const entries = readdirSync(serversDir)
    for (const entry of entries) {
        const fullPath = resolve(serversDir, entry)
        if (!statSync(fullPath).isDirectory()) continue

        const pkgPath = resolve(fullPath, 'package.json')
        if (!existsSync(pkgPath)) continue

        const pkg = safeParseJson(pkgPath, errors)
        if (!pkg) continue

        const rel = `servers/${entry}/package.json`
        if (!pkg.name) {
            errors.push(`${rel}: missing "name" field`)
        } else if (!pkg.name.startsWith('@amzn/')) {
            errors.push(`${rel}: name "${pkg.name}" does not start with @amzn/`)
        } else {
            console.log(`✓ ${rel}: name starts with @amzn/`)
        }
    }

    return errors
}

/**
 * Validate that every server manifest name starts with @amzn/.
 * @param {string} serversDir - Absolute path to the servers/ directory
 * @returns {string[]} Array of error strings (empty if valid)
 */
export function validateManifestNamespaces(serversDir) {
    const errors = []

    if (!existsSync(serversDir)) {
        errors.push('servers/ directory not found')
        return errors
    }

    const entries = readdirSync(serversDir)
    for (const entry of entries) {
        const fullPath = resolve(serversDir, entry)
        if (!statSync(fullPath).isDirectory()) continue

        const manifestPath = resolve(fullPath, 'manifest.json')
        if (!existsSync(manifestPath)) continue

        const manifest = safeParseJson(manifestPath, errors)
        if (!manifest) continue

        const rel = `servers/${entry}/manifest.json`
        if (!manifest.name) {
            errors.push(`${rel}: missing "name" field`)
        } else if (!manifest.name.startsWith('@amzn/')) {
            errors.push(`${rel}: name "${manifest.name}" does not start with @amzn/`)
        } else {
            console.log(`✓ ${rel}: name starts with @amzn/`)
        }
    }

    return errors
}

/**
 * Validate that no pkg in the repo uses the legacy scope.
 * Scans all package.json files recursively, skipping node_modules and .git.
 * @param {string} root - Absolute path to the repository root
 * @returns {string[]} Array of error strings (empty if valid)
 */
export function validateNoLegacyScope(root) {
    const errors = []
    const legacyScope = '@ml-container-creator/'

    function scanDir(dir) {
        let entries
        try {
            entries = readdirSync(dir)
        } catch {
            return
        }

        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '.git') continue

            const fullPath = resolve(dir, entry)
            let stat
            try {
                stat = statSync(fullPath)
            } catch {
                continue
            }

            if (stat.isDirectory()) {
                scanDir(fullPath)
            } else if (entry === 'package.json') {
                const pkg = safeParseJson(fullPath, errors)
                if (!pkg) continue

                const rel = relative(root, fullPath)
                if (pkg.name && pkg.name.startsWith(legacyScope)) {
                    errors.push(`${rel}: name "${pkg.name}" uses legacy scope ${legacyScope}`)
                }
            }
        }
    }

    scanDir(root)

    if (errors.length === 0) {
        console.log(`✓ No package.json uses legacy scope ${legacyScope}`)
    }

    return errors
}

/**
 * Validate publish safety: server packages must be private, root must not be.
 * @param {string} pkgPath - Absolute path to root package.json
 * @param {string} serversDir - Absolute path to the servers/ directory
 * @returns {string[]} Array of error strings (empty if valid)
 */
export function validatePublishSafety(pkgPath, serversDir) {
    const errors = []

    // Check root package is NOT private
    if (!existsSync(pkgPath)) {
        errors.push('Root package.json not found')
    } else {
        const rootPkg = safeParseJson(pkgPath, errors)
        if (rootPkg) {
            if (rootPkg.private === true) {
                errors.push('Root package.json: must NOT have "private": true (it is published to npm)')
            } else {
                console.log('✓ Root package.json: not marked as private (publishable)')
            }
        }
    }

    // Check all server packages ARE private
    if (!existsSync(serversDir)) {
        errors.push('servers/ directory not found')
        return errors
    }

    const entries = readdirSync(serversDir)
    for (const entry of entries) {
        const fullPath = resolve(serversDir, entry)
        if (!statSync(fullPath).isDirectory()) continue

        const serverPkgPath = resolve(fullPath, 'package.json')
        if (!existsSync(serverPkgPath)) continue

        const pkg = safeParseJson(serverPkgPath, errors)
        if (!pkg) continue

        const rel = `servers/${entry}/package.json`
        if (pkg.private !== true) {
            errors.push(`${rel}: missing "private": true (internal package must not be published)`)
        } else {
            console.log(`✓ ${rel}: marked as private`)
        }
    }

    return errors
}

/**
 * Run all namespace and publish safety validations.
 * @returns {{ errors: string[], checkCount: number }}
 */
export function validateAll() {
    const errors = []
    let checkCount = 0

    console.log('── Namespace validation ──')

    console.log('\n  Root package:')
    const rootErrors = validateRootNamespace(rootPkgPath)
    errors.push(...rootErrors)
    checkCount++

    console.log('\n  Server packages:')
    const serverErrors = validateServerNamespaces(serversRoot)
    errors.push(...serverErrors)
    checkCount++

    console.log('\n  Server manifests:')
    const manifestErrors = validateManifestNamespaces(serversRoot)
    errors.push(...manifestErrors)
    checkCount++

    console.log('\n  Legacy scope scan:')
    const legacyErrors = validateNoLegacyScope(repoRoot)
    errors.push(...legacyErrors)
    checkCount++

    console.log('\n── Publish safety ──')
    const publishErrors = validatePublishSafety(rootPkgPath, serversRoot)
    errors.push(...publishErrors)
    checkCount++

    return { errors, checkCount }
}

// Run when executed directly
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename)
if (isMain) {
    const { errors, checkCount } = validateAll()

    if (errors.length > 0) {
        console.log('')
        for (const err of errors) {
            console.error(`❌ ${err}`)
        }
        console.error(`\n${errors.length} validation error(s) found`)
        process.exit(1)
    } else {
        console.log(`\n✅ All ${checkCount} namespace checks passed`)
        process.exit(0)
    }
}
