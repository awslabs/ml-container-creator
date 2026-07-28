// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture Sync
 *
 * Fetches model registry source files from server GitHub repositories
 * and extracts supported model_type values into the model-servers catalog.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Parse vLLM's model registry Python source to extract model_type keys.
 *
 * vLLM's registry maps architecture class names to (module, impl_class) tuples:
 *   "LlamaForCausalLM": ("llama", "LlamaForCausalLM"),
 *   "Qwen2ForCausalLM": ("qwen2", "Qwen2ForCausalLM"),
 *
 * The module name (first tuple element) corresponds to the model_type.
 * Also matches older formats where model_type is used directly as dict key.
 *
 * @param {string} source - Python source code content
 * @returns {string[]} Sorted array of model_type strings
 */
export const parseVllmRegistry = (source) => {
    const modelTypes = new Set();
    const patterns = [
        // Tuple value format: ("module_name", "ClassName") — extract module_name
        /\("([a-z][a-z0-9_]*)"\s*,\s*"[A-Z]/g,
        // Direct lowercase key format (older registries): "model_type": (
        /"([a-z][a-z0-9_]*)":\s*\(/g,
        // Direct lowercase key format: "model_type": ClassName
        /"([a-z][a-z0-9_]*)":\s*[A-Z]/g,
        // Direct lowercase key format: "model_type": [
        /"([a-z][a-z0-9_]*)":\s*\[/g
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) {
            modelTypes.add(match[1]);
        }
    }
    return [...modelTypes].sort();
};

/**
 * Parse SGLang's model_registry.py to extract model_type keys.
 *
 * Matches patterns like:
 *   "llama": ModelClass,
 *   "qwen2": (ModulePath, ClassName),
 *
 * @param {string} source - Python source code content
 * @returns {string[]} Sorted array of model_type strings
 */
export const parseSglangRegistry = (source) => {
    const modelTypes = new Set();
    const patterns = [
        /"([a-z][a-z0-9_]*)":\s*\(/g,
        /"([a-z][a-z0-9_]*)":\s*[A-Z]/g,
        /"([a-z][a-z0-9_]*)":\s*\[/g
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) {
            modelTypes.add(match[1]);
        }
    }
    return [...modelTypes].sort();
};

/**
 * Parse TensorRT-LLM's models __init__.py to extract model_type keys.
 *
 * Matches patterns from MODEL_MAP or similar dict structures:
 *   "llama": LlamaForCausalLM,
 *   "gpt2": GPT2LMHeadModel,
 *
 * @param {string} source - Python source code content
 * @returns {string[]} Sorted array of model_type strings
 */
export const parseTensorRTRegistry = (source) => {
    const modelTypes = new Set();
    const patterns = [
        /"([a-z][a-z0-9_]*)":\s*[A-Z]/g,
        /"([a-z][a-z0-9_]*)":\s*\(/g,
        /'([a-z][a-z0-9_]*)':\s*[A-Z]/g,
        /'([a-z][a-z0-9_]*)':\s*\(/g
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) {
            modelTypes.add(match[1]);
        }
    }
    return [...modelTypes].sort();
};

/**
 * Configuration mapping each server to its GitHub repository,
 * registry file path, tag prefix, and parser function.
 */
export const SERVER_REGISTRY_SOURCES = {
    vllm: {
        repo: 'vllm-project/vllm',
        file: 'vllm/model_executor/models/registry.py',
        tagPrefix: 'v',
        parser: parseVllmRegistry
    },
    sglang: {
        repo: 'sgl-project/sglang',
        // SGLang removed model_registry.py in v0.5.x — architectures are now registered via
        // @ModelRegistry.register decorators in individual model files. The central registry
        // file no longer exists. SGLang architecture support is maintained manually in
        // servers/lib/catalogs/model-arch-support.json instead.
        file: null,
        tagPrefix: 'v',
        parser: parseSglangRegistry
    },
    'tensorrt-llm': {
        repo: 'NVIDIA/TensorRT-LLM',
        file: 'tensorrt_llm/models/__init__.py',
        tagPrefix: 'v',
        parser: parseTensorRTRegistry
    }
};

/**
 * Sync supported model architectures from server GitHub repositories
 * into the model-servers catalog.
 *
 * For each server entry in the catalog that has a matching source config,
 * fetches the model registry file from GitHub at the version tag and
 * parses it to extract supported model_type values.
 *
 * @param {string} catalogPath - Path to model-servers.json
 * @returns {object} Summary with counts and failures
 */
export const syncArchitectures = async (catalogPath) => {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const summary = { servers: [], failures: [] };

    for (const [server, entries] of Object.entries(catalog)) {
        const source = SERVER_REGISTRY_SOURCES[server];
        if (!source) continue;

        for (const entry of entries) {
            const version = entry.labels?.framework_version;
            if (!version) continue;

            const tag = `${source.tagPrefix}${version}`;

            // Skip servers where the registry file no longer exists upstream (e.g. sglang)
            if (source.file === null) {
                console.log(`   ⏭  ${server} ${version}: skipped (no upstream registry file — maintained manually)`);
                continue;
            }

            const candidates = source.fileCandidates
                ? source.fileCandidates.map(f => `https://raw.githubusercontent.com/${source.repo}/${tag}/${f}`)
                : [`https://raw.githubusercontent.com/${source.repo}/${tag}/${source.file}`];

            try {
                let response;
                for (const url of candidates) {
                    response = await fetch(url);
                    if (response.ok) { break; }
                }
                if (!response?.ok) {
                    const tried = candidates.map(u => u.split('/').slice(-1)[0]).join(', ');
                    summary.failures.push({ server, version, reason: `HTTP ${response?.status ?? 'no response'} (tried: ${tried})` });
                    console.log(`   ⚠️  ${server} ${version}: all paths 404 (tried: ${tried})`);
                    continue;
                }
                const content = await response.text();
                entry.supportedModelTypes = source.parser(content);
                summary.servers.push({ server, version, count: entry.supportedModelTypes.length });
                console.log(`   ✓ ${server} ${version}: ${entry.supportedModelTypes.length} architectures`);
            } catch (err) {
                summary.failures.push({ server, version, reason: err.message });
                console.log(`   ⚠️  ${server} ${version}: fetch failed (${err.message})`);
            }
        }
    }

    writeFileSync(catalogPath, JSON.stringify(catalog, null, 4));
    return summary;
};
