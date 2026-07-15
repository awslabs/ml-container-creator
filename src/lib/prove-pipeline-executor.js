// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prove Pipeline Executor
 *
 * Executes lifecycle stages for validation targets in the `mcc prove` workflow.
 * Handles stage-specific logic including idempotency checks, status tracking,
 * and fail-fast behavior.
 *
 * ## Module Status (AC-1.4)
 *
 * FUNCTIONAL stages:
 * - `executeStageStep()` — fully wired with idempotency via `.mlcc/staged-assets.json`
 * - `isAlreadyStaged()` — checks staged assets existence and validity
 * - `getStagingState()` — resolves current staging state from filesystem + step results
 * - `isValidLifecycleStage()` — validates individual stage names
 * - `validateStagesArray()` — validates arrays of stage names
 * - `formatStagingStatus()` — formats staging state for display
 * - `buildTargetStatus()` — builds status summary for a prove target
 *
 * INTENTIONALLY INCOMPLETE (post-v1 scope):
 * - Other lifecycle stage executors (build, push, deploy, test, tune, adapter,
 *   test-adapter, benchmark, register, clean) are NOT implemented.
 * - Only the `stage` step has execution logic. Other stages are recognized in
 *   validation but have no executor function.
 * - This is not "broken" — these were never finished before the laptop was bricked.
 *   They are explicitly post-v1 scope.
 *
 * Feature: s3-model-loading
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { shouldExecuteTuneStages } from './path-prover-brain.js';

const execFileAsync = promisify(execFile);

// ── Valid Lifecycle Stages ────────────────────────────────────────────────────

/**
 * All recognized lifecycle stages for the prove pipeline.
 * The "stage" step pre-stages model weights from HuggingFace to S3.
 */
export const VALID_LIFECYCLE_STAGES = [
    'generate',
    'stage',
    'build',
    'push',
    'deploy',
    'test',
    'tune',
    'adapter',
    'test-adapter',
    'benchmark',
    'register',
    'clean'
];

// ── Prove State (Idempotency) ────────────────────────────────────────────────

/**
 * Load the prove state file for idempotency checks.
 *
 * @param {string} projectDir - Path to the project directory
 * @returns {object} Prove state object (stage → { status, timestamp, duration })
 */
