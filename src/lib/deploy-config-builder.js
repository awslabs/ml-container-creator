#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive Deployment Configuration Builder.
 *
 * Guides users through configuring a deployment when required vars are missing.
 * Prompts for target, instance type, endpoint strategy, cluster, etc.
 * Calls MCP servers (instance-sizer, endpoint-picker, cluster-picker) for
 * recommendations.
 *
 * Invoked from do/deploy when config is incomplete:
 *   node -e "import('.../deploy-config-builder.js').then(m => m.run({...}))"
 *
 * Uses @inquirer/prompts for UX consistency with mcc generate and do/train.
 *
 * Output: JSON written to --output-file with collected answers:
 *   { target, instance_type, endpoint_name, endpoint_strategy, ... }
 */

import { select, input, checkbox } from '@inquirer/prompts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GENERATOR_ROOT = resolve(__dirname, '..', '..');

// ── Target aliases (v1.3 backward compat) ────────────────────────────────────

const TARGET_ALIASES = {
    'realtime-inference': 'managed-inference'
};

function normalizeTarget(target) {
    return TARGET_ALIASES[target] || target;
}

// ── Config parsing ───────────────────────────────────────────────────────────

function parseConfig(configPath) {
    const vars = {};
    if (!existsSync(configPath)) return vars;
    const content = readFileSync(configPath, 'utf8');
    for (const line of content.split('\n')) {
        const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith('\'') && value.endsWith('\''))) {
            value = value.slice(1, -1);
        }
        // Strip inline comments
        const commentIdx = value.indexOf(' #');
        if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
        vars[match[1]] = value;
    }
    return vars;
}

// ── MCP client helper ────────────────────────────────────────────────────────

function resolveMcpArgs(args) {
    return (args || []).map(arg => {
        if (arg && !arg.startsWith('/') && !arg.startsWith('-')) {
            return resolve(GENERATOR_ROOT, arg);
        }
        return arg;
    });
}

async function callMcpTool(serverName, toolName, toolArgs, opts = {}) {
    const timeout = opts.timeout || 10000;
    const mcpConfigPath = join(GENERATOR_ROOT, 'config', 'mcp.json');
    if (!existsSync(mcpConfigPath)) return null;

    let mcpConfig;
    try {
        mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    } catch { return null; }

    const serverConfig = mcpConfig.mcpServers?.[serverName];
    if (!serverConfig) return null;

    try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

        const transport = new StdioClientTransport({
            command: serverConfig.command,
            args: resolveMcpArgs(serverConfig.args),
            env: { ...process.env, ...(serverConfig.env || {}) },
            stderr: 'pipe',
            cwd: GENERATOR_ROOT
        });

        const client = new Client(
            { name: 'ml-container-creator-deploy', version: '1.0.0' },
            { capabilities: {} }
        );

        await client.connect(transport);

        const result = await Promise.race([
            client.callTool({ name: toolName, arguments: toolArgs }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('MCP timeout')), timeout)
            )
        ]);

        await client.close();

        if (result?.isError) {
            console.error(`   [MCP debug] ${serverName}/${toolName}: ${result?.content?.[0]?.text || 'unknown error'}`);
            return null;
        }

        const textBlock = result?.content?.find(b => b.type === 'text');
        if (textBlock) return JSON.parse(textBlock.text);
        return null;
    } catch (err) {
        // MCP unavailable or timeout — caller uses fallback
        console.error(`   [MCP debug] ${serverName}/${toolName} failed: ${err.message}`);
        return null;
    }
}

// ── Instance sizing ──────────────────────────────────────────────────────────

