// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Command Handler
 *
 * Handles the `bootstrap` CLI subcommand tree for provisioning shared
 * AWS infrastructure (IAM role, ECR repository, S3 buckets) and
 * persisting configuration to ~/.ml-container-creator/config.json.
 *
 * Subcommands:
 *   (no args)                          Interactive setup flow
 *   status                             Show active profile and resource state
 *   use <profile>                      Switch active bootstrap profile
 *   list                               List all bootstrap profiles
 *   remove <profile> [--force]         Remove a bootstrap profile
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import BootstrapConfig from './bootstrap-config.js';
import AwsProfileParser from './aws-profile-parser.js';
import AssetManager from './asset-manager.js';
import { runPrompts } from '../prompt-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STACK_NAME_PREFIX = 'mlcc-bootstrap';
const STACK_TEMPLATE_PATH = path.resolve(__dirname, '../../config/bootstrap-stack.json');

export default class BootstrapCommandHandler {
    constructor({ promptFn } = {}) {
        this.config = new BootstrapConfig();
        this.profileParser = new AwsProfileParser();
        this._promptFn = promptFn || runPrompts;
    }

    /**
     * Dispatch bootstrap subcommands.
     * @param {string[]} args - Remaining positional args after 'bootstrap'
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options) {
        if (args.length === 0) {
            await this._handleInteractiveSetup(options);
            return;
        }

        const subcommand = args[0].toLowerCase();

        switch (subcommand) {
        case 'status':
            await this._handleStatus(options);
            break;
        case 'use':
            await this._handleUse(args[1]);
            break;
        case 'list':
            await this._handleList();
            break;
        case 'remove':
            await this._handleRemove(args[1], options);
            break;
        case 'scan':
            await this._handleScan();
            break;
        case 'prune':
            await this._handlePrune();
            break;
        case 'update':
            await this._handleUpdate(options);
            break;
        default:
            console.log(`Unknown bootstrap subcommand: ${subcommand}`);
            this._showHelp();
            break;
        }
    }

    /**
     * Interactive setup flow — provisions AWS resources and saves profile.
     * @param {object} options - Parsed CLI options
     */
    async _handleInteractiveSetup(options) {
        const nonInteractive = options['non-interactive'];

        // Non-interactive mode: validate required flags upfront
        if (nonInteractive) {
            const missingFlags = [];
            if (!options.profile) {
                missingFlags.push('--profile');
            }
            if (!options.region) {
                missingFlags.push('--region');
            }
            if (missingFlags.length > 0) {
                console.log(`❌ Missing required flags for non-interactive mode: ${missingFlags.join(', ')}`);
                return;
            }
        }

        console.log('\n🚀 Bootstrap — Shared AWS Infrastructure Setup\n');

        // Determine bootstrap profile name
        let profileName;
        if (nonInteractive) {
            profileName = options.name || 'default';
        } else {
            const answer = await this._promptFn([{
                type: 'input',
                name: 'profileName',
                message: 'Bootstrap profile name:',
                default: 'default'
            }]);
            profileName = answer.profileName;
        }

        const profileData = {};

        // Step 1: AWS profile selection
        this._displayProgress('🔍', 'Selecting AWS profile...');
        let awsProfile;
        if (nonInteractive) {
            awsProfile = options.profile;
        } else {
            awsProfile = await this._selectProfile(options);
        }
        profileData.awsProfile = awsProfile;
        this._currentProfile = awsProfile;

        // Step 2: Credential validation
        this._displayProgress('🔑', 'Validating AWS credentials...');
        const { accountId, region } = await this._validateCredentials(awsProfile, nonInteractive ? options.region : undefined);
        profileData.accountId = accountId;
        profileData.awsRegion = region;
        this._currentRegion = region;
        this._currentAccountId = accountId;

        // Step 3: Determine stack parameters
        let useExistingRoleArn = '';
        if (nonInteractive && options['role-arn']) {
            useExistingRoleArn = options['role-arn'];
            console.log(`  Using provided IAM role ARN: ${options['role-arn']}`);
        }

        let createS3Buckets = false;
        if (nonInteractive && options['skip-s3']) {
            console.log('  ⏭️  Skipping S3 bucket creation (--skip-s3)');
        } else if (nonInteractive) {
            createS3Buckets = true;
        } else {
            const { useS3 } = await this._promptFn([{
                type: 'confirm',
                name: 'useS3',
                message: 'Will you use async inference or batch transform?',
                default: false
            }]);
            createS3Buckets = useS3;
        }

        // Step 4: Deploy CloudFormation stack
        this._displayProgress('☁️', 'Deploying bootstrap infrastructure stack...');
        const stackName = `${STACK_NAME_PREFIX}-${profileName}`;

        try {
            const stackOutputs = this._deployStack(stackName, {
                CreateS3Buckets: createS3Buckets ? 'true' : 'false',
                UseExistingRoleArn: useExistingRoleArn
            }, awsProfile, region);

            // Read outputs into profile data
            profileData.roleArn = stackOutputs.RoleArn;
            profileData.ecrRepositoryName = stackOutputs.EcrRepositoryName;
            profileData.stackName = stackName;

            if (stackOutputs.AsyncS3BucketName) {
                profileData.asyncS3Bucket = stackOutputs.AsyncS3BucketName;
            }
            if (stackOutputs.BatchS3BucketName) {
                profileData.batchS3Bucket = stackOutputs.BatchS3BucketName;
            }

            console.log('  ✅ Bootstrap stack deployed successfully');
        } catch (error) {
            console.log(`  ❌ Stack deployment failed: ${error.message}`);
            console.log('  Check the CloudFormation console for details:');
            console.log(`  https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks`);
            return;
        }

        // Step 5: CI Infrastructure setup (separate CDK stack — unchanged)
        this._displayProgress('🧪', 'CI Testing Infrastructure...');
        try {
            let provisionCi = false;

            if (nonInteractive) {
                if (options.ci) {
                    provisionCi = true;
                } else if (options['skip-ci']) {
                    console.log('  ⏭️  Skipping CI infrastructure (--skip-ci)');
                    provisionCi = false;
                } else {
                    provisionCi = false;
                }
            } else {
                const ciAnswer = await this._promptFn([{
                    type: 'confirm',
                    name: 'useCi',
                    message: 'Do you want CI testing infrastructure?',
                    default: false
                }]);
                provisionCi = ciAnswer.useCi;
            }

            if (provisionCi) {
                // Ensure CDK is bootstrapped in this account/region
                const cdkBootstrapped = this._resourceExists(
                    `ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --region ${profileData.awsRegion}`,
                    profileData.awsProfile
                );

                if (!cdkBootstrapped) {
                    console.log('  📦 CDK has not been bootstrapped in this account/region — bootstrapping now...');
                    try {
                        execSync(
                            `npx cdk bootstrap aws://${profileData.accountId}/${profileData.awsRegion}`,
                            {
                                encoding: 'utf8',
                                stdio: 'inherit',
                                env: {
                                    ...process.env,
                                    AWS_PROFILE: profileData.awsProfile
                                }
                            }
                        );
                        console.log('  ✅ CDK bootstrap complete');
                    } catch (cdkErr) {
                        console.log(`  ❌ CDK bootstrap failed: ${cdkErr.message}`);
                        console.log(`  Run manually: npx cdk bootstrap aws://${profileData.accountId}/${profileData.awsRegion} --profile ${profileData.awsProfile}`);
                        throw cdkErr;
                    }
                }

                // Check if CI stack already exists — deploy or update
                const ciStackExists = this._resourceExists(
                    `cloudformation describe-stacks --stack-name MlccCiHarnessStack --region ${profileData.awsRegion}`,
                    profileData.awsProfile
                );

                if (ciStackExists) {
                    console.log('  ✅ CI stack already deployed — updating if needed...');
                } else {
                    console.log('  🚀 Deploying CI harness stack...');
                }

                const ciHarnessDir = path.resolve(__dirname, '../../infra/ci-harness');

                // CI harness source is not bundled in the npm package — only available from git clone
                if (!existsSync(ciHarnessDir)) {
                    console.log('  ⚠️  CI harness source not available (npm install does not include infra/)');
                    console.log('     To deploy the CI stack, clone the repo: git clone https://github.com/awslabs/ml-container-creator');
                    console.log('     Then run: cd ml-container-creator/infra/ci-harness && npx cdk deploy MlccCiHarnessStack');
                } else {
                    // Ensure dependencies are installed (handles cold starts / fresh clones)
                    execSync('npm install --silent', {
                        cwd: ciHarnessDir,
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'pipe']
                    });

                    execSync(
                        'npx cdk deploy MlccCiHarnessStack --require-approval never',
                        {
                            cwd: ciHarnessDir,
                            encoding: 'utf8',
                            stdio: 'inherit',
                            env: {
                                ...process.env,
                                CDK_DEFAULT_REGION: profileData.awsRegion,
                                CDK_DEFAULT_ACCOUNT: profileData.accountId,
                                AWS_PROFILE: profileData.awsProfile
                            }
                        }
                    );
                    console.log('  ✅ CI harness stack deployed');

                    profileData.ciInfraProvisioned = true;
                    profileData.ciTableName = 'mlcc-ci-table';
                }
            }
        } catch (error) {
            console.log(`⚠️  CI infrastructure setup failed: ${error.message}`);
        }

