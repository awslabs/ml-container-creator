// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Module Runner — executes CDK deploy/destroy for bootstrap modules.
 *
 * Provides the generic implementation of provision/teardown/status that
 * the bootstrap command handler invokes for each module. Plain CommonJS
 * (.cjs, no build step) so it can be imported directly by src/lib at
 * runtime via dynamic import() — Node handles the CJS→ESM interop and
 * exposes named exports (CdkModuleRunner) on the resolved namespace.
 *
 * The CDK stacks themselves (bin/app.ts, <module>/stack.ts) remain
 * TypeScript — they are run by the `cdk` CLI via cdk.json, never imported
 * by the Node process.
 */

const { execSync } = require('child_process');
const path = require('path');

const MODULES_ROOT = path.resolve(__dirname);

/**
 * Modules that own a retained S3 bucket, and the bucket-name template.
 * These buckets use RemovalPolicy.RETAIN, so they survive `cdk destroy`.
 * On re-provision we must adopt the existing bucket instead of recreating it.
 * @param {string} accountId
 * @param {string} region
 * @returns {Record<string, string>} module name -> bucket name
 */
function retainedBucketFor(moduleName, accountId, region) {
    const map = {
        benchmark: `mlcc-benchmark-results-${accountId}-${region}`,
        training: `mlcc-training-${accountId}-${region}`,
        core: `mlcc-models-${accountId}-${region}`,
        ci: `mlcc-codebuild-source-${accountId}-${region}`,
    };
    return map[moduleName];
}

/**
 * Modules that own a SECOND retained S3 bucket, and the bucket-name template.
 * The training module owns both the training-data bucket (above) and the
 * adapters bucket, each RETAINed and each able to exist independently. This
 * companion map lets the runner detect the adapters bucket's existence
 * separately, so a re-provision adopts it only when it actually exists.
 * @returns {string|undefined} bucket name, or undefined if the module owns none
 */
function retainedAdaptersBucketFor(moduleName, accountId, region) {
    const map = {
        training: `mlcc-training-adapters-${accountId}-${region}`,
    };
    return map[moduleName];
}

/**
 * Modules that own a retained ECR repository, and the repo name.
 * The core ECR repo uses RemovalPolicy.RETAIN, so it survives `cdk destroy`.
 * On re-provision we must adopt the existing repo instead of recreating it.
 * @param {string} moduleName
 * @returns {string|undefined} repository name, or undefined if the module owns none
 */
function retainedEcrRepoFor(moduleName) {
    const map = { core: 'ml-container-creator' };
    return map[moduleName];
}

/**
 * Get the CDK stack name for a module.
 * @param {string} profileName
 * @param {string} stackNameSuffix
 * @returns {string}
 */
function getStackName(profileName, stackNameSuffix) {
    return `mlcc-${profileName}-${stackNameSuffix}`;
}

/**
 * Generic module implementation that delegates to CDK commands.
 */
class CdkModuleRunner {
    /**
     * @param {string} name - Module name from manifest
     * @param {string} stackNameSuffix - Stack name suffix from manifest
     */
    constructor(name, stackNameSuffix) {
        this.name = name;
        this.stackNameSuffix = stackNameSuffix;
    }

    /**
     * Compute the CDK context flags for adopting retained resources (S3 bucket,
     * ECR repo) that already exist. Shared by provision() and diff() so the
     * dry-run preview synthesizes the SAME template as the real deploy.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @param {object} [opts] - { verbose?: boolean } — print ♻️ adoption notices
     * @returns {string[]} array of --context flags (possibly empty)
     */
    _computeAdoptFlags(profile, opts = {}) {
        const flags = [];
        const bucketName = retainedBucketFor(this.name, profile.accountId, profile.awsRegion);
        if (bucketName && this._bucketExists(bucketName, profile)) {
            if (opts.verbose) console.log(`  ♻️  Existing bucket detected (${bucketName}) — adopting instead of recreating`);
            flags.push('--context adoptExistingBuckets=true');
        }
        const adaptersBucketName = retainedAdaptersBucketFor(this.name, profile.accountId, profile.awsRegion);
        if (adaptersBucketName && this._bucketExists(adaptersBucketName, profile)) {
            if (opts.verbose) console.log(`  ♻️  Existing adapters bucket detected (${adaptersBucketName}) — adopting instead of recreating`);
            flags.push('--context adoptExistingAdaptersBucket=true');
        }
        const ecrRepo = retainedEcrRepoFor(this.name);
        if (ecrRepo && this._ecrRepoExists(ecrRepo, profile)) {
            if (opts.verbose) console.log(`  ♻️  Existing ECR repo detected (${ecrRepo}) — adopting instead of recreating`);
            flags.push('--context adoptExistingEcr=true');
        }
        return flags;
    }