async function getInstanceRecommendations(modelName, _region, deploymentTarget) {
    if (!modelName) return { single: [], multi: [] };

    const result = await callMcpTool('instance-sizer', 'get_instance_recommendation', {
        modelName,
        limit: 40,
        context: { deploymentTarget: deploymentTarget || 'realtime-inference' }
    }, { timeout: 60000 });

    if (result?.choices?.instanceType?.length > 0) {
        const recs = result.metadata?.recommendations || [];
        const estimatedVram = result.metadata?.estimatedVramGb;

        const formatRec = (r) => {
            const vramTotal = r.totalVramGb || '?';
            const utilPct = r.utilizationPercent || (estimatedVram && r.totalVramGb
                ? Math.round((estimatedVram / r.totalVramGb) * 100) : '?');
            const gpuCount = r.gpuCount || GPU_MAP[r.instanceType?.replace('ml.', '')] || 1;
            const perGpuVram = r.totalVramGb ? Math.round(r.totalVramGb / gpuCount) : '?';
            const headroom = r.quotaHeadroom ?? -1;

            // Quota info (when available from sizer discover mode)
            let quotaStr = '';
            if (r.quotaHeadroom !== undefined && r.quotaLimit !== undefined) {
                quotaStr = ` [${r.quotaHeadroom}/${r.quotaLimit} avail]`;
            } else if (r.quotaStatus === 'available') {
                quotaStr = ' [quota: ok]';
            } else if (r.quotaStatus === 'zero-quota') {
                quotaStr = ' [quota: 0]';
            } else if (r.quotaStatus === 'limited') {
                quotaStr = ' [quota: low]';
            }

            let label;
            if (gpuCount > 1) {
                label = `${r.instanceType} — ${gpuCount}x ${perGpuVram}GB GPU, ${vramTotal}GB total (${utilPct}% util)${quotaStr}`;
            } else {
                label = `${r.instanceType} — ${perGpuVram}GB VRAM (${utilPct}% util)${quotaStr}`;
            }

            return {
                name: r.displayLabel || label,
                value: r.instanceType,
                gpuCount,
                headroom
            };
        };

        const all = recs.map(formatRec);

        // Sort by highest available quota first
        const byHeadroom = (a, b) => b.headroom - a.headroom;

        // Filter: only show instances with room (headroom > 0 or unknown)
        const hasRoom = (r) => r.headroom === -1 || r.headroom > 0;

        const single = all.filter(r => r.gpuCount === 1 && hasRoom(r))
            .sort(byHeadroom).slice(0, 10);
        const multi = all.filter(r => r.gpuCount > 1 && hasRoom(r))
            .sort(byHeadroom).slice(0, 10);

        // If everything was filtered by quota, show all with a warning
        if (single.length === 0 && multi.length === 0 && all.length > 0) {
            console.log('   ⚠️  All instances have 0 quota — showing full list (request a quota increase)');
            const singleAll = all.filter(r => r.gpuCount === 1).sort(byHeadroom).slice(0, 10);
            const multiAll = all.filter(r => r.gpuCount > 1).sort(byHeadroom).slice(0, 10);
            return { single: singleAll, multi: multiAll, estimatedVram };
        }

        return { single, multi, estimatedVram };
    }
    return { single: [], multi: [] };
}

// ── Endpoint listing ─────────────────────────────────────────────────────────

async function getEndpoints(region) {
    const result = await callMcpTool('endpoint-picker', 'get_inference_endpoints', {
        parameters: ['existingEndpointName'],
        limit: 10,
        context: { awsRegion: region, deploymentTarget: 'realtime-inference' }
    }, { timeout: 60000 });

    // Picker returns choices under 'endpointName' key
    const endpointNames = result?.choices?.endpointName
        || result?.choices?.existingEndpointName
        || [];
    const metadata = result?.metadata || {};

    // Return enriched objects with instance type info
    return endpointNames.map(name => ({
        name,
        instanceType: metadata[name]?.instanceType || '',
        instanceCount: metadata[name]?.instanceCount || 1,
        icCount: metadata[name]?.icCount || 0,
        availableGpus: metadata[name]?.availableGpus || 0
    }));
}

// ── Cluster listing ──────────────────────────────────────────────────────────

async function getClusters(region) {
    const result = await callMcpTool('hyperpod-cluster-picker', 'get_hyperpod_clusters', {
        parameters: ['clusterName', 'gpuCapacity'],
        context: { awsRegion: region }
    }, { timeout: 60000 });

    if (result?.choices?.hyperPodCluster?.length > 0) {
        const metadata = result.metadata || {};
        return result.choices.hyperPodCluster.map(name => {
            const info = metadata[name];
            const instanceGroups = info?.instanceGroups || [];
            const gpuTotal = instanceGroups.reduce(
                (sum, g) => sum + (g.gpuCapacity?.total || 0), 0
            ) || 0;
            // Extract unique instance types available on this cluster
            const instanceTypes = [...new Set(
                instanceGroups
                    .map(g => g.instanceType)
                    .filter(Boolean)
            )];
            return {
                name,
                gpuTotal,
                queues: info?.queues || [],
                instanceTypes,
                instanceGroups
            };
        });
    }
    return [];
}

// ── GPU count detection ──────────────────────────────────────────────────────

