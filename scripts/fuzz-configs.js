#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * fuzz-configs.js — Configuration Fuzzer for ML Container Creator
 *
 * Generates random valid configurations from parameter-schema-v2.json and tests
 * that ml-container-creator can generate projects without errors.
 *
 * What it catches:
 *   - Template rendering crashes on unusual flag combinations
 *   - Conditional logic bugs in EJS templates
 *   - Validation engine rejecting valid configs
 *   - Missing case statements in do/ scripts for valid deployment configs
 *   - File routing bugs (wrong files kept/deleted for a given architecture)
 *
 * Usage:
 *   node scripts/fuzz-configs.js                       # 10 trials, generate-only
 *   node scripts/fuzz-configs.js --trials 50           # 50 trials
 *   node scripts/fuzz-configs.js --seed 42             # Reproducible run
 *   node scripts/fuzz-configs.js --dry-run             # Print commands, don't execute
 *   node scripts/fuzz-configs.js --mode build          # Also run do/build (needs Docker)
 *   node scripts/fuzz-configs.js --verbose             # Show full stdout/stderr
 *
 * Exit codes:
 *   0 — all trials passed
 *   1 — one or more trials failed
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const SCHEMA_PATH = join(PROJECT_ROOT, 'config', 'parameter-schema-v2.json');

// ─── CLI Argument Parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        trials: 10,
        seed: null,
        dryRun: false,
        verbose: false,
        mode: 'generate-only',
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--trials' && argv[i + 1]) {
            args.trials = parseInt(argv[++i], 10);
        } else if (arg.startsWith('--trials=')) {
            args.trials = parseInt(arg.split('=')[1], 10);
        } else if (arg === '--seed' && argv[i + 1]) {
            args.seed = parseInt(argv[++i], 10);
        } else if (arg.startsWith('--seed=')) {
            args.seed = parseInt(arg.split('=')[1], 10);
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--verbose') {
            args.verbose = true;
        } else if (arg === '--mode' && argv[i + 1]) {
            args.mode = argv[++i];
        } else if (arg.startsWith('--mode=')) {
            args.mode = arg.split('=')[1];
        } else if (arg === '--help' || arg === '-h') {
            console.log(`Usage: node scripts/fuzz-configs.js [options]

Options:
  --trials N        Number of random configs to test (default: 10)
  --seed N          Random seed for reproducibility
  --dry-run         Print commands without executing
  --verbose         Show full output of each trial
  --mode <mode>     'generate-only' (default) or 'build' (requires Docker)
  --help            Show this message`);
            process.exit(0);
        }
    }
    return args;
}

// ─── Seeded Random Number Generator ────────────────────────────────────────────

class SeededRng {
    constructor(seed) {
        // Simple mulberry32 PRNG
        this.state = seed !== null && seed !== undefined ? seed : Date.now();
    }

