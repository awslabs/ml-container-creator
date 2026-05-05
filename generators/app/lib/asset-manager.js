// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Asset Manager
 *
 * Core data-access module for the deployment registry asset manifest.
 * Handles reading, writing, querying, and validating the per-profile
 * asset manifest stored at ~/.ml-container-creator/manifests/{profileName}.json.
 *
 * Manifest file format:
 * {
 *   "schemaVersion": "2026-05-04",
 *   "resources": [
 *     {
 *       "resourceId": "arn:aws:sagemaker:us-east-1:111111111111:endpoint/my-endpoint",
 *       "resourceType": "sagemaker-endpoint",
 *       "createdAt": "2026-05-04T10:30:00Z",
 *       "lastUpdatedAt": "2026-05-04T10:30:00Z",
 *       "project": "my-llm-project",
 *       "status": "active",
 *       "metadata": {
 *         "endpointName": "my-endpoint",
 *         "instanceType": "ml.g5.xlarge",
 *         "region": "us-east-1"
 *       }
 *     }
 *   ]
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const SCHEMA_VERSION = '2026-05-04'

const VALID_RESOURCE_TYPES = [
    'sagemaker-endpoint',
    'sagemaker-endpoint-config',
    'sagemaker-model',
    'sagemaker-inference-component',
    'sagemaker-transform-job',
    'ecr-image',
    'codebuild-project',
    'iam-role',
    's3-object',
    'sns-topic',
    'k8s-deployment',
    'k8s-service'
]

const VALID_STATUSES = ['active', 'deleted', 'unknown']

export { SCHEMA_VERSION, VALID_RESOURCE_TYPES, VALID_STATUSES }

export default class AssetManager {
    /**
     * @param {string} profileName - The bootstrap profile name
     * @param {Object} [options] - Optional configuration
     * @param {string} [options.configDir] - Override the default config directory
     *   Defaults to ~/.ml-container-creator
     */
    constructor(profileName, options = {}) {
        this.profileName = profileName
        this.configDir = options.configDir || join(homedir(), '.ml-container-creator')
    }

    /**
     * Derive the manifest file path from the profile name.
     *
     * @returns {string} Absolute path to the manifest JSON file
     */
    get manifestPath() {
        return join(this.configDir, 'manifests', `${this.profileName}.json`)
    }

    /**
     * Read the manifest file and return the parsed manifest object.
     *
     * Handles:
     * - Missing file → return { schemaVersion, resources: [] }
     * - Invalid JSON → throw descriptive error
     * - Missing/unrecognized schemaVersion → log warning, attempt best-effort read
     *
     * @returns {{ schemaVersion: string, resources: Array<Object> }}
     */
    _readManifest() {
        if (!existsSync(this.manifestPath)) {
            return { schemaVersion: SCHEMA_VERSION, resources: [] }
        }

        const raw = readFileSync(this.manifestPath, 'utf8')

        let data
        try {
            data = JSON.parse(raw)
        } catch (err) {
            throw new Error(
                `Invalid JSON in manifest file ${this.manifestPath}: ${err.message}`
            )
        }

        if (!data.schemaVersion) {
            console.warn(
                `Warning: Manifest file ${this.manifestPath} has no schemaVersion. Attempting best-effort read.`
            )
        } else if (data.schemaVersion !== SCHEMA_VERSION) {
            console.warn(
                `Warning: Manifest file ${this.manifestPath} has unrecognized schemaVersion "${data.schemaVersion}". Attempting best-effort read.`
            )
        }

        return {
            schemaVersion: data.schemaVersion || SCHEMA_VERSION,
            resources: Array.isArray(data.resources) ? data.resources : []
        }
    }

    /**
     * Write a manifest object to the manifest file.
     * Creates parent directories if they don't exist.
     * Uses 2-space indentation and a trailing newline.
     *
     * @param {{ schemaVersion: string, resources: Array<Object> }} manifest
     */
    _writeManifest(manifest) {
        const dir = dirname(this.manifestPath)
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        writeFileSync(
            this.manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`
        )
    }

    /**
     * Validate an Asset_Record against the required schema.
     *
     * Checks:
     * - Required fields: resourceId, resourceType, createdAt, lastUpdatedAt, project, status, metadata
     * - resourceType is one of VALID_RESOURCE_TYPES
     * - status is one of VALID_STATUSES
     * - createdAt and lastUpdatedAt are valid ISO 8601 strings
     * - metadata is a non-null object
     *
     * @param {Object} record - The record to validate
     * @returns {{ valid: boolean, errors: string[] }}
     */
    _validateRecord(record) {
        const errors = []

        const requiredFields = [
            'resourceId',
            'resourceType',
            'createdAt',
            'lastUpdatedAt',
            'project',
            'status',
            'metadata'
        ]

        for (const field of requiredFields) {
            if (record[field] === undefined || record[field] === null) {
                errors.push(`Missing required field: ${field}`)
            }
        }

        if (record.resourceType !== undefined && record.resourceType !== null) {
            if (!VALID_RESOURCE_TYPES.includes(record.resourceType)) {
                errors.push(
                    `Invalid resourceType: "${record.resourceType}". Must be one of: ${VALID_RESOURCE_TYPES.join(', ')}`
                )
            }
        }

        if (record.status !== undefined && record.status !== null) {
            if (!VALID_STATUSES.includes(record.status)) {
                errors.push(
                    `Invalid status: "${record.status}". Must be one of: ${VALID_STATUSES.join(', ')}`
                )
            }
        }

        if (record.createdAt !== undefined && record.createdAt !== null) {
            if (!_isValidISO8601(record.createdAt)) {
                errors.push(
                    `Invalid createdAt: "${record.createdAt}". Must be a valid ISO 8601 timestamp.`
                )
            }
        }

        if (record.lastUpdatedAt !== undefined && record.lastUpdatedAt !== null) {
            if (!_isValidISO8601(record.lastUpdatedAt)) {
                errors.push(
                    `Invalid lastUpdatedAt: "${record.lastUpdatedAt}". Must be a valid ISO 8601 timestamp.`
                )
            }
        }

        if (record.metadata !== undefined && record.metadata !== null) {
            if (typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
                errors.push('Invalid metadata: must be a non-null object.')
            }
        }

        return { valid: errors.length === 0, errors }
    }

    /**
     * Add or update a resource record in the manifest (upsert semantics).
     *
     * Validates the record, reads the manifest, and either updates an
     * existing record (matching resourceId) or appends a new one.
     *
     * @param {Object} record - The Asset_Record to add or update
     * @throws {Error} If the record fails validation
     */
    addResource(record) {
        const { valid, errors } = this._validateRecord(record)
        if (!valid) {
            throw new Error(`Invalid asset record: ${errors.join('; ')}`)
        }

        const manifest = this._readManifest()
        const existingIndex = manifest.resources.findIndex(
            r => r.resourceId === record.resourceId
        )

        if (existingIndex !== -1) {
            manifest.resources[existingIndex].lastUpdatedAt = record.lastUpdatedAt
            manifest.resources[existingIndex].status = record.status
        } else {
            manifest.resources.push(record)
        }

        this._writeManifest(manifest)
    }

    /**
     * Update the status of a resource by its resourceId.
     *
     * @param {string} resourceId - The resource identifier to find
     * @param {string} newStatus - The new status value
     * @returns {boolean} true if the resource was found and updated, false otherwise
     */
    updateStatus(resourceId, newStatus) {
        const manifest = this._readManifest()
        const resource = manifest.resources.find(r => r.resourceId === resourceId)

        if (!resource) {
            return false
        }

        resource.status = newStatus
        resource.lastUpdatedAt = new Date().toISOString()
        this._writeManifest(manifest)
        return true
    }

    /**
     * Get a single resource record by its resourceId.
     *
     * @param {string} resourceId - The resource identifier to find
     * @returns {Object|null} The matching Asset_Record, or null if not found
     */
    getResource(resourceId) {
        const manifest = this._readManifest()
        return manifest.resources.find(r => r.resourceId === resourceId) || null
    }

    /**
     * Remove a resource record from the manifest by its resourceId.
     *
     * @param {string} resourceId - The resource identifier to remove
     * @returns {boolean} true if the resource was found and removed, false otherwise
     */
    removeResource(resourceId) {
        const manifest = this._readManifest()
        const originalLength = manifest.resources.length
        manifest.resources = manifest.resources.filter(
            r => r.resourceId !== resourceId
        )

        if (manifest.resources.length === originalLength) {
            return false
        }

        this._writeManifest(manifest)
        return true
    }

    /**
     * List resources matching optional filters (AND logic).
     *
     * Supported filter keys: resourceType, project, status.
     * With no filters, returns all resources.
     *
     * @param {Object} [filters] - Optional filter criteria
     * @returns {Array<Object>} Matching Asset_Records
     */
    listResources(filters = {}) {
        const manifest = this._readManifest()

        if (!filters || Object.keys(filters).length === 0) {
            return manifest.resources
        }

        return manifest.resources.filter(resource => {
            if (filters.resourceType && resource.resourceType !== filters.resourceType) {
                return false
            }
            if (filters.project && resource.project !== filters.project) {
                return false
            }
            if (filters.status && resource.status !== filters.status) {
                return false
            }
            return true
        })
    }

    /**
     * Group all resources by their project name.
     *
     * @returns {Map<string, Array<Object>>} Map of project name → Asset_Record array
     */
    getResourcesByProject() {
        const manifest = this._readManifest()
        const grouped = new Map()

        for (const resource of manifest.resources) {
            const project = resource.project
            if (!grouped.has(project)) {
                grouped.set(project, [])
            }
            grouped.get(project).push(resource)
        }

        return grouped
    }

    /**
     * Count resources by status.
     *
     * @returns {{ active: number, deleted: number, unknown: number }}
     */
    getStatusCounts() {
        const manifest = this._readManifest()
        const counts = { active: 0, deleted: 0, unknown: 0 }

        for (const resource of manifest.resources) {
            if (resource.status in counts) {
                counts[resource.status]++
            }
        }

        return counts
    }
}

/**
 * Check whether a string is a valid ISO 8601 timestamp.
 *
 * Accepts any string that the Date constructor can parse into a valid date
 * and that matches the ISO 8601 pattern (must contain date separators and
 * a time designator). This allows both `2026-05-04T10:30:00Z` and
 * `2026-05-04T10:30:00.000Z` forms.
 *
 * @param {string} str - The string to check
 * @returns {boolean} true if the string is a valid ISO 8601 timestamp
 */
function _isValidISO8601(str) {
    if (typeof str !== 'string' || str.length === 0) {
        return false
    }
    const date = new Date(str)
    if (isNaN(date.getTime())) {
        return false
    }
    // Ensure the string looks like an ISO 8601 timestamp (not just any parseable date string)
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str)
}
