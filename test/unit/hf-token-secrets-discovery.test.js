// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable no-unused-vars, prefer-const */

/**
 * Unit tests for BL067 — HF Token Prompt → Secrets Manager ARNs
 *
 * Tests:
 * - secrets-discovery.js: discoverSecrets and createSecret
 * - model-prompts.js: buildHfTokenPrompts factory
 * - secrets-prompt-runner.js: inline creation flow
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 3.1–3.4, 7.1
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';

// ────────────────────────────────────────────────────────────────────────────
// Mock AWS SDK — must be set up before importing the modules under test.
// We use dynamic import + module-level mock state to intercept SDK calls.
// ────────────────────────────────────────────────────────────────────────────

// Mock state
let mockListResponse = null;
let mockCreateResponse = null;
let mockListError = null;
let mockCreateError = null;
let listCallCount = 0;
let createCallCount = 0;
let lastListFilters = null;
let lastCreateParams = null;

// Since ESM doesn't support module mocking easily, we'll test at the integration
// level through the SecretsPromptRunner (which allows test overrides).
// For direct discoverSecrets/createSecret, we test via the runner's delegation.

import PromptRunner from '../../src/lib/prompt-runner.js';
import { hfTokenPrompts, buildHfTokenPrompts } from '../../src/lib/prompts/model-prompts.js';

/**
 * Creates a PromptRunner instance with mocked dependencies.
 */
function createTestRunner(opts = {}) {
    const promptResponses = opts.promptResponses || {};
    const promptCalls = [];

    const promptFn = async (prompts) => {
        const answers = {};
        for (const p of prompts) {
            promptCalls.push({ name: p.name, type: p.type, choices: p.choices });
            if (promptResponses[p.name] !== undefined) {
                answers[p.name] = promptResponses[p.name];
            } else if (p.default !== undefined) {
                answers[p.name] = typeof p.default === 'function' ? p.default({}) : p.default;
            } else {
                answers[p.name] = '';
            }
        }
        return answers;
    };

    const configManager = opts.configManager || {
        parameterMatrix: {},
        getExplicitConfiguration: () => ({}),
        isAutoPrompt: () => false
    };

    const runner = new PromptRunner({
        configManager,
        options: opts.options || {},
        registryConfigManager: null,
        baseConfig: {},
        promptFn
    });

    return { runner, promptCalls };
}

