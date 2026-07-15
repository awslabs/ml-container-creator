/**
 * Tests for IC_ENV_* deploy-time environment variable injection.
 *
 * Validates:
 * - IC_ENV_* variables are rendered in do/config as exports
 * - inference-component.sh collects IC_ENV_* vars, strips prefix, validates constraints
 * - Max 16 entries enforced (AC-3.3)
 * - Key/value <= 1024 chars enforced (AC-3.4)
 * - IC_ENV_* overrides take precedence over CONTAINER_ENV_JSON
 * - Secrets warning is included in generated do/config (AC-3.8)
 *
 * Requirements: US-3
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_TEMPLATE = readFileSync(
    resolve(__dirname, '../../templates/do/config'),
    'utf-8'
);
const IC_SCRIPT = readFileSync(
    resolve(__dirname, '../../templates/do/lib/inference-component.sh'),
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
        buildTarget: 'codebuild',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        modelName: 'meta-llama/Llama-3.1-8B-Instruct',
        hfToken: '',
        hfTokenArn: '',
        ngcApiKey: '',
        ngcTokenArn: '',
        roleArn: '',
        modelFormat: '',
        baseImage: 'test-image:latest',
        orderedEnvVars: [],
        codebuildComputeType: 'BUILD_GENERAL1_LARGE',
        inferenceAmiVersion: '',
        tuneSupported: false,
        tuneModelId: null,
        enableLora: true,
        includeBenchmark: true,
        benchmarkConcurrency: 10,
        benchmarkInputTokensMean: 550,
        benchmarkOutputTokensMean: 150,
        benchmarkStreaming: true,
        benchmarkRequestCount: null,
        benchmarkS3OutputPath: null,
        ...overrides
    };
}

describe('IC_ENV_* Deploy-time Environment Variables (US-3)', () => {

    describe('do/config rendering with icEnvVars', () => {

        it('IC_ENV_FOO=bar is rendered as export in do/config', () => {
            const icEnvVars = { FOO: 'bar' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars }));

            assert.ok(
                output.includes('export IC_ENV_FOO='),
                'do/config should export IC_ENV_FOO'
            );
            assert.ok(
                output.includes('bar'),
                'do/config should include value bar'
            );
        });

        it('multiple IC_ENV vars are all rendered as export lines', () => {
            const icEnvVars = {
                VLLM_MAX_MODEL_LEN: '8192',
                VLLM_TENSOR_PARALLEL_SIZE: '2',
                VLLM_GPU_MEMORY_UTILIZATION: '0.85'
            };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars }));

            assert.ok(
                output.includes('export IC_ENV_VLLM_MAX_MODEL_LEN='),
                'do/config should export IC_ENV_VLLM_MAX_MODEL_LEN'
            );
            assert.ok(
                output.includes('export IC_ENV_VLLM_TENSOR_PARALLEL_SIZE='),
                'do/config should export IC_ENV_VLLM_TENSOR_PARALLEL_SIZE'
            );
            assert.ok(
                output.includes('export IC_ENV_VLLM_GPU_MEMORY_UTILIZATION='),
                'do/config should export IC_ENV_VLLM_GPU_MEMORY_UTILIZATION'
            );
        });

        it('IC_ENV section has deploy-time header comment', () => {
            const icEnvVars = { FOO: 'bar' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars }));

            assert.ok(
                output.includes('Deploy-time IC environment variables'),
                'do/config should have deploy-time IC env vars header'
            );
        });

        it('IC_ENV uses ${KEY:-value} pattern allowing runtime override', () => {
            const icEnvVars = { VLLM_MAX_MODEL_LEN: '8192' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars }));

            assert.ok(
                output.includes('export IC_ENV_VLLM_MAX_MODEL_LEN=${IC_ENV_VLLM_MAX_MODEL_LEN:-8192}'),
                'do/config should use ${KEY:-value} pattern for IC env vars'
            );
        });

        it('empty icEnvVars shows commented placeholder for realtime-inference', () => {
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars: {} }));

            assert.ok(
                output.includes('IC_ENV_VLLM_MAX_MODEL_LEN'),
                'do/config should have IC_ENV placeholder section for realtime-inference when empty'
            );
        });

        it('empty icEnvVars does not show IC_ENV section for non-realtime targets', () => {
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({
                icEnvVars: {},
                deploymentTarget: 'batch-transform',
                instanceType: 'ml.g5.xlarge',
                batchInstanceCount: 1,
                batchSplitType: 'Line',
                batchStrategy: 'MultiRecord',
                batchJoinSource: 'None',
                batchMaxConcurrentTransforms: null,
                batchMaxPayloadInMB: null
            }));

            assert.ok(
                !output.includes('IC_ENV_VLLM_MAX_MODEL_LEN'),
                'do/config should NOT have IC_ENV section for batch-transform'
            );
        });
    });

    describe('secrets warning (AC-3.8)', () => {

        it('generated do/config includes secrets warning when icEnvVars present', () => {
            const icEnvVars = { FOO: 'bar' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars }));

            assert.ok(
                output.includes('Do not store raw secrets here'),
                'do/config should warn against storing raw secrets'
            );
            assert.ok(
                output.includes('Secrets Manager ARN pattern'),
                'do/config should recommend Secrets Manager ARN pattern'
            );
        });

        it('secrets warning recommends IC_ENV_HF_TOKEN_ARN pattern', () => {
            const icEnvVars = { FOO: 'bar' };
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars }));

            assert.ok(
                output.includes('IC_ENV_HF_TOKEN_ARN'),
                'do/config should reference IC_ENV_HF_TOKEN_ARN as an example ARN pattern'
            );
        });

        it('secrets warning present in commented placeholder section too', () => {
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ icEnvVars: {} }));

            assert.ok(
                output.includes('Do not store raw secrets here'),
                'Commented placeholder section should include secrets warning'
            );
        });
    });

    describe('inference-component.sh IC_ENV_* handling', () => {

        it('contains _collect_ic_env_vars function', () => {
            assert.ok(
                IC_SCRIPT.includes('_collect_ic_env_vars()'),
                'inference-component.sh should define _collect_ic_env_vars function'
            );
        });

        it('reads IC_ENV_ prefixed variables from environment', () => {
            assert.ok(
                IC_SCRIPT.includes('grep "^IC_ENV_"'),
                'Should grep for IC_ENV_ prefixed environment variables'
            );
        });

        it('strips IC_ENV_ prefix from keys', () => {
            assert.ok(
                IC_SCRIPT.includes('${full_key#IC_ENV_}'),
                'Should strip IC_ENV_ prefix using parameter expansion'
            );
        });

        it('validates max 16 entries (AC-3.3)', () => {
            assert.ok(
                IC_SCRIPT.includes('ic_env_count') && IC_SCRIPT.includes('-gt 16'),
                'Should count entries and check if exceeds 16'
            );
            assert.ok(
                IC_SCRIPT.includes('Using first 16 only'),
                'Should warn when exceeding 16 entries'
            );
        });

        it('validates key length <= 1024 chars (AC-3.4)', () => {
            assert.ok(
                IC_SCRIPT.includes('${#stripped_key} -gt 1024'),
                'Should check key length against 1024'
            );
            assert.ok(
                IC_SCRIPT.includes('key exceeds 1024 chars, skipping'),
                'Should warn when key exceeds 1024 chars'
            );
        });

        it('validates value length <= 1024 chars (AC-3.4)', () => {
            assert.ok(
                IC_SCRIPT.includes('${#value} -gt 1024'),
                'Should check value length against 1024'
            );
            assert.ok(
                IC_SCRIPT.includes('value exceeds 1024 chars, skipping'),
                'Should warn when value exceeds 1024 chars'
            );
        });

        it('IC_ENV_* overrides take precedence over CONTAINER_ENV_JSON', () => {
            // IC_ENV_OVERRIDE is appended after CONTAINER_ENV_JSON and IC_CONTAINER_ENV_EXTRA
            // which means IC_ENV_* keys appear later in the JSON and override earlier ones
            const envMergeSection = IC_SCRIPT.includes(
                '[ -n "${IC_ENV_OVERRIDE:-}" ] && env_json="${env_json:+${env_json},}${IC_ENV_OVERRIDE}"'
            );
            assert.ok(
                envMergeSection,
                'IC_ENV_OVERRIDE should be appended after CONTAINER_ENV_JSON (overriding precedence)'
            );
        });

        it('calls _collect_ic_env_vars in create_inference_component', () => {
            const createFnStart = IC_SCRIPT.indexOf('create_inference_component()');
            const createFnBody = IC_SCRIPT.substring(createFnStart, createFnStart + 2000);
            assert.ok(
                createFnBody.includes('_collect_ic_env_vars'),
                'create_inference_component must call _collect_ic_env_vars'
            );
        });

        it('outputs IC_ENV_OVERRIDE as JSON key-value pairs', () => {
            // The shell script uses escaped quotes: \"${stripped_key}\":\"${value}\"
            assert.ok(
                IC_SCRIPT.includes('\\"${stripped_key}\\":\\"${value}\\"'),
                'Should format as JSON "key":"value" pairs using escaped quotes'
            );
        });
    });
});
