// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model ID → Architecture Resolution Module.
 *
 * Resolves a HuggingFace model ID (e.g., "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B")
 * to its model architecture class (e.g., "Qwen2ForCausalLM") by fetching the model's
 * config.json from the HuggingFace Hub.
 *
 * Features:
 *   - In-memory cache to avoid repeated network calls
 *   - Graceful fallback: returns null on failure (no filtering applied)
 *   - Configurable timeout for network requests
 *
 * Exports:
 *   - resolveModelArchitecture(modelId, options) → Promise<string|null>
 *   - clearModelArchitectureCache() → void (for testing)
 */

// ── In-memory cache ──────────────────────────────────────────────────────────

const architectureCache = new Map();

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10000;
const HF_BASE_URL = 'https://huggingface.co';

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve a HuggingFace model ID to its primary architecture class.
 *
 * Fetches `https://huggingface.co/{modelId}/resolve/main/config.json` and
 * extracts `architectures[0]`.
 *
 * @param {string|null|undefined} modelId - HuggingFace model identifier (e.g., "meta-llama/Llama-3.1-8B")
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Network timeout in milliseconds (default: 10000)
 * @param {typeof globalThis.fetch} [options.fetchFn] - Custom fetch function (for testing)
 * @returns {Promise<string|null>} Architecture class name or null if unavailable
 */
export async function resolveModelArchitecture(modelId, options = {}) {
    // If modelId is not provided, skip resolution
    if (!modelId || typeof modelId !== 'string' || !modelId.trim()) {
        return null;
    }

    const trimmedId = modelId.trim();

    // Check cache first
    if (architectureCache.has(trimmedId)) {
        return architectureCache.get(trimmedId);
    }

    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const fetchFn = options.fetchFn || globalThis.fetch;

    try {
        const url = `${HF_BASE_URL}/${trimmedId}/resolve/main/config.json`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
            response = await fetchFn(url, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            // Model not found, private, or other HTTP error — cache null to avoid retries
            architectureCache.set(trimmedId, null);
            return null;
        }

        const config = await response.json();

        // Extract architectures[0]
        const architecture = Array.isArray(config.architectures) && config.architectures.length > 0
            ? config.architectures[0]
            : null;

        // Cache the result (including null for models without architectures field)
        architectureCache.set(trimmedId, architecture);
        return architecture;
    } catch (err) {
        // Network error, timeout, JSON parse error, etc. — cache null for this modelId
        architectureCache.set(trimmedId, null);
        return null;
    }
}

/**
 * Clear the in-memory architecture cache.
 * Useful for testing or when cache invalidation is needed.
 */
export function clearModelArchitectureCache() {
    architectureCache.clear();
}

/**
 * Get the current cache size (for diagnostics/testing).
 * @returns {number}
 */
export function getModelArchitectureCacheSize() {
    return architectureCache.size;
}
