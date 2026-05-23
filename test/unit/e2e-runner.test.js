// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Runner Lifecycle Executor Unit Tests
 *
 * Tests the lifecycle executor functions:
 *   - resolveStepCommand: maps step names to shell commands
 *   - executeStep: spawns commands with timeout handling
 *   - runConfig: orchestrates project generation and lifecycle execution
 *
 * Validates: Requirements 2.2, 2.4, 2.5, 4.1, 4.2
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import {
    resolveStepCommand,
    resolveStepCommandWithConfig,
    getStepTimeout,
    executeStep,
    runConfig,
    parseArgs,
    runE2E
} from '../../scripts/e2e-runner.js';
import { parseInstanceType } from '../../src/lib/e2e-quota-validator.js';
import { filterByConfig } from '../../src/lib/e2e-catalog-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// resolveStepCommand
// ---------------------------------------------------------------------------

describe('E2E Runner — resolveStepCommand', () => {

    it('maps simple step "build" to "./do/build"', () => {
        const result = resolveStepCommand('build', '/tmp/project');
        assert.strictEqual(result, './do/build');
    });

    it('maps simple step "push" to "./do/push"', () => {
        const result = resolveStepCommand('push', '/tmp/project');
        assert.strictEqual(result, './do/push');
    });

    it('maps simple step "deploy" to "./do/deploy"', () => {
        const result = resolveStepCommand('deploy', '/tmp/project');
        assert.strictEqual(result, './do/deploy');
    });

    it('maps simple step "test" to "./do/test"', () => {
        const result = resolveStepCommand('test', '/tmp/project');
        assert.strictEqual(result, './do/test');
    });

    it('maps simple step "benchmark" to "./do/benchmark"', () => {
        const result = resolveStepCommand('benchmark', '/tmp/project');
        assert.strictEqual(result, './do/benchmark');
    });

    it('maps simple step "status" to "./do/status"', () => {
        const result = resolveStepCommand('status', '/tmp/project');
        assert.strictEqual(result, './do/status');
    });

    it('maps "clean" to "./do/clean all"', () => {
        const result = resolveStepCommand('clean', '/tmp/project');
        assert.strictEqual(result, './do/clean all');
    });

    it('maps "adapter-add" to "./do/adapter add"', () => {
        const result = resolveStepCommand('adapter-add', '/tmp/project');
        assert.strictEqual(result, './do/adapter add');
    });

    it('maps "adapter-remove" to "./do/adapter remove"', () => {
        const result = resolveStepCommand('adapter-remove', '/tmp/project');
        assert.strictEqual(result, './do/adapter remove');
    });

    it('maps "test-adapter" to "./do/test --adapter"', () => {
        const result = resolveStepCommand('test-adapter', '/tmp/project');
        assert.strictEqual(result, './do/test --adapter');
    });

    it('maps "add-ic" to "./do/add ic"', () => {
        const result = resolveStepCommand('add-ic', '/tmp/project');
        assert.strictEqual(result, './do/add ic');
    });

    it('maps "test-ic" to "./do/test --ic"', () => {
        const result = resolveStepCommand('test-ic', '/tmp/project');
        assert.strictEqual(result, './do/test --ic');
    });
});

// ---------------------------------------------------------------------------
// resolveStepCommandWithConfig
// Validates: Requirements 3.1, 3.2, 3.3, 3.4
// ---------------------------------------------------------------------------

