// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Prompt Runner - Handles secret selection and plaintext entry prompts.
 * Uses delegation pattern: receives parent PromptRunner reference to access shared state.
 */

import { execSync } from 'node:child_process';
import { SECRET_CLASSIFICATIONS } from './secret-classification.js';
import { isSecretsManagerArn } from './arn-detection.js';
import BootstrapConfig from './bootstrap-config.js';
import { discoverSecrets, createSecret } from './prompts/secrets-discovery.js';

export default class SecretsPromptRunner {
    constructor(runner) {
        this.runner = runner;
    }

    /**
     * Run secret prompts using the Secret_Classification registry.
     * @param {object} previousAnswers - Answers from previous prompt phases
     * @param {object} explicitConfig - Explicit CLI/config values
     * @param {object} existingConfig - Existing project configuration
     * @returns {Promise<object>} Object with token/ARN values keyed by config field names
     */
    async _runSecretPrompts(previousAnswers, explicitConfig, existingConfig) {
        const results = {};

        for (const classification of SECRET_CLASSIFICATIONS) {
            if (!this._secretStagesApply(classification, previousAnswers)) continue;

            const arnConfigKey = this._getArnConfigKey(classification);
            const plaintextConfigKey = this._getPlaintextConfigKey(classification);

            if (explicitConfig[arnConfigKey]) {
                results[arnConfigKey] = explicitConfig[arnConfigKey];
                continue;
            }

            if (explicitConfig[plaintextConfigKey]) {
                results[plaintextConfigKey] = explicitConfig[plaintextConfigKey];
                continue;
            }

            const managedSecrets = await this._listManagedSecrets(classification.identifier);

            if (managedSecrets.length > 0) {
                const answer = await this._promptSecretSelection(classification, managedSecrets, previousAnswers);
                Object.assign(results, answer);
            } else {
                const answer = await this._promptPlaintextFallback(classification, previousAnswers, explicitConfig, existingConfig);
                Object.assign(results, answer);
            }
        }

        return results;
    }

    _secretStagesApply(classification, answers) {
        const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
        const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');

        if (classification.identifier === 'hf-token') {
            const isTransformers = architecture === 'transformers';
            const isDiffusors = architecture === 'diffusors';
            const isTritonLlm = architecture === 'triton' && (backend === 'vllm' || backend === 'tensorrtllm');

            if (!isTransformers && !isDiffusors && !isTritonLlm) return false;

            const modelSource = answers.modelSource;
            if (modelSource && modelSource !== 'huggingface') return false;

            // Skip HF token when model name is an S3 URI (no HF download needed)
            const modelName = answers.customModelName || answers.modelName;
            if (modelName && modelName.startsWith('s3://')) return false;

            return true;
        }

        if (classification.identifier === 'ngc-token') {
            if (architecture === 'triton') return false;
            if (architecture === 'diffusors') return false;
            return architecture === 'transformers' && backend === 'tensorrt-llm';
        }

        return classification.stages.length > 0;
    }

    _getArnConfigKey(classification) {
        const keyMap = {
            'hf-token': 'hfTokenArn',
            'ngc-token': 'ngcTokenArn'
        };
        return keyMap[classification.identifier] || `${classification.identifier.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Arn`;
    }

    _getPlaintextConfigKey(classification) {
        const keyMap = {
            'hf-token': 'hfToken',
            'ngc-token': 'ngcApiKey'
        };
        return keyMap[classification.identifier] || classification.identifier.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }

    async _listManagedSecrets(secretType) {
        // Allow test overrides on the parent runner
        if (this.runner._listManagedSecrets && this.runner._listManagedSecrets !== this._listManagedSecrets) {
            return this.runner._listManagedSecrets(secretType);
        }
        try {
            const bootstrapConfig = new BootstrapConfig();
            const activeProfile = bootstrapConfig.getActiveProfile();
            if (!activeProfile) return [];

            const profile = activeProfile.config.awsProfile;
            const region = activeProfile.config.awsRegion;
            if (!profile || !region) return [];

            // BL067: Use SDK-based name-pattern discovery for hf-token secrets
            // (Requirement 1.1) — search by naming convention in addition to tags
            if (secretType === 'hf-token') {
                const namePatterns = ['huggingface', 'hf-token', 'hf_token'];
                const results = await Promise.all(
                    namePatterns.map(pattern => discoverSecrets(pattern, profile, region))
                );

                // Deduplicate by ARN
                const arnSet = new Set();
                const allSecrets = [];
                for (const secrets of results) {
                    for (const secret of secrets) {
                        if (!arnSet.has(secret.arn)) {
                            arnSet.add(secret.arn);
                            allSecrets.push(secret);
                        }
                    }
                }

                // Also try existing tag-based discovery as fallback
                if (allSecrets.length === 0) {
                    return this._listManagedSecretsByTag(secretType, profile, region);
                }

                return allSecrets;
            }

            // For non-hf-token types, use the existing tag-based discovery
            return this._listManagedSecretsByTag(secretType, profile, region);
        } catch {
            return [];
        }
    }

