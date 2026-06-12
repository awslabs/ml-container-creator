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
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import BootstrapConfig from './bootstrap-config.js';
import AwsProfileParser from './aws-profile-parser.js';
import McpCommandHandler from './mcp-command-handler.js';
import RegistryCommandHandler from './registry-command-handler.js';
import { runPrompts } from '../prompt-adapter.js';
import BootstrapProfileManager from './bootstrap-profile-manager.js';
import BootstrapProvisioners from './bootstrap-provisioners.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STACK_NAME_PREFIX = 'mlcc-bootstrap';
const STACK_TEMPLATE_PATH = path.resolve(__dirname, '../../config/bootstrap-stack.json');

export default class BootstrapCommandHandler {
    constructor({ promptFn } = {}) {
        this.config = new BootstrapConfig();
        this.profileParser = new AwsProfileParser();
        this._promptFn = promptFn || runPrompts;
        this.profileManager = new BootstrapProfileManager(this);
        this.provisioners = new BootstrapProvisioners(this);
    }

    // ── Provisioner delegations (backward compat for tests) ─────────

    _buildResourceTags() { return this.provisioners._buildResourceTags(); }
    _setupEcrRepository() { return this.provisioners._setupEcrRepository(); }
    _setupIamRole(options) { return this.provisioners._setupIamRole(options); }
    _setupS3Buckets() { return this.provisioners._setupS3Buckets(); }
    _createS3Bucket(name, tags) { return this.provisioners._createS3Bucket(name, tags); }
    _verifyCliV2() { return this.provisioners._verifyCliV2(); }

    // ── ProfileManager delegations (backward compat for tests) ──────

    _handleStatus(options) { return this.profileManager._handleStatus(options); }
    _handleUse(profileName) { return this.profileManager._handleUse(profileName); }
    _handleList() { return this.profileManager._handleList(); }
    _handleRemove(profileName, options) { return this.profileManager._handleRemove(profileName, options); }
    _handleScan() { return this.profileManager._handleScan(); }
    _handlePrune() { return this.profileManager._handlePrune(); }
    _handleSyncSchemas() { return this.profileManager._handleSyncSchemas(); }
    _handleSyncModelFamilies() { return this.profileManager._handleSyncModelFamilies(); }

