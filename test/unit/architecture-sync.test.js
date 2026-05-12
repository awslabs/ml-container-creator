// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for architecture-sync parsers.
 *
 * Tests:
 * - vLLM parser extracts model_type keys from Python registry source
 * - SGLang parser extracts model_type keys from model_registry.py
 * - TensorRT-LLM parser extracts model_type keys (double and single quotes)
 * - Edge cases: empty source, malformed source, no matches
 *
 * Validates: Requirements 1.2-1.3
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import {
    parseVllmRegistry,
    parseSglangRegistry,
    parseTensorRTRegistry
} from '../../src/lib/architecture-sync.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VLLM_REGISTRY_SOURCE = `
# vLLM Model Registry
# Maps model_type -> (module_path, class_name)

_MODELS = {
    "llama": ("vllm.model_executor.models.llama", "LlamaForCausalLM"),
    "mistral": ("vllm.model_executor.models.mistral", "MistralForCausalLM"),
    "qwen2": ("vllm.model_executor.models.qwen2", "Qwen2ForCausalLM"),
    "gemma2": ("vllm.model_executor.models.gemma2", "Gemma2ForCausalLM"),
    "phi3": ("vllm.model_executor.models.phi3", "Phi3ForCausalLM"),
}

_EMBEDDING_MODELS = {
    "bert": ("vllm.model_executor.models.bert", "BertModel"),
}

_MULTIMODAL_MODELS = {
    "llava": ("vllm.model_executor.models.llava", "LlavaForConditionalGeneration"),
    "internvl_chat": ("vllm.model_executor.models.internvl", "InternVLChatModel"),
}
`;

const VLLM_REGISTRY_CLASSNAME_PATTERN = `
# Alternative pattern: model_type -> ClassName directly
_TEXT_GENERATION_MODELS = {
    "gpt2": GPT2LMHeadModel,
    "opt": OPTForCausalLM,
    "bloom": BloomForCausalLM,
}
`;

const VLLM_REGISTRY_LIST_PATTERN = `
# Alternative pattern: model_type -> [list of classes]
_MODELS = {
    "falcon": [FalconForCausalLM, FalconModel],
    "mpt": [MPTForCausalLM],
}
`;

const SGLANG_REGISTRY_SOURCE = `
# SGLang Model Registry
# python/sglang/srt/models/model_registry.py

_MODELS = {
    "llama": ("sglang.srt.models.llama", "LlamaForCausalLM"),
    "qwen2": ("sglang.srt.models.qwen2", "Qwen2ForCausalLM"),
    "gemma": ("sglang.srt.models.gemma", "GemmaForCausalLM"),
    "deepseek_v2": ("sglang.srt.models.deepseek_v2", "DeepseekV2ForCausalLM"),
    "mixtral": ("sglang.srt.models.mixtral", "MixtralForCausalLM"),
}

_VISION_MODELS = {
    "llava_next": ("sglang.srt.models.llava_next", "LlavaNextForConditionalGeneration"),
}
`;

const SGLANG_REGISTRY_CLASSNAME_PATTERN = `
# Direct class reference pattern
_MODELS = {
    "stablelm": StableLMForCausalLM,
    "yi": YiForCausalLM,
}
`;

const TENSORRT_REGISTRY_SOURCE = `
# TensorRT-LLM Model Registry
# tensorrt_llm/models/__init__.py

MODEL_MAP = {
    "llama": LlamaForCausalLM,
    "gpt2": GPT2LMHeadModel,
    "falcon": FalconForCausalLM,
    'bloom': BloomForCausalLM,
    'baichuan': BaichuanForCausalLM,
    "chatglm": ChatGLMForCausalLM,
}

