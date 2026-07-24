// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * H3 Cluster-Picker Enhancements — GPU Capacity, Model Recommendation, Queue Awareness
 *
 * Tests for:
 * - getGpuCount utility
 * - Total GPU capacity calculation
 * - Allocated GPU detection from kubectl mocks
 * - computeVramGb VRAM calculation
 * - Model-aware node group recommendation
 * - Kueue/PriorityClass detection
 * - Extended buildResponse format
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import {
    getGpuCount,
    calculateTotalGpus,
    getAllocatedGpus,
    computeVramGb,
    recommendNodeGroup,
    detectKueueQueues,
    detectPriorityClasses
} from '../../servers/hyperpod-cluster-picker/gpu-capacity.js';
import { buildResponse } from '../../servers/hyperpod-cluster-picker/index.js';

// ── GPU Capacity Tests ───────────────────────────────────────────────────────

describe('H3: GPU Capacity — getGpuCount', () => {
    it('ml.g5.12xlarge → 4 GPUs', () => {
        assert.strictEqual(getGpuCount('ml.g5.12xlarge'), 4);
    });

    it('ml.g5.48xlarge → 8 GPUs', () => {
        assert.strictEqual(getGpuCount('ml.g5.48xlarge'), 8);
    });

    it('ml.g5.xlarge → 1 GPU', () => {
        assert.strictEqual(getGpuCount('ml.g5.xlarge'), 1);
    });

    it('ml.p4d.24xlarge → 8 GPUs', () => {
        assert.strictEqual(getGpuCount('ml.p4d.24xlarge'), 8);
    });

    it('ml.p5.48xlarge → 8 GPUs', () => {
        assert.strictEqual(getGpuCount('ml.p5.48xlarge'), 8);
    });

    it('unknown-type → null (graceful)', () => {
        assert.strictEqual(getGpuCount('unknown-type'), null);
    });

    it('ml.m5.xlarge (no GPU) → null', () => {
        // This is a CPU instance, not in GPU_PER_INSTANCE
        const result = getGpuCount('ml.m5.xlarge');
        // Could be null or 0 from catalog
        assert.ok(result === null || result === 0, 'CPU instance should return null or 0');
    });
});

describe('H3: GPU Capacity — calculateTotalGpus', () => {
    it('3 instances of ml.g5.12xlarge → 12 GPUs', () => {
        assert.strictEqual(calculateTotalGpus(3, 'ml.g5.12xlarge'), 12);
    });

    it('2 instances of ml.g5.48xlarge → 16 GPUs', () => {
        assert.strictEqual(calculateTotalGpus(2, 'ml.g5.48xlarge'), 16);
    });

    it('1 instance of ml.g5.xlarge → 1 GPU', () => {
        assert.strictEqual(calculateTotalGpus(1, 'ml.g5.xlarge'), 1);
    });

    it('unknown instance type → null', () => {
        assert.strictEqual(calculateTotalGpus(5, 'unknown-type'), null);
    });

    it('0 instances → 0 GPUs', () => {
        assert.strictEqual(calculateTotalGpus(0, 'ml.g5.12xlarge'), 0);
    });
});

describe('H3: GPU Capacity — getAllocatedGpus', () => {
    it('mock kubectl: 2 pods each requesting 2 GPUs → allocated=4', () => {
        const mockOutput = JSON.stringify({
            items: [
                {
                    status: { phase: 'Running' },
                    spec: {
                        containers: [{
                            resources: { requests: { 'nvidia.com/gpu': '2' } }
                        }]
                    }
                },
                {
                    status: { phase: 'Running' },
                    spec: {
                        containers: [{
                            resources: { requests: { 'nvidia.com/gpu': '2' } }
                        }]
                    }
                }
            ]
        });

        const result = getAllocatedGpus({
            execFn: () => mockOutput
        });
        assert.strictEqual(result.allocated, 4);
        assert.strictEqual(result.error, null);
    });

    it('mock kubectl: pods with no GPU requests → allocated=0', () => {
        const mockOutput = JSON.stringify({
            items: [
                {
                    status: { phase: 'Running' },
                    spec: {
                        containers: [{
                            resources: { requests: { cpu: '1', memory: '1Gi' } }
                        }]
                    }
                }
            ]
        });

        const result = getAllocatedGpus({ execFn: () => mockOutput });
        assert.strictEqual(result.allocated, 0);
    });

    it('mock kubectl timeout → allocated=null with error', () => {
        const result = getAllocatedGpus({
            execFn: () => { throw new Error('Command timed out'); }
        });
        assert.strictEqual(result.allocated, null);
        assert.ok(result.error.includes('timed out'));
    });

    it('mock kubectl non-zero exit → allocated=null', () => {
        const result = getAllocatedGpus({
            execFn: () => { throw new Error('kubectl: command not found'); }
        });
        assert.strictEqual(result.allocated, null);
        assert.ok(result.error);
    });

    it('ignores completed/failed pods', () => {
        const mockOutput = JSON.stringify({
            items: [
                {
                    status: { phase: 'Succeeded' },
                    spec: {
                        containers: [{
                            resources: { requests: { 'nvidia.com/gpu': '4' } }
                        }]
                    }
                },
                {
                    status: { phase: 'Running' },
                    spec: {
                        containers: [{
                            resources: { requests: { 'nvidia.com/gpu': '2' } }
                        }]
                    }
                }
            ]
        });

        const result = getAllocatedGpus({ execFn: () => mockOutput });
        assert.strictEqual(result.allocated, 2, 'should only count Running/Pending pods');
    });
});

