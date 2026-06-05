// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Model Families — Discovers supported models from the SageMaker JumpStart Hub
 * and updates the tune catalog with tune-eligible models.
 *
 * Follows the schema-sync pattern:
 *   1. For each known prefix, call ListHubContents
 *   2. For each result, call DescribeHubContent
 *   3. Parse HubContentDocument JSON → extract RecipeCollection
 *   4. Filter to models with CustomizationTechnique entries
 *   5. Build catalog entries: { key: hubContentName, family, provider, displayName, huggingFaceId, techniques }
 *   6. Additive merge with existing tune-catalog.json
 *   7. Cross-reference with schema registry for benchmark eligibility
 *   8. Write updated catalog + report summary
 *
 * Requirements: 10.1-10.12, 10.15
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATALOG_PATH = path.resolve(__dirname, '..', 'config', 'tune-catalog.json');

const KNOWN_PREFIXES = [
    'huggingface-llm',
    'huggingface-reasoning',
    'huggingface-vlm',
    'deepseek-llm',
    'meta-textgeneration',
    'openai-reasoning'
];

const HUB_NAME = 'SageMakerPublicHub';

/**
 * Derive the model family from a Hub content name prefix.
 * @param {string} hubContentName
 * @returns {string}
 */
function deriveFamily(hubContentName) {
    if (hubContentName.startsWith('huggingface-llm-qwen2-5')) return 'qwen-2.5';
    if (hubContentName.startsWith('huggingface-reasoning-qwen3')) return 'qwen-3';
    if (hubContentName.startsWith('huggingface-vlm')) return 'huggingface-vlm';
    if (hubContentName.startsWith('deepseek-llm-r1-distill')) return 'deepseek-r1';
    if (hubContentName.startsWith('deepseek-llm')) return 'deepseek';
    if (hubContentName.startsWith('meta-textgeneration-llama-3')) return 'llama-3';
    if (hubContentName.startsWith('meta-textgeneration')) return 'meta';
    if (hubContentName.startsWith('openai-reasoning-gpt-oss')) return 'gpt-oss';
    if (hubContentName.startsWith('openai-reasoning')) return 'openai';
    // Fallback: use the prefix up to the first numeric segment
    const parts = hubContentName.split('-');
    const familyParts = [];
    for (const part of parts) {
        if (/^\d/.test(part)) break;
        familyParts.push(part);
    }
    return familyParts.join('-') || hubContentName;
}

/**
 * Derive the provider from a Hub content name.
 * @param {string} hubContentName
 * @returns {string}
 */
function deriveProvider(hubContentName) {
    if (hubContentName.startsWith('huggingface-llm-qwen') || hubContentName.startsWith('huggingface-reasoning-qwen')) return 'alibaba';
    if (hubContentName.startsWith('deepseek')) return 'deepseek';
    if (hubContentName.startsWith('meta-textgeneration')) return 'meta';
    if (hubContentName.startsWith('openai')) return 'openai';
    return 'unknown';
}

/**
 * Query ListHubContents for models matching a prefix.
 * @param {import('@aws-sdk/client-sagemaker').SageMakerClient} client
 * @param {string} prefix
 * @returns {Promise<Array<{HubContentName: string, HubContentStatus: string}>>}
 */
async function listHubModels(client, prefix) {
    const { ListHubContentsCommand } = await import('@aws-sdk/client-sagemaker');

    const models = [];
    let nextToken;

    do {
        const command = new ListHubContentsCommand({
            HubName: HUB_NAME,
            HubContentType: 'Model',
            NameContains: prefix,
            MaxResults: 50,
            ...(nextToken && { NextToken: nextToken })
        });

        const response = await client.send(command);
        const summaries = response.HubContentSummaries || [];

        for (const item of summaries) {
            if (item.HubContentStatus === 'Available') {
                models.push(item);
            }
        }

        nextToken = response.NextToken;
    } while (nextToken);

    return models;
}

