// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prove Command Handler
 *
 * Orchestrates the `mcc prove` CLI subcommand tree:
 * - `prove <config.json>` — run a prove config file end-to-end
 * - `prove --interactive` — build and run a prove config via wizard
 * - `prove report` — query DynamoDB for prove results
 * - `prove sync` — update catalogs from proven results
 * - `prove status` — show local prove workspace state
 *
 * Feature: prove-mvp
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { STAGE_EXECUTORS, loadProveState } from './prove-pipeline-executor.js';
import { classifyFailure } from './path-prover-brain.js';
import { E2ECIRecorder } from './e2e-ci-recorder.js';

/**
 * @typedef {object} ProveConfig
 * @property {string} schema_version - Schema version (currently "1")
 * @property {object} base - Base configuration template
 * @property {object} [sweep] - Sweep axes for expansion
 * @property {string[]} stages - Lifecycle stages to execute
 * @property {number} [timeout_minutes] - Overall timeout in minutes
 * @property {number} [budget_usd] - Budget ceiling in USD
 */

export default class ProveCommandHandler {
    constructor({ promptFn } = {}) {
        this._promptFn = promptFn || null;
    }

    /**
     * Dispatch prove subcommands.
     *
     * @param {string[]} args - Positional args after 'prove'
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options) {
        // Interactive mode
        if (options.interactive) {
            return this._handleInteractive(options);
        }

        // Subcommand dispatch
        const firstArg = args[0];
        if (firstArg === 'report') {
            return this._handleReport(options);
        }
        if (firstArg === 'sync') {
            return this._handleSync(options);
        }
        if (firstArg === 'status') {
            return this._handleStatus(options);
        }

        // Default: treat first arg as config file path
        if (firstArg) {
            return this._handleRunConfig(firstArg, options);
        }

        // No args and no --interactive: show usage
        console.log('🔬 Usage: mcc prove <config.json> | --interactive | report | sync | status');
    }

    // ── Sweep Expansion ──────────────────────────────────────────────────────

    /**
     * Expand sweep axes in a prove config into flat list of configs.
     * Each sweep axis produces the Cartesian product with the base config.
     *
     * @param {ProveConfig} proveConfig - The prove config with base and sweep
     * @returns {object[]} Flat list of expanded configs
     */
    expandSweep(proveConfig) {
        const { base, sweep = {} } = proveConfig;
        const axes = Object.entries(sweep).filter(([, values]) => Array.isArray(values) && values.length > 0);

        if (axes.length === 0) {
            return [{ ...base }];
        }

        // Build Cartesian product of all sweep axes
        let combinations = [{}];
        for (const [key, values] of axes) {
            const newCombinations = [];
            for (const combo of combinations) {
                for (const value of values) {
                    newCombinations.push({ ...combo, [key]: value });
                }
            }
            combinations = newCombinations;
        }

        // Merge each combination with base
        return combinations.map(combo => ({ ...base, ...combo }));
    }

    /**
     * Compute a deterministic config hash from a config object.
     *
     * @param {object} config - Config object to hash
     * @returns {string} 16-character hex hash
     */
    computeConfigHash(config) {
        const sorted = JSON.stringify(config, Object.keys(config).sort());
        return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
    }

    // ── Run Config ───────────────────────────────────────────────────────────

