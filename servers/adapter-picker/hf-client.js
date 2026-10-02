// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HuggingFace Hub client for the adapter-picker MCP server.
 *
 * Provides two failure-tolerant, live-HF requests behind an injectable
 * `fetchFn` (defaulting to globalThis.fetch), mirroring the precedent set by
 * servers/lib/model-id-resolver.js:
 *
 *   - searchModels(baseModel, task, options) → Promise<Array>  (candidate repos)
 *   - fetchAdapterConfig(hfId, options)      → Promise<object|null>  (adapter_config.json)
 *
 * Every call is tolerant of network errors, timeouts, non-OK HTTP status, and
 * JSON parse failures: searchModels returns [] and fetchAdapterConfig returns
 * null rather than throwing. This keeps the discovery tools graceful.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const HF_BASE_URL = 'https://huggingface.co';

/**
 * Perform a single fetch with an AbortController timeout.
 * Returns the parsed JSON on success, or null on any failure.
 *
 * @param {string} url
 * @param {object} options
 * @param {number} [options.timeoutMs]
 * @param {typeof globalThis.fetch} [options.fetchFn]
 * @returns {Promise<any|null>}
 */
async function fetchJson(url, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const fetchFn = options.fetchFn || globalThis.fetch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        let response;
        try {
            response = await fetchFn(url, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!response || !response.ok) {
            return null;
        }
        return await response.json();
    } catch (_err) {
        // Network error, timeout/abort, JSON parse error, etc.
        return null;
    }
}

/**
 * Search the HF Hub for PEFT/LoRA adapter repos.
 *
 * GET https://huggingface.co/api/models?filter=peft&filter=lora&search=<base_model>&full=true&limit=50
 *
 * The HF API is queried with the PEFT/LoRA filters plus a `search` narrowing on
 * the base model (and, when provided, the task). The search endpoint alone does
 * not confirm exact base-model compatibility — that is done by the caller via
 * fetchAdapterConfig + exact `base_model_name_or_path` match. This function only
 * returns the candidate list.
 *
 * @param {string} baseModel - Base model HF ID the adapters should target.
 * @param {string} [task] - Optional task narrowing term.
 * @param {object} [options] - { timeoutMs, fetchFn }
 * @returns {Promise<Array>} Candidate repo objects (may be empty). Never throws.
 */
export async function searchModels(baseModel, task, options = {}) {
    if (!baseModel || typeof baseModel !== 'string' || !baseModel.trim()) {
        return [];
    }

    const params = new URLSearchParams();
    // Filter to PEFT/LoRA adapters on the Hub.
    params.append('filter', 'peft');
    params.append('filter', 'lora');
    // Narrow by base model (and task, if provided).
    const searchTerm = task ? `${baseModel.trim()} ${task}` : baseModel.trim();
    params.set('search', searchTerm);
    params.set('full', 'true');
    params.set('limit', '50');

    const url = `${HF_BASE_URL}/api/models?${params.toString()}`;
    const result = await fetchJson(url, options);

    if (!Array.isArray(result)) {
        return [];
    }
    return result;
}

/**
 * Fetch a single adapter's adapter_config.json.
 *
 * GET https://huggingface.co/<hf_id>/resolve/main/adapter_config.json
 *
 * @param {string} hfId - HuggingFace adapter repo ID.
 * @param {object} [options] - { timeoutMs, fetchFn }
 * @returns {Promise<object|null>} Parsed adapter_config.json, or null when the
 *   repo has no adapter_config.json (404) or on any failure. Never throws.
 */
export async function fetchAdapterConfig(hfId, options = {}) {
    if (!hfId || typeof hfId !== 'string' || !hfId.trim()) {
        return null;
    }
    const url = `${HF_BASE_URL}/${hfId.trim()}/resolve/main/adapter_config.json`;
    const config = await fetchJson(url, options);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return null;
    }
    return config;
}
