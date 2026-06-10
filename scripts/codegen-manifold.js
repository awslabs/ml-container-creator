#!/usr/bin/env node
/**
 * codegen-manifold.js — Generates docs/data/coverage-manifold.json
 *
 * Reads an Athena export (CSV/JSON) or generates synthetic sample data,
 * encodes categorical dimensions as integers, computes PCA projection (2 components),
 * and outputs a static JSON file for the Coverage Manifold visualization.
 *
 * Usage:
 *   node scripts/codegen-manifold.js --input athena-export.csv --output docs/data/coverage-manifold.json
 *   node scripts/codegen-manifold.js --sample --output docs/data/coverage-manifold.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- CLI Argument Parsing ---

function parseArgs(argv) {
    const args = { input: null, output: null, sample: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--input' && argv[i + 1]) {
            args.input = argv[++i];
        } else if (argv[i] === '--output' && argv[i + 1]) {
            args.output = argv[++i];
        } else if (argv[i] === '--sample') {
            args.sample = true;
        } else if (argv[i] === '--help' || argv[i] === '-h') {
            console.log(`Usage:
  node scripts/codegen-manifold.js --input <csv-or-json> --output <path>
  node scripts/codegen-manifold.js --sample --output <path>

Options:
  --input <file>   Path to Athena export (CSV or JSON)
  --sample         Generate synthetic sample data for development
  --output <path>  Output path (default: docs/data/coverage-manifold.json)
  --help           Show this help`);
            process.exit(0);
        }
    }
    if (!args.output) {
        args.output = path.join(ROOT, 'docs', 'data', 'coverage-manifold.json');
    }
    if (!args.sample && !args.input) {
        console.error('❌ Must specify --input <file> or --sample');
        process.exit(1);
    }
    return args;
}

// --- Encoding Maps (categorical → integer) ---

const ENCODING_MAPS = {
    deployment_config: {
        'http-flask': 0,
        'http-fastapi': 1,
        'transformers-vllm': 2,
        'transformers-sglang': 3,
        'transformers-tensorrt-llm': 4,
        'transformers-lmi': 5,
        'transformers-djl': 6,
        'triton-fil': 7,
        'triton-onnxruntime': 8,
        'triton-tensorflow': 9,
        'triton-pytorch': 10,
        'triton-vllm': 11,
        'triton-tensorrtllm': 12,
        'triton-python': 13,
        'diffusors-vllm-omni': 14,
        'marketplace': 15
    },
    model_family: {
        'qwen3': 0,
        'qwen2.5': 1,
        'llama3': 2,
        'deepseek-r1': 3,
        'mistral': 4,
        'gemma2': 5,
        'phi3': 6,
        'gpt-oss': 7,
        'starcoder2': 8,
        'falcon': 9
    },
    instance_family: {
        'g5': 0,
        'g6': 1,
        'g6e': 2,
        'p5': 3,
        'p4d': 4,
        'inf2': 5,
        'trn2': 6
    },
    quantization: {
        'none': 0,
        'fp16': 1,
        'fp8': 2,
        'int8': 3,
        'int4': 4,
        'awq': 5,
        'gptq': 6
    },
    tp_degree: {
        '1': 0,
        '2': 1,
        '4': 2,
        '8': 3
    },
    enable_lora: {
        'false': 0,
        'true': 1
    },
    deployment_target: {
        'realtime-inference': 0,
        'async-inference': 1,
        'batch-transform': 2,
        'hyperpod-eks': 3
    }
};

const DIMENSIONS_USED = [
    'deployment_config',
    'model_family',
    'instance_family',
    'quantization',
    'tp_degree',
    'enable_lora',
    'deployment_target'
];

// --- PCA Implementation (no external dependencies) ---

/**
 * Encode a single point's categorical dimensions as an integer vector.
 */
function encodePoint(point) {
    return DIMENSIONS_USED.map((dim) => {
        const value = String(point[dim] ?? '');
        return ENCODING_MAPS[dim][value] ?? 0;
    });
}

/**
 * Compute the mean of each column.
 */
function computeMean(matrix) {
    const n = matrix.length;
    const dims = matrix[0].length;
    const mean = new Array(dims).fill(0);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < dims; j++) {
            mean[j] += matrix[i][j];
        }
    }
    for (let j = 0; j < dims; j++) {
        mean[j] /= n;
    }
    return mean;
}

/**
 * Center the matrix by subtracting the mean from each row.
 */
function centerMatrix(matrix, mean) {
    return matrix.map((row) => row.map((v, i) => v - mean[i]));
}

/**
 * Compute the covariance matrix of a centered data matrix.
 */
