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
import { execFileSync } from 'node:child_process';
import { KNOWN_TECHNIQUES } from '../src/lib/managed-techniques.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATALOG_PATH = path.resolve(__dirname, '..', 'config', 'tune-catalog.json');

// BL129: where the per-technique tune descriptors live (the second sync output).
const TUNE_D = path.resolve(__dirname, '..', 'templates', 'code', 'tune.d');

// BL129: plumbing keys to EXCLUDE from the LEANER MTRL override-params flavor, which
// carries no `category` tag to filter on. Everything NOT in this denylist is treated
// as a surfaced hyperparameter. A drift test guards this list so a new plumbing key
// AWS adds can't silently become a knob. (The TAGGED flavor — sft/dpo/rlvr/rlaif —
// filters on `category: hyperparameter` instead and ignores this list.)
const MTRL_PLUMBING_DENYLIST = new Set([
    'data_path', 'model_name_or_path', 'output_path', 'name'
]);

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
 * Known HuggingFace-id casing corrections for Hub documents whose `HuggingfaceId`
 * field is mis-cased relative to the canonical (case-SENSITIVE) HF repo id.
 *
 * HF repo ids are case-sensitive: a wrong-cased id 307-redirects and staging fails
 * with an opaque JSONDecodeError. AWS's JumpStart Hub document for the Gemma VLM
 * records `google/gemma-4-e4b-it`, but the real repo is `google/gemma-4-E4B-it`
 * (verified: HF API 200 for E4B, 307 for e4b). This map corrects such verified
 * cases at sync time so the generator always yields a staffable id and a re-sync
 * does NOT reintroduce the bad casing (the sync's discovered-wins merge would
 * otherwise clobber a hand-fix). Keyed case-INSENSITIVELY on the Hub id; the value
 * is the exact canonical HF id. Add an entry ONLY with a verified HF 200.
 */
const HF_ID_CASING_CORRECTIONS = {
    'google/gemma-4-e4b-it': 'google/gemma-4-E4B-it'
};

/**
 * Apply a known casing correction to an extracted HuggingFace id, or return it
 * unchanged. Matches case-insensitively so a Hub doc in any casing resolves to the
 * one canonical id.
 * @param {string} hfId
 * @returns {string}
 */
export function correctHuggingFaceIdCasing(hfId) {
    if (!hfId) return hfId;
    const corrected = HF_ID_CASING_CORRECTIONS[hfId.toLowerCase()];
    return corrected || hfId;
}

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
function parseRecipes(hubContentDocument, modelName) {
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
        // Keyed off the shared KNOWN enum so a known-but-unimplemented technique (mtrl —
        // BL139) is RETAINED in the catalog rather than dropped at discovery. The
        // downstream picker/warning decide implemented-vs-not; sync just records what
        // the model advertises. (BL144 — this changes which TECHNIQUES are kept per
        // model, NOT which models are discovered: KNOWN_PREFIXES is untouched.)
        if (!KNOWN_TECHNIQUES.includes(normalizedTechnique)) continue;

        const trainingTypes = recipe.TrainingTypes || recipe.trainingTypes || ['lora'];
        const datasetFormat = recipe.DatasetFormat || recipe.datasetFormat || `default-${normalizedTechnique}`;
        const datasetSchema = recipe.DatasetSchema || recipe.datasetSchema || getDefaultDatasetSchema(normalizedTechnique);

        recipes.push({
            technique: normalizedTechnique,
            trainingTypes: Array.isArray(trainingTypes) ? trainingTypes.map(t => t.toLowerCase()) : ['lora'],
            datasetFormat,
            datasetSchema,
            // BL129: additive — the per-recipe PEFT mode + override-params pointers the
            // tune-descriptor sync needs. The catalog build ignores these; only
            // syncTuneDescriptors() reads them. `peft` maps LORA→'lora', anything else
            // (incl. 'None'/full-rank)→'full' to key the descriptor variant.
            peft: String(recipe.Peft || recipe.peft || 'lora').toLowerCase() === 'lora' ? 'lora' : 'full',
            smtjOverrideParamsS3Uri: _normalizeS3Pointer(recipe.SmtjOverrideParamsS3Uri),
            hpEksOverrideParamsS3Uri: _normalizeS3Pointer(recipe.HpEksOverrideParamsS3Uri),
            // Wave 11 (R9.3): the HP-EKS payload template (ConfigMap + workload) that
            // do/tune --backend hp-eks renders; its workload `kind:` is synced below.
            hpEksPayloadTemplateS3Uri: _normalizeS3Pointer(recipe.HpEksPayloadTemplateS3Uri),
            // The catalog's hpEks pointers are keyed by the recipe's REAL PEFT mode.
            // Live Hub data (2026-10-28) omits `Peft` on full-rank (fft) recipes, which
            // the `peft` fallback above reads as 'lora'; when Peft is absent the
            // AWS recipe name (`-fft` / `-lora`) decides instead.
            hpEksPeft: _hpEksPeft(recipe),
            // BL180: the model this recipe belongs to — the SDK-specs fetcher needs it
            // to construct the technique's trainer and read its authoritative _specs.
            model: modelName || null
        });
    }

    return recipes;
}

