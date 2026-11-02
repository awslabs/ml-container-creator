// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model Metadata Resolver for the instance-sizer MCP server.
 *
 * Resolution pipeline:
 *   1. Load model-sizes catalog (pre-built, offline-safe)
 *   2. Attempt catalog lookup via glob pattern matching
 *   3. If discover=true and no catalog hit, query the HuggingFace Hub (model API
 *      safetensors metadata for the parameter count + config.json, including
 *      the nested `text_config` of multimodal models)
 *   4. Extract parameter count, dtype, architecture, context length; when the
 *      size cannot be determined, parameterCount is null (never zero)
 *
 * Exports:
 *   - resolveModelMetadata(modelName, options) — full resolution pipeline
 *   - globMatch(pattern, string) — glob-style pattern matching (case-insensitive)
 *   - loadCatalog(path) — loads the model-sizes JSON catalog
 *   - catalogLookup(modelName, catalog) — finds a model in the catalog
 *   - estimateParamsFromConfig(config) — estimates params from architecture dimensions
 *   - extractFromHuggingFaceConfig(config) — extracts metadata from HF config.json
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CATALOG_PATH = resolve(__dirname, '../../lib/catalogs/model-sizes.json');

/**
 * Known protocol prefixes that indicate non-HuggingFace model sources.
 * Models with these prefixes are never fetched from HuggingFace Hub.
 */
export const PROTOCOL_PREFIXES = [
    's3://',
    'registry://',
    'marketplace://',
    'jumpstart://',
    'jumpstart-hub://'
];

/**
 * Determine if a model name matches the HuggingFace pattern: org/model-name.
 * Must contain exactly one `/` and must NOT start with a protocol prefix.
 *
 * @param {string} modelName - The model identifier to test
 * @returns {boolean} Whether the model name is a HuggingFace model ID
 */