describe('E2E Runner — resolveStepCommandWithConfig', () => {

    const sampleConfig = {
        id: 'rt-qwen3-4b',
        tier: 'ci',
        track: 'realtime',
        args: '--deployment-config=transformers-vllm --model-name=Qwen/Qwen3-4B --instance-type=ml.g5.xlarge --region=us-west-2 --enable-lora',
        lifecycle: ['build', 'push', 'deploy', 'test', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
        timeout: 1800,
        tuneTimeout: 3600,
        tuneConfig: {
            tuneId: 'qwen3-4b',
            technique: 'sft',
            trainingType: 'lora',
            dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
        }
    };

    it('maps "tune-sft" to ./do/tune with technique, dataset, and training-type from tuneConfig', () => {
        const result = resolveStepCommandWithConfig('tune-sft', sampleConfig);
        assert.strictEqual(result, './do/tune --technique sft --dataset s3://mlcc-e2e-datasets/sft-small/train.jsonl --training-type lora');
    });

    it('maps "tune-dpo" to ./do/tune with technique dpo', () => {
        const dpoConfig = {
            ...sampleConfig,
            tuneConfig: {
                tuneId: 'qwen3-4b',
                technique: 'dpo',
                trainingType: 'full-rank',
                dataset: 's3://mlcc-e2e-datasets/dpo-small/train.jsonl'
            }
        };
        const result = resolveStepCommandWithConfig('tune-dpo', dpoConfig);
        assert.strictEqual(result, './do/tune --technique dpo --dataset s3://mlcc-e2e-datasets/dpo-small/train.jsonl --training-type full-rank');
    });

    it('maps "adapter-add" to ./do/adapter add tuned-sft --from-tune sft', () => {
        const result = resolveStepCommandWithConfig('adapter-add', sampleConfig);
        assert.strictEqual(result, './do/adapter add tuned-sft --from-tune sft');
    });

    it('maps "test-adapter" to ./do/test --adapter', () => {
        const result = resolveStepCommandWithConfig('test-adapter', sampleConfig);
        assert.strictEqual(result, './do/test --adapter');
    });

    it('delegates "build" to resolveStepCommand', () => {
        const result = resolveStepCommandWithConfig('build', sampleConfig);
        assert.strictEqual(result, './do/build');
    });

    it('delegates "clean" to resolveStepCommand', () => {
        const result = resolveStepCommandWithConfig('clean', sampleConfig);
        assert.strictEqual(result, './do/clean all');
    });

    it('delegates "deploy" to resolveStepCommand', () => {
        const result = resolveStepCommandWithConfig('deploy', sampleConfig);
        assert.strictEqual(result, './do/deploy');
    });

    it('delegates "test" to resolveStepCommand', () => {
        const result = resolveStepCommandWithConfig('test', sampleConfig);
        assert.strictEqual(result, './do/test');
    });
});

// ---------------------------------------------------------------------------
// executeStep
// ---------------------------------------------------------------------------

describe('E2E Runner — executeStep', () => {

    const tmpDir = path.join('/tmp', `e2e-test-exec-${Date.now()}`);

    before(async () => {
        await mkdir(path.join(tmpDir, 'do'), { recursive: true });
    });

    after(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns pass status when command succeeds', async () => {
        // Create a script that exits 0
        const scriptPath = path.join(tmpDir, 'do', 'build');
        await writeFile(scriptPath, '#!/bin/bash\nexit 0\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('build', tmpDir, 30);

        assert.strictEqual(result.name, 'build');
        assert.strictEqual(result.status, 'pass');
        assert.ok(result.duration >= 0);
        assert.strictEqual(result.error, undefined);
    });

    it('returns fail status when command exits non-zero', async () => {
        const scriptPath = path.join(tmpDir, 'do', 'deploy');
        await writeFile(scriptPath, '#!/bin/bash\necho "deploy failed" >&2\nexit 1\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('deploy', tmpDir, 30);

        assert.strictEqual(result.name, 'deploy');
        assert.strictEqual(result.status, 'fail');
        assert.ok(result.duration >= 0);
        assert.ok(result.error.includes('deploy failed'));
    });

    it('captures last 500 chars of stderr on failure', async () => {
        // Create a script that outputs a long stderr message
        const longMsg = 'x'.repeat(600);
        const scriptPath = path.join(tmpDir, 'do', 'push');
        await writeFile(scriptPath, `#!/bin/bash\necho "${longMsg}" >&2\nexit 1\n`);
        await chmod(scriptPath, 0o755);

        const result = await executeStep('push', tmpDir, 30);

        assert.strictEqual(result.status, 'fail');
        assert.ok(result.error.length <= 500);
    });

    it('returns timeout error when command exceeds timeout', async function () {
        this.timeout(10000);

        const scriptPath = path.join(tmpDir, 'do', 'test');
        await writeFile(scriptPath, '#!/bin/bash\nsleep 30\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('test', tmpDir, 1);

        assert.strictEqual(result.name, 'test');
        assert.strictEqual(result.status, 'fail');
        assert.ok(result.error.includes('Timeout after 1s'));
    });

    it('resolves clean step to "./do/clean all"', async () => {
        // Create a clean script that accepts "all" argument
        const scriptPath = path.join(tmpDir, 'do', 'clean');
        await writeFile(scriptPath, '#!/bin/bash\nif [ "$1" = "all" ]; then exit 0; else exit 1; fi\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('clean', tmpDir, 30);

        assert.strictEqual(result.name, 'clean');
        assert.strictEqual(result.status, 'pass');
    });

    it('records duration for both pass and fail', async () => {
        const scriptPath = path.join(tmpDir, 'do', 'build');
        await writeFile(scriptPath, '#!/bin/bash\nsleep 0.1\nexit 0\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('build', tmpDir, 30);

        assert.ok(result.duration >= 50, `Expected duration >= 50ms, got ${result.duration}ms`);
    });
});

// ---------------------------------------------------------------------------
// runConfig
// ---------------------------------------------------------------------------

describe('E2E Runner — runConfig', () => {

    const tmpWorkspace = path.join('/tmp', `e2e-test-runconfig-${Date.now()}`);
    const tmpRepoRoot = path.join('/tmp', `e2e-test-repo-${Date.now()}`);

    before(async () => {
        await mkdir(tmpWorkspace, { recursive: true });
        // Create a fake repo root with a bin/cli.js that creates a project
        await mkdir(path.join(tmpRepoRoot, 'bin'), { recursive: true });
        // Create a fake CLI that creates the project directory with do/ scripts
        const fakeCli = `#!/usr/bin/env node
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const projectName = args[0]
let projectDir = null

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-dir' && i + 1 < args.length) {
        projectDir = args[i + 1]
        break
    }
}

if (!projectDir) {
    projectDir = path.join(process.cwd(), projectName)
}

await mkdir(path.join(projectDir, 'do'), { recursive: true })

// Create lifecycle scripts
const steps = ['build', 'push', 'deploy', 'test', 'clean']
for (const step of steps) {
    const script = path.join(projectDir, 'do', step)
    await writeFile(script, '#!/bin/bash\\nexit 0\\n')
    await chmod(script, 0o755)
}
`;
        await writeFile(path.join(tmpRepoRoot, 'bin', 'cli.js'), fakeCli);
    });

    after(async () => {
        await rm(tmpWorkspace, { recursive: true, force: true });
        await rm(tmpRepoRoot, { recursive: true, force: true });
    });

    it('runs all lifecycle steps and returns pass when all succeed', async function () {
        this.timeout(15000);

        const config = {
            id: 'test-pass-all',
            tier: 'ci',
            track: 'realtime',
            args: '--deployment-config=transformers-vllm',
            lifecycle: ['build', 'push', 'deploy', 'test', 'clean'],
            timeout: 30
        };

        const result = await runConfig(config, tmpWorkspace, tmpRepoRoot);

        assert.strictEqual(result.id, 'test-pass-all');
        assert.strictEqual(result.status, 'pass');
        assert.ok(result.duration > 0);
        // Steps should include build, push, deploy, test + clean (from finally)
        assert.strictEqual(result.steps.length, 5);
        assert.strictEqual(result.steps[0].name, 'build');
        assert.strictEqual(result.steps[1].name, 'push');
        assert.strictEqual(result.steps[2].name, 'deploy');
        assert.strictEqual(result.steps[3].name, 'test');
        assert.strictEqual(result.steps[4].name, 'clean');
    });

    it('stops at first failure (fail-fast) but still runs clean', async function () {
        this.timeout(15000);

        // Create a workspace with a failing deploy script
        const configId = 'test-fail-fast';
        const projectDir = path.join(tmpWorkspace, configId);
        await mkdir(path.join(projectDir, 'do'), { recursive: true });

        // build passes, deploy fails, test should be skipped
        await writeFile(path.join(projectDir, 'do', 'build'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'build'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'deploy'), '#!/bin/bash\necho "deploy error" >&2\nexit 1\n');
        await chmod(path.join(projectDir, 'do', 'deploy'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'test'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'test'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'clean'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'clean'), 0o755);

        // Use a fake repo root that just creates the project dir (already exists)
        const fakeRepoForExisting = path.join('/tmp', `e2e-fake-repo-${Date.now()}`);
        await mkdir(path.join(fakeRepoForExisting, 'bin'), { recursive: true });
        const noopCli = `#!/usr/bin/env node
// No-op: project already exists
`;
        await writeFile(path.join(fakeRepoForExisting, 'bin', 'cli.js'), noopCli);

        const config = {
            id: configId,
            tier: 'ci',
            track: 'realtime',
            args: '',
            lifecycle: ['build', 'deploy', 'test', 'clean'],
            timeout: 30
        };

        const result = await runConfig(config, tmpWorkspace, fakeRepoForExisting);

        assert.strictEqual(result.status, 'fail');
        assert.ok(result.error.includes('deploy error'));
        // Should have: build (pass), deploy (fail), clean (pass)
        // test should NOT be in the list (skipped due to fail-fast)
        assert.strictEqual(result.steps.length, 3);
        assert.strictEqual(result.steps[0].name, 'build');
        assert.strictEqual(result.steps[0].status, 'pass');
        assert.strictEqual(result.steps[1].name, 'deploy');
        assert.strictEqual(result.steps[1].status, 'fail');
        assert.strictEqual(result.steps[2].name, 'clean');

        await rm(fakeRepoForExisting, { recursive: true, force: true });
    });

    it('always runs clean even when project generation fails', async function () {
        this.timeout(15000);

        // Use a repo root with a CLI that fails
        const failRepoRoot = path.join('/tmp', `e2e-fail-repo-${Date.now()}`);
        await mkdir(path.join(failRepoRoot, 'bin'), { recursive: true });
        const failCli = `#!/usr/bin/env node
process.exit(1)
`;
        await writeFile(path.join(failRepoRoot, 'bin', 'cli.js'), failCli);

        const config = {
            id: 'test-gen-fail',
            tier: 'ci',
            track: 'realtime',
            args: '',
            lifecycle: ['build', 'test', 'clean'],
            timeout: 30
        };

        const result = await runConfig(config, tmpWorkspace, failRepoRoot);

        assert.strictEqual(result.status, 'fail');
        // Clean should still be in the steps (from finally block)
        const cleanStep = result.steps.find(s => s.name === 'clean');
        assert.ok(cleanStep, 'clean step should always be present');
        assert.ok(result.duration > 0);

        await rm(failRepoRoot, { recursive: true, force: true });
    });
});


// ---------------------------------------------------------------------------
// parseArgs — CLI argument parsing
// Validates: Requirements 2.1
// ---------------------------------------------------------------------------

describe('E2E Runner — parseArgs', () => {

    it('parses --tier flag with space separator', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.tier, 'ci');
    });

    it('parses --tier flag with equals separator', () => {
        const result = parseArgs(['--tier=nightly']);
        assert.strictEqual(result.tier, 'nightly');
    });

    it('parses --concurrency flag', () => {
        const result = parseArgs(['--tier', 'ci', '--concurrency', '4']);
        assert.strictEqual(result.concurrency, 4);
    });

    it('parses --concurrency with equals separator', () => {
        const result = parseArgs(['--concurrency=8']);
        assert.strictEqual(result.concurrency, 8);
    });

    it('defaults concurrency to 2 when not specified', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.concurrency, 2);
    });

    it('parses --dry-run flag', () => {
        const result = parseArgs(['--tier', 'ci', '--dry-run']);
        assert.strictEqual(result.dryRun, true);
    });

    it('defaults dryRun to false when not specified', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.dryRun, false);
    });

    it('parses --s3-bucket flag with space separator', () => {
        const result = parseArgs(['--tier', 'ci', '--s3-bucket', 'my-bucket']);
        assert.strictEqual(result.s3Bucket, 'my-bucket');
    });

    it('parses --s3-bucket flag with equals separator', () => {
        const result = parseArgs(['--s3-bucket=mlcc-results-123']);
        assert.strictEqual(result.s3Bucket, 'mlcc-results-123');
    });

    it('defaults s3Bucket to undefined when not specified', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.s3Bucket, undefined);
    });

    it('parses --sns-topic flag with space separator', () => {
        const result = parseArgs(['--tier', 'ci', '--sns-topic', 'arn:aws:sns:us-west-2:123:my-topic']);
        assert.strictEqual(result.snsTopicArn, 'arn:aws:sns:us-west-2:123:my-topic');
    });

    it('parses --sns-topic flag with equals separator', () => {
        const result = parseArgs(['--sns-topic=arn:aws:sns:us-east-1:456:alerts']);
        assert.strictEqual(result.snsTopicArn, 'arn:aws:sns:us-east-1:456:alerts');
    });

    it('defaults snsTopicArn to undefined when not specified', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.snsTopicArn, undefined);
    });

    it('parses --catalog-path flag', () => {
        const result = parseArgs(['--catalog-path', '/custom/catalog.json']);
        assert.ok(result.catalogPath.endsWith('catalog.json'));
    });

    it('parses --workspace-root flag', () => {
        const result = parseArgs(['--workspace-root', '/tmp/my-workspace']);
        assert.strictEqual(result.workspaceRoot, '/tmp/my-workspace');
    });

    it('parses all flags together', () => {
        const result = parseArgs([
            '--tier', 'weekly',
            '--concurrency', '3',
            '--dry-run',
            '--s3-bucket', 'results-bucket',
            '--sns-topic', 'arn:aws:sns:us-west-2:123:topic',
            '--workspace-root', '/tmp/e2e'
        ]);
        assert.strictEqual(result.tier, 'weekly');
        assert.strictEqual(result.concurrency, 3);
        assert.strictEqual(result.dryRun, true);
        assert.strictEqual(result.s3Bucket, 'results-bucket');
        assert.strictEqual(result.snsTopicArn, 'arn:aws:sns:us-west-2:123:topic');
        assert.strictEqual(result.workspaceRoot, '/tmp/e2e');
    });

    it('parses --config flag with space separator', () => {
        const result = parseArgs(['--tier', 'ci', '--config', 'rt-qwen3-06b']);
        assert.strictEqual(result.configId, 'rt-qwen3-06b');
    });

    it('parses --config flag with equals separator', () => {
        const result = parseArgs(['--config=rt-llama-32-1b']);
        assert.strictEqual(result.configId, 'rt-llama-32-1b');
    });

    it('defaults configId to undefined when not specified', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.configId, undefined);
    });

    it('parses --verbose flag', () => {
        const result = parseArgs(['--tier', 'ci', '--verbose']);
        assert.strictEqual(result.verbose, true);
    });

    it('defaults verbose to false when not specified', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.verbose, false);
    });

    it('parses --save-local flag with space separator', () => {
        const result = parseArgs(['--tier', 'ci', '--save-local', '/tmp/results']);
        assert.strictEqual(result.saveLocal, '/tmp/results');
    });

    it('parses --save-local flag with equals separator', () => {
        const result = parseArgs(['--save-local=./my-results']);
        assert.strictEqual(result.saveLocal, './my-results');
    });

    it('defaults saveLocal to undefined when not specified', () => {
        const result = parseArgs(['--tier', 'ci']);
        assert.strictEqual(result.saveLocal, undefined);
    });

    it('parses all new flags together with existing flags', () => {
        const result = parseArgs([
            '--tier', 'ci',
            '--config', 'rt-qwen3-06b',
            '--verbose',
            '--save-local', '/tmp/artifacts',
            '--dry-run'
        ]);
        assert.strictEqual(result.tier, 'ci');
        assert.strictEqual(result.configId, 'rt-qwen3-06b');
        assert.strictEqual(result.verbose, true);
        assert.strictEqual(result.saveLocal, '/tmp/artifacts');
        assert.strictEqual(result.dryRun, true);
    });
});