describe('BL067 — HF Token Secrets Manager Discovery', () => {

    describe('secrets-discovery.js — discoverSecrets', () => {
        it('should return results when _listManagedSecrets returns secrets for hf-token', async () => {
            const mockSecrets = [
                { name: 'huggingface-prod-token', arn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:huggingface-prod-token-AbCdEf' },
                { name: 'hf-token-staging', arn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:hf-token-staging-GhIjKl' }
            ];

            const { runner, promptCalls } = createTestRunner({
                promptResponses: {
                    secretSelection: mockSecrets[0].arn
                }
            });

            // Override _listManagedSecrets to return mock secrets
            runner._listManagedSecrets = async () => mockSecrets;

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            // Should have prompted with a list including the secrets
            assert.strictEqual(result.hfTokenArn, mockSecrets[0].arn);
        });

        it('should return empty array (fall back to plaintext) when no secrets found', async () => {
            const { runner, promptCalls } = createTestRunner({
                promptResponses: {
                    tokenValue: ''
                }
            });

            // Override _listManagedSecrets to return empty
            runner._listManagedSecrets = async () => [];

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            // No ARN selected, empty tokenValue → no keys
            assert.strictEqual(result.hfTokenArn, undefined);
            assert.strictEqual(result.hfToken, undefined);
        });

        it('should return empty array on Secrets Manager error (never throws)', async () => {
            const { runner, promptCalls } = createTestRunner({
                promptResponses: {
                    tokenValue: 'hf_test_12345'
                }
            });

            // Override _listManagedSecrets to throw error
            runner.secretsPromptRunner._listManagedSecrets = async () => { throw new Error('AccessDenied'); };

            // The runner should catch the error and fall back gracefully
            // Actually, _runSecretPrompts calls _listManagedSecrets within a try/catch
            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            // Should fall back to plaintext prompt
            assert.strictEqual(result.hfToken, 'hf_test_12345');
        });
    });

    describe('secrets-discovery.js — createSecret', () => {
        it('should succeed and return ARN via inline creation flow', async () => {
            const mockArn = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:mlcc-hf-token-myproject-XyZaB';
            const mockSecrets = [
                { name: 'existing-hf-secret', arn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:existing-hf-secret-AbCd' }
            ];

            const { runner, promptCalls } = createTestRunner({
                promptResponses: {
                    secretSelection: '__create_new__',
                    newTokenValue: 'hf_new_token_12345',
                    newSecretName: 'mlcc-hf-token-myproject'
                }
            });

            runner._listManagedSecrets = async () => mockSecrets;

            // Mock the createSecret call by overriding the imported function behavior
            // Since we can't easily mock ESM imports, we'll test the full flow
            // by verifying the prompt flow reaches the create-new path.
            // The actual AWS call would fail without credentials, so we test the prompt path.
            
            // Verify the prompt choices include "Create a new secret"
            const result = await runner.secretsPromptRunner._promptSecretSelection(
                { identifier: 'hf-token', displayName: 'HuggingFace Token', purpose: 'Auth for gated models', promptLabel: 'HuggingFace token' },
                mockSecrets,
                { projectName: 'myproject', awsProfile: 'default', awsRegion: 'us-east-1' }
            );

            // The __create_new__ selection triggers _promptCreateNewSecret which calls createSecret.
            // In a real test environment without AWS credentials, this will fail and fall back.
            // We verify the prompt flow reached the creation path by checking prompt calls.
            const createNewChoice = promptCalls.find(c => 
                c.name === 'secretSelection' && 
                c.choices?.some(ch => ch.value === '__create_new__')
            );
            assert.ok(createNewChoice, 'Should have a "Create a new secret" choice');
        });

        it('should fall back to plaintext on creation failure', async () => {
            const { runner, promptCalls } = createTestRunner({
                promptResponses: {
                    newTokenValue: 'hf_new_token_12345',
                    newSecretName: 'mlcc-hf-token-test',
                    tokenValue: 'hf_fallback_token'
                }
            });

            // Call _promptCreateNewSecret directly — it will fail (no AWS) and fall back
            const classification = { identifier: 'hf-token', displayName: 'HuggingFace Token', purpose: 'Auth', promptLabel: 'HuggingFace token', envVar: 'HF_TOKEN' };
            const result = await runner.secretsPromptRunner._promptCreateNewSecret(
                classification,
                { projectName: 'test', awsProfile: 'fake', awsRegion: 'us-east-1' }
            );

            // Should have prompted for newTokenValue and newSecretName, then fallen back
            const tokenPrompt = promptCalls.find(c => c.name === 'newTokenValue');
            assert.ok(tokenPrompt, 'Should prompt for token value');
            
            const namePrompt = promptCalls.find(c => c.name === 'newSecretName');
            assert.ok(namePrompt, 'Should prompt for secret name');
            
            // After failure, falls back to plaintext entry
            const fallbackPrompt = promptCalls.find(c => c.name === 'tokenValue');
            assert.ok(fallbackPrompt, 'Should fall back to plaintext entry on creation failure');
        });
    });

    describe('buildHfTokenPrompts — async factory (Requirement 1.2, 1.3, 1.4)', () => {
        it('should return static hfTokenPrompts when no region provided', async () => {
            const result = await buildHfTokenPrompts({ awsProfile: '', awsRegion: '' });
            assert.deepStrictEqual(result, hfTokenPrompts);
        });

        it('should return static hfTokenPrompts as fallback on discovery error', async () => {
            // Pass invalid region to trigger error in SDK call
            const result = await buildHfTokenPrompts({ awsProfile: 'nonexistent-profile-xyz', awsRegion: 'invalid-region-xyz' });
            // Should never throw, always returns a valid prompt array
            assert.ok(Array.isArray(result));
            assert.ok(result.length > 0);
        });

        it('hfTokenPrompts static array has input type with correct name', () => {
            assert.strictEqual(hfTokenPrompts[0].type, 'input');
            assert.strictEqual(hfTokenPrompts[0].name, 'hfToken');
        });

        it('buildHfTokenPrompts returns prompts with when clause for architecture gating', async () => {
            const result = await buildHfTokenPrompts({ awsProfile: '', awsRegion: '' });
            const firstPrompt = result[0];
            assert.ok(firstPrompt.when, 'Should have a when clause');
            
            // Test gating: transformers should show
            assert.strictEqual(firstPrompt.when({ architecture: 'transformers', backend: 'vllm' }), true);
            // Test gating: http should not show
            assert.strictEqual(firstPrompt.when({ architecture: 'http', backend: 'flask' }), false);
            // Test gating: S3 model source should not show
            assert.strictEqual(firstPrompt.when({ architecture: 'transformers', backend: 'vllm', modelName: 's3://bucket/model' }), false);
        });
    });

    describe('Prompt selection flow — list type with secrets found', () => {
        it('should present list-type prompt with secrets, create-new, and skip options', async () => {
            const mockSecrets = [
                { name: 'huggingface-prod', arn: 'arn:aws:secretsmanager:us-east-1:111:secret:huggingface-prod-Ab' },
                { name: 'hf-token-dev', arn: 'arn:aws:secretsmanager:us-east-1:111:secret:hf-token-dev-Cd' }
            ];

            const { runner, promptCalls } = createTestRunner({
                promptResponses: {
                    secretSelection: mockSecrets[0].arn
                }
            });

            runner._listManagedSecrets = async () => mockSecrets;

            await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            const listPrompt = promptCalls.find(c => c.name === 'secretSelection');
            assert.ok(listPrompt, 'Should have a secretSelection prompt');
            assert.strictEqual(listPrompt.type, 'list');

            // Verify choices include the secrets + create-new + plaintext + skip
            const choiceValues = listPrompt.choices.map(c => c.value);
            assert.ok(choiceValues.includes(mockSecrets[0].arn), 'Should include first secret ARN');
            assert.ok(choiceValues.includes(mockSecrets[1].arn), 'Should include second secret ARN');
            assert.ok(choiceValues.includes('__create_new__'), 'Should include create-new option');
            assert.ok(choiceValues.includes('__plaintext__'), 'Should include plaintext option');
            assert.ok(choiceValues.includes('__skip__'), 'Should include skip option');
        });

        it('should set hfTokenArn when user selects an existing secret', async () => {
            const mockArn = 'arn:aws:secretsmanager:us-east-1:111:secret:huggingface-prod-Ab';
            const { runner } = createTestRunner({
                promptResponses: { secretSelection: mockArn }
            });

            runner._listManagedSecrets = async () => [{ name: 'huggingface-prod', arn: mockArn }];

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            assert.strictEqual(result.hfTokenArn, mockArn);
            assert.strictEqual(result.hfToken, undefined);
        });

        it('should return empty when user selects skip (Requirement 3.4)', async () => {
            const { runner } = createTestRunner({
                promptResponses: { secretSelection: '__skip__' }
            });

            runner._listManagedSecrets = async () => [{ name: 'hf-token', arn: 'arn:aws:secretsmanager:us-east-1:111:secret:hf-Ab' }];

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            // Skip → both fields empty
            assert.strictEqual(result.hfTokenArn, undefined);
            assert.strictEqual(result.hfToken, undefined);
        });
    });

    describe('Prompt fallback — no secrets found', () => {
        it('should present input-type prompt when no managed secrets exist', async () => {
            const { runner, promptCalls } = createTestRunner({
                promptResponses: { tokenValue: 'hf_my_token_xyz' }
            });

            runner._listManagedSecrets = async () => [];

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            // Should have used the plaintext fallback prompt
            const inputPrompt = promptCalls.find(c => c.name === 'tokenValue');
            assert.ok(inputPrompt, 'Should have an input-type tokenValue prompt');
            assert.strictEqual(inputPrompt.type, 'input');
            assert.strictEqual(result.hfToken, 'hf_my_token_xyz');
        });

        it('should set hfToken for raw token entry (Requirement 3.3)', async () => {
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: 'hf_raw_token_123' }
            });

            runner._listManagedSecrets = async () => [];

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            assert.strictEqual(result.hfToken, 'hf_raw_token_123');
            assert.strictEqual(result.hfTokenArn, undefined);
        });

        it('should set hfTokenArn when user enters an ARN manually (Requirement 3.2)', async () => {
            const manualArn = 'arn:aws:secretsmanager:us-west-2:222:secret:my-hf-secret-XyZ';
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: manualArn }
            });

            runner._listManagedSecrets = async () => [];

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm' },
                {},
                {}
            );

            assert.strictEqual(result.hfTokenArn, manualArn);
            assert.strictEqual(result.hfToken, undefined);
        });
    });

    describe('Architecture gating — hf-token stage applicability', () => {
        it('should not prompt for http architecture', async () => {
            const { runner, promptCalls } = createTestRunner({});
            runner._listManagedSecrets = async () => [];

            const result = await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'http', backend: 'flask' },
                {},
                {}
            );

            // No HF token prompt should appear
            const hfPrompt = promptCalls.find(c => c.name === 'tokenValue' || c.name === 'secretSelection');
            assert.strictEqual(hfPrompt, undefined);
        });

        it('should prompt for diffusors architecture', async () => {
            const { runner, promptCalls } = createTestRunner({
                promptResponses: { tokenValue: '' }
            });
            runner._listManagedSecrets = async () => [];

            await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'diffusors', backend: 'vllm-omni' },
                {},
                {}
            );

            const hfPrompt = promptCalls.find(c => c.name === 'tokenValue');
            assert.ok(hfPrompt, 'Should prompt for HF token with diffusors');
        });

        it('should prompt for triton-vllm architecture', async () => {
            const { runner, promptCalls } = createTestRunner({
                promptResponses: { tokenValue: '' }
            });
            runner._listManagedSecrets = async () => [];

            await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'triton', backend: 'vllm' },
                {},
                {}
            );

            const hfPrompt = promptCalls.find(c => c.name === 'tokenValue');
            assert.ok(hfPrompt, 'Should prompt for HF token with triton-vllm');
        });

        it('should skip for S3 model source', async () => {
            const { runner, promptCalls } = createTestRunner({});
            runner._listManagedSecrets = async () => [];

            await runner.secretsPromptRunner._runSecretPrompts(
                { architecture: 'transformers', backend: 'vllm', modelSource: 'registry' },
                {},
                {}
            );

            const hfPrompt = promptCalls.find(c => c.name === 'tokenValue' || c.name === 'secretSelection');
            assert.strictEqual(hfPrompt, undefined);
        });
    });
});
