/**
 * E2E Validation Runner
 *
 * Orchestrates end-to-end testing of generated ML container projects.
 * Loads a catalog of configurations, filters by tier, and runs each
 * config's lifecycle against real AWS infrastructure.
 *
 * Usage:
 *   node scripts/e2e-runner.js --tier ci [--concurrency 2] [--dry-run]
 *
 * Requirements: 2.1, 2.6
 */

import { readFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateCatalog, filterByTier } from '../src/lib/e2e-catalog-validator.js';
import { aggregateResults, formatJSON } from './e2e-summary.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CATALOG_PATH = path.resolve(__dirname, 'e2e-catalog.json');
const DEFAULT_CONCURRENCY = 2;
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Semaphore ─────────────────────────────────────────────────────────────────
// Requirements: 2.3

/**
 * Simple semaphore for bounded parallelism.
 * Limits the number of concurrent async operations.
 */
export class Semaphore {
    constructor(max) {
        this._max = max;
        this._count = 0;
        this._queue = [];
    }

    async acquire() {
        if (this._count < this._max) {
            this._count++;
            return;
        }
        return new Promise(resolve => {
            this._queue.push(resolve);
        });
    }

    release() {
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            next();
        } else {
            this._count--;
        }
    }
}

/**
 * Parse CLI arguments from process.argv.
 *
 * @param {string[]} argv - process.argv slice (from index 2)
 * @returns {object} Parsed options
 */
export function parseArgs(argv) {
    const options = {
        tier: undefined,
        concurrency: DEFAULT_CONCURRENCY,
        catalogPath: DEFAULT_CATALOG_PATH,
        workspaceRoot: undefined,
        s3Bucket: undefined,
        snsTopicArn: undefined,
        dryRun: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '--tier' && i + 1 < argv.length) {
            options.tier = argv[++i];
        } else if (arg.startsWith('--tier=')) {
            options.tier = arg.split('=')[1];
        } else if (arg === '--concurrency' && i + 1 < argv.length) {
            options.concurrency = parseInt(argv[++i], 10);
        } else if (arg.startsWith('--concurrency=')) {
            options.concurrency = parseInt(arg.split('=')[1], 10);
        } else if (arg === '--catalog-path' && i + 1 < argv.length) {
            options.catalogPath = path.resolve(argv[++i]);
        } else if (arg.startsWith('--catalog-path=')) {
            options.catalogPath = path.resolve(arg.split('=')[1]);
        } else if (arg === '--workspace-root' && i + 1 < argv.length) {
            options.workspaceRoot = argv[++i];
        } else if (arg.startsWith('--workspace-root=')) {
            options.workspaceRoot = arg.split('=')[1];
        } else if (arg === '--s3-bucket' && i + 1 < argv.length) {
            options.s3Bucket = argv[++i];
        } else if (arg.startsWith('--s3-bucket=')) {
            options.s3Bucket = arg.split('=')[1];
        } else if (arg === '--sns-topic' && i + 1 < argv.length) {
            options.snsTopicArn = argv[++i];
        } else if (arg.startsWith('--sns-topic=')) {
            options.snsTopicArn = arg.split('=')[1];
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        }
    }

    return options;
}

/**
 * Load and validate the e2e catalog from disk.
 *
 * @param {string} catalogPath - Path to the catalog JSON file
 * @returns {Promise<object>} The validated catalog object
 */
