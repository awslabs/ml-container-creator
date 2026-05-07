#!/usr/bin/env node
/**
 * Migration script: Enrich model-servers.json with operational metadata from frameworks.js
 * 
 * For each framework key in frameworks.js, locates the corresponding Image_Entry array
 * in model-servers.json and adds: defaults, accelerator, validationLevel, profiles, notes
 * 
 * Preserves all existing Image_Entry fields without modification.
 */

import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

// Load the complete model-servers.json from git (since working copy is truncated)
const catalogJson = execSync('git show 235b7c3:servers/base-image-picker/catalogs/model-servers.json', { encoding: 'utf8' })
const catalog = JSON.parse(catalogJson)

// Import frameworks registry (legacy path - this script was a one-time migration utility)
// The frameworks registry no longer exists as a standalone file; data lives in server catalogs.
const frameworksModule = await import('../generators/app/config/registries/frameworks.js')
const frameworks = frameworksModule.default

// For each framework in the registry, get the latest version's metadata
function getLatestVersionConfig(frameworkVersions) {
    const versions = Object.keys(frameworkVersions)
    // Sort versions descending (latest first)
    versions.sort((a, b) => {
        const partsA = a.split('.').map(Number)
        const partsB = b.split('.').map(Number)
        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const diff = (partsB[i] || 0) - (partsA[i] || 0)
            if (diff !== 0) return diff
        }
        return 0
    })
    return frameworkVersions[versions[0]]
}

// Build the enriched catalog
const enrichedCatalog = {}

for (const [frameworkKey, entries] of Object.entries(catalog)) {
    if (!frameworks[frameworkKey]) {
        // Framework not in registry - keep entries as-is
        enrichedCatalog[frameworkKey] = entries
        continue
    }

    const frameworkVersions = frameworks[frameworkKey]
    const latestConfig = getLatestVersionConfig(frameworkVersions)

    enrichedCatalog[frameworkKey] = entries.map(entry => {
        // Try to find a version-specific config by matching framework_version label
        const fwVersion = entry.labels?.framework_version
        let config = latestConfig

        // Check if there's an exact version match in the registry
        if (fwVersion) {
            for (const [regVersion, regConfig] of Object.entries(frameworkVersions)) {
                if (fwVersion === regVersion || fwVersion.startsWith(regVersion)) {
                    config = regConfig
                    break
                }
            }
        }

        // Build the enrichment fields
        const enrichment = {}

        // defaults
        enrichment.defaults = {
            envVars: config.envVars || {},
            inferenceAmiVersion: config.inferenceAmiVersion || '',
            recommendedInstanceTypes: config.recommendedInstanceTypes || []
        }

        // accelerator
        if (config.accelerator) {
            enrichment.accelerator = {
                type: config.accelerator.type,
                version: config.accelerator.version,
                versionRange: {
                    min: config.accelerator.versionRange.min,
                    max: config.accelerator.versionRange.max
                }
            }
        }

        // validationLevel
        enrichment.validationLevel = config.validationLevel || 'untested'

        // profiles (if present)
        if (config.profiles) {
            enrichment.profiles = {}
            for (const [profileName, profileConfig] of Object.entries(config.profiles)) {
                const profileEntry = {
                    displayName: profileConfig.displayName,
                    description: profileConfig.description,
                    envVars: profileConfig.envVars || {}
                }
                if (profileConfig.recommendedInstanceTypes) {
                    profileEntry.recommendedInstanceTypes = profileConfig.recommendedInstanceTypes
                }
                if (profileConfig.notes) {
                    profileEntry.notes = profileConfig.notes
                }
                enrichment.profiles[profileName] = profileEntry
            }
        }

        // notes
        enrichment.notes = config.notes || ''

        // Return entry with existing fields preserved + new fields added
        return {
            ...entry,
            ...enrichment
        }
    })
}

// Now add triton-* frameworks that exist in the registry but not in the catalog
// These need Image_Entry arrays created from the registry data
for (const [frameworkKey, frameworkVersions] of Object.entries(frameworks)) {
    if (enrichedCatalog[frameworkKey]) continue // Already handled

    // Create Image_Entry arrays for frameworks only in the registry
    enrichedCatalog[frameworkKey] = []
    
    for (const [version, config] of Object.entries(frameworkVersions)) {
        const entry = {
            image: config.baseImage,
            tag: version,
            architecture: 'amd64',
            created: new Date().toISOString().split('T')[0] + 'T00:00:00Z',
            labels: {
                cuda_version: config.accelerator?.version || '',
                python_version: '3.10',
                framework_version: version
            },
            registry: config.baseImage.includes('nvcr.io') ? 'ngc' : 
                      config.baseImage.includes('ecr') ? 'ecr' : 'dockerhub',
            repository: config.baseImage.split(':')[0],
            defaults: {
                envVars: config.envVars || {},
                inferenceAmiVersion: config.inferenceAmiVersion || '',
                recommendedInstanceTypes: config.recommendedInstanceTypes || []
            },
            accelerator: config.accelerator ? {
                type: config.accelerator.type,
                version: config.accelerator.version,
                versionRange: {
                    min: config.accelerator.versionRange.min,
                    max: config.accelerator.versionRange.max
                }
            } : undefined,
            validationLevel: config.validationLevel || 'untested',
            notes: config.notes || ''
        }

        // Add profiles if present
        if (config.profiles) {
            entry.profiles = {}
            for (const [profileName, profileConfig] of Object.entries(config.profiles)) {
                const profileEntry = {
                    displayName: profileConfig.displayName,
                    description: profileConfig.description,
                    envVars: profileConfig.envVars || {}
                }
                if (profileConfig.recommendedInstanceTypes) {
                    profileEntry.recommendedInstanceTypes = profileConfig.recommendedInstanceTypes
                }
                if (profileConfig.notes) {
                    profileEntry.notes = profileConfig.notes
                }
                entry.profiles[profileName] = profileEntry
            }
        }

        enrichedCatalog[frameworkKey].push(entry)
    }
}

// Write the enriched catalog
const output = JSON.stringify(enrichedCatalog, null, 4)
writeFileSync('servers/base-image-picker/catalogs/model-servers.json', output + '\n')

console.log('Enriched model-servers.json successfully!')
console.log('Framework keys:', Object.keys(enrichedCatalog))
for (const [key, entries] of Object.entries(enrichedCatalog)) {
    console.log(`  ${key}: ${entries.length} entries`)
}