export function isHuggingFacePattern(modelName) {
    if (!modelName || typeof modelName !== 'string') {
        return false;
    }
    if (PROTOCOL_PREFIXES.some(prefix => modelName.startsWith(prefix))) {
        return false;
    }
    const slashCount = (modelName.match(/\//g) || []).length;
    return slashCount === 1;
}

/**
 * Glob-style pattern matching (case-insensitive).
 * Supports `*` as a wildcard that matches any sequence of characters.
 *
 * @param {string} pattern - Pattern with optional `*` wildcards
 * @param {string} string - String to test against the pattern
 * @returns {boolean} Whether the string matches the pattern
 */
export function globMatch(pattern, string) {
    // Escape regex special characters except `*`
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Replace `*` with `.*` for regex matching
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
    return regex.test(string);
}

/**
 * Load the model-sizes catalog from a JSON file.
 *
 * @param {string} [catalogPath] - Absolute path to the catalog JSON file
 * @returns {Promise<Object|null>} Parsed catalog object, or null if file not found/invalid
 */
export async function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
    try {
        const raw = readFileSync(catalogPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Look up a model in the catalog using glob pattern matching.
 * Iterates over catalog keys (which may contain `*` wildcards) and
 * returns the first matching entry.
 *
 * @param {string} modelName - HuggingFace model ID (e.g., "meta-llama/Llama-3.1-8B-Instruct")
 * @param {Object|null} catalog - Loaded catalog object with a `models` field
 * @returns {Object|null} Matching catalog entry, or null
 */
export function catalogLookup(modelName, catalog) {
    if (!catalog || !catalog.models) {
        return null;
    }

    for (const [pattern, entry] of Object.entries(catalog.models)) {
        if (globMatch(pattern, modelName)) {
            return entry;
        }
    }

    return null;
}

/**
 * Sub-config keys under which multimodal / composite HF configs nest the
 * language-model dimensions (e.g. Qwen3_5ForConditionalGeneration,
 * Qwen2_5_VLForConditionalGeneration, Gemma3ForConditionalGeneration,
 * LlavaForConditionalGeneration put hidden_size, num_hidden_layers,
 * max_position_embeddings and dtype under `text_config`). Reading only the
 * top level of such a config silently yields no size and a bogus 4096 context.
 */
export const NESTED_TEXT_CONFIG_KEYS = ['text_config', 'llm_config', 'language_config'];

/**
 * Config keys whose presence means the model is a mixture-of-experts. The
 * dense-transformer parameter formula does not apply to these, so
 * estimateParamsFromConfig refuses to guess.
 */
const MOE_CONFIG_KEYS = ['num_experts', 'num_local_experts', 'n_routed_experts', 'moe_num_experts'];

/**
 * safetensors dtype tags (HF Hub API `safetensors.parameters` keys) → the
 * dtype names used by the VRAM estimator.
 */
export const SAFETENSORS_DTYPE_MAP = {
    BF16: 'bfloat16',
    F16: 'float16',
    F32: 'float32',
    I8: 'int8',
    U8: 'int8',
    F8_E4M3: 'int8',
    F8_E5M2: 'int8'
};

/**
 * Return the nested language-model sub-config of a composite (multimodal)
 * HF config, or null for a plain causal-LM config.
 *
 * @param {Object} config - Parsed HF config.json
 * @returns {Object|null}
 */
export function nestedTextConfig(config) {
    if (!config || typeof config !== 'object') return null;
    for (const key of NESTED_TEXT_CONFIG_KEYS) {
        const sub = config[key];
        if (sub && typeof sub === 'object' && !Array.isArray(sub)) return sub;
    }
    return null;
}

/**
 * Read a field from the top level of an HF config, falling back to the
 * nested language-model sub-config (see NESTED_TEXT_CONFIG_KEYS).
 *
 * @param {Object} config - Parsed HF config.json
 * @param {string} key - Field name
 * @returns {*} The value, or undefined when absent at both levels
 */
export function configField(config, key) {
    if (config && config[key] !== undefined && config[key] !== null) return config[key];
    const sub = nestedTextConfig(config);
    if (sub && sub[key] !== undefined && sub[key] !== null) return sub[key];
    return undefined;
}

/**
 * Estimate parameter count of a DENSE transformer from its config dimensions:
 *   layers × 12 × hidden² (attention + MLP blocks) + vocab × hidden embeddings
 *   (×2 when input/output embeddings are untied).
 *
 * This is a last-resort derivation, used only when neither the HF Hub
 * safetensors metadata nor `num_parameters` is available. It refuses to guess
 * (returns null) for mixture-of-experts configs, where the dense formula is
 * wrong by an order of magnitude.
 *
 * @param {Object} config - Model configuration (HuggingFace config.json format)
 * @returns {number|null} Estimated parameter count, or null if dimensions are missing / MoE
 */
export function estimateParamsFromConfig(config) {
    if (!config || typeof config !== 'object') return null;
    const hiddenSize = configField(config, 'hidden_size');
    const numLayers = configField(config, 'num_hidden_layers');

    if (!hiddenSize || !numLayers) {
        return null;
    }
    if (MOE_CONFIG_KEYS.some(k => configField(config, k))) {
        return null;
    }

    const vocabSize = configField(config, 'vocab_size') || 0;
    const tied = configField(config, 'tie_word_embeddings') === true;
    const embeddingParams = vocabSize * hiddenSize * (tied ? 1 : 2);
    return numLayers * 12 * hiddenSize * hiddenSize + embeddingParams;
}

/**
 * Normalize a dtype string from config.json (`torch_dtype` / `dtype`) to the
 * estimator's names. Returns null for unknown values.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function normalizeDtype(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.toLowerCase().replace(/^torch\./, '');
    if (v === 'bfloat16' || v === 'bf16') return 'bfloat16';
    if (v === 'float16' || v === 'fp16' || v === 'half') return 'float16';
    if (v === 'float32' || v === 'fp32' || v === 'float') return 'float32';
    return null;
}

/**
 * Pick the dominant weight dtype from HF Hub safetensors metadata
 * (`{ parameters: { BF16: n, F32: m }, total }`).
 *
 * @param {Object|null} safetensors
 * @returns {string|null}
 */
export function dominantSafetensorsDtype(safetensors) {
    const params = safetensors?.parameters;
    if (!params || typeof params !== 'object') return null;
    let best = null;
    let bestCount = -1;
    for (const [tag, count] of Object.entries(params)) {
        if (typeof count === 'number' && count > bestCount && SAFETENSORS_DTYPE_MAP[tag]) {
            best = SAFETENSORS_DTYPE_MAP[tag];
            bestCount = count;
        }
    }
    return best;
}

/**
 * Extract model metadata from a HuggingFace config.json object, optionally
 * combined with the HF Hub API's safetensors metadata (authoritative
 * parameter count, read from the published weight-file headers).
 *
 * Parameter-count precedence (first available wins, the source is recorded
 * in `parameterCountSource`):
 *   1. `safetensors.total` from the HF Hub model API
 *   2. `num_parameters` in config.json
 *   3. a dense-transformer estimate from config dimensions (never for MoE)
 * When none apply, `parameterCount` is null — callers must treat that as
 * "size unknown", never as zero.
 *
 * Multimodal configs that nest the language model under `text_config` (and
 * siblings) are read through `configField`. `maxPositionEmbeddings` is null
 * when the config does not publish it (no fabricated 4096).
 *
 * @param {Object} config - Parsed config.json from HuggingFace Hub ({} when unavailable)
 * @param {Object} [hubInfo] - Optional HF Hub API metadata `{ safetensors }`
 * @returns {Object} Extracted metadata
 */
export function extractFromHuggingFaceConfig(config, hubInfo = null) {
    const cfg = config || {};
    const safetensorsTotal = hubInfo?.safetensors?.total;
    let parameterCount = null;
    let parameterCountSource = null;
    if (typeof safetensorsTotal === 'number' && safetensorsTotal > 0) {
        parameterCount = safetensorsTotal;
        parameterCountSource = 'huggingface-safetensors-metadata';
    } else if (configField(cfg, 'num_parameters')) {
        parameterCount = configField(cfg, 'num_parameters');
        parameterCountSource = 'config.num_parameters';
    } else {
        const estimated = estimateParamsFromConfig(cfg);
        if (estimated) {
            parameterCount = estimated;
            parameterCountSource = 'config-dimension-estimate';
        }
    }

    const dtype = normalizeDtype(configField(cfg, 'torch_dtype'))
        || normalizeDtype(configField(cfg, 'dtype'))
        || dominantSafetensorsDtype(hubInfo?.safetensors)
        || 'float16';
    const architectures = cfg.architectures || hubInfo?.config?.architectures;
    const architecture = (architectures && architectures[0]) || 'unknown';
    const maxPositionEmbeddings = configField(cfg, 'max_position_embeddings') || null;

    // Extract architecture params for KV cache computation (computeMaxModelLen)
    const hiddenSize = configField(cfg, 'hidden_size');
    const numAttnHeads = configField(cfg, 'num_attention_heads');
    const numLayers = configField(cfg, 'num_hidden_layers') || null;
    const numKvHeads = configField(cfg, 'num_key_value_heads') || numAttnHeads || null;
    const headDim = configField(cfg, 'head_dim') || (hiddenSize && numAttnHeads
        ? Math.floor(hiddenSize / numAttnHeads)
        : null);

    const result = {
        parameterCount,
        parameterCountSource,
        dtype,
        architecture,
        maxPositionEmbeddings,
        source: 'huggingface_api'
    };

    // Only include architecture params if available (graceful degradation)
    if (numLayers) result.numLayers = numLayers;
    if (numKvHeads) result.numKvHeads = numKvHeads;
    if (headDim) result.headDim = headDim;

    return result;
}

/**
 * Fetch JSON from a URL with a timeout. Returns null on any failure.
 *
 * @param {Function} fetchImpl - fetch implementation
 * @param {string} url
 * @param {number} timeout - ms
 * @param {Object} headers
 * @returns {Promise<Object|null>}
 */
async function fetchJson(fetchImpl, url, timeout, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetchImpl(url, { signal: controller.signal, headers });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Discover model sizing metadata from the HuggingFace Hub.
 *
 * Queries, in parallel, the Hub model API (`/api/models/<id>` — public even
 * for gated repos, carries the authoritative safetensors parameter count) and
 * the repo's config.json (context length / dtype / KV-head dimensions; may be
 * 401 for gated repos without HF_TOKEN). Returns null when neither is
 * reachable.
 *
 * @param {string} modelName - HF model id (org/name)
 * @param {Object} [options]
 * @param {number} [options.timeout=5000]
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {string} [options.hfToken] - Optional HF token (defaults to $HF_TOKEN)
 * @returns {Promise<Object|null>}
 */
export async function discoverFromHuggingFace(modelName, options = {}) {
    const {
        timeout = 5000,
        fetchImpl = globalThis.fetch,
        hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || ''
    } = options;
    if (typeof fetchImpl !== 'function') return null;

    const headers = {
        'User-Agent': 'ml-container-creator/instance-sizer',
        ...(hfToken ? { Authorization: `Bearer ${hfToken}` } : {})
    };
    const [hubInfo, config] = await Promise.all([
        fetchJson(fetchImpl, `https://huggingface.co/api/models/${modelName}`, timeout, headers),
        fetchJson(fetchImpl, `https://huggingface.co/${modelName}/resolve/main/config.json`, timeout, headers)
    ]);

    if (!hubInfo && !config) return null;
    return extractFromHuggingFaceConfig(config || {}, hubInfo);
}

/**
 * True when resolved metadata carries a usable (positive, finite) parameter count.
 *
 * @param {Object|null} metadata
 * @returns {boolean}
 */
export function hasUsableSize(metadata) {
    const n = metadata?.parameterCount;
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Resolve model metadata through the full pipeline:
 *   1. Catalog lookup (offline, fast)
 *   2. HuggingFace Hub fetch (if discover=true and no catalog hit)
 *
 * @param {string} modelName - HuggingFace model ID
 * @param {Object} [options] - Resolution options
 * @param {string} [options.catalogPath] - Path to model-sizes catalog
 * @param {boolean} [options.discover=true] - Whether to fetch from HuggingFace Hub on cache miss
 * @param {number} [options.timeout=5000] - HTTP timeout for HuggingFace API (ms)
 * @param {string} [options.localCatalogPath] - Path to a project-local catalog override (checked first)
 * @param {Function} [options.fetchImpl] - fetch implementation (tests inject a stub)
 * @returns {Promise<Object|null>} Resolved metadata, or null if unresolvable.
 *   A returned object may still have `parameterCount: null` (e.g. an
 *   incomplete local-catalog entry when the Hub is unreachable) — check with
 *   hasUsableSize() before sizing.
 */
export async function resolveModelMetadata(modelName, options = {}) {
    const {
        catalogPath = DEFAULT_CATALOG_PATH,
        discover = true,
        localCatalogPath = null,
        timeout = 5000,
        fetchImpl
    } = options;

    // Step 1a: Try project-local catalog first (written by do/stage for unknown models).
    // An entry WITHOUT a parameter count (older do/stage registrations of
    // multimodal configs wrote only architecture/dtype/context) cannot size the
    // model, so it must not shadow the shipped catalog or Hub discovery — keep
    // it only as a last-resort partial result.
    let incompleteLocal = null;
    if (localCatalogPath) {
        const localCatalog = await loadCatalog(localCatalogPath);
        if (localCatalog) {
            const localEntry = catalogLookup(modelName, localCatalog);
            if (localEntry) {
                const localResult = {
                    parameterCount: localEntry.parameterCount ?? null,
                    dtype: localEntry.defaultDtype || 'float16',
                    architecture: localEntry.architecture || 'unknown',
                    // do/stage omits an unknown context length — keep it unknown
                    // (null) rather than inventing 4096.
                    maxPositionEmbeddings: localEntry.maxPositionEmbeddings || null,
                    source: 'local-catalog',
                    ...(localEntry.parameterCountSource ? { parameterCountSource: localEntry.parameterCountSource } : {}),
                    ...(localEntry.numLayers ? { numLayers: localEntry.numLayers } : {}),
                    ...(localEntry.numKvHeads ? { numKvHeads: localEntry.numKvHeads } : {}),
                    ...(localEntry.headDim ? { headDim: localEntry.headDim } : {}),
                    ...(localEntry.recommendedInstances ? { recommendedInstances: localEntry.recommendedInstances } : {})
                };
                if (hasUsableSize(localResult)) {
                    return localResult;
                }
                incompleteLocal = localResult;
            }
        }
    }

    // Step 1b: Try shipped catalog lookup
    const catalog = await loadCatalog(catalogPath);
    const catalogEntry = catalogLookup(modelName, catalog);

    if (catalogEntry) {
        const result = {
            parameterCount: catalogEntry.parameterCount,
            dtype: catalogEntry.defaultDtype || 'float16',
            architecture: catalogEntry.architecture || 'unknown',
            maxPositionEmbeddings: catalogEntry.maxPositionEmbeddings || 4096,
            source: 'catalog'
        };

        // Pass through recommendedInstances for NFR-1 guard
        if (catalogEntry.recommendedInstances) {
            result.recommendedInstances = catalogEntry.recommendedInstances;
        }

        // Pass through architecture params if available in catalog
        if (catalogEntry.numLayers) result.numLayers = catalogEntry.numLayers;
        if (catalogEntry.numKvHeads) result.numKvHeads = catalogEntry.numKvHeads;
        if (catalogEntry.headDim) result.headDim = catalogEntry.headDim;

        return result;
    }

    // Step 2: If discover mode, derive from the HuggingFace Hub (safetensors
    // metadata + config.json). Network error / timeout → fall through.
    if (discover && isHuggingFacePattern(modelName)) {
        const discovered = await discoverFromHuggingFace(modelName, {
            timeout,
            ...(fetchImpl ? { fetchImpl } : {})
        });
        if (discovered && (hasUsableSize(discovered) || !incompleteLocal)) {
            return discovered;
        }
    }

    return incompleteLocal;
}
