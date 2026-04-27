#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// CI validation script for MCP server artifacts.
// Scans servers/ directories and validates manifests, catalogs, schemas,
// and tool name uniqueness across all bundled servers.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const serversRoot = resolve(__dirname, '../servers')
const schemasDir = resolve(serversRoot, 'lib/schemas')

// Load all schemas
const manifestSchema = JSON.parse(readFileSync(resolve(schemasDir, 'manifest.schema.json'), 'utf8'))
const imageCatalogSchema = JSON.parse(readFileSync(resolve(schemasDir, 'image-catalog.schema.json'), 'utf8'))
const instancesSchema = JSON.parse(readFileSync(resolve(schemasDir, 'instances.schema.json'), 'utf8'))
const regionsSchema = JSON.parse(readFileSync(resolve(schemasDir, 'regions.schema.json'), 'utf8'))
const tritonBackendsSchema = JSON.parse(readFileSync(resolve(schemasDir, 'triton-backends.schema.json'), 'utf8'))
const modelCatalogSchema = JSON.parse(readFileSync(resolve(schemasDir, 'model-catalog.schema.json'), 'utf8'))

// Catalog name → schema mapping
const CATALOG_SCHEMA_MAP = {
    'model-servers': imageCatalogSchema,
    'python-slim': imageCatalogSchema,
    'triton-backends': tritonBackendsSchema,
    'instances': instancesSchema,
    'regions': regionsSchema,
    'popular-transformers': modelCatalogSchema,
    'popular-diffusors': modelCatalogSchema
}

function createAjv() {
    const ajv = new Ajv({ allErrors: true })
    addFormats(ajv)
    return ajv
}

/**
 * Validate that all .schema.json files in lib/schemas/ are valid JSON Schema.
 * @returns {string[]} Array of error strings (empty if all valid)
 */
export function validateSchemas() {
    const errors = []

    if (!existsSync(schemasDir)) {
        errors.push('lib/schemas/ directory not found')
        return errors
    }

    const ajv = createAjv()
    const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'))

    if (schemaFiles.length === 0) {
        errors.push('lib/schemas/ contains no .schema.json files')
        return errors
    }

    for (const file of schemaFiles) {
        const filePath = resolve(schemasDir, file)

        // Check it's valid JSON
        let schema
        try {
            schema = JSON.parse(readFileSync(filePath, 'utf8'))
        } catch (err) {
            errors.push(`lib/schemas/${file}: not valid JSON: ${err.message}`)
            continue
        }

        // Check it compiles as a valid JSON Schema
        try {
            ajv.compile(schema)
            console.log(`✓ lib/schemas/${file}: valid JSON Schema`)
        } catch (err) {
            errors.push(`lib/schemas/${file}: invalid JSON Schema: ${err.message}`)
        }
    }

    return errors
}

/**
 * Validate a single server directory.
 * @param {string} serverDir - Absolute path to the server directory
 * @param {string} serverName - Name of the server directory (e.g. 'base-image-picker')
 * @returns {string[]} Array of error strings (empty if valid)
 */
