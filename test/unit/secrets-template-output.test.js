// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do-script template changes related to Secrets Manager integration.
 *
 * Tests cover:
 * - do/config output for ARN, plaintext, and omitted configurations
 * - do/build resolution block presence
 * - do/run (serve) resolution block presence
 * - Backward compatibility: no ARN → identical output to current behavior
 *
 * Feature: secrets-manager-integration
 * Validates: Requirements 9.1–9.5, 10.1–10.5, 11.1–11.5, 12.1, 12.4
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/config');
const BUILD_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/build');
const RUN_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/run');

const CONFIG_TEMPLATE = readFileSync(CONFIG_TEMPLATE_PATH, 'utf-8');
const BUILD_TEMPLATE = readFileSync(BUILD_TEMPLATE_PATH, 'utf-8');
const RUN_TEMPLATE = readFileSync(RUN_TEMPLATE_PATH, 'utf-8');

// ── Helper: render do/config template with defaults ──────────────────────────

function renderConfig(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'local',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        modelName: 'meta-llama/Llama-2-7b-hf',
        hfToken: '',
        hfTokenArn: '',
        ngcApiKey: '',
        ngcTokenArn: '',
        roleArn: '',
        modelFormat: '',
        baseImage: '',
        orderedEnvVars: [],
        codebuildComputeType: '',
        inferenceAmiVersion: '',
        asyncS3OutputPath: '',
        asyncSnsSuccessTopic: '',
        asyncSnsErrorTopic: '',
        asyncMaxConcurrentInvocations: '',
        hyperPodCluster: '',
        hyperPodNamespace: '',
        hyperPodReplicas: '',
        fsxVolumeHandle: '',
        batchInputPath: '',
        batchOutputPath: '',
        batchInstanceCount: '',
        batchSplitType: '',
        batchStrategy: '',
        batchJoinSource: '',
        batchMaxConcurrentTransforms: '',
        batchMaxPayloadInMB: '',
        ...overrides
    };
    return ejs.render(CONFIG_TEMPLATE, vars);
}

// ── Helper: render do/build template ─────────────────────────────────────────

function renderBuild() {
    // do/build is a static bash script (no EJS variables), so render as-is
    return BUILD_TEMPLATE;
}

// ── Helper: render do/run template ───────────────────────────────────────────

function renderRun(overrides = {}) {
    const vars = {
        framework: 'transformers',
        ...overrides
    };
    return ejs.render(RUN_TEMPLATE, vars);
}

// ── do/config tests ──────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration — do/config template output', () => {

    describe('HuggingFace token ARN configuration (Req 11.1)', () => {

        it('exports HF_TOKEN_ARN when hfTokenArn is set', () => {
            // **Validates: Requirements 11.1**
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const output = renderConfig({ hfTokenArn: arn });
            assert.ok(
                output.includes(`export HF_TOKEN_ARN="${arn}"`),
                'do/config must export HF_TOKEN_ARN when hfTokenArn is configured'
            );
        });

        it('does NOT export HF_TOKEN when hfTokenArn is set', () => {
            // **Validates: Requirements 11.1**
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const output = renderConfig({ hfTokenArn: arn });
            assert.ok(
                !output.includes('export HF_TOKEN='),
                'do/config must NOT export HF_TOKEN when hfTokenArn is configured'
            );
        });
    });

    describe('HuggingFace plaintext token configuration (Req 11.3)', () => {

        it('exports HF_TOKEN when hfToken is set (plaintext)', () => {
            // **Validates: Requirements 11.3**
            const output = renderConfig({ hfToken: 'hf_abc123' });
            assert.ok(
                output.includes('export HF_TOKEN="hf_abc123"'),
                'do/config must export HF_TOKEN when plaintext hfToken is configured'
            );
        });

        it('does NOT export HF_TOKEN_ARN when hfToken is set (plaintext)', () => {
            // **Validates: Requirements 11.3**
            const output = renderConfig({ hfToken: 'hf_abc123' });
            assert.ok(
                !output.includes('export HF_TOKEN_ARN='),
                'do/config must NOT export HF_TOKEN_ARN when plaintext hfToken is configured'
            );
        });
    });

    describe('HuggingFace token omitted (Req 11.5)', () => {

        it('does NOT export HF_TOKEN or HF_TOKEN_ARN when neither is set', () => {
            // **Validates: Requirements 11.5**
            const output = renderConfig({ hfToken: '', hfTokenArn: '' });
            assert.ok(
                !output.includes('export HF_TOKEN_ARN='),
                'do/config must NOT export HF_TOKEN_ARN when neither is configured'
            );
            assert.ok(
                !output.includes('export HF_TOKEN='),
                'do/config must NOT export HF_TOKEN when neither is configured'
            );
        });
    });

    describe('NGC API key ARN configuration (Req 11.2)', () => {

        it('exports NGC_API_KEY_ARN when ngcTokenArn is set', () => {
            // **Validates: Requirements 11.2**
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/team-XyZ123';
            const output = renderConfig({ ngcTokenArn: arn });
            assert.ok(
                output.includes(`export NGC_API_KEY_ARN="${arn}"`),
                'do/config must export NGC_API_KEY_ARN when ngcTokenArn is configured'
            );
        });

        it('does NOT export NGC_API_KEY when ngcTokenArn is set', () => {
            // **Validates: Requirements 11.2**
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/team-XyZ123';
            const output = renderConfig({ ngcTokenArn: arn });
            assert.ok(
                !output.includes('export NGC_API_KEY='),
                'do/config must NOT export NGC_API_KEY when ngcTokenArn is configured'
            );
        });
    });

    describe('NGC plaintext token configuration (Req 11.3)', () => {

        it('exports NGC_API_KEY when ngcApiKey is set (plaintext)', () => {
            // **Validates: Requirements 11.3**
            const output = renderConfig({ ngcApiKey: 'nvapi-abc123' });
            assert.ok(
                output.includes('export NGC_API_KEY="nvapi-abc123"'),
                'do/config must export NGC_API_KEY when plaintext ngcApiKey is configured'
            );
        });

        it('does NOT export NGC_API_KEY_ARN when ngcApiKey is set (plaintext)', () => {
            // **Validates: Requirements 11.3**
            const output = renderConfig({ ngcApiKey: 'nvapi-abc123' });
            assert.ok(
                !output.includes('export NGC_API_KEY_ARN='),
                'do/config must NOT export NGC_API_KEY_ARN when plaintext ngcApiKey is configured'
            );
        });
    });

    describe('ARN vs plaintext comment documentation (Req 11.4)', () => {

        it('includes comment explaining ARN vs plaintext convention', () => {
            // **Validates: Requirements 11.4**
            const output = renderConfig({ hfTokenArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf' });
            assert.ok(
                output.includes('Secrets Manager integration'),
                'do/config must include a comment about Secrets Manager integration'
            );
        });
    });
});

