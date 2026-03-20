// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment Registry
 *
 * Core data-access module for the deployment registry system.
 * Handles CRUD, search, import/export, and schema validation
 * for deployment entries stored as JSON files.
 *
 * Registry file format:
 * {
 *   "schemaVersion": "2026-03-20",
 *   "entries": [ ...Deployment_Entry objects ]
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import Ajv from 'ajv'
import { minimatch } from 'minimatch'
import deploymentEntrySchema from '../config/schemas/deployment-entry-schema.js'

const CURRENT_SCHEMA_VERSION = '2026-03-20'

export default class DeploymentRegistry {
    /**
     * @param {string} registryPath - Absolute path to the registry JSON file
     */
    constructor(registryPath) {
        this.registryPath = registryPath
        this._ajv = new Ajv({ allErrors: true, strict: false })
        this._validate = this._ajv.compile(deploymentEntrySchema)
    }

    /**
     * Read the registry file and return the entries array.
     *
     * Handles:
     * - Missing file → return []
     * - Invalid JSON → throw with descriptive message
     * - Missing/unrecognized schemaVersion → console.warn + best-effort
     *
     * @returns {Array<Object>} entries array
     */
    _readRegistry() {
        if (!existsSync(this.registryPath)) {
            return []
        }

        const raw = readFileSync(this.registryPath, 'utf8')

        let data
        try {
            data = JSON.parse(raw)
        } catch (err) {
            throw new Error(`Invalid JSON in registry file ${this.registryPath}: ${err.message}`)
        }

        const migrated = this._migrateIfNeeded(data)

        if (!migrated.schemaVersion) {
            console.warn(`Warning: Registry file ${this.registryPath} has no schemaVersion. Attempting best-effort read.`)
        } else if (migrated.schemaVersion !== CURRENT_SCHEMA_VERSION) {
            console.warn(`Warning: Registry file ${this.registryPath} has unrecognized schemaVersion "${migrated.schemaVersion}". Attempting best-effort read.`)
        }

        return Array.isArray(migrated.entries) ? migrated.entries : []
    }

    /**
     * Write entries to the registry file wrapped in a versioned envelope.
     *
     * Creates parent directories if they don't exist.
     * Uses 2-space indentation and a trailing newline.
     *
     * @param {Array<Object>} entries - The entries array to write
     */
    _writeRegistry(entries) {
        const dir = dirname(this.registryPath)
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        const envelope = {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            entries
        }

        writeFileSync(this.registryPath, JSON.stringify(envelope, null, 2) + '\n')
    }

    /**
     * Generate an 8-character hex ID from a hash of the entry's timestamp
     * and deploymentConfig. Retries with random entropy on collision.
     *
     * @param {Object} entry - The deployment entry
     * @param {Array<Object>} [existingEntries] - Existing entries to check for collisions
     * @returns {string} 8-character hex string
     */
    _generateId(entry, existingEntries = []) {
        const baseInput = `${entry.timestamp}:${entry.deployment.deploymentConfig}`
        let id = createHash('sha256').update(baseInput).digest('hex').slice(0, 8)

        const existingIds = new Set(existingEntries.map(e => e.id))

        while (existingIds.has(id)) {
            const entropy = Math.random().toString(36).slice(2)
            id = createHash('sha256').update(baseInput + entropy).digest('hex').slice(0, 8)
        }

        return id
    }

    /**
     * Validate an entry against the deployment entry schema using ajv.
     *
     * @param {Object} entry - The entry to validate
     * @returns {{ valid: boolean, errors: Array|null }} Validation result
     */
    _validateEntry(entry) {
        const valid = this._validate(entry)
        return {
            valid: !!valid,
            errors: valid ? null : this._validate.errors
        }
    }

    /**
     * Migrate old registry formats to the current versioned envelope.
     *
     * Handles:
     * - Plain arrays (legacy format) → wrap in envelope
     * - Already-enveloped data → return as-is
     *
     * @param {*} data - Parsed JSON data from the registry file
     * @returns {{ schemaVersion: string|undefined, entries: Array }}
     */
    _migrateIfNeeded(data) {
        // Legacy format: plain array of entries
        if (Array.isArray(data)) {
            return {
                schemaVersion: CURRENT_SCHEMA_VERSION,
                entries: data
            }
        }

        // Already an envelope with schemaVersion and entries
        if (data && typeof data === 'object' && 'entries' in data) {
            return data
        }

        // Unknown format — wrap in envelope with empty entries
        return {
            schemaVersion: undefined,
            entries: []
        }
    }

    /**
     * Add a new deployment entry to the registry.
     *
     * Validates the entry against the schema, generates a unique ID,
     * reads existing entries, appends the new entry, and writes back.
     *
     * @param {Object} entry - The deployment entry (without id)
     * @returns {string} The generated 8-character hex ID
     * @throws {Error} If the entry fails schema validation
     */
    add(entry) {
        const existingEntries = this._readRegistry()
        const id = this._generateId(entry, existingEntries)

        const fullEntry = { ...entry, id }

        const { valid, errors } = this._validateEntry(fullEntry)
        if (!valid) {
            const details = errors.map(e => `${e.instancePath || '/'} ${e.message}`).join(', ')
            throw new Error(`Validation failed: ${details}`)
        }

        existingEntries.push(fullEntry)
        this._writeRegistry(existingEntries)

        return id
    }

    /**
     * Get a deployment entry by its ID.
     *
     * @param {string} id - The entry ID to look up
     * @returns {Object|null} The matching entry, or null if not found
     */
    get(id) {
        const entries = this._readRegistry()
        return entries.find(e => e.id === id) || null
    }

    /**
     * Remove a deployment entry by its ID.
     *
     * @param {string} id - The entry ID to remove
     * @returns {boolean} true if an entry was removed, false if not found
     */
    remove(id) {
        const entries = this._readRegistry()
        const filtered = entries.filter(e => e.id !== id)

        if (filtered.length === entries.length) {
            return false
        }

        this._writeRegistry(filtered)
        return true
    }

    /**
     * Check whether an entry matches all provided filters (AND logic).
     *
     * Supported filter keys:
     * - backend: exact match on deployment.backend
     * - architecture: exact match on deployment.architecture
     * - model: substring match on model.modelName (case-insensitive)
     * - 'instance-type': exact match on infrastructure.instanceType
     * - status: exact match on status
     *
     * @param {Object} entry - The deployment entry to test
     * @param {Object} filters - Key-value pairs of filter criteria
     * @returns {boolean} true if the entry matches all filters
     */
    _matchesFilters(entry, filters) {
        if (!filters || typeof filters !== 'object') {
            return true
        }

        for (const [key, value] of Object.entries(filters)) {
            if (value === undefined || value === null) {
                continue
            }

            switch (key) {
                case 'backend':
                    if (entry.deployment?.backend !== value) return false
                    break
                case 'architecture':
                    if (entry.deployment?.architecture !== value) return false
                    break
                case 'model':
                    if (!entry.model?.modelName?.toLowerCase().includes(value.toLowerCase())) return false
                    break
                case 'instance-type':
                    if (entry.infrastructure?.instanceType !== value) return false
                    break
                case 'status':
                    if (entry.status !== value) return false
                    break
                default:
                    break
            }
        }

        return true
    }

    /**
     * List entries from the registry, optionally filtered.
     *
     * Reads all entries and returns those matching every provided filter
     * using AND logic.
     *
     * @param {Object} [filters] - Optional filter criteria
     * @returns {Array<Object>} Matching entries
     */
    list(filters) {
        const entries = this._readRegistry()

        if (!filters || Object.keys(filters).length === 0) {
            return entries
        }

        return entries.filter(entry => this._matchesFilters(entry, filters))
    }

    /**
     * Search entries using glob-based model matching and standard filters.
     *
     * Similar to list(), but the `model` filter uses glob pattern matching
     * (via minimatch) instead of substring matching.
     *
     * @param {Object} [query] - Search criteria; `model` supports glob patterns
     * @returns {Array<Object>} Matching entries
     */
    search(query) {
        const entries = this._readRegistry()

        if (!query || Object.keys(query).length === 0) {
            return entries
        }

        return entries.filter(entry => {
            for (const [key, value] of Object.entries(query)) {
                if (value === undefined || value === null) {
                    continue
                }

                switch (key) {
                    case 'model':
                        if (!entry.model?.modelName || !minimatch(entry.model.modelName, value)) return false
                        break
                    case 'backend':
                        if (entry.deployment?.backend !== value) return false
                        break
                    case 'architecture':
                        if (entry.deployment?.architecture !== value) return false
                        break
                    case 'instance-type':
                        if (entry.infrastructure?.instanceType !== value) return false
                        break
                    case 'status':
                        if (entry.status !== value) return false
                        break
                    default:
                        break
                }
            }

            return true
        })
    }

    /**
     * Strip sensitive fields from a deployment entry.
     *
     * Returns a deep-cloned copy with the following fields removed:
     * - infrastructure.roleArn
     * - infrastructure.region
     * - configuration.parameters.HF_TOKEN
     * - configuration.parameters.NGC_API_KEY
     *
     * The original entry is not mutated.
     *
     * @param {Object} entry - The deployment entry to sanitize
     * @returns {Object} A sanitized deep copy of the entry
     */
    _stripSensitiveFields(entry) {
        const copy = JSON.parse(JSON.stringify(entry))

        if (copy.infrastructure) {
            delete copy.infrastructure.roleArn
            delete copy.infrastructure.region
        }

        if (copy.configuration?.parameters) {
            delete copy.configuration.parameters.HF_TOKEN
            delete copy.configuration.parameters.NGC_API_KEY
        }

        return copy
    }

    /**
     * Export deployment entries in the standard Export_Format.
     *
     * If an id is provided, exports only that single entry.
     * Otherwise exports all entries matching the status filter.
     * By default, only entries with status "success" are exported.
     * All exported entries have sensitive fields stripped.
     *
     * @param {string|null} [id] - Optional entry ID to export a single entry
     * @param {Object} [options] - Export options
     * @param {string} [options.status] - Status filter override (default: 'success')
     * @returns {Object} Export_Format object with version, exportedAt, exportedBy, entries
     */
    exportEntries(id, options = {}) {
        const entries = this._readRegistry()
        const statusFilter = options.status || 'success'

        let filtered
        if (id) {
            const entry = entries.find(e => e.id === id)
            filtered = entry ? [entry] : []
        } else {
            filtered = entries.filter(e => e.status === statusFilter)
        }

        const sanitized = filtered.map(e => this._stripSensitiveFields(e))

        return {
            version: '1.0',
            exportedAt: new Date().toISOString(),
            exportedBy: 'anonymous',
            entries: sanitized
        }
    }

    /**
     * Reconstruct CLI flags from a stored deployment entry.
     * Delegates to the standalone reconstructReplayFlags function.
     *
     * @param {Object} entry - The deployment entry
     * @param {Object} [overrides] - User-provided CLI overrides
     * @returns {Object} CLI flag key-value pairs
     */
    reconstructReplayFlags(entry, overrides = {}) {
        return reconstructReplayFlags(entry, overrides)
    }

    /**
     * Import deployment entries from an Export_Format JSON object.
     *
     * Validates the import format, sets metadata on each entry,
     * detects conflicts, and applies the specified resolution strategy.
     *
     * Conflict detection matches on: modelName, backend, instanceType,
     * and parameters (deep equality via JSON.stringify).
     *
     * Strategies:
     * - 'skip' (default): skip conflicting entries
     * - 'merge': keep both existing and imported entries
     * - 'replace': overwrite existing entries with imported ones
     *
     * @param {Object} json - Parsed Export_Format JSON object
     * @param {string} [strategy='skip'] - Conflict resolution strategy
     * @param {string} [filename='unknown'] - Source filename for metadata
     * @returns {{ added: number, skipped: number, conflicts: number }}
     * @throws {Error} If the import format is invalid
     */
    importEntries(json, strategy = 'skip', filename = 'unknown') {
        if (!json || typeof json !== 'object' || !json.version || !Array.isArray(json.entries)) {
            throw new Error('Invalid export format: missing required "version" or "entries" fields')
        }

        const existingEntries = this._readRegistry()
        let added = 0
        let skipped = 0
        let conflicts = 0

        for (const importedEntry of json.entries) {
            const entry = JSON.parse(JSON.stringify(importedEntry))

            if (!entry.metadata) {
                entry.metadata = {}
            }
            entry.metadata.source = 'imported'
            entry.metadata.importedFrom = filename

            const isConflict = existingEntries.some(existing =>
                existing.model?.modelName === entry.model?.modelName &&
                existing.deployment?.backend === entry.deployment?.backend &&
                existing.infrastructure?.instanceType === entry.infrastructure?.instanceType &&
                JSON.stringify(existing.configuration?.parameters) === JSON.stringify(entry.configuration?.parameters)
            )

            if (isConflict) {
                conflicts++
                if (strategy === 'merge') {
                    const id = this._generateId(entry, existingEntries)
                    entry.id = id
                    existingEntries.push(entry)
                } else if (strategy === 'replace') {
                    const conflictIndex = existingEntries.findIndex(existing =>
                        existing.model?.modelName === entry.model?.modelName &&
                        existing.deployment?.backend === entry.deployment?.backend &&
                        existing.infrastructure?.instanceType === entry.infrastructure?.instanceType &&
                        JSON.stringify(existing.configuration?.parameters) === JSON.stringify(entry.configuration?.parameters)
                    )
                    if (conflictIndex !== -1) {
                        entry.id = existingEntries[conflictIndex].id
                        existingEntries[conflictIndex] = entry
                    }
                } else {
                    skipped++
                }
            } else {
                const id = this._generateId(entry, existingEntries)
                entry.id = id
                existingEntries.push(entry)
                added++
            }
        }

        this._writeRegistry(existingEntries)

        return { added, skipped, conflicts }
    }

}

/**
 * Reconstruct CLI flags from a stored deployment entry.
 *
 * Maps entry fields to their corresponding CLI flags:
 * - deployment.deploymentConfig → --deployment-config
 * - model.modelName → --model-name
 * - infrastructure.instanceType → --instance-type
 * - infrastructure.region → --region
 * - model.modelFormat → --model-format (omitted for transformers architecture)
 *
 * Null/undefined fields are omitted so the generator prompts for them.
 * User overrides take precedence over stored entry values.
 *
 * @param {Object} entry - The deployment entry
 * @param {Object} [overrides={}] - User-provided CLI overrides (keyed by flag name, e.g. '--model-name')
 * @returns {Object} CLI flag key-value pairs
 */
export function reconstructReplayFlags(entry, overrides = {}) {
    const flags = {}

    const mappings = [
        { field: entry?.deployment?.deploymentConfig, flag: '--deployment-config' },
        { field: entry?.model?.modelName, flag: '--model-name' },
        { field: entry?.infrastructure?.instanceType, flag: '--instance-type' },
        { field: entry?.infrastructure?.region, flag: '--region' },
    ]

    for (const { field, flag } of mappings) {
        if (field != null) {
            flags[flag] = field
        }
    }

    // Omit --model-format for transformers architecture
    const isTransformers = entry?.deployment?.architecture === 'transformers'
    if (!isTransformers && entry?.model?.modelFormat != null) {
        flags['--model-format'] = entry.model.modelFormat
    }

    // Apply user overrides with higher precedence
    for (const [key, value] of Object.entries(overrides)) {
        if (value != null) {
            flags[key] = value
        }
    }

    return flags
}

/**
 * System environment variables excluded from http architecture deployments.
 * These are standard system/Python vars that are not relevant to the
 * deployment configuration.
 */
const HTTP_SYSTEM_VARS = new Set([
    'PATH',
    'PYTHONPATH',
    'SAGEMAKER_BIND_TO_PORT',
    'LANG',
    'GPG_KEY',
    'PYTHON_VERSION',
    'PYTHON_PIP_VERSION',
    'PYTHON_SETUPTOOLS_VERSION',
    'PYTHON_GET_PIP_URL',
    'PYTHON_GET_PIP_SHA256',
])

/**
 * Filter environment variables for transformer architecture deployments.
 *
 * Keeps only vars whose key starts with the given engine prefix
 * (e.g. 'VLLM_', 'SGLANG_'), plus HF_TOKEN and HF_MODEL_ID if present.
 *
 * @param {Object} envVars - Key-value pairs of environment variables
 * @param {string} enginePrefix - Engine prefix string (e.g. 'VLLM_')
 * @returns {Object} Filtered key-value pairs
 */
export function filterTransformerEnvVars(envVars, enginePrefix) {
    const result = {}

    for (const [key, value] of Object.entries(envVars)) {
        if (key.startsWith(enginePrefix) || key === 'HF_TOKEN' || key === 'HF_MODEL_ID') {
            result[key] = value
        }
    }

    return result
}

/**
 * Filter environment variables for http architecture deployments.
 *
 * Excludes known system variables (PATH, PYTHONPATH, etc.) and
 * returns everything else.
 *
 * @param {Object} envVars - Key-value pairs of environment variables
 * @returns {Object} Filtered key-value pairs with system vars removed
 */
export function filterHttpEnvVars(envVars) {
    const result = {}

    for (const [key, value] of Object.entries(envVars)) {
        if (!HTTP_SYSTEM_VARS.has(key)) {
            result[key] = value
        }
    }

    return result
}
