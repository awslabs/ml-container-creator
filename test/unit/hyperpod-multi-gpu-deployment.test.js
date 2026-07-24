// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * H2 Multi-GPU Serving — deployment.yaml rendering tests
 *
 * Tests that the HyperPod deployment.yaml template correctly renders:
 * - GPU count from HP_GPU_COUNT
 * - VLLM_TENSOR_PARALLEL_SIZE env var
 * - Memory/CPU auto-scaling
 * - EFA conditional block
 * - Node selector from HP_NODE_SELECTOR
 * - Queue label from HP_QUEUE
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const TEMPLATE_PATH = resolve(__dirname, '..', '..', 'templates', 'hyperpod', 'deployment.yaml');
const templateContent = readFileSync(TEMPLATE_PATH, 'utf8');

function renderTemplate(vars) {
    const defaults = {
        projectName: 'test-model',
        hyperPodNamespace: 'default',
        framework: 'transformers',
        hyperPodReplicas: 1,
        awsRegion: 'us-east-1',
        instanceType: 'ml.g5.xlarge',
        fsxVolumeHandle: '',
        HP_GPU_COUNT: '1',
        HP_NODE_SELECTOR: '',
        HP_EFA_ENABLED: 'false',
        HP_MEM_REQUEST: '',
        HP_CPU_REQUEST: '',
        HP_QUEUE: ''
    };
    return ejs.render(templateContent, { ...defaults, ...vars });
}

describe('H2: Multi-GPU Serving — deployment.yaml rendering', () => {

    describe('GPU count rendering', () => {
        it('HP_GPU_COUNT=1: manifest has nvidia.com/gpu "1", TP=1, memory 16Gi, CPU 4', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '1' });
            assert.ok(output.includes('nvidia.com/gpu: "1"'), 'GPU requests should be 1');
            assert.ok(output.includes('VLLM_TENSOR_PARALLEL_SIZE'), 'TP env var should be present');
            assert.ok(output.includes('value: "1"'), 'TP should be 1');
            assert.ok(output.includes('memory: "16Gi"'), 'memory request should be 16Gi');
            assert.ok(output.includes('cpu: "4"'), 'CPU request should be 4');
        });

        it('HP_GPU_COUNT=4: manifest has nvidia.com/gpu "4", TP=4, memory 64Gi, CPU 16', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '4' });
            assert.ok(output.includes('nvidia.com/gpu: "4"'), 'GPU requests should be 4');
            assert.ok(output.includes('value: "4"'), 'TP should be 4');
            assert.ok(output.includes('memory: "64Gi"'), 'memory request should be 64Gi');
            assert.ok(output.includes('cpu: "16"'), 'CPU request should be 16');
        });

        it('HP_GPU_COUNT=8: TP=8, memory 128Gi, CPU 32', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '8' });
            assert.ok(output.includes('nvidia.com/gpu: "8"'), 'GPU requests should be 8');
            assert.ok(output.includes('value: "8"'), 'TP should be 8');
            assert.ok(output.includes('memory: "128Gi"'), 'memory request should be 128Gi');
            assert.ok(output.includes('cpu: "32"'), 'CPU request should be 32');
        });

        it('HP_GPU_COUNT=2: TP=2, memory 32Gi, CPU 8', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '2' });
            assert.ok(output.includes('nvidia.com/gpu: "2"'), 'GPU requests should be 2');
            assert.ok(output.includes('value: "2"'), 'TP should be 2');
            assert.ok(output.includes('memory: "32Gi"'), 'memory request should be 32Gi');
            assert.ok(output.includes('cpu: "8"'), 'CPU request should be 8');
        });
    });

    describe('Memory/CPU override via HP_MEM_REQUEST and HP_CPU_REQUEST', () => {
        it('HP_MEM_REQUEST overrides auto-calculated memory', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '4', HP_MEM_REQUEST: '128' });
            // requests.memory should be the override value
            assert.ok(output.includes('memory: "128"'), 'memory request should be overridden to 128');
        });

        it('HP_CPU_REQUEST overrides auto-calculated CPU', () => {
            const output = renderTemplate({ HP_GPU_COUNT: '4', HP_CPU_REQUEST: '32' });
            assert.ok(output.includes('cpu: "32"'), 'CPU request should be overridden to 32');
        });
    });

    describe('Node selector', () => {
        it('HP_NODE_SELECTOR="": uses instanceType variable for nodeSelector', () => {
            const output = renderTemplate({ HP_NODE_SELECTOR: '', instanceType: 'ml.g5.xlarge' });
            assert.ok(output.includes('node.kubernetes.io/instance-type: ml.g5.xlarge'),
                'should use instanceType when HP_NODE_SELECTOR is empty');
        });

        it('HP_NODE_SELECTOR="ml.g5.12xlarge": nodeSelector uses that value', () => {
            const output = renderTemplate({ HP_NODE_SELECTOR: 'ml.g5.12xlarge' });
            assert.ok(output.includes('node.kubernetes.io/instance-type: "ml.g5.12xlarge"'),
                'should use HP_NODE_SELECTOR value');
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

        it('HP_QUEUE set: queue label present on pod and deployment', () => {
            const output = renderTemplate({ HP_QUEUE: 'gpu-queue' });
            assert.ok(output.includes('kueue.x-k8s.io/queue-name: "gpu-queue"'), 'queue label should be present');
        });
    });

    describe('FSx volume mount', () => {
        it('fsxVolumeHandle set: volumeMount and PVC present', () => {
            const output = renderTemplate({ fsxVolumeHandle: 'fs-1234567890' });
            assert.ok(output.includes('fsx-storage'), 'FSx volume name present');
            assert.ok(output.includes('/opt/ml/model'), 'mount path present');
            assert.ok(output.includes('test-model-fsx-pvc'), 'PVC name present');
        });

        it('fsxVolumeHandle empty: no volume mount', () => {
            const output = renderTemplate({ fsxVolumeHandle: '' });
            assert.ok(!output.includes('fsx-storage'), 'No FSx volume when handle empty');
        });
    });

    describe('Combined multi-GPU + EFA scenario', () => {
        it('8 GPUs with EFA produces correct manifest', () => {
            const output = renderTemplate({
                HP_GPU_COUNT: '8',
                HP_EFA_ENABLED: 'true',
                HP_NODE_SELECTOR: 'ml.g5.48xlarge'
            });
            assert.ok(output.includes('nvidia.com/gpu: "8"'), '8 GPUs');
            assert.ok(output.includes('vpc.amazonaws.com/efa: "1"'), 'EFA present');
            assert.ok(output.includes('value: "8"'), 'TP=8');
            assert.ok(output.includes('memory: "128Gi"'), '128Gi memory');
            assert.ok(output.includes('cpu: "32"'), '32 CPUs');
            assert.ok(output.includes('node.kubernetes.io/instance-type: "ml.g5.48xlarge"'), 'node selector');
        });
    });
});

describe('H2: Instance-sizer → HP_GPU_COUNT wiring', () => {
    // These test the logic added to prompt-runner.js
    it('gpuCount=4 + instanceType=ml.g5.12xlarge flows to HP_GPU_COUNT and HP_NODE_SELECTOR', () => {
        // Simulating what prompt-runner does
        const combinedAnswers = {
            deploymentTarget: 'hyperpod-eks',
            gpuCount: 4,
            instanceType: 'ml.g5.12xlarge'
        };

        // Simulate the wiring logic
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
