// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Serving Versions — Discovers latest container image tags for vLLM, SGLang,
 * and TensorRT-LLM from DockerHub/NGC registries, updates the model-servers catalog
 * to retain exactly the latest 3 versions per server, clones curated metadata for
 * new entries, and invokes architecture sync to populate supported model types.
 *
 * Follows the schema-sync pattern:
 *   1. For each server in SERVER_SOURCES, fetch available tags from the registry
 *   2. Filter tags to valid semver, sort descending, select top 3
 *   3. For each target version, deep-merge existing or clone nearest entry
 *   4. Prune entries not in the target set
 *   5. Write updated catalog + invoke architecture sync
 *
 * Requirements: 1.1-1.4, 2.1-2.3, 3.1-3.3, 4.1-4.4, 5.1-5.2, 6.1-6.2, 7.1-7.2, 9.1-9.3, 10.1-10.2
 */

import { readFileSync, writeFileSync } from 'node:fs'; // eslint-disable-line no-unused-vars
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// eslint-disable-next-line no-unused-vars
const CATALOG_PATH = path.resolve(__dirname, '..', 'servers', 'lib', 'catalogs', 'model-servers.json');

/**
 * Static configuration mapping each server key to its registry metadata.
 */
export const SERVER_SOURCES = {
    vllm: {
        registry: 'dockerhub',
        namespace: 'vllm',
        repository: 'vllm-openai',
        imagePrefix: 'vllm/vllm-openai'
    },
    sglang: {
        registry: 'dockerhub',
        namespace: 'lmsysorg',
        repository: 'sglang',
        imagePrefix: 'lmsysorg/sglang'
    },
    'tensorrt-llm': {
        registry: 'ngc',
        org: 'nvidia',
        repository: 'tensorrt-llm/release',
        imagePrefix: 'nvcr.io/nvidia/tensorrt-llm'
    }
};

// ─── Semver Utilities ────────────────────────────────────────────────────────

/**
 * Check if a tag string is a valid semver version.
 * Accepts optional `v` prefix. Supports major.minor.patch format only.
 *
 * @param {string} tag - Tag string to validate
 * @returns {boolean}
 */
export function isValidSemver(tag) {
    return /^v?\d+\.\d+\.\d+$/.test(tag);
}

/**
 * Parse a semver tag into numeric components.
 *
 * @param {string} tag - Tag string (e.g., 'v0.20.2' or '0.20.2')
 * @returns {{ major: number, minor: number, patch: number, raw: string }}
 */
export function parseSemver(tag) {
    const cleaned = tag.replace(/^v/, '');
    const [major, minor, patch] = cleaned.split('.').map(Number);
    return { major, minor, patch, raw: tag };
}

/**
 * Compare two parsed semver objects for descending sort.
 *
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number} Negative if a > b, positive if a < b
 */
export function compareSemverDesc(a, b) {
    if (a.major !== b.major) return b.major - a.major;
    if (a.minor !== b.minor) return b.minor - a.minor;
    return b.patch - a.patch;
}

/**
 * Compute a simple numeric distance between two semver versions.
 * Used to determine the nearest existing entry for metadata cloning.
 *
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number} Non-negative distance value
 */
export function semverDistance(a, b) {
    return Math.abs(a.major - b.major) * 10000 +
           Math.abs(a.minor - b.minor) * 100 +
           Math.abs(a.patch - b.patch);
}

// ─── Registry Fetchers ───────────────────────────────────────────────────────

/**
 * Fetch tags from DockerHub for a given repository.
 * Paginates through all results using the `next` URL.
 *
 * @param {string} namespace - DockerHub namespace (e.g., 'vllm')
 * @param {string} repository - Repository name (e.g., 'vllm-openai')
 * @param {Function} [fetchImpl] - Fetch implementation (for dependency injection)
 * @returns {Promise<Array<{name: string, lastUpdated: string}>>}
 */
export async function fetchDockerHubTags(namespace, repository, fetchImpl) {
    const fetchFn = fetchImpl || fetch;
    const tags = [];
    let url = `https://hub.docker.com/v2/repositories/${namespace}/${repository}/tags?page_size=100`;

    while (url) {
        const response = await fetchFn(url);
        if (!response.ok) {
            throw new Error(`DockerHub API returned HTTP ${response.status}`);
        }
        const data = await response.json();
        for (const result of data.results || []) {
            tags.push({ name: result.name, lastUpdated: result.last_updated });
        }
        url = data.next || null;
    }

    return tags;
}

/**
 * Fetch tags from the NGC container registry.
 *
 * @param {string} org - NGC organization (e.g., 'nvidia')
 * @param {string} repository - Repository path (e.g., 'tensorrt-llm/release')
 * @param {Function} [fetchImpl] - Fetch implementation (for dependency injection)
 * @returns {Promise<Array<{name: string, lastUpdated: string}>>}
 */
