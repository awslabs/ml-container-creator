// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Proven Configs — Updates catalogs from proven DynamoDB results.
 *
 * Reads the `mlcc-ci-table` for records with `status='completed'` and
 * `run_type IN ('prove', 'path_prove')`, then:
 * 1. Adds new model entries to `servers/lib/catalogs/models.json`
 * 2. Adds new entries to `scripts/e2e-catalog.json`
 *
 * Usage:
 *   node scripts/sync-proven-configs.js [--dry-run]
 *
 * Or via CLI:
 *   mcc prove sync [--dry-run]
 *
 * Feature: prove-mvp
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BootstrapConfig from '../src/lib/bootstrap-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_CATALOG_PATH = path.resolve(__dirname, '..', 'servers', 'lib', 'catalogs', 'models.json');
const E2E_CATALOG_PATH = path.resolve(__dirname, 'e2e-catalog.json');

/**
 * Sync proven configurations from DynamoDB to local catalogs.
 *
 * @param {object} [options] - Options
 * @param {boolean} [options.dryRun=false] - Print changes without writing
 * @param {object} [options.client] - Pre-initialized DynamoDB client (for testing)
 * @param {string} [options.tableName] - Override table name (for testing)
 * @returns {Promise<object>} Sync result with added models and catalog entries
 */
export async function syncProvenConfigs(options = {}) {
    const { dryRun = false } = options;
    let client = options.client;
    let tableName = options.tableName;

    // Initialize DynamoDB client from bootstrap config
    if (!client) {
        const config = new BootstrapConfig();
        const profile = config.getActiveProfileWithDefaults();
        if (!profile || !profile.config.ciInfraProvisioned) {
            console.log('⚠️  CI table not provisioned — nothing to sync');
            return { addedModels: [], addedCatalogEntries: [] };
        }
        tableName = tableName || profile.config.ciTableName;
        const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
        client = new DynamoDBClient({ region: profile.config.awsRegion });
    }

    // Scan for proven results
    const { ScanCommand } = await import('@aws-sdk/client-dynamodb');
    const { unmarshall } = await import('@aws-sdk/util-dynamodb');

    const response = await client.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'testStatus = :pass',
        ExpressionAttributeValues: {
            ':pass': { S: 'pass' }
        }
    }));

    const items = (response.Items || []).map(item => unmarshall(item));

    if (items.length === 0) {
        console.log('📊 No proven results found to sync');
        return { addedModels: [], addedCatalogEntries: [] };
    }

    // Load existing catalogs
    let modelsCatalog = {};
    try {
        modelsCatalog = JSON.parse(readFileSync(MODELS_CATALOG_PATH, 'utf8'));
    } catch { /* start fresh if not found */ }

    let e2eCatalog = { configs: [] };
    try {
        e2eCatalog = JSON.parse(readFileSync(E2E_CATALOG_PATH, 'utf8'));
    } catch { /* start fresh if not found */ }

    const addedModels = [];
    const addedCatalogEntries = [];
    const existingCatalogIds = new Set(e2eCatalog.configs.map(c => c.id));

    for (const item of items) {
        // Parse args to extract config fields (parseArgs validates the ID format)
        parseArgs(item.e2eCatalogId || item.configId || '');
        const stageResults = item.stageResults || {};
        const modelName = extractModelName(item, stageResults);
        const deploymentConfig = extractField(item, 'deploymentConfig') || '';
        const instanceType = extractField(item, 'instanceType') || '';

        // Add model to models.json if new
        if (modelName && !modelsCatalog[modelName]) {
            const modelEntry = {
                family: deriveModelFamily(modelName),
                validationLevel: 'proven',
                notes: `Proven via mcc prove on ${new Date().toISOString().split('T')[0]}`
            };
            modelsCatalog[modelName] = modelEntry;
            addedModels.push(modelName);
        }

        // Add e2e catalog entry if new
        const catalogId = `prove-${(item.configId || '').slice(0, 12)}`;
        if (!existingCatalogIds.has(catalogId) && modelName && deploymentConfig) {
            const newEntry = {
                id: catalogId,
                tier: 'proven',
                track: 'realtime',
                args: `--deployment-config=${deploymentConfig} --model-name=${modelName}${ 
                    instanceType ? ` --instance-type=${instanceType}` : ''}`,
                lifecycle: ['build', 'push', 'deploy', 'test', 'clean'],
                timeout: 1800
            };
            e2eCatalog.configs.push(newEntry);
            existingCatalogIds.add(catalogId);
            addedCatalogEntries.push(catalogId);
        }
    }

    // Print diff
    if (addedModels.length > 0) {
        console.log(`\n🆕 New models (${addedModels.length}):`);
        for (const m of addedModels) {
            console.log(`  + ${m}`);
        }
    }

    if (addedCatalogEntries.length > 0) {
        console.log(`\n🆕 New E2E catalog entries (${addedCatalogEntries.length}):`);
        for (const e of addedCatalogEntries) {
            console.log(`  + ${e}`);
        }
    }

    if (addedModels.length === 0 && addedCatalogEntries.length === 0) {
        console.log('✅ Catalogs already up-to-date');
    }

    // Write if not dry-run
    if (!dryRun && (addedModels.length > 0 || addedCatalogEntries.length > 0)) {
        writeFileSync(MODELS_CATALOG_PATH, JSON.stringify(modelsCatalog, null, 4));
        writeFileSync(E2E_CATALOG_PATH, JSON.stringify(e2eCatalog, null, 4));
        console.log('\n✅ Catalogs updated');
    } else if (dryRun && (addedModels.length > 0 || addedCatalogEntries.length > 0)) {
        console.log('\n🏜️  Dry run — no files written');
    }

    return { addedModels, addedCatalogEntries };
}

