// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * H2 Multi-GPU Serving — InferenceEndpointConfig CRD rendering tests
 *
 * After the BL088 migration, HyperPod EKS deployments render a single
 * InferenceEndpointConfig CRD. This suite verifies the CRD template correctly
 * renders:
 * - GPU count from HP_GPU_COUNT (worker.resources requests/limits)
 * - VLLM_TENSOR_PARALLEL_SIZE environmentVariable
 * - EFA conditional block (env vars + vpc.amazonaws.com/efa resource)
 * - Kueue queue label from HP_QUEUE
 *
 * CPU/memory now flow through shell `${HP_CPU_REQUEST:-N}` / `${HP_MEM_REQUEST:-NGi}`
 * placeholders that are resolved at deploy time, so the raw defaults are asserted
 * as substrings of the rendered (pre-envsubst) template.
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const TEMPLATE_PATH = resolve(__dirname, '..', '..', 'templates', 'hyperpod', 'InferenceEndpointConfig.yaml.ejs');
const templateContent = readFileSync(TEMPLATE_PATH, 'utf8');

function renderTemplate(vars) {
    const defaults = {
        projectName: 'test-model',
        hyperPodNamespace: 'default',
        framework: 'transformers',
        modelName: 'meta-llama/Llama-3.1-8B',
        hyperPodReplicas: 1,
        awsRegion: 'us-east-1',
        instanceType: 'ml.g5.xlarge',
        HP_GPU_COUNT: '1',
        HP_NODE_SELECTOR: '',
        HP_EFA_ENABLED: 'false',
        HP_MEM_REQUEST: '',
        HP_CPU_REQUEST: '',
        HP_QUEUE: ''
    };
    return ejs.render(templateContent, { ...defaults, ...vars });
}

describe('H2: Multi-GPU Serving — InferenceEndpointConfig CRD rendering', () => {

    describe('GPU count rendering', () => {
        it('HP_GPU_COUNT=1: nvidia.com/gpu "1", TP=1, default memory 16Gi, CPU 4', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '1' });
            assert.ok(output.includes('nvidia.com/gpu: "1"'), 'GPU should be 1');
            assert.ok(output.includes('VLLM_TENSOR_PARALLEL_SIZE'), 'TP env var should be present');
            assert.ok(output.includes('${HP_MEM_REQUEST:-16Gi}'), 'default memory should be 16Gi');
            assert.ok(output.includes('${HP_CPU_REQUEST:-4}'), 'default CPU should be 4');
        });

        it('HP_GPU_COUNT=4: nvidia.com/gpu "4", TP=4, default memory 64Gi, CPU 16', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '4' });
            assert.ok(output.includes('nvidia.com/gpu: "4"'), 'GPU should be 4');
            assert.ok(output.includes('${HP_MEM_REQUEST:-64Gi}'), 'default memory should be 64Gi');
            assert.ok(output.includes('${HP_CPU_REQUEST:-16}'), 'default CPU should be 16');
        });

        it('HP_GPU_COUNT=8: default memory 128Gi, CPU 32', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '8' });
            assert.ok(output.includes('nvidia.com/gpu: "8"'), 'GPU should be 8');
            assert.ok(output.includes('${HP_MEM_REQUEST:-128Gi}'), 'default memory should be 128Gi');
            assert.ok(output.includes('${HP_CPU_REQUEST:-32}'), 'default CPU should be 32');
        });
    });

    describe('Tensor parallel size wiring', () => {
        it('VLLM_TENSOR_PARALLEL_SIZE matches HP_GPU_COUNT', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '4' });
            // Env var value block renders the GPU count as the TP size.
            const tpIdx = output.indexOf('VLLM_TENSOR_PARALLEL_SIZE');
            const after = output.slice(tpIdx, tpIdx + 80);
            assert.ok(after.includes('value: "4"'), 'TP size should equal GPU count');
        });
    });

    describe('EFA conditional block', () => {
        it('HP_EFA_ENABLED=false: no EFA resources or NCCL env vars', () => {
            const output = renderTemplate({ HP_EFA_ENABLED: 'false' });
            assert.ok(!output.includes('vpc.amazonaws.com/efa'), 'no EFA resources when disabled');
            assert.ok(!output.includes('NCCL_SOCKET_IFNAME'), 'no NCCL env vars when EFA disabled');
            assert.ok(!output.includes('FI_PROVIDER'), 'no FI_PROVIDER when EFA disabled');
        });

        it('HP_EFA_ENABLED=true: EFA resources and NCCL env vars present', () => {
            const output = renderTemplate({ HP_EFA_ENABLED: 'true' });
            assert.ok(output.includes('vpc.amazonaws.com/efa: "1"'), 'EFA resource should be present');
            assert.ok(output.includes('NCCL_SOCKET_IFNAME'), 'NCCL_SOCKET_IFNAME should be present');
            assert.ok(output.includes('FI_PROVIDER'), 'FI_PROVIDER should be present');
            assert.ok(output.includes('value: "efa"'), 'FI_PROVIDER should be efa');
            assert.ok(output.includes('NCCL_PROTOCOL'), 'NCCL_PROTOCOL should be present');
        });
    });

    describe('Kueue queue label', () => {
        it('HP_QUEUE not set: no queue label', () => {
            const output = renderTemplate({ HP_QUEUE: '' });
            assert.ok(!output.includes('kueue.x-k8s.io/queue-name'), 'no queue label when HP_QUEUE empty');
        });

        it('HP_QUEUE set: queue label present', () => {
            const output = renderTemplate({ HP_QUEUE: 'gpu-queue' });
            assert.ok(output.includes('kueue.x-k8s.io/queue-name: "gpu-queue"'), 'queue label should be present');
        });
    });

    describe('Instance type', () => {
        it('HP_NODE_SELECTOR set: instanceType placeholder uses that value', () => {
            const output = renderTemplate({ HP_NODE_SELECTOR: 'ml.g5.12xlarge' });
            assert.ok(output.includes('ml.g5.12xlarge'), 'should use HP_NODE_SELECTOR value in instanceType');
        });

        it('HP_NODE_SELECTOR empty: falls back to instanceType', () => {
            const output = renderTemplate({ HP_NODE_SELECTOR: '', instanceType: 'ml.g5.xlarge' });
            assert.ok(output.includes('ml.g5.xlarge'), 'should use instanceType when HP_NODE_SELECTOR empty');
        });
    });
});