function computeCovariance(centered) {
    const n = centered.length;
    const dims = centered[0].length;
    const cov = Array.from({ length: dims }, () => new Array(dims).fill(0));
    for (let i = 0; i < dims; i++) {
        for (let j = i; j < dims; j++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
                sum += centered[k][i] * centered[k][j];
            }
            cov[i][j] = sum / (n - 1 || 1);
            cov[j][i] = cov[i][j];
        }
    }
    return cov;
}

/**
 * Find the dominant eigenvector of a symmetric matrix using power iteration.
 * Returns the eigenvector (normalized) and eigenvalue.
 */
function powerIteration(matrix, maxIter = 200, tol = 1e-10) {
    const n = matrix.length;
    // Start with a deterministic initial vector
    let vec = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        vec[i] = (i + 1) / n;
    }
    // Normalize
    let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    vec = vec.map((v) => v / norm);

    let eigenvalue = 0;
    for (let iter = 0; iter < maxIter; iter++) {
        // Multiply: newVec = matrix * vec
        const newVec = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                newVec[i] += matrix[i][j] * vec[j];
            }
        }
        // Compute eigenvalue (Rayleigh quotient)
        eigenvalue = newVec.reduce((s, v, i) => s + v * vec[i], 0);
        // Normalize
        norm = Math.sqrt(newVec.reduce((s, v) => s + v * v, 0));
        if (norm < 1e-15) break;
        const nextVec = newVec.map((v) => v / norm);
        // Check convergence
        const diff = nextVec.reduce((s, v, i) => s + (v - vec[i]) ** 2, 0);
        vec = nextVec;
        if (diff < tol) break;
    }
    return { vector: vec, eigenvalue };
}

/**
 * Deflate the matrix by removing the contribution of a known eigenvector.
 * Returns a new matrix with the eigenvector's component subtracted.
 */
function deflateMatrix(matrix, eigenvector, eigenvalue) {
    const n = matrix.length;
    const deflated = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            deflated[i][j] = matrix[i][j] - eigenvalue * eigenvector[i] * eigenvector[j];
        }
    }
    return deflated;
}

/**
 * Compute the top-k eigenvectors of a symmetric matrix using power iteration + deflation.
 */
function topEigenvectors(matrix, k = 2) {
    const results = [];
    let current = matrix.map((row) => [...row]);
    for (let i = 0; i < k; i++) {
        const { vector, eigenvalue } = powerIteration(current);
        results.push(vector);
        current = deflateMatrix(current, vector, eigenvalue);
    }
    return results;
}

/**
 * Project centered data points onto PCA components.
 */
function projectPoints(centered, components) {
    return centered.map((row) => components.map((comp) =>
        comp.reduce((sum, w, i) => sum + w * row[i], 0)
    ));
}

/**
 * Run PCA on a set of points. Returns pca_components, pca_mean, and projected coordinates.
 */
function runPCA(points) {
    const matrix = points.map((p) => encodePoint(p));
    const mean = computeMean(matrix);
    const centered = centerMatrix(matrix, mean);
    const cov = computeCovariance(centered);
    const components = topEigenvectors(cov, 2);
    const projected = projectPoints(centered, components);
    return { components, mean, projected };
}

// --- Input Parsing ---

/**
 * Parse CSV content into an array of objects.
 */
function parseCSV(content) {
    const lines = content.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
        rows.push(row);
    }
    return rows;
}

/**
 * Derive model_family from model_name.
 * E.g., "Qwen/Qwen3-4B" → "qwen3", "meta-llama/Llama-3.1-8B" → "llama3"
 */
function deriveModelFamily(modelName) {
    if (!modelName) return 'unknown';
    const lower = modelName.toLowerCase();
    if (lower.includes('qwen3') || lower.includes('qwen-3')) return 'qwen3';
    if (lower.includes('qwen2.5') || lower.includes('qwen-2.5')) return 'qwen2.5';
    if (lower.includes('llama-3') || lower.includes('llama3')) return 'llama3';
    if (lower.includes('deepseek-r1') || lower.includes('deepseek_r1')) return 'deepseek-r1';
    if (lower.includes('mistral')) return 'mistral';
    if (lower.includes('gemma')) return 'gemma2';
    if (lower.includes('phi-3') || lower.includes('phi3')) return 'phi3';
    if (lower.includes('gpt-oss') || lower.includes('gptoss')) return 'gpt-oss';
    if (lower.includes('starcoder')) return 'starcoder2';
    if (lower.includes('falcon')) return 'falcon';
    return 'unknown';
}

/**
 * Derive instance_family from instance_type.
 * E.g., "ml.g5.xlarge" → "g5", "ml.p5.48xlarge" → "p5"
 */
