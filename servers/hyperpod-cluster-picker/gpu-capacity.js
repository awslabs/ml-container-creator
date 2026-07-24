// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GPU Capacity Utilities for HyperPod Cluster Picker
 *
 * Provides GPU-per-instance lookup, total/allocated capacity calculation,
 * model-aware VRAM recommendation, and Kueue/PriorityClass detection.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// ── GPU-per-instance catalog ────────────────────────────────────────────────

/**
 * Static GPU count mapping for HyperPod-eligible instance types.
 * Used as a fast lookup before falling back to instances.json catalog.
 */
const GPU_PER_INSTANCE = {
    'ml.g5.xlarge': 1,
    'ml.g5.2xlarge': 1,
    'ml.g5.4xlarge': 1,
    'ml.g5.8xlarge': 1,
    'ml.g5.12xlarge': 4,
    'ml.g5.16xlarge': 1,
    'ml.g5.24xlarge': 4,
    'ml.g5.48xlarge': 8,
    'ml.g6.xlarge': 1,
    'ml.g6.2xlarge': 1,
    'ml.g6.4xlarge': 1,
    'ml.g6.12xlarge': 4,
    'ml.g6.48xlarge': 8,
    'ml.g6e.xlarge': 1,
    'ml.g6e.2xlarge': 1,
    'ml.g6e.4xlarge': 1,
    'ml.g6e.12xlarge': 4,
    'ml.g6e.48xlarge': 8,
    'ml.p4d.24xlarge': 8,
    'ml.p4de.24xlarge': 8,
    'ml.p5.48xlarge': 8
};

/**
 * GPU VRAM per GPU for each instance family (in GB).
 */
const GPU_VRAM_GB = {
    'ml.g5.xlarge': 24,
    'ml.g5.2xlarge': 24,
    'ml.g5.4xlarge': 24,
    'ml.g5.8xlarge': 24,
    'ml.g5.12xlarge': 24,
    'ml.g5.16xlarge': 24,
    'ml.g5.24xlarge': 24,
    'ml.g5.48xlarge': 24,
    'ml.g6.xlarge': 24,
    'ml.g6.2xlarge': 24,
    'ml.g6.4xlarge': 24,
    'ml.g6.12xlarge': 24,
    'ml.g6.48xlarge': 24,
    'ml.g6e.xlarge': 48,
    'ml.g6e.2xlarge': 48,
    'ml.g6e.4xlarge': 48,
    'ml.g6e.12xlarge': 48,
    'ml.g6e.48xlarge': 48,
    'ml.p4d.24xlarge': 40,
    'ml.p4de.24xlarge': 80,
    'ml.p5.48xlarge': 80
};

/**
 * Static cost tier ordering (lower = cheaper).
 */
const COST_TIER = {
    'ml.g5.xlarge': 1,
    'ml.g5.2xlarge': 2,
    'ml.g5.4xlarge': 3,
    'ml.g5.8xlarge': 4,
    'ml.g5.12xlarge': 5,
    'ml.g5.16xlarge': 4,
    'ml.g5.24xlarge': 6,
    'ml.g5.48xlarge': 7,
    'ml.g6.xlarge': 1,
    'ml.g6.2xlarge': 2,
    'ml.g6.4xlarge': 3,
    'ml.g6.12xlarge': 5,
    'ml.g6.48xlarge': 7,
    'ml.g6e.xlarge': 2,
    'ml.g6e.2xlarge': 3,
    'ml.g6e.4xlarge': 4,
    'ml.g6e.12xlarge': 6,
    'ml.g6e.48xlarge': 8,
    'ml.p4d.24xlarge': 9,
    'ml.p4de.24xlarge': 10,
    'ml.p5.48xlarge': 11
};

/**
 * Get GPU count for an instance type.
 * @param {string} instanceType - e.g. 'ml.g5.12xlarge'
 * @returns {number|null} GPU count, or null if unknown
 */
