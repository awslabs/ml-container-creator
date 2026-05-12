// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance Filter & Ranker
 *
 * Filters and ranks SageMaker instances by compatibility with a model's
 * VRAM requirement. Considers tensor parallelism for multi-GPU instances
 * and applies cost-efficiency ranking within each TP tier.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * GPU memory per chip (in GB) by hardware type.
 * Used when the catalog doesn't have a direct gpuMemoryGb field.
 */
const GPU_MEMORY_MAP = {
    'NVIDIA T4': 16,
    'NVIDIA A10G': 24,
    'NVIDIA V100': 16,
    'NVIDIA L4': 24,
    'NVIDIA A100': 40,
    'NVIDIA H100': 80,
    'AWS Inferentia2': 32,
    'AWS Trainium': 32
}

/**
 * Cost tier classification by instance family.
 */
const COST_TIER_MAP = {
    'g4dn': 'low',
    'inf2': 'low',
    'g5': 'medium',
    'g6': 'medium',
    'trn1': 'medium',
    'p3': 'high',
    'p4d': 'high',
    'p4de': 'high',
    'p5': 'high'
}

/**
 * Relative cost weight by tier for sorting within TP groups.
 * Lower is better (more cost-efficient).
 */
const COST_TIER_WEIGHT = {
    'low': 1,
    'medium': 2,
    'high': 3
}

/**
 * Generation weight by instance family.
 * Lower is newer (sorted first). Newer generations offer better perf/$.
 */
const GENERATION_WEIGHT = {
    'g6': 1,
    'p5': 1,
    'trn1': 2,
    'inf2': 2,
    'g5': 3,
    'p4de': 4,
    'p4d': 4,
    'p3': 5,
    'g4dn': 6
}

/**
 * TP overhead penalty: 10% per additional GPU beyond the first.
 * Effective VRAM = totalVram × (1 - 0.10 × (gpuCount - 1))
 */
const TP_OVERHEAD_PER_GPU = 0.10

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Extract per-GPU memory in GB from an instance catalog entry.
 *
 * Tries these approaches in order:
 * 1. Direct gpuMemoryGb field (if catalog has been extended)
 * 2. Parse from accelerator string (e.g., "4x A10G 96GB" → 24 per GPU)
 * 3. Lookup by hardware type from GPU_MEMORY_MAP
 *
 * @param {object} instance - Instance catalog entry
 * @returns {number|null} Per-GPU memory in GB, or null if not determinable
 */
const getPerGpuMemoryGb = (instance) => {
    // 1. Direct field
    if (instance.gpuMemoryGb) {
        return instance.gpuMemoryGb
    }

    // 2. Parse from accelerator string
    if (instance.accelerator) {
        // Match patterns like "A10G 24GB", "4x A10G 96GB", "T4 16GB"
        const totalMatch = instance.accelerator.match(/(\d+)GB/)
        if (totalMatch) {
            const totalGb = parseInt(totalMatch[1], 10)
            const gpuCount = instance.gpus || 1
            // If the string has a multiplier prefix like "4x", the GB is total
            const hasMultiplier = instance.accelerator.match(/^(\d+)x\s/)
            if (hasMultiplier) {
                return totalGb / gpuCount
            }
            // Single GPU entry — the GB value is per-GPU
            return totalGb
        }
    }

    // 3. Lookup by hardware type
    if (instance.hardware && GPU_MEMORY_MAP[instance.hardware]) {
        return GPU_MEMORY_MAP[instance.hardware]
    }

    return null
}

/**
 * Determine cost tier for an instance based on its family.
 *
 * @param {object} instance - Instance catalog entry
 * @returns {string} 'low', 'medium', or 'high'
 */
const getCostTier = (instance) => {
    if (instance.costTier) {
        return instance.costTier
    }
    const family = instance.family || ''
    return COST_TIER_MAP[family] || 'medium'
}

/**
 * Calculate effective VRAM available after TP overhead penalty.
 *
 * Each additional GPU beyond the first loses 10% of its per-GPU capacity
 * to communication overhead. The first GPU contributes its full capacity.
 *
 * Formula: perGpuMemory + (gpuCount - 1) × perGpuMemory × (1 - TP_OVERHEAD_PER_GPU)
 * Simplified: perGpuMemory × (1 + (gpuCount - 1) × 0.9)
 * Or equivalently: totalVram - perGpuMemory × 0.10 × (gpuCount - 1)
 *
 * @param {number} totalVramGb - Total GPU VRAM in GB
 * @param {number} gpuCount - Number of GPUs (TP degree)
 * @returns {number} Effective usable VRAM in GB
 */