    /**
     * Load, validate, and run a prove config file.
     *
     * @param {string} configPath - Path to prove.json
     * @param {object} options - CLI options
     */
    async _handleRunConfig(configPath, options) {
        // Load config
        const resolvedPath = path.resolve(configPath);
        if (!existsSync(resolvedPath)) {
            console.error(`❌ Config file not found: ${resolvedPath}`);
            process.exitCode = 1;
            return;
        }

        let proveConfig;
        try {
            proveConfig = JSON.parse(readFileSync(resolvedPath, 'utf8'));
        } catch (err) {
            console.error(`❌ Failed to parse config: ${err.message}`);
            process.exitCode = 1;
            return;
        }

        // Validate
        if (!proveConfig.base || !proveConfig.stages || !Array.isArray(proveConfig.stages)) {
            console.error('❌ Invalid prove.json: must have "base" object and "stages" array');
            process.exitCode = 1;
            return;
        }

        // Apply CLI overrides
        if (options.model) proveConfig.base.model_name = options.model;
        if (options.deploymentConfig) proveConfig.base.deployment_config = options.deploymentConfig;
        if (options.instanceType) proveConfig.base.instance_type = options.instanceType;
        if (options.stages) proveConfig.stages = options.stages.split(',');

        // Expand sweep
        const configs = this.expandSweep(proveConfig);
        const concurrency = options.concurrency || 1;
        const stages = proveConfig.stages;

        if (options.dryRun) {
            console.log(`🔬 Dry run: would prove ${configs.length} config(s) across ${stages.length} stages`);
            for (const cfg of configs) {
                console.log(`  • ${cfg.model_name || 'unknown'} / ${cfg.deployment_config || 'unknown'} / ${cfg.instance_type || 'unknown'}`);
            }
            return;
        }

        console.log(`🔬 Proving ${configs.length} configuration(s) across ${stages.length} stages...`);

        // Run configs (sequentially or with concurrency)
        const results = [];
        const chunks = [];
        for (let i = 0; i < configs.length; i += concurrency) {
            chunks.push(configs.slice(i, i + concurrency));
        }

        for (const chunk of chunks) {
            const chunkResults = await Promise.all(
                chunk.map(cfg => this._runSingleConfig(cfg, stages, options))
            );
            results.push(...chunkResults);
        }

        // Print summary table
        this._printSummary(results, stages);

        // Record results to DynamoDB
        await this._recordResults(results);
    }

    /**
     * Run a single prove config through all stages.
     *
     * @param {object} config - Expanded config object
     * @param {string[]} stages - Stages to execute
     * @param {object} options - CLI options
     * @returns {Promise<object>} Run result
     */
    async _runSingleConfig(config, stages, options) {
        const configHash = this.computeConfigHash(config);
        const projectDir = path.join(homedir(), '.mlcc', 'prove', configHash, 'project');
        mkdirSync(projectDir, { recursive: true });

        const steps = [];
        let failed = false;
        const startTime = Date.now();

        for (const stage of stages) {
            if (stage === 'clean') continue; // clean runs last regardless

            if (failed) {
                steps.push({ name: stage, status: 'skip', duration: 0 });
                continue;
            }

            const executor = STAGE_EXECUTORS[stage];
            if (!executor) {
                steps.push({ name: stage, status: 'fail', duration: 0, error: `Unknown stage: ${stage}` });
                failed = true;
                continue;
            }

            const stepOptions = { ...options, config };
            const result = await executor(projectDir, stepOptions);
            steps.push(result);

            if (result.status === 'fail') {
                failed = true;
                // Classify failure
                const classification = classifyFailure(result.error);
                result.classification = classification;
            }
        }

        // Always run clean unless --no-clean
        if (stages.includes('clean') && options.clean !== false) {
            const cleanResult = await STAGE_EXECUTORS.clean(projectDir, options);
            steps.push(cleanResult);
        }

        const overallStatus = steps.some(s => s.status === 'fail') ? 'failed' : 'completed';

        return {
            config,
            configHash,
            projectDir,
            steps,
            status: overallStatus,
            duration: Date.now() - startTime
        };
    }