    /**
     * Provision this module's infrastructure. Idempotent.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @param {object} [opts] - { forceDeploy?: boolean }
     *   forceDeploy=true (used by `bootstrap update`) always runs `cdk deploy`
     *   so CloudFormation diffs the template and applies any changes, instead of
     *   short-circuiting when the stack already exists.
     * @returns {Promise<Record<string, string>>} Stack outputs
     */
    async provision(profile, opts = {}) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);

        // A prior failed deploy can leave the stack in a state CDK cannot update
        // (e.g. ROLLBACK_COMPLETE). Detect and delete it first so this deploy
        // starts clean, rather than failing with an un-updatable-stack error.
        await this._cleanupUnupdatableStack(stackName, profile);

        // Idempotency short-circuit for `add-module`: if the stack already
        // exists, don't redeploy. `bootstrap update` passes forceDeploy=true to
        // bypass this — cdk deploy is itself a no-op when nothing changed, but
        // will apply template changes when there are any.
        if (!opts.forceDeploy) {
            const currentStatus = await this.status(profile);
            if (currentStatus.state === 'provisioned') {
                console.log(`  ✅ ${this.name} already provisioned (${stackName})`);
                return this._getStackOutputs(stackName, profile);
            }
        }

        console.log(`  ${opts.forceDeploy ? '🔄 Updating' : '🚀 Deploying'} ${this.name} module (${stackName})...`);

        // Detect retained resources to adopt (bucket/ECR) — shared with diff()
        // so the dry-run preview synthesizes the SAME template as the real deploy.
        const adoptFlags = this._computeAdoptFlags(profile, { verbose: true });

        const cdkCmd = [
            'npx cdk deploy', stackName,
            '--require-approval never',
            `--context module=${this.stackNameSuffix}`,
            `--context profileName=${profile.profileName}`,
            `--context accountId=${profile.accountId}`,
            `--context region=${profile.awsRegion}`,
            ...adoptFlags,
        ].filter(Boolean).join(' ');

        try {
            execSync(cdkCmd, {
                cwd: MODULES_ROOT,
                encoding: 'utf8',
                stdio: 'inherit',
                env: {
                    ...process.env,
                    AWS_REGION: profile.awsRegion,
                    CDK_DEFAULT_REGION: profile.awsRegion,
                    CDK_DEFAULT_ACCOUNT: profile.accountId,
                    ...(profile.awsProfile ? { AWS_PROFILE: profile.awsProfile } : {}),
                },
            });
        } catch (err) {
            throw new Error(`CDK deploy failed for ${this.name}: ${err.message}`);
        }

        console.log(`  ✅ ${this.name} module deployed`);
        return this._getStackOutputs(stackName, profile);
    }

    /**
     * Tear down this module's infrastructure.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @returns {Promise<void>}
     */
    async teardown(profile) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);

        console.log(`  🗑️  Destroying ${this.name} module (${stackName})...`);

        const cdkCmd = [
            'npx cdk destroy', stackName,
            '--force',
            `--context module=${this.stackNameSuffix}`,
            `--context profileName=${profile.profileName}`,
            `--context accountId=${profile.accountId}`,
            `--context region=${profile.awsRegion}`,
        ].join(' ');

        try {
            execSync(cdkCmd, {
                cwd: MODULES_ROOT,
                encoding: 'utf8',
                stdio: 'inherit',
                env: {
                    ...process.env,
                    AWS_REGION: profile.awsRegion,
                    CDK_DEFAULT_REGION: profile.awsRegion,
                    CDK_DEFAULT_ACCOUNT: profile.accountId,
                    ...(profile.awsProfile ? { AWS_PROFILE: profile.awsProfile } : {}),
                },
            });
        } catch (err) {
            throw new Error(`CDK destroy failed for ${this.name}: ${err.message}`);
        }

        console.log(`  ✅ ${this.name} module destroyed`);
    }

    /**
     * Show what `cdk deploy` WOULD change for this module, without applying.
     * Runs `cdk diff` and streams the output. Used by `bootstrap update --dry-run`.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @returns {Promise<void>}
     */
    async diff(profile) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);
        console.log(`  🔍 Diffing ${this.name} module (${stackName})...`);

        // Use the SAME adopt flags the real deploy would use, so the diff
        // reflects reality (e.g. an adopted bucket shows as a reference, not a
        // spurious [+] AWS::S3::Bucket create).
        const adoptFlags = this._computeAdoptFlags(profile, { verbose: false });

        const cdkCmd = [
            'npx cdk diff', stackName,
            `--context module=${this.stackNameSuffix}`,
            `--context profileName=${profile.profileName}`,
            `--context accountId=${profile.accountId}`,
            `--context region=${profile.awsRegion}`,
            ...adoptFlags,
        ].join(' ');

        try {
            execSync(cdkCmd, {
                cwd: MODULES_ROOT,
                encoding: 'utf8',
                stdio: 'inherit',
                env: {
                    ...process.env,
                    AWS_REGION: profile.awsRegion,
                    CDK_DEFAULT_REGION: profile.awsRegion,
                    CDK_DEFAULT_ACCOUNT: profile.accountId,
                    ...(profile.awsProfile ? { AWS_PROFILE: profile.awsProfile } : {}),
                },
            });
        } catch (err) {
            // `cdk diff` exits non-zero when there ARE differences — that's not
            // an error for our purposes. Only surface real failures.
            // (exit code 1 = diffs present; we let the streamed output speak.)
        }
    }

    /**
     * Check the current status of this module's stack.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @returns {Promise<object>} { state, stackName?, resources, lastUpdated? }
     */
    async status(profile) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);

        try {
            const result = execSync(
                `aws cloudformation describe-stacks --stack-name ${stackName} --region ${profile.awsRegion} --output json` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );

            const parsed = JSON.parse(result);
            const stack = parsed.Stacks && parsed.Stacks[0];

            if (!stack) {
                return { state: 'not-provisioned', resources: [] };
            }

            const cfnStatus = stack.StackStatus;
            let state;

            if (cfnStatus.endsWith('_COMPLETE') && !cfnStatus.includes('DELETE') && !cfnStatus.includes('ROLLBACK')) {
                state = 'provisioned';
            } else if (cfnStatus.includes('IN_PROGRESS')) {
                state = 'updating';
            } else if (cfnStatus.includes('ROLLBACK') || cfnStatus.includes('FAILED')) {
                state = 'failed';
            } else {
                state = 'not-provisioned';
            }

            const resources = (stack.Outputs || []).map((o) => `${o.OutputKey}=${o.OutputValue}`);

            return {
                state,
                stackName,
                resources,
                lastUpdated: stack.LastUpdatedTime || stack.CreationTime,
            };
        } catch (err) {
            // Stack doesn't exist
            return { state: 'not-provisioned', resources: [] };
        }
    }

    /**
     * Delete a stack that is in a state CloudFormation cannot update, so a
     * subsequent `cdk deploy` starts clean.
     *
     * Un-updatable states (must delete before re-deploy):
     *   ROLLBACK_COMPLETE, ROLLBACK_FAILED  — failed initial CREATE
     *   CREATE_FAILED                        — failed initial CREATE
     *   DELETE_FAILED                        — failed teardown, stuck
     *
     * Recoverable states (leave alone — cdk deploy can proceed):
     *   UPDATE_ROLLBACK_COMPLETE             — failed UPDATE, but stack is intact
     *   *_COMPLETE, *_IN_PROGRESS
     *
     * @param {string} stackName
     * @param {object} profile - { awsRegion, awsProfile? }
     * @returns {Promise<void>}
     */
    async _cleanupUnupdatableStack(stackName, profile) {
        const UNUPDATABLE = new Set([
            'ROLLBACK_COMPLETE',
            'ROLLBACK_FAILED',
            'CREATE_FAILED',
            'DELETE_FAILED',
        ]);

        let cfnStatus;
        try {
            const result = execSync(
                `aws cloudformation describe-stacks --stack-name ${stackName} --region ${profile.awsRegion} --output json` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            const parsed = JSON.parse(result);
            const stack = parsed.Stacks && parsed.Stacks[0];
            cfnStatus = stack && stack.StackStatus;
        } catch {
            // Stack doesn't exist — nothing to clean up.
            return;
        }

        if (!cfnStatus || !UNUPDATABLE.has(cfnStatus)) {
            return; // Healthy, in-progress, or recoverable — leave it.
        }

        console.log(`  🧹 Stack ${stackName} is in ${cfnStatus} (un-updatable) — deleting before redeploy...`);
        try {
            execSync(
                `aws cloudformation delete-stack --stack-name ${stackName} --region ${profile.awsRegion}` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            execSync(
                `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --region ${profile.awsRegion}` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log(`  ✅ Removed failed stack ${stackName} — proceeding with clean deploy`);
        } catch (err) {
            // Deletion failed (e.g. a retained resource blocking, or DELETE_FAILED
            // that won't clear). Surface an actionable message but don't hard-throw
            // here — let the subsequent cdk deploy produce the authoritative error.
            console.log(`  ⚠️  Could not auto-delete ${stackName}: ${err.message.split('\n')[0]}`);
            console.log(`     You may need to delete it manually in the CloudFormation console, then retry.`);
        }
    }

    /**
     * Check whether an S3 bucket already exists (and is owned by this account).
     * Used to decide whether a retained bucket must be adopted on re-provision.
     * @param {string} bucketName
     * @param {object} profile - { awsRegion, awsProfile? }
     * @returns {boolean} true if the bucket exists / is owned by the caller
     */
    _bucketExists(bucketName, profile) {
        try {
            execSync(
                `aws s3api head-bucket --bucket ${bucketName} --region ${profile.awsRegion}` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            return true;
        } catch (err) {
            // head-bucket exits non-zero for both "not found" (404) and
            // "exists but owned by someone else" (403). A 403 would still
            // collide on create, so treat it as existing too.
            const msg = (err.stderr || err.message || '').toString();
            if (msg.includes('403') || msg.includes('Forbidden')) return true;
            return false;
        }
    }

    /**
     * Check whether an ECR repository already exists (owned by this account).
     * Used to decide whether a retained repo must be adopted on re-provision.
     * @param {string} repoName
     * @param {object} profile - { awsRegion, awsProfile? }
     * @returns {boolean} true if the repository exists
     */
    _ecrRepoExists(repoName, profile) {
        try {
            execSync(
                `aws ecr describe-repositories --repository-names ${repoName} --region ${profile.awsRegion}` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            return true;
        } catch (err) {
            // describe-repositories exits non-zero (RepositoryNotFoundException)
            // when the repo doesn't exist. Any other error (e.g. access denied)
            // is treated as "not present" so provisioning attempts a normal create.
            return false;
        }
    }

    /**
     * Fetch stack outputs as a key-value map.
     * @param {string} stackName
     * @param {object} profile
     * @returns {Record<string, string>}
     */
    _getStackOutputs(stackName, profile) {
        try {
            const result = execSync(
                `aws cloudformation describe-stacks --stack-name ${stackName} --region ${profile.awsRegion} --query "Stacks[0].Outputs" --output json` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );

            const outputs = JSON.parse(result);
            const map = {};
            if (Array.isArray(outputs)) {
                for (const o of outputs) {
                    // CfnOutput logical IDs carry an 'Output' suffix (e.g.
                    // 'AdaptersBucketOutput'), but every consumer — the module
                    // manifest `exports` list and _denormalizeModuleOutputs —
                    // expects the bare export name ('AdaptersBucket'). Strip a
                    // trailing 'Output' so the persisted keys match. Keys that
                    // don't end in 'Output' (e.g. 'MlflowAppArn') pass through.
                    const key = o.OutputKey.replace(/Output$/, '');
                    map[key] = o.OutputValue;
                }
            }
            return map;
        } catch (err) {
            return {};
        }
    }
}

/**
 * Multi-stack module runner. Deploys an ordered list of CDK stacks with
 * SSM parameter chaining between stacks — outputs from stack N are passed
 * as CDK context to stack N+1.
 *
 * Used by the `hyperpod-cluster` module which internally deploys three stacks:
 *   1. eks-cluster  2. hyperpod-cluster  3. inference-operator
 */
class CdkMultiStackModuleRunner {
    /**
     * @param {string} name - Module name from manifest
     * @param {string[]} stacks - Ordered stack suffixes (e.g. ['eks-cluster','hyperpod-cluster','inference-operator'])
     */
    constructor(name, stacks) {
        this.name = name;
        this.stacks = stacks;
    }

    /**
     * Provision all stacks in order. SSM params from each completed stack are
     * read and passed as CDK context to the next stack.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @param {object} [opts] - { forceDeploy?: boolean }
     * @returns {Promise<Record<string, string>>} Merged outputs from all stacks
     */
    async provision(profile, opts = {}) {
        const allOutputs = {};

        for (let i = 0; i < this.stacks.length; i++) {
            const stackSuffix = this.stacks[i];
            const stackName = getStackName(profile.profileName, stackSuffix);

            console.log(`  📦 [${i + 1}/${this.stacks.length}] Stack: ${stackSuffix}`);

            // Create a single-stack runner for this stack
            const runner = new CdkModuleRunner(this.name, stackSuffix);

            // Read SSM params from prior stacks to pass as context
            const ssmContext = this._readSsmParamsForContext(profile);

            // Override provision to inject SSM context
            const outputs = await this._provisionStack(runner, stackSuffix, profile, opts, ssmContext);
            Object.assign(allOutputs, outputs);
        }

        console.log(`  ✅ All ${this.stacks.length} stacks deployed for ${this.name}`);
        return allOutputs;
    }

    /**
     * Provision a single stack with SSM context injected.
     */
    async _provisionStack(runner, stackSuffix, profile, opts, ssmContext) {
        const stackName = getStackName(profile.profileName, stackSuffix);

        // Cleanup un-updatable stacks first
        await runner._cleanupUnupdatableStack(stackName, profile);

        // Idempotency short-circuit
        if (!opts.forceDeploy) {
            const currentStatus = await runner.status(profile);
            if (currentStatus.state === 'provisioned') {
                console.log(`    ✅ ${stackSuffix} already provisioned (${stackName})`);
                return runner._getStackOutputs(stackName, profile);
            }
        }

        console.log(`    ${opts.forceDeploy ? '🔄 Updating' : '🚀 Deploying'} ${stackSuffix} (${stackName})...`);

        // Build adopt flags for this specific stack
        const adoptFlags = runner._computeAdoptFlags(profile, { verbose: true });

        // Add SSM context flags
        const contextFlags = Object.entries(ssmContext).map(
            ([key, value]) => `--context ${key}=${value}`
        );

        const cdkCmd = [
            'npx cdk deploy', stackName,
            '--require-approval never',
            `--context module=${stackSuffix}`,
            `--context profileName=${profile.profileName}`,
            `--context accountId=${profile.accountId}`,
            `--context region=${profile.awsRegion}`,
            ...adoptFlags,
            ...contextFlags,
        ].filter(Boolean).join(' ');

        try {
            execSync(cdkCmd, {
                cwd: MODULES_ROOT,
                encoding: 'utf8',
                stdio: 'inherit',
                env: {
                    ...process.env,
                    AWS_REGION: profile.awsRegion,
                    CDK_DEFAULT_REGION: profile.awsRegion,
                    CDK_DEFAULT_ACCOUNT: profile.accountId,
                    ...(profile.awsProfile ? { AWS_PROFILE: profile.awsProfile } : {}),
                },
            });
        } catch (err) {
            throw new Error(`CDK deploy failed for ${this.name}/${stackSuffix}: ${err.message}`);
        }

        console.log(`    ✅ ${stackSuffix} deployed`);
        return runner._getStackOutputs(stackName, profile);
    }

    /**
     * Read SSM params exported by previously deployed stacks and return as
     * key-value context map for the next stack.
     * @param {object} profile
     * @returns {Record<string, string>}
     */
    _readSsmParamsForContext(profile) {
        const ssmPrefix = `/mlcc/${profile.profileName}/hyperpod`;
        const context = {};

        const paramKeys = [
            'EksClusterArn',
            'EksClusterName',
            'ClusterSecurityGroupId',
            'PrivateSubnetIds',
            'HyperPodInstanceRoleArn',
            'HyperPodClusterArn',
            'HyperPodClusterName',
            'HyperpodInferenceRoleArn',
            'AlbControllerRoleArn',
            'KedaOperatorRoleArn',
            'S3CsiRoleArn',
            'FsxCsiRoleArn',
        ];

        for (const key of paramKeys) {
            try {
                const result = execSync(
                    `aws ssm get-parameter --name ${ssmPrefix}/${key} --region ${profile.awsRegion} --query "Parameter.Value" --output text` +
                    (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                const value = result.trim();
                if (value && value !== 'None') {
                    context[key] = value;
                }
            } catch {
                // Param doesn't exist yet — skip (prior stack hasn't run)
            }
        }

        return context;
    }

    /**
     * Tear down all stacks in reverse order.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @param {object} [opts] - { forceDelete?: boolean }
     */
    async teardown(profile, opts = {}) {
        const reversed = [...this.stacks].reverse();

        console.log(`  🗑️  Destroying ${this.name} module (${this.stacks.length} stacks, reverse order)...`);

        for (let i = 0; i < reversed.length; i++) {
            const stackSuffix = reversed[i];
            const stackName = getStackName(profile.profileName, stackSuffix);

            console.log(`    [${i + 1}/${reversed.length}] Destroying ${stackSuffix} (${stackName})...`);

            const cdkCmd = [
                'npx cdk destroy', stackName,
                '--force',
                `--context module=${stackSuffix}`,
                `--context profileName=${profile.profileName}`,
                `--context accountId=${profile.accountId}`,
                `--context region=${profile.awsRegion}`,
            ].join(' ');

            try {
                execSync(cdkCmd, {
                    cwd: MODULES_ROOT,
                    encoding: 'utf8',
                    stdio: 'inherit',
                    env: {
                        ...process.env,
                        AWS_REGION: profile.awsRegion,
                        CDK_DEFAULT_REGION: profile.awsRegion,
                        CDK_DEFAULT_ACCOUNT: profile.accountId,
                        ...(profile.awsProfile ? { AWS_PROFILE: profile.awsProfile } : {}),
                    },
                });
                console.log(`    ✅ ${stackSuffix} destroyed`);
            } catch (err) {
                throw new Error(`CDK destroy failed for ${this.name}/${stackSuffix}: ${err.message}`);
            }
        }

        // If --force-delete, also remove retained resources
        if (opts.forceDelete) {
            await this._forceDeleteRetainedResources(profile);
        }

        console.log(`  ✅ ${this.name} module destroyed`);
    }

    /**
     * Force-delete retained resources (IAM roles, HyperPod cluster, TLS bucket)
     * after CDK destroy. Called only with --force-delete flag.
     */
    async _forceDeleteRetainedResources(profile) {
        console.log('    🔥 Force-deleting retained resources...');

        const ssmPrefix = `/mlcc/${profile.profileName}/hyperpod`;
        const awsFlags = `--region ${profile.awsRegion}` +
            (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');

        // Delete HyperPod cluster
        try {
            const clusterName = execSync(
                `aws ssm get-parameter --name ${ssmPrefix}/HyperPodClusterName --query "Parameter.Value" --output text ${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            if (clusterName && clusterName !== 'None') {
                console.log(`      Deleting HyperPod cluster: ${clusterName}...`);
                execSync(
                    `aws sagemaker delete-cluster --cluster-name ${clusterName} ${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            }
        } catch (err) {
            console.log(`      ⚠️  Could not delete HyperPod cluster: ${err.message.split('\n')[0]}`);
        }

        // Delete TLS bucket
        try {
            const bucketName = `hyperpod-tls-${profile.profileName}-${profile.awsRegion}`;
            console.log(`      Deleting TLS bucket: ${bucketName}...`);
            execSync(
                `aws s3 rb s3://${bucketName} --force ${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
        } catch (err) {
            console.log(`      ⚠️  Could not delete TLS bucket: ${err.message.split('\n')[0]}`);
        }

        // Delete IAM roles
        const roleNames = [
            `mlcc-${profile.profileName}-eks-cluster-role`,
            `mlcc-${profile.profileName}-eks-node-role`,
            `mlcc-${profile.profileName}-hyperpod-instance-role`,
            `mlcc-${profile.profileName}-hyperpod-inference-role`,
            `mlcc-${profile.profileName}-alb-controller-role`,
            `mlcc-${profile.profileName}-keda-operator-role`,
            `mlcc-${profile.profileName}-s3-csi-role`,
            `mlcc-${profile.profileName}-fsx-csi-role`,
        ];
        for (const roleName of roleNames) {
            try {
                // Detach managed policies first
                const policies = execSync(
                    `aws iam list-attached-role-policies --role-name ${roleName} --query "AttachedPolicies[].PolicyArn" --output text ${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                ).trim();
                for (const policyArn of policies.split(/\s+/).filter(Boolean)) {
                    execSync(
                        `aws iam detach-role-policy --role-name ${roleName} --policy-arn ${policyArn} ${awsFlags}`,
                        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                    );
                }
                // Delete inline policies
                const inlinePolicies = execSync(
                    `aws iam list-role-policies --role-name ${roleName} --query "PolicyNames[]" --output text ${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                ).trim();
                for (const policyName of inlinePolicies.split(/\s+/).filter(Boolean)) {
                    execSync(
                        `aws iam delete-role-policy --role-name ${roleName} --policy-name ${policyName} ${awsFlags}`,
                        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                    );
                }
                execSync(
                    `aws iam delete-role --role-name ${roleName} ${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch {
                // Role doesn't exist or already deleted — skip
            }
        }

        // Clean up SSM params
        for (const key of ['EksClusterArn', 'EksClusterName', 'ClusterSecurityGroupId',
            'PrivateSubnetIds', 'HyperPodInstanceRoleArn', 'HyperPodClusterArn',
            'HyperPodClusterName', 'HyperpodInferenceRoleArn', 'AlbControllerRoleArn',
            'KedaOperatorRoleArn', 'S3CsiRoleArn', 'FsxCsiRoleArn', 'InferenceOperatorStatus']) {
            try {
                execSync(
                    `aws ssm delete-parameter --name ${ssmPrefix}/${key} ${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch {
                // Param doesn't exist — skip
            }
        }

        console.log('    ✅ Retained resources deleted');
    }

    /**
     * Check status of all stacks and return aggregate.
     * @param {object} profile
     * @returns {Promise<object>} { state, stacks: [{stackSuffix, state, stackName}] }
     */
    async status(profile) {
        const stackStatuses = [];
        let aggregateState = 'provisioned';

        for (const stackSuffix of this.stacks) {
            const runner = new CdkModuleRunner(this.name, stackSuffix);
            const result = await runner.status(profile);
            stackStatuses.push({
                stackSuffix,
                stackName: getStackName(profile.profileName, stackSuffix),
                state: result.state,
                resources: result.resources,
                lastUpdated: result.lastUpdated,
            });

            if (result.state !== 'provisioned') {
                aggregateState = result.state;
            }
        }

        return {
            state: aggregateState,
            stacks: stackStatuses,
        };
    }

    /**
     * Run cdk diff for all stacks.
     * @param {object} profile
     */
    async diff(profile) {
        for (const stackSuffix of this.stacks) {
            const runner = new CdkModuleRunner(this.name, stackSuffix);
            await runner.diff(profile);
        }
    }
}

module.exports = { CdkModuleRunner, CdkMultiStackModuleRunner };
