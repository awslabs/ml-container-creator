#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter Picker MCP Server
 *
 * A bundled, discovery-only MCP server that finds PEFT/LoRA adapters on the
 * HuggingFace Hub compatible with a given base model. It mirrors the tool shape
 * of the draft-model-picker's `recommend_draft` (search / get / recommend), but
 * its data source is the live HF Hub rather than a static catalog.
 *
 * Tools:
 *   - search_hf_adapters(base_model, task):  Search HF Hub for PEFT/LoRA adapters
 *                                            whose adapter_config.json declares an
 *                                            exact-match base_model_name_or_path.
 *   - get_adapter_metadata(hf_id):           Full metadata + classification from
 *                                            adapter_config.json.
 *   - recommend_adapter(base_model, task):   Top-ranked compatible adapter.
 *
 * This server does NOT load adapters. The existing S3-based adapter loading in
 * templates/do/adapter and templates/do/lib/python/lora_vllm.py is a separate
 * concern and is untouched by this server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchModels, fetchAdapterConfig } from './hf-client.js';

// ── Pure logic (exported for tests) ──────────────────────────────────────────

/**
 * Normalize a model-id string for exact comparison: trimmed, lower-cased.
 * @param {*} value
 * @returns {string|null}
 */
function normalizeId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Detect a quantization hint (QLoRA marker) in an adapter_config.
 * @param {object} config
 * @returns {boolean}
 */
function hasQuantizationHint(config) {
    if (!config || typeof config !== 'object') return false;
    if (config.quantization !== null && config.quantization !== undefined) return true;
    if (config.quant_method !== null && config.quant_method !== undefined) return true;
    if (config.load_in_4bit === true || config.load_in_8bit === true) return true;
    // Any bnb_* marker (bitsandbytes quantization hints).
    for (const key of Object.keys(config)) {
        if (key.startsWith('bnb_') && config[key] !== null && config[key] !== undefined && config[key] !== false) {
            return true;
        }
    }
    return false;
}

/**
 * Faithfully classify an adapter from its parsed adapter_config.
 *
 * Recognized cases (precedence DoRA → QLoRA → LoRA):
 *   1. DoRA   — config.use_dora === true
 *   2. QLoRA  — else a quantization hint is present
 *   3. LoRA   — else adapter_type/peft_type indicates lora
 * Otherwise:
 *   4. Passthrough — a declared non-LoRA adapter_type/peft_type is reported as-is
 *   5. "unknown"   — no type information at all
 *
 * The result is the faithfully-reported detected type; it is NOT restricted to
 * {LoRA, DoRA, QLoRA}.
 *
 * @param {object} config - Parsed adapter_config.json.
 * @returns {string} classification.
 */
export function classifyAdapter(config) {
    if (!config || typeof config !== 'object') return 'unknown';

    const rawType = typeof config.adapter_type === 'string' ? config.adapter_type.trim() : '';
    const rawPeft = typeof config.peft_type === 'string' ? config.peft_type.trim() : '';
    const declared = rawType || rawPeft;
    const lowerDeclared = declared.toLowerCase();

    // 1. DoRA — an explicit LoRA variant flag.
    if (config.use_dora === true) return 'DoRA';

    // 2. QLoRA — LoRA over a quantized base.
    if (hasQuantizationHint(config)) return 'QLoRA';

    // 3. LoRA — the declared type indicates lora.
    if (lowerDeclared === 'lora') return 'LoRA';

    // 4. Passthrough — some other declared type, reported faithfully as-is.
    if (declared) return declared;

    // 5. No type information at all.
    return 'unknown';
}

/**
 * Determine whether an adapter_config is compatible with the requested base
 * model via an EXACT (case-insensitive, trimmed) match of the explicit
 * base_model_name_or_path metadata field. No inference or heuristics.
 *
 * A config lacking an explicit base_model_name_or_path is never compatible.
 *
 * @param {object} config - Parsed adapter_config.json.
 * @param {string} baseModel - Requested base model HF ID.
 * @returns {boolean}
 */
export function isCompatible(config, baseModel) {
    if (!config || typeof config !== 'object') return false;
    const declared = normalizeId(config.base_model_name_or_path);
    const requested = normalizeId(baseModel);
    if (declared === null || requested === null) return false;
    return declared === requested;
}