    next() {
        let t = (this.state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    pick(arr) {
        return arr[Math.floor(this.next() * arr.length)];
    }

    bool(probability = 0.5) {
        return this.next() < probability;
    }

    int(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }
}

// ─── Schema Loader ─────────────────────────────────────────────────────────────

function loadSchema() {
    const raw = readFileSync(SCHEMA_PATH, 'utf8');
    return JSON.parse(raw);
}

// ─── Architecture Resolver ─────────────────────────────────────────────────────

function getArchitecture(deploymentConfig) {
    if (deploymentConfig === 'marketplace') return 'marketplace';
    return deploymentConfig.split('-')[0]; // transformers, http, triton, diffusors
}

// ─── Config Generator ──────────────────────────────────────────────────────────

const TRANSFORMER_MODELS = [
    'Qwen/Qwen3-4B',
    'meta-llama/Llama-3.2-1B-Instruct',
    'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B',
    'openai/gpt-oss-20b',
];

const GPU_INSTANCES = ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge'];
const CPU_INSTANCES = ['ml.m5.large', 'ml.m5.xlarge'];

const MODEL_FORMATS_HTTP = ['pkl', 'joblib', 'json', 'h5', 'pb', 'pt'];

// Deployment targets — use the non-deprecated name
const DEPLOYMENT_TARGETS = ['realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'];

function generateConfig(schema, rng) {
    const params = schema.parameters;

    // 1. Pick a deployment config
    const deploymentConfigs = params.deploymentConfig.validation.enum;
    const deploymentConfig = rng.pick(deploymentConfigs);
    const architecture = getArchitecture(deploymentConfig);

    // 2. Pick a deployment target (weighted toward realtime-inference)
    let deploymentTarget;
    if (rng.bool(0.6)) {
        deploymentTarget = 'realtime-inference';
    } else {
        deploymentTarget = rng.pick(DEPLOYMENT_TARGETS);
    }

    // 3. Build the config
    const config = {
        '--deployment-config': deploymentConfig,
        '--deployment-target': deploymentTarget,
        '--region': 'us-east-1',
    };

    // 4. Model name (required for transformers/diffusors)
    if (architecture === 'transformers' || architecture === 'diffusors') {
        config['--model-name'] = rng.pick(TRANSFORMER_MODELS);
    }

    // 5. Instance type (required for managed/async/batch targets)
    const needsInstance = ['realtime-inference', 'managed-inference', 'async-inference', 'batch-transform'];
    if (needsInstance.includes(deploymentTarget)) {
        if (architecture === 'http') {
            config['--instance-type'] = rng.pick(CPU_INSTANCES);
        } else {
            config['--instance-type'] = rng.pick(GPU_INSTANCES);
        }
    }

    // 6. Model format (required for http architecture)
    if (architecture === 'http') {
        config['--model-format'] = rng.pick(MODEL_FORMATS_HTTP);
    }

    // 7. Optionally add constrained parameters based on architecture + target
    if (architecture === 'transformers' && deploymentTarget === 'realtime-inference') {
        // LoRA (30% chance)
        if (rng.bool(0.3)) {
            config['--enable-lora'] = true;
            if (rng.bool(0.5)) {
                config['--max-loras'] = rng.int(1, 4);
            }
        }
    }

    // IC configuration (for realtime-inference, 20% chance)
    if (deploymentTarget === 'realtime-inference' && rng.bool(0.2)) {
        config['--ic-gpu-count'] = rng.int(1, 4);
        if (rng.bool(0.3)) {
            config['--ic-copy-count'] = rng.int(1, 2);
        }
    }

    // Endpoint config (for realtime-inference, 20% chance)
    if (deploymentTarget === 'realtime-inference' && rng.bool(0.2)) {
        config['--endpoint-initial-instance-count'] = rng.int(1, 2);
        if (rng.bool(0.3)) {
            config['--endpoint-volume-size'] = rng.pick([30, 50, 100, 200]);
        }
    }

    // Async config
    if (deploymentTarget === 'async-inference') {
        config['--async-s3-output-path'] = 's3://mlcc-fuzz-async/output/';
        if (rng.bool(0.3)) {
            config['--async-max-concurrent'] = rng.int(1, 5);
        }
    }

    // Batch config
    if (deploymentTarget === 'batch-transform') {
        config['--batch-input-path'] = 's3://mlcc-fuzz-batch/input/';
        config['--batch-output-path'] = 's3://mlcc-fuzz-batch/output/';
        if (rng.bool(0.5)) {
            config['--batch-instance-count'] = rng.int(1, 3);
        }
        if (rng.bool(0.3)) {
            config['--batch-split-type'] = rng.pick(['Line', 'RecordIO', 'None']);
        }
        if (rng.bool(0.3)) {
            config['--batch-strategy'] = rng.pick(['MultiRecord', 'SingleRecord']);
        }
    }

    // HyperPod config
    if (deploymentTarget === 'hyperpod-eks') {
        config['--hyperpod-cluster'] = 'fuzz-cluster';
        config['--hyperpod-namespace'] = 'fuzz-ns';
        if (rng.bool(0.3)) {
            config['--hyperpod-replicas'] = rng.int(1, 3);
        }
    }

    // Benchmark (for transformers on realtime, 15% chance)
    if (architecture === 'transformers' && deploymentTarget === 'realtime-inference' && rng.bool(0.15)) {
        config['--include-benchmark'] = true;
        config['--benchmark-concurrency'] = rng.int(1, 8);
    }

    // Include sample (for http, sometimes disable)
    if (architecture === 'http' && rng.bool(0.3)) {
        config['--include-sample'] = false;
    }

    // Build target (20% chance)
    if (rng.bool(0.2)) {
        config['--build-target'] = rng.pick(['local', 'codebuild']);
    }

    return config;
}

// ─── Command Builder ───────────────────────────────────────────────────────────

function buildCommand(config, projectName) {
    const parts = ['ml-container-creator', projectName];

    for (const [flag, value] of Object.entries(config)) {
        if (value === true) {
            parts.push(flag);
        } else if (value === false) {
            // Skip false booleans (don't pass the flag)
            continue;
        } else {
            parts.push(`${flag}=${value}`);
        }
    }

    parts.push('--skip-prompts');
    return parts.join(' ');
}

// ─── Trial Runner ──────────────────────────────────────────────────────────────

function runTrial(config, trialIndex, totalTrials, options) {
    const deploymentConfig = config['--deployment-config'];
    const modelName = config['--model-name'] || '(none)';
    const instanceType = config['--instance-type'] || '(none)';
    const deploymentTarget = config['--deployment-target'];

    const projectName = `fuzz-${trialIndex}-${Date.now()}`;
    const command = buildCommand(config, projectName);

    const label = `${deploymentConfig} + ${modelName} + ${instanceType} [${deploymentTarget}]`;

    if (options.dryRun) {
        console.log(`[${trialIndex + 1}/${totalTrials}] 🔍 ${label}`);
        console.log(`  $ ${command}`);
        return { passed: true, label };
    }

    // Create temp directory
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcc-fuzz-'));

    try {
        // Execute ml-container-creator
        const result = execSync(command, {
            cwd: tmpDir,
            encoding: 'utf8',
            timeout: 120_000, // 2 minutes max
            stdio: options.verbose ? 'inherit' : 'pipe',
            env: { ...process.env, NODE_ENV: 'test' },
        });

        // Verify expected files exist
        const projectDir = join(tmpDir, projectName);
        const requiredFiles = ['Dockerfile', 'do/config', 'do/build'];
        const missingFiles = [];

        for (const file of requiredFiles) {
            if (!existsSync(join(projectDir, file))) {
                missingFiles.push(file);
            }
        }

        if (missingFiles.length > 0) {
            console.log(`[${trialIndex + 1}/${totalTrials}] ❌ ${label} — missing files: ${missingFiles.join(', ')}`);
            return { passed: false, label, error: `Missing files: ${missingFiles.join(', ')}` };
        }

        // Optionally run do/build
        if (options.mode === 'build') {
            try {
                execSync('./do/build', {
                    cwd: projectDir,
                    encoding: 'utf8',
                    timeout: 300_000, // 5 minutes
                    stdio: options.verbose ? 'inherit' : 'pipe',
                });
            } catch (buildErr) {
                const stderr = buildErr.stderr?.slice(0, 200) || buildErr.message;
                console.log(`[${trialIndex + 1}/${totalTrials}] ❌ ${label} — do/build failed: ${stderr}`);
                return { passed: false, label, error: `Build failed: ${stderr}` };
            }
        }

        console.log(`[${trialIndex + 1}/${totalTrials}] ✅ ${label}`);
        return { passed: true, label };

    } catch (err) {
        const stderr = err.stderr?.slice(0, 300) || err.message;
        console.log(`[${trialIndex + 1}/${totalTrials}] ❌ ${label} — exit code ${err.status}: ${stderr}`);
        if (options.verbose && err.stdout) {
            console.log('  stdout:', err.stdout.slice(0, 500));
        }
        return { passed: false, label, error: stderr, command };
    } finally {
        // Clean up
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function main() {
    const args = parseArgs(process.argv);
    const schema = loadSchema();
    const rng = new SeededRng(args.seed);

    console.log(`\n🎲 MCC Config Fuzzer`);
    console.log(`   Trials: ${args.trials}`);
    console.log(`   Seed: ${args.seed ?? '(random)'}`);
    console.log(`   Mode: ${args.mode}`);
    console.log(`   Dry run: ${args.dryRun}`);
    console.log('');

    const results = [];

    for (let i = 0; i < args.trials; i++) {
        const config = generateConfig(schema, rng);
        const result = runTrial(config, i, args.trials, args);
        results.push(result);
    }

    // Summary
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log('');
    console.log('━'.repeat(60));
    if (failed === 0) {
        console.log(`✅ ${passed}/${results.length} passed`);
    } else {
        console.log(`❌ ${passed}/${results.length} passed, ${failed} failed`);
        console.log('');
        console.log('Failed configs:');
        for (const r of results.filter(r => !r.passed)) {
            console.log(`  • ${r.label}`);
            if (r.error) console.log(`    ${r.error.slice(0, 150)}`);
            if (r.command) console.log(`    $ ${r.command}`);
        }
    }
    console.log('━'.repeat(60));

    process.exit(failed > 0 ? 1 : 0);
}

main();