    /**
     * Legacy tag-based secret listing using AWS CLI.
     * @param {string} secretType - The secret type tag value
     * @param {string} profile - AWS profile name
     * @param {string} region - AWS region
     * @returns {Promise<Array<{name: string, arn: string}>>}
     */
    async _listManagedSecretsByTag(secretType, profile, region) {
        try {
            const command = `aws secretsmanager list-secrets --filters Key=tag-key,Values=mlcc:managed-by Key=tag-value,Values=ml-container-creator --region ${region} --profile ${profile} --output json`;
            const output = execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
            const trimmed = output.trim();
            if (!trimmed) return [];

            const result = JSON.parse(trimmed);
            const secrets = result.SecretList || [];

            return secrets
                .filter(secret => {
                    const typeTag = (secret.Tags || []).find(t => t.Key === 'mlcc:secret-type');
                    return typeTag && typeTag.Value === secretType;
                })
                .map(secret => ({
                    name: secret.Name,
                    arn: secret.ARN
                }));
        } catch {
            return [];
        }
    }

    async _promptSecretSelection(classification, managedSecrets, previousAnswers) {
        const arnConfigKey = this._getArnConfigKey(classification);

        console.log(`\n🔐 ${classification.displayName}`);
        console.log(`   ${classification.purpose}`);

        const choices = [
            ...managedSecrets.map(secret => ({
                name: `🔒 ${secret.name} (${secret.arn})`,
                value: secret.arn,
                short: secret.name
            })),
            { name: '✨ Create a new secret', value: '__create_new__', short: 'Create new' },
            { name: '✏️  Enter plaintext token', value: '__plaintext__', short: 'Plaintext' },
            { name: '⏭️  Skip (use environment variable)', value: '__skip__', short: 'Skip' }
        ];

        const { secretSelection } = await this.runner._runPrompts([{
            type: 'list',
            name: 'secretSelection',
            message: `Select ${classification.promptLabel}:`,
            choices
        }]);

        if (secretSelection === '__skip__') {
            return {};
        }

        if (secretSelection === '__plaintext__') {
            return this._promptPlaintextEntry(classification, previousAnswers);
        }

        // BL067: Inline secret creation (Requirement 2.1)
        if (secretSelection === '__create_new__') {
            return this._promptCreateNewSecret(classification, previousAnswers);
        }

        return { [arnConfigKey]: secretSelection };
    }

    /**
     * BL067: Inline secret creation flow (Requirement 2.1, 2.2).
     * Prompts for token value and secret name, creates the secret in Secrets Manager.
     * Falls back to plaintext entry on failure.
     *
     * @param {object} classification - Secret classification object
     * @param {object} previousAnswers - Answers from previous prompt phases
     * @returns {Promise<object>} Object with ARN or plaintext token key
     */
    async _promptCreateNewSecret(classification, previousAnswers) {
        const arnConfigKey = this._getArnConfigKey(classification);

        // Prompt for the raw token value (masked)
        const { newTokenValue } = await this.runner._runPrompts([{
            type: 'password',
            name: 'newTokenValue',
            message: `Enter ${classification.promptLabel} value:`,
            mask: '*',
            validate: (input) => {
                if (!input || input.trim() === '') {
                    return `${classification.promptLabel} value is required`;
                }
                return true;
            }
        }]);

        if (!newTokenValue || newTokenValue.trim() === '') {
            return {};
        }

        // Determine default name
        const projectName = previousAnswers.projectName || 'project';
        const defaultName = `mlcc-hf-token-${projectName}`;

        // Prompt for secret name
        const { newSecretName } = await this.runner._runPrompts([{
            type: 'input',
            name: 'newSecretName',
            message: 'Secret name in Secrets Manager:',
            default: defaultName
        }]);

        const secretName = (newSecretName || defaultName).trim();

        // Get profile and region
        try {
            const bootstrapConfig = new BootstrapConfig();
            const activeProfile = bootstrapConfig.getActiveProfile();
            const awsProfile = activeProfile?.config?.awsProfile || previousAnswers.awsProfile || '';
            const region = activeProfile?.config?.awsRegion || previousAnswers.awsRegion || '';

            const result = await createSecret(secretName, newTokenValue.trim(), awsProfile, region);
            console.log(`   ✅ Secret created: ${result.arn}`);

            // BL076 integration: write ARN to profile if available
            if (activeProfile) {
                try {
                    const config = bootstrapConfig.read();
                    if (config && config.profiles && config.profiles[activeProfile.name]) {
                        if (!config.profiles[activeProfile.name].secrets) {
                            config.profiles[activeProfile.name].secrets = {};
                        }
                        config.profiles[activeProfile.name].secrets.hfToken = result.arn;
                        bootstrapConfig.write(config);
                    }
                } catch {
                    // Non-fatal: profile write failure doesn't block generation
                }
            }

            return { [arnConfigKey]: result.arn };
        } catch (err) {
            // Requirement 2.2: Fall back to plaintext on creation failure
            console.error(`   ❌ Failed to create secret: ${err.message}`);
            console.log('   Falling back to manual entry.\n');
            return this._promptPlaintextEntry(classification, previousAnswers);
        }
    }