/**
 * Parse args string from a catalog entry to extract fields.
 *
 * @param {string} argsStr - Arguments string
 * @returns {object} Parsed key-value pairs
 */
function parseArgs(argsStr) {
    const result = {};
    const parts = (argsStr || '').split(/\s+/).filter(a => a.startsWith('--'));
    for (const part of parts) {
        const [key, value] = part.replace(/^--/, '').split('=');
        if (key && value) result[key] = value;
    }
    return result;
}

/**
 * Extract model name from a DynamoDB item.
 *
 * @param {object} item - DynamoDB item
 * @param {object} stageResults - Stage results map
 * @returns {string|null} Model name or null
 */
function extractModelName(item, _stageResults) {
    if (item.model_name) return item.model_name;
    const argsStr = item.e2eCatalogId || '';
    const args = parseArgs(argsStr);
    return args['model-name'] || null;
}

/**
 * Extract a field from a DynamoDB item.
 *
 * @param {object} item - DynamoDB item
 * @param {string} field - Field name
 * @returns {string|null} Field value or null
 */
function extractField(item, field) {
    return item[field] || null;
}

/**
 * Derive model family from a model name.
 *
 * @param {string} modelName - HuggingFace model ID (e.g., "Qwen/Qwen3-4B")
 * @returns {string} Model family (e.g., "qwen3")
 */
function deriveModelFamily(modelName) {
    const name = modelName.split('/').pop().toLowerCase();
    // Common family patterns
    if (name.includes('qwen3')) return 'qwen3';
    if (name.includes('qwen2')) return 'qwen2';
    if (name.includes('llama-3.2') || name.includes('llama-32')) return 'llama-3.2';
    if (name.includes('llama-3.1') || name.includes('llama-31')) return 'llama-3.1';
    if (name.includes('llama-3') || name.includes('llama3')) return 'llama-3';
    if (name.includes('llama')) return 'llama';
    if (name.includes('deepseek')) return 'deepseek';
    if (name.includes('gemma')) return 'gemma';
    if (name.includes('mistral')) return 'mistral';
    if (name.includes('phi')) return 'phi';
    return 'unknown';
}

// ── CLI entry point ──────────────────────────────────────────────────────────

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
    const dryRun = process.argv.includes('--dry-run');
    syncProvenConfigs({ dryRun }).catch(err => {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    });
}