export async function fetchNgcTags(org, repository, fetchImpl) {
    const fetchFn = fetchImpl || fetch;
    const tags = [];
    const url = `https://api.ngc.nvidia.com/v2/org/${org}/containers/${repository}/tags`;

    const response = await fetchFn(url);
    if (!response.ok) {
        throw new Error(`NGC API returned HTTP ${response.status}`);
    }
    const data = await response.json();
    for (const tag of data.tags || []) {
        tags.push({ name: tag.name, lastUpdated: tag.updated_date || tag.created_date });
    }

    return tags;
}

// ─── Version Selection ───────────────────────────────────────────────────────

/**
 * Filter to valid semver, sort descending, select top 3.
 *
 * @param {Array<{name: string, lastUpdated: string}>} tags - Raw tags from registry
 * @returns {Array<{name: string, lastUpdated: string, parsed: object}>}
 */
export function selectTargetVersions(tags) {
    const valid = tags
        .filter(t => isValidSemver(t.name))
        .map(t => ({ ...t, parsed: parseSemver(t.name) }));

    valid.sort((a, b) => compareSemverDesc(a.parsed, b.parsed));

    return valid.slice(0, 3);
}

// ─── Catalog Update Logic ────────────────────────────────────────────────────

/**
 * Find the nearest existing entry by semver distance.
 *
 * @param {Array<object>} entries - Existing server entries
 * @param {{ major: number, minor: number, patch: number }} targetParsed
 * @returns {object|null} The nearest entry, or null if no entries exist
 */
export function findNearestEntry(entries, targetParsed) {
    if (!entries || entries.length === 0) return null;

    let nearest = entries[0];
    let minDist = Infinity;

    for (const entry of entries) {
        const version = entry.labels?.framework_version;
        if (!version) continue;
        const entryParsed = parseSemver(version);
        const dist = semverDistance(targetParsed, entryParsed);
        if (dist < minDist) {
            minDist = dist;
            nearest = entry;
        }
    }

    return nearest;
}

/**
 * Build a new Server_Entry for a discovered version.
 *
 * @param {object} serverSource - SERVER_SOURCES config for this server
 * @param {{ name: string, lastUpdated: string, parsed: object }} tag - Discovered tag
 * @param {object|null} nearestEntry - Nearest existing entry for field cloning
 * @returns {object} New Server_Entry
 */
export function buildNewEntry(serverSource, tag, nearestEntry) {
    const versionWithoutV = tag.name.replace(/^v/, '');

    const entry = {
        image: `${serverSource.imagePrefix}:${tag.name}`,
        tag: tag.name,
        architecture: 'amd64',
        created: tag.lastUpdated || new Date().toISOString(),
        labels: {
            framework_version: versionWithoutV
        },
        registry: serverSource.registry,
        repository: `${serverSource.namespace || serverSource.org}/${serverSource.repository}`
    };

    // Clone curated fields from nearest entry
    if (nearestEntry) {
        if (nearestEntry.defaults) entry.defaults = structuredClone(nearestEntry.defaults);
        if (nearestEntry.profiles) entry.profiles = structuredClone(nearestEntry.profiles);
        if (nearestEntry.accelerator) entry.accelerator = structuredClone(nearestEntry.accelerator);
        if (nearestEntry.notes) entry.notes = nearestEntry.notes;
        if (nearestEntry.validationLevel) entry.validationLevel = nearestEntry.validationLevel;
    }

    return entry;
}

/**
 * Deep-merge an existing entry with new registry metadata.
 * Preserves: profiles, defaults, notes, accelerator, validationLevel
 * Updates: image, tag, created, labels
 *
 * @param {object} existingEntry - Current catalog entry
 * @param {{ name: string, lastUpdated: string, parsed: object }} tag - Registry tag data
 * @param {object} serverSource - SERVER_SOURCES config for this server
 * @returns {object} Merged entry
 */
export function deepMergeEntry(existingEntry, tag, serverSource) {
    const versionWithoutV = tag.name.replace(/^v/, '');

    return {
        ...existingEntry,
        image: `${serverSource.imagePrefix}:${tag.name}`,
        tag: tag.name,
        created: tag.lastUpdated || existingEntry.created,
        labels: {
            ...existingEntry.labels,
            framework_version: versionWithoutV
        }
    };
}

/**
 * Build the new entries array for a server.
 * For each target version:
 *   - If an existing entry matches, deep merge it
 *   - If no match, build a new entry from the nearest existing entry
 *
 * @param {string} serverKey - Server key (e.g., 'vllm')
 * @param {Array<object>} existingEntries - Current catalog entries for this server
 * @param {Array<object>} targetVersions - Selected target versions with parsed semver
 * @param {object} serverSource - SERVER_SOURCES config
 * @returns {{ entries: Array<object>, added: number, removed: number }}
 */