const effectiveVram = (totalVramGb, gpuCount) => {
    if (gpuCount <= 1) return totalVramGb
    const perGpuMemory = totalVramGb / gpuCount
    const overhead = perGpuMemory * TP_OVERHEAD_PER_GPU * (gpuCount - 1)
    return totalVramGb - overhead
}

// ── Main Function ────────────────────────────────────────────────────────────

/**
 * Filter and rank instances by compatibility with VRAM requirement.
 *
 * @param {number} vramRequired - Required VRAM in GB
 * @param {object} instanceCatalog - Object keyed by instance type, values are metadata
 * @param {object} [options={}]
 * @param {number} [options.limit=10] - Max results to return
 * @param {boolean} [options.allowTensorParallelism=true] - Consider multi-GPU splits
 * @returns {object[]} Ranked list of compatible instances
 */
const filterAndRankInstances = (vramRequired, instanceCatalog, options = {}) => {
    const { limit = 10, allowTensorParallelism = true } = options

    if (!vramRequired || vramRequired <= 0) {
        return []
    }

    if (!instanceCatalog || typeof instanceCatalog !== 'object') {
        return []
    }

    const candidates = []

    for (const [instanceType, meta] of Object.entries(instanceCatalog)) {
        // Skip non-GPU instances
        if (!meta.gpus || meta.gpus <= 0) continue
        if (meta.category !== 'gpu') continue

        const perGpuMemory = getPerGpuMemoryGb(meta)
        if (!perGpuMemory) continue

        const gpuCount = meta.gpus
        const totalVramGb = perGpuMemory * gpuCount

        // Determine if model fits on a single GPU
        if (gpuCount === 1) {
            if (perGpuMemory >= vramRequired) {
                const utilizationPercent = Math.round((vramRequired / perGpuMemory) * 100)
                candidates.push({
                    instanceType,
                    gpuCount,
                    totalVramGb,
                    utilizationPercent,
                    tensorParallelism: 1,
                    costTier: getCostTier(meta),
                    family: meta.family || ''
                })
            }
        } else if (allowTensorParallelism) {
            // Multi-GPU: check if model fits with TP across all GPUs
            const effectiveTotal = effectiveVram(totalVramGb, gpuCount)
            if (effectiveTotal >= vramRequired) {
                const utilizationPercent = Math.round((vramRequired / effectiveTotal) * 100)
                candidates.push({
                    instanceType,
                    gpuCount,
                    totalVramGb,
                    utilizationPercent,
                    tensorParallelism: gpuCount,
                    costTier: getCostTier(meta),
                    family: meta.family || ''
                })
            }
        }
    }

    // Sort candidates by ranking criteria:
    // 1. Single-GPU first (TP=1), then multi-GPU by lowest TP degree
    // 2. Within each TP tier, newest generation first (g6 > g5 > g4dn)
    // 3. Within same generation, sort by cost tier (lower is better)
    // 4. Within same cost tier, prefer lower total VRAM (right-sized)
    candidates.sort((a, b) => {
        // Primary: TP degree (lower is better)
        if (a.tensorParallelism !== b.tensorParallelism) {
            return a.tensorParallelism - b.tensorParallelism
        }

        // Secondary: generation (newer is better — lower weight)
        const genA = GENERATION_WEIGHT[a.family] || 4
        const genB = GENERATION_WEIGHT[b.family] || 4
        if (genA !== genB) {
            return genA - genB
        }

        // Tertiary: cost tier (lower is better)
        const costA = COST_TIER_WEIGHT[a.costTier] || 2
        const costB = COST_TIER_WEIGHT[b.costTier] || 2
        if (costA !== costB) {
            return costA - costB
        }

        // Quaternary: prefer lower total VRAM (right-sized, less waste)
        if (a.totalVramGb !== b.totalVramGb) {
            return a.totalVramGb - b.totalVramGb
        }

        // Final tiebreaker: instance type name for deterministic ordering
        return a.instanceType.localeCompare(b.instanceType)
    })

    return candidates.slice(0, limit)
}

export {
    filterAndRankInstances,
    getPerGpuMemoryGb,
    getCostTier,
    effectiveVram,
    GPU_MEMORY_MAP,
    COST_TIER_MAP,
    COST_TIER_WEIGHT,
    GENERATION_WEIGHT,
    TP_OVERHEAD_PER_GPU
}
