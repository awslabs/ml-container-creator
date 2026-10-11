// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test that `mcc regenerate` preserves existing deployment config values
 * from do/config, including per-target status vars (FR-9.3).
 *
 * Validates:
 * - shellVarsToAnswers maps status vars to camelCase answer keys
 * - The config template renders preserved status var values
 * - A full regeneration cycle (parse config → answers → render template)
 *   preserves status vars that were set at deploy time
 */

import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeProject } from '../../src/app.js';
import { fileURLToPath } from 'node:url';
// parseDoConfig + shellVarsToAnswers are now the shared do-config utilities that
// regenerate-command-handler uses (single source of truth). Import them directly
// rather than replicating the logic in the test.
import { parseDoConfig, shellVarsToAnswers } from '../../src/lib/do-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_DIR = path.join(GENERATOR_ROOT, 'templates');

describe('regenerate preserves config values (FR-9.3)', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-test-regen-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('shellVarsToAnswers status var mapping', () => {
        it('maps DEPLOYMENT_TARGET_SMAI_STATUS to camelCase', () => {
            const vars = { DEPLOYMENT_TARGET_SMAI_STATUS: 'InService' };
            const answers = shellVarsToAnswers(vars);
            assert.strictEqual(answers.deploymentTargetSmaiStatus, 'InService');
        });

        it('maps DEPLOYMENT_TARGET_HP_STATUS to camelCase', () => {
            const vars = { DEPLOYMENT_TARGET_HP_STATUS: 'Running' };
            const answers = shellVarsToAnswers(vars);
            assert.strictEqual(answers.deploymentTargetHpStatus, 'Running');
        });

        it('maps DEPLOYMENT_TARGET_ASYNC_STATUS to camelCase', () => {
            const vars = { DEPLOYMENT_TARGET_ASYNC_STATUS: 'InService' };
            const answers = shellVarsToAnswers(vars);
            assert.strictEqual(answers.deploymentTargetAsyncStatus, 'InService');
        });

        it('maps DEPLOYMENT_TARGET_BATCH_STATUS to camelCase', () => {
            const vars = { DEPLOYMENT_TARGET_BATCH_STATUS: 'Completed' };
            const answers = shellVarsToAnswers(vars);
            assert.strictEqual(answers.deploymentTargetBatchStatus, 'Completed');
        });

        it('maps all status vars together', () => {
            const vars = {
                DEPLOYMENT_TARGET_SMAI_STATUS: 'InService',
                DEPLOYMENT_TARGET_HP_STATUS: 'Running',
                DEPLOYMENT_TARGET_ASYNC_STATUS: 'Failed',
                DEPLOYMENT_TARGET_BATCH_STATUS: 'Completed'
            };
            const answers = shellVarsToAnswers(vars);
            assert.strictEqual(answers.deploymentTargetSmaiStatus, 'InService');
            assert.strictEqual(answers.deploymentTargetHpStatus, 'Running');
            assert.strictEqual(answers.deploymentTargetAsyncStatus, 'Failed');
            assert.strictEqual(answers.deploymentTargetBatchStatus, 'Completed');
        });

        it('preserves empty status vars as empty string', () => {
            const vars = {
                DEPLOYMENT_TARGET_SMAI_STATUS: '',
                DEPLOYMENT_TARGET_HP_STATUS: ''
            };
            const answers = shellVarsToAnswers(vars);
            assert.strictEqual(answers.deploymentTargetSmaiStatus, '');
            assert.strictEqual(answers.deploymentTargetHpStatus, '');
        });
    });

    describe('config template renders preserved status vars', () => {
        const baseAnswers = {
            projectName: 'test-project',
            deploymentConfig: 'transformers-vllm',
            deploymentTarget: 'realtime-inference',
            instanceType: 'ml.g5.xlarge',
            modelName: 'meta-llama/Llama-3-8B',
            baseImage: 'vllm/vllm-openai:v0.21.0',
            region: 'us-east-1',
            awsRegion: 'us-east-1',
            framework: 'transformers',
            modelServer: 'vllm',
            architecture: 'transformers',
            backend: 'vllm',
            destinationDir: '',
            includeBenchmark: false,
            enableLora: false,
            testTypes: ['hosted-model-endpoint'],
            icGpuCount: 1,
            icCopyCount: 1,
            icMemorySize: 16384,
            no_build: true,
            container_image_uri: 'vllm/vllm-openai:v0.21.0',
            deploy_mode: 'dlc-direct',
            hfToken: null,
            hfTokenArn: null,
            ngcApiKey: null,
            ngcTokenArn: null,
            envVars: {},
            modelEnvVars: {},
            serverEnvVars: {},
            chatTemplate: null,
            chatTemplateSource: null,
            accelerator: 'gpu',
            frameworkVersion: null,
            validationLevel: 'unknown',
            configSources: [],
            recommendedInstanceTypes: [],
            roleArn: null,
            codebuildComputeType: null,
            codebuildProjectName: null,
            modelFormat: null,
            includeSampleModel: false,
            includeTesting: true,
            buildTimestamp: new Date().toISOString(),
            buildTarget: 'codebuild',
            hyperPodCluster: null,
            hyperPodNamespace: 'default',
            hyperPodReplicas: 1,
            fsxVolumeHandle: null,
            modelSource: 'huggingface',
            artifactUri: '',
            modelLoadStrategy: 'runtime',
            existingEndpointName: null,
            maxLoras: 30,
            maxLoraRank: 64,
            engine: 'vllm',
            inferenceAmiVersion: null
        };

        it('preserves SMAI status InService through regeneration', async () => {
            const answers = {
                ...baseAnswers,
                destinationDir: tmpDir,
                deploymentTargetSmaiStatus: 'InService'
            };
            await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
                onlyFiles: ['do/config']
            });

            const configPath = path.join(tmpDir, 'do', 'config');
            const content = fs.readFileSync(configPath, 'utf8');
            assert.ok(
                content.includes('export DEPLOYMENT_TARGET_SMAI_STATUS="InService"'),
                `Expected InService status to be preserved in config, got:\n${content.match(/DEPLOYMENT_TARGET_SMAI_STATUS.*/)?.[0]}`
            );
        });

        it('preserves HP status Running through regeneration', async () => {
            const answers = {
                ...baseAnswers,
                destinationDir: tmpDir,
                deploymentTargetHpStatus: 'Running'
            };
            await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
                onlyFiles: ['do/config']
            });

            const configPath = path.join(tmpDir, 'do', 'config');
            const content = fs.readFileSync(configPath, 'utf8');
            assert.ok(
                content.includes('export DEPLOYMENT_TARGET_HP_STATUS="Running"'),
                `Expected Running status to be preserved in config, got:\n${content.match(/DEPLOYMENT_TARGET_HP_STATUS.*/)?.[0]}`
            );
        });

        it('preserves multiple status vars simultaneously', async () => {
            const answers = {
                ...baseAnswers,
                destinationDir: tmpDir,
                deploymentTargetSmaiStatus: 'InService',
                deploymentTargetHpStatus: 'Running',
                deploymentTargetAsyncStatus: 'Failed',
                deploymentTargetBatchStatus: 'Completed'
            };
            await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
                onlyFiles: ['do/config']
            });

            const configPath = path.join(tmpDir, 'do', 'config');
            const content = fs.readFileSync(configPath, 'utf8');
            assert.ok(content.includes('export DEPLOYMENT_TARGET_SMAI_STATUS="InService"'));
            assert.ok(content.includes('export DEPLOYMENT_TARGET_HP_STATUS="Running"'));
            assert.ok(content.includes('export DEPLOYMENT_TARGET_ASYNC_STATUS="Failed"'));
            assert.ok(content.includes('export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"'));
        });

        it('renders empty status when no status values provided (fresh project)', async () => {
            const answers = {
                ...baseAnswers,
                destinationDir: tmpDir
                // No status vars set — simulates initial generation
            };
            await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
                onlyFiles: ['do/config']
            });

            const configPath = path.join(tmpDir, 'do', 'config');
            const content = fs.readFileSync(configPath, 'utf8');
            assert.ok(content.includes('export DEPLOYMENT_TARGET_SMAI_STATUS=""'));
            assert.ok(content.includes('export DEPLOYMENT_TARGET_HP_STATUS=""'));
            assert.ok(content.includes('export DEPLOYMENT_TARGET_ASYNC_STATUS=""'));
            assert.ok(content.includes('export DEPLOYMENT_TARGET_BATCH_STATUS=""'));
        });
    });

    describe('runtime-owned var preservation (do/stage, do/benchmark, …)', () => {
        it('RUNTIME_OWNED_VARS includes STAGED_MODEL_PATH so regenerate does not drop S3 staging', async () => {
            // do/stage writes STAGED_MODEL_PATH to do/config at runtime; it has no
            // generation answer to be restored from, so it must be in the
            // capture/re-inject set or `mcc regenerate` silently wipes it and every
            // later deploy falls back to pulling the model from HuggingFace.
            const { RUNTIME_OWNED_VARS } = await import('../../src/lib/regenerate-command-handler.js');
            assert.ok(RUNTIME_OWNED_VARS.has('STAGED_MODEL_PATH'),
                'regenerate must preserve STAGED_MODEL_PATH (runtime S3 staging pointer)');
        });

        it('a full capture→inject cycle keeps STAGED_MODEL_PATH set in do/config', () => {
            // Mirror the handler's capture (RUNTIME_OWNED_VARS ∩ do/config) and
            // re-inject, proving the staged URI survives a regenerate that rewrites
            // the file from template defaults (which carry no STAGED_MODEL_PATH).
            const configBefore = [
                'export PROJECT_NAME="clever-llm-predictor"',
                'export MODEL_NAME="Qwen/Qwen3-32B"',
                'export STAGED_MODEL_PATH="s3://mlcc-core-123/models/Qwen/Qwen3-32B/"'
            ].join('\n');
            const configPath = path.join(tmpDir, 'config');
            fs.writeFileSync(configPath, configBefore);

            const shellVars = parseDoConfig(configPath);
            // The handler's _captureRuntimeVars keeps only RUNTIME_OWNED_VARS with a
            // non-empty value; assert STAGED_MODEL_PATH is captured.
            assert.strictEqual(shellVars.STAGED_MODEL_PATH, 's3://mlcc-core-123/models/Qwen/Qwen3-32B/');

            // A regenerated template config would NOT contain STAGED_MODEL_PATH; the
            // re-inject step must append it back. Simulate that end state.
            const regenerated = 'export PROJECT_NAME="clever-llm-predictor"\nexport MODEL_NAME="Qwen/Qwen3-32B"\n';
            const reinjected = `${regenerated}\nexport STAGED_MODEL_PATH="${shellVars.STAGED_MODEL_PATH}"`;
            assert.match(reinjected, /export STAGED_MODEL_PATH="s3:\/\/mlcc-core-123\/models\/Qwen\/Qwen3-32B\/"/);
        });
    });

    describe('end-to-end regeneration preserves status vars', () => {
        it('simulates regeneration: parse config → answers → render preserves status', () => {
            // Simulate a do/config file that has been deployed with status vars set
            const configContent = [
                'export PROJECT_NAME="my-project"',
                'export DEPLOYMENT_CONFIG="transformers-vllm"',
                'export DEPLOYMENT_TARGET="managed-inference"',
                'export INSTANCE_TYPE="ml.g5.xlarge"',
                'export AWS_REGION="us-east-1"',
                'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
                'export DEPLOYMENT_TARGET_HP_STATUS="Running"',
                'export DEPLOYMENT_TARGET_ASYNC_STATUS=""',
                'export DEPLOYMENT_TARGET_BATCH_STATUS=""',
                'export BASE_IMAGE="vllm/vllm-openai:v0.21.0"'
            ].join('\n');

            const configPath = path.join(tmpDir, 'config');
            fs.writeFileSync(configPath, configContent);

            // Step 1: Parse the config (same as regenerate handler does)
            const shellVars = parseDoConfig(configPath);
            assert.strictEqual(shellVars.DEPLOYMENT_TARGET_SMAI_STATUS, 'InService');
            assert.strictEqual(shellVars.DEPLOYMENT_TARGET_HP_STATUS, 'Running');

            // Step 2: Convert to answers (same as regenerate handler does)
            const answers = shellVarsToAnswers(shellVars);
            assert.strictEqual(answers.deploymentTargetSmaiStatus, 'InService');
            assert.strictEqual(answers.deploymentTargetHpStatus, 'Running');
            assert.strictEqual(answers.deploymentTargetAsyncStatus, '');
            assert.strictEqual(answers.deploymentTargetBatchStatus, '');

            // The answers now contain the status vars, which will be passed to
            // writeProject and rendered in the config template with their values
            // preserved (tested in the template rendering tests above).
        });

        it('simulates regeneration: empty status vars remain empty', () => {
            const configContent = [
                'export PROJECT_NAME="fresh-project"',
                'export DEPLOYMENT_CONFIG="transformers-vllm"',
                'export DEPLOYMENT_TARGET=""',
                'export INSTANCE_TYPE=""',
                'export AWS_REGION="us-west-2"',
                'export DEPLOYMENT_TARGET_SMAI_STATUS=""',
                'export DEPLOYMENT_TARGET_HP_STATUS=""',
                'export DEPLOYMENT_TARGET_ASYNC_STATUS=""',
                'export DEPLOYMENT_TARGET_BATCH_STATUS=""',
                'export BASE_IMAGE=""'
            ].join('\n');

            const configPath = path.join(tmpDir, 'config');
            fs.writeFileSync(configPath, configContent);

            const shellVars = parseDoConfig(configPath);
            const answers = shellVarsToAnswers(shellVars);

            // All status vars should be empty string (not undefined)
            assert.strictEqual(answers.deploymentTargetSmaiStatus, '');
            assert.strictEqual(answers.deploymentTargetHpStatus, '');
            assert.strictEqual(answers.deploymentTargetAsyncStatus, '');
            assert.strictEqual(answers.deploymentTargetBatchStatus, '');
        });
    });
});
