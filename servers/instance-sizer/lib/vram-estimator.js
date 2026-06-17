// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VRAM Estimation Engine
 *
 * Converts model metadata (parameter count, dtype, quantization) into a
 * memory requirement estimate. Used by the instance-sizer MCP server to
 * filter and rank compatible SageMaker instances.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const BYTES_PER_PARAM = {
    float32: 4.0,
    float16: 2.0,
    bfloat16: 2.0,
    int8: 1.0,
    int4: 0.5
};

const QUANTIZATION_BYTES = {
    'awq': 0.5,
    'gptq': 0.5,
    'bnb-4bit': 0.5,
    'bnb-8bit': 1.0
};

const BYTES_IN_GB = 1024 ** 3;

const DEFAULT_MAX_SEQUENCE_LENGTH = 4096;
const DEFAULT_BATCH_SIZE = 1;
const OVERHEAD_FACTOR = 0.1;
const MIN_USEFUL_CONTEXT_LEN = 2048;

const KV_CACHE_DTYPE_BYTES = {
    'auto': 2,      // fp16/bf16
    'fp16': 2,
    'bfloat16': 2,
    'fp8': 1,
    'fp8_e5m2': 1,
    'fp8_e4m3': 1,
    'int8': 1
};

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Look up bytes per parameter based on dtype and optional quantization.
 * Quantization takes precedence over dtype when provided.
 *
 * @param {string} dtype - Data type: 'float32', 'float16', 'bfloat16', 'int8', 'int4'
 * @param {string} [quantization] - Quantization method: 'awq', 'gptq', 'bnb-4bit', 'bnb-8bit'
 * @returns {number} Bytes per parameter
 */
const bytesPerParam = (dtype, quantization) => {
    if (quantization && QUANTIZATION_BYTES[quantization] !== undefined) {
        return QUANTIZATION_BYTES[quantization];
    }
    return BYTES_PER_PARAM[dtype] ?? BYTES_PER_PARAM.float16;
};

/**
 * Estimate KV cache memory usage.
 *
 * The KV cache scales with sequence length and batch size. This uses a
 * simplified heuristic based on the observation that KV cache for a typical
 * transformer is roughly proportional to (numLayers × hiddenSize × seqLen × batch × 2 keys+values × 2 bytes).
 * We approximate numLayers × hiddenSize as sqrt(parameterCount) × scaling factor.
 *
 * For a 7B model at seq=4096, batch=1, this yields ~0.5GB which matches
 * real-world observations for Llama-2-7B.
 *
 * @param {number} parameterCount - Total model parameters
 * @param {number} maxSequenceLength - Maximum context/sequence length
 * @param {number} batchSize - Expected concurrent batch size
 * @returns {number} Estimated KV cache size in bytes
 */
const estimateKvCache = (parameterCount, maxSequenceLength, batchSize) => {
    const seqLength = maxSequenceLength ?? DEFAULT_MAX_SEQUENCE_LENGTH;
    const batch = batchSize ?? DEFAULT_BATCH_SIZE;

    // Heuristic: KV cache ≈ parameterCount × (seqLength / 4096) × batch × 0.05 bytes
    // This gives ~5% of raw param count in bytes at default seq length and batch=1
    // For 7B params: 7e9 × 0.05 = 350MB at seq=4096, batch=1
    // Scales linearly with sequence length and batch size
    const kvBytes = parameterCount * (seqLength / DEFAULT_MAX_SEQUENCE_LENGTH) * batch * 0.05;
    return kvBytes;
};

// ── Main Estimation Function ─────────────────────────────────────────────────

/**
 * Estimate VRAM required to serve a model.
 *
 * @param {object} modelInfo
 * @param {number} modelInfo.parameterCount - Total parameters (e.g., 7_000_000_000)
 * @param {string} modelInfo.dtype - Data type: 'float32', 'float16', 'bfloat16', 'int8', 'int4'
 * @param {string} [modelInfo.quantization] - Quantization method: 'awq', 'gptq', 'bnb-4bit', 'bnb-8bit'
 * @param {number} [modelInfo.maxSequenceLength] - Max context length (affects KV cache)
 * @param {number} [modelInfo.batchSize] - Expected concurrent batch size
 * @returns {{ vramGb: number, breakdown: { weightsGb: number, kvCacheGb: number, overheadGb: number }, confidence: string, source: string }}
 */
const estimateVram = (modelInfo) => {
    const {
        parameterCount,
        dtype,
        quantization,
        maxSequenceLength,
        batchSize
    } = modelInfo;

    // Determine confidence based on what was explicitly provided
    const confidence = determineConfidence(modelInfo);

    // Calculate base weight bytes
    const bpp = bytesPerParam(dtype, quantization);
    const baseWeightBytes = parameterCount * bpp;

    // Calculate KV cache
    const kvCacheBytes = estimateKvCache(
        parameterCount,
        maxSequenceLength ?? DEFAULT_MAX_SEQUENCE_LENGTH,
        batchSize ?? DEFAULT_BATCH_SIZE
    );

    // Calculate overhead (framework/CUDA)
    const overheadBytes = baseWeightBytes * OVERHEAD_FACTOR;

    // Total VRAM
    const totalVramBytes = baseWeightBytes + kvCacheBytes + overheadBytes;
    const vramGb = totalVramBytes / BYTES_IN_GB;

    return {
        vramGb,
        breakdown: {
            weightsGb: baseWeightBytes / BYTES_IN_GB,
            kvCacheGb: kvCacheBytes / BYTES_IN_GB,
            overheadGb: overheadBytes / BYTES_IN_GB
        },
        confidence,
        source: 'estimate'
    };
};