    /**
     * Print a summary table of prove results.
     *
     * @param {object[]} results - Array of run results
     * @param {string[]} stages - Stages that were executed
     */
    _printSummary(results, stages) {
        console.log('\n📊 Prove Summary:');
        console.log('─'.repeat(80));
        const header = `${'Config'.padEnd(20)} | ${stages.map(s => s.slice(0, 8).padEnd(8)).join(' | ')}`;
        console.log(header);
        console.log('─'.repeat(80));

        for (const result of results) {
            const label = (result.config.model_name || result.configHash).slice(0, 20).padEnd(20);
            const cells = stages.map(stage => {
                const step = result.steps.find(s => s.name === stage);
                if (!step) return '─'.padEnd(8);
                if (step.status === 'pass') return '✅ pass'.padEnd(8);
                if (step.status === 'fail') return '❌ fail'.padEnd(8);
                return '⏭ skip'.padEnd(8);
            });
            console.log(`${label} | ${cells.join(' | ')}`);
        }
        console.log('─'.repeat(80));
    }

    /**
     * Record prove results to DynamoDB.
     *
     * @param {object[]} results - Array of run results
     */
    async _recordResults(results) {
        try {
            const recorder = new E2ECIRecorder();
            const ready = await recorder.init();
            if (!ready) return;

            for (const result of results) {
                const catalogEntry = {
                    id: `prove-${result.configHash}`,
                    tier: 'prove',
                    args: Object.entries(result.config)
                        .filter(([, v]) => v !== undefined && v !== null)
                        .map(([k, v]) => `--${k}=${v}`)
                        .join(' ')
                };
                const configResult = {
                    status: result.status === 'completed' ? 'pass' : 'fail',
                    steps: result.steps,
                    duration: result.duration
                };
                await recorder.recordConfigResult(catalogEntry, configResult);
            }
        } catch (err) {
            console.warn(`⚠️  Failed to record results to DynamoDB: ${err.message}`);
        }
    }

    // ── Interactive Mode ─────────────────────────────────────────────────────

    /**
     * Interactive prove config builder.
     *
     * @param {object} options - CLI options
     */
    async _handleInteractive(options) {
        let promptFn = this._promptFn;
        if (!promptFn) {
            const { runPrompts } = await import('../prompt-adapter.js');
            promptFn = runPrompts;
        }

        const answers = await promptFn([
            { type: 'input', name: 'model_name', message: 'Model name (HuggingFace ID):' },
            {
                type: 'list', name: 'deployment_config', message: 'Deployment config:',
                choices: ['transformers-vllm', 'transformers-sglang', 'transformers-tgi', 'http-flask', 'djl-deepspeed']
            },
            { type: 'input', name: 'instance_type', message: 'Instance type:', default: 'ml.g5.xlarge' },
            {
                type: 'checkbox', name: 'stages', message: 'Stages to run:',
                choices: ['generate', 'stage', 'build', 'push', 'deploy', 'test', 'tune', 'adapter', 'test-adapter', 'benchmark', 'register', 'clean'],
                default: ['generate', 'stage', 'build', 'push', 'deploy', 'test', 'clean']
            },
            { type: 'input', name: 'quantization_sweep', message: 'Quantization sweep (comma-separated, or empty):', default: '' }
        ]);

        const proveConfig = {
            schema_version: '1',
            base: {
                model_name: answers.model_name,
                deployment_config: answers.deployment_config,
                instance_type: answers.instance_type
            },
            sweep: {},
            stages: answers.stages,
            timeout_minutes: 90,
            budget_usd: 50
        };

        if (answers.quantization_sweep) {
            proveConfig.sweep.quantization = answers.quantization_sweep.split(',').map(s => s.trim());
        }

        // Write prove.json
        const outputPath = path.resolve('prove.json');
        writeFileSync(outputPath, JSON.stringify(proveConfig, null, 2));
        console.log(`✅ Wrote ${outputPath}`);

        // Ask to run
        const runAnswer = await promptFn([
            { type: 'confirm', name: 'runNow', message: 'Run now?', default: true }
        ]);

        if (runAnswer.runNow) {
            await this._handleRunConfig(outputPath, options);
        }
    }

    // ── Report ───────────────────────────────────────────────────────────────

