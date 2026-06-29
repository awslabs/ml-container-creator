#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive Training Job Configuration Builder.
 *
 * Guides users through configuring a custom training job by prompting
 * for technique, model, dataset, instance type, and hyperparameters.
 * Writes the result to training/config.yaml.
 *
 * Invoked from do/train --interactive:
 *   node -e "import('.../train-config-builder.js').then(m => m.run({...}))"
 *
 * Uses @inquirer/prompts via the project's prompt-adapter.js for UX
 * consistency with the main ml-container-creator generation flow.
 */

import { select, input, confirm } from '@inquirer/prompts';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// ── YAML helpers (minimal, no dependency) ────────────────────────────────────

/**
 * Parse a simple YAML file (flat key-value, no nesting beyond what we need).
 * Falls back gracefully if format is unexpected.
 */
function parseSimpleYaml(content) {
    const result = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let value = trimmed.slice(colonIdx + 1).trim();
        // Remove quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith('\'') && value.endsWith('\''))) {
            value = value.slice(1, -1);
        }
        // Type coercion
        if (value === 'true') result[key] = true;
        else if (value === 'false') result[key] = false;
        else if (value === '' || value === '""' || value === '\'\'') result[key] = '';
        else if (!isNaN(value) && value !== '') result[key] = Number(value);
        else result[key] = value;
    }
    return result;
}

// ── Technique scanning ───────────────────────────────────────────────────────

function scanTechniques(trainingDir) {
    const techniques = [];
    try {
        const entries = readdirSync(trainingDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const trainScript = join(trainingDir, entry.name, 'train.py');
                if (existsSync(trainScript)) {
                    techniques.push(entry.name);
                }
            }
        }
    } catch {
        // Directory doesn't exist or not readable
    }
    return techniques.length > 0 ? techniques : ['custom'];
}

// ── Prompts.json loading ─────────────────────────────────────────────────────

function loadTechniquePrompts(trainingDir, technique) {
    const promptsFile = join(trainingDir, technique, 'prompts.json');
    if (!existsSync(promptsFile)) return null;
    try {
        return JSON.parse(readFileSync(promptsFile, 'utf8'));
    } catch {
        return null;
    }
}

// ── Defaults loading ─────────────────────────────────────────────────────────

function loadTechniqueDefaults(trainingDir, technique) {
    const defaultsFile = join(trainingDir, technique, 'defaults.yaml');
    if (!existsSync(defaultsFile)) return {};
    try {
        return parseSimpleYaml(readFileSync(defaultsFile, 'utf8'));
    } catch {
        return {};
    }
}

// ── Main interactive flow ────────────────────────────────────────────────────