/**
 * PEFT key for a recipe's HP-EKS pointers: an explicit `Peft` wins (LORA → lora,
 * anything else → full); without one, a `fft`/`full` token in the recipe name or
 * payload URI means full-rank, else lora.
 * @param {object} recipe - a Hub RecipeCollection entry
 * @returns {'lora'|'full'}
 */
function _hpEksPeft(recipe) {
    const explicit = recipe.Peft || recipe.peft;
    if (explicit) return String(explicit).toLowerCase() === 'lora' ? 'lora' : 'full';
    const hint = `${recipe.Name || ''} ${recipe.HpEksPayloadTemplateS3Uri || ''}`;
    return /(^|[-_/])(fft|full)([-_.]|$)/i.test(hint) ? 'full' : 'lora';
}
/**
 * Normalize an override-params pointer: the Hub serializes an absent pointer as the
 * STRING "None" (seen live on MTRL's HpEksOverrideParamsS3Uri), so treat "None"/empty
 * as null. Returns the s3:// URI or null.
 * @param {*} value
 * @returns {string|null}
 */
function _normalizeS3Pointer(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!v || v === 'None' || v === 'null') return null;
    return v.startsWith('s3://') ? v : null;
}

/**
 * Get the default dataset schema for a technique.
 *
 * BL129: the RL arm (rlvr/rlaif/mtrl) previously returned `{prompt: array}` — a
 * VERIFIED-WRONG guess. The managed-RL dataset contract is STRUCTURAL and now lives
 * in the per-technique tune descriptor (`templates/code/tune.d/<technique>/
 * manifest.json` → `dataset_contract`, verl 5-field parquet), consumed by the
 * do/tune Gate's field-schema half — NOT a synced catalog guess. Only sft/dpo (the
 * jsonl techniques whose catalog schema is still read by `do/tune`'s jsonl line-check
 * via `_get_dataset_schema`) keep a default here. An RL technique falls through to {}
 * (contract-absent) rather than a fabricated schema.
 * @param {string} technique
 * @returns {object}
 */