export async function loadCatalog(catalogPath) {
    let raw;
    try {
        raw = await readFile(catalogPath, 'utf-8');
    } catch (err) {
        throw new Error(`Failed to read catalog at ${catalogPath}: ${err.message}`);
    }

    let catalog;
    try {
        catalog = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Failed to parse catalog JSON: ${err.message}`);
    }

    const result = validateCatalog(catalog);
    if (!result.valid) {
        const messages = result.errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
        throw new Error(`Catalog validation failed:\n${messages}`);
    }

    return catalog;
}

// ── Lifecycle Executor ────────────────────────────────────────────────────────
// Requirements: 2.2, 2.4, 2.5, 4.1, 4.2

/**
 * Resolve a lifecycle step name to a shell command.
 *
 * Step name conventions:
 * - Simple steps: "build" → "./do/build"
 * - Compound steps with hyphens:
 *   - "adapter-add" → "./do/adapter add"
 *   - "adapter-remove" → "./do/adapter remove"
 *   - "test-adapter" → "./do/test --adapter"
 * - Special case: "clean" → "./do/clean all"
 *
 * @param {string} step - Lifecycle step name from catalog
 * @param {string} projectDir - Path to the generated project directory
 * @returns {string} Shell command to execute
 */
export function resolveStepCommand(step, _projectDir) {
    // Special case: clean always maps to "./do/clean all"
    if (step === 'clean') {
        return './do/clean all';
    }

    // Compound steps with hyphens
    if (step.includes('-')) {
        const parts = step.split('-');
        const base = parts[0];

        // "test-adapter" → "./do/test --adapter"
        if (base === 'test') {
            const flag = parts.slice(1).join('-');
            return `./do/test --${flag}`;
        }

        // "adapter-add" → "./do/adapter add"
        const subcommand = parts.slice(1).join('-');
        return `./do/${base} ${subcommand}`;
    }

    // Simple steps: "build" → "./do/build"
    return `./do/${step}`;
}

/**
 * Execute a single lifecycle step in the project directory.
 *
 * Spawns the step command via bash, captures stderr (last 500 chars),
 * and handles timeout kills.
 *
 * @param {string} step - Lifecycle step name
 * @param {string} projectDir - Path to the generated project directory
 * @param {number} timeout - Timeout in seconds
 * @returns {Promise<object>} StepResult with name, status, duration, and optional error
 */
export async function executeStep(step, projectDir, timeout) {
    const command = resolveStepCommand(step, projectDir);
    const startTime = Date.now();

    try {
        await execFileAsync('bash', ['-c', command], {
            cwd: projectDir,
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024
        });
        return {
            name: step,
            status: 'pass',
            duration: Date.now() - startTime
        };
    } catch (err) {
        const error = err.killed
            ? `Timeout after ${timeout}s`
            : (err.stderr || err.message).slice(-500);
        return {
            name: step,
            status: 'fail',
            duration: Date.now() - startTime,
            error
        };
    }
}

/**
 * Generate a project by invoking the CLI.
 *
 * Runs `node bin/cli.js {config.id} --skip-prompts {config.args}`
 * from the repo root, with the output directory set to the workspace.
 *
 * @param {object} config - Catalog config entry
 * @param {string} projectDir - Target directory for the generated project
 * @param {string} repoRoot - Path to the repository root
 * @returns {Promise<void>}
 */
async function generateProject(config, projectDir, repoRoot) {
    await mkdir(projectDir, { recursive: true });

    const cliPath = path.join(repoRoot, 'bin', 'cli.js');
    const args = [cliPath, config.id, '--skip-prompts', '--project-dir', projectDir];

    // Append config args (split by whitespace)
    if (config.args) {
        args.push(...config.args.split(/\s+/).filter(Boolean));
    }

    await execFileAsync('node', args, {
        cwd: repoRoot,
        timeout: 300 * 1000,
        maxBuffer: 10 * 1024 * 1024
    });
}

/**
 * Run a single config through its full lifecycle.
 *
 * Generates the project, executes lifecycle steps sequentially with
 * fail-fast behavior, and always runs clean in a finally block.
 *
 * @param {object} config - Catalog config entry
 * @param {string} workspaceRoot - Root workspace directory
 * @param {string} repoRoot - Path to the repository root
 * @returns {Promise<object>} ConfigResult with id, status, duration, steps, and optional error
 */
export async function runConfig(config, workspaceRoot, repoRoot) {
    const projectDir = path.join(workspaceRoot, config.id);
    const result = { id: config.id, steps: [], status: 'pass', duration: 0 };
    const startTime = Date.now();

    try {
        // Generate project
        await generateProject(config, projectDir, repoRoot);

        // Execute lifecycle steps (fail-fast), excluding clean
        for (const step of config.lifecycle.filter(s => s !== 'clean')) {
            const stepResult = await executeStep(step, projectDir, config.timeout);
            result.steps.push(stepResult);
            if (stepResult.status === 'fail') {
                result.status = 'fail';
                result.error = stepResult.error;
                break;
            }
        }
    } catch (err) {
        // Project generation or unexpected error
        result.status = 'fail';
        result.error = (err.stderr || err.message || String(err)).slice(-500);
    } finally {
        // Clean always runs
        const cleanResult = await executeStep('clean', projectDir, 300);
        result.steps.push(cleanResult);
        result.duration = Date.now() - startTime;
    }

    return result;
}

/**
 * Print the dry-run execution plan.
 *
 * @param {object[]} configs - Filtered configs to run
 * @param {object} options - Run options
 */
export function printDryRunPlan(configs, options) {
    console.log('\n📋 E2E Dry Run — Execution Plan');
    console.log('═'.repeat(50));
    console.log(`  Tier:         ${options.tier}`);
    console.log(`  Concurrency:  ${options.concurrency}`);
    console.log(`  Workspace:    ${options.workspaceRoot}`);
    console.log(`  Catalog:      ${options.catalogPath}`);
    console.log(`  Configs:      ${configs.length}`);
    console.log('');
    console.log('  Configs to execute:');

    for (const config of configs) {
        console.log(`    • ${config.id} [${config.track}]`);
        console.log(`      lifecycle: ${config.lifecycle.join(' → ')}`);
        console.log(`      timeout:   ${config.timeout}s`);
    }

    console.log('');
    console.log('═'.repeat(50));
    console.log('  (dry-run mode — no configs will be executed)');
    console.log('');
}

/**
 * Upload results JSON to S3.
 * Skips gracefully if S3 client is not available or upload fails.
 *
 * @param {string} bucket - S3 bucket name
 * @param {object} runResult - The run result object
 * @returns {Promise<void>}
 */
async function uploadToS3(bucket, runResult) {
    try {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const client = new S3Client();
        const key = `e2e-results/${runResult.tier}/${runResult.runId}.json`;

        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: formatJSON(runResult),
            ContentType: 'application/json'
        }));

        console.log(`📤 Results uploaded to s3://${bucket}/${key}`);
    } catch (err) {
        console.warn(`⚠️  S3 upload skipped: ${err.message}`);
    }
}