    async _promptPlaintextEntry(classification, _previousAnswers) {
        const arnConfigKey = this._getArnConfigKey(classification);
        const plaintextConfigKey = this._getPlaintextConfigKey(classification);

        const { tokenValue } = await this.runner._runPrompts([{
            type: 'input',
            name: 'tokenValue',
            message: `${classification.promptLabel} (enter token, ARN, or leave empty):`,
            validate: (input) => {
                if (!input || input.trim() === '') return true;
                if (input.trim().startsWith('$')) return true;
                return true;
            }
        }]);

        if (!tokenValue || tokenValue.trim() === '') {
            return {};
        }

        const value = tokenValue.trim();

        if (isSecretsManagerArn(value)) {
            return { [arnConfigKey]: value };
        }

        return { [plaintextConfigKey]: value };
    }

    async _promptPlaintextFallback(classification, _previousAnswers, _explicitConfig, _existingConfig) {
        const arnConfigKey = this._getArnConfigKey(classification);
        const plaintextConfigKey = this._getPlaintextConfigKey(classification);

        if (this.runner.configManager?.isAutoPrompt()) {
            return {};
        }

        if (classification.identifier === 'hf-token') {
            console.log('\n🔐 HuggingFace Authentication');
            console.log('   Many models (e.g. Llama, Mistral) are gated and require a token.');
            console.log('   💡 Tip: Use `ml-container-creator secrets create --type hf-token` to store');
            console.log('   your token in AWS Secrets Manager for zero-knowledge operation.');
            console.log('   For CI/CD pipelines, use "$HF_TOKEN" to reference an environment variable.\n');
        } else if (classification.identifier === 'ngc-token') {
            console.log('\n🔐 NVIDIA NGC Authentication');
            console.log('   TensorRT-LLM base images are hosted on NVIDIA NGC and require an API key.');
            console.log('   💡 Tip: Use `ml-container-creator secrets create --type ngc-token` to store');
            console.log('   your key in AWS Secrets Manager for zero-knowledge operation.');
            console.log('   For CI/CD pipelines, use "$NGC_API_KEY" to reference an environment variable.\n');
        } else {
            console.log(`\n🔐 ${classification.displayName}`);
            console.log(`   ${classification.purpose}\n`);
        }

        const { tokenValue } = await this.runner._runPrompts([{
            type: 'input',
            name: 'tokenValue',
            message: `${classification.promptLabel} (enter token, ARN, "$${classification.envVar}" for env var, or leave empty):`,
            validate: (input) => {
                if (!input || input.trim() === '') return true;
                if (input.trim().startsWith('$')) return true;
                if (classification.identifier === 'hf-token' && !input.startsWith('hf_') && !isSecretsManagerArn(input)) {
                    console.warn('\n⚠️  Warning: HuggingFace tokens typically start with "hf_"');
                    console.warn('   If this is intentional, you can ignore this warning.');
                }
                return true;
            }
        }]);

        if (!tokenValue || tokenValue.trim() === '') {
            return {};
        }

        const value = tokenValue.trim();

        if (isSecretsManagerArn(value)) {
            return { [arnConfigKey]: value };
        }

        return { [plaintextConfigKey]: value };
    }
}
