// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helper for loading project-local catalog overrides from .mlcc/.
 *
 * Each MCP server calls loadWithOverrides() at query time to merge local entries
 * on top of the shipped catalog. Local entries win on key collisions and are tagged
 * with `"source": "local"` for discoverability.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the project directory from tool call context, env var, or cwd.
 *
 * @param {object} [context] - Tool call context object
 * @returns {string} Resolved project directory path
 */
export function resolveProjectDir(context) {
    return context?.projectDir || process.env.MLCC_PROJECT_DIR || process.cwd();
}

/**
 * Read and parse an override file. Returns null if the file doesn't exist or is malformed.
 *
 * @param {string} projectDir - Absolute path to the project directory
 * @param {string} overrideFilename - Override file name (e.g., 'model-picker.json')
 * @returns {object|null} Parsed override data, or null on error
 */
function readOverrideFile(projectDir, overrideFilename) {
    const overridePath = join(projectDir, '.mlcc', overrideFilename);

    let raw;
    try {
        raw = readFileSync(overridePath, 'utf8');
    } catch {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        process.stderr.write(`[override-loader] Warning: malformed override at ${overridePath}\n`);
        return null;
    }
}

/**
 * Merge project-local overrides into an object-keyed catalog (model-picker, instance-sizer).
 *
 * Override format: { "<arrayKey>": [ { "<mergeKey>": "...", ...fields } ] }
 * Shipped format: { "<entryKey>": { ...fields } }
 *
 * Local entries are keyed by `mergeKey` and merged into the shipped object.
 * All local entries receive `"source": "local"`.
 *
 * @param {object} shippedCatalog - The shipped catalog (object keyed by entry name)
 * @param {string} projectDir - Absolute path to the project directory
 * @param {string} overrideFilename - Override file name (e.g., 'model-picker.json')
 * @param {string} mergeKey - The field in override entries to use as the object key (e.g., 'name', 'instanceType')
 * @returns {object} Merged catalog object
 */
export function loadWithOverrides(shippedCatalog, projectDir, overrideFilename, mergeKey) {
    const localData = readOverrideFile(projectDir, overrideFilename);
    if (!localData) return shippedCatalog;

    const localEntries = extractEntries(localData);
    if (!localEntries || !Array.isArray(localEntries)) return shippedCatalog;

    // Merge into a copy of the shipped catalog
    const merged = { ...shippedCatalog };
    for (const entry of localEntries) {
        const key = entry[mergeKey];
        if (!key) continue;
        merged[key] = { ...entry, source: 'local' };
    }

    return merged;
}

/**
 * Merge project-local overrides into an array-based catalog (base-image-picker).
 *
 * Override format: { "<arrayKey>": [ { "<mergeKey>": "...", ...fields } ] }
 * Shipped format: [ { "<mergeKey>": "...", ...fields } ]
 *
 * Local entries win on key collision; new entries are appended.
 * All local entries receive `"source": "local"`.
 *
 * @param {Array} shippedArray - The shipped catalog entries (array of objects)
 * @param {string} projectDir - Absolute path to the project directory
 * @param {string} overrideFilename - Override file name (e.g., 'base-image-picker.json')
 * @param {string} mergeKey - The key field to match entries on (e.g., 'name', 'tag')
 * @returns {Array} Merged catalog entries
 */
export function loadWithOverridesArray(shippedArray, projectDir, overrideFilename, mergeKey) {
    const localData = readOverrideFile(projectDir, overrideFilename);
    if (!localData) return shippedArray;

    const localEntries = extractEntries(localData);
    if (!localEntries || !Array.isArray(localEntries)) return shippedArray;

    // Build index of shipped entries by merge key
    const merged = [...shippedArray];
    const indexMap = new Map();
    for (let i = 0; i < merged.length; i++) {
        const key = merged[i][mergeKey];
        if (key) indexMap.set(key, i);
    }

    // Merge: local wins on collision, append otherwise
    for (const entry of localEntries) {
        const taggedEntry = { ...entry, source: 'local' };
        const key = entry[mergeKey];
        if (key && indexMap.has(key)) {
            merged[indexMap.get(key)] = taggedEntry;
        } else {
            merged.push(taggedEntry);
        }
    }

    return merged;
}

/**
 * Merge project-local capability overrides on top of shipped capability matrix.
 *
 * Override format: { "capabilities": { "<capKey>": { ...fields } } }
 * Shipped format: { "<capKey>": { ...fields } } (or array)
 *
 * Local entries win on key collision.
 * All local entries receive `"source": "local"`.
 *
 * @param {object} shippedData - The shipped capability matrix (object keyed by capability name)
 * @param {string} projectDir - Absolute path to the project directory
 * @param {string} overrideFilename - Override file name (e.g., 'capabilities.json')
 * @returns {object} Merged capability matrix
 */
export function loadWithOverridesObject(shippedData, projectDir, overrideFilename) {
    const localData = readOverrideFile(projectDir, overrideFilename);
    if (!localData) return shippedData;

    const localCapabilities = localData.capabilities || localData;
    if (typeof localCapabilities !== 'object' || Array.isArray(localCapabilities)) {
        return shippedData;
    }

    // Merge: local wins on collision, tag with source
    const merged = { ...shippedData };
    for (const [key, value] of Object.entries(localCapabilities)) {
        merged[key] = typeof value === 'object' && value !== null
            ? { ...value, source: 'local' }
            : value;
    }

    return merged;
}

/**
 * Extract the first array value from a parsed override object.
 * Handles formats like { "models": [...] }, { "instances": [...] }, { "images": [...] }
 */
function extractEntries(data) {
    if (Array.isArray(data)) return data;
    if (typeof data === 'object' && data !== null) {
        for (const value of Object.values(data)) {
            if (Array.isArray(value)) return value;
        }
    }
    return null;
}
