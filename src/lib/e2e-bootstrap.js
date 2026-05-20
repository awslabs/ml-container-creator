// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Bootstrap Integration
 *
 * Handles the `bootstrap --ci --e2e` flow:
 * 1. Loads the e2e catalog
 * 2. Runs quota validation for the CI tier and emits warnings
 * 3. Deploys the config/bootstrap-e2e-stack.json CloudFormation stack
 * 4. Stores e2e config (bucket, SNS ARN, CodeBuild project name) in bootstrap config
 *
 * Requirements: 3.3, 3.4
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuotas } from './e2e-quota-validator.js';
import { validateCatalog } from './e2e-catalog-validator.js';
import BootstrapConfig from './bootstrap-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const E2E_STACK_NAME = 'mlcc-bootstrap-e2e';
const E2E_STACK_TEMPLATE_PATH = path.resolve(__dirname, '../../config/bootstrap-e2e-stack.json');
const DEFAULT_CATALOG_PATH = path.resolve(__dirname, '../../scripts/e2e-catalog.json');

/**
 * Bootstrap E2E infrastructure.
 *
 * Loads the catalog, validates quotas for the CI tier, deploys the
 * CloudFormation stack, and stores e2e config in the bootstrap profile.
 *
 * @param {Object} options
 * @param {string} options.region - AWS region
 * @param {string} options.profile - AWS CLI profile name
 * @param {string} [options.catalogPath] - Path to the e2e catalog JSON file
 * @param {string} [options.profileName] - Bootstrap profile name (default: 'default')
 * @param {Object} [options.bootstrapConfig] - Pre-configured BootstrapConfig instance (for testing)
 * @returns {Promise<Object>} The e2e config object with bucket, SNS ARN, and CodeBuild project name
 */
export async function bootstrapE2E(options) {
    const {
        region,
        profile,
        catalogPath = DEFAULT_CATALOG_PATH,
        profileName = 'default',
        bootstrapConfig
    } = options;

    console.log('\n🧪 E2E Validation Infrastructure Setup\n');

    // Step 1: Load and validate the catalog
    console.log('  📋 Loading e2e catalog...');
    const catalog = loadCatalog(catalogPath);
    console.log(`  ✅ Catalog loaded (${catalog.configs.length} configs)`);

    // Step 2: Run quota validation for CI tier
    console.log('\n  🔍 Checking service quotas for CI tier...');
    const quotaResults = await runQuotaValidation('ci', catalog, region);

    if (quotaResults.length === 0) {
        console.log('  ℹ️  No instance types to validate for CI tier');
    } else {
        const insufficient = quotaResults.filter(r => !r.sufficient);
        if (insufficient.length === 0) {
            console.log('  ✅ All quotas sufficient for CI tier');
        } else {
            for (const result of insufficient) {
                console.log(`  ⚠️  ${result.instanceType} quota is ${result.available}, need ${result.required} for CI tier`);
            }
        }
    }

    // Step 3: Deploy the E2E CloudFormation stack
    console.log('\n  ☁️  Deploying E2E infrastructure stack...');
    const stackOutputs = deployE2EStack(profile, region);
    console.log('  ✅ E2E stack deployed successfully');

    // Step 4: Store e2e config in bootstrap profile
    const e2eConfig = {
        e2eInfraProvisioned: true,
        e2eCodeBuildProject: stackOutputs.CodeBuildProjectName || 'ml-container-creator-e2e',
        e2eResultsBucket: stackOutputs.ResultsBucketName || `mlcc-e2e-results-unknown-${region}`,
        e2eSnsTopicArn: stackOutputs.NotificationsTopicArn || ''
    };

    console.log('\n  💾 Saving e2e config to bootstrap profile...');
    const config = bootstrapConfig || new BootstrapConfig();
    storeE2EConfig(config, profileName, e2eConfig);
    console.log('  ✅ E2E config saved');

    // Display summary
    console.log('\n  📋 E2E Infrastructure Summary:');
    console.log(`     CodeBuild project: ${e2eConfig.e2eCodeBuildProject}`);
    console.log(`     Results bucket:    ${e2eConfig.e2eResultsBucket}`);
    console.log(`     SNS topic:         ${e2eConfig.e2eSnsTopicArn}`);

    return e2eConfig;
}

