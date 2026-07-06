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
import { loadModuleManifest, selectModules, validateDependencies, findDependents, topologicalSort } from './bootstrap-module-selector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    _provisionAiRegistryHub(profileData) { return this.provisioners.provisionAiRegistryHub(profileData); }

    // ── ProfileManager delegations (backward compat for tests) ──────

    _handleStatus(options) { return this.profileManager._handleStatus(options); }
    _handleUse(profileName) { return this.profileManager._handleUse(profileName); }
    _handleList() { return this.profileManager._handleList(); }
    _handleRemove(profileName, options) { return this.profileManager._handleRemove(profileName, options); }
    _handleScan() { return this.profileManager._handleScan(); }
    _handlePrune() { return this.profileManager._handlePrune(); }
    _handleSyncSchemas() { return this.profileManager._handleSyncSchemas(); }
    _handleSyncModelFamilies() { return this.profileManager._handleSyncModelFamilies(); }
    _handleSyncServingVersions() { return this.profileManager._handleSyncServingVersions(); }

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
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
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
            else if (arg === '--dry-run') extractedOptions.dryRun = true;
            else if (arg.startsWith('--with=')) extractedOptions.with = arg.slice('--with='.length);
            else if (arg === '--with' && i + 1 < args.length) { extractedOptions.with = args[++i]; }
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
        case 'add':
            await this._handleModuleAdd(args[1], options);
            break;
        case 'remove-module':
            await this._handleModuleRemove(args[1], options);
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
        case 'sync-serving-versions':
            await this._handleSyncServingVersions();
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

        // ── Migration Detection ──────────────────────────────────────────────
        // Check if profile has legacy structure (roleArn but no provisionedModules)
        const activeProfile = this.config.getActiveProfile();
        if (activeProfile && activeProfile.config.roleArn && !activeProfile.config.provisionedModules) {
            if (!nonInteractive) {
                const { migrate } = await this._promptFn([{
                    type: 'confirm',
                    name: 'migrate',
                    message: 'Existing bootstrap infrastructure detected. Migrate to modular stacks? [Y/n]',
                    default: true
                }]);

                if (migrate) {
                    const profileConfig = activeProfile.config;
                    const discoveredModules = ['core']; // Always present if roleArn exists

                    // Discover profile-level resources
                    if (profileConfig.ciBenchmarkResultsBucket || profileConfig.benchmarkS3Bucket) {
                        discoveredModules.push('benchmark');
                    }
                    if (profileConfig.aiRegistryHubName) {
                        discoveredModules.push('registry');
                    }
                    if (profileConfig.ciInfraProvisioned) {
                        discoveredModules.push('ci');
                    }

                    profileConfig.provisionedModules = discoveredModules;
                    profileConfig.moduleOutputs = {
                        core: {
                            RoleArn: profileConfig.roleArn,
                            EcrRepositoryName: profileConfig.ecrRepositoryName || 'ml-container-creator'
                        }
                    };

                    if (profileConfig.ciBenchmarkResultsBucket) {
                        profileConfig.moduleOutputs.benchmark = {
                            BenchmarkBucket: profileConfig.ciBenchmarkResultsBucket,
                            GlueDatabase: profileConfig.ciGlueDatabase || 'mlcc_ci'
                        };
                    }

                    if (profileConfig.aiRegistryHubName) {
                        profileConfig.moduleOutputs.registry = {
                            AiRegistryHubName: profileConfig.aiRegistryHubName
                        };
                    }

                    this.config.setProfile(activeProfile.name, profileConfig);
                    console.log(`  ✅ Migrated profile "${activeProfile.name}" to modular format.`);
                    console.log(`     Modules: ${discoveredModules.join(', ')}`);
                    console.log('     Note: Modular CDK stacks will be created on next `bootstrap add` or full setup.\n');
                    return;
                } else {
                    console.log('  ⚠️  Monolithic bootstrap is deprecated. Run `bootstrap` again to migrate when ready.\n');
                }
            }
        }

        // Verify AWS CLI v2 is installed
        if (!this._verifyCliV2()) {
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

        // Step 3: Module selection
        const manifest = loadModuleManifest();
        const alreadyProvisioned = [];  // Fresh setup — no modules yet
        let selected;

        if (nonInteractive) {
            // Default: core + registry. --with adds more.
            selected = ['core', 'registry'];
            if (options.with) {
                const extra = options.with.split(',').map(m => m.trim()).filter(Boolean);
                for (const m of extra) {
                    if (!manifest.modules[m]) {
                        console.log(`❌ Unknown module: ${m}`);
                        console.log(`   Available: ${Object.keys(manifest.modules).join(', ')}`);
                        return;
                    }
                    if (!selected.includes(m)) {
                        selected.push(m);
                    }
                }
            }
        } else {
            selected = await selectModules(alreadyProvisioned, this._promptFn);
        }

        // Validate and auto-add missing dependencies
        const { valid, missing } = validateDependencies(selected);
        if (!valid) {
            const autoAdded = [];
            for (const m of missing) {
                for (const dep of m.missingDeps) {
                    if (!selected.includes(dep)) {
                        selected.push(dep);
                        autoAdded.push(dep);
                    }
                }
            }
            if (autoAdded.length > 0) {
                console.log(`  ℹ️  Auto-adding required dependencies: ${autoAdded.join(', ')}`);
            }
        }

        // Topological sort for correct provisioning order
        const ordered = topologicalSort(selected);

        // Step 4: Dry-run preview
        if (options.dryRun) {
            console.log('\n🔍 Dry run — no resources will be created.\n');
            console.log('   Modules to provision (in order):');
            for (const moduleName of ordered) {
                const mod = manifest.modules[moduleName];
                const sn = `mlcc-${profileName}-${mod.stackNameSuffix}`;
                console.log(`     ${mod.displayName} (${moduleName}) → ${sn}  ~${mod.estimatedMonthlyCost || '$0'}/mo`);
            }
            console.log(`\n   Profile: ${profileName}`);
            console.log(`   Region:  ${region}`);
            console.log(`   Account: ${accountId}`);
            console.log('\n   Re-run without --dry-run to apply.');
            return;
        }

        // Step 5: Ensure CDK is bootstrapped in this account/region
        this._displayProgress('📦', 'Checking CDK bootstrap...');
        const cdkBootstrapped = this._resourceExists(
            `ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --region ${region}`,
            awsProfile
        );

        if (!cdkBootstrapped) {
            console.log('  CDK has not been bootstrapped — bootstrapping now...');
            try {
                execSync(
                    `npx cdk bootstrap aws://${accountId}/${region}`,
                    {
                        encoding: 'utf8',
                        stdio: 'inherit',
                        env: {
                            ...process.env,
                            AWS_PROFILE: awsProfile
                        }
                    }
                );
                console.log('  ✅ CDK bootstrap complete');
            } catch (cdkErr) {
                console.log(`  ❌ CDK bootstrap failed: ${cdkErr.message}`);
                console.log(`  Run manually: npx cdk bootstrap aws://${accountId}/${region} --profile ${awsProfile}`);
                return;
            }
        }

        // Step 6: Provision modules via CdkModuleRunner
        this._displayProgress('☁️', 'Provisioning infrastructure modules...');
        const moduleOutputs = await this._provisionModules(ordered, manifest, profileName, accountId, region, awsProfile);
        if (moduleOutputs === null) {
            // Provision failed — partial progress not saved (module runner logs the error)
            return;
        }

        // Step 7: MLflow best-effort for training module
        if (ordered.includes('training')) {
            this._displayProgress('📊', 'MLflow App for experiment tracking (best-effort)...');
            try {
                const { ensureMlflowApp } = await import('../../infra/bootstrap-modules/training/provision-mlflow.cjs');
                const coreOutputs = moduleOutputs.core || {};
                const mlflowAppArn = ensureMlflowApp({
                    accountId,
                    awsRegion: region,
                    awsProfile,
                    roleArn: coreOutputs.RoleArn || profileData.roleArn
                });
                if (mlflowAppArn) {
                    moduleOutputs.training = moduleOutputs.training || {};
                    moduleOutputs.training.MlflowAppArn = mlflowAppArn;
                    console.log(`  ✅ MLflow App ready: ${mlflowAppArn}`);
                }
            } catch (error) {
                console.log(`  ⚠️  MLflow App setup skipped (best-effort): ${error.message}`);
                console.log('     Tune jobs will still work — MLFLOW_APP_ARN will be absent.');
            }
        }

        // Build final profile data
        profileData.provisionedModules = ordered;
        profileData.moduleOutputs = moduleOutputs;

        // Step 8: Denormalize module outputs into flat profile keys for backward compat
        this._denormalizeModuleOutputs(profileData);

        // Save profile to config
        this.config.setProfile(profileName, profileData);
        this._displayProgress('✅', `Profile "${profileName}" saved to config`);

        // Display summary
        this._displaySummary(profileName, profileData);

        // Step 9: Post-setup chain (mcp init → sync-architectures → sync-schemas)
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

        // --- SANITY CHECK: Account identity ---
        const callerAccount = this._getCallerAccount(profileConfig.awsProfile);
        if (callerAccount !== profileConfig.accountId) {
            console.log(`❌ Account mismatch: profile expects ${profileConfig.accountId} but credentials resolve to ${callerAccount}`);
            return;
        }

        this._displayProgress('☁️', 'Re-provisioning modular stacks...');

        const provisioned = profileConfig.provisionedModules || ['core'];
        const manifest = loadModuleManifest();
        const ordered = topologicalSort(provisioned);
        const moduleOutputs = await this._provisionModules(ordered, manifest, name, profileConfig.accountId, profileConfig.awsRegion, profileConfig.awsProfile);

        if (moduleOutputs === null) {
            // Fatal failure — partial progress not saved
            return;
        }

        // MLflow best-effort for training module
        if (provisioned.includes('training')) {
            this._displayProgress('📊', 'MLflow App for experiment tracking (best-effort)...');
            try {
                const { ensureMlflowApp } = await import('../../infra/bootstrap-modules/training/provision-mlflow.cjs');
                const coreOutputs = moduleOutputs.core || {};
                const mlflowAppArn = ensureMlflowApp({
                    accountId: profileConfig.accountId,
                    awsRegion: profileConfig.awsRegion,
                    awsProfile: profileConfig.awsProfile,
                    roleArn: coreOutputs.RoleArn || profileConfig.roleArn
                });
                if (mlflowAppArn) {
                    moduleOutputs.training = moduleOutputs.training || {};
                    moduleOutputs.training.MlflowAppArn = mlflowAppArn;
                    console.log(`  ✅ MLflow App ready: ${mlflowAppArn}`);
                }
            } catch (error) {
                console.log(`  ⚠️  MLflow App setup skipped: ${error.message}`);
            }
        }

        profileConfig.provisionedModules = ordered;
        profileConfig.moduleOutputs = moduleOutputs;
        this._denormalizeModuleOutputs(profileConfig);

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
            const expected = `mlcc-bootstrap-${name}`;

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
            const expected = `mlcc-bootstrap-${name}`;
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

    /**
     * Denormalize moduleOutputs into flat profile keys for backward compatibility.
     * Scripts in do/ (profile.sh) and templates read flat keys like roleArn,
     * ecrRepositoryName, ciBenchmarkResultsBucket, etc. This method derives
     * them from the structured moduleOutputs so both formats coexist in the
     * persisted profile.
     *
     * @param {object} profileData - Profile data object (mutated in place)
     */
    _denormalizeModuleOutputs(profileData) {
        const outputs = profileData.moduleOutputs || {};

        // core → roleArn, ecrRepositoryName
        if (outputs.core) {
            if (outputs.core.RoleArn) profileData.roleArn = outputs.core.RoleArn;
            if (outputs.core.EcrRepositoryName) profileData.ecrRepositoryName = outputs.core.EcrRepositoryName;
        }

        // benchmark → ciBenchmarkResultsBucket, ciGlueDatabase
        if (outputs.benchmark) {
            if (outputs.benchmark.BenchmarkBucket) profileData.ciBenchmarkResultsBucket = outputs.benchmark.BenchmarkBucket;
            if (outputs.benchmark.GlueDatabase) profileData.ciGlueDatabase = outputs.benchmark.GlueDatabase;
        }

        // registry → aiRegistryHubName
        if (outputs.registry) {
            if (outputs.registry.AiRegistryHubName) profileData.aiRegistryHubName = outputs.registry.AiRegistryHubName;
        }

        // training → mlflowAppArn
        if (outputs.training) {
            if (outputs.training.MlflowAppArn) profileData.mlflowAppArn = outputs.training.MlflowAppArn;
        }

        // ci → ciInfraProvisioned, ciTableName
        if (outputs.ci) {
            profileData.ciInfraProvisioned = true;
            if (outputs.ci.CiTableName) profileData.ciTableName = outputs.ci.CiTableName;
        }
    }

    /**
     * Provision a list of modules in order via CdkModuleRunner.
     * Extracted into a method so tests can mock it without intercepting dynamic imports.
     *
     * @param {string[]} ordered - Module names in topological order
     * @param {object} manifest - Parsed module manifest
     * @param {string} profileName - Bootstrap profile name
     * @param {string} accountId - AWS account ID
     * @param {string} region - AWS region
     * @param {string} awsProfile - AWS CLI profile name
     * @returns {Promise<object|null>} Map of module name → outputs, or null if fatal failure
     */
    async _provisionModules(ordered, manifest, profileName, accountId, region, awsProfile) {
        const { CdkModuleRunner } = await import('../../infra/bootstrap-modules/module-runner.cjs');
        const moduleOutputs = {};
        this._ensureModuleDeps();

        for (const moduleName of ordered) {
            const mod = manifest.modules[moduleName];
            const runner = new CdkModuleRunner(moduleName, mod.stackNameSuffix);
            try {
                const outputs = await runner.provision({
                    accountId,
                    awsRegion: region,
                    awsProfile,
                    profileName
                });
                moduleOutputs[moduleName] = outputs;
            } catch (error) {
                console.log(`  ❌ Module "${moduleName}" failed: ${error.message}`);
                console.log('  Aborting — partial progress not saved. Fix the error and re-run.');
                return null;
            }
        }

        return moduleOutputs;
    }

    /**
     * Ensure the bootstrap-modules CDK package has its dependencies installed.
     * Lazily runs `npm install` in infra/bootstrap-modules/ the first time a
     * provision is attempted (mirrors the ci-harness lazy-install pattern).
     * The CDK deps (aws-cdk-lib, constructs, ts-node) are only needed when
     * actually provisioning, so we don't pay the install cost on every
     * `npm install` of the parent package.
     *
     * Best-effort: logs a warning if install fails but does not throw — the
     * subsequent `cdk deploy` will surface a clearer error if deps are truly
     * missing.
     */
    _ensureModuleDeps() {
        const modulesDir = path.resolve(__dirname, '../../infra/bootstrap-modules');
        const nodeModules = path.join(modulesDir, 'node_modules', 'aws-cdk-lib');

        if (existsSync(nodeModules)) {
            return; // Already installed
        }

        console.log('  📦 Installing bootstrap-modules CDK dependencies (first run)...');
        try {
            execSync('npm install --silent', {
                cwd: modulesDir,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            console.log('  ✅ CDK dependencies installed');
        } catch (err) {
            console.log(`  ⚠️  Could not auto-install CDK dependencies: ${err.message}`);
            console.log(`     Run manually: cd ${modulesDir} && npm install`);
        }
    }

    /**
     * Warn that a module's S3 bucket(s) will persist after teardown.
     * Buckets use RemovalPolicy.RETAIN, so `cdk destroy` leaves them in place
     * (data is preserved) but they become unmanaged — no stack owns them until
     * the module is re-added, at which point they're adopted automatically.
     *
     * @param {string[]} moduleNames - Modules being removed
     * @param {object} profileConfig - Active profile config (accountId, awsRegion)
     */
    _warnPersistentBuckets(moduleNames, profileConfig) {
        const bucketOwners = {
            benchmark: `mlcc-benchmark-results-${profileConfig.accountId}-${profileConfig.awsRegion}`,
            training: `mlcc-training-${profileConfig.accountId}-${profileConfig.awsRegion}`
        };
        const affected = moduleNames
            .filter(m => bucketOwners[m])
            .map(m => bucketOwners[m]);

        if (affected.length === 0) {
            return;
        }

        console.log('\n   ⚠️  S3 buckets will PERSIST after teardown (RemovalPolicy: RETAIN):');
        for (const b of affected) {
            console.log(`        • s3://${b}`);
        }
        console.log('      Your data is preserved, but these buckets become UNMANAGED — no');
        console.log('      CDK stack owns them until you re-add the module (they are adopted');
        console.log('      automatically on re-provision). To reclaim the storage/name, delete');
        console.log('      them manually: aws s3 rb s3://<bucket> --force');
    }

    // ── Display helpers ─────────────────────────────────────────────

    /**
     * Show bootstrap usage help.
     */
    /**
     * Handle `bootstrap add <module>` — provision a single additional module.
     * @param {string} moduleName - Module to add
     * @param {object} options - CLI options
     */
    async _handleModuleAdd(moduleName, options) {
        if (!moduleName) {
            console.log('❌ Usage: ml-container-creator bootstrap add <module>');
            console.log('   Available modules: core, benchmark, registry, training, ci, sagemaker-domain, hyperpod-cluster');
            return;
        }

        const manifest = loadModuleManifest();
        if (!manifest.modules[moduleName]) {
            console.log(`❌ Unknown module: ${moduleName}`);
            console.log(`   Available: ${Object.keys(manifest.modules).join(', ')}`);
            return;
        }

        if (moduleName === 'core') {
            console.log('ℹ️  Core module is always provisioned — nothing to add.');
            return;
        }

        const profile = this.config.getActiveProfile();
        if (!profile) {
            console.log('❌ No active bootstrap profile. Run `ml-container-creator bootstrap` first.');
            return;
        }

        const { name, config: profileConfig } = profile;
        const provisioned = profileConfig.provisionedModules || [];

        if (provisioned.includes(moduleName)) {
            console.log(`ℹ️  Module "${moduleName}" is already provisioned. Nothing to do.`);
            return;
        }

        // Check dependencies
        const { valid, missing } = validateDependencies([...provisioned, moduleName]);
        if (!valid) {
            for (const m of missing) {
                if (m.module === moduleName) {
                    console.log(`❌ Module "${moduleName}" requires: ${m.missingDeps.join(', ')}`);
                    console.log(`   Provision dependencies first: ml-container-creator bootstrap add ${m.missingDeps[0]}`);
                    return;
                }
            }
        }

        // Dry-run: preview what would happen without provisioning
        if (options.dryRun) {
            const mod = manifest.modules[moduleName];
            const stackName = `mlcc-${name}-${mod.stackNameSuffix}`;
            console.log('\n🔍 Dry run — no resources will be created.\n');
            console.log(`   Module:       ${mod.displayName} (${moduleName})`);
            console.log(`   CDK stack:    ${stackName}`);
            console.log(`   Est. cost:    ~${mod.estimatedMonthlyCost || '$0'}/mo`);
            console.log(`   Depends on:   ${(mod.depends || []).join(', ') || '(none)'}`);
            console.log('   Resources (CfnOutputs):');
            for (const exp of (mod.exports || [])) {
                console.log(`     - ${stackName}-${exp}`);
            }
            console.log('\n   Command that would run:');
            console.log(`     npx cdk deploy ${stackName} --require-approval never \\`);
            console.log(`       --context profileName=${name} --context accountId=${profileConfig.accountId} \\`);
            console.log(`       --context region=${profileConfig.awsRegion}`);
            console.log('\n   Profile update:');
            console.log(`     provisionedModules: [${provisioned.join(', ')}] → [${[...provisioned, moduleName].join(', ')}]`);
            console.log('\n   Re-run without --dry-run to apply.');
            return;
        }

        // Provision using module-runner
        console.log(`\n🚀 Adding module: ${manifest.modules[moduleName].displayName}`);
        const { CdkModuleRunner } = await import('../../infra/bootstrap-modules/module-runner.cjs');
        const runner = new CdkModuleRunner(moduleName, manifest.modules[moduleName].stackNameSuffix);

        try {
            const outputs = await runner.provision({
                accountId: profileConfig.accountId,
                awsRegion: profileConfig.awsRegion,
                awsProfile: profileConfig.awsProfile,
                profileName: name
            });

            // Update profile
            profileConfig.provisionedModules = [...provisioned, moduleName];
            profileConfig.moduleOutputs = profileConfig.moduleOutputs || {};
            profileConfig.moduleOutputs[moduleName] = outputs;
            this.config.setProfile(name, profileConfig);

            console.log(`\n✅ Module "${moduleName}" provisioned successfully.`);
        } catch (err) {
            console.log(`\n❌ Failed to provision "${moduleName}": ${err.message}`);
        }
    }

    /**
     * Handle `bootstrap remove-module <module>` — tear down a single module.
     * @param {string} moduleName - Module to remove
     * @param {object} options - CLI options
     */
    async _handleModuleRemove(moduleName, options) {
        if (!moduleName) {
            console.log('❌ Usage: ml-container-creator bootstrap remove-module <module>');
            return;
        }

        if (moduleName === 'core') {
            console.log('❌ Cannot remove core module — it is required for all other modules.');
            return;
        }

        const manifest = loadModuleManifest();
        if (!manifest.modules[moduleName]) {
            console.log(`❌ Unknown module: ${moduleName}`);
            return;
        }

        const profile = this.config.getActiveProfile();
        if (!profile) {
            console.log('❌ No active bootstrap profile.');
            return;
        }

        const { name, config: profileConfig } = profile;
        const provisioned = profileConfig.provisionedModules || [];

        if (!provisioned.includes(moduleName)) {
            console.log(`ℹ️  Module "${moduleName}" is not provisioned. Nothing to remove.`);
            return;
        }

        // Check dependents
        const dependents = findDependents(moduleName, provisioned);

        // Dry-run: preview the teardown without destroying anything
        if (options.dryRun) {
            const mod = manifest.modules[moduleName];
            const stackName = `mlcc-${name}-${mod.stackNameSuffix}`;
            const toRemove = [...dependents, moduleName];
            console.log('\n🔍 Dry run — no resources will be destroyed.\n');
            console.log(`   Module:       ${mod.displayName} (${moduleName})`);
            console.log(`   CDK stack:    ${stackName}`);
            if (dependents.length > 0) {
                console.log(`   ⚠️  Cascade:   ${dependents.join(', ')} depend on this module and would also be removed`);
            }
            console.log('\n   Stacks that would be destroyed (in order):');
            for (const m of toRemove) {
                console.log(`     - mlcc-${name}-${manifest.modules[m].stackNameSuffix}`);
            }
            const remaining = provisioned.filter(m => !toRemove.includes(m));
            console.log('\n   Profile update:');
            console.log(`     provisionedModules: [${provisioned.join(', ')}] → [${remaining.join(', ')}]`);
            this._warnPersistentBuckets(toRemove, profileConfig);
            console.log('\n   Re-run without --dry-run to apply.');
            return;
        }

        if (dependents.length > 0) {
            console.log(`⚠️  Module "${moduleName}" is required by: ${dependents.join(', ')}`);
            const { proceed } = await this._promptFn([{
                type: 'confirm',
                name: 'proceed',
                message: `Remove "${moduleName}" and its dependents (${dependents.join(', ')})?`,
                default: false
            }]);
            if (!proceed) {
                console.log('   Aborted.');
                return;
            }
            // Remove dependents first (reverse topological order)
            for (const dep of dependents) {
                await this._handleModuleRemove(dep, options);
            }
        }

        // Confirm removal
        if (!options.force) {
            this._warnPersistentBuckets([moduleName], profileConfig);
            const { confirm } = await this._promptFn([{
                type: 'confirm',
                name: 'confirm',
                message: `Remove module "${moduleName}"? Resources will be destroyed.`,
                default: false
            }]);
            if (!confirm) {
                console.log('   Aborted.');
                return;
            }
        }

        // Teardown
        console.log(`\n🗑️  Removing module: ${manifest.modules[moduleName].displayName}`);
        const { CdkModuleRunner } = await import('../../infra/bootstrap-modules/module-runner.cjs');
        const runner = new CdkModuleRunner(moduleName, manifest.modules[moduleName].stackNameSuffix);

        try {
            await runner.teardown({
                accountId: profileConfig.accountId,
                awsRegion: profileConfig.awsRegion,
                awsProfile: profileConfig.awsProfile,
                profileName: name
            });

            // Update profile
            profileConfig.provisionedModules = provisioned.filter(m => m !== moduleName);
            if (profileConfig.moduleOutputs) {
                delete profileConfig.moduleOutputs[moduleName];
            }
            this.config.setProfile(name, profileConfig);

            console.log(`✅ Module "${moduleName}" removed.`);
        } catch (err) {
            console.log(`❌ Failed to remove "${moduleName}": ${err.message}`);
        }
    }

    _showHelp() {
        console.log(`
Bootstrap — Modular AWS Infrastructure Setup

Provisions shared infrastructure via per-module CDK stacks. Each module
(core, benchmark, registry, training, ci) is an independent CDK stack that
can be added or removed independently.

USAGE:
  ml-container-creator bootstrap [subcommand] [options]

SUBCOMMANDS:
  (no subcommand)                     Interactive setup (default) — select and provision modules
  add <module>                        Add a single module to the active profile
  remove-module <module>              Remove a single module (tears down its CDK stack)
  status                              Show active profile, module state, and deployed resources
  status --verify                     Show status and verify active resources exist in AWS
  use <profile>                       Switch active bootstrap profile
  list                                List all bootstrap profiles
  remove <profile>                    Remove a bootstrap profile
  scan                                Discover pre-existing MLCC-managed resources in AWS
  prune                               Remove deleted and unknown records from the deployment manifest
  update                              Re-provision all modules using active profile (no prompts)
  migrate                             Upgrade legacy profiles to current naming conventions
  sync-schemas                        Download AWS service model schemas (sagemaker, iam, ecr, s3)
  sync-model-families                 Discover tune-eligible models from JumpStart Hub and update catalog
  sync-serving-versions               Discover latest vLLM/SGLang/TRT-LLM image versions and update catalog

MODULES:
  core                                IAM role + ECR repository (always required)
  benchmark                           S3 bucket + Glue DB for benchmark results
  registry                            Model Package Group + AI Registry Hub
  training                            Training data bucket + execution role + MLflow (best-effort)
  ci                                  CodeBuild + DynamoDB + StepFunctions
  sagemaker-domain                    SageMaker Studio domain + default user profile
  hyperpod-cluster                    HyperPod EKS cluster configuration

SETUP OPTIONS:
  --non-interactive                   Run without interactive prompts (requires --profile, --region)
  --name <name>                       Bootstrap profile name (default: "default")
  --profile <profile>                 AWS CLI profile to use
  --region <region>                   AWS region for resources
  --with <modules>                    Comma-separated modules to provision (default: core,registry)
  --dry-run                           Preview module plan without provisioning
  --skip-post-setup                   Skip post-setup chain (mcp init, sync-architectures, sync-schemas)
  --ignore-staleness                  Suppress schema staleness warnings

ADD/REMOVE OPTIONS:
  --dry-run                           Preview changes without provisioning or destroying
  --force                             Skip confirmation prompt on remove

STATUS OPTIONS:
  --verify                            Check each active resource against AWS APIs for drift detection

PROFILE REMOVE OPTIONS:
  --force                             Skip confirmation prompt
  --delete-stack                      Also delete the CloudFormation stack and AWS resources

EXAMPLES:
  ml-container-creator bootstrap
  ml-container-creator bootstrap --dry-run
  ml-container-creator bootstrap --non-interactive --profile my-aws-profile --region us-west-2
  ml-container-creator bootstrap --non-interactive --profile my-aws-profile --region us-west-2 --with benchmark,training,ci
  ml-container-creator bootstrap add training
  ml-container-creator bootstrap add training --dry-run
  ml-container-creator bootstrap remove-module benchmark
  ml-container-creator bootstrap remove-module benchmark --dry-run
  ml-container-creator bootstrap status
  ml-container-creator bootstrap update
  ml-container-creator bootstrap use prod
  ml-container-creator bootstrap list
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
