/**
 * Verifies that --server-env KEY=VALUE pairs flow through the generator
 * and are rendered as `export KEY=VALUE` lines in the generated do/config.
 *
 * Task 3.1: Trace --server-env from CLI → generator → template context → do/config
 * Requirements: FTP-3 (3.1, 3.2, 3.3)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { resolvePrefixedEnvVars } from '../../src/lib/engine-prefix-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_TEMPLATE = readFileSync(
    resolve(__dirname, '../../templates/do/config'),
    'utf-8'
);

/** Base template variables required for do/config rendering */
function baseVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'local',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        modelName: 'meta-llama/Llama-2-7b-hf',
        hfToken: 'hf_test_token',
        hfTokenArn: '',
        ngcApiKey: '',
        ngcTokenArn: '',
        roleArn: '',
        modelFormat: '',
        baseImage: '',
        orderedEnvVars: [],
        codebuildComputeType: '',
        inferenceAmiVersion: '',
        ...overrides
    };
}

describe('Server-Env do/config Rendering (Task 3.1)', () => {

    describe('serverEnvVars are rendered as export lines', () => {

        it('single server env var is rendered as export in do/config', () => {
            const serverEnvVars = { SM_VLLM_KV_CACHE_DTYPE: 'fp8' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ serverEnvVars }));

            // Should contain export line for the server env var
            assert.ok(
                output.includes('export SM_VLLM_KV_CACHE_DTYPE='),
                'do/config should export SM_VLLM_KV_CACHE_DTYPE'
            );
            // Verify the value is present
            assert.ok(
                output.includes('fp8'),
                'do/config should include value fp8'
            );
        });

        it('multiple server env vars are all rendered as export lines', () => {
            const serverEnvVars = {
                SM_VLLM_KV_CACHE_DTYPE: 'fp8',
                SM_VLLM_MAX_MODEL_LEN: '32768',
                SM_VLLM_GPU_MEMORY_UTILIZATION: '0.95'
            };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ serverEnvVars }));

            // Each var should have an export line
            assert.ok(
                output.includes('export SM_VLLM_KV_CACHE_DTYPE='),
                'do/config should export SM_VLLM_KV_CACHE_DTYPE'
            );
            assert.ok(
                output.includes('export SM_VLLM_MAX_MODEL_LEN='),
                'do/config should export SM_VLLM_MAX_MODEL_LEN'
            );
            assert.ok(
                output.includes('export SM_VLLM_GPU_MEMORY_UTILIZATION='),
                'do/config should export SM_VLLM_GPU_MEMORY_UTILIZATION'
            );
        });

        it('server env vars section has correct header comment', () => {
            const serverEnvVars = { SM_VLLM_KV_CACHE_DTYPE: 'fp8' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ serverEnvVars }));

            assert.ok(
                output.includes('# Server environment variables'),
                'do/config should have "# Server environment variables" header'
            );
        });

        it('empty serverEnvVars does not render the section', () => {
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ serverEnvVars: {} }));

            assert.ok(
                !output.includes('# Server environment variables'),
                'do/config should NOT have server env section when empty'
            );
        });

        it('undefined serverEnvVars does not render the section', () => {
            const output = ejs.render(CONFIG_TEMPLATE, baseVars());

            assert.ok(
                !output.includes('# Server environment variables'),
                'do/config should NOT have server env section when undefined'
            );
        });
    });

    describe('server env vars use runtime-override pattern', () => {

        it('uses ${KEY:-value} pattern allowing runtime override', () => {
            const serverEnvVars = { SM_VLLM_KV_CACHE_DTYPE: 'fp8' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ serverEnvVars }));

            assert.ok(
                output.includes('export SM_VLLM_KV_CACHE_DTYPE=${SM_VLLM_KV_CACHE_DTYPE:-fp8}'),
                'do/config should use ${KEY:-value} pattern for server env vars'
            );
        });
    });

    describe('end-to-end flow: CLI --server-env → prefixed → do/config', () => {

        it('vllm engine applies VLLM_ prefix via resolvePrefixedEnvVars', () => {
            // Simulate CLI input: --server-env KV_CACHE_DTYPE=fp8
            const rawServerEnvVars = { KV_CACHE_DTYPE: 'fp8' };
            const engine = 'vllm';

            const prefixed = resolvePrefixedEnvVars(engine, rawServerEnvVars);

            // vllm engine should prefix with VLLM_
            assert.ok(
                'VLLM_KV_CACHE_DTYPE' in prefixed,
                'vllm engine should prefix KV_CACHE_DTYPE with VLLM_'
            );
            assert.strictEqual(prefixed.VLLM_KV_CACHE_DTYPE, 'fp8');
        });

        it('user-provided full env var name is prefixed by engine', () => {
            // When user specifies the full SageMaker env var name directly
            // the prefix resolver still adds the engine prefix
            const rawServerEnvVars = { SM_VLLM_KV_CACHE_DTYPE: 'fp8' };
            const engine = 'vllm';

            const prefixed = resolvePrefixedEnvVars(engine, rawServerEnvVars);

            // The resolver always adds the engine prefix
            assert.ok(
                'VLLM_SM_VLLM_KV_CACHE_DTYPE' in prefixed,
                'Full SM_VLLM_ var gets engine prefix prepended'
            );
        });

        it('prefixed server env vars render correctly in do/config', () => {
            // Simulate the full flow: CLI → prefix → template
            const rawServerEnvVars = { KV_CACHE_DTYPE: 'fp8', MAX_MODEL_LEN: '32768' };
            const engine = 'vllm';
            const prefixed = resolvePrefixedEnvVars(engine, rawServerEnvVars);

            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ serverEnvVars: prefixed }));

            // All prefixed vars should be exported
            for (const key of Object.keys(prefixed)) {
                assert.ok(
                    output.includes(`export ${key}=`),
                    `do/config should export ${key}`
                );
            }
        });
    });

    describe('server env vars are available to do/deploy via sourced config', () => {

        it('exported vars are sourceable by downstream scripts', () => {
            const serverEnvVars = {
                SM_VLLM_KV_CACHE_DTYPE: 'fp8',
                SM_VLLM_TENSOR_PARALLEL_SIZE: '8'
            };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ serverEnvVars }));

            // Verify each var produces a valid bash export statement
            const lines = output.split('\n');
            const exportLines = lines.filter(l =>
                l.trim().startsWith('export SM_VLLM_')
            );

            assert.strictEqual(
                exportLines.length, 2,
                `Expected 2 SM_VLLM_ export lines, got ${exportLines.length}`
            );

            // Each line should be valid bash export syntax
            for (const line of exportLines) {
                assert.match(
                    line.trim(),
                    /^export [A-Z_]+=\$\{[A-Z_]+:-[^}]+\}$/,
                    `Export line should match bash syntax: ${line}`
                );
            }
        });
    });
});