/**
 * Retrieve the full HubContentDocument for a model.
 * @param {import('@aws-sdk/client-sagemaker').SageMakerClient} client
 * @param {string} name - Hub content name
 * @returns {Promise<object>} - DescribeHubContent response
 */
async function describeHubContent(client, name) {
    const { DescribeHubContentCommand } = await import('@aws-sdk/client-sagemaker');

    const command = new DescribeHubContentCommand({
        HubName: HUB_NAME,
        HubContentName: name,
        HubContentType: 'Model'
    });

    return client.send(command);
}

/**
 * Parse the HubContentDocument to extract fine-tuning recipes.
 * Returns an array of recipe entries that have CustomizationTechnique values.
 *
 * @param {string} hubContentDocument - JSON string from DescribeHubContent
 * @returns {Array<{technique: string, trainingTypes: string[], datasetFormat: string, datasetSchema: object}>}
 */
function parseRecipes(hubContentDocument) {
    if (!hubContentDocument) return [];

    let doc;
    try {
        doc = typeof hubContentDocument === 'string'
            ? JSON.parse(hubContentDocument)
            : hubContentDocument;
    } catch {
        return [];
    }

    const recipes = [];
    const recipeCollection = doc.RecipeCollection || doc.recipeCollection || [];

    for (const recipe of recipeCollection) {
        const technique = recipe.CustomizationTechnique || recipe.customizationTechnique;
        if (!technique) continue;

        const normalizedTechnique = technique.toLowerCase();
        const validTechniques = ['sft', 'dpo', 'rlaif', 'rlvr'];
        if (!validTechniques.includes(normalizedTechnique)) continue;

        const trainingTypes = recipe.TrainingTypes || recipe.trainingTypes || ['lora'];
        const datasetFormat = recipe.DatasetFormat || recipe.datasetFormat || `default-${normalizedTechnique}`;
        const datasetSchema = recipe.DatasetSchema || recipe.datasetSchema || getDefaultDatasetSchema(normalizedTechnique);

        recipes.push({
            technique: normalizedTechnique,
            trainingTypes: Array.isArray(trainingTypes) ? trainingTypes.map(t => t.toLowerCase()) : ['lora'],
            datasetFormat,
            datasetSchema
        });
    }

    return recipes;
}

/**
 * Get the default dataset schema for a technique.
 * @param {string} technique
 * @returns {object}
 */
function getDefaultDatasetSchema(technique) {
    switch (technique) {
    case 'sft':
        return { required: ['prompt', 'completion'], types: { prompt: 'string', completion: 'string' } };
    case 'dpo':
        return { required: ['prompt', 'chosen', 'rejected'], types: { prompt: 'string', chosen: 'string', rejected: 'string' } };
    case 'rlaif':
    case 'rlvr':
        return { required: ['prompt'], types: { prompt: 'array' } };
    default:
        return { required: ['prompt'], types: { prompt: 'string' } };
    }
}

/**
 * Build a catalog entry from Hub model data and parsed recipes.
 *
 * @param {object} model - ListHubContents summary item
 * @param {object} detail - DescribeHubContent response
 * @param {Array} recipes - Parsed recipe entries
 * @returns {object} - Catalog entry
 */
function buildCatalogEntry(model, detail, recipes) {
    const hubContentName = model.HubContentName;
    const displayName = detail.HubContentDisplayName || detail.HubContentName || hubContentName;

    // Attempt to derive HuggingFace ID from Hub metadata
    let huggingFaceId = '';
    if (detail.HubContentDocument) {
        try {
            const doc = typeof detail.HubContentDocument === 'string'
                ? JSON.parse(detail.HubContentDocument)
                : detail.HubContentDocument;
            huggingFaceId = doc.HuggingFaceModelId || doc.huggingFaceModelId || doc.ModelId || '';
        } catch {
            // Ignore parse errors
        }
    }

    const techniques = {};
    for (const recipe of recipes) {
        techniques[recipe.technique] = {
            trainingTypes: recipe.trainingTypes,
            datasetFormat: recipe.datasetFormat,
            datasetSchema: recipe.datasetSchema
        };
    }

    return {
        family: deriveFamily(hubContentName),
        provider: deriveProvider(hubContentName),
        displayName,
        huggingFaceId,
        techniques
    };
}