/**
 * Publish failure notification to SNS.
 * Skips gracefully if SNS client is not available or publish fails.
 *
 * @param {string} topicArn - SNS topic ARN
 * @param {object} runResult - The run result object
 * @returns {Promise<void>}
 */
async function publishToSNS(topicArn, runResult) {
    try {
        const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
        const client = new SNSClient();

        const failedConfigs = runResult.results
            .filter(r => r.status === 'fail')
            .map(r => `  • ${r.id}: ${r.error || 'unknown error'}`)
            .join('\n');

        const message = [
            `❌ E2E Run Failed — ${runResult.tier} tier`,
            `Run ID: ${runResult.runId}`,
            `Passed: ${runResult.passed}, Failed: ${runResult.failed}`,
            '',
            'Failed configs:',
            failedConfigs
        ].join('\n');

        await client.send(new PublishCommand({
            TopicArn: topicArn,
            Subject: `E2E Failure: ${runResult.tier} tier — ${runResult.failed} config(s) failed`,
            Message: message
        }));

        console.log('📢 Failure notification sent to SNS');
    } catch (err) {
        console.warn(`⚠️  SNS publish skipped: ${err.message}`);
    }
}

/**
 * Run the E2E validation suite.
 *
 * @param {object} options
 * @param {string} options.tier - Tier to filter configs by
 * @param {number} [options.concurrency=2] - Max parallel config executions
 * @param {string} [options.catalogPath] - Path to catalog JSON
 * @param {string} [options.workspaceRoot] - Root directory for workspaces
 * @param {string} [options.s3Bucket] - S3 bucket for results upload
 * @param {string} [options.snsTopicArn] - SNS topic for failure notifications
 * @param {boolean} [options.dryRun=false] - Print plan without executing
 * @returns {Promise<object>} RunResult
 */
export async function runE2E(options) {
    const {
        tier,
        concurrency = DEFAULT_CONCURRENCY,
        catalogPath = DEFAULT_CATALOG_PATH,
        workspaceRoot = `/tmp/mlcc-e2e-${Date.now()}`,
        s3Bucket,
        snsTopicArn,
        dryRun = false
    } = options;

    if (!tier) {
        throw new Error('--tier is required');
    }

    // Load and validate catalog
    const catalog = await loadCatalog(catalogPath);

    // Filter by tier
    const configs = filterByTier(catalog, tier);

    if (configs.length === 0) {
        throw new Error(`No configs found for tier "${tier}"`);
    }

    // Resolve options for downstream use
    const resolvedOptions = {
        tier,
        concurrency,
        catalogPath,
        workspaceRoot,
        dryRun
    };

    // Dry-run: print plan and exit
    if (dryRun) {
        printDryRunPlan(configs, resolvedOptions);
        return {
            runId: new Date().toISOString(),
            tier,
            duration: 0,
            passed: 0,
            failed: 0,
            results: []
        };
    }

    // Execute configs with bounded parallelism
    const startTime = Date.now();
    const semaphore = new Semaphore(concurrency);

    const promises = configs.map(async (config) => {
        await semaphore.acquire();
        try {
            return await runConfig(config, workspaceRoot, REPO_ROOT);
        } finally {
            semaphore.release();
        }
    });

    const settled = await Promise.allSettled(promises);

    // Extract results from settled promises
    const results = settled.map((outcome, i) => {
        if (outcome.status === 'fulfilled') {
            return outcome.value;
        }
        // Rejected promise — unexpected error
        return {
            id: configs[i].id,
            status: 'fail',
            duration: 0,
            error: (outcome.reason?.message || String(outcome.reason)).slice(-500),
            steps: []
        };
    });

    // Aggregate results using summary module
    const meta = {
        runId: new Date().toISOString(),
        tier,
        startTime
    };
    const runResult = aggregateResults(results, meta);

    // Upload to S3 if configured
    if (s3Bucket) {
        await uploadToS3(s3Bucket, runResult);
    }

    // Publish to SNS on failure if configured
    if (snsTopicArn && runResult.failed > 0) {
        await publishToSNS(snsTopicArn, runResult);
    }

    // Remove workspace root directory
    try {
        await rm(workspaceRoot, { recursive: true, force: true });
    } catch (err) {
        console.warn(`⚠️  Failed to clean workspace: ${err.message}`);
    }

    return runResult;
}

/**
 * CLI entry point — detect if this module is the main script.
 */
const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
    const options = parseArgs(process.argv.slice(2));

    runE2E(options)
        .then((result) => {
            if (!options.dryRun) {
                console.log(formatJSON(result));
            }
            // Exit with code 1 if any config failed
            if (result.failed > 0) {
                process.exit(1);
            }
        })
        .catch((err) => {
            console.error(`❌ E2E Runner failed: ${err.message}`);
            process.exit(1);
        });
}
