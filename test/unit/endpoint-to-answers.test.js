// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'mocha';
import { inferDeploymentConfig, extractModelId } from '../../src/lib/endpoint-to-answers.js';

describe('endpoint-to-answers', () => {
    describe('inferDeploymentConfig', () => {
        it('test_infer_deployment_config_vllm', () => {
            assert.strictEqual(
                inferDeploymentConfig('123456789012.dkr.ecr.us-east-1.amazonaws.com/vllm/vllm-openai:v0.21.0'),
                'transformers-vllm'
            );
        });

        it('test_infer_deployment_config_sglang', () => {
            assert.strictEqual(
                inferDeploymentConfig('123456789012.dkr.ecr.us-east-1.amazonaws.com/sglang-server:latest'),
                'transformers-sglang'
            );
        });

        it('test_infer_deployment_config_lmi', () => {
            assert.strictEqual(
                inferDeploymentConfig('763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:latest'),
                'transformers-lmi'
            );
        });

        it('test_infer_deployment_config_triton', () => {
            assert.strictEqual(
                inferDeploymentConfig('nvcr.io/nvidia/tritonserver:24.01-py3'),
                'triton'
            );
        });

        it('test_infer_deployment_config_flask', () => {
            assert.strictEqual(
                inferDeploymentConfig('my-repo/flask-inference:1.0'),
                'http-flask'
            );
        });

        it('test_infer_deployment_config_unknown', () => {
            assert.strictEqual(
                inferDeploymentConfig('some-random-image:latest'),
                'transformers-vllm'
            );
        });
    });

    describe('extractModelId', () => {
        it('test_extract_model_id_priority', () => {
            const envVars = {
                IC_ENV_HF_MODEL_ID: 'meta-llama/Llama-3-8B',
                HF_MODEL_ID: 'meta-llama/Llama-2-7B',
                MODEL_NAME: 'some-other-model'
            };
            assert.strictEqual(extractModelId(envVars), 'meta-llama/Llama-3-8B');
        });

        it('test_extract_model_id_fallback_hf_model_id', () => {
            const envVars = {
                HF_MODEL_ID: 'meta-llama/Llama-2-7B',
                MODEL_NAME: 'some-other-model'
            };
            assert.strictEqual(extractModelId(envVars), 'meta-llama/Llama-2-7B');
        });

        it('test_extract_model_id_fallback_model_name', () => {
            const envVars = {
                MODEL_NAME: 'custom-model-v2'
            };
            assert.strictEqual(extractModelId(envVars), 'custom-model-v2');
        });

        it('test_extract_model_id_returns_unknown_when_empty', () => {
            assert.strictEqual(extractModelId({}), 'unknown');
        });

        it('test_extract_model_id_skips_empty_values', () => {
            const envVars = {
                IC_ENV_HF_MODEL_ID: '',
                HF_MODEL_ID: '',
                MODEL_NAME: 'fallback-model'
            };
            assert.strictEqual(extractModelId(envVars), 'fallback-model');
        });
    });
});