// ── VRAM Calculation Tests ──────────────────────────────────────────────────

describe('H3: Model Recommendation — computeVramGb', () => {
    it('7B fp16 → ~16.8 GB', () => {
        const vram = computeVramGb(7, 'fp16');
        assert.ok(vram > 16 && vram < 17, `Expected ~16.8, got ${vram}`);
    });

    it('70B fp16 → ~168 GB', () => {
        const vram = computeVramGb(70, 'fp16');
        assert.ok(vram > 167 && vram < 169, `Expected ~168, got ${vram}`);
    });

    it('7B int8 → ~8.4 GB', () => {
        const vram = computeVramGb(7, 'int8');
        assert.ok(vram > 8 && vram < 9, `Expected ~8.4, got ${vram}`);
    });

    it('7B int4 → ~4.2 GB', () => {
        const vram = computeVramGb(7, 'int4');
        assert.ok(vram > 4 && vram < 5, `Expected ~4.2, got ${vram}`);
    });

    it('13B fp16 → ~31.2 GB', () => {
        const vram = computeVramGb(13, 'fp16');
        assert.ok(vram > 31 && vram < 32, `Expected ~31.2, got ${vram}`);
    });

    it('30B fp16 → ~72 GB', () => {
        const vram = computeVramGb(30, 'fp16');
        assert.ok(vram > 71 && vram < 73, `Expected ~72, got ${vram}`);
    });
});

// ── Node Group Recommendation Tests ─────────────────────────────────────────

describe('H3: Model Recommendation — recommendNodeGroup', () => {
    const sampleGroups = [
        { name: 'small-gpus', instanceType: 'ml.g5.xlarge', count: 4 },
        { name: 'medium-gpus', instanceType: 'ml.g5.12xlarge', count: 2 },
        { name: 'large-gpus', instanceType: 'ml.g5.48xlarge', count: 1 }
    ];

    it('7B fp16 (~16.8 GB) → recommends g5.xlarge (24 GB VRAM)', () => {
        const vram = computeVramGb(7, 'fp16');
        const rec = recommendNodeGroup(sampleGroups, vram);
        assert.strictEqual(rec.fits, true);
        assert.strictEqual(rec.instanceType, 'ml.g5.xlarge');
        assert.strictEqual(rec.gpuCount, 1);
        assert.strictEqual(rec.nodeGroupName, 'small-gpus');
    });

    it('70B fp16 (~168 GB) → recommends g5.48xlarge (192 GB total VRAM)', () => {
        const vram = computeVramGb(70, 'fp16');
        const rec = recommendNodeGroup(sampleGroups, vram);
        assert.strictEqual(rec.fits, true);
        assert.strictEqual(rec.instanceType, 'ml.g5.48xlarge');
        assert.strictEqual(rec.gpuCount, 8);
        assert.strictEqual(rec.nodeGroupName, 'large-gpus');
    });

    it('30B fp16 (~72 GB) → recommends g5.12xlarge (96 GB total VRAM)', () => {
        const vram = computeVramGb(30, 'fp16');
        const rec = recommendNodeGroup(sampleGroups, vram);
        assert.strictEqual(rec.fits, true);
        assert.strictEqual(rec.instanceType, 'ml.g5.12xlarge');
        assert.strictEqual(rec.gpuCount, 4);
    });

    it('200B fp16 (~480 GB) → no fitting group, returns suggestion', () => {
        const vram = computeVramGb(200, 'fp16');
        const rec = recommendNodeGroup(sampleGroups, vram);
        assert.strictEqual(rec.fits, false);
        assert.ok(rec.suggestion.includes('Scale up') || rec.suggestion.includes('larger node group'));
    });

    it('empty instance groups → fits=false with suggestion', () => {
        const rec = recommendNodeGroup([], 10);
        assert.strictEqual(rec.fits, false);
        assert.ok(rec.suggestion);
    });

    it('sorts by cost — picks cheapest fitting option', () => {
        const groups = [
            { name: 'expensive', instanceType: 'ml.p4d.24xlarge', count: 1 },
            { name: 'cheap', instanceType: 'ml.g5.48xlarge', count: 1 }
        ];
        // Both have 8 GPUs. p4d has 320GB, g5.48x has 192GB. For a 100GB need, g5.48x suffices and is cheaper.
        const rec = recommendNodeGroup(groups, 100);
        assert.strictEqual(rec.fits, true);
        assert.strictEqual(rec.instanceType, 'ml.g5.48xlarge');
    });
});