QUANTIZATION_MAP = {
    'mpt': ("tensorrt_llm.quantization", "MPTQuantized"),
    "opt": ("tensorrt_llm.quantization", "OPTQuantized"),
}
`;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Architecture Sync Parsers', () => {

    describe('parseVllmRegistry', () => {

        it('should extract model_type keys from tuple-value patterns', () => {
            const result = parseVllmRegistry(VLLM_REGISTRY_SOURCE);
            assert.ok(Array.isArray(result), 'Should return an array');
            assert.ok(result.includes('llama'), 'Should include llama');
            assert.ok(result.includes('mistral'), 'Should include mistral');
            assert.ok(result.includes('qwen2'), 'Should include qwen2');
            assert.ok(result.includes('gemma2'), 'Should include gemma2');
            assert.ok(result.includes('phi3'), 'Should include phi3');
            assert.ok(result.includes('bert'), 'Should include bert');
            assert.ok(result.includes('llava'), 'Should include llava');
            assert.ok(result.includes('internvl_chat'), 'Should include internvl_chat');
        });

        it('should extract model_type keys from ClassName patterns', () => {
            const result = parseVllmRegistry(VLLM_REGISTRY_CLASSNAME_PATTERN);
            assert.ok(result.includes('gpt2'), 'Should include gpt2');
            assert.ok(result.includes('opt'), 'Should include opt');
            assert.ok(result.includes('bloom'), 'Should include bloom');
        });

        it('should extract model_type keys from list patterns', () => {
            const result = parseVllmRegistry(VLLM_REGISTRY_LIST_PATTERN);
            assert.ok(result.includes('falcon'), 'Should include falcon');
            assert.ok(result.includes('mpt'), 'Should include mpt');
        });

        it('should return sorted results', () => {
            const result = parseVllmRegistry(VLLM_REGISTRY_SOURCE);
            const sorted = [...result].sort();
            assert.deepStrictEqual(result, sorted, 'Results should be sorted alphabetically');
        });

        it('should not include duplicate entries', () => {
            const sourceWithDuplicates = `
_MODELS = {
    "llama": ("module", "LlamaForCausalLM"),
}
_OTHER = {
    "llama": LlamaModel,
}
`;
            const result = parseVllmRegistry(sourceWithDuplicates);
            const llamaCount = result.filter(t => t === 'llama').length;
            assert.strictEqual(llamaCount, 1, 'Should deduplicate model_type entries');
        });
    });

    describe('parseSglangRegistry', () => {

        it('should extract model_type keys from tuple-value patterns', () => {
            const result = parseSglangRegistry(SGLANG_REGISTRY_SOURCE);
            assert.ok(Array.isArray(result), 'Should return an array');
            assert.ok(result.includes('llama'), 'Should include llama');
            assert.ok(result.includes('qwen2'), 'Should include qwen2');
            assert.ok(result.includes('gemma'), 'Should include gemma');
            assert.ok(result.includes('deepseek_v2'), 'Should include deepseek_v2');
            assert.ok(result.includes('mixtral'), 'Should include mixtral');
            assert.ok(result.includes('llava_next'), 'Should include llava_next');
        });

        it('should extract model_type keys from ClassName patterns', () => {
            const result = parseSglangRegistry(SGLANG_REGISTRY_CLASSNAME_PATTERN);
            assert.ok(result.includes('stablelm'), 'Should include stablelm');
            assert.ok(result.includes('yi'), 'Should include yi');
        });

        it('should return sorted results', () => {
            const result = parseSglangRegistry(SGLANG_REGISTRY_SOURCE);
            const sorted = [...result].sort();
            assert.deepStrictEqual(result, sorted, 'Results should be sorted alphabetically');
        });
    });

    describe('parseTensorRTRegistry', () => {

        it('should extract model_type keys from double-quoted entries', () => {
            const result = parseTensorRTRegistry(TENSORRT_REGISTRY_SOURCE);
            assert.ok(Array.isArray(result), 'Should return an array');
            assert.ok(result.includes('llama'), 'Should include llama (double-quoted)');
            assert.ok(result.includes('gpt2'), 'Should include gpt2 (double-quoted)');
            assert.ok(result.includes('falcon'), 'Should include falcon (double-quoted)');
            assert.ok(result.includes('chatglm'), 'Should include chatglm (double-quoted)');
            assert.ok(result.includes('opt'), 'Should include opt (double-quoted)');
        });

        it('should extract model_type keys from single-quoted entries', () => {
            const result = parseTensorRTRegistry(TENSORRT_REGISTRY_SOURCE);
            assert.ok(result.includes('bloom'), 'Should include bloom (single-quoted)');
            assert.ok(result.includes('baichuan'), 'Should include baichuan (single-quoted)');
            assert.ok(result.includes('mpt'), 'Should include mpt (single-quoted)');
        });

        it('should handle mixed quote styles in the same source', () => {
            const mixedSource = `