/**
 * Load the existing tune catalog from disk.
 * @param {string} [catalogPath] - Override catalog path
 * @returns {object} - Parsed catalog or default structure
 */
function loadExistingCatalog(catalogPath) {
    const filePath = catalogPath || CATALOG_PATH;

    if (!existsSync(filePath)) {
        return {
            version: new Date().toISOString().split('T')[0],
            lastSynced: null,
            source: 'https://docs.aws.amazon.com/sagemaker/latest/dg/model-customize-open-weight.html',
            models: {}
        };
    }

    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        return {
            version: new Date().toISOString().split('T')[0],
            lastSynced: null,
            source: 'https://docs.aws.amazon.com/sagemaker/latest/dg/model-customize-open-weight.html',
            models: {}
        };
    }
}

/**
 * Load benchmark eligibility set by cross-referencing the schema registry
 * benchmark constraints with the E2E catalog golden-path models.
 *
 * A model is golden-path eligible when:
 * 1. The schema registry is available and contains the CreateAIBenchmarkJob shape
 *    (indicating the benchmarking service is supported)
 * 2. The model's Hub content name appears in the E2E catalog's tuneConfig.tuneId
 *    (indicating it has been validated for both tune AND benchmark workflows)
 *
 * Requirements: 10.13, 10.14
 *
 * @param {string} [registryPath] - Override schema registry path
 * @returns {Set<string>} - Set of Hub content names eligible for benchmarking
 */
export function loadBenchmarkEligibility(registryPath) {
    // Step 1: Check if schema registry has benchmark support
    const schemaRegistryPath = registryPath || path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.ml-container-creator',
        'schemas'
    );

    const sagemakerModelPath = path.join(schemaRegistryPath, 'sagemaker', 'service-2.json');

    if (!existsSync(sagemakerModelPath)) {
        // Schema registry not available — no golden-path flagging
        return new Set();
    }

    let hasBenchmarkSupport = false;
    try {
        const modelContent = readFileSync(sagemakerModelPath, 'utf8');
        const model = JSON.parse(modelContent);
        const operations = model.operations || {};
        const shapes = model.shapes || {};

        // Check for the CreateAIBenchmarkJob operation or its input shape
        hasBenchmarkSupport = !!(operations.CreateAIBenchmarkJob || shapes.CreateAIBenchmarkJobRequest);
    } catch {
        // Failed to parse — no golden-path flagging
        return new Set();
    }

    if (!hasBenchmarkSupport) {
        // Benchmarking service not available in the schema registry
        return new Set();
    }

    // Step 2: Load E2E catalog to get golden-path models
    const e2eCatalogPath = path.resolve(__dirname, 'e2e-catalog.json');

    if (!existsSync(e2eCatalogPath)) {
        return new Set();
    }

    try {
        const e2eCatalog = JSON.parse(readFileSync(e2eCatalogPath, 'utf8'));
        const configs = e2eCatalog.configs || [];

        // Step 3: Extract tuneId from configs that have tuneConfig
        // These models are validated for both tune AND benchmark (golden-path)
        const eligibleModels = new Set();
        for (const config of configs) {
            if (config.tuneConfig && config.tuneConfig.tuneId) {
                eligibleModels.add(config.tuneConfig.tuneId);
            }
        }

        return eligibleModels;
    } catch {
        return new Set();
    }
}

/**
 * Write the catalog to disk.
 * @param {object} catalog - Full catalog object
 * @param {string} [catalogPath] - Override catalog path
 */
function writeCatalog(catalog, catalogPath) {
    const filePath = catalogPath || CATALOG_PATH;
    writeFileSync(filePath, `${JSON.stringify(catalog, null, 2)  }\n`, 'utf8');
}