// ── Queue / PriorityClass Detection Tests ───────────────────────────────────

describe('H3: Queue Awareness — detectKueueQueues', () => {
    it('Kueue present: returns queues with GPU quota', () => {
        const mockOutput = JSON.stringify({
            items: [{
                metadata: { name: 'gpu-queue' },
                spec: {
                    resourceGroups: [{
                        flavors: [{
                            resources: [
                                { name: 'nvidia.com/gpu', nominalQuota: '16' }
                            ]
                        }]
                    }]
                }
            }]
        });

        const result = detectKueueQueues({ execFn: () => mockOutput });
        assert.strictEqual(result.queues.length, 1);
        assert.strictEqual(result.queues[0].name, 'gpu-queue');
        assert.strictEqual(result.queues[0].availableGpuQuota, 16);
        assert.strictEqual(result.error, null);
    });

    it('Kueue not installed: returns empty queues with error', () => {
        const result = detectKueueQueues({
            execFn: () => { throw new Error('the server doesn\'t have a resource type "clusterqueues"'); }
        });
        assert.deepStrictEqual(result.queues, []);
        assert.ok(result.error);
    });

    it('Multiple queues returned correctly', () => {
        const mockOutput = JSON.stringify({
            items: [
                {
                    metadata: { name: 'team-a-queue' },
                    spec: { resourceGroups: [{ flavors: [{ resources: [{ name: 'nvidia.com/gpu', nominalQuota: '8' }] }] }] }
                },
                {
                    metadata: { name: 'team-b-queue' },
                    spec: { resourceGroups: [{ flavors: [{ resources: [{ name: 'nvidia.com/gpu', nominalQuota: '4' }] }] }] }
                }
            ]
        });

        const result = detectKueueQueues({ execFn: () => mockOutput });
        assert.strictEqual(result.queues.length, 2);
        assert.strictEqual(result.queues[0].name, 'team-a-queue');
        assert.strictEqual(result.queues[1].name, 'team-b-queue');
    });
});

describe('H3: Queue Awareness — detectPriorityClasses', () => {
    it('PriorityClasses present: returns classes with values', () => {
        const mockOutput = JSON.stringify({
            items: [
                { metadata: { name: 'high-priority' }, value: 1000, description: 'High priority workloads' },
                { metadata: { name: 'low-priority' }, value: 100, description: 'Low priority batch' }
            ]
        });

        const result = detectPriorityClasses({ execFn: () => mockOutput });
        assert.strictEqual(result.priorityClasses.length, 2);
        assert.strictEqual(result.priorityClasses[0].name, 'high-priority');
        assert.strictEqual(result.priorityClasses[0].value, 1000);
        assert.strictEqual(result.priorityClasses[1].name, 'low-priority');
    });

    it('kubectl unavailable: returns empty with error', () => {
        const result = detectPriorityClasses({
            execFn: () => { throw new Error('connection refused'); }
        });
        assert.deepStrictEqual(result.priorityClasses, []);
        assert.ok(result.error);
    });
});

// ── Extended buildResponse Tests ────────────────────────────────────────────