function getDefaultDatasetSchema(technique) {
    switch (technique) {
    case 'sft':
        return { required: ['prompt', 'completion'], types: { prompt: 'string', completion: 'string' } };
    case 'dpo':
        return { required: ['prompt', 'chosen', 'rejected'], types: { prompt: 'string', chosen: 'string', rejected: 'string' } };
    default:
        // BL129: RL techniques (rlvr/rlaif/mtrl) and any other technique carry NO
        // guessed catalog schema — their dataset contract is structural, in the tune
        // descriptor. Contract-absent {} rather than a fabricated {prompt:...}.
        return {};
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

    // Extract HuggingFace id and provider from the Hub metadata document.
    let huggingFaceId = '';
    let docProvider = '';
    if (detail.HubContentDocument) {
        try {
            const doc = typeof detail.HubContentDocument === 'string'
                ? JSON.parse(detail.HubContentDocument)
                : detail.HubContentDocument;
            // JumpStart hub documents expose the HuggingFace id under a field whose
            // casing varies by schema. Observed: `HuggingfaceId` (huggingface-vlm-*,
            // e.g. "Qwen/Qwen3.6-27B"); older schemas used `HuggingFaceModelId` /
            // `ModelId`. Check all known spellings so the vlm family (Qwen 3.6, Gemma 4)
            // resolves a selectable id instead of being silently skipped by the picker.
            huggingFaceId = doc.HuggingfaceId
                || doc.HuggingFaceModelId
                || doc.huggingFaceModelId
                || doc.HuggingFaceId
                || doc.ModelId
                || '';
            // Correct known mis-cased Hub ids to the canonical (case-sensitive) HF
            // repo id so staging doesn't 307/fail and a re-sync won't reintroduce it.
            huggingFaceId = correctHuggingFaceIdCasing(huggingFaceId);
            // The hub document carries the authoritative model MAKER in `Provider`
            // (e.g. "Qwen", "nvidia", "deepseek"). Prefer it over name-prefix inference
            // so the picker groups by the real provider instead of falling to "unknown"
            // for families the prefix map does not recognize.
            docProvider = typeof doc.Provider === 'string' ? doc.Provider : '';
        } catch {
            // Ignore parse errors
        }
    }

    const techniques = {};
    for (const recipe of recipes) {
        const prev = techniques[recipe.technique];
        techniques[recipe.technique] = {
            trainingTypes: recipe.trainingTypes,
            datasetFormat: recipe.datasetFormat,
            datasetSchema: recipe.datasetSchema
        };
        // Wave 11 (R9.3): this model's HP-EKS payload pointers per PEFT variant
        // (a technique usually has a lora and a full recipe).
        const hpEks = { ...((prev && prev.hpEks) || {}) };
        if (recipe.hpEksPayloadTemplateS3Uri) {
            hpEks[recipe.hpEksPeft || recipe.peft] = {
                payloadTemplate: recipe.hpEksPayloadTemplateS3Uri,
                overrideParams: recipe.hpEksOverrideParamsS3Uri || null
            };
        }
        if (Object.keys(hpEks).length > 0) techniques[recipe.technique].hpEks = hpEks;
    }

    return {
        family: deriveFamily(hubContentName),
        // Hub-document `Provider` wins; name-prefix inference is the fallback.
        provider: docProvider || deriveProvider(hubContentName),
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

// ── BL129: tune-descriptor synced layer ─────────────────────────────────────────
//
// The SAME Hub traversal that builds the model catalog also populates each tune
// descriptor's SYNCED layer (hyperparameters + _synced) from AWS's recipe
// override-params objects. One pass, two outputs — the two catalogs cannot disagree
// about which recipes exist. The STRUCTURAL layer (hand-authored) is preserved.

/**
 * Extract a semver from an override-params S3 key, e.g.
 * `..._override_params_sm_jobs_v2.2.7.json` → "2.2.7". Returns null when absent.
 * @param {string} uri
 * @returns {string|null}
 */
function _versionFromOverrideParamsUri(uri) {
    if (typeof uri !== 'string') return null;
    const m = uri.match(/_v(\d+\.\d+\.\d+)\.json$/);
    return m ? m[1] : null;
}

/**
 * Map ONE AWS override-param entry onto the descriptor's canonical hyperparameter
 * entry shape (see templates/code/tune.d/manifest.schema.json $defs/hyperparameter).
 * Renames `control_type`→`control` and `visibility_tier`→`tier`; defaults `required`
 * to false when the source omits it; carries default/min/max/step/enum/display_name/
 * description/hint where present. Returns null for a value that is not an object.
 * @param {object} knob - the override-param entry
 * @returns {object|null}
 */
// AWS override-param `type` strings → the schema's allowed `type` enum
// (templates/code/tune.d/manifest.schema.json $defs/hyperparameter: string |
// integer | number | boolean). AWS uses `float` for reals and occasionally
// `array` for multi-value knobs, neither of which the schema names — so normalize
// here rather than write a schema-invalid descriptor. `float` → `number`;
// `array` → `string` (a multi-value knob is surfaced as free text; its `enum`,
// when present, is carried separately). Unknown types fall back to `string` with
// a warning so a new AWS type never silently produces an invalid descriptor.
const _OVERRIDE_PARAM_TYPE_MAP = {
    string: 'string', integer: 'integer', number: 'number', boolean: 'boolean',
    float: 'number', double: 'number', int: 'integer', bool: 'boolean',
    array: 'string', list: 'string'
};

function _normalizeKnobType(rawType) {
    if (typeof rawType !== 'string') return 'string';
    const mapped = _OVERRIDE_PARAM_TYPE_MAP[rawType.toLowerCase()];
    if (mapped) return mapped;
    console.warn(`[sync-tune] unknown override-param type '${rawType}' → defaulting to 'string'; add it to _OVERRIDE_PARAM_TYPE_MAP if it should map elsewhere.`);
    return 'string';
}

function _mapOverrideParamKnob(knob) {
    if (!knob || typeof knob !== 'object') return null;
    const entry = {
        type: _normalizeKnobType(knob.type),
        required: knob.required === true
    };
    if ('default' in knob) entry.default = knob.default;
    for (const k of ['min', 'max', 'step']) {
        if (typeof knob[k] === 'number') entry[k] = knob[k];
    }
    if (Array.isArray(knob.enum) && knob.enum.length) entry.enum = knob.enum;
    if (typeof knob.control_type === 'string') entry.control = knob.control_type;
    if (typeof knob.visibility_tier === 'string') entry.tier = knob.visibility_tier;
    for (const k of ['display_name', 'description', 'hint']) {
        if (typeof knob[k] === 'string') entry[k] = knob[k];
    }
    return entry;
}

/**
 * Decide whether an override-param key is a surfaced HYPERPARAMETER (vs system/
 * plumbing). Handles BOTH flavors:
 *   - TAGGED (sft/dpo/rlvr/rlaif): the entry carries `category`; keep only
 *     `category === 'hyperparameter'`.
 *   - LEANER MTRL (no `category` on any entry): keep everything NOT in
 *     MTRL_PLUMBING_DENYLIST.
 * @param {string} name
 * @param {object} knob
 * @param {boolean} tagged - whether this override-params object uses the tagged flavor
 * @returns {boolean}
 */
function _isSurfacedHyperparameter(name, knob, tagged) {
    // Wave 11 (R9.3): the k8s override params tag `namespace` as a hyperparameter;
    // it is MLCC's cluster placement (HP_NAMESPACE), never a training knob.
    if (name === 'namespace') return false;
    if (tagged) return knob && knob.category === 'hyperparameter';
    return !MTRL_PLUMBING_DENYLIST.has(name);
}

/** Workload kinds do/tune --backend hp-eks knows how to gate (R9.1 / R9.2). */
export const HP_EKS_WORKLOAD_KINDS = ['HyperPodPyTorchJob', 'RayJob'];
/**
 * Read the workload kind (the non-ConfigMap top-level `kind:`) from an HP-EKS
 * payload template's text. Returns a HP_EKS_WORKLOAD_KINDS member or null.
 * @param {string} text
 * @returns {string|null}
 */
export function readWorkloadKind(text) {
    if (typeof text !== 'string') return null;
    for (const m of text.matchAll(/^kind:\s*([A-Za-z]+)\s*$/gm)) {
        if (m[1] === 'ConfigMap') continue;
        return HP_EKS_WORKLOAD_KINDS.includes(m[1]) ? m[1] : null;
    }
    return null;
}
/**
 * Default payload-template fetcher: read-only `aws s3 cp <uri> -`.
 * @param {string} [region]
 * @returns {(uri: string) => Promise<string|null>}
 */
function _defaultFetchPayloadTemplate(region) {
    return async function fetchTemplate(uri) {
        try {
            const args = ['s3', 'cp', uri, '-'];
            if (region || process.env.AWS_REGION) args.push('--region', region || process.env.AWS_REGION);
            return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
        } catch {
            return null;
        }
    };
}
/**
 * Build the synced `hyperparameters` block from a parsed override-params object.
 * @param {object} overrideParams - the override-params JSON (knob-name → entry)
 * @returns {object} canonical hyperparameters map
 */
function buildHyperparametersBlock(overrideParams) {
    const op = overrideParams && typeof overrideParams === 'object' ? overrideParams : {};
    // TAGGED iff ANY entry carries a `category` field (the leaner MTRL flavor has none).
    const tagged = Object.values(op).some(
        v => v && typeof v === 'object' && typeof v.category === 'string'
    );
    const out = {};
    for (const [name, knob] of Object.entries(op)) {
        if (!_isSurfacedHyperparameter(name, knob, tagged)) continue;
        const mapped = _mapOverrideParamKnob(knob);
        if (mapped) out[name] = mapped;
    }
    return out;
}

/**
 * Additive-merge the SYNCED layer into a descriptor's variant, PRESERVING every
 * structural field (peft, artifact_kind, dataset_contract). Mutates `variant`.
 * @param {object} variant - the descriptor variant object
 * @param {object} syncedHyperparameters
 * @param {object} syncedBlock - per-backend {smtj?, hp-eks?} provenance
 */
function mergeSyncedIntoVariant(variant, syncedHyperparameters, syncedBlock) {
    variant.hyperparameters = syncedHyperparameters;
    variant._synced = syncedBlock;
}

/**
 * Sync the per-technique tune descriptors' SYNCED layer from the recipes discovered
 * in the Hub traversal. For each (technique, variant) with an SMTJ override-params
 * pointer, fetch + filter + map the knobs and additive-merge into
 * tune.d/<technique>/manifest.json. Idempotent: a variant whose `_synced.smtj.version`
 * already equals the recipe's version is skipped (no rewrite). The STRUCTURAL layer is
 * never touched. Fetch failures leave the existing synced layer intact (never regress).
 *
 * @param {Array<{technique, peft, smtjOverrideParamsS3Uri, hpEksOverrideParamsS3Uri}>} recipes
 *   — flattened across every discovered model (duplicates by technique+peft are fine;
 *   last write wins, and the version-skip makes re-runs no-ops).
 * @param {object} [opts]
 * @param {(uri: string) => Promise<object|null>} [opts.fetchOverrideParams] - injectable
 *   fetcher (default: S3 GetObject → parsed JSON). Injected in tests to stay offline.
 * @param {string} [opts.tuneDir] - override the tune.d root (tests).
 * @param {string} [opts.region]
 * @returns {Promise<{synced: number, skipped: number, failed: number}>}
 */
export async function syncTuneDescriptors(recipes, opts = {}) {
    const tuneDir = opts.tuneDir || TUNE_D;
    const fetchOverrideParams = opts.fetchOverrideParams || _defaultFetchOverrideParams(opts.region);
    const fetchPayloadTemplate = opts.fetchPayloadTemplate || _defaultFetchPayloadTemplate(opts.region);
    // Wave 11 (R9.3): the hp-eks workload kind, read from the payload template. A
    // failed fetch returns the PREVIOUS value (never regress).
    const workloadKindFor = async (recipe, previous) => {
        if (!recipe.hpEksPayloadTemplateS3Uri) return previous || null;
        let text = null;
        try {
            text = await fetchPayloadTemplate(recipe.hpEksPayloadTemplateS3Uri);
        } catch {
            text = null;
        }
        return readWorkloadKind(text) || previous || null;
    };

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    // De-dupe recipes by technique+peft (many models advertise the same recipe; one
    // fetch per distinct descriptor variant suffices). Prefer an entry WITH an SMTJ
    // pointer over one without.
    const byVariant = new Map();
    for (const r of recipes || []) {
        if (!r || !r.technique || !r.peft) continue;
        const key = `${r.technique}/${r.peft}`;
        const existing = byVariant.get(key);
        if (!existing || (!existing.smtjOverrideParamsS3Uri && r.smtjOverrideParamsS3Uri)) {
            byVariant.set(key, r);
        }
    }

    for (const [key, recipe] of byVariant) {
        const [technique, variantKey] = key.split('/');
        const manifestPath = path.join(tuneDir, technique, 'manifest.json');
        if (!existsSync(manifestPath)) continue; // no descriptor for this technique

        const smtjUri = recipe.smtjOverrideParamsS3Uri;
        if (!smtjUri) continue; // nothing to sync from

        let manifest;
        try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
            failed++;
            continue;
        }
        const variant = manifest.variants && manifest.variants[variantKey];
        if (!variant) continue; // descriptor doesn't declare this variant

        const version = _versionFromOverrideParamsUri(smtjUri);
        const prevHp = (variant._synced && variant._synced['hp-eks']) || null;
        // Idempotent: skip when the recorded smtj version is unchanged — UNLESS forced.
        // BL180 note: the version-skip keys off the recipe URI version, but the
        // AUTHORITATIVE source is now the SMTJ SDK's _specs (which can change even when
        // the recipe URI version does not — e.g. an SDK upgrade that fixes the valid-
        // options set). `opts.force` (sync:models --force) bypasses the skip so a
        // re-source / SDK-change can be pulled in. Without --force the skip still makes
        // ordinary re-runs cheap no-ops.
        if (!opts.force
            && version
            && variant._synced && variant._synced.smtj
            && variant._synced.smtj.version === version) {
            // The knob block is unchanged, but an hp-eks entry synced before Wave 11
            // has no workload_kind yet: backfill just that (no knob refetch).
            if (prevHp && !prevHp.workload_kind && recipe.hpEksPayloadTemplateS3Uri) {
                const kind = await workloadKindFor(recipe, null);
                if (kind) {
                    prevHp.workload_kind = kind;
                    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
                }
            }
            skipped++;
            continue;
        }

        let overrideParams;
        try {
            // BL180: the fetcher receives the RECIPE (technique + model + peft), not
            // just the S3 uri — the authoritative source is the SMTJ SDK's resolved
            // `_specs` (recipe + the trainer's per-technique mutations), which the
            // default fetcher reads by constructing the trainer via the Python helper.
            // The raw override-params file is version-skewed from the validator and is
            // NO LONGER the source (it listed knobs the trainer rejects + a stale enum).
            overrideParams = await fetchOverrideParams(recipe);
        } catch {
            overrideParams = null;
        }
        if (!overrideParams) {
            // Fetch failed → leave the existing synced layer intact (never regress).
            failed++;
            continue;
        }

        const hyperparameters = buildHyperparametersBlock(overrideParams);
        const syncedBlock = { smtj: { from: smtjUri, version: version || '0.0.0' } };
        // hp-eks only when the pointer genuinely exists (MTRL's is null → omit).
        if (recipe.hpEksOverrideParamsS3Uri) {
            syncedBlock['hp-eks'] = {
                from: recipe.hpEksOverrideParamsS3Uri,
                version: _versionFromOverrideParamsUri(recipe.hpEksOverrideParamsS3Uri) || '0.0.0'
            };
            const kind = await workloadKindFor(recipe, prevHp && prevHp.workload_kind);
            if (kind) syncedBlock['hp-eks'].workload_kind = kind;
        }

        mergeSyncedIntoVariant(variant, hyperparameters, syncedBlock);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        synced++;
    }

    return { synced, skipped, failed };
}

/**
 * Default spec fetcher (BL180): read the SMTJ SDK's AUTHORITATIVE fine-tuning
 * `_specs` for a recipe's (technique, model[, peft]) by invoking the Python helper
 * `scripts/dump-tune-specs.py`, which constructs the trainer and dumps `_specs` as
 * JSON. This REPLACES the old raw-S3-recipe fetch: the recipe override-params file
 * was version-skewed from the trainer's own validator (listed knobs the SDK rejects,
 * omitted ones it accepts, carried a stale global_batch_size enum). The `_specs` dict
 * has the SAME entry shape as the override-params, so buildHyperparametersBlock /
 * _mapOverrideParamKnob consume it unchanged. Network+SDK-dependent; the injectable
 * seam (opts.fetchOverrideParams) keeps the unit tests offline.
 *
 * Returns null on any failure (missing model, helper error, non-JSON) so the caller
 * leaves the existing synced layer intact (never regress).
 * @param {string} [region]
 * @param {string} [pythonBin] python interpreter (default: process.env.PYTHON or 'python3')
 * @returns {(recipe: {technique: string, model: string, peft?: string}) => Promise<object|null>}
 */
function _defaultFetchOverrideParams(region, pythonBin) {
    // The helper needs the SMTJ SDK (sagemaker.train). Bare `python3` usually lacks it;
    // prefer the repo venv's interpreter (.venv/bin/python) when present, then an
    // explicit override, then fall back to python3. (BL180: the sync counted all
    // techniques as "failed" when it shelled out to a bare python3 without the SDK.)
    const _venvPy = path.resolve(__dirname, '..', '.venv', 'bin', 'python');
    const py = pythonBin
        || process.env.MLCC_SYNC_PYTHON
        || process.env.PYTHON
        || (existsSync(_venvPy) ? _venvPy : 'python3');
    const helper = path.resolve(__dirname, 'dump-tune-specs.py');
    return async function fetchFromSdk(recipe) {
        if (!recipe || !recipe.technique || !recipe.model) return null;
        const args = [
            helper,
            '--technique', recipe.technique,
            '--model', recipe.model,
            '--training-type', recipe.peft === 'full' ? 'full-rank' : 'lora'
        ];
        if (region || process.env.AWS_REGION) {
            args.push('--region', region || process.env.AWS_REGION);
        }
        let out;
        try {
            // stdout is PURE JSON (the helper routes SDK noise to stderr). Inherit
            // stderr so sync logs/errors remain visible; cap the buffer generously.
            out = execFileSync(py, args, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'inherit'],
                maxBuffer: 32 * 1024 * 1024
            });
        } catch {
            return null; // helper exited non-zero (e.g. {"error": ...}) → treat as fetch failure
        }
        let parsed;
        try {
            parsed = JSON.parse(out);
        } catch {
            return null;
        }
        if (!parsed || typeof parsed !== 'object' || parsed.error) return null;
        return parsed;
    };
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
    // BL129: accumulate every parsed recipe (across all models) so the tune-descriptor
    // sync runs in the SAME traversal as the catalog build — one pass, two outputs.
    const allRecipes = [];

    for (const prefix of KNOWN_PREFIXES) {
        console.log(`  Querying Hub for prefix: ${prefix}...`);
        const models = await listHubModels(client, prefix);
        totalQueried += models.length;

        for (const model of models) {
            console.log(`    Describing: ${model.HubContentName}`);
            const detail = await describeHubContent(client, model.HubContentName);
            const recipes = parseRecipes(detail.HubContentDocument, model.HubContentName);

            if (recipes.length > 0) {
                discovered[model.HubContentName] = buildCatalogEntry(model, detail, recipes);
                allRecipes.push(...recipes);
            }
        }
    }

    // Deep merge — discovered entries update existing, but empty API values don't overwrite curated data
    const existing = loadExistingCatalog(catalogPath);
    const merged = { ...existing.models };

    for (const [key, discoveredEntry] of Object.entries(discovered)) {
        const existingEntry = merged[key];
        if (!existingEntry) {
            // New model — add as-is
            merged[key] = discoveredEntry;
        } else {
            // Existing model — deep merge, preserving non-empty curated values
            merged[key] = {
                ...existingEntry,
                // Only overwrite scalar fields if discovered value is non-empty
                family: discoveredEntry.family || existingEntry.family,
                provider: discoveredEntry.provider || existingEntry.provider,
                displayName: discoveredEntry.displayName || existingEntry.displayName,
                huggingFaceId: discoveredEntry.huggingFaceId || existingEntry.huggingFaceId,
                // Merge techniques: discovered techniques augment existing
                techniques: {
                    ...existingEntry.techniques,
                    ...discoveredEntry.techniques
                }
            };
        }
    }

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

    // BL129: second output of the same traversal — populate each tune descriptor's
    // SYNCED layer from the recipes' override-params. Opt-out via
    // `options.syncDescriptors === false` (tests that only assert catalog behavior).
    // The fetcher is injectable (`options.fetchOverrideParams`) so the default test
    // gate stays offline.
    let descriptorResult = { synced: 0, skipped: 0, failed: 0 };
    if (options.syncDescriptors !== false) {
        descriptorResult = await syncTuneDescriptors(allRecipes, {
            fetchOverrideParams: options.fetchOverrideParams,
            tuneDir: options.tuneDir,
            force: options.force,
            fetchPayloadTemplate: options.fetchPayloadTemplate,
            region
        });
    }

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
    console.log(`     Tune descriptors synced: ${descriptorResult.synced} ` +
        `(${descriptorResult.skipped} unchanged, ${descriptorResult.failed} failed)`);

    return {
        added, updated, total, goldenPath: goldenPathCount,
        descriptors: descriptorResult
    };
}

// Main guard for standalone execution
const isMainModule = process.argv[1] && (
    process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('sync-model-families.js')
);

if (isMainModule) {
    console.log('\n📦 Sync Model Families — Discovering supported models from JumpStart Hub...\n');

    // BL180: --force re-syncs the tune-descriptor synced layer even when the recipe
    // URI version is unchanged (needed to pull an SDK-sourced _specs change).
    const _force = process.argv.includes('--force');
    syncModelFamilies({ force: _force })
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