export function getGpuCount(instanceType) {
    if (GPU_PER_INSTANCE[instanceType] !== undefined) {
        return GPU_PER_INSTANCE[instanceType];
    }
    // Fallback: try instances.json catalog
    try {
        const catalogPath = resolve(__dirname, '..', 'lib', 'catalogs', 'instances.json');
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
        const entry = catalog?.catalog?.[instanceType];
        if (entry?.gpus !== undefined) return entry.gpus;
    } catch {
        // catalog not available
    }
    return null;
}

/**
 * Get total GPU VRAM for an instance type (all GPUs combined).
 * @param {string} instanceType
 * @returns {number|null} Total VRAM in GB, or null if unknown
 */
export function getTotalVramGb(instanceType) {
    const gpuCount = getGpuCount(instanceType);
    const vramPerGpu = GPU_VRAM_GB[instanceType];
    if (gpuCount === null || vramPerGpu === undefined) return null;
    return gpuCount * vramPerGpu;
}

/**
 * Calculate total GPU capacity for an instance group.
 * @param {number} instanceCount
 * @param {string} instanceType
 * @returns {number|null}
 */
export function calculateTotalGpus(instanceCount, instanceType) {
    const gpusPerInstance = getGpuCount(instanceType);
    if (gpusPerInstance === null) return null;
    return instanceCount * gpusPerInstance;
}

// ── Allocated GPU detection via kubectl ─────────────────────────────────────

/**
 * Get allocated GPU count from running pods via kubectl.
 * @param {object} [options] - { timeout: number (ms), execFn: function }
 * @returns {{ allocated: number|null, error: string|null }}
 */
export function getAllocatedGpus(options = {}) {
    const { timeout = 5000, execFn = null } = options;
    try {
        const exec = execFn || ((cmd) => execSync(cmd, { timeout, encoding: 'utf-8' }));
        const output = exec('kubectl get pods --all-namespaces -o json');
        const data = JSON.parse(output);
        let totalAllocated = 0;
        for (const pod of (data.items || [])) {
            if (pod.status?.phase !== 'Running' && pod.status?.phase !== 'Pending') continue;
            for (const container of (pod.spec?.containers || [])) {
                const gpuReq = container.resources?.requests?.['nvidia.com/gpu'];
                if (gpuReq) {
                    totalAllocated += parseInt(gpuReq, 10) || 0;
                }
            }
        }
        return { allocated: totalAllocated, error: null };
    } catch (err) {
        return { allocated: null, error: err.message || 'kubectl failed' };
    }
}

// ── Model-aware VRAM recommendation ─────────────────────────────────────────

/**
 * Compute VRAM requirement for a model.
 * Formula: params_in_billions * bytes_per_param * overhead_factor
 * @param {number} modelParamsBillions - e.g. 7 for 7B
 * @param {string} [quantization='fp16'] - 'fp16', 'bf16', 'int8', 'fp8', 'int4'
 * @returns {number} VRAM in GB
 */
export function computeVramGb(modelParamsBillions, quantization = 'fp16') {
    const overheadFactor = 1.2; // KV cache + activations overhead
    let bytesPerParam;
    switch (quantization) {
    case 'int4':
        bytesPerParam = 0.5;
        break;
    case 'int8':
    case 'fp8':
        bytesPerParam = 1.0;
        break;
    case 'fp16':
    case 'bf16':
    default:
        bytesPerParam = 2.0;
        break;
    }
    return modelParamsBillions * bytesPerParam * overheadFactor;
}

/**
 * Recommend the best node group for a model.
 * @param {Array} instanceGroups - [{ name, instanceType, count }]
 * @param {number} vramGb - Required VRAM in GB
 * @returns {{ fits: boolean, instanceType?: string, gpuCount?: number, nodeGroupName?: string, reason?: string, suggestion?: string }}
 */