function deriveInstanceFamily(instanceType) {
    if (!instanceType) return 'g5';
    const match = instanceType.match(/ml\.([a-z]+\d+[a-z]*)\./);
    return match ? match[1] : 'g5';
}

/**
 * Load data from an input file (CSV or JSON).
 */
function loadInputData(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();
    let records;
    if (ext === '.json') {
        const parsed = JSON.parse(content);
        records = Array.isArray(parsed) ? parsed : (parsed.records || parsed.results || [parsed]);
    } else {
        records = parseCSV(content);
    }
    // Normalize records — ensure derived fields are present
    return records.map((r) => ({
        configId: r.config_id || r.configId || '',
        deployment_config: r.deployment_config || r.deploymentConfig || '',
        model_name: r.model_name || r.modelName || '',
        model_family: r.model_family || deriveModelFamily(r.model_name || r.modelName || ''),
        instance_type: r.instance_type || r.instanceType || '',
        instance_family: r.instance_family || deriveInstanceFamily(r.instance_type || r.instanceType || ''),
        quantization: r.quantization || 'none',
        tp_degree: String(r.tensor_parallel_degree || r.tp_degree || '1'),
        enable_lora: String(r.enable_lora ?? 'false'),
        deployment_target: r.deployment_target || r.deploymentTarget || 'realtime-inference',
        status: r.status || 'completed',
        throughput_rps: parseFloat(r.throughput_rps) || 0,
        ttft_p50_ms: parseFloat(r.ttft_p50_ms) || 0,
        run_type: r.run_type || 'ci'
    }));
}

// --- Sample Data Generation (Task 7.2) ---

/**
 * Seeded pseudo-random number generator (deterministic for reproducibility).
 */
function createRNG(seed = 42) {
    let state = seed;
    return function () {
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF;
        return (state >>> 0) / 0xFFFFFFFF;
    };
}

/**
 * Generate synthetic sample data covering all deployment configs and major model families.
 */