    /**
     * Dispatch bootstrap subcommands.
     * @param {string[]} args - Remaining positional args after 'bootstrap'
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options) {
        // Commander.js with passThroughOptions() captures flags after positional
        // arguments in args rather than options. Extract known flags from args.
        const extractedOptions = { ...options };
        const cleanArgs = [];
        for (const arg of args) {
            if (arg === '--ci') extractedOptions.ci = true;
            else if (arg === '--benchmark-infra') extractedOptions.benchmarkInfra = true;
            else if (arg === '--skip-ci') extractedOptions.skipCi = true;
            else if (arg === '--skip-s3') extractedOptions.skipS3 = true;
            else if (arg === '--skip-post-setup') extractedOptions.skipPostSetup = true;
            else if (arg === '--force') extractedOptions.force = true;
            else if (arg === '--verify') extractedOptions.verify = true;
            else if (arg === '--delete-stack') extractedOptions.deleteStack = true;
            else if (arg === '--non-interactive') extractedOptions.nonInteractive = true;
            else if (arg === '--ignore-staleness') extractedOptions.ignoreStaleness = true;
            else cleanArgs.push(arg);
        }
        args = cleanArgs;
        options = extractedOptions;

        // Handle legacy --sync-schemas flag for backward compatibility
        if ((options['sync-schemas'] || options.syncSchemas)) {
            await this._handleSyncSchemas();
            if (args.length === 0) return;
        }

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
        case 'sync-schemas':
            await this._handleSyncSchemas();
            break;
        case 'sync-model-families':
            await this._handleSyncModelFamilies();
            break;
        // Migration path: upgrades legacy profiles to current naming conventions.
        // Corrects stackName to mlcc-bootstrap-{profileName}, renames sharedStackFrom
        // to sharedInfraFrom. Idempotent — safe to run multiple times.
        case 'migrate':
            await this._handleMigrate();
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
        // Commander.js converts --non-interactive to options.nonInteractive (camelCase)
        const nonInteractive = options['non-interactive'] || options.nonInteractive;

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

        // Verify AWS CLI v2 is installed
        if (!this.provisioners._verifyCliV2()) {
            return;
        }

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
        if (nonInteractive && (options['role-arn'] || options.roleArn)) {
            useExistingRoleArn = (options['role-arn'] || options.roleArn);
            console.log(`  Using provided IAM role ARN: ${(options['role-arn'] || options.roleArn)}`);
        }

        let createS3Buckets = false;
        if (nonInteractive && (options['skip-s3'] || options.skipS3)) {
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

        // Check for existing bootstrap stack in this account-region (resources are singletons)
        try {
            const existingStacks = this._execAws(
                `cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE --query "StackSummaries[?starts_with(StackName,'${STACK_NAME_PREFIX}-')].StackName" --output json`,
                awsProfile
            );
            const stacks = Array.isArray(existingStacks) ? existingStacks : [];
            const otherStack = stacks.find(s => s !== stackName);
            if (otherStack) {
                console.log(`  ℹ️  Bootstrap infrastructure already exists in ${accountId}/${region} (stack: ${otherStack})`);
                console.log('     Reusing existing resources (IAM role, ECR repo are singletons per account-region).');
                console.log('     Use `ml-container-creator bootstrap update` to apply latest permissions.\n');

                // Read outputs from existing stack
                const outputs = this._execAws(
                    `cloudformation describe-stacks --stack-name ${otherStack} --query "Stacks[0].Outputs" --output json`,
                    awsProfile
                );
                const stackOutputs = {};
                if (Array.isArray(outputs)) {
                    for (const o of outputs) {
                        stackOutputs[o.OutputKey] = o.OutputValue;
                    }
                }

                profileData.roleArn = stackOutputs.RoleArn;
                profileData.ecrRepositoryName = stackOutputs.EcrRepositoryName;
                profileData.stackName = stackName;
                profileData.sharedInfraFrom = otherStack;  // Track that this profile reuses another's stack
                if (stackOutputs.AsyncS3BucketName) profileData.asyncS3Bucket = stackOutputs.AsyncS3BucketName;
                if (stackOutputs.BatchS3BucketName) profileData.batchS3Bucket = stackOutputs.BatchS3BucketName;
                if (stackOutputs.AdapterS3BucketName) profileData.adapterS3Bucket = stackOutputs.AdapterS3BucketName;
                if (stackOutputs.BenchmarkS3BucketName) profileData.benchmarkS3Bucket = stackOutputs.BenchmarkS3BucketName;

                // Skip stack deployment, continue to CI setup and profile save
                console.log('  ✅ Existing bootstrap infrastructure reused');
            }
        } catch (_) {
            // If list-stacks fails, proceed with normal deployment
        }

        if (!profileData.stackName) {
            // Pre-check: if IAM role already exists globally (from another region's deployment),
            // pass its ARN so CloudFormation skips re-creation (account-level singleton)
            if (!useExistingRoleArn) {
                try {
                    const roleResult = this._execAws(
                        'iam get-role --role-name mlcc-sagemaker-execution-role',
                        awsProfile
                    );
                    const roleArn = roleResult && roleResult.Role && roleResult.Role.Arn;
                    if (roleArn && roleArn.startsWith('arn:aws:iam::')) {
                        useExistingRoleArn = roleArn;
                        console.log(`  ℹ️  Reusing existing IAM role: ${roleArn}`);
                    }
                } catch (_) {
                    // Role doesn't exist yet — will be created by the stack
                }
            }

            try {
                // Check if ECR repo already exists (avoid ResourceExistenceCheck failure)
                let skipEcr = 'false';
                try {
                    this._execAws(
                        `ecr describe-repositories --repository-names ml-container-creator --region ${region}`,
                        awsProfile
                    );
                    skipEcr = 'true';
                    console.log('  ℹ️  ECR repository already exists — skipping creation');
                } catch (_) { /* doesn't exist — will be created */ }

                const stackOutputs = this._deployStack(stackName, {
                    CreateS3Buckets: createS3Buckets ? 'true' : 'false',
                    UseExistingRoleArn: useExistingRoleArn,
                    SkipEcrCreation: skipEcr
                }, awsProfile, region);

                // Read outputs into profile data
                profileData.roleArn = stackOutputs.RoleArn;
                profileData.ecrRepositoryName = stackOutputs.EcrRepositoryName || 'ml-container-creator';
                profileData.stackName = stackName;

                if (stackOutputs.AsyncS3BucketName) {
                    profileData.asyncS3Bucket = stackOutputs.AsyncS3BucketName;
                }
                if (stackOutputs.BatchS3BucketName) {
                    profileData.batchS3Bucket = stackOutputs.BatchS3BucketName;
                }
                if (stackOutputs.AdapterS3BucketName) {
                    profileData.adapterS3Bucket = stackOutputs.AdapterS3BucketName;
                }
                if (stackOutputs.BenchmarkS3BucketName) {
                    profileData.benchmarkS3Bucket = stackOutputs.BenchmarkS3BucketName;
                }

                console.log('  ✅ Bootstrap stack deployed successfully');
            } catch (error) {
                console.log(`  ❌ Stack deployment failed: ${error.message}`);
                console.log('  Check the CloudFormation console for details:');
                console.log(`  https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks`);
                return;
            }
        } // end if (!profileData.stackName)

        // Step 4b: MLflow App for model customization experiment tracking
        this._displayProgress('📊', 'MLflow App for experiment tracking...');
        try {
            if (!profileData.mlflowAppArn) {
                const mlflowAppArn = this._ensureMlflowApp(profileData, awsProfile);
                if (mlflowAppArn) {
                    profileData.mlflowAppArn = mlflowAppArn;
                    console.log(`  ✅ MLflow App ready: ${mlflowAppArn}`);
                }
            } else {
                console.log(`  ✅ MLflow App already configured: ${profileData.mlflowAppArn}`);
            }
        } catch (error) {
            console.log(`  ⚠️  MLflow App setup skipped: ${error.message}`);
            console.log('     Tune jobs will still work but experiment tracking may not be available.');
        }

        // Step 5: CI Infrastructure setup (separate CDK stack — unchanged)
        this._displayProgress('🧪', 'CI Testing Infrastructure...');
        try {
            let provisionCi = false;

            if (nonInteractive) {
                if (options.ci) {
                    provisionCi = true;
                } else if ((options['skip-ci'] || options.skipCi)) {
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
                // --- CI single-region enforcement ---
                const ciConflict = this._findExistingCiProfile(profileName);
                if (ciConflict) {
                    console.log(`❌ CI infrastructure already deployed in region ${ciConflict.config.awsRegion} (profile: ${ciConflict.name}).`);
                    console.log('   CI can only be deployed in one region per account.');
                    provisionCi = false;
                }
            }

            if (provisionCi) {
                // Persist CI intent immediately so that `bootstrap update --ci` can
                // retry if the CDK deploy fails. Don't wait for success.
                profileData.ciInfraProvisioned = true;
                profileData.ciTableName = profileData.ciTableName || 'mlcc-ci-table';

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

                    // Warn if shell AWS_REGION differs from profile region
                    if (process.env.AWS_REGION && process.env.AWS_REGION !== profileData.awsRegion) {
                        console.log(`  ⚠️  AWS_REGION env var (${process.env.AWS_REGION}) differs from profile region (${profileData.awsRegion}) — using profile region`);
                    }

                    // --no-rollback prevents rollback on AlreadyExists errors for IAM roles
                    // that may pre-exist from a prior deployment or another region.
                    // Check if benchmark bucket already exists (from a prior torn-down stack with RETAIN policy)
                    let importBucketCtx = '';
                    if (options.benchmarkInfra) {
                        try {
                            execSync(
                                `aws s3api head-bucket --bucket mlcc-benchmark-results-${profileData.accountId}-${profileData.awsRegion}${profileData.awsProfile ? ` --profile ${profileData.awsProfile}` : ''} --region ${profileData.awsRegion}`,
                                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                            );
                            importBucketCtx = ' -c importExistingBenchmarkBucket=true';
                            console.log('  ℹ️  Benchmark results bucket already exists — importing into stack');
                        } catch {
                            // Bucket doesn't exist — will be created fresh
                        }
                    }
                    const cdkDeployCmd = options.benchmarkInfra
                        ? `npx cdk deploy MlccCiHarnessStack --require-approval never --no-rollback --parameters MlccCiHarnessStack:CreateBenchmarkInfra=true${importBucketCtx}`
                        : 'npx cdk deploy MlccCiHarnessStack --require-approval never --no-rollback';
                    execSync(
                        cdkDeployCmd,
                        {
                            cwd: ciHarnessDir,
                            encoding: 'utf8',
                            stdio: 'inherit',
                            env: {
                                ...process.env,
                                AWS_REGION: profileData.awsRegion,
                                CDK_DEFAULT_REGION: profileData.awsRegion,
                                CDK_DEFAULT_ACCOUNT: profileData.accountId,
                                AWS_PROFILE: profileData.awsProfile
                            }
                        }
                    );
                    console.log('  ✅ CI harness stack deployed');

                    profileData.ciInfraProvisioned = true;
                    profileData.ciTableName = 'mlcc-ci-table';
                    if (options.benchmarkInfra) {
                        profileData.benchmarkInfraProvisioned = true;
                        profileData.ciGlueDatabase = 'mlcc_ci';
                        profileData.ciBenchmarkResultsBucket = `mlcc-benchmark-results-${profileData.accountId}-${profileData.awsRegion}`;
                    }
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

        // Step 6: Post-setup chain (mcp init → sync-architectures → sync-schemas)
        await this._runPostSetupChain(options);
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

        // --- SANITY CHECK 1: Account identity ---
        const callerAccount = this._getCallerAccount(profileConfig.awsProfile);
        if (callerAccount !== profileConfig.accountId) {
            console.log(`❌ Account mismatch: profile expects ${profileConfig.accountId} but credentials resolve to ${callerAccount}`);
            return;
        }

        // Re-deploy the CloudFormation bootstrap stack
        const stackName = profileConfig.stackName || `${STACK_NAME_PREFIX}-${name}`;

        // Sanity check: stack name consistency (warn-and-continue)
        const expectedStackName = `${STACK_NAME_PREFIX}-${name}`;
        if (profileConfig.stackName && profileConfig.stackName !== expectedStackName) {
            console.log(`⚠️  Stack name mismatch: expected "${expectedStackName}" but profile has "${profileConfig.stackName}"`);
            console.log('   Run `ml-container-creator bootstrap migrate` to fix.');
            console.log('   Proceeding with stored stack name...');
        }

        // --- SANITY CHECK 3: Stack exists in target region ---
        const stackExists = this._resourceExists(
            `cloudformation describe-stacks --stack-name ${stackName} --region ${profileConfig.awsRegion}`,
            profileConfig.awsProfile
        );
        if (!stackExists) {
            console.log(`❌ Stack "${stackName}" not found in ${profileConfig.awsRegion}.`);
            console.log('   Run `ml-container-creator bootstrap` to create it.');
            return;
        }

        // --- CI single-region enforcement ---
        if (options.ci) {
            const ciConflict = this._findExistingCiProfile(name);
            if (ciConflict) {
                console.log(`❌ CI infrastructure already deployed in region ${ciConflict.config.awsRegion} (profile: ${ciConflict.name}).`);
                console.log('   CI can only be deployed in one region per account.');
                return;
            }
        }

        this._displayProgress('☁️', 'Updating bootstrap stack...');

        // Pre-check: if IAM role already exists globally (from another region's deployment),
        // pass its ARN so CloudFormation skips re-creation (account-level singleton)
        let useExistingRoleArn = profileConfig.roleArn || '';
        if (!useExistingRoleArn) {
            try {
                const roleResult = this._execAws(
                    'iam get-role --role-name mlcc-sagemaker-execution-role',
                    profileConfig.awsProfile
                );
                const roleArn = roleResult && roleResult.Role && roleResult.Role.Arn;
                if (roleArn && roleArn.startsWith('arn:aws:iam::')) {
                    useExistingRoleArn = roleArn;
                }
            } catch (_) {
                // Role doesn't exist yet — will be created by the stack
            }
        }

        try {
            // Check if ECR repo already exists (avoid ResourceExistenceCheck failure)
            let skipEcr = 'false';
            try {
                this._execAws(
                    `ecr describe-repositories --repository-names ml-container-creator --region ${profileConfig.awsRegion}`,
                    profileConfig.awsProfile
                );
                skipEcr = 'true';
            } catch (_) { /* doesn't exist */ }

            const stackOutputs = this._deployStack(stackName, {
                CreateS3Buckets: (profileConfig.asyncS3Bucket || profileConfig.batchS3Bucket) ? 'true' : 'false',
                UseExistingRoleArn: useExistingRoleArn,
                SkipEcrCreation: skipEcr
            }, profileConfig.awsProfile, profileConfig.awsRegion);

            // Update profile with any new outputs
            if (stackOutputs.RoleArn) profileConfig.roleArn = stackOutputs.RoleArn;
            if (stackOutputs.EcrRepositoryName) profileConfig.ecrRepositoryName = stackOutputs.EcrRepositoryName;
            if (stackOutputs.AsyncS3BucketName) profileConfig.asyncS3Bucket = stackOutputs.AsyncS3BucketName;
            if (stackOutputs.BatchS3BucketName) profileConfig.batchS3Bucket = stackOutputs.BatchS3BucketName;
            if (stackOutputs.BenchmarkS3BucketName) profileConfig.benchmarkS3Bucket = stackOutputs.BenchmarkS3BucketName;
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

                    // --no-rollback prevents rollback on AlreadyExists errors for IAM roles
                    // that may pre-exist from a prior deployment or another region.
                    // Check if benchmark bucket already exists (from a prior torn-down stack with RETAIN policy)
                    let updateImportBucketCtx = '';
                    if (options.benchmarkInfra || profileConfig.benchmarkInfraProvisioned) {
                        try {
                            execSync(
                                `aws s3api head-bucket --bucket mlcc-benchmark-results-${profileConfig.accountId}-${profileConfig.awsRegion}${profileConfig.awsProfile ? ` --profile ${profileConfig.awsProfile}` : ''} --region ${profileConfig.awsRegion}`,
                                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                            );
                            updateImportBucketCtx = ' -c importExistingBenchmarkBucket=true';
                            console.log('  ℹ️  Benchmark results bucket already exists — importing into stack');
                        } catch {
                            // Bucket doesn't exist — will be created fresh
                        }
                    }
                    const updateCdkCmd = (options.benchmarkInfra || profileConfig.benchmarkInfraProvisioned)
                        ? `npx cdk deploy MlccCiHarnessStack --require-approval never --no-rollback --parameters MlccCiHarnessStack:CreateBenchmarkInfra=true${updateImportBucketCtx}`
                        : 'npx cdk deploy MlccCiHarnessStack --require-approval never --no-rollback';
                    execSync(
                        updateCdkCmd,
                        {
                            cwd: ciHarnessDir,
                            encoding: 'utf8',
                            stdio: 'inherit',
                            env: {
                                ...process.env,
                                AWS_REGION: profileConfig.awsRegion,
                                CDK_DEFAULT_REGION: profileConfig.awsRegion,
                                CDK_DEFAULT_ACCOUNT: profileConfig.accountId,
                                AWS_PROFILE: profileConfig.awsProfile
                            }
                        }
                    );
                    profileConfig.ciInfraProvisioned = true;
                    profileConfig.ciGlueDatabase = profileConfig.ciGlueDatabase || 'mlcc_ci';
                    profileConfig.ciBenchmarkResultsBucket = profileConfig.ciBenchmarkResultsBucket || `mlcc-benchmark-results-${profileConfig.accountId}-${profileConfig.awsRegion}`;
                    console.log('  ✅ CI harness stack updated');
                }
            } catch (error) {
                console.log(`  ❌ CI stack update failed: ${error.message}`);
            }
        } else {
            console.log('  ⏭️  CI stack skipped (not provisioned — use --ci to force)');
        }

        // Ensure MLflow App exists
        this._displayProgress('📊', 'MLflow App for experiment tracking...');
        try {
            const mlflowAppArn = this._ensureMlflowApp(profileConfig, profileConfig.awsProfile);
            if (mlflowAppArn) {
                profileConfig.mlflowAppArn = mlflowAppArn;
                console.log(`  ✅ MLflow App ready: ${mlflowAppArn}`);
            }
        } catch (error) {
            console.log(`  ⚠️  MLflow App setup skipped: ${error.message}`);
        }

        // Save updated profile
        this.config.setProfile(name, profileConfig);
        console.log(`\n✅ Update complete for profile "${name}"`);

        // Re-run post-setup chain after updating AWS resources
        await this._runPostSetupChain(options);
    }

    /**
     * Migrate legacy profiles to current naming conventions.
     * Corrects stackName mismatches and renames sharedStackFrom → sharedInfraFrom.
     * Displays a preview of all changes and requires confirmation before writing.
     */
    async _handleMigrate() {
        const config = this.config.read();
        if (!config || !config.profiles) {
            console.log('No profiles to migrate.');
            return;
        }

        const changes = [];

        for (const [name, profileConfig] of Object.entries(config.profiles)) {
            const expected = `${STACK_NAME_PREFIX}-${name}`;

            // Fix stackName mismatch
            if (profileConfig.stackName && profileConfig.stackName !== expected) {
                changes.push({
                    profile: name,
                    field: 'stackName',
                    from: profileConfig.stackName,
                    to: expected
                });
            }

            // Rename sharedStackFrom → sharedInfraFrom
            if (profileConfig.sharedStackFrom) {
                changes.push({
                    profile: name,
                    field: 'sharedStackFrom → sharedInfraFrom',
                    from: profileConfig.sharedStackFrom,
                    to: profileConfig.sharedStackFrom
                });
            }
        }

        if (changes.length === 0) {
            console.log('✅ All profiles already use current naming conventions.');
            return;
        }

        // Display preview
        console.log('📋 Migration Preview:\n');
        for (const change of changes) {
            console.log(`  Profile "${change.profile}":`);
            console.log(`    ${change.field}: "${change.from}" → "${change.to}"`);
        }

        // Prompt for confirmation
        const { confirm } = await this._promptFn([{
            type: 'confirm',
            name: 'confirm',
            message: 'Apply these changes?',
            default: true
        }]);

        if (!confirm) return;

        // Apply changes
        for (const [name, profileConfig] of Object.entries(config.profiles)) {
            const expected = `${STACK_NAME_PREFIX}-${name}`;
            if (profileConfig.stackName !== expected) {
                profileConfig.stackName = expected;
            }
            if (profileConfig.sharedStackFrom) {
                profileConfig.sharedInfraFrom = profileConfig.sharedStackFrom;
                delete profileConfig.sharedStackFrom;
            }
        }

        this.config.write(config);
        console.log('✅ Migration complete.');
    }

    /**
     * Run the post-setup chain: mcp init → registry sync-architectures → sync-schemas.
     * Each step is independent — failures are collected and reported at the end.
     *
     * @param {object} options - Parsed CLI options (checks skipPostSetup)
     */
    async _runPostSetupChain(options = {}) {
        if ((options['skip-post-setup'] || options.skipPostSetup)) {
            console.log('\n⏭️  Skipping post-setup chain (--skip-post-setup)');
            return;
        }

        console.log('\n🔗 Running post-setup configuration...\n');

        const failures = [];

        // 1. MCP init — register bundled MCP servers
        console.log('📡 Registering MCP servers...');
        try {
            const generatorAdapter = {
                destinationPath(...segments) {
                    return path.resolve(process.cwd(), ...segments);
                }
            };
            const mcpHandler = new McpCommandHandler(generatorAdapter);
            await mcpHandler.handle(['init'], {});
        } catch (error) {
            failures.push({ step: 'mcp init', error: error.message });
            console.log(`  ⚠️  mcp init failed: ${error.message}`);
        }

        // 2. Registry sync-architectures — populate supportedModelTypes
        console.log('\n📋 Syncing model architecture registry...');
        try {
            const registryHandler = new RegistryCommandHandler();
            await registryHandler.handle(['sync-architectures'], {});
        } catch (error) {
            failures.push({ step: 'registry sync-architectures', error: error.message });
            console.log(`  ⚠️  registry sync-architectures failed: ${error.message}`);
        }

        // 3. Schema sync — download AWS service models
        console.log('\n📐 Syncing service schemas...');
        try {
            await this._handleSyncSchemas();
        } catch (error) {
            failures.push({ step: 'sync-schemas', error: error.message });
            console.log(`  ⚠️  sync-schemas failed: ${error.message}`);
        }

        // Report results
        if (failures.length === 0) {
            console.log('\n✅ Bootstrap complete — all systems operational');
        } else {
            console.log(`\n⚠️  Bootstrap complete with ${failures.length} warning${failures.length === 1 ? '' : 's'}:`);
            for (const { step, error } of failures) {
                console.log(`  • ${step}: ${error}`);
            }
            console.log('\n  These steps can be re-run individually:');
            console.log('    ml-container-creator mcp init');
            console.log('    ml-container-creator registry sync-architectures');
            console.log('    ml-container-creator bootstrap sync-schemas');
        }
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
     * @param {string} arn - AWS ARN string
     * @returns {string} The resource name portion
     */
    _extractNameFromArn(arn) {
        const parts = arn.split('/');
        return parts[parts.length - 1];
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


    // ── AWS CLI helpers ─────────────────────────────────────────────

    /**
     * Execute an AWS CLI command and return parsed JSON output.
     * @param {string} command - AWS CLI command (without 'aws' prefix)
     * @param {string} profile - AWS profile name
     * @returns {object} Parsed JSON output
     */
    _execAws(command, profile) {
        const profileFlag = profile ? `--profile ${profile}` : '';
        const fullCommand = `aws ${command} ${profileFlag} --output json`.replace(/\s+/g, ' ').trim();
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
     * Before deploying, checks for pre-existing S3 buckets that would cause
     * ResourceExistenceCheck failures. If the stack is in REVIEW_IN_PROGRESS
     * state (empty shell from a failed prior attempt), deletes it first.
     * If buckets exist but aren't managed by the stack, uses a CloudFormation
     * import changeset to adopt them before proceeding with the normal deploy.
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
        // Handle ghost stacks and pre-existing resources
        this._resolveStackConflicts(stackName, parameters, profile, region);

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
            } else if (stderr.includes('ResourceExistenceCheck')) {
                // Resources already exist outside the stack — attempt import and retry
                console.log('  ⚠️  Pre-existing resources detected — attempting import...');
                this._resolveStackConflicts(stackName, parameters, profile, region);
                // Rebuild deploy command with updated parameters (e.g., CreateS3Buckets may now be 'false')
                const retryParamOverrides = Object.entries(parameters)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' ');
                const retryDeployCommand = [
                    'aws cloudformation deploy',
                    `--template-file ${STACK_TEMPLATE_PATH}`,
                    `--stack-name ${stackName}`,
                    '--capabilities CAPABILITY_NAMED_IAM',
                    `--parameter-overrides ${retryParamOverrides}`,
                    `--profile ${profile}`,
                    `--region ${region}`
                ].join(' ');
                // Retry the deploy after import
                try {
                    execSync(retryDeployCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
                } catch (retryError) {
                    const retryStderr = retryError.stderr || retryError.message || '';
                    if (!retryStderr.includes('No changes to deploy')) {
                        throw retryError;
                    }
                }
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

        // If S3 buckets already existed (skipped creation), inject their names
        // into outputs so the profile config gets populated correctly.
        if (this._preExistingBuckets && this._preExistingBuckets.length > 0) {
            const bucketOutputMap = {
                'AsyncS3Bucket': 'AsyncS3BucketName',
                'BatchS3Bucket': 'BatchS3BucketName',
                'AdapterS3Bucket': 'AdapterS3BucketName',
                'BenchmarkS3Bucket': 'BenchmarkS3BucketName',
                'TuneS3Bucket': 'TuneS3BucketName'
            };
            for (const bucket of this._preExistingBuckets) {
                const outputKey = bucketOutputMap[bucket.logicalId];
                if (outputKey && !outputs[outputKey]) {
                    outputs[outputKey] = bucket.name;
                }
            }
            this._preExistingBuckets = null;
        }

        return outputs;
    }

    /**
     * Resolve stack conflicts before deploying.
     *
     * Handles two scenarios that cause ResourceExistenceCheck failures:
     * 1. Ghost stacks (REVIEW_IN_PROGRESS) — delete them first
     * 2. Pre-existing S3 buckets not managed by the stack — import them
     *
     * @param {string} stackName - CloudFormation stack name
     * @param {object} parameters - Stack parameter key-value pairs
     * @param {string} profile - AWS CLI profile name
     * @param {string} region - AWS region
     */
    _resolveStackConflicts(stackName, parameters, profile, region) {
        // Check if stack exists and its status
        let stackStatus = null;
        let managedResources = [];

        try {
            const describeResult = this._execAws(
                `cloudformation describe-stacks --stack-name ${stackName} --region ${region}`,
                profile
            );
            const stack = describeResult.Stacks && describeResult.Stacks[0];
            if (stack) {
                stackStatus = stack.StackStatus;
            }
        } catch (_) {
            // Stack doesn't exist — no conflicts possible
            return;
        }

        // Handle ghost stacks (created but never successfully deployed)
        if (stackStatus === 'REVIEW_IN_PROGRESS') {
            console.log('  ⚠️  Found ghost stack (REVIEW_IN_PROGRESS) — deleting before redeploy...');
            try {
                execSync(
                    `aws cloudformation delete-stack --stack-name ${stackName} --profile ${profile} --region ${region}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                execSync(
                    `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --profile ${profile} --region ${region}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 }
                );
                console.log('  ✅ Ghost stack deleted');
            } catch (err) {
                console.log(`  ⚠️  Could not delete ghost stack: ${err.message || err}`);
            }
            // Don't return — fall through to check for pre-existing S3 buckets
            // that need to be imported on the fresh deploy. The ghost stack had
            // DeletionPolicy:Retain buckets that survive stack deletion.
            stackStatus = null;
            managedResources = [];
        }

        // For active stacks (or post-ghost-deletion), check if S3 buckets exist but aren't managed
        if (parameters.CreateS3Buckets !== 'true') {
            return; // Not creating buckets — no conflict
        }

        // Get list of resources currently managed by the stack (empty if stack was just deleted)
        if (stackStatus) {
            try {
                const resources = this._execAws(
                    `cloudformation list-stack-resources --stack-name ${stackName} --region ${region}`,
                    profile
                );
                managedResources = (resources.StackResourceSummaries || [])
                    .map(r => r.LogicalResourceId);
            } catch (_) {
                // Stack doesn't exist or can't be queried — proceed with empty managedResources
            }
        }

        // Check each S3 bucket that the template would create
        const accountId = this._currentAccountId;
        const bucketConfigs = [
            { logicalId: 'AsyncS3Bucket', name: `mlcc-async-${accountId}-${region}` },
            { logicalId: 'BatchS3Bucket', name: `mlcc-batch-${accountId}-${region}` },
            { logicalId: 'AdapterS3Bucket', name: `mlcc-adapters-${accountId}-${region}` },
            { logicalId: 'BenchmarkS3Bucket', name: `mlcc-benchmark-${accountId}-${region}` },
            { logicalId: 'TuneS3Bucket', name: `mlcc-tune-${accountId}-${region}` }
        ];

        const bucketsToImport = [];

        for (const bucket of bucketConfigs) {
            if (managedResources.includes(bucket.logicalId)) {
                continue; // Already managed by the stack — no conflict
            }
            // Check if bucket exists in AWS
            try {
                execSync(
                    `aws s3api head-bucket --bucket ${bucket.name} --profile ${profile} --region ${region}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                // Bucket exists but not in stack — needs import
                bucketsToImport.push(bucket);
            } catch (_) {
                // Bucket doesn't exist — will be created normally
            }
        }

        if (bucketsToImport.length > 0) {
            console.log(`  ℹ️  ${bucketsToImport.length} pre-existing S3 bucket(s) detected — skipping S3 creation (buckets already exist)`);

            // Pre-existing S3 buckets survive stack deletion (DeletionPolicy: Retain).
            // Rather than fighting CloudFormation's IMPORT limitations, just skip S3
            // creation and wire the existing bucket names into the profile config directly.
            // The naming convention is deterministic, so we know exactly what they are.
            this._preExistingBuckets = bucketsToImport;

            // Modify the parameters to skip S3 bucket creation in the deploy
            parameters.CreateS3Buckets = 'false';
        }
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

    /**
     * Get the AWS account ID from the caller's credentials.
     * Uses `sts get-caller-identity` to resolve the actual account.
     *
     * @param {string} awsProfile - AWS CLI profile name
     * @returns {string} The 12-digit AWS account ID
     */
    _getCallerAccount(awsProfile) {
        const identity = this._execAws('sts get-caller-identity', awsProfile);
        return identity.Account;
    }

    /**
     * Scan all profiles to find one with ciInfraProvisioned=true,
     * excluding the given profile name.
     *
     * @param {string} excludeProfile - Profile name to exclude from the scan
     * @returns {{ name: string, config: Object }|null} The CI profile, or null if none found
     */
    _findExistingCiProfile(excludeProfile) {
        const config = this.config.read();
        if (!config || !config.profiles) return null;

        for (const [name, profileConfig] of Object.entries(config.profiles)) {
            if (name === excludeProfile) continue;
            if (profileConfig.ciInfraProvisioned) {
                return { name, config: profileConfig };
            }
        }
        return null;
    }

    /**
     * Ensure an MLCC-owned MLflow App exists for experiment tracking.
     * Creates one if it doesn't exist, using the tune S3 bucket as artifact store.
     *
     * @param {object} profileData - Bootstrap profile data (needs roleArn, awsRegion, accountId)
     * @param {string} awsProfile - AWS CLI profile name
     * @returns {string|null} MLflow App ARN or null if creation failed
     */
    _ensureMlflowApp(profileData, awsProfile) {
        const region = profileData.awsRegion;
        const accountId = profileData.accountId;
        const roleArn = profileData.roleArn;
        const appName = 'mlcc-tune-tracking';
        const artifactBucket = `mlcc-tune-${accountId}-${region}`;

        // Check if MLCC app already exists
        try {
            const apps = this._execAws(
                `sagemaker list-mlflow-apps --region ${region}`,
                awsProfile
            );
            const summaries = apps.Summaries || [];
            const existing = summaries.find(a => a.Name === appName);
            if (existing) {
                return existing.Arn;
            }
        } catch {
            // list-mlflow-apps may not be available in all CLI versions — proceed to create
        }

        // Create the MLflow App
        console.log(`  Creating MLflow App "${appName}" with artifact store s3://${artifactBucket}...`);

        // Ensure the artifact bucket exists (it's the tune bucket from the stack)
        try {
            this._execAws(
                `s3api head-bucket --bucket ${artifactBucket} --region ${region}`,
                awsProfile
            );
        } catch {
            // Bucket doesn't exist — create it
            console.log(`  Creating artifact bucket: ${artifactBucket}`);
            try {
                this._execAws(
                    `s3api create-bucket --bucket ${artifactBucket} --region ${region} --create-bucket-configuration LocationConstraint=${region}`,
                    awsProfile
                );
            } catch (bucketErr) {
                // May already exist or region doesn't need LocationConstraint (us-east-1)
                if (!bucketErr.message?.includes('BucketAlreadyOwnedByYou')) {
                    try {
                        this._execAws(
                            `s3api create-bucket --bucket ${artifactBucket} --region ${region}`,
                            awsProfile
                        );
                    } catch {
                        // Bucket likely exists, continue
                    }
                }
            }
        }

        // Create the app
        try {
            const result = this._execAws(
                `sagemaker create-mlflow-app --name ${appName} --artifact-store-uri s3://${artifactBucket} --role-arn ${roleArn} --model-registration-mode AutoModelRegistrationEnabled --region ${region}`,
                awsProfile
            );
            return result.Arn;
        } catch (err) {
            // If app already exists (race condition), try to describe it
            if (err.message?.includes('ResourceLimitExceeded') || err.message?.includes('already exists')) {
                try {
                    const apps = this._execAws(
                        `sagemaker list-mlflow-apps --region ${region}`,
                        awsProfile
                    );
                    const found = (apps.Summaries || []).find(a => a.Name === appName);
                    if (found) return found.Arn;
                } catch {
                    // Fall through
                }
            }
            throw err;
        }
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
  migrate                             Upgrade legacy profiles to current naming conventions
  sync-model-families                 Discover tune-eligible models from JumpStart Hub and update catalog

SETUP OPTIONS:
  --non-interactive                   Run without interactive prompts
  --name <name>                       Bootstrap profile name (default: "default")
  --profile <profile>                 AWS CLI profile to use
  --region <region>                   AWS region for resources
  --role-arn <arn>                    Use existing IAM role ARN (skip role creation)
  --skip-s3                           Skip S3 bucket creation
  --ci                                Provision CI testing infrastructure
  --skip-ci                           Skip CI infrastructure provisioning
  --skip-post-setup                   Skip post-setup chain (mcp init, sync-architectures, sync-schemas)

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
  ml-container-creator bootstrap sync-model-families
  ml-container-creator bootstrap migrate
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