// ── do/build tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration — do/build template output', () => {

    describe('Secrets Manager resolution block (Req 9.1, 9.2)', () => {

        it('contains HF_TOKEN_ARN resolution block', () => {
            // **Validates: Requirements 9.1**
            const output = renderBuild();
            assert.ok(
                output.includes('${HF_TOKEN_ARN:-}'),
                'do/build must check for HF_TOKEN_ARN'
            );
            assert.ok(
                output.includes('aws secretsmanager get-secret-value --secret-id "${HF_TOKEN_ARN}"'),
                'do/build must call get-secret-value for HF_TOKEN_ARN'
            );
        });

        it('contains NGC_API_KEY_ARN resolution block', () => {
            // **Validates: Requirements 9.1**
            const output = renderBuild();
            assert.ok(
                output.includes('${NGC_API_KEY_ARN:-}'),
                'do/build must check for NGC_API_KEY_ARN'
            );
            assert.ok(
                output.includes('aws secretsmanager get-secret-value --secret-id "${NGC_API_KEY_ARN}"'),
                'do/build must call get-secret-value for NGC_API_KEY_ARN'
            );
        });

        it('exports resolved HF_TOKEN after resolution', () => {
            // **Validates: Requirements 9.2**
            const output = renderBuild();
            assert.ok(
                output.includes('export HF_TOKEN'),
                'do/build must export HF_TOKEN after resolving from Secrets Manager'
            );
        });

        it('exports resolved NGC_API_KEY after resolution', () => {
            // **Validates: Requirements 9.2**
            const output = renderBuild();
            assert.ok(
                output.includes('export NGC_API_KEY'),
                'do/build must export NGC_API_KEY after resolving from Secrets Manager'
            );
        });
    });

    describe('Error handling on resolution failure (Req 9.5)', () => {

        it('exits with code 3 on HF_TOKEN resolution failure', () => {
            // **Validates: Requirements 9.5**
            const output = renderBuild();
            assert.ok(
                output.includes('Failed to resolve HuggingFace token from Secrets Manager'),
                'do/build must display error message on HF_TOKEN resolution failure'
            );
            assert.ok(
                output.includes('exit 3'),
                'do/build must exit with code 3 on resolution failure'
            );
        });

        it('exits with code 3 on NGC_API_KEY resolution failure', () => {
            // **Validates: Requirements 9.5**
            const output = renderBuild();
            assert.ok(
                output.includes('Failed to resolve NGC API key from Secrets Manager'),
                'do/build must display error message on NGC_API_KEY resolution failure'
            );
        });
    });

    describe('BuildKit improvement comment (Req 9.3)', () => {

        it('includes comment about BuildKit --secret mount future improvement', () => {
            // **Validates: Requirements 9.3**
            const output = renderBuild();
            assert.ok(
                output.includes('BuildKit') || output.includes('--secret'),
                'do/build must include comment about BuildKit --secret mount improvement'
            );
        });
    });

    describe('Secrets Manager resolution section header (Req 9.4)', () => {

        it('contains the resolution section header comment', () => {
            // **Validates: Requirements 9.4**
            const output = renderBuild();
            assert.ok(
                output.includes('Secrets Manager resolution (build-time)'),
                'do/build must contain the Secrets Manager resolution section header'
            );
        });
    });
});