export async function run({ configFile, trainingDir }) {
    const configPath = resolve(configFile);
    const trainingPath = resolve(trainingDir);

    // Load existing config as defaults
    let existingConfig = {};
    if (existsSync(configPath)) {
        try {
            existingConfig = parseSimpleYaml(readFileSync(configPath, 'utf8'));
        } catch {
            // Ignore parse errors — start fresh
        }
    }

    console.log('');
    console.log('🏋️  Custom Training Job Builder');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // ── Technique selection ──────────────────────────────────────────────────
    const techniques = scanTechniques(trainingPath);
    const technique = await select({
        message: 'Training technique?',
        choices: techniques.map(t => ({ name: t, value: t })),
        default: existingConfig.technique || 'sft'
    });

    // ── Common questions ─────────────────────────────────────────────────────
    const modelId = await input({
        message: 'Base model (HuggingFace ID)?',
        default: existingConfig.model_id || process.env.HF_MODEL_ID || 'Qwen/Qwen3-0.6B'
    });

    const dataset = await input({
        message: 'Dataset (hf://org/name, s3://..., or registry name)?',
        default: existingConfig.dataset || ''
    });

    const instanceType = await input({
        message: 'Instance type?',
        default: existingConfig.instance_type || 'ml.g5.xlarge'
    });

    // ── Load technique defaults for hyperparam questions ─────────────────────
    const defaults = loadTechniqueDefaults(trainingPath, technique);

    const epochs = await input({
        message: 'Epochs?',
        default: String(existingConfig.epochs || defaults.epochs || 3),
        validate: (v) => !isNaN(v) && Number(v) > 0 ? true : 'Must be a positive number'
    });

    const learningRate = await input({
        message: 'Learning rate?',
        default: String(existingConfig.learning_rate || defaults.learning_rate || '2e-4'),
        validate: (v) => !isNaN(parseFloat(v)) ? true : 'Must be a number'
    });

    const loraR = await input({
        message: 'LoRA rank (r)?',
        default: String(existingConfig.lora_r || defaults.lora_r || 16),
        validate: (v) => !isNaN(v) && Number(v) > 0 ? true : 'Must be a positive integer'
    });

    // ── Technique-specific prompts ───────────────────────────────────────────
    const techniquePromptsSchema = loadTechniquePrompts(trainingPath, technique);
    const techniqueAnswers = {};

    if (techniquePromptsSchema && techniquePromptsSchema.prompts) {
        console.log('');
        console.log(`─── ${techniquePromptsSchema.section_title || `${technique} settings`} ───`);

        for (const prompt of techniquePromptsSchema.prompts) {
            const existingVal = existingConfig[prompt.name];
            const defaultVal = existingVal !== null && existingVal !== undefined ? String(existingVal) :
                (defaults[prompt.name] !== null && defaults[prompt.name] !== undefined ? String(defaults[prompt.name]) :
                    (prompt.default || ''));

            const answer = await input({
                message: `${prompt.message}`,
                default: defaultVal,
                validate: (v) => {
                    if (prompt.validate === 'float') return !isNaN(parseFloat(v)) ? true : 'Must be a number';
                    if (prompt.validate === 'int') return !isNaN(parseInt(v)) ? true : 'Must be an integer';
                    return true;
                }
            });
            techniqueAnswers[prompt.name] = answer;
        }
    }

    // ── Build config ─────────────────────────────────────────────────────────
    const hyperparameters = {
        epochs,
        learning_rate: learningRate,
        lora_r: loraR,
        ...techniqueAnswers
    };

    // ── Write config ─────────────────────────────────────────────────────────
    // Build YAML output (preserving the original file structure where possible)
    const yamlLines = [
        '# do/training/config.yaml — Generated by interactive builder',
        `# Technique: ${technique}`,
        `# Generated: ${new Date().toISOString()}`,
        '',
        `technique: "${technique}"`,
        '',
        '# Base model',
        `model_id: "${modelId}"`,
        '',
        '# Dataset',
        `dataset: "${dataset}"`,
        '',
        '# Instance',
        `instance_type: "${instanceType}"`,
        `instance_count: ${existingConfig.instance_count || 1}`,
        '',
        '# Container image',
        `image: "${existingConfig.image || ''}"`,
        '',
        '# Script (auto-selected from technique)',
        `script: "do/training/${technique}/train.py"`,
        '',
        '# Output',
        `output_path: "${existingConfig.output_path || ''}"`,
        '',
        '# Hyperparameters',
        'hyperparameters:'
    ];

    for (const [key, val] of Object.entries(hyperparameters)) {
        yamlLines.push(`  ${key}: "${val}"`);
    }

    // Preserve other existing fields
    if (existingConfig.max_runtime_seconds) {
        yamlLines.push('', `max_runtime_seconds: ${existingConfig.max_runtime_seconds}`);
    }
    if (existingConfig.volume_size_gb) {
        yamlLines.push(`volume_size_gb: ${existingConfig.volume_size_gb}`);
    }
    if (existingConfig.enable_spot) {
        yamlLines.push(`enable_spot: ${existingConfig.enable_spot}`);
    }

    yamlLines.push('');
    writeFileSync(configPath, yamlLines.join('\n'), 'utf8');

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('');
    console.log('✅ Configuration written to training/config.yaml');
    console.log('');
    console.log(`  technique: ${technique}`);
    console.log(`  model: ${modelId}`);
    console.log(`  dataset: ${dataset || '(none)'}`);
    console.log(`  instance_type: ${instanceType}`);
    console.log(`  epochs: ${epochs}`);
    console.log(`  learning_rate: ${learningRate}`);
    console.log(`  lora_r: ${loraR}`);
    if (Object.keys(techniqueAnswers).length > 0) {
        for (const [k, v] of Object.entries(techniqueAnswers)) {
            console.log(`  ${k}: ${v}`);
        }
    }
    console.log('');

    // ── Run now? ─────────────────────────────────────────────────────────────
    const runNow = await confirm({
        message: 'Run training job now?',
        default: false
    });

    // Output JSON for bash consumption
    const result = JSON.stringify({
        config_written: true,
        technique,
        run_now: runNow
    });
    console.log(result);
}

// ── CLI entry point ──────────────────────────────────────────────────────────

async function main() {
    const { values } = parseArgs({
        options: {
            'config-file': { type: 'string' },
            'training-dir': { type: 'string' }
        }
    });

    const configFile = values['config-file'];
    const trainingDir = values['training-dir'];

    if (!configFile || !trainingDir) {
        console.error('Usage: train-config-builder --config-file <path> --training-dir <path>');
        process.exit(1);
    }

    try {
        await run({ configFile, trainingDir });
    } catch (err) {
        if (err.name === 'ExitPromptError') {
            // User pressed Ctrl+C
            console.log('\n⚠️  Cancelled.');
            process.exit(130);
        }
        console.error(`❌ Error: ${err.message}`);
        process.exit(1);
    }
}

// Run if invoked directly
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMainModule) {
    main();
}