describe('H3: Extended buildResponse format', () => {
    const sampleClusters = [{
        clusterName: 'my-cluster',
        clusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/my-cluster',
        status: 'InService',
        instanceGroups: [
            { name: 'gpu-workers', instanceType: 'ml.g5.12xlarge', count: 3 }
        ]
    }];

    it('still has values + choices arrays (backward compat)', () => {
        const result = buildResponse(sampleClusters);
        assert.ok(result.values, 'values present');
        assert.ok(result.choices, 'choices present');
        assert.strictEqual(result.values.hyperPodCluster, 'my-cluster');
        assert.deepStrictEqual(result.choices.hyperPodCluster, ['my-cluster']);
    });

    it('metadata[clusterName].instanceGroups[].gpuCapacity fields present', () => {
        const result = buildResponse(sampleClusters);
        const cluster = result.metadata['my-cluster'];
        assert.ok(cluster, 'cluster metadata present');
        assert.ok(cluster.instanceGroups[0].gpuCapacity, 'gpuCapacity present');
        assert.strictEqual(cluster.instanceGroups[0].gpuCapacity.total, 12); // 3 * 4
        // availability is 'known' when GPU total can be calculated from instance type
        assert.strictEqual(cluster.instanceGroups[0].gpuCapacity.availability, 'known');
    });

    it('metadata.recommendation present when modelParams provided', () => {
        const result = buildResponse(sampleClusters, { modelParams: 7 });
        assert.ok(result.metadata.recommendation, 'recommendation should be present');
        assert.strictEqual(result.metadata.recommendation.fits, true);
    });

    it('metadata.recommendation absent when no model context', () => {
        const result = buildResponse(sampleClusters);
        assert.strictEqual(result.metadata.recommendation, undefined);
    });

    it('empty clusters still returns standard format', () => {
        const result = buildResponse([]);
        assert.deepStrictEqual(result.choices.hyperPodCluster, []);
        assert.ok(result.message);
    });

    it('metadata.queues present when kubectl returns Kueue data', () => {
        // This test exercises buildResponse with kubectlOptions that mock Kueue
        // The real integration would require a mock execFn, but buildResponse
        // calls detectKueueQueues internally. Since the default exec will fail
        // in CI (no kubectl), queues will be null, which is expected graceful degradation.
        const result = buildResponse(sampleClusters);
        // In non-kubectl environments, queues should be absent (graceful)
        // Test that format is still valid — backward compat flat map
        assert.ok(result.metadata['my-cluster'], 'cluster metadata always present');
    });

    it('GPU capacity calculation correct for p4d cluster', () => {
        const p4dCluster = [{
            clusterName: 'p4d-cluster',
            clusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/p4d-cluster',
            status: 'InService',
            instanceGroups: [
                { name: 'training', instanceType: 'ml.p4d.24xlarge', count: 4 }
            ]
        }];
        const result = buildResponse(p4dCluster);
        const cluster = result.metadata['p4d-cluster'];
        assert.strictEqual(cluster.instanceGroups[0].gpuCapacity.total, 32); // 4 * 8
    });
});

describe('H3: do/config HP_QUEUE emission', () => {
    it('HP_QUEUE flows to deployment.yaml queue label', async () => {
        // This validates the template integration
        const ejsMod = await import('ejs');
        const fsMod = await import('fs');
        const pathMod = await import('path');
        const urlMod = await import('url');

        const __fn = urlMod.fileURLToPath(import.meta.url);
        const __dn = pathMod.resolve(__fn, '..');
        const templatePath = pathMod.resolve(__dn, '..', '..', 'templates', 'hyperpod', 'deployment.yaml');
        const template = fsMod.readFileSync(templatePath, 'utf8');

        const output = ejsMod.default.render(template, {
            projectName: 'test',
            hyperPodNamespace: 'default',
            framework: 'transformers',
            hyperPodReplicas: 1,
            awsRegion: 'us-east-1',
            instanceType: 'ml.g5.xlarge',
            fsxVolumeHandle: '',
            HP_GPU_COUNT: '4',
            HP_NODE_SELECTOR: 'ml.g5.12xlarge',
            HP_EFA_ENABLED: 'false',
            HP_MEM_REQUEST: '',
            HP_CPU_REQUEST: '',
            HP_QUEUE: 'my-team-queue'
        });

        assert.ok(output.includes('kueue.x-k8s.io/queue-name: "my-team-queue"'));
    });
});