const GPU_MAP = {
    'g5.xlarge': 1, 'g5.2xlarge': 1, 'g5.4xlarge': 1, 'g5.8xlarge': 1,
    'g5.12xlarge': 4, 'g5.16xlarge': 1, 'g5.24xlarge': 4, 'g5.48xlarge': 8,
    'g6.xlarge': 1, 'g6.2xlarge': 1, 'g6.4xlarge': 1, 'g6.8xlarge': 1,
    'g6.12xlarge': 4, 'g6.16xlarge': 1, 'g6.24xlarge': 4, 'g6.48xlarge': 8,
    'p4d.24xlarge': 8, 'p4de.24xlarge': 8, 'p5.48xlarge': 8
};

function detectGpuCount(instanceType) {
    if (!instanceType) return '1';
    const suffix = instanceType.replace('ml.', '');
    return String(GPU_MAP[suffix] || 1);
}

// ── AMI version resolution ────────────────────────────────────────────────────

function resolveInferenceAmiVersion(deploymentConfig) {
    // Map deployment configs to model-server catalog keys
    const configToServer = {
        'transformers-vllm': 'vllm',
        'transformers-sglang': 'sglang',
        'transformers-trtllm': 'tensorrt-llm',
        'transformers-lmi': 'lmi',
        'transformers-djl': 'djl',
        'diffusors-vllm': 'vllm-omni'
    };

    const serverKey = configToServer[deploymentConfig];
    if (!serverKey) return null;

    try {
        const catalogPath = join(GENERATOR_ROOT, 'servers', 'lib', 'catalogs', 'model-servers.json');
        if (!existsSync(catalogPath)) return null;
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const entries = catalog[serverKey];
        if (!Array.isArray(entries) || entries.length === 0) return null;
        return entries[0].defaults?.inferenceAmiVersion || null;
    } catch {
        return null;
    }
}

// ── Instance type prompt with split display ──────────────────────────────────

async function promptInstanceType(modelName, region, strategy, deploymentTarget) {
    const spinner = ora('Querying instance-sizer...').start();
    const { single, multi, estimatedVram } = await getInstanceRecommendations(modelName, region, deploymentTarget);
    const totalRecs = single.length + multi.length;
    if (totalRecs > 0) {
        spinner.succeed(`${totalRecs} recommendation(s)`);
        if (estimatedVram) {
            console.log(`   Model VRAM estimate: ~${estimatedVram.toFixed(1)}GB`);
        }

        // Build grouped choices with separators
        const choices = [];
        if (single.length > 0) {
            choices.push({ name: '── Single Accelerator ──', value: '__sep__', disabled: '' });
            choices.push(...single);
        }
        if (multi.length > 0) {
            choices.push({ name: '── Multi Accelerator ──', value: '__sep__', disabled: '' });
            choices.push(...multi);
        }
        choices.push({ name: '── Custom ──', value: '__sep__', disabled: '' });
        choices.push({ name: 'Enter manually...', value: '__custom__' });

        if (strategy === 'heterogeneous') {
            // Multi-select for heterogeneous (availability-ordered fallback)
            // Max 3 selections, FIFO order preserved.
            console.log('');
            console.log('   Select up to 3 instance types (order = priority):');
            const selectableChoices = [
                ...choices.filter(c => !c.disabled && c.value !== '__sep__' && c.value !== '__custom__'),
                { name: 'Enter manually...', value: '__custom__' }
            ];
            const selected = await checkbox({
                message: 'Instance types (space to select, enter to confirm):',
                choices: selectableChoices,
                validate: (items) => {
                    if (items.length === 0) return 'Select at least one';
                    if (items.length > 3) return 'Maximum 3 instance types for heterogeneous endpoints';
                    return true;
                }
            });
            // Handle custom entry
            const results = [];
            for (const s of selected) {
                if (s === '__custom__') {
                    const custom = await input({
                        message: 'Instance type:',
                        validate: v => v.startsWith('ml.') ? true : 'Must start with ml.'
                    });
                    results.push(custom);
                } else {
                    results.push(s);
                }
            }
            return results.join(',');
        } else {
            // Single-select
            const selected = await select({
                message: 'Instance type:',
                choices
            });
            if (selected === '__custom__') {
                return await input({
                    message: 'Instance type (e.g. ml.g5.xlarge):',
                    validate: v => v.startsWith('ml.') ? true : 'Must start with ml.'
                });
            }
            return selected;
        }
    } else {
        spinner.warn('No MCP recommendations available');
        return await input({
            message: 'Instance type (e.g. ml.g5.xlarge):',
            default: 'ml.g5.xlarge',
            validate: v => v.startsWith('ml.') ? true : 'Must start with ml.'
        });
    }
}

