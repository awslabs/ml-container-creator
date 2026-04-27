#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Validates all catalog JSON files against their corresponding JSON Schemas.
// Exits non-zero if any catalog entry fails validation.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const root = resolve(__dirname, '..')
const schemasDir = resolve(root, 'servers/lib/schemas')

// Catalog file path → schema file name mapping
const CATALOG_SCHEMA_MAP = [
    {
        catalog: 'servers/base-image-picker/catalogs/model-servers.json',
        schema: 'image-catalog.schema.json',
        label: 'model-servers'
    },
    {
        catalog: 'servers/base-image-picker/catalogs/triton-backends.json',
        schema: 'triton-backends.schema.json',
        label: 'triton-backends'
    },
    {
        catalog: 'servers/instance-recommender/catalogs/instances.json',
        schema: 'instances.schema.json',
        label: 'instances'
    },
    {
        catalog: 'servers/model-picker/catalogs/popular-transformers.json',
        schema: 'model-catalog.schema.json',
        label: 'popular-transformers'
    },
    {
        catalog: 'servers/model-picker/catalogs/popular-diffusors.json',
        schema: 'model-catalog.schema.json',
        label: 'popular-diffusors'
    }
]

function createAjv() {
    const ajv = new Ajv({ allErrors: true })
    addFormats(ajv)
    return ajv
}

/**
 * Validate all catalogs against their schemas.
 * @returns {{ errors: string[], passed: number }}
 */
export function validateCatalogs() {
    const errors = []
    let passed = 0
    const ajv = createAjv()

    // Pre-compile schemas (avoids duplicate $id errors when multiple catalogs share a schema)
    const compiledSchemas = new Map()

    for (const { catalog, schema, label } of CATALOG_SCHEMA_MAP) {
        const catalogPath = resolve(root, catalog)
        const schemaPath = resolve(schemasDir, schema)

        // Check schema file exists
        if (!existsSync(schemaPath)) {
            errors.push(`${label}: schema file not found at ${schema}`)
            continue
        }

        // Check catalog file exists
        if (!existsSync(catalogPath)) {
            errors.push(`${label}: catalog file not found at ${catalog}`)
            continue
        }

        // Compile schema (once per schema file)
        if (!compiledSchemas.has(schema)) {
            let schemaData
            try {
                schemaData = JSON.parse(readFileSync(schemaPath, 'utf8'))
            } catch (err) {
                errors.push(`${label}: schema ${schema} is not valid JSON: ${err.message}`)
                continue
            }
            try {
                compiledSchemas.set(schema, ajv.compile(schemaData))
            } catch (err) {
                errors.push(`${label}: schema ${schema} failed to compile: ${err.message}`)
                continue
            }
        }

        const validate = compiledSchemas.get(schema)
        if (!validate) continue

        // Load catalog
        let catalogData
        try {
            catalogData = JSON.parse(readFileSync(catalogPath, 'utf8'))
        } catch (err) {
            errors.push(`${label}: catalog is not valid JSON: ${err.message}`)
            continue
        }

        // Validate
        if (!validate(catalogData)) {
            for (const err of validate.errors) {
                const entryKey = err.instancePath || '/'
                errors.push(`${label}: ${catalog} ${entryKey} ${err.message}`)
            }
        } else {
            passed++
            console.log(`✓ ${label}: ${catalog} valid`)
        }
    }

    return { errors, passed }
}

// Run when executed directly
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename)
if (isMain) {
    console.log('── Catalog schema validation ──\n')
    const { errors, passed } = validateCatalogs()

    if (errors.length > 0) {
        console.log('')
        for (const err of errors) {
            console.error(`❌ ${err}`)
        }
        console.error(`\n${errors.length} validation error(s) found`)
        process.exit(1)
    } else {
        console.log(`\n✅ All ${passed} catalogs validated successfully`)
        process.exit(0)
    }
}