/**
 * Rank compatible adapters. Ordering:
 *   1. Exact task match first (when a task is requested and the adapter's task matches).
 *   2. Higher popularity (downloads, then likes).
 *   3. Stable tie-break on hf_id for determinism.
 *
 * Each entry is annotated with a numeric `score` for transparency.
 *
 * @param {Array} adapters - Compatible adapter entries.
 * @param {string} [task] - Optional requested task.
 * @returns {Array} A new, ranked array (highest first).
 */
export function rankAdapters(adapters, task) {
    if (!Array.isArray(adapters)) return [];
    const requestedTask = normalizeId(task);

    const scored = adapters.map((a) => {
        const downloads = Number.isFinite(a.downloads) ? a.downloads : 0;
        const likes = Number.isFinite(a.likes) ? a.likes : 0;
        const adapterTask = normalizeId(a.task);
        const taskMatch = requestedTask && adapterTask === requestedTask;
        // Task match dominates; then downloads; then likes.
        const score = (taskMatch ? 1_000_000 : 0) + downloads + likes;
        return { entry: a, score };
    });

    scored.sort((x, y) => {
        if (y.score !== x.score) return y.score - x.score;
        // Stable, deterministic tie-break.
        return String(x.entry.hf_id).localeCompare(String(y.entry.hf_id));
    });

    return scored.map(({ entry, score }) => ({ ...entry, score }));
}

/**
 * Build a search-result entry from a candidate repo + its adapter_config.
 * @param {object} repo - Candidate repo object from the HF search API.
 * @param {object} config - Parsed adapter_config.json.
 * @returns {object}
 */
function toEntry(repo, config) {
    return {
        hf_id: repo.id || repo.modelId || repo.hf_id,
        adapter_type: typeof config.adapter_type === 'string' ? config.adapter_type : (config.peft_type ?? null),
        base_model_name_or_path: config.base_model_name_or_path ?? null,
        classification: classifyAdapter(config),
        task: repo.task ?? repo.pipeline_tag ?? null,
        downloads: Number.isFinite(repo.downloads) ? repo.downloads : 0,
        likes: Number.isFinite(repo.likes) ? repo.likes : 0
    };
}

/**
 * Search the HF Hub for adapters compatible with `baseModel`.
 *
 * Returns only adapters whose explicit base_model_name_or_path is an exact
 * (case-insensitive, trimmed) match for the requested base model, and whose
 * classification is not "unknown". Empty results are a normal (non-error)
 * outcome.
 *
 * @param {string} baseModel
 * @param {string} [task]
 * @param {object} [options] - { timeoutMs, fetchFn }
 * @returns {Promise<{base_model: string, task: string|null, count: number, adapters: Array}>}
 */
export async function searchHfAdapters(baseModel, task, options = {}) {
    const candidates = await searchModels(baseModel, task, options);

    const entries = [];
    for (const repo of candidates) {
        const hfId = repo && (repo.id || repo.modelId || repo.hf_id);
        if (!hfId) continue;
        const config = await fetchAdapterConfig(hfId, options);
        if (!config) continue;
        if (!isCompatible(config, baseModel)) continue;
        if (classifyAdapter(config) === 'unknown') continue;
        entries.push(toEntry(repo, config));
    }

    return {
        base_model: baseModel,
        task: task ?? null,
        count: entries.length,
        adapters: entries
    };
}

/**
 * Fetch and classify full metadata for a specific adapter repo.
 *
 * @param {string} hfId
 * @param {object} [options] - { timeoutMs, fetchFn }
 * @returns {Promise<object|null>} Metadata object, or null when no
 *   adapter_config.json is available.
 */
export async function getAdapterMetadata(hfId, options = {}) {
    const config = await fetchAdapterConfig(hfId, options);
    if (!config) return null;
    return {
        hf_id: hfId,
        adapter_type: typeof config.adapter_type === 'string' ? config.adapter_type : (config.peft_type ?? null),
        base_model_name_or_path: config.base_model_name_or_path ?? null,
        peft_type: config.peft_type ?? null,
        classification: classifyAdapter(config),
        r: config.r ?? null,
        lora_alpha: config.lora_alpha ?? null,
        quantization: hasQuantizationHint(config) ? (config.quantization ?? config.quant_method ?? true) : null
    };
}