/**
 * Sync model families from the SageMaker JumpStart Hub.
 * Orchestrates the full discovery → parse → merge → write flow.
 *
 * @param {object} [options]
 * @param {string} [options.region] - AWS region (default: AWS_REGION env or 'us-west-2')
 * @param {string} [options.catalogPath] - Override catalog file path
 * @param {string} [options.registryPath] - Override schema registry path for benchmark eligibility check
 * @param {import('@aws-sdk/client-sagemaker').SageMakerClient} [options.client] - Override SageMaker client (for testing)
 * @returns {Promise<{added: number, updated: number, total: number, goldenPath: number}>}
 */
export async function syncModelFamilies(options = {}) {
    const { SageMakerClient } = await import('@aws-sdk/client-sagemaker');

    const region = options.region || process.env.AWS_REGION || 'us-west-2';
    const client = options.client || new SageMakerClient({ region });
    const catalogPath = options.catalogPath || CATALOG_PATH;

    const discovered = {};
    let totalQueried = 0;

    for (const prefix of KNOWN_PREFIXES) {
        console.log(`  Querying Hub for prefix: ${prefix}...`);
        const models = await listHubModels(client, prefix);
        totalQueried += models.length;

        for (const model of models) {
            console.log(`    Describing: ${model.HubContentName}`);
            const detail = await describeHubContent(client, model.HubContentName);
            const recipes = parseRecipes(detail.HubContentDocument);

            if (recipes.length > 0) {
                discovered[model.HubContentName] = buildCatalogEntry(model, detail, recipes);
            }
        }
    }

    // Additive merge — existing entries are preserved
    const existing = loadExistingCatalog(catalogPath);
    const merged = { ...existing.models, ...discovered };

    // Cross-reference with benchmark eligibility (Req 10.13-10.14)
    const benchmarkModels = loadBenchmarkEligibility(options.registryPath);
    let goldenPathCount = 0;
    for (const [key, entry] of Object.entries(merged)) {
        entry.goldenPath = benchmarkModels.has(key);
        if (entry.goldenPath) goldenPathCount++;
    }

    // Compute stats
    const added = Object.keys(discovered).filter(k => !existing.models?.[k]).length;
    const updated = Object.keys(discovered).filter(k => existing.models?.[k]).length;
    const total = Object.keys(merged).length;

    // Write catalog with lastSynced timestamp
    const updatedCatalog = {
        ...existing,
        lastSynced: new Date().toISOString(),
        models: merged
    };
    writeCatalog(updatedCatalog, catalogPath);

    // Report summary
    console.log('');
    console.log('  📊 Sync Summary:');
    console.log(`     Hub models queried: ${totalQueried}`);
    console.log(`     Tune-eligible discovered: ${Object.keys(discovered).length}`);
    console.log(`     New families added: ${added}`);
    console.log(`     Models updated: ${updated}`);
    console.log(`     Total catalog entries: ${total}`);
    if (goldenPathCount > 0) {
        console.log(`     Golden-path eligible: ${goldenPathCount}`);
    }

    return { added, updated, total, goldenPath: goldenPathCount };
}

// Main guard for standalone execution
const isMainModule = process.argv[1] && (
    process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('sync-model-families.js')
);

if (isMainModule) {
    console.log('\n📦 Sync Model Families — Discovering supported models from JumpStart Hub...\n');

    syncModelFamilies()
        .then((result) => {
            console.log(`\n✅ Sync complete: ${result.added} new, ${result.updated} updated, ${result.total} total models\n`);
        })
        .catch((err) => {
            console.error(`\n❌ Sync failed: ${err.message}`);
            if (err.name === 'CredentialsProviderError' || err.message.includes('credentials')) {
                console.error('   Ensure AWS credentials are configured with sagemaker:ListHubContents and sagemaker:DescribeHubContent permissions.');
            }
            process.exit(1);
        });
}