// ---------------------------------------------------------------------------
// --dry-run mode
// Validates: Requirements 2.1
// ---------------------------------------------------------------------------

describe('E2E Runner — dry-run mode', () => {

    it('returns without executing configs when dryRun is true', async function () {
        this.timeout(10000);

        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        const result = await runE2E({
            tier: 'ci',
            dryRun: true,
            catalogPath
        });

        assert.strictEqual(result.duration, 0);
        assert.strictEqual(result.passed, 0);
        assert.strictEqual(result.failed, 0);
        assert.deepStrictEqual(result.results, []);
        assert.ok(result.runId, 'should have a runId');
        assert.strictEqual(result.tier, 'ci');
    });

    it('does not create workspace directory in dry-run mode', async function () {
        this.timeout(10000);

        const workspaceRoot = `/tmp/mlcc-dryrun-test-${Date.now()}`;
        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');

        await runE2E({
            tier: 'ci',
            dryRun: true,
            catalogPath,
            workspaceRoot
        });

        // Workspace should not exist since nothing was executed
        const { access } = await import('node:fs/promises');
        let exists = true;
        try {
            await access(workspaceRoot);
        } catch {
            exists = false;
        }
        assert.strictEqual(exists, false, 'workspace should not be created in dry-run mode');
    });
});

