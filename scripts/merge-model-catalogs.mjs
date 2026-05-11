#!/usr/bin/env node

/**
 * Merge script for creating the unified model catalog (models.json).
 *
 * Reads three source catalogs:
 *   - servers/lib/catalogs/model-sizes.json
 *   - servers/lib/catalogs/popular-transformers.json
 *   - servers/lib/catalogs/popular-diffusors.json
 *
 * Merges fields per model ID (union of all fields from each source),
 * derives `modelType`, `tasks`, and ensures `architecture` is present.
 *
 * Writes output to servers/lib/catalogs/models.json
 *
 * Requirements: 2.1, 2.2, 2.3, 2.7, 2.8, 2.9
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CATALOGS_DIR = resolve(ROOT, 'servers/lib/catalogs')

// --- Load source catalogs ---

const modelSizesRaw = JSON.parse(
    readFileSync(resolve(CATALOGS_DIR, 'model-sizes.json'), 'utf-8')
)
const modelSizes = modelSizesRaw.models || modelSizesRaw

const popularTransformers = JSON.parse(
    readFileSync(resolve(CATALOGS_DIR, 'popular-transformers.json'), 'utf-8')
)

const popularDiffusors = JSON.parse(
    readFileSync(resolve(CATALOGS_DIR, 'popular-diffusors.json'), 'utf-8')
)

// --- Utility: glob-style wildcard matching ---

/**
 * Convert a glob pattern (with * wildcards) to a RegExp.
 * Only supports * as a wildcard (matches any characters).
 */
function globToRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    const regexStr = '^' + escaped.replace(/\*/g, '.*') + '$'
    return new RegExp(regexStr)
}

/**
 * Check if a model ID matches a pattern (exact or glob).
 */
function matchesPattern(modelId, pattern) {
    if (modelId === pattern) return true
    if (!pattern.includes('*')) return false
    return globToRegex(pattern).test(modelId)
}

/**
 * Find the best matching model-sizes entry for a given model ID.
 * Prefers exact matches, then the most specific glob match (longest pattern).
 */
function findModelSizeEntry(modelId, modelSizesMap) {
    // Exact match first
    if (modelSizesMap[modelId]) {
        return modelSizesMap[modelId]
    }

    // Find glob matches, prefer the most specific (longest pattern)
    let bestMatch = null
    let bestLength = 0

    for (const [pattern, entry] of Object.entries(modelSizesMap)) {
        if (pattern.includes('*') && matchesPattern(modelId, pattern)) {
            if (pattern.length > bestLength) {
                bestMatch = entry
                bestLength = pattern.length
            }
        }
    }

    return bestMatch
}

// --- Field mapping from source keys to unified keys ---

// popular-transformers and popular-diffusors use snake_case for some fields;
// the unified catalog uses camelCase per the design schema.
function normalizeFields(entry) {
    const normalized = { ...entry }

    // chat_template → chatTemplate
    if ('chat_template' in normalized) {
        normalized.chatTemplate = normalized.chat_template
        delete normalized.chat_template
    }

    // framework_compatibility → frameworkCompatibility
    if ('framework_compatibility' in normalized) {
        normalized.frameworkCompatibility = normalized.framework_compatibility
        delete normalized.framework_compatibility
    }

    // validation_level → validationLevel
    if ('validation_level' in normalized) {
        normalized.validationLevel = normalized.validation_level
        delete normalized.validation_level
    }

    return normalized
}

// --- Derive tasks from tags and pipeline info ---

function deriveTasks(entry) {
    const tasks = new Set()

    // Derive from tags
    if (Array.isArray(entry.tags)) {
        for (const tag of entry.tags) {
            if (tag === 'text-generation' || tag === 'conversational') {
                tasks.add('text-generation')
            }
            if (tag === 'code') {
                tasks.add('text-generation')
            }
            if (tag === 'image-generation') {
                tasks.add('text-to-image')
            }
            if (tag === 'video-generation') {
                tasks.add('text-to-video')
            }
        }
    }

    // Derive from pipeline field if present
    if (entry.pipeline) {
        if (entry.pipeline.includes('text-to-image') || entry.pipeline.includes('StableDiffusion')) {
            tasks.add('text-to-image')
        }
        if (entry.pipeline.includes('text-to-video')) {
            tasks.add('text-to-video')
        }
    }

    return [...tasks]
}

// --- Build unified catalog ---

const unified = {}

// Track which model-sizes keys have been consumed via glob matching
const consumedModelSizeKeys = new Set()

