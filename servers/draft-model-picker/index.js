#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Draft Model Picker MCP Server
 *
 * A bundled MCP server that provides a catalog of known speculative-decoding
 * draft models compatible with MLCC's HyperPod EKS deployment target.
 *
 * Tools:
 *   - list_draft_models:  List known draft models with optional filters
 *   - get_draft_model:    Get full metadata for a specific draft model HF ID
 *   - recommend_draft:    Recommend the best draft model given a target model ID
 *
 * The catalog is loaded from ../../servers/lib/catalogs/draft-models.json.
 * Add new entries there to extend the list.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// ── Catalog loader ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadCatalog(relativePath) {
    const fullPath = resolve(__dirname, relativePath);
    let raw;
    try {
        raw = readFileSync(fullPath, 'utf8');
    } catch (err) {
        throw new Error(`Catalog file not found: ${fullPath}`);
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`Failed to parse catalog ${fullPath}: ${err.message}`);
    }
}

// ── Load draft model catalog ─────────────────────────────────────────────────

let CATALOG;
try {
    CATALOG = loadCatalog('../lib/catalogs/draft-models.json');
} catch (err) {
    process.stderr.write(`[draft-model-picker] Fatal: ${err.message}\n`);
    process.exit(1);
}

const HF_IDS = Object.keys(CATALOG);

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * List draft models with optional filters.
 */
export function listDraftModels({ targetModel = '', algorithm = '' } = {}) {
    const entries = Object.entries(CATALOG)
        .filter(([, meta]) =>
            (!targetModel || meta.target_model.toLowerCase().includes(targetModel.toLowerCase())) &&
            (!algorithm   || meta.algorithm.toLowerCase() === algorithm.toLowerCase())
        )
        .map(([hf_id, meta]) => ({ hf_id, ...meta }));
    return { count: entries.length, models: entries };
}

/**
 * Get full metadata for a specific draft model HF ID.
 */
export function getDraftModel(hfId) {
    const meta = CATALOG[hfId];
    if (!meta) return null;
    return { hf_id: hfId, ...meta };
}

/**
 * Recommend the best draft model for a given target model ID.
 * Prefers eagle3 > eagle2 > eagle > draft-model for ranking.
 */
export function recommendDraft(targetModel) {
    const ALG_RANK = { eagle3: 0, eagle2: 1, eagle: 2, 'draft-model': 3, mtp: 4, ngram: 5 };
    const matches = Object.entries(CATALOG)
        .filter(([, meta]) => meta.target_model.toLowerCase().includes(targetModel.toLowerCase()))
        .sort(([, a], [, b]) => (ALG_RANK[a.algorithm] ?? 99) - (ALG_RANK[b.algorithm] ?? 99));

    if (matches.length === 0) return null;
    const [hf_id, meta] = matches[0];
    return {
        hf_id,
        ...meta,
        all_options: matches.map(([id, m]) => ({ hf_id: id, algorithm: m.algorithm }))
    };
}

function log(message) {
    process.stderr.write(`[draft-model-picker] ${message}\n`);
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'draft-model-picker',
    version: '1.0.0'
});

server.tool(
    'list_draft_models',
    'List known speculative-decoding draft models from the MLCC catalog. ' +
    'Optionally filter by target model (partial match) or algorithm.',
    {
        target_model: z.string().optional().describe(
            'Partial HF model ID to filter by target (e.g. "Llama-3.1-8B")'
        ),
        algorithm: z.string().optional().describe(
            'Algorithm filter: eagle3, eagle2, eagle, draft-model, ngram, mtp'
        )
    },
    async ({ target_model = '', algorithm = '' }) => {
        const result = listDraftModels({ targetModel: target_model, algorithm });
        log(`list_draft_models target="${target_model}" alg="${algorithm}" → ${result.count}`);
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
);

server.tool(
    'get_draft_model',
    'Get full metadata for a specific draft model by its HuggingFace model ID.',
    {
        hf_id: z.string().describe('HuggingFace model ID (e.g. "thoughtworks/Llama-3.1-8B-Instruct-Eagle3")')
    },
    async ({ hf_id }) => {
        const model = getDraftModel(hf_id);
        if (!model) {
            return {
                content: [{ type: 'text', text: JSON.stringify({
                    error: `Unknown draft model: ${hf_id}`,
                    available: HF_IDS
                }) }],
                isError: true
            };
        }
        log(`get_draft_model → ${hf_id}`);
        return {
            content: [{ type: 'text', text: JSON.stringify(model, null, 2) }]
        };
    }
);

server.tool(
    'recommend_draft',
    'Recommend the best draft model for a given target model ID. ' +
    'Returns the top recommendation plus all alternatives, ranked by algorithm quality (eagle3 first).',
    {
        target_model: z.string().describe(
            'Target model HF ID or partial name (e.g. "meta-llama/Llama-3.1-8B-Instruct" or "Llama-3.1-8B")'
        )
    },
    async ({ target_model }) => {
        const result = recommendDraft(target_model);
        if (!result) {
            return {
                content: [{ type: 'text', text: JSON.stringify({
                    error: `No draft models found for target: ${target_model}`,
                    hint: 'Use list_draft_models to see all available models'
                }) }],
                isError: true
            };
        }
        log(`recommend_draft "${target_model}" → ${result.hf_id}`);
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

main().catch(err => {
    process.stderr.write(`[draft-model-picker] Fatal: ${err.message}\n`);
    process.exit(1);
});