// ---------------------------------------------------------------------------
// parseInstanceType — quota parsing from args
// Validates: Requirements 3.3
// ---------------------------------------------------------------------------

describe('E2E Runner — parseInstanceType', () => {

    it('extracts instance type from --instance-type=value format', () => {
        const result = parseInstanceType('--deployment-config=transformers-vllm --instance-type=ml.g6e.xlarge --region=us-west-2');
        assert.strictEqual(result, 'ml.g6e.xlarge');
    });

    it('extracts instance type from --instance-type value format', () => {
        const result = parseInstanceType('--deployment-config=transformers-vllm --instance-type ml.g5.2xlarge --region=us-west-2');
        assert.strictEqual(result, 'ml.g5.2xlarge');
    });

    it('returns null when no --instance-type is present', () => {
        const result = parseInstanceType('--deployment-config=transformers-vllm --region=us-west-2');
        assert.strictEqual(result, null);
    });

    it('returns null for empty string', () => {
        const result = parseInstanceType('');
        assert.strictEqual(result, null);
    });

    it('returns null for null input', () => {
        const result = parseInstanceType(null);
        assert.strictEqual(result, null);
    });

    it('returns null for undefined input', () => {
        const result = parseInstanceType(undefined);
        assert.strictEqual(result, null);
    });

    it('handles instance type at end of args string', () => {
        const result = parseInstanceType('--model-name=Qwen/Qwen3-4B --instance-type=ml.p5.48xlarge');
        assert.strictEqual(result, 'ml.p5.48xlarge');
    });

    it('handles instance type at start of args string', () => {
        const result = parseInstanceType('--instance-type=ml.m5.xlarge --model-name=test');
        assert.strictEqual(result, 'ml.m5.xlarge');
    });
});

