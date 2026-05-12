// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for PromptRunner secret prompt flow integration
 *
 * Tests the registry-driven secret selection flow including:
 * - Secret selection list appears when managed secrets exist
 * - Fallback to plaintext when no managed secrets exist
 * - ARN detection in custom value entry
 * - Stage applicability filtering
 * - CLI flag skip behavior
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import PromptRunner from '../../src/lib/prompt-runner.js';

/**
 * Creates a PromptRunner instance with mocked dependencies.
 * @param {object} opts - Configuration options
 * @param {object} opts.promptResponses - Map of prompt name → response value
 * @param {object} opts.configManager - Mock config manager
 * @param {object} opts.options - CLI options
 * @returns {object} Object with runner instance and tracking helpers
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

describe('PromptRunner Secret Prompt Integration (Requirements 8.1–8.9)', () => {

    describe('_secretStagesApply — stage filtering (Requirement 8.9)', () => {
        it('should return true for hf-token when architecture is transformers', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };
            const answers = { architecture: 'transformers', backend: 'vllm' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), true);
        });

        it('should return true for hf-token when architecture is diffusors', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };
            const answers = { architecture: 'diffusors', backend: 'diffusers' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), true);
        });

        it('should return true for hf-token when architecture is triton with vllm backend', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };
            const answers = { architecture: 'triton', backend: 'vllm' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), true);
        });

        it('should return false for hf-token when architecture is predictor', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };
            const answers = { architecture: 'predictor', backend: 'flask' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), false);
        });

        it('should return false for hf-token when architecture is http', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };
            const answers = { architecture: 'http', backend: 'flask' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), false);
        });

        it('should return false for hf-token when modelSource is not huggingface', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };
            const answers = { architecture: 'transformers', backend: 'vllm', modelSource: 's3' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), false);
        });

        it('should return true for ngc-token when architecture is transformers with tensorrt-llm backend', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'ngc-token', stages: ['build-time'] };
            const answers = { architecture: 'transformers', backend: 'tensorrt-llm' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), true);
        });

        it('should return false for ngc-token when architecture is transformers with vllm backend', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'ngc-token', stages: ['build-time'] };
            const answers = { architecture: 'transformers', backend: 'vllm' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), false);
        });

        it('should derive architecture from deploymentConfig when architecture is not set', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token', stages: ['build-time', 'runtime'] };
            const answers = { deploymentConfig: 'transformers-vllm' };

            assert.strictEqual(runner._secretStagesApply(classification, answers), true);
        });
    });

    describe('_getArnConfigKey / _getPlaintextConfigKey — key mapping', () => {
        it('should map hf-token to hfTokenArn', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token' };

            assert.strictEqual(runner._getArnConfigKey(classification), 'hfTokenArn');
        });

        it('should map ngc-token to ngcTokenArn', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'ngc-token' };

            assert.strictEqual(runner._getArnConfigKey(classification), 'ngcTokenArn');
        });

        it('should map hf-token to hfToken for plaintext', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'hf-token' };

            assert.strictEqual(runner._getPlaintextConfigKey(classification), 'hfToken');
        });

        it('should map ngc-token to ngcApiKey for plaintext', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'ngc-token' };

            assert.strictEqual(runner._getPlaintextConfigKey(classification), 'ngcApiKey');
        });

        it('should generate camelCase key for unknown identifiers', () => {
            const { runner } = createTestRunner();
            const classification = { identifier: 'pypi-token' };

            assert.strictEqual(runner._getArnConfigKey(classification), 'pypiTokenArn');
            assert.strictEqual(runner._getPlaintextConfigKey(classification), 'pypiToken');
        });
    });

    describe('_promptSecretSelection — selection list (Requirements 8.1, 8.2, 8.3)', () => {
        it('should display managed secrets in selection list and store ARN when selected', async () => {
            const testArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const { runner, promptCalls } = createTestRunner({
                promptResponses: { secretSelection: testArn }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download from HuggingFace Hub',
                promptLabel: 'HuggingFace token'
            };
            const managedSecrets = [
                { name: 'mlcc/hf-token/prod', arn: testArn }
            ];

            const result = await runner._promptSecretSelection(classification, managedSecrets, {});

            // Should have prompted with a list type
            assert.strictEqual(promptCalls.length, 1);
            assert.strictEqual(promptCalls[0].name, 'secretSelection');
            assert.strictEqual(promptCalls[0].type, 'list');

            // Choices should include managed secret + plaintext + skip
            const choices = promptCalls[0].choices;
            assert.strictEqual(choices.length, 3);
            assert.strictEqual(choices[0].value, testArn);
            assert.strictEqual(choices[1].value, '__plaintext__');
            assert.strictEqual(choices[2].value, '__skip__');

            // Result should store the ARN
            assert.deepStrictEqual(result, { hfTokenArn: testArn });
        });

        it('should display multiple managed secrets in the list', async () => {
            const arn1 = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const arn2 = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/dev-GhIjKl';
            const { runner, promptCalls } = createTestRunner({
                promptResponses: { secretSelection: arn2 }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download',
                promptLabel: 'HuggingFace token'
            };
            const managedSecrets = [
                { name: 'mlcc/hf-token/prod', arn: arn1 },
                { name: 'mlcc/hf-token/dev', arn: arn2 }
            ];

            const result = await runner._promptSecretSelection(classification, managedSecrets, {});

            // Should have 4 choices: 2 secrets + plaintext + skip
            const choices = promptCalls[0].choices;
            assert.strictEqual(choices.length, 4);
            assert.strictEqual(choices[0].value, arn1);
            assert.strictEqual(choices[1].value, arn2);

            assert.deepStrictEqual(result, { hfTokenArn: arn2 });
        });

        it('should return empty object when user selects skip', async () => {
            const { runner } = createTestRunner({
                promptResponses: { secretSelection: '__skip__' }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download',
                promptLabel: 'HuggingFace token'
            };
            const managedSecrets = [
                { name: 'mlcc/hf-token/prod', arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf' }
            ];

            const result = await runner._promptSecretSelection(classification, managedSecrets, {});

            assert.deepStrictEqual(result, {});
        });

        it('should delegate to _promptPlaintextEntry when user selects plaintext', async () => {
            const { runner } = createTestRunner({
                promptResponses: {
                    secretSelection: '__plaintext__',
                    tokenValue: 'hf_myplaintexttoken123'
                }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download',
                promptLabel: 'HuggingFace token'
            };
            const managedSecrets = [
                { name: 'mlcc/hf-token/prod', arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf' }
            ];

            const result = await runner._promptSecretSelection(classification, managedSecrets, {});

            // Should store as plaintext
            assert.deepStrictEqual(result, { hfToken: 'hf_myplaintexttoken123' });
        });
    });

    describe('_promptPlaintextEntry — ARN detection (Requirements 8.4, 8.5, 8.6)', () => {
        it('should store value as ARN when input is a Secrets Manager ARN', async () => {
            const testArn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:mlcc/hf-token/ci-XyZaBc';
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: testArn }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download',
                promptLabel: 'HuggingFace token'
            };

            const result = await runner._promptPlaintextEntry(classification, {});

            assert.deepStrictEqual(result, { hfTokenArn: testArn });
        });

        it('should store value as plaintext when input is not an ARN', async () => {
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: 'hf_mytoken123' }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download',
                promptLabel: 'HuggingFace token'
            };

            const result = await runner._promptPlaintextEntry(classification, {});

            assert.deepStrictEqual(result, { hfToken: 'hf_mytoken123' });
        });

        it('should return empty object when input is empty', async () => {
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: '' }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download',
                promptLabel: 'HuggingFace token'
            };

            const result = await runner._promptPlaintextEntry(classification, {});

            assert.deepStrictEqual(result, {});
        });

        it('should trim whitespace before ARN detection', async () => {
            const testArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: `  ${testArn}  ` }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                purpose: 'Gated model download',
                promptLabel: 'HuggingFace token'
            };

            const result = await runner._promptPlaintextEntry(classification, {});

            assert.deepStrictEqual(result, { hfTokenArn: testArn });
        });

        it('should store NGC token ARN correctly', async () => {
            const testArn = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:mlcc/ngc-token/team-AbCdEf';
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: testArn }
            });

            const classification = {
                identifier: 'ngc-token',
                displayName: 'NVIDIA NGC Token',
                purpose: 'Pulling base images from NVIDIA NGC registry',
                promptLabel: 'NVIDIA NGC API key'
            };

            const result = await runner._promptPlaintextEntry(classification, {});

            assert.deepStrictEqual(result, { ngcTokenArn: testArn });
        });

        it('should store NGC plaintext correctly', async () => {
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: 'nvapi-mykey456' }
            });

            const classification = {
                identifier: 'ngc-token',
                displayName: 'NVIDIA NGC Token',
                purpose: 'Pulling base images from NVIDIA NGC registry',
                promptLabel: 'NVIDIA NGC API key'
            };

            const result = await runner._promptPlaintextEntry(classification, {});

            assert.deepStrictEqual(result, { ngcApiKey: 'nvapi-mykey456' });
        });
    });

    describe('_promptPlaintextFallback — no managed secrets (Requirement 8.7)', () => {
        it('should prompt for plaintext and store value when no managed secrets exist', async () => {
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: 'hf_fallbacktoken' }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                stages: ['build-time', 'runtime'],
                purpose: 'Gated model download from HuggingFace Hub',
                promptLabel: 'HuggingFace token',
                envVar: 'HF_TOKEN'
            };

            const result = await runner._promptPlaintextFallback(classification, {}, {}, {});

            assert.deepStrictEqual(result, { hfToken: 'hf_fallbacktoken' });
        });

        it('should detect ARN in fallback plaintext entry', async () => {
            const testArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: testArn }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                stages: ['build-time', 'runtime'],
                purpose: 'Gated model download from HuggingFace Hub',
                promptLabel: 'HuggingFace token',
                envVar: 'HF_TOKEN'
            };

            const result = await runner._promptPlaintextFallback(classification, {}, {}, {});

            assert.deepStrictEqual(result, { hfTokenArn: testArn });
        });

        it('should return empty object when input is empty in fallback', async () => {
            const { runner } = createTestRunner({
                promptResponses: { tokenValue: '' }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                stages: ['build-time', 'runtime'],
                purpose: 'Gated model download from HuggingFace Hub',
                promptLabel: 'HuggingFace token',
                envVar: 'HF_TOKEN'
            };

            const result = await runner._promptPlaintextFallback(classification, {}, {}, {});

            assert.deepStrictEqual(result, {});
        });

        it('should skip prompting in auto-prompt mode', async () => {
            const { runner, promptCalls } = createTestRunner({
                configManager: {
                    parameterMatrix: {},
                    getExplicitConfiguration: () => ({}),
                    isAutoPrompt: () => true
                },
                promptResponses: { tokenValue: 'should-not-be-used' }
            });

            const classification = {
                identifier: 'hf-token',
                displayName: 'HuggingFace Token',
                stages: ['build-time', 'runtime'],
                purpose: 'Gated model download from HuggingFace Hub',
                promptLabel: 'HuggingFace token',
                envVar: 'HF_TOKEN'
            };

            const result = await runner._promptPlaintextFallback(classification, {}, {}, {});

            assert.deepStrictEqual(result, {});
            assert.strictEqual(promptCalls.length, 0, 'Should not prompt in auto-prompt mode');
        });
    });

    describe('_runSecretPrompts — orchestration (Requirements 8.1, 8.8)', () => {
        it('should skip classification when stages do not apply', async () => {
            const { runner } = createTestRunner({
                promptResponses: {}
            });

            // Mock _listManagedSecrets to track calls
            const listCalls = [];
            runner._listManagedSecrets = async (secretType) => {
                listCalls.push(secretType);
                return [];
            };

            // predictor architecture — hf-token and ngc-token should not apply
            const previousAnswers = { architecture: 'predictor', backend: 'flask' };
            const result = await runner._runSecretPrompts(previousAnswers, {}, {});

            assert.deepStrictEqual(result, {});
            assert.strictEqual(listCalls.length, 0, 'Should not query secrets for non-applicable stages');
        });

        it('should skip classification when ARN already provided via CLI', async () => {
            const existingArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const { runner } = createTestRunner({});

            const listCalls = [];
            runner._listManagedSecrets = async (secretType) => {
                listCalls.push(secretType);
                return [];
            };

            const previousAnswers = { architecture: 'transformers', backend: 'vllm' };
            const explicitConfig = { hfTokenArn: existingArn };
            const result = await runner._runSecretPrompts(previousAnswers, explicitConfig, {});

            // Should use the explicit ARN directly
            assert.strictEqual(result.hfTokenArn, existingArn);
            // Should not have queried for hf-token secrets
            assert.ok(!listCalls.includes('hf-token'), 'Should not query for hf-token when ARN is explicit');
        });

        it('should skip classification when plaintext already provided via CLI', async () => {
            const { runner } = createTestRunner({});

            const listCalls = [];
            runner._listManagedSecrets = async (secretType) => {
                listCalls.push(secretType);
                return [];
            };

            const previousAnswers = { architecture: 'transformers', backend: 'vllm' };
            const explicitConfig = { hfToken: 'hf_explicit123' };
            const result = await runner._runSecretPrompts(previousAnswers, explicitConfig, {});

            assert.strictEqual(result.hfToken, 'hf_explicit123');
            assert.ok(!listCalls.includes('hf-token'), 'Should not query for hf-token when plaintext is explicit');
        });

        it('should show selection list when managed secrets exist', async () => {
            const testArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const { runner, promptCalls } = createTestRunner({
                promptResponses: { secretSelection: testArn }
            });

            runner._listManagedSecrets = async (secretType) => {
                if (secretType === 'hf-token') {
                    return [{ name: 'mlcc/hf-token/prod', arn: testArn }];
                }
                return [];
            };

            const previousAnswers = { architecture: 'transformers', backend: 'vllm' };
            const result = await runner._runSecretPrompts(previousAnswers, {}, {});

            assert.strictEqual(result.hfTokenArn, testArn);
            // Should have shown a list prompt
            const listPrompt = promptCalls.find(p => p.name === 'secretSelection');
            assert.ok(listPrompt, 'Should have shown secretSelection prompt');
            assert.strictEqual(listPrompt.type, 'list');
        });

        it('should fall back to plaintext prompt when no managed secrets exist', async () => {
            const { runner, promptCalls } = createTestRunner({
                promptResponses: { tokenValue: 'hf_fallback123' }
            });

            runner._listManagedSecrets = async () => [];

            const previousAnswers = { architecture: 'transformers', backend: 'vllm' };
            const result = await runner._runSecretPrompts(previousAnswers, {}, {});

            assert.strictEqual(result.hfToken, 'hf_fallback123');
            // Should have shown a tokenValue prompt (plaintext fallback)
            const tokenPrompt = promptCalls.find(p => p.name === 'tokenValue');
            assert.ok(tokenPrompt, 'Should have shown tokenValue prompt as fallback');
        });

        it('should process multiple classifications in sequence (Requirement 8.8)', async () => {
            const hfArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const ngcArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/team-GhIjKl';

            // Track prompt call order
            let promptCallIndex = 0;
            const promptFn = async (prompts) => {
                const answers = {};
                for (const p of prompts) {
                    promptCallIndex++;
                    if (p.name === 'secretSelection') {
                        // First call is for hf-token, second for ngc-token
                        answers[p.name] = promptCallIndex <= 1 ? hfArn : ngcArn;
                    }
                }
                return answers;
            };

            const runner = new PromptRunner({
                configManager: {
                    parameterMatrix: {},
                    getExplicitConfiguration: () => ({}),
                    isAutoPrompt: () => false
                },
                options: {},
                registryConfigManager: null,
                baseConfig: {},
                promptFn
            });

            runner._listManagedSecrets = async (secretType) => {
                if (secretType === 'hf-token') {
                    return [{ name: 'mlcc/hf-token/prod', arn: hfArn }];
                }
                if (secretType === 'ngc-token') {
                    return [{ name: 'mlcc/ngc-token/team', arn: ngcArn }];
                }
                return [];
            };

            // transformers + tensorrt-llm triggers both hf-token and ngc-token
            const previousAnswers = { architecture: 'transformers', backend: 'tensorrt-llm' };
            const result = await runner._runSecretPrompts(previousAnswers, {}, {});

            assert.strictEqual(result.hfTokenArn, hfArn);
            assert.strictEqual(result.ngcTokenArn, ngcArn);
        });
    });
});
