// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import AssetManager from './asset-manager.js';

const STACK_NAME_PREFIX = 'mlcc-bootstrap';

/**
 * Handles bootstrap profile management subcommands (status, use, list, remove, scan, prune, sync-schemas).
 * Delegates back to the BootstrapCommandHandler instance for shared helpers.
 */
export default class BootstrapProfileManager {
    constructor(handler) {
        this.handler = handler;
    }

    /**
     * Display active bootstrap profile and resource state.
     * @param {object} [options] - Parsed CLI options (e.g., --verify)
     */
    async _handleStatus(options = {}) {
        const config = this.handler.config.read();
        if (!config) {
            console.log('No bootstrap configuration found.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            return;
        }

        const profile = this.handler.config.getActiveProfile();
        if (!profile) {
            console.log('No active bootstrap profile found.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            return;
        }

        const allProfiles = this.handler.config.listProfiles();
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
            const stackInfo = this.handler._execAws(
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
                if (outputs.AdapterS3BucketName) {
                    console.log(`  ✅ S3 bucket (adapters): ${outputs.AdapterS3BucketName}`);
                }
                if (outputs.BenchmarkS3BucketName) {
                    console.log(`  ✅ S3 bucket (benchmark): ${outputs.BenchmarkS3BucketName}`);
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

                const roleExists = this.handler._resourceExists(
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
                const ecrExists = this.handler._resourceExists(
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
                    const asyncExists = this.handler._resourceExists(
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
                    const batchExists = this.handler._resourceExists(
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

            if (profile.config.benchmarkS3Bucket) {
                try {
                    const benchmarkExists = this.handler._resourceExists(
                        `s3api head-bucket --bucket ${profile.config.benchmarkS3Bucket}`,
                        profile.config.awsProfile
                    );
                    console.log(benchmarkExists
                        ? `  ✅ S3 bucket (benchmark): ${profile.config.benchmarkS3Bucket}`
                        : `  ⚠️  S3 bucket (benchmark): ${profile.config.benchmarkS3Bucket} — missing`);
                } catch {
                    console.log(`  ⚠️  S3 bucket (benchmark): ${profile.config.benchmarkS3Bucket} — could not validate`);
                }
            }
        }

        // Check AI Registry hub status
        if (profile.config.aiRegistryHubName) {
            try {
                const hubExists = this.handler._resourceExists(
                    `sagemaker describe-hub --hub-name ${profile.config.aiRegistryHubName} --region ${profile.config.awsRegion}`,
                    profile.config.awsProfile
                );
                console.log(hubExists
                    ? `  ✅ AI Registry hub: ${profile.config.aiRegistryHubName}`
                    : `  ⚠️  AI Registry hub: ${profile.config.aiRegistryHubName} — missing`);
            } catch {
                console.log(`  ⚠️  AI Registry hub: ${profile.config.aiRegistryHubName} — could not validate`);
            }
        } else {
            console.log('  ℹ️  AI Registry hub: not provisioned (run bootstrap to create)');
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
            const checkCommand = this.handler._buildDriftCheckCommand(resource);

            if (!checkCommand) {
                unchecked++;
                continue;
            }

            try {
                const exists = this.handler._resourceExists(checkCommand, profile.config.awsProfile);

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
            this.handler.config.setActiveProfile(null);
            console.log('Active profile cleared. No bootstrap profile is active.');
            return;
        }

        const profile = this.handler.config.getProfile(profileName);
        if (!profile) {
            const available = this.handler.config.listProfiles();
            console.log(`Profile "${profileName}" not found.`);
            if (available.length > 0) {
                console.log(`Available profiles: ${available.join(', ')}`);
            } else {
                console.log('No profiles configured. Run `ml-container-creator bootstrap` to create one.');
            }
            return;
        }

        this.handler.config.setActiveProfile(profileName);
        console.log(`Switched active profile to "${profileName}".`);
    }

    /**
     * List all bootstrap profiles.
     */
    async _handleList() {
        const profiles = this.handler.config.listProfiles();

        if (profiles.length === 0) {
            console.log('No bootstrap profiles configured.');
            console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
            return;
        }

        const config = this.handler.config.read();
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
     * Remove a bootstrap profile (metadata-only).
     *
     * Only removes the profile entry from config.json and the local manifest file.
     * AWS resources (CloudFormation stack, S3 buckets, ECR repo, IAM roles) are
     * intentionally retained — they may be shared across profiles or still in use.
     *
     * @param {string} profileName - Profile name to remove
     * @param {object} options - Parsed CLI options (e.g., --force)
     */
    async _handleRemove(profileName, options) {
        if (!profileName) {
            console.log('Usage: ml-container-creator bootstrap remove <profile> [--force]');
            return;
        }

        const profile = this.handler.config.getProfile(profileName);
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

        if (!options.force) {
            const { confirm } = await this.handler._promptFn([{
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

        // Delete manifest file if it exists
        if (hasManifest) {
            try {
                unlinkSync(assetManager.manifestPath);
                console.log(`Manifest file for "${profileName}" deleted.`);
            } catch {
                console.log(`⚠️  Could not delete manifest file for "${profileName}".`);
            }
        }

        this.handler.config.removeProfile(profileName);
        console.log(`Profile "${profileName}" removed.`);

        // Advisory: AWS resources are retained for safety
        const stackName = profile.stackName || `${STACK_NAME_PREFIX}-${profileName}`;
        console.log('');
        console.log('ℹ️  Profile removed from config. AWS resources (CloudFormation stack, S3 buckets, ECR repo, IAM roles) have been retained.');
        console.log(`   To delete AWS resources, manually delete the CloudFormation stack "${stackName}" in the AWS console.`);
    }

    /**
     * Scan AWS for pre-existing MLCC-managed resources and add them to the manifest.
     */
    async _handleScan() {
        const profile = this.handler.config.getActiveProfile();
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
            const tagResult = this.handler._execAws(
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

                const resourceType = this.handler._inferResourceTypeFromArn(arn);
                if (!resourceType) {
                    skipped++;
                    continue;
                }

                const project = this.handler._inferProjectFromTags(tagged.Tags) || 'unknown';

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
            const ecrResult = this.handler._execAws(
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
                            project: this.handler._inferProjectFromImageTag(tag),
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
            const cbResult = this.handler._execAws(
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
                        project: this.handler._inferProjectFromCodeBuildName(projectName),
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
        const profile = this.handler.config.getActiveProfile();
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
     * Handle sync-schemas subcommand: download service models and verify AWS CLI.
     */
    async _handleSyncSchemas() {
        console.log('\n📦 Schema Sync — Downloading AWS service models...\n');

        // Verify AWS CLI is installed
        try {
            const version = execSync('aws --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            console.log(`  AWS CLI: ${version}`);
        } catch {
            console.log('  ⚠️  AWS CLI not found.');
            console.log('  Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
            console.log('  Continuing without AWS CLI verification...\n');
        }

        // Dynamic import to avoid circular dependencies
        const { syncSchemas } = await import('./schema-sync.js');
        const result = await syncSchemas();

        if (result.success) {
            console.log('\n  ✅ Schema sync complete.');
        } else {
            console.log('\n  ⚠️  Schema sync completed with errors (some services may be unavailable).');
        }

        console.log(`  Manifest written: lastSynced = ${result.manifest.lastSynced}\n`);
    }

    /**
     * Handle sync-model-families subcommand: discover tune-eligible models from
     * the SageMaker JumpStart Hub and update the tune catalog.
     *
     * Requires AWS credentials with sagemaker:ListHubContents and
     * sagemaker:DescribeHubContent permissions.
     */
    async _handleSyncModelFamilies() {
        console.log('\n📦 Sync Model Families — Discovering supported models...\n');

        // Determine region from active profile or environment
        const profile = this.handler.config.getActiveProfile();
        const region = profile?.config?.awsRegion || process.env.AWS_REGION || 'us-west-2';

        try {
            const { syncModelFamilies } = await import('../../scripts/sync-model-families.js');
            const result = await syncModelFamilies({ region });
            console.log(`\n✅ Sync complete: ${result.added} new, ${result.total} total models`);
        } catch (err) {
            if (err.name === 'CredentialsProviderError' || err.message?.includes('credentials') || err.message?.includes('Could not load credentials')) {
                console.log('❌ AWS credentials not available or insufficient permissions.');
                console.log('');
                console.log('   Required permissions:');
                console.log('     • sagemaker:ListHubContents');
                console.log('     • sagemaker:DescribeHubContent');
                console.log('');
                console.log('   Ensure your AWS credentials are configured:');
                console.log('     aws configure');
                console.log('     # or set AWS_PROFILE to a profile with SageMaker AI access');
            } else {
                console.log(`❌ Sync failed: ${err.message}`);
            }
            process.exit(1);
        }
    }
}