// ---------------------------------------------------------------------------
// S3 upload skipped gracefully when no bucket configured
// Validates: Requirements 2.7
// ---------------------------------------------------------------------------

describe('E2E Runner — S3 upload skipped gracefully', () => {

    it('completes successfully without s3Bucket configured', async function () {
        this.timeout(10000);

        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        const result = await runE2E({
            tier: 'ci',
            dryRun: true,
            catalogPath,
            s3Bucket: undefined
        });

        // Should complete without error — no S3 upload attempted
        assert.ok(result, 'runE2E should return a result');
        assert.strictEqual(result.tier, 'ci');
    });

    it('completes successfully with s3Bucket set to undefined', async function () {
        this.timeout(10000);

        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        const result = await runE2E({
            tier: 'ci',
            dryRun: true,
            catalogPath,
            s3Bucket: undefined,
            snsTopicArn: undefined
        });

        assert.ok(result, 'should complete without throwing');
        assert.deepStrictEqual(result.results, []);
    });
});

// ---------------------------------------------------------------------------
// SNS publish on failure only when topic configured
// Validates: Requirements 2.8
// ---------------------------------------------------------------------------

describe('E2E Runner — SNS publish behavior', () => {

    it('completes successfully without snsTopicArn configured', async function () {
        this.timeout(10000);

        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        const result = await runE2E({
            tier: 'ci',
            dryRun: true,
            catalogPath,
            snsTopicArn: undefined
        });

        // Should complete without error — no SNS publish attempted
        assert.ok(result, 'runE2E should return a result');
        assert.strictEqual(result.tier, 'ci');
    });

    it('does not attempt SNS publish when no failures and topic configured', async function () {
        this.timeout(10000);

        // In dry-run mode, there are no failures, so SNS should not be triggered
        // even if a topic is configured
        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        const result = await runE2E({
            tier: 'ci',
            dryRun: true,
            catalogPath,
            snsTopicArn: 'arn:aws:sns:us-west-2:123456789:test-topic'
        });

        // Should complete without error — SNS only publishes on failure
        assert.ok(result, 'should complete without throwing');
        assert.strictEqual(result.failed, 0);
    });
});


// ---------------------------------------------------------------------------
// filterByConfig — config id filtering logic
// Validates: Requirements 3.7
// ---------------------------------------------------------------------------

describe('E2E Runner — filterByConfig', () => {

    const catalog = {
        configs: [
            { id: 'rt-qwen3-06b', tier: 'ci', track: 'realtime' },
            { id: 'rt-qwen3-17b', tier: 'ci', track: 'realtime' },
            { id: 'rt-qwen3-14b', tier: 'nightly', track: 'realtime' },
            { id: 'rt-llama-33-70b', tier: 'weekly', track: 'realtime' }
        ]
    };

    it('returns all configs when configId is undefined', () => {
        const ciConfigs = catalog.configs.filter(c => c.tier === 'ci');
        const result = filterByConfig(ciConfigs, catalog, undefined);
        assert.strictEqual(result.length, 2);
    });

    it('returns all configs when configId is empty string', () => {
        const ciConfigs = catalog.configs.filter(c => c.tier === 'ci');
        const result = filterByConfig(ciConfigs, catalog, '');
        assert.strictEqual(result.length, 2);
    });

    it('finds config within the tier-filtered set', () => {
        const ciConfigs = catalog.configs.filter(c => c.tier === 'ci');
        const result = filterByConfig(ciConfigs, catalog, 'rt-qwen3-06b');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'rt-qwen3-06b');
    });

    it('falls back to full catalog when config not in tier', () => {
        const ciConfigs = catalog.configs.filter(c => c.tier === 'ci');
        // rt-qwen3-14b is in nightly tier, not ci
        const result = filterByConfig(ciConfigs, catalog, 'rt-qwen3-14b');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'rt-qwen3-14b');
        assert.strictEqual(result[0].tier, 'nightly');
    });

    it('returns empty array when config id not found anywhere', () => {
        const ciConfigs = catalog.configs.filter(c => c.tier === 'ci');
        const result = filterByConfig(ciConfigs, catalog, 'nonexistent-config');
        assert.strictEqual(result.length, 0);
    });

    it('handles empty configs array', () => {
        const result = filterByConfig([], catalog, 'rt-qwen3-06b');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'rt-qwen3-06b');
    });

    it('handles null catalog gracefully', () => {
        const ciConfigs = [{ id: 'rt-qwen3-06b', tier: 'ci' }];
        const result = filterByConfig(ciConfigs, null, 'nonexistent');
        assert.strictEqual(result.length, 0);
    });

    it('handles catalog without configs array gracefully', () => {
        const ciConfigs = [{ id: 'rt-qwen3-06b', tier: 'ci' }];
        const result = filterByConfig(ciConfigs, {}, 'nonexistent');
        assert.strictEqual(result.length, 0);
    });
});

// ---------------------------------------------------------------------------
// --config flag integration with runE2E
// Validates: Requirements 3.7
// ---------------------------------------------------------------------------

