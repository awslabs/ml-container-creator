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

// ── S3 draft-head validation (BL114) ─────────────────────────────────────────

/**
 * @typedef {Object} S3Accessor
 * @property {(prefix: string) => Promise<string[]>} listKeys - object keys under the prefix
 * @property {(key: string) => Promise<string>} getObject - object body as text
 */

/**
 * @typedef {Object} DraftS3ValidationResult
 * @property {boolean} valid                 - true iff has_adapter_config || has_model_config
 * @property {string}  s3_uri                - echoes the validated input
 * @property {boolean} has_adapter_config    - adapter_config.json present under the prefix
 * @property {boolean} has_model_config      - config.json present under the prefix
 * @property {string=} target_model          - best-effort, when derivable from config.json
 * @property {string=} target_arch           - best-effort, architectures[0] from config.json
 * @property {("malformed_uri"|"unreachable"|"no_config")=} error - present when valid=false
 */

const S3_URI_RE = /^s3:\/\//;
const DEFAULT_S3_TIMEOUT_MS = 10000;

/**
 * Parse an s3:// URI into { bucket, prefix }. The prefix is the key portion
 * (may be empty), normalized without a leading slash and with a single
 * trailing slash trimmed so key comparisons are stable.
 * @param {string} s3Uri
 * @returns {{ bucket: string, prefix: string } | null}
 */
function parseS3Uri(s3Uri) {
    if (typeof s3Uri !== 'string' || !S3_URI_RE.test(s3Uri)) return null;
    const withoutScheme = s3Uri.slice('s3://'.length);
    if (withoutScheme.length === 0) return null;
    const slash = withoutScheme.indexOf('/');
    const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
    if (!bucket) return null;
    let prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1);
    // Normalize trailing slash so "prefix/" and "prefix" behave identically.
    if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
    return { bucket, prefix };
}

/**
 * Default S3 accessor: shells out to the AWS CLI via child_process. Kept lazy
 * so tests that inject a mock never touch AWS or require the CLI to exist.
 * @param {number} timeoutMs
 * @returns {S3Accessor}
 */
function defaultS3Accessor(timeoutMs = DEFAULT_S3_TIMEOUT_MS) {
    return {
        async listKeys(prefix) {
            const parsed = parseS3Uri(prefix);
            if (!parsed) throw new Error('malformed_uri');
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const run = promisify(execFile);
            // `aws s3 ls s3://bucket/prefix/ --recursive` lists keys under prefix.
            const prefixSeg = parsed.prefix ? `${parsed.prefix}/` : '';
            const uri = `s3://${parsed.bucket}/${prefixSeg}`;
            const { stdout } = await run('aws', ['s3', 'ls', uri, '--recursive'], {
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024
            });
            // Each line: "2024-01-01 12:00:00     1234 prefix/adapter_config.json"
            return stdout
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => line.split(/\s+/).slice(3).join(' '))
                .filter(Boolean);
        },
        async getObject(key) {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const run = promisify(execFile);
            const { stdout } = await run('aws', ['s3', 'cp', `s3://${key}`, '-'], {
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024
            });
            return stdout;
        }
    };
}

/**
 * Validate that an S3 URI points at a usable draft head.
 *
 * Mirrors the injectable-dependency + graceful-fallback pattern in
 * servers/lib/model-id-resolver.js: an exported async function with an
 * injectable client that returns a structured result rather than throwing
 * for expected failure modes.
 *
 * @param {string} s3Uri - e.g. "s3://my-bucket/drafts/llama-eagle3/"
 * @param {object} [options]
 * @param {S3Accessor} [options.s3Client] - injectable accessor (for testing/mocking)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<DraftS3ValidationResult>}
 */
export async function getDraftFromS3(s3Uri, options = {}) {
    const parsed = parseS3Uri(s3Uri);
    if (!parsed) {
        return {
            valid: false,
            s3_uri: typeof s3Uri === 'string' ? s3Uri : '',
            has_adapter_config: false,
            has_model_config: false,
            error: 'malformed_uri'
        };
    }

    const timeoutMs = options.timeoutMs || DEFAULT_S3_TIMEOUT_MS;
    const s3Client = options.s3Client || defaultS3Accessor(timeoutMs);

    let keys;
    try {
        keys = await s3Client.listKeys(s3Uri);
    } catch (err) {
        // Unreachable path / missing credentials / CLI error — graceful fallback.
        return {
            valid: false,
            s3_uri: s3Uri,
            has_adapter_config: false,
            has_model_config: false,
            error: 'unreachable'
        };
    }

    // Detect config files by basename anywhere under the prefix.
    const basenames = (keys || []).map(k => k.split('/').pop());
    const has_adapter_config = basenames.includes('adapter_config.json');
    const has_model_config = basenames.includes('config.json');
    const valid = has_adapter_config || has_model_config;

    if (!valid) {
        return {
            valid: false,
            s3_uri: s3Uri,
            has_adapter_config: false,
            has_model_config: false,
            error: 'no_config'
        };
    }

    /** @type {DraftS3ValidationResult} */
    const result = {
        valid: true,
        s3_uri: s3Uri,
        has_adapter_config,
        has_model_config
    };

    // Best-effort: derive target_arch / target_model from config.json when present.
    if (has_model_config) {
        // Find the full key for config.json to fetch it.
        const configKey = (keys || []).find(k => k.split('/').pop() === 'config.json');
        if (configKey) {
            try {
                const body = await s3Client.getObject(`${parsed.bucket}/${configKey}`);
                const config = JSON.parse(body);
                if (Array.isArray(config.architectures) && config.architectures.length > 0) {
                    result.target_arch = config.architectures[0];
                }
                const baseModel = config._name_or_path || config.base_model || config.model_type;
                if (typeof baseModel === 'string' && baseModel) {
                    result.target_model = baseModel;
                }
            } catch (err) {
                // Best-effort only — a fetch/parse failure does not invalidate the head.
            }
        }
    }

    return result;
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

server.tool(
    'get_draft_from_s3',
    'Validate that an s3:// URI points at a usable speculative-decoding draft head ' +
    '(checks for adapter_config.json or a model config), and return structured metadata.',
    {
        s3_uri: z.string().regex(/^s3:\/\//, 'must be an s3:// URI')
            .describe('S3 URI to a draft head, e.g. "s3://my-bucket/drafts/llama-eagle3/"')
    },
    async ({ s3_uri }) => {
        const result = await getDraftFromS3(s3_uri);
        log(`get_draft_from_s3 "${s3_uri}" → valid=${result.valid}${result.error ? ` (${result.error})` : ''}`);
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: result.valid === false
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