// 1. Process popular-transformers (sets modelType = "transformer")
for (const [modelId, rawEntry] of Object.entries(popularTransformers)) {
    const entry = normalizeFields(rawEntry)
    unified[modelId] = {
        ...entry,
        modelType: 'transformer'
    }

    // Try to merge model-sizes data via wildcard matching
    const sizeEntry = findModelSizeEntry(modelId, modelSizes)
    if (sizeEntry) {
        const { recommendedInstances, minVramGb, ...sizeFields } = sizeEntry
        unified[modelId] = { ...unified[modelId], ...sizeFields }
        // Mark the matching key as consumed
        for (const [pattern] of Object.entries(modelSizes)) {
            if (matchesPattern(modelId, pattern)) {
                consumedModelSizeKeys.add(pattern)
            }
        }
    }
}

// 2. Process popular-diffusors (sets modelType = "diffusor")
for (const [modelId, rawEntry] of Object.entries(popularDiffusors)) {
    const entry = normalizeFields(rawEntry)
    if (unified[modelId]) {
        // Merge: union fields from diffusor source into existing entry
        unified[modelId] = { ...unified[modelId], ...entry, modelType: 'diffusor' }
    } else {
        unified[modelId] = { ...entry, modelType: 'diffusor' }
    }

    // Try to merge model-sizes data via wildcard matching
    const sizeEntry = findModelSizeEntry(modelId, modelSizes)
    if (sizeEntry) {
        const { recommendedInstances, minVramGb, ...sizeFields } = sizeEntry
        unified[modelId] = { ...unified[modelId], ...sizeFields }
        for (const [pattern] of Object.entries(modelSizes)) {
            if (matchesPattern(modelId, pattern)) {
                consumedModelSizeKeys.add(pattern)
            }
        }
    }
}

// 3. Process remaining model-sizes entries that weren't consumed by transformer/diffusor matching.
//    These are kept as their own entries (they may be wildcard patterns themselves that serve
//    as fallback sizing data). Models only in model-sizes get modelType = "transformer" since
//    they are LLM architectures (LlamaForCausalLM, MistralForCausalLM, etc.) that just lack
//    a popular-transformers entry.
for (const [modelId, rawEntry] of Object.entries(modelSizes)) {
    if (consumedModelSizeKeys.has(modelId)) continue
    if (unified[modelId]) continue

    const { recommendedInstances, minVramGb, ...entry } = rawEntry

    // Determine modelType: these are LLM architectures, so "transformer"
    // (predictor would be for sklearn/xgboost/etc. which aren't in model-sizes)
    unified[modelId] = { ...entry, modelType: 'transformer' }
}

// 4. Derive tasks and ensure architecture for all entries
for (const [modelId, entry] of Object.entries(unified)) {
    // Ensure architecture field exists (may be null for wildcard/fallback entries)
    if (!('architecture' in entry)) {
        entry.architecture = null
    }

    // Derive tasks
    const derivedTasks = deriveTasks(entry)
    if (derivedTasks.length > 0) {
        entry.tasks = derivedTasks
    } else {
        // Fallback based on modelType
        if (entry.modelType === 'transformer') {
            entry.tasks = ['text-generation']
        } else if (entry.modelType === 'diffusor') {
            entry.tasks = ['text-to-image']
        } else {
            entry.tasks = ['prediction']
        }
    }

    // Remove recommendedInstanceTypes from profiles if present
    if (entry.profiles) {
        for (const profileKey of Object.keys(entry.profiles)) {
            delete entry.profiles[profileKey].recommendedInstanceTypes
        }
    }

    unified[modelId] = entry
}

// --- Write output ---

const outputPath = resolve(CATALOGS_DIR, 'models.json')
writeFileSync(outputPath, JSON.stringify(unified, null, 4) + '\n', 'utf-8')

const modelCount = Object.keys(unified).length
const transformerCount = Object.values(unified).filter(e => e.modelType === 'transformer').length
const diffusorCount = Object.values(unified).filter(e => e.modelType === 'diffusor').length
const predictorCount = Object.values(unified).filter(e => e.modelType === 'predictor').length

console.log(`✅ Unified model catalog written to: ${outputPath}`)
console.log(`   Total models: ${modelCount}`)
console.log(`   Transformers: ${transformerCount}`)
console.log(`   Diffusors:    ${diffusorCount}`)
console.log(`   Predictors:   ${predictorCount}`)
