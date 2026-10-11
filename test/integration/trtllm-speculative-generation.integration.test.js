// SPDX-License-Identifier: Apache-2.0

/**
 * Integration (BL125): TensorRT-LLM speculative_config survives the FULL
 * generation pipeline and lands in the generated serve script ON DISK.
 *
 * The unit test (test/unit/speculative-decoding.test.js, "BL125" blocks) proves
 * the wrapper assembly and manifest in isolation by rendering the EJS directly.
 * THIS test proves the glue: it spawns the real CLI via runGenerator for a
 * `transformers-tensorrt-llm` project and asserts the speculative_config assembly
 * (the --extra_llm_api_options YAML builder) is present in the generated
 * `code/serve`. That closes the Req 4 "declared but not wired" gap end-to-end —
 * a regression in writeProject's serve.d include, the Dockerfile COPY, or the
 * engine include-list would otherwise pass every isolated render test silently.
 *
 * Deterministic/offline: runGenerator defaults to --skip-prompts and sets
 * VALIDATE_ENV_VARS=false; a concrete model + instance avoid MCP/network.
 */
import { describe, it, after } from 'mocha';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Integration: TensorRT-LLM speculative_config → code/serve (end-to-end)', () => {
    const cleanups = [];
    after(() => {
        for (const c of cleanups) {
            try { c(); } catch { /* best-effort temp cleanup */ }
        }
    });

    function generateTrtllm() {
        const result = runGenerator({
            'deployment-config': 'transformers-tensorrt-llm',
            'model-name': 'meta-llama/Llama-3.1-8B',
            'instance-type': 'ml.g5.xlarge'
        });
        cleanups.push(result.cleanup);
        return result;
    }

    it('generates code/serve carrying the TRT-LLM serve wrapper', () => {
        const result = generateTrtllm();
        const serve = readFileSync(result.file('code/serve'), 'utf8');
        assert.match(serve, /TensorRT-LLM Server Configuration/,
            'code/serve must include the tensorrt-llm wrapper');
    });

    it('the generated serve script assembles a speculative_config via --extra_llm_api_options', () => {
        const result = generateTrtllm();
        const serve = readFileSync(result.file('code/serve'), 'utf8');
        // The structured speculative config (Req 2.1) — proof the wrapper EMITS it,
        // not merely that the manifest declares it (Req 4.1).
        assert.match(serve, /speculative_config:/,
            'generated serve script must assemble a speculative_config YAML block');
        assert.match(serve, /decoding_type:/,
            'generated serve script must set decoding_type');
        assert.match(serve, /extra_llm_api_options/,
            'generated serve script must pass the YAML via --extra_llm_api_options');
        // Guarded on the prefixed algorithm env var (ADR-004 prefix, resolved to TRTLLM_).
        assert.match(serve, /TRTLLM_SPECULATIVE_ALGORITHM/,
            'the speculative assembly must be driven by the prefixed algorithm env var');
    });

    it('non-speculative output is unaffected: the assembly is gated on the algorithm env var', () => {
        const result = generateTrtllm();
        const serve = readFileSync(result.file('code/serve'), 'utf8');
        // The whole block is wrapped in `if [ -n "${TRTLLM_SPECULATIVE_ALGORITHM:-}" ]`,
        // so a project that never sets the var emits no speculative config at runtime.
        assert.match(serve, /if \[ -n "\$\{TRTLLM_SPECULATIVE_ALGORITHM:-\}" \]; then/,
            'the speculative config must be gated so unset = no speculative output');
    });
});
