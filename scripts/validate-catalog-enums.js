#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI validation script for catalog enum values against AWS service models.
 * Loads the SageMaker service model from the schema registry and validates
 * that catalog entries in model-servers.json use valid enum values.
 *
 * Exit codes:
 *   0 — all catalog entries valid
 *   1 — one or more invalid enum values found
 *   2 — validation could not run (registry missing, parse failure)
 *
 * Requirements: 14.4
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ServiceModelParser from '../src/lib/service-model-parser.js'
import CatalogValidator from '../src/lib/validators/catalog-validator.js'
import { getRegistryPath, loadServiceModel } from '../src/lib/schema-sync.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const root = resolve(__dirname, '..')
const catalogPath = resolve(root, 'servers/lib/catalogs/model-servers.json')

async function main() {
    console.log('── Catalog enum validation (service model) ──\n')

    // Load the SageMaker service model from the registry
    const registryPath = getRegistryPath()

    if (!existsSync(registryPath)) {
        console.log('⚠️  Schema registry not found. Run `ml-container-creator bootstrap sync-schemas` to set up.')
        console.log('   Skipping catalog enum validation.')
        process.exit(0)
    }

    const rawModel = loadServiceModel('sagemaker', registryPath)
    if (!rawModel) {
        console.log('⚠️  SageMaker service model not found in registry. Run `ml-container-creator bootstrap sync-schemas`.')
        console.log('   Skipping catalog enum validation.')
        process.exit(0)
    }

    let parsedModel
    try {
        const parser = new ServiceModelParser()
        parsedModel = parser.parse(JSON.parse(rawModel))
    } catch (err) {
        console.error(`❌ Failed to parse SageMaker service model: ${err.message}`)
        process.exit(2)
    }

    // Load the catalog
    if (!existsSync(catalogPath)) {
        console.error(`❌ Catalog file not found: ${catalogPath}`)
        process.exit(2)
    }

    // Run the catalog validator
    const validator = new CatalogValidator()
    const findings = await validator.validate({}, {
        serviceModels: [parsedModel],
        catalogPath
    })

    if (findings.length === 0) {
        console.log(`✅ All catalog entries in model-servers.json have valid enum values`)
        process.exit(0)
    }

    // Report errors
    for (const finding of findings) {
        console.error(`❌ ${finding.entryKey}: ${finding.fieldName} = "${finding.invalidValue}"`)
        console.error(`   Valid values: ${finding.constraint.values.join(', ')}`)
        console.error('')
    }

    console.error(`${findings.length} catalog enum error(s) found`)
    process.exit(1)
}

main().catch(err => {
    console.error(`❌ Unexpected error: ${err.message}`)
    process.exit(2)
})