export function updateServerEntries(serverKey, existingEntries, targetVersions, serverSource) {
    const newEntries = [];
    let added = 0;

    for (const target of targetVersions) {
        const versionWithoutV = target.name.replace(/^v/, '');
        const existing = existingEntries.find(
            e => e.labels?.framework_version === versionWithoutV
        );

        if (existing) {
            newEntries.push(deepMergeEntry(existing, target, serverSource));
        } else {
            const nearest = findNearestEntry(existingEntries, target.parsed);
            newEntries.push(buildNewEntry(serverSource, target, nearest));
            added++;
        }
    }

    const removed = existingEntries.length - (targetVersions.length - added);

    return { entries: newEntries, added, removed };
}

/**
 * Write catalog to disk with 4-space indentation.
 * Preserves key ordering: vllm, sglang, tensorrt-llm.
 *
 * @param {object} catalog - Full catalog object
 * @param {string} catalogPath - Path to model-servers.json
 */
export function writeCatalog(catalog, catalogPath) {
    const ordered = {};
    const keyOrder = ['vllm', 'sglang', 'tensorrt-llm'];
    for (const key of keyOrder) {
        if (catalog[key]) ordered[key] = catalog[key];
    }
    // Include any unexpected keys at the end
    for (const key of Object.keys(catalog)) {
        if (!ordered[key]) ordered[key] = catalog[key];
    }
    writeFileSync(catalogPath, `${JSON.stringify(ordered, null, 4)}\n`, 'utf8');
}

// ─── Main Sync Orchestrator ──────────────────────────────────────────────────

/**
 * Main sync function. Discovers versions, updates catalog, runs architecture sync.
 *
 * @param {object} [options]
 * @param {string} [options.catalogPath] - Override catalog file path
 * @param {Function} [options.fetchFn] - Override global fetch (for testing)
 * @returns {Promise<{ servers: object, totalAdded: number, totalRemoved: number, archSync: object|null }>}
 */
export async function syncServingVersions(options = {}) {
    const catalogPath = options.catalogPath || CATALOG_PATH;
    const fetchImpl = options.fetchFn || fetch;

    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const results = {};
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const [serverKey, source] of Object.entries(SERVER_SOURCES)) {
        try {
            // Fetch tags from appropriate registry
            let tags;
            if (source.registry === 'dockerhub') {
                tags = await fetchDockerHubTags(source.namespace, source.repository, fetchImpl);
            } else {
                tags = await fetchNgcTags(source.org, source.repository, fetchImpl);
            }

            // Select target versions
            const targetVersions = selectTargetVersions(tags);

            if (targetVersions.length === 0) {
                console.log(`  ⚠️  ${serverKey}: no valid semver tags found`);
                results[serverKey] = { versions: [], added: 0, removed: 0 };
                continue;
            }

            // Update catalog entries
            const existingEntries = catalog[serverKey] || [];
            const { entries, added, removed } = updateServerEntries(
                serverKey, existingEntries, targetVersions, source
            );

            catalog[serverKey] = entries;
            totalAdded += added;
            totalRemoved += removed;

            results[serverKey] = {
                versions: targetVersions.map(t => t.name),
                added,
                removed
            };

            console.log(`  ✓ ${serverKey}: ${targetVersions.map(t => t.name).join(', ')} (${added} new, ${removed} pruned)`);
        } catch (error) {
            console.log(`  ⚠️  ${serverKey}: ${error.message}`);
            results[serverKey] = { error: error.message };
        }
    }

    // Write updated catalog
    writeCatalog(catalog, catalogPath);

    // Run architecture sync
    let archSyncResult = null;
    try {
        const { syncArchitectures } = await import('../src/lib/architecture-sync.js');
        archSyncResult = await syncArchitectures(catalogPath);
        console.log('  ✓ Architecture sync completed');
    } catch (error) {
        console.log(`  ⚠️  Architecture sync failed: ${error.message}`);
    }

    return { servers: results, totalAdded, totalRemoved, archSync: archSyncResult };
}

// ─── Main Guard ──────────────────────────────────────────────────────────────

// Main guard for standalone execution
const isMainModule = process.argv[1] && (
    process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('sync-serving-versions.js')
);

if (isMainModule) {
    console.log('\n🔄 Sync Serving Versions — Discovering latest container images...\n');

    syncServingVersions()
        .then((result) => {
            console.log(`\n✅ Sync complete: ${result.totalAdded} new, ${result.totalRemoved} pruned`);
            if (result.archSync) {
                console.log('   Architecture sync: succeeded');
            }
            console.log('');
        })
        .catch((err) => {
            console.error(`\n❌ Sync failed: ${err.message}`);
            process.exit(1);
        });
}