    /**
     * Query DynamoDB for prove results and print table.
     *
     * @param {object} _options - CLI options
     */
    async _handleReport(_options) {
        try {
            const recorder = new E2ECIRecorder();
            const ready = await recorder.init();
            if (!ready) {
                console.log('⚠️  CI table not provisioned — no results to report');
                return;
            }

            const { ScanCommand } = await import('@aws-sdk/client-dynamodb');
            const { unmarshall } = await import('@aws-sdk/util-dynamodb');

            const response = await recorder.client.send(new ScanCommand({
                TableName: recorder.tableName,
                FilterExpression: 'contains(configId, :prefix)',
                ExpressionAttributeValues: {
                    ':prefix': { S: 'prove' }
                }
            }));

            const items = (response.Items || []).map(item => unmarshall(item));

            if (items.length === 0) {
                console.log('📊 No prove results found');
                return;
            }

            console.log('\n📊 Prove Report:');
            console.log('─'.repeat(90));
            console.log(`${'Config ID'.padEnd(18)} | ${'Status'.padEnd(10)} | ${'Duration'.padEnd(10)} | ${'Date'.padEnd(22)}`);
            console.log('─'.repeat(90));

            for (const item of items) {
                const id = (item.configId || '').slice(0, 16).padEnd(18);
                const status = (item.testStatus || '').padEnd(10);
                const duration = item.duration ? `${Math.round(item.duration / 1000)}s`.padEnd(10) : '—'.padEnd(10);
                const date = (item.lastTestTimestamp || '').slice(0, 22).padEnd(22);
                console.log(`${id} | ${status} | ${duration} | ${date}`);
            }
            console.log('─'.repeat(90));
        } catch (err) {
            console.error(`❌ Failed to query report: ${err.message}`);
        }
    }

    // ── Sync ─────────────────────────────────────────────────────────────────

    /**
     * Sync proven results to catalogs.
     *
     * @param {object} options - CLI options
     */
    async _handleSync(options) {
        try {
            const { syncProvenConfigs } = await import('../../scripts/sync-proven-configs.js');
            await syncProvenConfigs({ dryRun: options.dryRun });
        } catch (err) {
            console.error(`❌ Sync failed: ${err.message}`);
        }
    }

    // ── Status ───────────────────────────────────────────────────────────────

    /**
     * Show local prove workspace status.
     *
     * @param {object} _options - CLI options
     */
    async _handleStatus(_options) {
        const proveDir = path.join(homedir(), '.mlcc', 'prove');

        if (!existsSync(proveDir)) {
            console.log('📊 No prove workspaces found');
            return;
        }

        const entries = readdirSync(proveDir, { withFileTypes: true })
            .filter(d => d.isDirectory());

        if (entries.length === 0) {
            console.log('📊 No prove workspaces found');
            return;
        }

        console.log('\n📊 Prove Workspace Status:');
        console.log('─'.repeat(70));
        console.log(`${'Config Hash'.padEnd(18)} | ${'Stages Completed'.padEnd(20)} | ${'Last Run'.padEnd(22)}`);
        console.log('─'.repeat(70));

        for (const entry of entries) {
            const projectDir = path.join(proveDir, entry.name, 'project');
            const state = loadProveState(projectDir);
            const stages = Object.keys(state);
            const passedStages = stages.filter(s => state[s]?.status === 'pass');
            const lastTimestamp = Math.max(...stages.map(s => state[s]?.timestamp || 0), 0);
            const lastRun = lastTimestamp > 0
                ? new Date(lastTimestamp).toISOString().slice(0, 19)
                : '—';

            console.log(
                `${entry.name.slice(0, 16).padEnd(18)} | ${ 
                    `${passedStages.length}/${stages.length} stages`.padEnd(20)  } | ${ 
                    lastRun.padEnd(22)}`
            );
        }
        console.log('─'.repeat(70));
    }
}