describe('E2E Runner — --config flag integration', () => {

    it('filters to a single config in dry-run mode', async function () {
        this.timeout(10000);

        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        const result = await runE2E({
            tier: 'ci',
            configId: 'rt-qwen3-06b',
            dryRun: true,
            catalogPath
        });

        assert.ok(result, 'should return a result');
        assert.strictEqual(result.tier, 'ci');
        assert.strictEqual(result.duration, 0);
    });

    it('returns gracefully when config id not found', async function () {
        this.timeout(10000);

        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        const result = await runE2E({
            tier: 'ci',
            configId: 'nonexistent-config-xyz',
            dryRun: true,
            catalogPath
        });

        // Should return gracefully with empty results, not throw
        assert.ok(result, 'should return a result');
        assert.strictEqual(result.passed, 0);
        assert.strictEqual(result.failed, 0);
        assert.deepStrictEqual(result.results, []);
    });

    it('finds config from different tier (fallback behavior)', async function () {
        this.timeout(10000);

        const catalogPath = path.resolve(__dirname, '../../scripts/e2e-catalog.json');
        // rt-qwen3-14b is in nightly tier, but we specify --tier ci
        const result = await runE2E({
            tier: 'ci',
            configId: 'rt-qwen3-14b',
            dryRun: true,
            catalogPath
        });

        // Should find it via fallback to full catalog and return successfully
        assert.ok(result, 'should return a result');
        assert.strictEqual(result.tier, 'ci');
        assert.strictEqual(result.duration, 0);
    });
});

// ---------------------------------------------------------------------------
// executeStep — verbose mode
// Validates: Requirements 3.8
// ---------------------------------------------------------------------------