/**
 * Load and validate the e2e catalog from a JSON file.
 *
 * @param {string} catalogPath - Path to the catalog JSON file
 * @returns {Object} The validated catalog object
 * @throws {Error} If the catalog file cannot be read or is invalid
 */
export function loadCatalog(catalogPath) {
    let raw;
    try {
        raw = readFileSync(catalogPath, 'utf8');
    } catch (err) {
        throw new Error(`Failed to read e2e catalog at ${catalogPath}: ${err.message}`);
    }

    let catalog;
    try {
        catalog = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Failed to parse e2e catalog JSON: ${err.message}`);
    }

    const validation = validateCatalog(catalog);
    if (!validation.valid) {
        const errorMessages = validation.errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
        throw new Error(`E2E catalog validation failed:\n${errorMessages}`);
    }

    return catalog;
}

/**
 * Run quota validation for a given tier and emit warnings.
 *
 * @param {string} tier - The tier to validate (e.g., 'ci')
 * @param {Object} catalog - The validated catalog object
 * @param {string} region - AWS region
 * @returns {Promise<Array<{instanceType: string, required: number, available: number, sufficient: boolean}>>}
 */
export async function runQuotaValidation(tier, catalog, region) {
    try {
        return await validateQuotas(tier, catalog, region);
    } catch (err) {
        console.warn(`  ⚠️  Quota validation failed: ${err.message}`);
        console.warn('     Continuing without quota validation...');
        return [];
    }
}

/**
 * Deploy the E2E CloudFormation stack.
 *
 * Uses `aws cloudformation deploy` which handles both CREATE and UPDATE scenarios.
 *
 * @param {string} awsProfile - AWS CLI profile name
 * @param {string} region - AWS region
 * @returns {Object} Map of stack output key → output value
 * @throws {Error} If stack deployment fails
 */
export function deployE2EStack(awsProfile, region) {
    const deployCommand = [
        'aws cloudformation deploy',
        `--template-file ${E2E_STACK_TEMPLATE_PATH}`,
        `--stack-name ${E2E_STACK_NAME}`,
        '--capabilities CAPABILITY_NAMED_IAM',
        `--profile ${awsProfile}`,
        `--region ${region}`
    ].join(' ');

    try {
        execSync(deployCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
        // "No changes to deploy" is a success case — CloudFormation deploy
        // exits with code 255 when there's nothing to update
        const stderr = error.stderr || error.message || '';
        if (stderr.includes('No changes to deploy')) {
            console.log('  ℹ️  E2E stack is up to date — no changes needed');
        } else {
            throw new Error(`E2E stack deployment failed: ${stderr}`);
        }
    }

    // Read stack outputs
    const describeCommand = `aws cloudformation describe-stacks --stack-name ${E2E_STACK_NAME} --region ${region} --profile ${awsProfile} --output json`;
    let describeOutput;
    try {
        describeOutput = execSync(describeCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
        throw new Error(`Failed to read E2E stack outputs: ${err.message}`);
    }

    const describeResult = JSON.parse(describeOutput.trim());
    const stack = describeResult.Stacks && describeResult.Stacks[0];
    if (!stack) {
        throw new Error(`Stack "${E2E_STACK_NAME}" not found after deployment`);
    }

    const outputs = {};
    for (const output of (stack.Outputs || [])) {
        outputs[output.OutputKey] = output.OutputValue;
    }

    return outputs;
}

/**
 * Store e2e config fields in the bootstrap profile.
 *
 * @param {BootstrapConfig} config - BootstrapConfig instance
 * @param {string} profileName - The profile name to update
 * @param {Object} e2eConfig - The e2e config fields to store
 */
export function storeE2EConfig(config, profileName, e2eConfig) {
    const fullConfig = config.read();
    if (!fullConfig || !fullConfig.profiles || !fullConfig.profiles[profileName]) {
        throw new Error(`Bootstrap profile "${profileName}" not found. Run bootstrap first.`);
    }

    const profileData = fullConfig.profiles[profileName];
    Object.assign(profileData, e2eConfig);
    fullConfig.profiles[profileName] = profileData;
    config.write(fullConfig);
}