export function loadProveState(projectDir) {
    const p = path.join(projectDir, '.mlcc', '.prove-state.json');
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

/**
 * Save a stage result to the prove state file.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {string} stage - Stage name
 * @param {object} result - StepResult object with status and duration
 */
export function saveProveState(projectDir, stage, result) {
    const p = path.join(projectDir, '.mlcc', '.prove-state.json');
    mkdirSync(path.dirname(p), { recursive: true });
    const state = loadProveState(projectDir);
    state[stage] = { status: result.status, timestamp: Date.now(), duration: result.duration };
    if (result.error) state[stage].error = result.error;
    writeFileSync(p, JSON.stringify(state, null, 2));
}

/**
 * Possible staging states for status output.
 */
export const STAGING_STATES = {
    STAGED: 'staged',
    NOT_STAGED: 'not-staged',
    STAGE_FAILED: 'stage-failed'
};

// ── Stage Lifecycle Step ─────────────────────────────────────────────────────

/**
 * Check if a model has already been staged by looking for `.mlcc/staged-assets.json`.
 *
 * @param {string} projectDir - Path to the generated project directory
 * @returns {boolean} True if the model has already been staged
 */
export function isAlreadyStaged(projectDir) {
    const stagedAssetsPath = path.join(projectDir, '.mlcc', 'staged-assets.json');
    if (!existsSync(stagedAssetsPath)) {
        return false;
    }

    try {
        const content = readFileSync(stagedAssetsPath, 'utf8');
        const data = JSON.parse(content);
        // Check that there's a valid staged URI
        return !!(data?.models?.default?.staged_uri);
    } catch {
        return false;
    }
}

/**
 * Get the current staging state for a project.
 *
 * @param {string} projectDir - Path to the generated project directory
 * @param {object} [stepResults] - Previous step results (to check for stage-failed)
 * @returns {string} One of: 'staged', 'not-staged', 'stage-failed'
 */
export function getStagingState(projectDir, stepResults = null) {
    // Check if stage previously failed
    if (stepResults?.stage?.status === 'fail') {
        return STAGING_STATES.STAGE_FAILED;
    }

    if (isAlreadyStaged(projectDir)) {
        return STAGING_STATES.STAGED;
    }

    return STAGING_STATES.NOT_STAGED;
}

/**
 * Execute the stage lifecycle step with idempotency support.
 *
 * If the model is already staged (`.mlcc/staged-assets.json` exists with a valid URI),
 * the step is skipped and marked as passed.
 *
 * If `do/stage` exits non-zero, the model is marked as stage-failed.
 *
 * @param {string} projectDir - Path to the generated project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=1800] - Timeout in seconds (default: 30 minutes)
 * @param {boolean} [options.verbose=false] - Stream stdout/stderr in real time
 * @returns {Promise<object>} StepResult with name, status, duration, stagingState, and optional error
 */
export async function executeStageStep(projectDir, options = {}) {
    const { timeout = 1800, verbose = false } = options;
    const startTime = Date.now();

    // Idempotency check: skip if already staged (Requirement 5.4)
    if (isAlreadyStaged(projectDir)) {
        return {
            name: 'stage',
            status: 'pass',
            duration: Date.now() - startTime,
            stagingState: STAGING_STATES.STAGED,
            skipped: true,
            message: '✓ Model already staged — skipping'
        };
    }

    // Execute do/stage and verify exit code 0 (Requirement 5.2)
    const command = './do/stage';

    try {
        if (verbose) {
            // Verbose: stream output in real time
            const { spawn } = await import('node:child_process');
            const result = await new Promise((resolve) => {
                const child = spawn('bash', ['-c', command], {
                    cwd: projectDir,
                    stdio: ['pipe', 'inherit', 'inherit']
                });

                let killed = false;
                const timer = setTimeout(() => {
                    killed = true;
                    child.kill('SIGTERM');
                }, timeout * 1000);

                child.on('close', (code) => {
                    clearTimeout(timer);
                    if (code === 0) {
                        resolve({
                            name: 'stage',
                            status: 'pass',
                            duration: Date.now() - startTime,
                            stagingState: STAGING_STATES.STAGED
                        });
                    } else {
                        const error = killed
                            ? `Timeout after ${timeout}s`
                            : `do/stage exited with code ${code}`;
                        resolve({
                            name: 'stage',
                            status: 'fail',
                            duration: Date.now() - startTime,
                            stagingState: STAGING_STATES.STAGE_FAILED,
                            error
                        });
                    }
                });

                child.on('error', (err) => {
                    clearTimeout(timer);
                    resolve({
                        name: 'stage',
                        status: 'fail',
                        duration: Date.now() - startTime,
                        stagingState: STAGING_STATES.STAGE_FAILED,
                        error: err.message.slice(-500)
                    });
                });
            });
            return result;
        }

        // Non-verbose: buffer output
        await execFileAsync('bash', ['-c', command], {
            cwd: projectDir,
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024
        });

        return {
            name: 'stage',
            status: 'pass',
            duration: Date.now() - startTime,
            stagingState: STAGING_STATES.STAGED
        };
    } catch (err) {
        // Mark model as failed if staging fails (Requirement 5.3)
        const error = err.killed
            ? `Timeout after ${timeout}s`
            : (err.stderr || err.message).slice(-500);

        return {
            name: 'stage',
            status: 'fail',
            duration: Date.now() - startTime,
            stagingState: STAGING_STATES.STAGE_FAILED,
            error
        };
    }
}

// ── Stage Validation ─────────────────────────────────────────────────────────

/**
 * Validate that a lifecycle stage name is recognized by the prove pipeline.
 *
 * @param {string} stageName - The stage name to validate
 * @returns {boolean} True if the stage is valid
 */
export function isValidLifecycleStage(stageName) {
    return VALID_LIFECYCLE_STAGES.includes(stageName);
}

/**
 * Validate a stages array from validation-targets configuration.
 *
 * @param {string[]} stages - Array of stage names
 * @returns {object} Validation result: { valid: boolean, errors: string[] }
 */
export function validateStagesArray(stages) {
    const errors = [];

    if (!Array.isArray(stages)) {
        return { valid: false, errors: ['stages must be an array'] };
    }

    if (stages.length === 0) {
        return { valid: false, errors: ['stages array must not be empty'] };
    }

    for (const stage of stages) {
        if (typeof stage !== 'string') {
            errors.push(`Invalid stage type: expected string, got ${typeof stage}`);
            continue;
        }
        if (!isValidLifecycleStage(stage)) {
            errors.push(`Unrecognized lifecycle stage: "${stage}"`);
        }
    }

    return { valid: errors.length === 0, errors };
}

// ── Status Output ────────────────────────────────────────────────────────────

/**
 * Format the staging state for status output display.
 *
 * @param {string} state - One of STAGING_STATES values
 * @returns {string} Formatted status string with emoji
 */
export function formatStagingStatus(state) {
    switch (state) {
    case STAGING_STATES.STAGED:
        return '✓ staged';
    case STAGING_STATES.NOT_STAGED:
        return '○ not-staged';
    case STAGING_STATES.STAGE_FAILED:
        return '✗ stage-failed';
    default:
        return '? unknown';
    }
}

/**
 * Build a status summary for a prove target including staging state.
 *
 * @param {object} target - The validation target
 * @param {string} target.model_name - Model name
 * @param {string} projectDir - Path to the project directory
 * @param {object} [stepResults] - Results of executed steps
 * @returns {object} Status summary including stagingState
 */
export function buildTargetStatus(target, projectDir, stepResults = null) {
    const stagingState = getStagingState(projectDir, stepResults);
    const stages = target.stages || [];
    const includesStage = stages.includes('stage');

    return {
        model_name: target.model_name,
        stagingState,
        stagingStatus: formatStagingStatus(stagingState),
        includesStageStep: includesStage
    };
}

// ── Lifecycle Executors ──────────────────────────────────────────────────────

/**
 * Execute a lifecycle command with standard timeout/verbose/idempotency handling.
 * Internal helper used by all stage executors.
 *
 * @param {string} stageName - Stage name for result reporting
 * @param {string} command - Shell command to execute
 * @param {string} projectDir - Path to the project directory
 * @param {object} options - Execution options
 * @param {number} options.timeout - Timeout in seconds
 * @param {boolean} options.verbose - Stream stdout/stderr in real time
 * @param {boolean} [options.skipIdempotency=false] - Skip prove-state check
 * @returns {Promise<object>} StepResult
 */
async function executeLifecycleCommand(stageName, command, projectDir, options) {
    const { timeout, verbose = false, skipIdempotency = false } = options;
    const startTime = Date.now();

    // Idempotency check via .prove-state.json
    if (!skipIdempotency) {
        const state = loadProveState(projectDir);
        if (state[stageName]?.status === 'pass') {
            return {
                name: stageName,
                status: 'pass',
                duration: Date.now() - startTime,
                skipped: true,
                message: `✓ ${stageName} already passed — skipping`
            };
        }
    }

    try {
        if (verbose) {
            const { spawn } = await import('node:child_process');
            const result = await new Promise((resolve) => {
                const child = spawn('bash', ['-c', command], {
                    cwd: projectDir,
                    stdio: ['pipe', 'inherit', 'inherit']
                });

                let killed = false;
                const timer = setTimeout(() => {
                    killed = true;
                    child.kill('SIGTERM');
                }, timeout * 1000);

                child.on('close', (code) => {
                    clearTimeout(timer);
                    const r = code === 0
                        ? { name: stageName, status: 'pass', duration: Date.now() - startTime }
                        : {
                            name: stageName, status: 'fail', duration: Date.now() - startTime,
                            error: killed ? `Timeout after ${timeout}s` : `${stageName} exited with code ${code}`
                        };
                    saveProveState(projectDir, stageName, r);
                    resolve(r);
                });

                child.on('error', (err) => {
                    clearTimeout(timer);
                    const r = { name: stageName, status: 'fail', duration: Date.now() - startTime, error: err.message.slice(-500) };
                    saveProveState(projectDir, stageName, r);
                    resolve(r);
                });
            });
            return result;
        }

        // Non-verbose: buffer output
        await execFileAsync('bash', ['-c', command], {
            cwd: projectDir,
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024
        });

        const result = { name: stageName, status: 'pass', duration: Date.now() - startTime };
        saveProveState(projectDir, stageName, result);
        return result;
    } catch (err) {
        const error = err.killed
            ? `Timeout after ${timeout}s`
            : (err.stderr || err.message).slice(-500);
        const result = { name: stageName, status: 'fail', duration: Date.now() - startTime, error };
        saveProveState(projectDir, stageName, result);
        return result;
    }
}

/**
 * Execute the generate step — invokes `mcc` CLI with --skip-prompts and config flags.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=120] - Timeout in seconds
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @param {object} [options.config] - Prove config with base fields for CLI flags
 * @returns {Promise<object>} StepResult
 */
export async function executeGenerateStep(projectDir, options = {}) {
    const { timeout = 120, verbose = false, config = {} } = options;
    const startTime = Date.now();

    // Resolve the mcc/ml-container-creator binary path.
    // execFileAsync doesn't source shell profiles so nvm-managed node bins
    // may not be in PATH. Prefer the absolute path next to this module file.
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { existsSync } = await import('node:fs');
    const __dir = dirname(fileURLToPath(import.meta.url));
    // Package root bin directory (two levels up from src/lib/)
    const pkgRoot = resolve(__dir, '..', '..');
    const mccBin = resolve(pkgRoot, 'bin', 'cli.js');
    // Prefer direct node invocation to avoid PATH lookup issues
    const mccCommand = existsSync(mccBin) ? 'node' : 'mcc';
    const mccArgs = existsSync(mccBin) ? [mccBin] : [];

    // Idempotency check
    const state = loadProveState(projectDir);
    if (state.generate?.status === 'pass') {
        return {
            name: 'generate',
            status: 'pass',
            duration: Date.now() - startTime,
            skipped: true,
            message: '✓ generate already passed — skipping'
        };
    }

    // Build CLI flags from config
    const flags = ['--skip-prompts'];
    if (config.model_name) flags.push(`--model-name=${config.model_name}`);
    if (config.deployment_config) flags.push(`--deployment-config=${config.deployment_config}`);
    if (config.instance_type) flags.push(`--instance-type=${config.instance_type}`);
    if (config.max_model_len) flags.push(`--max-model-len=${config.max_model_len}`);
    if (config.enable_lora) flags.push('--enable-lora');
    // Note: quantization is a serving-time parameter, not a generation-time CLI flag.
    // It gets written to do/ic/default.conf after generation (see post-generate block below).
    // Tell the generator to output files into projectDir directly (not create a subdirectory)
    flags.push(`--project-dir=${projectDir}`);
    // Force overwrite in case of a resume (directory already exists from a prior partial run)
    flags.push('--force');

    const cmdArgs = [...mccArgs, ...flags];

    // Post-generation: write serving-time config overrides to do/ic/default.conf
    // These are not generation flags but need to be set before deploy.
    const _writeServingConfig = async () => {
        const icConfPath = path.join(projectDir, 'do', 'ic', 'default.conf');
        if (config.quantization && existsSync(icConfPath)) {
            const { readFileSync, appendFileSync } = await import('node:fs');
            const current = readFileSync(icConfPath, 'utf8');
            if (!current.includes('IC_ENV_VLLM_QUANTIZATION')) {
                appendFileSync(icConfPath, `\nexport IC_ENV_VLLM_QUANTIZATION="${config.quantization}"\n`);
            }
        }
    };

    try {
        if (verbose) {
            const { spawn } = await import('node:child_process');
            const result = await new Promise((resolve) => {
                const child = spawn(mccCommand, cmdArgs, {
                    cwd: projectDir,
                    stdio: ['pipe', 'inherit', 'inherit']
                });

                let killed = false;
                const timer = setTimeout(() => {
                    killed = true;
                    child.kill('SIGTERM');
                }, timeout * 1000);

                child.on('close', (code) => {
                    clearTimeout(timer);
                    let r;
                    if (code === 0) {
                        _writeServingConfig();
                        r = { name: 'generate', status: 'pass', duration: Date.now() - startTime };
                    } else {
                        r = {
                            name: 'generate', status: 'fail', duration: Date.now() - startTime,
                            error: killed ? `Timeout after ${timeout}s` : `generate exited with code ${code}`
                        };
                    }
                    saveProveState(projectDir, 'generate', r);
                    resolve(r);
                });

                child.on('error', (err) => {
                    clearTimeout(timer);
                    const r = { name: 'generate', status: 'fail', duration: Date.now() - startTime, error: err.message.slice(-500) };
                    saveProveState(projectDir, 'generate', r);
                    resolve(r);
                });
            });
            return result;
        }

        await execFileAsync(mccCommand, cmdArgs, {
            cwd: projectDir,
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024
        });
        await _writeServingConfig();

        const result = { name: 'generate', status: 'pass', duration: Date.now() - startTime };
        saveProveState(projectDir, 'generate', result);
        return result;
    } catch (err) {
        const error = err.killed
            ? `Timeout after ${timeout}s`
            : (err.stderr || err.message).slice(-500);
        const result = { name: 'generate', status: 'fail', duration: Date.now() - startTime, error };
        saveProveState(projectDir, 'generate', result);
        return result;
    }
}

/**
 * Execute the build step — runs `./do/build`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=1800] - Timeout in seconds (default: 30 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeBuildStep(projectDir, options = {}) {
    const { timeout = 1800, verbose = false } = options;
    return executeLifecycleCommand('build', './do/build', projectDir, { timeout, verbose });
}

/**
 * Execute the push step — runs `./do/push`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=600] - Timeout in seconds (default: 10 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executePushStep(projectDir, options = {}) {
    const { timeout = 600, verbose = false } = options;
    return executeLifecycleCommand('push', './do/push', projectDir, { timeout, verbose });
}

/**
 * Execute the deploy step — runs `./do/deploy`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=1800] - Timeout in seconds (default: 30 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeDeployStep(projectDir, options = {}) {
    const { timeout = 1800, verbose = false } = options;
    return executeLifecycleCommand('deploy', './do/deploy', projectDir, { timeout, verbose });
}

/**
 * Execute the test step — runs `./do/test`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=300] - Timeout in seconds (default: 5 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeTestStep(projectDir, options = {}) {
    const { timeout = 300, verbose = false } = options;
    return executeLifecycleCommand('test', './do/test', projectDir, { timeout, verbose });
}

/**
 * Execute the tune step — runs `./do/tune`.
 * Gated by `shouldExecuteTuneStages()` from path-prover-brain.js.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=7200] - Timeout in seconds (default: 2 hours)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @param {object} [options.config] - Prove config for tune gating check
 * @returns {Promise<object>} StepResult
 */
export async function executeTuneStep(projectDir, options = {}) {
    const { timeout = 7200, verbose = false, config = {} } = options;

    // Gate check: skip if tuning is not requested
    if (!shouldExecuteTuneStages(config)) {
        return {
            name: 'tune',
            status: 'pass',
            duration: 0,
            skipped: true,
            message: '✓ tune not requested — skipping'
        };
    }

    return executeLifecycleCommand('tune', './do/tune', projectDir, { timeout, verbose });
}

/**
 * Execute the adapter step — runs `./do/adapter add tuned-sft --from-tune`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=900] - Timeout in seconds (default: 15 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeAdapterStep(projectDir, options = {}) {
    const { timeout = 900, verbose = false } = options;
    return executeLifecycleCommand('adapter', './do/adapter add tuned-sft --from-tune', projectDir, { timeout, verbose });
}

/**
 * Execute the test-adapter step — runs `./do/test`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=300] - Timeout in seconds (default: 5 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeTestAdapterStep(projectDir, options = {}) {
    const { timeout = 300, verbose = false } = options;
    return executeLifecycleCommand('test-adapter', './do/test', projectDir, { timeout, verbose });
}

/**
 * Execute the benchmark step — runs `./do/benchmark --workload multi_turn_chat`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=3600] - Timeout in seconds (default: 1 hour)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeBenchmarkStep(projectDir, options = {}) {
    const { timeout = 3600, verbose = false } = options;
    return executeLifecycleCommand('benchmark', './do/benchmark --workload multi_turn_chat', projectDir, { timeout, verbose });
}

/**
 * Execute the register step — runs `./do/register`.
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=300] - Timeout in seconds (default: 5 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeRegisterStep(projectDir, options = {}) {
    const { timeout = 300, verbose = false } = options;
    return executeLifecycleCommand('register', './do/register', projectDir, { timeout, verbose });
}

/**
 * Execute the clean step — runs `./do/clean all`.
 * NOTE: This should always run even if prior steps failed (controlled by caller).
 *
 * @param {string} projectDir - Path to the project directory
 * @param {object} [options] - Execution options
 * @param {number} [options.timeout=600] - Timeout in seconds (default: 10 minutes)
 * @param {boolean} [options.verbose=false] - Stream output in real time
 * @returns {Promise<object>} StepResult
 */
export async function executeCleanStep(projectDir, options = {}) {
    const { timeout = 600, verbose = false } = options;
    return executeLifecycleCommand('clean', './do/clean all', projectDir, { timeout, verbose });
}

// ── Stage Executor Registry ──────────────────────────────────────────────────

/**
 * Map of stage names to their executor functions.
 * Used by prove-command-handler to dispatch stages dynamically.
 */
export const STAGE_EXECUTORS = {
    generate: executeGenerateStep,
    stage: executeStageStep,
    build: executeBuildStep,
    push: executePushStep,
    deploy: executeDeployStep,
    test: executeTestStep,
    tune: executeTuneStep,
    adapter: executeAdapterStep,
    'test-adapter': executeTestAdapterStep,
    benchmark: executeBenchmarkStep,
    register: executeRegisterStep,
    clean: executeCleanStep
};