        // Save profile to config
        this.config.setProfile(profileName, profileData);
        this._displayProgress('✅', `Profile "${profileName}" saved to config`);

        // Display summary
        this._displaySummary(profileName, profileData);
    }

    /**
     * Display active bootstrap profile and resource state.
     * @param {object} [options] - Parsed CLI options (e.g., --verify)
     */
    async _handleStatus(options = {}) {
        const config = this.config.read();
        if (!config) {
            console.log('No bootstrap configuration found.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            return;
        }

        const profile = this.config.getActiveProfile();
        if (!profile) {
            console.log('No active bootstrap profile found.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            return;
        }

        const allProfiles = this.config.listProfiles();
        console.log(`\n📋 Active Profile: ${profile.name} (${allProfiles.length} profile${allProfiles.length === 1 ? '' : 's'} total)`);
        console.log('─'.repeat(40));

        for (const [key, value] of Object.entries(profile.config)) {
            console.log(`  ${key}: ${value}`);
        }

        console.log('─'.repeat(40));

        // Validate bootstrap stack
        console.log('\n🔍 Resource Validation:');

        const stackName = profile.config.stackName || `${STACK_NAME_PREFIX}-${profile.name}`;

        try {
            const stackInfo = this._execAws(
                `cloudformation describe-stacks --stack-name ${stackName} --region ${profile.config.awsRegion}`,
                profile.config.awsProfile
            );

            const stack = stackInfo.Stacks && stackInfo.Stacks[0];
            if (stack) {
                const status = stack.StackStatus;
                const statusIcon = status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE' ? '✅' : '⚠️';
                console.log(`  ${statusIcon} Bootstrap stack: ${stackName} (${status})`);

                // Show stack outputs
                const outputs = {};
                for (const output of (stack.Outputs || [])) {
                    outputs[output.OutputKey] = output.OutputValue;
                }

                if (outputs.RoleArn) {
                    console.log(`  ✅ IAM role: ${outputs.RoleArn.split('/').pop()}`);
                }
                if (outputs.EcrRepositoryName) {
                    console.log(`  ✅ ECR repository: ${outputs.EcrRepositoryName}`);
                }
                if (outputs.AsyncS3BucketName) {
                    console.log(`  ✅ S3 bucket (async): ${outputs.AsyncS3BucketName}`);
                }
                if (outputs.BatchS3BucketName) {
                    console.log(`  ✅ S3 bucket (batch): ${outputs.BatchS3BucketName}`);
                }
                if (outputs.StackVersion) {
                    console.log(`  📋 Stack version: ${outputs.StackVersion}`);
                }
            }
        } catch {
            // Fall back to individual resource checks for profiles created before CloudFormation migration
            console.log(`  ⚠️  Bootstrap stack "${stackName}" not found — checking resources individually`);

            try {
                const defaultRoleName = 'mlcc-sagemaker-execution-role';
                let roleName = defaultRoleName;
                if (profile.config.roleArn) {
                    const arnParts = profile.config.roleArn.split('/');
                    roleName = arnParts[arnParts.length - 1];
                }

                const roleExists = this._resourceExists(
                    `iam get-role --role-name ${roleName}`,
                    profile.config.awsProfile
                );
                if (roleExists) {
                    console.log(`  ✅ IAM role: ${roleName}`);
                } else {
                    console.log(`  ⚠️  IAM role: ${roleName} — missing`);
                }
            } catch {
                console.log('  ⚠️  IAM role: could not validate');
            }

            try {
                const ecrExists = this._resourceExists(
                    `ecr describe-repositories --repository-names ml-container-creator --region ${profile.config.awsRegion}`,
                    profile.config.awsProfile
                );
                if (ecrExists) {
                    console.log('  ✅ ECR repository: ml-container-creator');
                } else {
                    console.log('  ⚠️  ECR repository: ml-container-creator — missing');
                }
            } catch {
                console.log('  ⚠️  ECR repository: could not validate');
            }

            if (profile.config.asyncS3Bucket) {
                try {
                    const asyncExists = this._resourceExists(
                        `s3api head-bucket --bucket ${profile.config.asyncS3Bucket}`,
                        profile.config.awsProfile
                    );
                    console.log(asyncExists
                        ? `  ✅ S3 bucket: ${profile.config.asyncS3Bucket}`
                        : `  ⚠️  S3 bucket: ${profile.config.asyncS3Bucket} — missing`);
                } catch {
                    console.log(`  ⚠️  S3 bucket: ${profile.config.asyncS3Bucket} — could not validate`);
                }
            }

            if (profile.config.batchS3Bucket) {
                try {
                    const batchExists = this._resourceExists(
                        `s3api head-bucket --bucket ${profile.config.batchS3Bucket}`,
                        profile.config.awsProfile
                    );
                    console.log(batchExists
                        ? `  ✅ S3 bucket: ${profile.config.batchS3Bucket}`
                        : `  ⚠️  S3 bucket: ${profile.config.batchS3Bucket} — missing`);
                } catch {
                    console.log(`  ⚠️  S3 bucket: ${profile.config.batchS3Bucket} — could not validate`);
                }
            }
        }

        // Display deployed resources from manifest
        console.log('\n📦 Deployed Resources:');

        const assetManager = new AssetManager(profile.name);

        if (!existsSync(assetManager.manifestPath)) {
            console.log('  No deployment tracking data available.');
            console.log('  Resources will be tracked after running deploy, push, or submit scripts.');
            return;
        }

        const resourcesByProject = assetManager.getResourcesByProject();

        if (resourcesByProject.size === 0) {
            console.log('  No deployed resources tracked.');
            return;
        }

        for (const [project, resources] of resourcesByProject) {
            console.log(`\n  Project: ${project}`);
            for (const resource of resources) {
                const timestamp = resource.createdAt || resource.lastUpdatedAt;
                console.log(`    ${resource.resourceType}  ${resource.resourceId}  [${resource.status}]  ${timestamp}`);
            }
        }

        const counts = assetManager.getStatusCounts();
        console.log(`\n  Summary: ${counts.active} active, ${counts.deleted} deleted, ${counts.unknown} unknown`);

        // Drift detection if --verify flag is set
        if (options.verify) {
            await this._handleStatusVerify(profile, assetManager);
        }
    }

    /**
     * Perform drift detection for active resources.
     * @param {object} profile - Active profile object with name and config
     * @param {AssetManager} assetManager - AssetManager instance for the profile
     */
    async _handleStatusVerify(profile, assetManager) {
        console.log('\n🔎 Drift Detection:');

        const activeResources = assetManager.listResources({ status: 'active' });

        if (activeResources.length === 0) {
            console.log('  No active resources to verify.');
            return;
        }

        let verified = 0;
        let drifted = 0;
        let unchecked = 0;

        for (const resource of activeResources) {
            const checkCommand = this._buildDriftCheckCommand(resource);

            if (!checkCommand) {
                unchecked++;
                continue;
            }

            try {
                const exists = this._resourceExists(checkCommand, profile.config.awsProfile);

                if (exists) {
                    verified++;
                    console.log(`  ✅ ${resource.resourceType}: ${resource.resourceId}`);
                } else {
                    drifted++;
                    assetManager.updateStatus(resource.resourceId, 'unknown');
                    console.log(`  ⚠️  ${resource.resourceType}: ${resource.resourceId} — not found (status updated to unknown)`);
                }
            } catch {
                unchecked++;
                console.log(`  ⚠️  ${resource.resourceType}: ${resource.resourceId} — could not verify (credentials or API unavailable)`);
            }
        }

        console.log(`\n  Drift Summary: ${verified} verified, ${drifted} drifted, ${unchecked} unchecked`);
    }

    /**
     * Build the AWS CLI command to check if a resource still exists.
     * @param {object} resource - Asset record
     * @returns {string|null} AWS CLI command string, or null if resource type is not supported
     */
    _buildDriftCheckCommand(resource) {
        const resourceId = resource.resourceId;

        switch (resource.resourceType) {
        case 'sagemaker-endpoint': {
            const name = this._extractNameFromArn(resourceId);
            return `sagemaker describe-endpoint --endpoint-name ${name}`;
        }
        case 'sagemaker-model': {
            const name = this._extractNameFromArn(resourceId);
            return `sagemaker describe-model --model-name ${name}`;
        }
        case 'sagemaker-inference-component': {
            const name = this._extractNameFromArn(resourceId);
            return `sagemaker describe-inference-component --inference-component-name ${name}`;
        }
        case 'ecr-image': {
            // resourceId is a full image URI like 111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:tag
            const parts = resourceId.split('/');
            const repoAndTag = parts[parts.length - 1];
            const [repo, tag] = repoAndTag.split(':');
            return `ecr describe-images --repository-name ${repo} --image-ids imageTag=${tag || 'latest'}`;
        }
        case 'codebuild-project': {
            const name = this._extractNameFromArn(resourceId);
            return `codebuild batch-get-projects --names ${name}`;
        }
        case 'iam-role': {
            const name = this._extractNameFromArn(resourceId);
            return `iam get-role --role-name ${name}`;
        }
        default:
            return null;
        }
    }

    /**
     * Extract the resource name from an ARN.
     * ARN format: arn:aws:service:region:account:resource-type/resource-name
     * @param {string} arn - AWS ARN string
     * @returns {string} The resource name portion
     */
    _extractNameFromArn(arn) {
        // Handle ARN formats like:
        // arn:aws:sagemaker:us-east-1:111111111111:endpoint/my-endpoint
        // arn:aws:iam::111111111111:role/my-role
        // arn:aws:codebuild:us-east-1:111111111111:project/my-project
        const parts = arn.split('/');
        return parts[parts.length - 1];
    }

    /**
     * Switch the active bootstrap profile.
     * @param {string} profileName - Profile name to activate
     */
    async _handleUse(profileName) {
        if (!profileName) {
            console.log('Usage: ml-container-creator bootstrap use <profile>');
            console.log('       ml-container-creator bootstrap use none    (deactivate)');
            return;
        }

        if (profileName === 'none') {
            this.config.setActiveProfile(null);
            console.log('Active profile cleared. No bootstrap profile is active.');
            return;
        }

        const profile = this.config.getProfile(profileName);
        if (!profile) {
            const available = this.config.listProfiles();
            console.log(`Profile "${profileName}" not found.`);
            if (available.length > 0) {
                console.log(`Available profiles: ${available.join(', ')}`);
            } else {
                console.log('No profiles configured. Run `ml-container-creator bootstrap` to create one.');
            }
            return;
        }

        this.config.setActiveProfile(profileName);
        console.log(`Switched active profile to "${profileName}".`);
    }

    /**
     * List all bootstrap profiles.
     */
    async _handleList() {
        const profiles = this.config.listProfiles();

        if (profiles.length === 0) {
            console.log('No bootstrap profiles configured.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            return;
        }

        const config = this.config.read();
        const activeProfileName = config ? config.activeProfile : null;

        console.log('\nBootstrap Profiles:');
        for (const name of profiles) {
            if (name === activeProfileName) {
                console.log(`  * ${name} (active)`);
            } else {
                console.log(`    ${name}`);
            }
        }
    }

    /**
     * Remove a bootstrap profile.
     * @param {string} profileName - Profile name to remove
     * @param {object} options - Parsed CLI options (e.g., --force)
     */
    async _handleRemove(profileName, options) {
        if (!profileName) {
            console.log('Usage: ml-container-creator bootstrap remove <profile> [--force]');
            return;
        }

        const profile = this.config.getProfile(profileName);
        if (!profile) {
            console.log(`Profile "${profileName}" not found.`);
            return;
        }

        // Check for manifest file with active resources
        const assetManager = new AssetManager(profileName);
        const hasManifest = existsSync(assetManager.manifestPath);

        if (hasManifest) {
            const counts = assetManager.getStatusCounts();
            if (counts.active > 0 && !options.force) {
                console.log(`⚠️  Profile "${profileName}" has ${counts.active} active resource${counts.active === 1 ? '' : 's'} in the deployment manifest.`);
            }
        }

        // Check for CloudFormation stack
        const stackName = profile.stackName || `${STACK_NAME_PREFIX}-${profileName}`;
        let hasStack = false;
        try {
            hasStack = this._resourceExists(
                `cloudformation describe-stacks --stack-name ${stackName} --region ${profile.awsRegion}`,
                profile.awsProfile
            );
        } catch {
            // ignore
        }

        if (hasStack && !options.force) {
            console.log(`⚠️  Profile "${profileName}" has a CloudFormation stack: ${stackName}`);
            console.log('   Use --delete-stack to also delete the AWS resources, or --force to remove the profile only.');
        }

        if (!options.force) {
            const { confirm } = await this._promptFn([{
                type: 'confirm',
                name: 'confirm',
                message: `Remove bootstrap profile "${profileName}"?`,
                default: false
            }]);

            if (!confirm) {
                console.log('Removal cancelled.');
                return;
            }
        }

        // Delete CloudFormation stack if requested
        if (hasStack && options['delete-stack']) {
            try {
                console.log(`🗑️  Deleting CloudFormation stack: ${stackName}`);
                execSync(
                    `aws cloudformation delete-stack --stack-name ${stackName} --region ${profile.awsRegion} --profile ${profile.awsProfile}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                console.log('⏳ Waiting for stack deletion...');
                execSync(
                    `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --region ${profile.awsRegion} --profile ${profile.awsProfile}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                console.log(`✅ Stack "${stackName}" deleted.`);
            } catch (err) {
                console.log(`⚠️  Could not delete stack "${stackName}": ${err.message}`);
                console.log('   You may need to delete it manually from the CloudFormation console.');
            }
        } else if (hasStack) {
            console.log(`Note: CloudFormation stack "${stackName}" was left in place.`);
            console.log('   To delete AWS resources, re-run with --delete-stack');
        }

        // Delete manifest file if it exists
        if (hasManifest) {
            try {
                unlinkSync(assetManager.manifestPath);
                console.log(`Manifest file for "${profileName}" deleted.`);
            } catch {
                console.log(`⚠️  Could not delete manifest file for "${profileName}".`);
            }
        }

        this.config.removeProfile(profileName);
        console.log(`Profile "${profileName}" removed.`);
    }

    /**
     * Scan AWS for pre-existing MLCC-managed resources and add them to the manifest.
     */
    async _handleScan() {
        const profile = this.config.getActiveProfile();
        if (!profile) {
            console.log('No active bootstrap profile found.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            return;
        }

        console.log(`\n🔍 Scanning for pre-existing resources in ${profile.config.awsRegion}...`);

        const assetManager = new AssetManager(profile.name);
        const now = new Date().toISOString();
        let discovered = 0;
        let added = 0;
        let skipped = 0;

        // 1. Query Resource Groups Tagging API for mlcc:managed-by tagged resources
        try {
            console.log('\n  Checking tagged resources...');
            const tagResult = this._execAws(
                `resourcegroupstaggingapi get-resources --tag-filters Key=mlcc:managed-by,Values=ml-container-creator --region ${profile.config.awsRegion}`,
                profile.config.awsProfile
            );

            const taggedResources = tagResult.ResourceTagMappingList || [];
            for (const tagged of taggedResources) {
                discovered++;
                const arn = tagged.ResourceARN;
                const existing = assetManager.getResource(arn);
                if (existing) {
                    skipped++;
                    continue;
                }

                const resourceType = this._inferResourceTypeFromArn(arn);
                if (!resourceType) {
                    skipped++;
                    continue;
                }

                const project = this._inferProjectFromTags(tagged.Tags) || 'unknown';

                try {
                    assetManager.addResource({
                        resourceId: arn,
                        resourceType,
                        createdAt: now,
                        lastUpdatedAt: now,
                        project,
                        status: 'active',
                        metadata: { discoveredBy: 'scan' }
                    });
                    added++;
                } catch {
                    skipped++;
                }
            }
        } catch {
            console.log('  ⚠️  Could not query tagged resources (credentials or API unavailable)');
        }

        // 2. Query ECR for images in ml-container-creator repository
        try {
            console.log('  Checking ECR images...');
            const ecrResult = this._execAws(
                `ecr describe-images --repository-name ml-container-creator --region ${profile.config.awsRegion}`,
                profile.config.awsProfile
            );

            const images = ecrResult.imageDetails || [];
            for (const image of images) {
                const tags = image.imageTags || [];
                for (const tag of tags) {
                    discovered++;
                    const imageUri = `${profile.config.accountId}.dkr.ecr.${profile.config.awsRegion}.amazonaws.com/ml-container-creator:${tag}`;
                    const existing = assetManager.getResource(imageUri);
                    if (existing) {
                        skipped++;
                        continue;
                    }

                    try {
                        assetManager.addResource({
                            resourceId: imageUri,
                            resourceType: 'ecr-image',
                            createdAt: now,
                            lastUpdatedAt: now,
                            project: this._inferProjectFromImageTag(tag),
                            status: 'active',
                            metadata: {
                                repositoryName: 'ml-container-creator',
                                imageTag: tag,
                                region: profile.config.awsRegion,
                                discoveredBy: 'scan'
                            }
                        });
                        added++;
                    } catch {
                        skipped++;
                    }
                }
            }
        } catch {
            console.log('  ⚠️  Could not query ECR images (credentials or API unavailable)');
        }

        // 3. Query CodeBuild for *-build-* projects
        try {
            console.log('  Checking CodeBuild projects...');
            const cbResult = this._execAws(
                `codebuild list-projects --region ${profile.config.awsRegion}`,
                profile.config.awsProfile
            );

            const projects = (cbResult.projects || []).filter(name => name.includes('-build-'));
            for (const projectName of projects) {
                discovered++;
                const arn = `arn:aws:codebuild:${profile.config.awsRegion}:${profile.config.accountId}:project/${projectName}`;
                const existing = assetManager.getResource(arn);
                if (existing) {
                    skipped++;
                    continue;
                }

                try {
                    assetManager.addResource({
                        resourceId: arn,
                        resourceType: 'codebuild-project',
                        createdAt: now,
                        lastUpdatedAt: now,
                        project: this._inferProjectFromCodeBuildName(projectName),
                        status: 'active',
                        metadata: {
                            projectName,
                            region: profile.config.awsRegion,
                            discoveredBy: 'scan'
                        }
                    });
                    added++;
                } catch {
                    skipped++;
                }
            }
        } catch {
            console.log('  ⚠️  Could not query CodeBuild projects (credentials or API unavailable)');
        }

        // Display summary
        console.log(`\n  Scan complete: ${discovered} discovered, ${added} added, ${skipped} skipped (duplicates or unsupported)`);

        if (discovered === 0) {
            console.log('  No MLCC-managed resources were discovered.');
        }
    }

    /**
     * Prune stale records from the manifest — removes entries with status
     * 'deleted' or 'unknown' that are no longer useful.
     */
    async _handlePrune() {
        const profile = this.config.getActiveProfile();
        if (!profile) {
            console.log('No active bootstrap profile found.');
            return;
        }

        const assetManager = new AssetManager(profile.name);

        if (!existsSync(assetManager.manifestPath)) {
            console.log('No deployment tracking data to prune.');
            return;
        }

        const before = assetManager.listResources();
        const toRemove = before.filter(r => r.status === 'deleted' || r.status === 'unknown');

        if (toRemove.length === 0) {
            console.log('Nothing to prune — no deleted or unknown records found.');
            return;
        }

        console.log(`\n🧹 Pruning ${toRemove.length} stale record${toRemove.length === 1 ? '' : 's'}:\n`);

        for (const resource of toRemove) {
            assetManager.removeResource(resource.resourceId);
            console.log(`  🗑️  [${resource.status}] ${resource.resourceType}: ${resource.resourceId}`);
        }

        const after = assetManager.listResources();
        console.log(`\n  Done. ${toRemove.length} removed, ${after.length} remaining.`);
    }

    /**
     * Re-deploy bootstrap infrastructure using the active profile.
     * No prompts — reads all config from the existing profile and re-applies
     * the CloudFormation stack and optionally the CI CDK stack.
     *
     * @param {object} [options] - Parsed CLI options (e.g., --ci to force CI update)
     */
    async _handleUpdate(options = {}) {
        const profile = this.config.getActiveProfile();
        if (!profile) {
            console.log('No active bootstrap profile found.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure first.');
            return;
        }

        const { name, config: profileConfig } = profile;
        console.log(`\n🔄 Updating bootstrap infrastructure for profile "${name}"`);
        console.log(`   Region: ${profileConfig.awsRegion}`);
        console.log(`   Account: ${profileConfig.accountId}`);

        // Re-deploy the CloudFormation bootstrap stack
        const stackName = profileConfig.stackName || `${STACK_NAME_PREFIX}-${name}`;
        this._displayProgress('☁️', 'Updating bootstrap stack...');

        try {
            const stackOutputs = this._deployStack(stackName, {
                CreateS3Buckets: (profileConfig.asyncS3Bucket || profileConfig.batchS3Bucket) ? 'true' : 'false',
                UseExistingRoleArn: ''
            }, profileConfig.awsProfile, profileConfig.awsRegion);

            // Update profile with any new outputs
            if (stackOutputs.RoleArn) profileConfig.roleArn = stackOutputs.RoleArn;
            if (stackOutputs.EcrRepositoryName) profileConfig.ecrRepositoryName = stackOutputs.EcrRepositoryName;
            if (stackOutputs.AsyncS3BucketName) profileConfig.asyncS3Bucket = stackOutputs.AsyncS3BucketName;
            if (stackOutputs.BatchS3BucketName) profileConfig.batchS3Bucket = stackOutputs.BatchS3BucketName;
            profileConfig.stackName = stackName;

            console.log('  ✅ Bootstrap stack updated');
        } catch (error) {
            console.log(`  ❌ Stack update failed: ${error.message}`);
        }

        // Re-deploy CI stack if it was provisioned or --ci flag is set
        const shouldUpdateCi = profileConfig.ciInfraProvisioned || options.ci;
        if (shouldUpdateCi) {
            this._displayProgress('🧪', 'Updating CI harness stack...');

            try {
                const ciHarnessDir = path.resolve(__dirname, '../../infra/ci-harness');

                // CI harness source is not bundled in the npm package — only available from git clone
                if (!existsSync(ciHarnessDir)) {
                    console.log('  ⏭️  CI harness source not available (npm install does not include infra/)');
                    console.log('     To update the CI stack, run from a git clone: git clone https://github.com/awslabs/ml-container-creator && cd ml-container-creator && npx cdk deploy -c region=REGION');
                } else {
                    // Ensure dependencies are installed (handles cold starts / fresh clones)
                    execSync('npm install --silent', {
                        cwd: ciHarnessDir,
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'pipe']
                    });

                    execSync(
                        'npx cdk deploy MlccCiHarnessStack --require-approval never',
                        {
                            cwd: ciHarnessDir,
                            encoding: 'utf8',
                            stdio: 'inherit',
                            env: {
                                ...process.env,
                                CDK_DEFAULT_REGION: profileConfig.awsRegion,
                                CDK_DEFAULT_ACCOUNT: profileConfig.accountId,
                                AWS_PROFILE: profileConfig.awsProfile
                            }
                        }
                    );
                    profileConfig.ciInfraProvisioned = true;
                    console.log('  ✅ CI harness stack updated');
                }
            } catch (error) {
                console.log(`  ❌ CI stack update failed: ${error.message}`);
            }
        } else {
            console.log('  ⏭️  CI stack skipped (not provisioned — use --ci to force)');
        }

        // Save updated profile
        this.config.setProfile(name, profileConfig);
        console.log(`\n✅ Update complete for profile "${name}"`);
    }

    /**
     * Infer the resource type from an ARN.
     * @param {string} arn - AWS ARN
     * @returns {string|null} Resource type or null if not recognized
     */
    _inferResourceTypeFromArn(arn) {
        if (arn.includes(':endpoint/')) return 'sagemaker-endpoint';
        if (arn.includes(':endpoint-config/')) return 'sagemaker-endpoint-config';
        if (arn.includes(':model/')) return 'sagemaker-model';
        if (arn.includes(':inference-component/')) return 'sagemaker-inference-component';
        if (arn.includes(':transform-job/')) return 'sagemaker-transform-job';
        if (arn.includes(':project/')) return 'codebuild-project';
        if (arn.includes(':role/')) return 'iam-role';
        if (arn.includes(':topic')) return 'sns-topic';
        return null;
    }

    /**
     * Infer the project name from resource tags.
     * @param {Array<{Key: string, Value: string}>} tags - Resource tags
     * @returns {string|null} Project name or null
     */
    _inferProjectFromTags(tags) {
        if (!tags) return null;
        const projectTag = tags.find(t => t.Key === 'mlcc:project' || t.Key === 'project');
        return projectTag ? projectTag.Value : null;
    }

    /**
     * Infer the project name from an ECR image tag.
     * @param {string} tag - Image tag (e.g., "my-project-latest")
     * @returns {string} Project name
     */
    _inferProjectFromImageTag(tag) {
        // Tags often follow pattern: project-name-suffix
        // Best effort: use the tag itself as project identifier
        return tag.replace(/-latest$/, '').replace(/-\d+$/, '') || 'unknown';
    }

    /**
     * Infer the project name from a CodeBuild project name.
     * @param {string} name - CodeBuild project name (e.g., "my-project-build-xyz")
     * @returns {string} Project name
     */
    _inferProjectFromCodeBuildName(name) {
        // Pattern: {project}-build-{suffix}
        const match = name.match(/^(.+?)-build-/);
        return match ? match[1] : name;
    }

    // ── Provisioning steps ──────────────────────────────────────────

    /**
     * Prompt user to select an AWS profile.
     * @param {object} options - Parsed CLI options
     * @returns {Promise<string>} Selected AWS profile name
     */
    async _selectProfile(_options) {
        const profiles = this.profileParser.getProfiles();

        if (profiles.length === 0) {
            console.log('❌ No AWS profiles found. Run `aws configure` first.');
            throw new Error('No AWS profiles found. Run `aws configure` first.');
        }

        const defaultProfile = profiles.includes('default') ? 'default' : profiles[0];

        const { awsProfile } = await this._promptFn([{
            type: 'list',
            name: 'awsProfile',
            message: 'Select an AWS profile:',
            choices: profiles,
            default: defaultProfile
        }]);

        return awsProfile;
    }

    /**
     * Validate AWS credentials via STS and extract account ID.
     * @param {string} profile - AWS profile name
     * @param {string} [providedRegion] - Optional region to use (skips prompt when provided)
     * @returns {Promise<object>} Object with accountId and region
     */
    async _validateCredentials(profile, providedRegion) {
        const identity = this._execAws('sts get-caller-identity', profile);
        const accountId = identity.Account;

        let region;
        if (providedRegion) {
            region = providedRegion;
        } else {
            const answer = await this._promptFn([{
                type: 'input',
                name: 'region',
                message: 'AWS region for resources:',
                default: 'us-east-1'
            }]);
            region = answer.region;
        }

        return { accountId, region };
    }

    /**
     * Create or reuse the SageMaker execution IAM role.
     * @param {object} options - Parsed CLI options
     * @returns {Promise<string>} Role ARN
     */
    async _setupIamRole(_options) {
        const roleName = 'mlcc-sagemaker-execution-role';

        // Define trust policy for SageMaker
        const trustPolicy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Effect: 'Allow',
                    Principal: {
                        Service: 'sagemaker.amazonaws.com'
                    },
                    Action: 'sts:AssumeRole'
                }
            ]
        };

        // Define execution policy with least-privilege permissions
        const executionPolicy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'SageMakerEndpoints',
                    Effect: 'Allow',
                    Action: [
                        'sagemaker:CreateEndpoint',
                        'sagemaker:CreateEndpointConfig',
                        'sagemaker:CreateModel',
                        'sagemaker:CreateInferenceComponent',
                        'sagemaker:UpdateEndpoint',
                        'sagemaker:UpdateEndpointWeightsAndCapacities',
                        'sagemaker:UpdateInferenceComponent',
                        'sagemaker:DeleteEndpoint',
                        'sagemaker:DeleteEndpointConfig',
                        'sagemaker:DeleteModel',
                        'sagemaker:DeleteInferenceComponent',
                        'sagemaker:DescribeEndpoint',
                        'sagemaker:DescribeEndpointConfig',
                        'sagemaker:DescribeModel',
                        'sagemaker:DescribeInferenceComponent',
                        'sagemaker:InvokeEndpoint',
                        'sagemaker:InvokeEndpointAsync'
                    ],
                    Resource: '*'
                },
                {
                    Sid: 'ECRPull',
                    Effect: 'Allow',
                    Action: [
                        'ecr:GetAuthorizationToken',
                        'ecr:BatchCheckLayerAvailability',
                        'ecr:GetDownloadUrlForLayer',
                        'ecr:BatchGetImage'
                    ],
                    Resource: 'arn:aws:ecr:*:*:repository/ml-container-creator'
                },
                {
                    Sid: 'ECRAuth',
                    Effect: 'Allow',
                    Action: 'ecr:GetAuthorizationToken',
                    Resource: '*'
                },
                {
                    Sid: 'CloudWatchLogs',
                    Effect: 'Allow',
                    Action: [
                        'logs:CreateLogGroup',
                        'logs:CreateLogStream',
                        'logs:PutLogEvents'
                    ],
                    Resource: 'arn:aws:logs:*:*:*'
                },
                {
                    Sid: 'S3ModelRead',
                    Effect: 'Allow',
                    Action: [
                        's3:GetObject',
                        's3:ListBucket'
                    ],
                    Resource: [
                        'arn:aws:s3:::ml-container-creator-*',
                        'arn:aws:s3:::ml-container-creator-*/*'
                    ]
                }
            ]
        };

        // Check if role already exists
        const roleExists = this._resourceExists(
            `iam get-role --role-name ${roleName}`,
            this._currentProfile
        );

        if (roleExists) {
            const existingRole = this._execAws(
                `iam get-role --role-name ${roleName}`,
                this._currentProfile
            );
            const roleArn = existingRole.Role.Arn;
            console.log(`  ✅ IAM role "${roleName}" already exists — reused`);

            // Always update the inline policy and tags to ensure they're current
            try {
                const execPolicyFile = this._writeJsonTempFile(executionPolicy, 'exec-policy');
                this._execAws(
                    `iam put-role-policy --role-name ${roleName} --policy-name mlcc-execution-policy --policy-document ${execPolicyFile}`,
                    this._currentProfile
                );
                console.log('  ✅ IAM policy "mlcc-execution-policy" — updated');
            } catch (err) {
                console.log(`  ⚠️  Could not update inline policy: ${err.message}`);
            }

            try {
                const tags = this._buildResourceTags();
                this._execAws(
                    `iam tag-role --role-name ${roleName} --tags ${this._formatTagsForCli(tags)}`,
                    this._currentProfile
                );
                console.log('  ✅ IAM role tags — updated');
            } catch (err) {
                console.log(`  ⚠️  Could not update role tags: ${err.message}`);
            }

            return roleArn;
        }

        // Display policies to user before creation
        console.log('\n  Trust Policy:');
        console.log(JSON.stringify(trustPolicy, null, 2));
        console.log('\n  Execution Policy:');
        console.log(JSON.stringify(executionPolicy, null, 2));
        console.log('');

        try {
            // Create the IAM role — write policy to temp file to avoid shell escaping issues
            const trustPolicyFile = this._writeJsonTempFile(trustPolicy, 'trust-policy');
            const createRoleResult = this._execAws(
                `iam create-role --role-name ${roleName} --assume-role-policy-document ${trustPolicyFile}`,
                this._currentProfile
            );
            const roleArn = createRoleResult.Role.Arn;

            // Attach inline execution policy
            const execPolicyFile = this._writeJsonTempFile(executionPolicy, 'exec-policy');
            this._execAws(
                `iam put-role-policy --role-name ${roleName} --policy-name mlcc-execution-policy --policy-document ${execPolicyFile}`,
                this._currentProfile
            );

            // Apply resource tags
            const tags = this._buildResourceTags();
            this._execAws(
                `iam tag-role --role-name ${roleName} --tags ${this._formatTagsForCli(tags)}`,
                this._currentProfile
            );

            console.log(`  ✅ IAM role "${roleName}" — created`);
            return roleArn;
        } catch (error) {
            const errorMessage = error.message || '';
            if (errorMessage.includes('AccessDenied') || errorMessage.includes('UnauthorizedAccess')) {
                console.log('  ⚠️  Permission denied for iam:CreateRole. Please provide an existing role ARN.');
                const { roleArn } = await this._promptFn([{
                    type: 'input',
                    name: 'roleArn',
                    message: 'Enter an existing IAM role ARN for SageMaker execution:'
                }]);
                return roleArn;
            }
            throw error;
        }
    }

    /**
     * Create or reuse the ECR repository.
     * @returns {Promise<string>} ECR repository name
     */
    async _setupEcrRepository() {
        const repoName = 'ml-container-creator';

        // Check if repository already exists
        const repoExists = this._resourceExists(
            `ecr describe-repositories --repository-names ${repoName} --region ${this._currentRegion}`,
            this._currentProfile
        );

        if (repoExists) {
            console.log(`  ✅ ECR repository "${repoName}" already exists — reused`);
            return repoName;
        }

        // Build resource tags
        const tags = this._buildResourceTags();

        // Create the ECR repository with image scanning and AES256 encryption
        this._execAws(
            `ecr create-repository --repository-name ${repoName} --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 --region ${this._currentRegion} --tags ${this._formatTagsForCli(tags)}`,
            this._currentProfile
        );

        // Apply lifecycle policy to expire untagged images after 30 days
        const lifecyclePolicy = {
            rules: [
                {
                    rulePriority: 1,
                    description: 'Expire untagged images after 30 days',
                    selection: {
                        tagStatus: 'untagged',
                        countType: 'sinceImagePushed',
                        countUnit: 'days',
                        countNumber: 30
                    },
                    action: {
                        type: 'expire'
                    }
                }
            ]
        };

        const lifecyclePolicyFile = this._writeJsonTempFile(lifecyclePolicy, 'ecr-lifecycle');
        this._execAws(
            `ecr put-lifecycle-policy --repository-name ${repoName} --lifecycle-policy-text ${lifecyclePolicyFile} --region ${this._currentRegion}`,
            this._currentProfile
        );

        console.log(`  ✅ ECR repository "${repoName}" — created`);
        return repoName;
    }

    /**
     * Optionally create S3 buckets for async/batch deployments.
     * @returns {Promise<object|null>} Bucket names or null if skipped
     */
    async _setupS3Buckets() {
        const { useS3 } = await this._promptFn([{
            type: 'confirm',
            name: 'useS3',
            message: 'Will you use async inference or batch transform?',
            default: false
        }]);

        if (!useS3) {
            return null;
        }

        const asyncBucketName = `ml-container-creator-async-${this._currentRegion}-${this._currentAccountId}`;
        const batchBucketName = `ml-container-creator-batch-${this._currentRegion}-${this._currentAccountId}`;

        const tags = this._buildResourceTags();
        const asyncS3Bucket = await this._createS3Bucket(asyncBucketName, tags);
        const batchS3Bucket = await this._createS3Bucket(batchBucketName, tags);

        return { asyncS3Bucket, batchS3Bucket };
    }

    /**
     * Create or reuse a single S3 bucket with versioning, encryption, and tags.
     * @param {string} bucketName - S3 bucket name
     * @param {Array<{Key: string, Value: string}>} tags - Resource tags
     * @returns {Promise<string>} Bucket name
     */
    async _createS3Bucket(bucketName, tags) {
        // Check if bucket already exists
        const bucketExists = this._resourceExists(
            `s3api head-bucket --bucket ${bucketName}`,
            this._currentProfile
        );

        if (bucketExists) {
            console.log(`  ✅ S3 bucket "${bucketName}" already exists — reused`);
            return bucketName;
        }

        // Build create-bucket command with region-appropriate configuration
        let createCommand = `s3api create-bucket --bucket ${bucketName} --region ${this._currentRegion}`;
        if (this._currentRegion !== 'us-east-1') {
            createCommand += ` --create-bucket-configuration LocationConstraint=${this._currentRegion}`;
        }

        this._execAws(createCommand, this._currentProfile);

        // Enable versioning
        this._execAws(
            `s3api put-bucket-versioning --bucket ${bucketName} --versioning-configuration Status=Enabled`,
            this._currentProfile
        );

        // Enable AES256 server-side encryption
        const encryptionConfig = { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] };
        const encryptionFile = this._writeJsonTempFile(encryptionConfig, 's3-encryption');
        this._execAws(
            `s3api put-bucket-encryption --bucket ${bucketName} --server-side-encryption-configuration ${encryptionFile}`,
            this._currentProfile
        );

        // Apply resource tags
        const tagging = { TagSet: tags };
        const taggingFile = this._writeJsonTempFile(tagging, 's3-tagging');
        this._execAws(
            `s3api put-bucket-tagging --bucket ${bucketName} --tagging ${taggingFile}`,
            this._currentProfile
        );

        console.log(`  ✅ S3 bucket "${bucketName}" — created`);
        return bucketName;
    }

    // ── AWS CLI helpers ─────────────────────────────────────────────

    /**
     * Execute an AWS CLI command and return parsed JSON output.
     * @param {string} command - AWS CLI command (without 'aws' prefix)
     * @param {string} profile - AWS profile name
     * @returns {object} Parsed JSON output
     */
    _execAws(command, profile) {
        const fullCommand = `aws ${command} --profile ${profile} --output json`;
        const output = execSync(fullCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const trimmed = output.trim();
        if (!trimmed) {
            return {};
        }
        return JSON.parse(trimmed);
    }

    /**
     * Deploy the bootstrap CloudFormation stack and return its outputs.
     *
     * Uses `aws cloudformation deploy` which is idempotent — it creates the
     * stack on first run and updates it on subsequent runs. If the template
     * hasn't changed, it exits with "No changes to deploy" which we handle
     * gracefully.
     *
     * @param {string} stackName - CloudFormation stack name
     * @param {object} parameters - Stack parameter key-value pairs
     * @param {string} profile - AWS CLI profile name
     * @param {string} region - AWS region
     * @returns {object} Map of output key → output value
     */
    _deployStack(stackName, parameters, profile, region) {
        // Build parameter overrides string
        const paramOverrides = Object.entries(parameters)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');

        const deployCommand = [
            'aws cloudformation deploy',
            `--template-file ${STACK_TEMPLATE_PATH}`,
            `--stack-name ${stackName}`,
            '--capabilities CAPABILITY_NAMED_IAM',
            `--parameter-overrides ${paramOverrides}`,
            `--profile ${profile}`,
            `--region ${region}`
        ].join(' ');

        try {
            execSync(deployCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
            // "No changes to deploy" is a success case — CloudFormation deploy
            // exits with code 255 when there's nothing to update
            const stderr = error.stderr || error.message || '';
            if (stderr.includes('No changes to deploy')) {
                console.log('  ℹ️  Stack is up to date — no changes needed');
            } else {
                throw error;
            }
        }

        // Read stack outputs
        const describeResult = this._execAws(
            `cloudformation describe-stacks --stack-name ${stackName} --region ${region}`,
            profile
        );

        const stack = describeResult.Stacks && describeResult.Stacks[0];
        if (!stack) {
            throw new Error(`Stack "${stackName}" not found after deployment`);
        }

        const outputs = {};
        for (const output of (stack.Outputs || [])) {
            outputs[output.OutputKey] = output.OutputValue;
        }

        return outputs;
    }

    /**
     * Write a JSON object to a temp file and return the `file://` path.
     * Used for passing complex JSON to AWS CLI commands without shell escaping issues.
     *
     * @param {object} jsonObj - The JSON object to write
     * @param {string} prefix - Filename prefix for the temp file
     * @returns {string} The `file://` path to the temp file
     */
    _writeJsonTempFile(jsonObj, prefix = 'mlcc-policy') {
        const dir = path.join(tmpdir(), 'mlcc-bootstrap');
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, `${prefix}-${Date.now()}.json`);
        writeFileSync(filePath, JSON.stringify(jsonObj));
        return `file://${filePath}`;
    }

    /**
     * Check whether an AWS resource exists by running a check command.
     * @param {string} checkCommand - AWS CLI command to check existence
     * @param {string} profile - AWS profile name
     * @returns {boolean} True if resource exists
     */
    _resourceExists(checkCommand, profile) {
        try {
            this._execAws(checkCommand, profile);
            return true;
        } catch {
            return false;
        }
    }

    // ── Tag helpers ─────────────────────────────────────────────────

    /**
     * Build the standard resource tag set.
     * @returns {Array<{Key: string, Value: string}>} Tag array
     */
    _buildResourceTags() {
        const packageJsonPath = path.resolve(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return [
            { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
            { Key: 'mlcc:created-by', Value: 'bootstrap' },
            { Key: 'mlcc:version', Value: packageJson.version }
        ];
    }

    /**
     * Format tags for the AWS CLI --tags parameter.
     * Writes tags to a temp file and returns the file:// reference
     * to avoid shell escaping issues with special characters in tag keys/values.
     *
     * @param {Array<{Key: string, Value: string}>} tags - Tag array
     * @returns {string} file:// path to the tags JSON file
     */
    _formatTagsForCli(tags) {
        return this._writeJsonTempFile(tags, 'tags');
    }

    // ── Display helpers ─────────────────────────────────────────────

    /**
     * Show bootstrap usage help.
     */
    _showHelp() {
        console.log(`
Bootstrap — Shared AWS Infrastructure Setup

Provisions shared infrastructure via a CloudFormation stack. Re-run bootstrap
at any time to apply updates from new versions — CloudFormation handles the diff.

USAGE:
  ml-container-creator bootstrap [subcommand] [options]

SUBCOMMANDS:
  (no subcommand)                     Interactive setup (default) — creates or updates stack
  status                              Show active profile, stack state, and deployed resources
  status --verify                     Show status and verify active resources exist in AWS
  use <profile>                       Switch active bootstrap profile
  list                                List all bootstrap profiles
  remove <profile>                    Remove a bootstrap profile
  scan                                Discover pre-existing MLCC-managed resources in AWS
  prune                               Remove deleted and unknown records from the deployment manifest
  update                              Re-deploy bootstrap stacks using active profile (no prompts)

SETUP OPTIONS:
  --non-interactive                   Run without interactive prompts
  --name <name>                       Bootstrap profile name (default: "default")
  --profile <profile>                 AWS CLI profile to use
  --region <region>                   AWS region for resources
  --role-arn <arn>                    Use existing IAM role ARN (skip role creation)
  --skip-s3                           Skip S3 bucket creation
  --ci                                Provision CI testing infrastructure
  --skip-ci                           Skip CI infrastructure provisioning

STATUS OPTIONS:
  --verify                            Check each active resource against AWS APIs for drift detection

REMOVE OPTIONS:
  --force                             Skip confirmation prompt
  --delete-stack                      Also delete the CloudFormation stack and AWS resources

EXAMPLES:
  ml-container-creator bootstrap
  ml-container-creator bootstrap status
  ml-container-creator bootstrap status --verify
  ml-container-creator bootstrap use prod
  ml-container-creator bootstrap list
  ml-container-creator bootstrap remove dev
  ml-container-creator bootstrap remove dev --force --delete-stack
  ml-container-creator bootstrap scan
  ml-container-creator bootstrap --non-interactive --profile my-aws-profile --region us-west-2
  ml-container-creator bootstrap --non-interactive --profile my-aws-profile --role-arn arn:aws:iam::123456789012:role/MyRole --skip-s3
  ml-container-creator bootstrap --non-interactive --profile my-aws-profile --region us-west-2 --ci
  ml-container-creator bootstrap --non-interactive --profile my-aws-profile --region us-west-2 --skip-ci
`);
    }

    /**
     * Display a summary of the bootstrap profile configuration.
     * @param {string} profileName - Bootstrap profile name
     * @param {object} profileConfig - Profile configuration object
     */
    _displaySummary(profileName, profileConfig) {
        console.log(`\n📋 Bootstrap Profile: ${profileName}`);
        console.log('─'.repeat(40));
        for (const [key, value] of Object.entries(profileConfig)) {
            console.log(`  ${key}: ${value}`);
        }
        console.log('─'.repeat(40));
    }

    /**
     * Display a progress indicator line.
     * @param {string} emoji - Emoji prefix
     * @param {string} message - Progress message
     */
    _displayProgress(emoji, message) {
        console.log(`${emoji} ${message}`);
    }
}