/**
 * Recommend the single top-ranked compatible adapter for a base model + task.
 *
 * @param {string} baseModel
 * @param {string} [task]
 * @param {object} [options] - { timeoutMs, fetchFn }
 * @returns {Promise<object|null>} Top recommendation with all_options, or null
 *   when no compatible adapters are found.
 */
export async function recommendAdapter(baseModel, task, options = {}) {
    const { adapters } = await searchHfAdapters(baseModel, task, options);
    if (adapters.length === 0) return null;

    const ranked = rankAdapters(adapters, task);
    const top = ranked[0];
    return {
        hf_id: top.hf_id,
        adapter_type: top.adapter_type,
        base_model_name_or_path: top.base_model_name_or_path,
        classification: top.classification,
        task: top.task,
        score: top.score,
        all_options: ranked.map((a) => ({
            hf_id: a.hf_id,
            classification: a.classification,
            score: a.score
        }))
    };
}

function log(message) {
    process.stderr.write(`[adapter-picker] ${message}\n`);
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'adapter-picker',
    version: '1.0.0'
});

server.tool(
    'search_hf_adapters',
    'Search the HuggingFace Hub for PEFT/LoRA adapters compatible with a base model. ' +
    'Compatibility is an exact match of the adapter\'s declared base_model_name_or_path ' +
    '(no inference or heuristics). Optionally narrow by task. Returns count:0 when none match.',
    {
        base_model: z.string().describe(
            'Base model HF ID the adapter must be compatible with (e.g. "meta-llama/Llama-3.1-8B-Instruct")'
        ),
        task: z.string().optional().describe(
            'Optional task filter: chat, code, summarization, etc.'
        )
    },
    async ({ base_model, task }) => {
        const result = await searchHfAdapters(base_model, task);
        log(`search_hf_adapters base="${base_model}" task="${task ?? ''}" → ${result.count}`);
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
);

server.tool(
    'get_adapter_metadata',
    'Get full metadata for a specific HuggingFace adapter, including adapter_type, ' +
    'base_model_name_or_path, and a faithfully-reported classification (LoRA/DoRA/QLoRA ' +
    'for recognized cases, else the detected type as-is).',
    {
        hf_id: z.string().describe('HuggingFace adapter repo ID (e.g. "org/llama31-8b-chat-lora")')
    },
    async ({ hf_id }) => {
        const metadata = await getAdapterMetadata(hf_id);
        if (!metadata) {
            return {
                content: [{ type: 'text', text: JSON.stringify({
                    error: `No adapter_config.json for ${hf_id}`,
                    hint: 'The repo may not be a PEFT adapter, or the Hub is unreachable'
                }) }],
                isError: true
            };
        }
        log(`get_adapter_metadata → ${hf_id} (${metadata.classification})`);
        return {
            content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }]
        };
    }
);

server.tool(
    'recommend_adapter',
    'Recommend the top PEFT/LoRA adapter for a base model and task. Returns the top ' +
    'pick plus all ranked alternatives (all_options). Errors when no compatible adapter is found.',
    {
        base_model: z.string().describe('Base model HF ID (e.g. "meta-llama/Llama-3.1-8B-Instruct")'),
        task: z.string().optional().describe('Task: chat, code, summarization, etc.')
    },
    async ({ base_model, task }) => {
        const result = await recommendAdapter(base_model, task);
        if (!result) {
            return {
                content: [{ type: 'text', text: JSON.stringify({
                    error: `No compatible adapters found for ${base_model}`,
                    hint: 'Try search_hf_adapters or a different base_model/task'
                }) }],
                isError: true
            };
        }
        log(`recommend_adapter base="${base_model}" task="${task ?? ''}" → ${result.hf_id}`);
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
);

// ── Start server ─────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    log('starting');
    await server.connect(transport);
    log('ready');
}

// Only start the server when run directly (not when imported by tests).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(err => {
        process.stderr.write(`[adapter-picker] Fatal: ${err.message}\n`);
        process.exit(1);
    });
}