function generateSampleData() {
    const rng = createRNG(2026);

    // Deployment configs with realistic weights (more transformers-vllm points)
    const deploymentConfigs = [
        { name: 'transformers-vllm', weight: 30 },
        { name: 'transformers-sglang', weight: 15 },
        { name: 'transformers-tensorrt-llm', weight: 10 },
        { name: 'transformers-lmi', weight: 5 },
        { name: 'http-flask', weight: 5 },
        { name: 'http-fastapi', weight: 5 },
        { name: 'triton-vllm', weight: 5 },
        { name: 'triton-tensorrtllm', weight: 3 },
        { name: 'triton-python', weight: 2 },
        { name: 'diffusors-vllm-omni', weight: 3 }
    ];

    // Model families with realistic distribution
    const modelFamilies = [
        { family: 'qwen3', models: ['Qwen/Qwen3-4B', 'Qwen/Qwen3-8B', 'Qwen/Qwen3-14B', 'Qwen/Qwen3-32B'] },
        { family: 'llama3', models: ['meta-llama/Llama-3.1-8B', 'meta-llama/Llama-3.1-70B', 'meta-llama/Llama-3.3-70B'] },
        { family: 'deepseek-r1', models: ['deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'deepseek-ai/DeepSeek-R1-Distill-Llama-8B'] },
        { family: 'mistral', models: ['mistralai/Mistral-7B-Instruct-v0.3', 'mistralai/Mixtral-8x7B-Instruct-v0.1'] },
        { family: 'gemma2', models: ['google/gemma-2-9b-it', 'google/gemma-2-27b-it'] }
    ];

    // Instance families and sizes
    const instances = [
        { family: 'g5', types: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge', 'ml.g5.48xlarge'] },
        { family: 'g6', types: ['ml.g6.xlarge', 'ml.g6.2xlarge', 'ml.g6.12xlarge'] },
        { family: 'g6e', types: ['ml.g6e.xlarge', 'ml.g6e.2xlarge', 'ml.g6e.12xlarge'] },
        { family: 'p5', types: ['ml.p5.48xlarge'] }
    ];

    const quantizations = ['none', 'fp16', 'fp8', 'awq', 'gptq'];
    // TP degrees are selected based on instance size (see below)
    const deploymentTargets = ['realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'];

    // Status distribution: ~70% proven/passed, ~15% failed, ~15% unfeasible
    function pickStatus() {
        const r = rng();
        if (r < 0.70) return 'proven';
        if (r < 0.85) return 'failed';
        return 'unfeasible';
    }

    // Weighted random pick
    function weightedPick(items) {
        const totalWeight = items.reduce((s, i) => s + i.weight, 0);
        let r = rng() * totalWeight;
        for (const item of items) {
            r -= item.weight;
            if (r <= 0) return item;
        }
        return items[items.length - 1];
    }

    function pickRandom(arr) {
        return arr[Math.floor(rng() * arr.length)];
    }

    // Generate a simple configId hash
    function makeConfigId(idx) {
        const hex = ((idx * 2654435761) >>> 0).toString(16).padStart(8, '0');
        return hex + hex.split('').reverse().join('').slice(0, 8);
    }

    // Generate 75 synthetic points
    const points = [];
    const targetCount = 75;

    for (let i = 0; i < targetCount; i++) {
        const dc = weightedPick(deploymentConfigs);
        const mf = pickRandom(modelFamilies);
        const model = pickRandom(mf.models);
        const inst = pickRandom(instances);
        const instanceType = pickRandom(inst.types);
        const quantization = pickRandom(quantizations);
        const status = pickStatus();
        const deploymentTarget = pickRandom(deploymentTargets);

        // TP degree based on instance GPU count
        let tp = '1';
        if (instanceType.includes('12xlarge')) tp = pickRandom(['2', '4']);
        else if (instanceType.includes('48xlarge')) tp = pickRandom(['4', '8']);

        // LoRA — ~20% of configs enable it
        const enableLora = rng() < 0.2 ? 'true' : 'false';

        // Realistic metrics based on model size and instance
        const isLargeModel = model.includes('70B') || model.includes('32B');
        const baseThru = isLargeModel ? 10 + rng() * 30 : 30 + rng() * 70;
        const throughput = status === 'proven' ? Math.round(baseThru * 10) / 10 : 0;
        const baseTtft = isLargeModel ? 100 + rng() * 400 : 30 + rng() * 200;
        const ttft = status === 'proven' ? Math.round(baseTtft) : 0;

        // Run type distribution
        let runType = 'ci';
        const rtRoll = rng();
        if (rtRoll < 0.65) runType = 'ci';
        else if (rtRoll < 0.80) runType = 'path_prove';
        else if (rtRoll < 0.92) runType = 'optimization';
        else runType = 'manual';

        points.push({
            configId: makeConfigId(i),
            deployment_config: dc.name,
            model_name: model,
            model_family: mf.family,
            instance_type: instanceType,
            instance_family: inst.family,
            quantization,
            tp_degree: tp,
            enable_lora: enableLora,
            deployment_target: deploymentTarget,
            status,
            throughput_rps: throughput,
            ttft_p50_ms: ttft,
            run_type: runType
        });
    }

    return points;
}

// --- Main ---

function main() {
    const args = parseArgs(process.argv);

    // Load or generate data
    let points;
    if (args.sample) {
        points = generateSampleData();
        console.log(`✅ Generated ${points.length} synthetic sample points`);
    } else {
        points = loadInputData(args.input);
        console.log(`✅ Loaded ${points.length} records from ${args.input}`);
    }

    if (points.length === 0) {
        console.error('❌ No data points to process');
        process.exit(1);
    }

    // Run PCA
    const { components, mean, projected } = runPCA(points);

    // Round PCA outputs for compact JSON
    const pcaComponents = components.map((c) => c.map((v) => Math.round(v * 1e6) / 1e6));
    const pcaMean = mean.map((v) => Math.round(v * 1e6) / 1e6);

    // Build output points with projected x,y
    const outputPoints = points.map((p, i) => ({
        configId: p.configId,
        x: Math.round(projected[i][0] * 1e4) / 1e4,
        y: Math.round(projected[i][1] * 1e4) / 1e4,
        status: p.status,
        deployment_config: p.deployment_config,
        model_name: p.model_name,
        model_family: p.model_family,
        instance_type: p.instance_type,
        instance_family: p.instance_family,
        quantization: p.quantization,
        tp_degree: parseInt(p.tp_degree, 10),
        enable_lora: p.enable_lora === 'true',
        deployment_target: p.deployment_target,
        throughput_rps: p.throughput_rps,
        ttft_p50_ms: p.ttft_p50_ms,
        run_type: p.run_type
    }));

    // Build manifold JSON
    const manifold = {
        projection_method: 'pca',
        dimensions_used: DIMENSIONS_USED,
        encoding_maps: ENCODING_MAPS,
        pca_components: pcaComponents,
        pca_mean: pcaMean,
        points: outputPoints,
        generated_at: new Date().toISOString(),
        total_configs: outputPoints.length
    };

    // Write output
    const outDir = path.dirname(args.output);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(manifold, null, 2)}\n`);

    console.log(`✅ Written ${args.output}`);
    console.log('   Projection: PCA (2 components)');
    console.log(`   Dimensions: ${DIMENSIONS_USED.join(', ')}`);
    console.log(`   Points: ${outputPoints.length}`);
    console.log(`   PCA mean: [${pcaMean.map((v) => v.toFixed(2)).join(', ')}]`);
}

main();