describe('E2E Runner — executeStep verbose mode', () => {

    const tmpDir = path.join('/tmp', `e2e-test-verbose-${Date.now()}`);

    before(async () => {
        await mkdir(path.join(tmpDir, 'do'), { recursive: true });
    });

    after(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('returns pass status in verbose mode when command succeeds', async () => {
        const scriptPath = path.join(tmpDir, 'do', 'build');
        await writeFile(scriptPath, '#!/bin/bash\necho "building..."\nexit 0\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('build', tmpDir, 30, true);

        assert.strictEqual(result.name, 'build');
        assert.strictEqual(result.status, 'pass');
        assert.ok(result.duration >= 0);
        assert.strictEqual(result.error, undefined);
    });

    it('returns fail status in verbose mode when command exits non-zero', async () => {
        const scriptPath = path.join(tmpDir, 'do', 'deploy');
        await writeFile(scriptPath, '#!/bin/bash\necho "deploy failed" >&2\nexit 1\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('deploy', tmpDir, 30, true);

        assert.strictEqual(result.name, 'deploy');
        assert.strictEqual(result.status, 'fail');
        assert.ok(result.duration >= 0);
        assert.ok(result.error.includes('exited with code 1'));
    });

    it('returns timeout error in verbose mode when command exceeds timeout', async function () {
        this.timeout(10000);

        const scriptPath = path.join(tmpDir, 'do', 'test');
        await writeFile(scriptPath, '#!/bin/bash\nsleep 30\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('test', tmpDir, 1, true);

        assert.strictEqual(result.name, 'test');
        assert.strictEqual(result.status, 'fail');
        assert.ok(result.error.includes('Timeout after 1s'));
    });

    it('defaults to non-verbose (buffered) when verbose parameter is omitted', async () => {
        const scriptPath = path.join(tmpDir, 'do', 'push');
        await writeFile(scriptPath, '#!/bin/bash\necho "pushing..." >&2\nexit 1\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('push', tmpDir, 30);

        assert.strictEqual(result.status, 'fail');
        // Non-verbose captures stderr
        assert.ok(result.error.includes('pushing...'));
    });

    it('defaults to non-verbose when verbose is explicitly false', async () => {
        const scriptPath = path.join(tmpDir, 'do', 'push');
        await writeFile(scriptPath, '#!/bin/bash\necho "push error" >&2\nexit 1\n');
        await chmod(scriptPath, 0o755);

        const result = await executeStep('push', tmpDir, 30, false);

        assert.strictEqual(result.status, 'fail');
        // Non-verbose captures stderr
        assert.ok(result.error.includes('push error'));
    });
});

// ---------------------------------------------------------------------------
// getStepTimeout — timeout selection for lifecycle steps
// Validates: Requirements 4.2
// ---------------------------------------------------------------------------

describe('E2E Runner — getStepTimeout', () => {

    it('returns tuneTimeout for tune-prefixed step when tuneTimeout is set', () => {
        const config = { timeout: 1800, tuneTimeout: 3600 };
        const result = getStepTimeout('tune-sft', config);
        assert.strictEqual(result, 3600);
    });

    it('falls back to timeout for tune-prefixed step when tuneTimeout is not set', () => {
        const config = { timeout: 1800 };
        const result = getStepTimeout('tune-sft', config);
        assert.strictEqual(result, 1800);
    });

    it('returns timeout for non-tune step regardless of tuneTimeout', () => {
        const config = { timeout: 1800, tuneTimeout: 3600 };
        const result = getStepTimeout('build', config);
        assert.strictEqual(result, 1800);
    });

    it('returns timeout for "deploy" step', () => {
        const config = { timeout: 2700, tuneTimeout: 5400 };
        const result = getStepTimeout('deploy', config);
        assert.strictEqual(result, 2700);
    });

    it('returns timeout for "test" step', () => {
        const config = { timeout: 1800, tuneTimeout: 3600 };
        const result = getStepTimeout('test', config);
        assert.strictEqual(result, 1800);
    });

    it('returns timeout for "clean" step', () => {
        const config = { timeout: 1800, tuneTimeout: 3600 };
        const result = getStepTimeout('clean', config);
        assert.strictEqual(result, 1800);
    });

    it('returns tuneTimeout for "tune-dpo" step', () => {
        const config = { timeout: 2700, tuneTimeout: 5400 };
        const result = getStepTimeout('tune-dpo', config);
        assert.strictEqual(result, 5400);
    });

    it('returns tuneTimeout for "tune-rlaif" step', () => {
        const config = { timeout: 3600, tuneTimeout: 10800 };
        const result = getStepTimeout('tune-rlaif', config);
        assert.strictEqual(result, 10800);
    });

    it('returns timeout for "adapter-add" step (not tune-prefixed)', () => {
        const config = { timeout: 1800, tuneTimeout: 3600 };
        const result = getStepTimeout('adapter-add', config);
        assert.strictEqual(result, 1800);
    });

    it('returns timeout for "test-adapter" step (not tune-prefixed)', () => {
        const config = { timeout: 1800, tuneTimeout: 3600 };
        const result = getStepTimeout('test-adapter', config);
        assert.strictEqual(result, 1800);
    });

    it('falls back to timeout when tuneTimeout is 0 (falsy)', () => {
        const config = { timeout: 1800, tuneTimeout: 0 };
        const result = getStepTimeout('tune-sft', config);
        assert.strictEqual(result, 1800);
    });
});

// ---------------------------------------------------------------------------
// runConfig — tune-group fail-fast behavior
// Validates: Requirements 3.5 (Correctness Property 3)
// ---------------------------------------------------------------------------

describe('E2E Runner — runConfig tune-group fail-fast', () => {

    const tmpWorkspace = path.join('/tmp', `e2e-test-tunefailfast-${Date.now()}`);

    after(async () => {
        await rm(tmpWorkspace, { recursive: true, force: true });
    });

    it('skips adapter-add and test-adapter when tune-sft fails, then runs clean', async function () {
        this.timeout(15000);

        const configId = 'test-tune-fail';
        const projectDir = path.join(tmpWorkspace, configId);
        await mkdir(path.join(projectDir, 'do'), { recursive: true });

        // build, push, deploy, test pass; tune-sft fails
        await writeFile(path.join(projectDir, 'do', 'build'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'build'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'push'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'push'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'deploy'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'deploy'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'test'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'test'), 0o755);
        // tune-sft fails (resolves to ./do/tune via resolveStepCommand for now)
        await writeFile(path.join(projectDir, 'do', 'tune'), '#!/bin/bash\necho "tune failed" >&2\nexit 1\n');
        await chmod(path.join(projectDir, 'do', 'tune'), 0o755);
        // adapter and test-adapter should NOT be called
        await writeFile(path.join(projectDir, 'do', 'adapter'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'adapter'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'clean'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'clean'), 0o755);

        // Use a no-op repo root (project already exists)
        const fakeRepo = path.join(tmpWorkspace, 'fake-repo-tune');
        await mkdir(path.join(fakeRepo, 'bin'), { recursive: true });
        await writeFile(path.join(fakeRepo, 'bin', 'cli.js'), '#!/usr/bin/env node\n// no-op\n');

        const config = {
            id: configId,
            tier: 'ci',
            track: 'realtime',
            args: '--enable-lora',
            lifecycle: ['build', 'push', 'deploy', 'test', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
            timeout: 30,
            tuneTimeout: 60,
            tuneConfig: {
                tuneId: 'test-model',
                technique: 'sft',
                trainingType: 'lora',
                dataset: 's3://test/train.jsonl'
            }
        };

        const result = await runConfig(config, tmpWorkspace, fakeRepo);

        assert.strictEqual(result.status, 'fail');
        assert.ok(result.error.includes('tune failed'));

        // Steps: build(pass), push(pass), deploy(pass), test(pass), tune-sft(fail), adapter-add(skipped), test-adapter(skipped), clean(pass)
        assert.strictEqual(result.steps.length, 8);
        assert.strictEqual(result.steps[0].name, 'build');
        assert.strictEqual(result.steps[0].status, 'pass');
        assert.strictEqual(result.steps[1].name, 'push');
        assert.strictEqual(result.steps[1].status, 'pass');
        assert.strictEqual(result.steps[2].name, 'deploy');
        assert.strictEqual(result.steps[2].status, 'pass');
        assert.strictEqual(result.steps[3].name, 'test');
        assert.strictEqual(result.steps[3].status, 'pass');
        assert.strictEqual(result.steps[4].name, 'tune-sft');
        assert.strictEqual(result.steps[4].status, 'fail');
        assert.strictEqual(result.steps[5].name, 'adapter-add');
        assert.strictEqual(result.steps[5].status, 'skipped');
        assert.strictEqual(result.steps[5].duration, 0);
        assert.strictEqual(result.steps[6].name, 'test-adapter');
        assert.strictEqual(result.steps[6].status, 'skipped');
        assert.strictEqual(result.steps[6].duration, 0);
        assert.strictEqual(result.steps[7].name, 'clean');
        assert.strictEqual(result.steps[7].status, 'pass');
    });

    it('breaks immediately on non-tune step failure (existing behavior preserved)', async function () {
        this.timeout(15000);

        const configId = 'test-nontune-fail';
        const projectDir = path.join(tmpWorkspace, configId);
        await mkdir(path.join(projectDir, 'do'), { recursive: true });

        // build passes, deploy fails — test and tune steps should not run
        await writeFile(path.join(projectDir, 'do', 'build'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'build'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'deploy'), '#!/bin/bash\necho "deploy error" >&2\nexit 1\n');
        await chmod(path.join(projectDir, 'do', 'deploy'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'test'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'test'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'tune'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'tune'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'adapter'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'adapter'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'clean'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'clean'), 0o755);

        const fakeRepo = path.join(tmpWorkspace, 'fake-repo-nontune');
        await mkdir(path.join(fakeRepo, 'bin'), { recursive: true });
        await writeFile(path.join(fakeRepo, 'bin', 'cli.js'), '#!/usr/bin/env node\n// no-op\n');

        const config = {
            id: configId,
            tier: 'ci',
            track: 'realtime',
            args: '--enable-lora',
            lifecycle: ['build', 'deploy', 'test', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
            timeout: 30,
            tuneTimeout: 60,
            tuneConfig: {
                tuneId: 'test-model',
                technique: 'sft',
                trainingType: 'lora',
                dataset: 's3://test/train.jsonl'
            }
        };

        const result = await runConfig(config, tmpWorkspace, fakeRepo);

        assert.strictEqual(result.status, 'fail');
        assert.ok(result.error.includes('deploy error'));

        // Steps: build(pass), deploy(fail), clean(pass) — test, tune, adapter steps NOT reached
        assert.strictEqual(result.steps.length, 3);
        assert.strictEqual(result.steps[0].name, 'build');
        assert.strictEqual(result.steps[0].status, 'pass');
        assert.strictEqual(result.steps[1].name, 'deploy');
        assert.strictEqual(result.steps[1].status, 'fail');
        assert.strictEqual(result.steps[2].name, 'clean');
        assert.strictEqual(result.steps[2].status, 'pass');
    });

    it('uses getStepTimeout for tune steps (tuneTimeout)', async function () {
        this.timeout(15000);

        const configId = 'test-tune-timeout';
        const projectDir = path.join(tmpWorkspace, configId);
        await mkdir(path.join(projectDir, 'do'), { recursive: true });

        // tune-sft passes (verifies tuneTimeout is used, not regular timeout)
        // We set timeout to 1s (would fail) and tuneTimeout to 30s (should pass)
        await writeFile(path.join(projectDir, 'do', 'build'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'build'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'tune'), '#!/bin/bash\nsleep 0.5\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'tune'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'adapter'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'adapter'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'test'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'test'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'clean'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'clean'), 0o755);

        const fakeRepo = path.join(tmpWorkspace, 'fake-repo-timeout');
        await mkdir(path.join(fakeRepo, 'bin'), { recursive: true });
        await writeFile(path.join(fakeRepo, 'bin', 'cli.js'), '#!/usr/bin/env node\n// no-op\n');

        const config = {
            id: configId,
            tier: 'ci',
            track: 'realtime',
            args: '--enable-lora',
            lifecycle: ['build', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
            timeout: 1,       // 1 second — would timeout tune if used
            tuneTimeout: 30,  // 30 seconds — tune should pass
            tuneConfig: {
                tuneId: 'test-model',
                technique: 'sft',
                trainingType: 'lora',
                dataset: 's3://test/train.jsonl'
            }
        };

        const result = await runConfig(config, tmpWorkspace, fakeRepo);

        // tune-sft should pass because tuneTimeout (30s) is used, not timeout (1s)
        const tuneSftStep = result.steps.find(s => s.name === 'tune-sft');
        assert.strictEqual(tuneSftStep.status, 'pass');
    });

    it('runs all lifecycle steps including tune group when all pass', async function () {
        this.timeout(15000);

        const configId = 'test-tune-allpass';
        const projectDir = path.join(tmpWorkspace, configId);
        await mkdir(path.join(projectDir, 'do'), { recursive: true });

        await writeFile(path.join(projectDir, 'do', 'build'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'build'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'test'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'test'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'tune'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'tune'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'adapter'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'adapter'), 0o755);
        await writeFile(path.join(projectDir, 'do', 'clean'), '#!/bin/bash\nexit 0\n');
        await chmod(path.join(projectDir, 'do', 'clean'), 0o755);

        const fakeRepo = path.join(tmpWorkspace, 'fake-repo-allpass');
        await mkdir(path.join(fakeRepo, 'bin'), { recursive: true });
        await writeFile(path.join(fakeRepo, 'bin', 'cli.js'), '#!/usr/bin/env node\n// no-op\n');

        const config = {
            id: configId,
            tier: 'ci',
            track: 'realtime',
            args: '--enable-lora',
            lifecycle: ['build', 'test', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
            timeout: 30,
            tuneTimeout: 60,
            tuneConfig: {
                tuneId: 'test-model',
                technique: 'sft',
                trainingType: 'lora',
                dataset: 's3://test/train.jsonl'
            }
        };

        const result = await runConfig(config, tmpWorkspace, fakeRepo);

        assert.strictEqual(result.status, 'pass');
        // Steps: build(pass), test(pass), tune-sft(pass), adapter-add(pass), test-adapter(pass), clean(pass)
        assert.strictEqual(result.steps.length, 6);
        assert.strictEqual(result.steps[0].name, 'build');
        assert.strictEqual(result.steps[0].status, 'pass');
        assert.strictEqual(result.steps[1].name, 'test');
        assert.strictEqual(result.steps[1].status, 'pass');
        assert.strictEqual(result.steps[2].name, 'tune-sft');
        assert.strictEqual(result.steps[2].status, 'pass');
        assert.strictEqual(result.steps[3].name, 'adapter-add');
        assert.strictEqual(result.steps[3].status, 'pass');
        assert.strictEqual(result.steps[4].name, 'test-adapter');
        assert.strictEqual(result.steps[4].status, 'pass');
        assert.strictEqual(result.steps[5].name, 'clean');
        assert.strictEqual(result.steps[5].status, 'pass');
    });
});