MODEL_MAP = {
    "llama": LlamaForCausalLM,
    'mistral': MistralForCausalLM,
    "phi": PhiForCausalLM,
    'qwen': QwenForCausalLM,
}
`;
            const result = parseTensorRTRegistry(mixedSource);
            assert.ok(result.includes('llama'), 'Should include double-quoted llama');
            assert.ok(result.includes('mistral'), 'Should include single-quoted mistral');
            assert.ok(result.includes('phi'), 'Should include double-quoted phi');
            assert.ok(result.includes('qwen'), 'Should include single-quoted qwen');
        });

        it('should return sorted results', () => {
            const result = parseTensorRTRegistry(TENSORRT_REGISTRY_SOURCE);
            const sorted = [...result].sort();
            assert.deepStrictEqual(result, sorted, 'Results should be sorted alphabetically');
        });

        it('should not include duplicate entries across quote styles', () => {
            const sourceWithDuplicates = `
MODEL_MAP = {
    "llama": LlamaForCausalLM,
    'llama': LlamaModel,
}
`;
            const result = parseTensorRTRegistry(sourceWithDuplicates);
            const llamaCount = result.filter(t => t === 'llama').length;
            assert.strictEqual(llamaCount, 1, 'Should deduplicate across quote styles');
        });
    });

    describe('Edge Cases', () => {

        it('should return empty array for empty source', () => {
            assert.deepStrictEqual(parseVllmRegistry(''), []);
            assert.deepStrictEqual(parseSglangRegistry(''), []);
            assert.deepStrictEqual(parseTensorRTRegistry(''), []);
        });

        it('should return empty array for source with no model registry patterns', () => {
            const noMatchSource = `
# This is just a regular Python file
import os
import sys

def main():
    print("Hello, world!")

if __name__ == "__main__":
    main()
`;
            assert.deepStrictEqual(parseVllmRegistry(noMatchSource), []);
            assert.deepStrictEqual(parseSglangRegistry(noMatchSource), []);
            assert.deepStrictEqual(parseTensorRTRegistry(noMatchSource), []);
        });

        it('should return empty array for malformed source with partial patterns', () => {
            const malformedSource = `
# Incomplete dict entries - keys don't match expected patterns
_MODELS = {
    "": ("module", "Class"),
    "123invalid": ("module", "Class"),
    "UPPERCASE": ("module", "Class"),
}
`;
            // Parser requires keys starting with lowercase letter
            const vllmResult = parseVllmRegistry(malformedSource);
            assert.ok(!vllmResult.includes(''), 'Should not include empty string');
            assert.ok(!vllmResult.includes('123invalid'), 'Should not include keys starting with numbers');
            assert.ok(!vllmResult.includes('UPPERCASE'), 'Should not include uppercase keys');
        });

        it('should handle source with comments and whitespace variations', () => {
            const sourceWithComments = `
# Model registry with various whitespace
_MODELS = {
    "llama":   ("module", "LlamaForCausalLM"),   # Llama model
    "qwen2" :  ("module", "Qwen2ForCausalLM"),
}
`;
            const result = parseVllmRegistry(sourceWithComments);
            assert.ok(result.includes('llama'), 'Should handle extra spaces after colon');
        });

        it('should only match keys with valid model_type format', () => {
            const mixedSource = `
_MODELS = {
    "valid_model": ("module", "ValidModel"),
    "also_valid2": ("module", "AlsoValid"),
    "a": ("module", "SingleChar"),
}
`;
            const result = parseVllmRegistry(mixedSource);
            assert.ok(result.includes('valid_model'), 'Should include valid underscore names');
            assert.ok(result.includes('also_valid2'), 'Should include names with trailing numbers');
        });
    });
});