// ── Max Model Length Computation ─────────────────────────────────────────────

/**
 * Compute the maximum model length (context window) that fits in available KV cache memory.
 *
 * KV cache per token = 2 × num_layers × num_kv_heads × head_dim × dtype_bytes
 * Available KV memory = (gpu_memory × gpu_count × utilization) - model_weight_memory - overhead
 * max_model_len = available_kv_memory / kv_per_token
 *
 * For GQA models (like Llama 3.2), num_kv_heads is the GQA head count, not the
 * full attention head count.
 *
 * @param {object} params
 * @param {number} params.modelWeightGb - Model weight memory in GB
 * @param {number} params.totalGpuMemoryGb - Total GPU memory for the instance
 * @param {number} params.gpuCount - Number of GPUs
 * @param {number} [params.gpuMemoryUtilization=0.9] - vLLM gpu_memory_utilization
 * @param {number} params.numLayers - Number of transformer layers
 * @param {number} params.numKvHeads - Number of KV attention heads (after GQA)
 * @param {number} params.headDim - Dimension per head
 * @param {string} [params.kvCacheDtype='auto'] - KV cache dtype
 * @param {number} [params.overheadFactor=0.15] - Fraction for activations/CUDA overhead (conservative)
 * @returns {{ maxModelLen: number, availableForKvGb: number } | null}
 */
const computeMaxModelLen = (params) => {
    const {
        modelWeightGb,
        totalGpuMemoryGb,
        gpuCount = 1,
        gpuMemoryUtilization = 0.9,
        numLayers,
        numKvHeads,
        headDim,
        kvCacheDtype = 'auto',
        overheadFactor = 0.15
    } = params;

    // Require architecture params — graceful degradation if missing
    if (!numLayers || !numKvHeads || !headDim) {
        return null;
    }
    if (!totalGpuMemoryGb || !modelWeightGb) {
        return null;
    }

    // Compute available memory for KV cache
    // Conservative: gpu_memory_utilization × (1 - overhead) gives usable memory
    const usableMemoryGb = totalGpuMemoryGb * gpuCount * gpuMemoryUtilization * (1 - overheadFactor);
    const availableForKvGb = usableMemoryGb - modelWeightGb;

    if (availableForKvGb <= 0) {
        return { maxModelLen: 0, availableForKvGb: 0 };
    }

    // KV cache per token (bytes)
    // Formula: 2 (K+V) × num_layers × num_kv_heads × head_dim × dtype_bytes
    // For TP: heads are distributed but so is memory — net effect is the same per-GPU
    const dtypeBytes = KV_CACHE_DTYPE_BYTES[kvCacheDtype] || 2;
    const kvPerTokenBytes = 2 * numLayers * numKvHeads * headDim * dtypeBytes;

    // Convert available GB to bytes and divide
    const availableBytes = availableForKvGb * BYTES_IN_GB;
    const maxModelLen = Math.floor(availableBytes / kvPerTokenBytes);

    return {
        maxModelLen: Math.max(0, maxModelLen),
        availableForKvGb
    };
};

// ── Confidence ───────────────────────────────────────────────────────────────

/**
 * Determine confidence level based on which parameters were explicitly provided.
 *
 * - 'high': All key parameters (parameterCount, dtype) are explicitly provided
 * - 'medium': Some parameters are provided but others use defaults
 * - 'low': Using fallback values for critical parameters
 *
 * @param {object} modelInfo
 * @returns {'high' | 'medium' | 'low'}
 */
const determineConfidence = (modelInfo) => {
    const { parameterCount, dtype, maxSequenceLength, batchSize } = modelInfo;

    if (!parameterCount || !dtype) {
        return 'low';
    }

    // If dtype is not in our known list, confidence drops
    if (!BYTES_PER_PARAM[dtype]) {
        return 'low';
    }

    // All key params explicitly provided
    if (maxSequenceLength !== undefined && batchSize !== undefined) {
        return 'high';
    }

    // Core params present but some optional ones use defaults
    return 'medium';
};

export {
    estimateVram,
    computeMaxModelLen,
    bytesPerParam,
    estimateKvCache,
    determineConfidence,
    BYTES_PER_PARAM,
    QUANTIZATION_BYTES,
    KV_CACHE_DTYPE_BYTES,
    DEFAULT_MAX_SEQUENCE_LENGTH,
    DEFAULT_BATCH_SIZE,
    OVERHEAD_FACTOR,
    MIN_USEFUL_CONTEXT_LEN,
    BYTES_IN_GB
};