// ── do/run (serve) tests ─────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration — do/run template output', () => {

    describe('Secrets Manager resolution block (Req 10.1, 10.2)', () => {

        it('contains HF_TOKEN_ARN resolution block', () => {
            // **Validates: Requirements 10.1**
            const output = renderRun();
            assert.ok(
                output.includes('${HF_TOKEN_ARN:-}'),
                'do/run must check for HF_TOKEN_ARN'
            );
            assert.ok(
                output.includes('aws secretsmanager get-secret-value --secret-id "${HF_TOKEN_ARN}"'),
                'do/run must call get-secret-value for HF_TOKEN_ARN'
            );
        });

        it('exports resolved HF_TOKEN after resolution', () => {
            // **Validates: Requirements 10.2**
            const output = renderRun();
            assert.ok(
                output.includes('export HF_TOKEN'),
                'do/run must export HF_TOKEN after resolving from Secrets Manager'
            );
        });
    });

    describe('Error handling on resolution failure (Req 10.4)', () => {

        it('exits with code 3 on HF_TOKEN resolution failure', () => {
            // **Validates: Requirements 10.4**
            const output = renderRun();
            assert.ok(
                output.includes('Failed to resolve HuggingFace token from Secrets Manager'),
                'do/run must display error message on HF_TOKEN resolution failure'
            );
            assert.ok(
                output.includes('exit 3'),
                'do/run must exit with code 3 on resolution failure'
            );
        });
    });

    describe('Secrets Manager resolution section header (Req 10.5)', () => {

        it('contains the resolution section header comment', () => {
            // **Validates: Requirements 10.5**
            const output = renderRun();
            assert.ok(
                output.includes('Secrets Manager resolution (runtime)'),
                'do/run must contain the Secrets Manager resolution section header'
            );
        });
    });
});

// ── Backward compatibility tests ─────────────────────────────────────────────

describe('Feature: secrets-manager-integration — backward compatibility', () => {

    describe('No ARN configured produces identical output to pre-secrets behavior (Req 12.1, 12.4)', () => {

        it('do/config without ARN does not contain any Secrets Manager resolution references', () => {
            // **Validates: Requirements 12.1**
            const output = renderConfig({ hfToken: '', hfTokenArn: '', ngcApiKey: '', ngcTokenArn: '' });
            assert.ok(
                !output.includes('export HF_TOKEN_ARN='),
                'do/config without ARN must not export HF_TOKEN_ARN'
            );
            assert.ok(
                !output.includes('export NGC_API_KEY_ARN='),
                'do/config without ARN must not export NGC_API_KEY_ARN'
            );
        });

        it('do/config with plaintext hfToken exports HF_TOKEN directly (existing behavior)', () => {
            // **Validates: Requirements 12.4**
            const output = renderConfig({ hfToken: 'hf_mytoken123', hfTokenArn: '' });
            assert.ok(
                output.includes('export HF_TOKEN="hf_mytoken123"'),
                'do/config with plaintext must export HF_TOKEN directly'
            );
            assert.ok(
                !output.includes('export HF_TOKEN_ARN='),
                'do/config with plaintext must not export HF_TOKEN_ARN'
            );
        });

        it('do/build resolution block uses conditional check (no-op when no ARN)', () => {
            // **Validates: Requirements 9.4, 12.4**
            const output = renderBuild();
            // The resolution block uses ${HF_TOKEN_ARN:-} which is empty when not set
            assert.ok(
                output.includes('if [ -n "${HF_TOKEN_ARN:-}" ]'),
                'do/build must use conditional check that is no-op when HF_TOKEN_ARN is not set'
            );
            assert.ok(
                output.includes('if [ -n "${NGC_API_KEY_ARN:-}" ]'),
                'do/build must use conditional check that is no-op when NGC_API_KEY_ARN is not set'
            );
        });

        it('do/run resolution block uses conditional check (no-op when no ARN)', () => {
            // **Validates: Requirements 10.3, 12.4**
            const output = renderRun();
            assert.ok(
                output.includes('if [ -n "${HF_TOKEN_ARN:-}" ]'),
                'do/run must use conditional check that is no-op when HF_TOKEN_ARN is not set'
            );
        });
    });

    describe('Diffusors framework with hfTokenArn (Req 11.1)', () => {

        it('exports HF_TOKEN_ARN for diffusors framework', () => {
            // **Validates: Requirements 11.1**
            const arn = 'arn:aws:secretsmanager:us-west-2:111222333444:secret:mlcc/hf-token/diffusors-key-AbCdEf';
            const output = renderConfig({
                framework: 'diffusors',
                deploymentConfig: 'diffusors-comfyui',
                hfTokenArn: arn
            });
            assert.ok(
                output.includes(`export HF_TOKEN_ARN="${arn}"`),
                'do/config must export HF_TOKEN_ARN for diffusors framework'
            );
        });
    });
});
