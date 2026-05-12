// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Command Handler
 *
 * Handles the `secrets` CLI subcommand tree for managing secrets in
 * AWS Secrets Manager. Follows the same dispatch pattern as
 * BootstrapCommandHandler.
 *
 * Subcommands:
 *   create                             Create a new secret in Secrets Manager
 *   list                               List all mlcc-managed secrets
 *   describe <name-or-arn>             Show metadata for a specific secret
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runPrompts } from '../prompt-adapter.js';
import { SECRET_CLASSIFICATIONS } from './secret-classification.js';
import BootstrapConfig from './bootstrap-config.js';

export default class SecretsCommandHandler {
    constructor({ promptFn, execAwsFn } = {}) {
        this._promptFn = promptFn || runPrompts;
        this._execAwsFn = execAwsFn || null;
        this._bootstrapConfig = new BootstrapConfig();
    }

    /**
     * Dispatch secrets subcommands.
     * @param {string[]} args - Positional args after 'secrets'
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options) {
        if (args.length === 0) {
            this._showHelp();
            return;
        }

        const subcommand = args[0].toLowerCase();

        switch (subcommand) {
        case 'create':
            await this._handleCreate(options);
            break;
        case 'list':
            await this._handleList();
            break;
        case 'describe':
            await this._handleDescribe(args[1]);
            break;
        default:
            console.log(`Unknown secrets subcommand: ${subcommand}`);
            this._showHelp();
            break;
        }
    }

    /**
     * Create a new secret in AWS Secrets Manager.
     * Supports three input modes:
     *   1. Interactive — prompts for type, name, and value
     *   2. --json flag — inline JSON or file:// path
     *   3. Individual flags — --type, --name, --secret-value, etc.
     * @param {object} options - Parsed CLI options
     */
    async _handleCreate(options) {
        let secretType, label, secretValue, description, kmsKeyId, userTags;

        if (options.json) {
            // JSON mode: parse inline JSON or read from file
            const jsonInput = await this._resolveJsonInput(options.json);
            if (!jsonInput) return;

            secretType = jsonInput.type || jsonInput.secretType;
            label = jsonInput.name || jsonInput.label;
            secretValue = jsonInput.secretValue || jsonInput['secret-value'];
            description = jsonInput.description;
            kmsKeyId = jsonInput.kmsKeyId || jsonInput['kms-key-id'];
            userTags = jsonInput.tags || [];
        } else if (options.type || options.name || options.secretValue) {
            // Flag mode: use individual CLI flags
            secretType = options.type;
            label = options.name;
            secretValue = options.secretValue;
            description = options.description;
            kmsKeyId = options.kmsKeyId;
            userTags = [];
        } else {
            // Interactive mode: prompt for all required fields
            const result = await this._runInteractiveCreate();
            if (!result) return;
            secretType = result.type;
            label = result.name;
            secretValue = result.secretValue;
            description = result.description;
            kmsKeyId = result.kmsKeyId;
            userTags = [];
        }

        // Validate required fields
        const missing = [];
        if (!secretType) missing.push('--type');
        if (!label) missing.push('--name');
        if (!secretValue) missing.push('--secret-value');

        if (missing.length > 0) {
            console.log(`❌ Missing required fields: ${missing.join(', ')}`);
            console.log('   Provide all required flags or run without flags for interactive mode.');
            process.exitCode = 1;
            return;
        }

        // Validate secret type against registry
        const classification = SECRET_CLASSIFICATIONS.find(c => c.identifier === secretType);
        if (!classification) {
            const validTypes = SECRET_CLASSIFICATIONS.map(c => c.identifier).join(', ');
            console.log(`❌ Unknown secret type: ${secretType}`);
            console.log(`   Valid types: ${validTypes}`);
            process.exitCode = 1;
            return;
        }

        // Construct the secret name
        const secretName = this._constructSecretName(secretType, label);

        // Merge tags
        const tags = this._mergeTags(userTags || [], secretType);

        // Build the create-secret command
        const { profile, region } = this._getActiveBootstrapContext();
        if (!profile) {
            console.log('❌ No active bootstrap profile found.');
            console.log('   Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            process.exitCode = 1;
            return;
        }

        // Write secret value to temp file to avoid shell exposure
        const secretValueFile = this._writeJsonTempFile(secretValue, 'secret-value');

        let command = `secretsmanager create-secret --name ${secretName} --secret-string ${secretValueFile} --tags ${this._formatTagsForCli(tags)} --region ${region}`;

        if (description) {
            command += ` --description "${description}"`;
        }
        if (kmsKeyId) {
            command += ` --kms-key-id ${kmsKeyId}`;
        }

        try {
            const result = this._execAws(command, profile);
            const arn = result.ARN || result.Name;
            console.log('✅ Secret created successfully');
            console.log(`   Name: ${secretName}`);
            console.log(`   ARN:  ${arn}`);
        } catch (error) {
            console.log(`❌ Failed to create secret: ${error.message}`);
            process.exitCode = 1;
        }
    }

    /**
     * Run the interactive secret creation flow.
     * Prompts for type, name, and value (password-masked).
     * @returns {object|null} Object with type, name, secretValue, description, kmsKeyId
     */
    async _runInteractiveCreate() {
        console.log('\n🔐 Create a new secret in AWS Secrets Manager\n');

        // Prompt for secret type
        const typeChoices = SECRET_CLASSIFICATIONS.map(c => ({
            name: `${c.displayName} — ${c.purpose}`,
            value: c.identifier
        }));

        const { secretType } = await this._promptFn([{
            type: 'list',
            name: 'secretType',
            message: 'Secret type:',
            choices: typeChoices
        }]);

        // Prompt for label
        const { label } = await this._promptFn([{
            type: 'input',
            name: 'label',
            message: 'Secret name (label):',
            validate: (val) => val && val.trim().length > 0 ? true : 'Name is required'
        }]);

        // Prompt for secret value (password-masked)
        const { value } = await this._promptFn([{
            type: 'password',
            name: 'value',
            message: 'Secret value:',
            mask: '*',
            validate: (val) => val && val.trim().length > 0 ? true : 'Value is required'
        }]);

        // Optional: description
        const { description } = await this._promptFn([{
            type: 'input',
            name: 'description',
            message: 'Description (optional):',
            default: ''
        }]);

        return {
            type: secretType,
            name: label.trim(),
            secretValue: value,
            description: description || undefined,
            kmsKeyId: undefined
        };
    }

    /**
     * Resolve JSON input from inline string or file:// path.
     * @param {string} jsonOrPath - Inline JSON string or file://path
     * @returns {object|null} Parsed JSON object, or null on error
     */
    async _resolveJsonInput(jsonOrPath) {
        let rawJson;

        if (jsonOrPath.startsWith('file://')) {
            const filePath = jsonOrPath.slice(7);
            if (!existsSync(filePath)) {
                console.log(`❌ File not found: ${filePath}`);
                process.exitCode = 1;
                return null;
            }
            rawJson = readFileSync(filePath, 'utf8');
        } else {
            rawJson = jsonOrPath;
        }

        try {
            return JSON.parse(rawJson);
        } catch (error) {
            console.log(`❌ Invalid JSON: ${error.message}`);
            process.exitCode = 1;
            return null;
        }
    }

    /**
     * Construct the secret name following the mlcc naming convention.
     * @param {string} type - Secret type identifier (e.g., 'hf-token')
     * @param {string} label - User-provided label
     * @returns {string} Constructed name in format mlcc/<type>/<label>
     */
    _constructSecretName(type, label) {
        return `mlcc/${type}/${label}`;
    }

    /**
     * Merge user-provided tags with required system tags.
     * System tags always win over user-provided tags with the mlcc: prefix.
     * User tags without the mlcc: prefix are preserved.
     * @param {Array<{Key: string, Value: string}>} userTags - User-provided tags
     * @param {string} secretType - Secret type identifier
     * @returns {Array<{Key: string, Value: string}>} Merged tag array
     */
    _mergeTags(userTags, secretType) {
        const systemTags = [
            { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
            { Key: 'mlcc:created-by', Value: 'secrets' },
            { Key: 'mlcc:secret-type', Value: secretType }
        ];

        const systemTagKeys = new Set(systemTags.map(t => t.Key));

        // Filter user tags: preserve non-mlcc: tags, warn about mlcc: conflicts
        const preservedUserTags = [];
        for (const tag of (userTags || [])) {
            if (!tag || !tag.Key) continue;
            if (tag.Key.startsWith('mlcc:')) {
                if (systemTagKeys.has(tag.Key)) {
                    console.log(`⚠️  Tag "${tag.Key}" is reserved and will be overwritten with system value`);
                } else {
                    console.log(`⚠️  Tag "${tag.Key}" uses reserved mlcc: prefix and will be removed`);
                }
            } else {
                preservedUserTags.push(tag);
            }
        }

        return [...systemTags, ...preservedUserTags];
    }

    /**
     * Get the active bootstrap profile's AWS profile and region.
     * @returns {{ profile: string|null, region: string|null }}
     */
    _getActiveBootstrapContext() {
        const active = this._bootstrapConfig.getActiveProfile();
        if (!active) {
            return { profile: null, region: null };
        }
        return {
            profile: active.config.awsProfile,
            region: active.config.awsRegion
        };
    }

    /**
     * Execute an AWS CLI command and return parsed JSON output.
     * @param {string} command - AWS CLI command (without 'aws' prefix)
     * @param {string} profile - AWS CLI profile name
     * @returns {object} Parsed JSON output
     */
    _execAws(command, profile) {
        if (this._execAwsFn) {
            return this._execAwsFn(command, profile);
        }
        const fullCommand = `aws ${command} --profile ${profile} --output json`;
        const output = execSync(fullCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const trimmed = output.trim();
        if (!trimmed) {
            return {};
        }
        return JSON.parse(trimmed);
    }

    /**
     * Write a JSON value to a temp file and return the file:// path.
     * Used to avoid shell escaping issues with complex values.
     * @param {*} value - Value to serialize (string or object)
     * @param {string} prefix - Filename prefix
     * @returns {string} file:// path to the temp file
     */
    _writeJsonTempFile(value, prefix = 'mlcc-secret') {
        const dir = path.join(tmpdir(), 'mlcc-secrets');
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, `${prefix}-${Date.now()}.json`);
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        writeFileSync(filePath, content);
        return `file://${filePath}`;
    }

    /**
     * Format tags for the AWS CLI --tags parameter.
     * Writes tags to a temp file and returns the file:// reference.
     * @param {Array<{Key: string, Value: string}>} tags - Tag array
     * @returns {string} file:// path to the tags JSON file
     */
    _formatTagsForCli(tags) {
        return this._writeJsonTempFile(tags, 'tags');
    }

    /**
     * List all mlcc-managed secrets.
     * Calls list-secrets filtered by the mlcc:managed-by tag and displays
     * name, ARN, secret type, creation date, and last accessed date.
     * Never displays secret values.
     *
     * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
     */
    async _handleList() {
        const { profile, region } = this._getActiveBootstrapContext();
        if (!profile) {
            console.log('❌ No active bootstrap profile found.');
            console.log('   Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            process.exitCode = 1;
            return;
        }

        const command = `secretsmanager list-secrets --filters Key=tag-key,Values=mlcc:managed-by Key=tag-value,Values=ml-container-creator --region ${region}`;

        let result;
        try {
            result = this._execAws(command, profile);
        } catch (error) {
            console.log(`❌ Failed to list secrets: ${error.message}`);
            process.exitCode = 1;
            return;
        }

        const secrets = result.SecretList || [];

        if (secrets.length === 0) {
            console.log('\nNo mlcc-managed secrets found.');
            console.log('   Run `ml-container-creator secrets create` to create your first secret.\n');
            return;
        }

        console.log(`\n🔐 Managed Secrets (${secrets.length})\n`);
        console.log('─'.repeat(80));

        for (const secret of secrets) {
            const secretType = this._extractTagValue(secret.Tags, 'mlcc:secret-type') || 'unknown';
            const createdDate = secret.CreatedDate ? new Date(secret.CreatedDate).toLocaleDateString() : 'N/A';
            const lastAccessed = secret.LastAccessedDate ? new Date(secret.LastAccessedDate).toLocaleDateString() : 'Never';

            console.log(`  Name:          ${secret.Name}`);
            console.log(`  ARN:           ${secret.ARN}`);
            console.log(`  Type:          ${secretType}`);
            console.log(`  Created:       ${createdDate}`);
            console.log(`  Last Accessed: ${lastAccessed}`);
            console.log('─'.repeat(80));
        }

        console.log('');
    }

    /**
     * Extract a tag value from a Tags array by key.
     * @param {Array<{Key: string, Value: string}>} tags - Tags array
     * @param {string} key - Tag key to find
     * @returns {string|undefined} Tag value or undefined if not found
     */
    _extractTagValue(tags, key) {
        if (!Array.isArray(tags)) return undefined;
        const tag = tags.find(t => t.Key === key);
        return tag ? tag.Value : undefined;
    }

    /**
     * Describe a specific secret's metadata (never reveals the value).
     * Calls `aws secretsmanager describe-secret` and displays name, ARN,
     * description, tags, creation date, last changed date, last accessed date,
     * and rotation configuration.
     *
     * Never calls GetSecretValue. Displays error if secret not found or
     * not a managed secret.
     *
     * Requirements: 4.1, 4.2, 4.3, 4.4
     *
     * @param {string} nameOrArn - Secret name or ARN to describe
     */
    async _handleDescribe(nameOrArn) {
        if (!nameOrArn) {
            console.log('❌ Missing secret name or ARN.');
            console.log('   Usage: ml-container-creator secrets describe <name-or-arn>');
            process.exitCode = 1;
            return;
        }

        const { profile, region } = this._getActiveBootstrapContext();
        if (!profile) {
            console.log('❌ No active bootstrap profile found.');
            console.log('   Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            process.exitCode = 1;
            return;
        }

        const command = `secretsmanager describe-secret --secret-id ${nameOrArn} --region ${region}`;

        let result;
        try {
            result = this._execAws(command, profile);
        } catch (error) {
            console.log(`❌ Secret not found: ${nameOrArn}`);
            console.log(`   ${error.message}`);
            process.exitCode = 1;
            return;
        }

        // Verify this is a managed secret by checking the mlcc:managed-by tag
        const managedByValue = this._extractTagValue(result.Tags, 'mlcc:managed-by');
        if (managedByValue !== 'ml-container-creator') {
            console.log(`❌ Secret "${nameOrArn}" is not managed by ml-container-creator.`);
            console.log('   Only secrets created with `ml-container-creator secrets create` can be described.');
            process.exitCode = 1;
            return;
        }

        // Display secret metadata
        const createdDate = result.CreatedDate ? new Date(result.CreatedDate).toLocaleString() : 'N/A';
        const lastChanged = result.LastChangedDate ? new Date(result.LastChangedDate).toLocaleString() : 'N/A';
        const lastAccessed = result.LastAccessedDate ? new Date(result.LastAccessedDate).toLocaleDateString() : 'Never';
        const secretType = this._extractTagValue(result.Tags, 'mlcc:secret-type') || 'unknown';

        console.log('\n🔐 Secret Details\n');
        console.log('─'.repeat(80));
        console.log(`  Name:           ${result.Name}`);
        console.log(`  ARN:            ${result.ARN}`);
        console.log(`  Type:           ${secretType}`);
        console.log(`  Description:    ${result.Description || '(none)'}`);
        console.log(`  Created:        ${createdDate}`);
        console.log(`  Last Changed:   ${lastChanged}`);
        console.log(`  Last Accessed:  ${lastAccessed}`);

        // Rotation configuration
        if (result.RotationEnabled) {
            console.log('  Rotation:       Enabled');
            if (result.RotationRules) {
                if (result.RotationRules.AutomaticallyAfterDays) {
                    console.log(`  Rotation Rule:  Every ${result.RotationRules.AutomaticallyAfterDays} days`);
                }
                if (result.RotationRules.Duration) {
                    console.log(`  Rotation Window: ${result.RotationRules.Duration}`);
                }
                if (result.RotationRules.ScheduleExpression) {
                    console.log(`  Rotation Schedule: ${result.RotationRules.ScheduleExpression}`);
                }
            }
        } else {
            console.log('  Rotation:       Disabled');
        }

        // Tags
        if (Array.isArray(result.Tags) && result.Tags.length > 0) {
            console.log('  Tags:');
            for (const tag of result.Tags) {
                console.log(`    ${tag.Key} = ${tag.Value}`);
            }
        }

        console.log('─'.repeat(80));
        console.log('');
    }

    /**
     * Show secrets usage help.
     */
    _showHelp() {
        console.log(`
Secrets — Manage secrets in AWS Secrets Manager

USAGE:
  ml-container-creator secrets <action> [options]

ACTIONS:
  create                              Create a new secret
  list                                List all mlcc-managed secrets
  describe <name-or-arn>              Show metadata for a specific secret

CREATE OPTIONS:
  --type <type>                       Secret type (e.g., hf-token, ngc-token)
  --name <label>                      Secret label (used in naming convention)
  --secret-value <value>              Secret value
  --description <text>                Secret description
  --kms-key-id <key>                  KMS key for encryption
  --json <json-or-path>               JSON input (inline or file://path)

EXAMPLES:
  ml-container-creator secrets create --type hf-token --name production --secret-value hf_***
  ml-container-creator secrets create --json file://secret.json
  ml-container-creator secrets list
  ml-container-creator secrets describe mlcc/hf-token/production
`.trim());
    }
}