export function recommendNodeGroup(instanceGroups, vramGb) {
    if (!instanceGroups || instanceGroups.length === 0) {
        return { fits: false, suggestion: 'No instance groups available. Add a GPU node group via UpdateCluster.' };
    }

    // Filter to groups with enough total VRAM per node
    const candidates = instanceGroups
        .map(g => {
            const totalVram = getTotalVramGb(g.instanceType);
            const gpuCount = getGpuCount(g.instanceType);
            return {
                ...g,
                totalVram,
                gpuCount,
                costTier: COST_TIER[g.instanceType] || 99
            };
        })
        .filter(g => g.totalVram !== null && g.totalVram >= vramGb);

    if (candidates.length === 0) {
        return {
            fits: false,
            suggestion: 'Scale up or add a larger node group via UpdateCluster'
        };
    }

    // Sort by cost tier ascending (cheapest first)
    candidates.sort((a, b) => a.costTier - b.costTier);
    const best = candidates[0];

    return {
        fits: true,
        instanceType: best.instanceType,
        gpuCount: best.gpuCount,
        nodeGroupName: best.name,
        reason: `${best.instanceType} provides ${best.totalVram}GB VRAM (${best.gpuCount} GPUs) — sufficient for ${vramGb.toFixed(1)}GB requirement`
    };
}

/**
 * Look up model parameter count from models.json catalog.
 * @param {string} modelName
 * @returns {number|null} Parameter count in billions, or null
 */
export function lookupModelParams(modelName) {
    try {
        const catalogPath = resolve(__dirname, '..', 'lib', 'catalogs', 'models.json');
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
        const entry = catalog[modelName];
        if (entry?.parameterCount) {
            return entry.parameterCount / 1e9; // Convert to billions
        }
    } catch {
        // catalog not available
    }
    return null;
}

// ── Kueue / PriorityClass detection ─────────────────────────────────────────

/**
 * Detect Kueue ClusterQueues on the cluster.
 * @param {object} [options] - { timeout: number (ms), execFn: function }
 * @returns {{ queues: Array<{ name: string, availableGpuQuota: number|null }>, error: string|null }}
 */
export function detectKueueQueues(options = {}) {
    const { timeout = 5000, execFn = null } = options;
    try {
        const exec = execFn || ((cmd) => execSync(cmd, { timeout, encoding: 'utf-8' }));
        const output = exec('kubectl get clusterqueues -o json');
        const data = JSON.parse(output);
        const queues = (data.items || []).map(item => {
            let availableGpuQuota = null;
            const resourceGroups = item.spec?.resourceGroups || [];
            for (const rg of resourceGroups) {
                for (const flavor of (rg.flavors || [])) {
                    for (const resource of (flavor.resources || [])) {
                        if (resource.name === 'nvidia.com/gpu') {
                            availableGpuQuota = (availableGpuQuota || 0) + (parseInt(resource.nominalQuota, 10) || 0);
                        }
                    }
                }
            }
            return { name: item.metadata?.name || 'unknown', availableGpuQuota };
        });
        return { queues, error: null };
    } catch (err) {
        return { queues: [], error: err.message || 'Kueue not available' };
    }
}

/**
 * Detect PriorityClasses on the cluster (fallback when Kueue is not present).
 * @param {object} [options] - { timeout: number (ms), execFn: function }
 * @returns {{ priorityClasses: Array<{ name: string, value: number, description: string }>, error: string|null }}
 */
export function detectPriorityClasses(options = {}) {
    const { timeout = 5000, execFn = null } = options;
    try {
        const exec = execFn || ((cmd) => execSync(cmd, { timeout, encoding: 'utf-8' }));
        const output = exec('kubectl get priorityclasses -o json');
        const data = JSON.parse(output);
        const priorityClasses = (data.items || []).map(item => ({
            name: item.metadata?.name || 'unknown',
            value: item.value || 0,
            description: item.description || ''
        }));
        return { priorityClasses, error: null };
    } catch (err) {
        return { priorityClasses: [], error: err.message || 'PriorityClasses not available' };
    }
}