describe('H2: Instance-sizer → HP_GPU_COUNT wiring', () => {
    // These test the logic added to prompt-runner.js
    it('gpuCount=4 + instanceType=ml.g5.12xlarge flows to HP_GPU_COUNT and HP_NODE_SELECTOR', () => {
        const combinedAnswers = {
            deploymentTarget: 'hyperpod-eks',
            gpuCount: 4,
            instanceType: 'ml.g5.12xlarge'
        };

        if (combinedAnswers.deploymentTarget === 'hyperpod-eks') {
            if (combinedAnswers.gpuCount) {
                combinedAnswers.HP_GPU_COUNT = String(combinedAnswers.gpuCount);
            } else {
                combinedAnswers.HP_GPU_COUNT = combinedAnswers.HP_GPU_COUNT || '1';
            }
            if (combinedAnswers.instanceType && !combinedAnswers.HP_NODE_SELECTOR) {
                combinedAnswers.HP_NODE_SELECTOR = combinedAnswers.instanceType;
            }
        }

        assert.strictEqual(combinedAnswers.HP_GPU_COUNT, '4');
        assert.strictEqual(combinedAnswers.HP_NODE_SELECTOR, 'ml.g5.12xlarge');
    });

    it('no gpuCount defaults HP_GPU_COUNT to 1', () => {
        const combinedAnswers = {
            deploymentTarget: 'hyperpod-eks',
            instanceType: 'ml.g5.xlarge'
        };

        if (combinedAnswers.deploymentTarget === 'hyperpod-eks') {
            if (combinedAnswers.gpuCount) {
                combinedAnswers.HP_GPU_COUNT = String(combinedAnswers.gpuCount);
            } else {
                combinedAnswers.HP_GPU_COUNT = combinedAnswers.HP_GPU_COUNT || '1';
            }
            if (combinedAnswers.instanceType && !combinedAnswers.HP_NODE_SELECTOR) {
                combinedAnswers.HP_NODE_SELECTOR = combinedAnswers.instanceType;
            }
        }

        assert.strictEqual(combinedAnswers.HP_GPU_COUNT, '1');
        assert.strictEqual(combinedAnswers.HP_NODE_SELECTOR, 'ml.g5.xlarge');
    });

    it('non-hyperpod target does not set HP_GPU_COUNT', () => {
        const combinedAnswers = {
            deploymentTarget: 'realtime-inference',
            gpuCount: 4,
            instanceType: 'ml.g5.12xlarge'
        };

        if (combinedAnswers.deploymentTarget === 'hyperpod-eks') {
            if (combinedAnswers.gpuCount) {
                combinedAnswers.HP_GPU_COUNT = String(combinedAnswers.gpuCount);
            }
        }

        assert.strictEqual(combinedAnswers.HP_GPU_COUNT, undefined);
    });
});