export function validateServer(serverDir, serverName) {
    const errors = []
    const ajv = createAjv()

    // 1. Load and validate manifest.json against manifest schema
    const manifestPath = resolve(serverDir, 'manifest.json')
    if (!existsSync(manifestPath)) {
        errors.push(`${serverName}: manifest.json not found`)
        return errors
    }

    let manifest
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
        errors.push(`${serverName}: manifest.json is not valid JSON: ${err.message}`)
        return errors
    }

    const validateManifest = ajv.compile(manifestSchema)
    if (!validateManifest(manifest)) {
        for (const err of validateManifest.errors) {
            errors.push(`${serverName}: manifest.json schema violation: ${err.instancePath} ${err.message}`)
        }
    } else {
        console.log(`✓ ${serverName}: manifest.json valid`)
    }

    // 2. Verify name and version match package.json
    const pkgPath = resolve(serverDir, 'package.json')
    if (!existsSync(pkgPath)) {
        errors.push(`${serverName}: package.json not found`)
    } else {
        let pkg
        try {
            pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        } catch (err) {
            errors.push(`${serverName}: package.json is not valid JSON: ${err.message}`)
        }

        if (pkg) {
            if (manifest.name !== pkg.name) {
                errors.push(`${serverName}: manifest.json name "${manifest.name}" does not match package.json name "${pkg.name}"`)
            }
            if (manifest.version !== pkg.version) {
                errors.push(`${serverName}: manifest.json version "${manifest.version}" does not match package.json version "${pkg.version}"`)
            }
            if (manifest.name === pkg.name && manifest.version === pkg.version) {
                console.log(`✓ ${serverName}: name/version match package.json`)
            }
        }
    }

    // 3. Validate each catalog entry
    const catalogs = manifest.catalogs || {}
    for (const [catalogName, catalogRelPath] of Object.entries(catalogs)) {
        const catalogFullPath = resolve(serverDir, catalogRelPath)

        // Check file exists
        if (!existsSync(catalogFullPath)) {
            errors.push(`${serverName}: catalog "${catalogName}" file not found at ${catalogRelPath}`)
            continue
        }

        // Load catalog data
        let catalogData
        try {
            catalogData = JSON.parse(readFileSync(catalogFullPath, 'utf8'))
        } catch (err) {
            errors.push(`${serverName}: catalog "${catalogName}" is not valid JSON: ${err.message}`)
            continue
        }

        // Validate against corresponding schema
        const schema = CATALOG_SCHEMA_MAP[catalogName]
        if (!schema) {
            console.log(`✓ ${serverName}: catalog "${catalogName}" exists (no schema to validate against)`)
            continue
        }

        const validateCatalog = ajv.compile(schema)
        if (!validateCatalog(catalogData)) {
            for (const err of validateCatalog.errors) {
                errors.push(`${serverName}: catalog "${catalogName}" failed schema validation: ${err.instancePath} ${err.message}`)
            }
        } else {
            console.log(`✓ ${serverName}: catalog "${catalogName}" exists and valid`)
        }
    }

    // 4. If modes.static === true, verify catalogs is non-empty
    if (manifest.modes && manifest.modes.static === true) {
        if (Object.keys(catalogs).length === 0) {
            errors.push(`${serverName}: modes.static is true but catalogs is empty`)
        } else {
            console.log(`✓ ${serverName}: static mode has catalogs`)
        }
    }

    return errors
}

/**
 * Check for tool name collisions across all server manifests.
 * @param {Map<string, string>} toolMap - Map of tool name → server name
 * @returns {string[]} Array of error strings (empty if no collisions)
 */
export function validateToolUniqueness(toolMap) {
    const errors = []
    const seen = new Map()

    for (const [toolName, serverName] of toolMap) {
        if (seen.has(toolName)) {
            errors.push(`Tool name collision: "${toolName}" is defined by both "${seen.get(toolName)}" and "${serverName}"`)
        } else {
            seen.set(toolName, serverName)
        }
    }

    if (errors.length === 0 && toolMap.size > 0) {
        console.log(`✓ All ${toolMap.size} tool names are unique across servers`)
    }

    return errors
}

/**
 * Validate all server directories under servers/.
 * @returns {{ errors: string[], serverCount: number }}
 */
export function validateAllServers() {
    const errors = []
    let serverCount = 0
    const toolMap = new Map()

    // Phase 1: Validate all schemas in lib/schemas/
    console.log('── Schema validation ──')
    errors.push(...validateSchemas())

    // Phase 2: Validate each server
    console.log('\n── Server validation ──')
    const entries = readdirSync(serversRoot)
    for (const entry of entries) {
        // Skip non-directories and the shared lib/ directory
        const fullPath = resolve(serversRoot, entry)
        if (!statSync(fullPath).isDirectory()) continue
        if (entry === 'lib') continue

        // Must have a package.json to be considered a server
        if (!existsSync(resolve(fullPath, 'package.json'))) continue

        serverCount++
        console.log(`\n  ${entry}/`)
        const serverErrors = validateServer(fullPath, entry)
        errors.push(...serverErrors)

        // Collect tool name for uniqueness check
        const manifestPath = resolve(fullPath, 'manifest.json')
        if (existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
                if (manifest.tool && manifest.tool.name) {
                    toolMap.set(manifest.tool.name, entry)
                }
            } catch {
                // Already reported by validateServer
            }
        }
    }

    // Phase 3: Check tool name uniqueness across all servers
    console.log('\n── Tool uniqueness ──')
    errors.push(...validateToolUniqueness(toolMap))

    return { errors, serverCount }
}

// Run when executed directly
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename)
if (isMain) {
    const { errors, serverCount } = validateAllServers()

    if (errors.length > 0) {
        console.log('')
        for (const err of errors) {
            console.error(`❌ ${err}`)
        }
        console.error(`\n${errors.length} validation error(s) found`)
        process.exit(1)
    } else {
        console.log(`\n✅ All ${serverCount} servers validated successfully`)
        process.exit(0)
    }
}
