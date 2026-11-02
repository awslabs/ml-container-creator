// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard (derive-dont-hardcode rule 4): HF config.json -> model size
 * extraction exists twice —
 *   - servers/instance-sizer/lib/model-resolver.js  extractFromHuggingFaceConfig (sizer, live)
 *   - templates/do/lib/python/catalog_registration.py _extract_from_hf_config (do/stage cache writer)
 * The Python copy writes the .mlcc/model-sizes.json cache that the JS copy
 * reads back, so they must derive the SAME parameter count, dtype, context
 * length and KV dimensions. This test feeds both the same inputs (including
 * the published Qwen3.5-4B multimodal config) and asserts agreement.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    extractFromHuggingFaceConfig,
    NESTED_TEXT_CONFIG_KEYS,
    SAFETENSORS_DTYPE_MAP
} from '../../servers/instance-sizer/lib/model-resolver.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY_DIR = join(ROOT, 'templates', 'do', 'lib', 'python');
const FIXTURES = join(ROOT, 'servers', 'instance-sizer', 'test', 'fixtures', 'hf');
const QWEN35_CONFIG = JSON.parse(readFileSync(join(FIXTURES, 'Qwen__Qwen3.5-4B.config.json'), 'utf8'));
const QWEN35_HUB = JSON.parse(readFileSync(join(FIXTURES, 'Qwen__Qwen3.5-4B.hub.json'), 'utf8'));

const CASES = {
    'multimodal + hub metadata (Qwen3.5-4B)': [QWEN35_CONFIG, QWEN35_HUB],
    'multimodal, config only (Qwen3.5-4B)': [QWEN35_CONFIG, null],
    'gated: hub only': [{}, { safetensors: { parameters: { BF16: 10, F32: 1 }, total: 11 } }],
    'dense estimate, untied': [{ hidden_size: 4096, num_hidden_layers: 32, vocab_size: 128256, torch_dtype: 'bfloat16', max_position_embeddings: 131072, num_attention_heads: 32, num_key_value_heads: 8 }, null],
    'num_parameters': [{ num_parameters: 7000000000, architectures: ['LlamaForCausalLM'] }, null],
    'moe (no estimate)': [{ hidden_size: 4096, num_hidden_layers: 32, num_local_experts: 8 }, null],
    'empty': [{}, null]
};

function pyExtract(cases) {
    const script = [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(PY_DIR)})`,
        'import catalog_registration as cr',
        'cases = json.load(sys.stdin)',
        'out = {k: cr._extract_from_hf_config(c, h) for k, (c, h) in cases.items()}',
        'out["__keys__"] = list(cr.NESTED_TEXT_CONFIG_KEYS)',
        'out["__dtypes__"] = cr._SAFETENSORS_DTYPE_MAP',
        'print(json.dumps(out))'
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify(cases), encoding: 'utf8' }));
}

describe('HF size extraction: model-resolver.js <-> catalog_registration.py conformance', () => {
    const py = pyExtract(CASES);

    it('nested text-config keys and safetensors dtype maps agree', () => {
        assert.deepStrictEqual(py.__keys__, NESTED_TEXT_CONFIG_KEYS);
        assert.deepStrictEqual(py.__dtypes__, SAFETENSORS_DTYPE_MAP);
    });

    for (const [name, [config, hub]] of Object.entries(CASES)) {
        it(`derives the same sizing fields: ${name}`, () => {
            const js = extractFromHuggingFaceConfig(config, hub);
            const p = py[name];
            assert.strictEqual(p.parameterCount ?? null, js.parameterCount, 'parameterCount');
            assert.strictEqual(p.parameterCountSource ?? null, js.parameterCountSource, 'parameterCountSource');
            assert.strictEqual(p.defaultDtype, js.dtype, 'dtype');
            assert.strictEqual(p.maxPositionEmbeddings ?? null, js.maxPositionEmbeddings, 'maxPositionEmbeddings');
            assert.strictEqual(p.numLayers ?? undefined, js.numLayers, 'numLayers');
            assert.strictEqual(p.numKvHeads ?? undefined, js.numKvHeads, 'numKvHeads');
            assert.strictEqual(p.headDim ?? undefined, js.headDim, 'headDim');
            assert.strictEqual(p.architecture, js.architecture, 'architecture');
        });
    }
});