// ── Main interactive flow ────────────────────────────────────────────────────

export async function run({ configFile, outputFile, preTarget, preInstanceType }) {
    const configPath = resolve(configFile);
    const config = parseConfig(configPath);
    const region = process.env.AWS_REGION
        || process.env.AWS_DEFAULT_REGION
        || config.AWS_REGION
        || 'us-east-1';
    const modelName = config.HF_MODEL_ID
        || (config.MODEL_NAME && !config.MODEL_NAME.startsWith('s3://') ? config.MODEL_NAME : '')
        || '';
    const projectName = config.PROJECT_NAME || 'project';

    console.log('');
    console.log('🚀  Deployment Configuration');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   AWS_PROFILE: ${process.env.AWS_PROFILE || '(not set)'}`);
    console.log(`   AWS_REGION: ${region}`);
    console.log('');

    // ── Target selection ─────────────────────────────────────────────────────
    const existingTarget = normalizeTarget(
        preTarget || config.DEPLOYMENT_TARGET || ''
    );

    let target;
    if (existingTarget && existingTarget !== '') {
        target = existingTarget;
        console.log(`   Target: ${target} (from config)`);
    } else {
        target = await select({
            message: 'Deployment target:',
            choices: [
                { name: 'Managed Inference (SageMaker real-time)', value: 'managed-inference' },
                { name: 'Async Inference (SageMaker async)', value: 'async-inference' },
                { name: 'Batch Transform (SageMaker batch)', value: 'batch-transform' },
                { name: 'HyperPod EKS (GPU cluster)', value: 'hyperpod-eks' }
            ],
            default: 'managed-inference'
        });
    }

    const answers = { target };

    // ── Endpoint strategy (for managed-inference) ────────────────────────────
    // Asked FIRST because it determines which MCP server to call next:
    // new/heterogeneous → instance-sizer, existing → endpoint-picker
    if (target === 'managed-inference') {
        if (!config.ENDPOINT_STRATEGY) {
            answers.endpoint_strategy = await select({
                message: 'Endpoint strategy:',
                choices: [
                    { name: 'New endpoint (single instance)', value: 'new' },
                    { name: 'New endpoint (heterogeneous — availability fallback)', value: 'heterogeneous' },
                    { name: 'Attach to existing endpoint (inference component)', value: 'existing' }
                ],
                default: 'new'
            });
        } else {
            answers.endpoint_strategy = config.ENDPOINT_STRATEGY;
        }
    }

    // ── Instance type ────────────────────────────────────────────────────────
    if (preInstanceType) {
        answers.instance_type = preInstanceType;
    } else if (!config.INSTANCE_TYPE) {
        if (target === 'managed-inference' && answers.endpoint_strategy === 'existing') {
            // For existing endpoints, query endpoint-picker
            const epSpinner = ora('Querying endpoint-picker...').start();
            const endpoints = await getEndpoints(region);
            epSpinner.stop();
            if (endpoints.length > 0) {
                const choices = [
                    ...endpoints.map(e => ({
                        name: `${e.name} (${e.instanceType}, ${e.icCount} ICs, ${e.availableGpus} GPUs free)`,
                        value: e.name
                    })),
                    { name: 'Custom (enter manually)', value: '__custom__' }
                ];
                const selected = await select({
                    message: 'Select endpoint:',
                    choices
                });
                if (selected === '__custom__') {
                    answers.smai_endpoint_name = await input({ message: 'Endpoint name:' });
                    // Custom endpoint — need instance type
                    answers.instance_type = await promptInstanceType(modelName, region, 'new', target);
                } else {
                    answers.smai_endpoint_name = selected;
                    // Instance type comes from the endpoint — no sizer needed
                    const ep = endpoints.find(e => e.name === selected);
                    if (ep?.instanceType) {
                        answers.instance_type = ep.instanceType;
                        console.log(`   Instance type: ${ep.instanceType} (from endpoint)`);
                    }
                }
            } else {
                answers.smai_endpoint_name = await input({
                    message: 'Endpoint name:',
                    default: `${projectName}-ep`
                });
                // No endpoint found — need instance type
                answers.instance_type = await promptInstanceType(modelName, region, 'new', target);
            }
        } else {
            answers.instance_type = await promptInstanceType(modelName, region, answers.endpoint_strategy, target);
        }
    } else {
        answers.instance_type = config.INSTANCE_TYPE;
    }

    // ── Resolve inference AMI version from model-server catalog ───────────────
    const deploymentConfig = config.DEPLOYMENT_CONFIG || '';
    if (!config.INFERENCE_AMI_VERSION && deploymentConfig) {
        const amiVersion = resolveInferenceAmiVersion(deploymentConfig);
        if (amiVersion) {
            answers.inference_ami_version = amiVersion;
            console.log(`   AMI version: ${amiVersion} (from ${deploymentConfig} catalog)`);
        }
    }

    // ── Target-specific prompts ──────────────────────────────────────────────

    if (target === 'managed-inference') {
        // Endpoint name (for new/heterogeneous — existing was handled above)
        if (answers.endpoint_strategy !== 'existing' && !config.SMAI_ENDPOINT_NAME) {
            answers.smai_endpoint_name = await input({
                message: 'Endpoint name:',
                default: `${projectName}-ep`
            });
        } else if (answers.endpoint_strategy !== 'existing') {
            answers.smai_endpoint_name = config.SMAI_ENDPOINT_NAME;
        }

        // Heterogeneous instance types — already handled by promptInstanceType
        // which used checkbox multi-select. The comma-separated result is in
        // answers.instance_type. Split into instance_types for config.
        if (answers.endpoint_strategy === 'heterogeneous') {
            answers.instance_types = answers.instance_type;
            // Primary type for GPU detection is the first in the list
            answers.instance_type = answers.instance_types.split(',')[0];
        }

        // GPU count
        if (!config.IC_GPU_COUNT) {
            const detected = detectGpuCount(answers.instance_type);
            answers.gpu_count = detected;
            console.log(`   GPU count: ${detected} (auto-detected)`);
        }

    } else if (target === 'hyperpod-eks') {
        // Cluster selection
        let selectedCluster = null;
        if (!config.HP_CLUSTER_NAME) {
            const clusterSpinner = ora('Querying cluster-picker...').start();
            const clusters = await getClusters(region);
            clusterSpinner.stop();
            if (clusters.length > 0) {
                const choices = clusters.map(c => ({
                    name: `${c.name} (${c.gpuTotal} GPUs, ${c.instanceTypes.join(', ')})`,
                    value: c.name
                }));
                answers.cluster_name = await select({
                    message: 'Select cluster:',
                    choices
                });

                selectedCluster = clusters.find(c => c.name === answers.cluster_name);

                // Queue selection from cluster metadata
                if (selectedCluster?.queues?.length > 0) {
                    const queueChoices = [
                        ...selectedCluster.queues.map(q => ({ name: q, value: q })),
                        { name: '(skip — no queue)', value: '' }
                    ];
                    answers.queue = await select({
                        message: 'Kueue queue:',
                        choices: queueChoices
                    });
                }
            } else {
                console.log('   ❌ No HyperPod cluster found.');
                console.log('      Run: mcc bootstrap add-module hyperpod');
                const result = { error: 'No HyperPod cluster found. Run: mcc bootstrap add-module hyperpod' };
                writeFileSync(outputFile, JSON.stringify(result));
                return result;
            }
        }

        // Instance type — use cluster's available instance types, not generic sizer
        if (!config.INSTANCE_TYPE && !preInstanceType) {
            const clusterInstanceTypes = selectedCluster?.instanceTypes || [];
            if (clusterInstanceTypes.length > 0) {
                // Show instance types from the cluster's node groups
                const choices = clusterInstanceTypes.map(t => {
                    const group = selectedCluster.instanceGroups.find(g => g.instanceType === t);
                    const gpus = group?.gpuCapacity?.total || 0;
                    const count = group?.count || 0;
                    return {
                        name: `${t} (${gpus} GPUs, ${count} nodes)`,
                        value: t
                    };
                });
                choices.push({ name: 'Custom (enter manually)', value: '__custom__' });

                const selected = await select({
                    message: 'Instance type (from cluster node groups):',
                    choices
                });
                if (selected === '__custom__') {
                    answers.instance_type = await input({
                        message: 'Instance type:',
                        validate: v => v.startsWith('ml.') ? true : 'Must start with ml.'
                    });
                } else {
                    answers.instance_type = selected;
                }
            } else {
                // No cluster info available — fall back to sizer
                answers.instance_type = await promptInstanceType(modelName, region, null, target);
            }
        }

        // GPU count
        if (!config.HP_GPU_COUNT) {
            const detected = detectGpuCount(answers.instance_type);
            answers.hp_gpu_count = detected;
            console.log(`   GPU count: ${detected} (auto-detected)`);
        }

        // Namespace
        if (!config.HP_NAMESPACE) {
            answers.namespace = await input({
                message: 'Kubernetes namespace:',
                default: 'default'
            });
        }

        // Replicas
        if (!config.HP_REPLICAS) {
            answers.replicas = await input({
                message: 'Number of replicas:',
                default: '1',
                validate: v => !isNaN(v) && Number(v) > 0 ? true : 'Must be positive'
            });
        }

    } else if (target === 'async-inference') {
        // Async endpoint name (separate from SMAI)
        if (!config.ASYNC_ENDPOINT_NAME) {
            answers.async_endpoint_name = await input({
                message: 'Async endpoint name:',
                default: `${projectName}-async-ep`
            });
        }

        if (!config.ASYNC_S3_OUTPUT_PATH) {
            // Try to get bucket from profile
            let defaultPath = '';
            try {
                const homedir = process.env.HOME || '';
                const pCfg = JSON.parse(readFileSync(join(homedir, '.ml-container-creator/config.json'), 'utf8'));
                const profile = pCfg.profiles?.[pCfg.activeProfile] || {};
                const bucket = profile.modelsS3Bucket || '';
                if (bucket) defaultPath = `s3://${bucket}/async-output/${projectName}/`;
            } catch { /* best-effort */ }

            answers.async_output_path = await input({
                message: 'S3 output path:',
                default: defaultPath
            });
        }
        if (!config.ASYNC_SNS_TOPIC) {
            answers.async_sns_topic = await input({
                message: 'SNS topic ARN (optional, Enter to skip):',
                default: ''
            });
        }
        if (!config.ASYNC_MAX_CONCURRENT) {
            answers.async_max_concurrent = await input({
                message: 'Max concurrent invocations:',
                default: '1'
            });
        }

    } else if (target === 'batch-transform') {
        if (!config.BATCH_INPUT_PATH) {
            answers.batch_input_path = await input({
                message: 'S3 input path (required):',
                validate: v => v.startsWith('s3://') ? true : 'Must be an S3 URI'
            });
        }
        if (!config.BATCH_OUTPUT_PATH) {
            let defaultPath = '';
            try {
                const homedir = process.env.HOME || '';
                const pCfg = JSON.parse(readFileSync(join(homedir, '.ml-container-creator/config.json'), 'utf8'));
                const profile = pCfg.profiles?.[pCfg.activeProfile] || {};
                const bucket = profile.modelsS3Bucket || '';
                if (bucket) defaultPath = `s3://${bucket}/batch-output/${projectName}/`;
            } catch { /* best-effort */ }

            answers.batch_output_path = await input({
                message: 'S3 output path:',
                default: defaultPath,
                validate: v => v.startsWith('s3://') ? true : 'Must be an S3 URI'
            });
        }
        if (!config.BATCH_SPLIT_TYPE) {
            answers.batch_split_type = await select({
                message: 'Split type:',
                choices: ['Line', 'RecordIO', 'None'].map(v => ({ name: v, value: v })),
                default: 'Line'
            });
        }
        if (!config.BATCH_STRATEGY) {
            answers.batch_strategy = await select({
                message: 'Batch strategy:',
                choices: ['MultiRecord', 'SingleRecord'].map(v => ({ name: v, value: v })),
                default: 'MultiRecord'
            });
        }
    }

    console.log('');

    // Write result
    writeFileSync(outputFile, JSON.stringify(answers));
    return answers;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const parsed = {};
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config-file' && args[i + 1]) parsed.configFile = args[++i];
    else if (args[i] === '--output-file' && args[i + 1]) parsed.outputFile = args[++i];
    else if (args[i] === '--target' && args[i + 1]) parsed.preTarget = args[++i];
    else if (args[i] === '--instance-type' && args[i + 1]) parsed.preInstanceType = args[++i];
}

if (parsed.configFile && parsed.outputFile) {
    run(parsed).catch(err => {
        writeFileSync(parsed.outputFile, JSON.stringify({ error: err.message }));
        process.exit(1);
    });
}
