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
            // Disable termination protection first — failed stacks may still
            // have it enabled (set by CDK's enableTerminationProtection option).
            execSync(
                `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name ${stackName} --region ${profile.awsRegion}` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
        } catch {
            // Termination protection may already be off, or stack doesn't support it — continue.
        }
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

        // Pre-flight: ensure the HyperPod service-linked role exists.
        // SageMaker needs this to manage VPC/subnet resources when creating
        // a HyperPod cluster. Without it, CreateCluster fails with
        // "Unable to retrieve subnets".
        this._ensureHyperPodServiceLinkedRole(profile);

        for (let i = 0; i < this.stacks.length; i++) {
            const stackSuffix = this.stacks[i];
            const stackName = getStackName(profile.profileName, stackSuffix);

            // After eks-cluster is deployed, install the HyperPod Helm chart
            // dependencies before creating the HyperPod cluster. SageMaker
            // validates that these components exist during CreateCluster.
            if (stackSuffix === 'hyperpod-cluster') {
                this._ensureEksOperatorAccess(profile);
                await this._ensureHyperPodHelmChart(profile, opts);
                this._ensureCdkExecRolePassRole(profile);
                this._ensureHyperPodInstanceRoleVpcAccess(profile);
            }

            // Before inference-operator, clear any blocking webhooks that aren't
            // yet served (ALB controller pods may still be scheduling on Fargate).
            if (stackSuffix === 'inference-operator') {
                this._clearBlockingWebhooks();
            }

            console.log(`  📦 [${i + 1}/${this.stacks.length}] Stack: ${stackSuffix}`);

            // Create a single-stack runner for this stack
            const runner = new CdkModuleRunner(this.name, stackSuffix);

            // Read SSM params from prior stacks to pass as context
            const ssmContext = this._readSsmParamsForContext(profile);

            // Override provision to inject SSM context
            const outputs = await this._provisionStack(runner, stackSuffix, profile, opts, ssmContext);
            Object.assign(allOutputs, outputs);
        }

        // Post-deploy: install inference operator addon via CLI (not CloudFormation)
        // to avoid CloudFormation timeout on the slow EnableClusterInference call.
        await this._installInferenceAddon(profile);

        console.log(`  ✅ All ${this.stacks.length} stacks deployed for ${this.name}`);
        return allOutputs;
    }

    /**
     * Ensure the SageMaker HyperPod service-linked role exists. This is
     * required before CreateCluster can work — SageMaker uses it to access
     * VPC/subnets. Idempotent: silently succeeds if the role already exists.
     * @param {object} profile
     */
    /**
     * Clear webhook configurations that block resource creation on a cluster
     * where webhook-serving pods haven't scheduled yet. These webhooks will be
     * recreated once the ALB/cert-manager pods are running on Fargate.
     */
    _clearBlockingWebhooks() {
        console.log('    Clearing blocking webhooks...');
        const webhooks = [
            'mutatingwebhookconfiguration/aws-load-balancer-webhook',
            'validatingwebhookconfiguration/aws-load-balancer-webhook',
            'mutatingwebhookconfiguration/cert-manager-webhook',
            'validatingwebhookconfiguration/cert-manager-webhook',
        ];
        for (const wh of webhooks) {
            try {
                execSync(`kubectl delete ${wh} --ignore-not-found`, {
                    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch {
                // kubectl not available or cluster not reachable — best effort
            }
        }
    }

    /**
     * Install the SageMaker HyperPod inference operator as an EKS addon via CLI.
     * Done outside CloudFormation because the addon's controller calls
     * EnableClusterInference (async SageMaker API) which can take 5-15+ minutes,
     * exceeding CloudFormation's health check timeout.
     * Idempotent: skips if addon already exists and is ACTIVE/DEGRADED.
     * @param {object} profile
     */
    async _installInferenceAddon(profile) {
        const awsFlags = (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');
        const eksClusterName = `mlcc-${profile.profileName}-eks`;

        // Check if addon already exists
        try {
            const result = execSync(
                `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-inference --region ${profile.awsRegion}${awsFlags} --query "addon.status" --output text`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            const status = result.trim();
            if (status === 'ACTIVE' || status === 'DEGRADED') {
                console.log(`  ✅ Inference operator addon already installed (${status})`);
                return;
            }
            // If CREATE_FAILED, delete and recreate
            if (status === 'CREATE_FAILED') {
                console.log('  ♻️  Inference addon in CREATE_FAILED state — deleting for reinstall...');
                execSync(
                    `aws eks delete-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-inference --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                // Wait a bit for deletion
                execSync('sleep 30', { stdio: 'pipe' });
            }
        } catch {
            // Addon doesn't exist — proceed with creation
        }

        // Read context values for addon config
        const ssmPrefix = `/mlcc/${profile.profileName}/hyperpod`;
        const getParam = (key) => {
            try {
                return execSync(
                    `aws ssm get-parameter --name ${ssmPrefix}/${key} --region ${profile.awsRegion}${awsFlags} --query "Parameter.Value" --output text`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                ).trim();
            } catch { return ''; }
        };

        const hyperpodClusterArn = getParam('HyperPodClusterArn')
            || this._readSsmParamsForContext?.(profile)?.HyperPodClusterArn || '';
        const hyperpodInferenceRoleArn = getParam('HyperpodInferenceRoleArn') || '';
        const albControllerRoleArn = getParam('AlbControllerRoleArn') || '';
        const kedaOperatorRoleArn = getParam('KedaOperatorRoleArn') || '';
        const tlsBucketName = `mlcc-hyperpod-tls-${profile.profileName}`;

        if (!hyperpodClusterArn) {
            console.log('  ⚠️  Skipping inference addon — HyperPod cluster ARN not found');
            return;
        }

        const configValues = JSON.stringify({
            executionRoleArn: hyperpodInferenceRoleArn,
            tlsCertificateS3Bucket: tlsBucketName,
            hyperpodClusterArn: hyperpodClusterArn,
            alb: {
                serviceAccount: {
                    create: true,
                    roleArn: albControllerRoleArn,
                },
            },
            keda: {
                auth: {
                    aws: {
                        irsa: {
                            roleArn: kedaOperatorRoleArn,
                        },
                    },
                },
            },
        });

        console.log('  📦 Installing inference operator addon...');
        try {
            execSync(
                `aws eks create-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-inference --configuration-values '${configValues.replace(/'/g, "'\\''")}' --resolve-conflicts OVERWRITE --region ${profile.awsRegion}${awsFlags}`,
                { encoding: 'utf8', stdio: 'inherit' }
            );
        } catch (err) {
            console.log(`  ⚠️  Inference addon creation command failed: ${err.message.split('\n')[0]}`);
            console.log('      The addon may still be initializing. Check status with:');
            console.log(`      aws eks describe-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-inference --region ${profile.awsRegion}`);
            return;
        }

        // Poll for addon to become ACTIVE (up to 10 min)
        console.log('  ⏳ Waiting for inference operator to become active (up to 10 min)...');
        const startTime = Date.now();
        const timeout = 600000; // 10 minutes
        while (Date.now() - startTime < timeout) {
            try {
                const result = execSync(
                    `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-inference --region ${profile.awsRegion}${awsFlags} --query "addon.status" --output text`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                const status = result.trim();
                if (status === 'ACTIVE') {
                    console.log('  ✅ Inference operator addon is ACTIVE');
                    return;
                }
                if (status === 'CREATE_FAILED') {
                    console.log(`  ⚠️  Inference operator addon failed. Check pods in hyperpod-inference-system namespace.`);
                    return;
                }
                // CREATING or DEGRADED — keep waiting
            } catch {
                // describe failed — keep trying
            }
            execSync('sleep 30', { stdio: 'pipe' });
        }
        console.log('  ⚠️  Inference operator addon did not reach ACTIVE within 10 minutes.');
        console.log('      It may still be initializing. This is non-blocking for basic deploys.');
    }

    _ensureHyperPodServiceLinkedRole(profile) {
        try {
            execSync(
                `aws iam create-service-linked-role --aws-service-name hyperpod.sagemaker.amazonaws.com` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log('  ✅ Created SageMaker HyperPod service-linked role');
        } catch {
            // Already exists — expected on subsequent deploys.
        }
    }

    /**
     * Install the HyperPod Helm chart on the EKS cluster. This chart bundles
     * device plugins (NVIDIA, Neuron, EFA), health monitoring, Kubeflow Training
     * Operator, deep health check RBAC, and job-auto-restart — all required
     * before SageMaker will accept a CreateCluster call.
     *
     * Idempotent: uses `helm upgrade --install` so re-runs are safe.
     * Skipped entirely when adoptEks=true (existing cluster already has the chart).
     * @param {object} profile
     * @param {object} [opts] - { adoptEks?: boolean }
     */
    async _ensureHyperPodHelmChart(profile, opts = {}) {
        if (opts.adoptEks) {
            console.log('  ⏭️  Skipping HyperPod Helm chart install (adoptEks=true — existing cluster)');
            return;
        }
        const ssmPrefix = `/mlcc/${profile.profileName}/hyperpod`;
        const awsFlags = (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');

        // Get EKS cluster name from SSM
        let eksClusterName;
        try {
            eksClusterName = execSync(
                `aws ssm get-parameter --name ${ssmPrefix}/EksClusterName --region ${profile.awsRegion} --query "Parameter.Value" --output text${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
        } catch {
            console.log('  ⚠️  Could not read EKS cluster name from SSM — skipping Helm chart install');
            return;
        }

        // Check if the release already exists
        try {
            const helmStatus = execSync(
                `helm status hyperpod-dependencies --namespace kube-system --output json 2>/dev/null`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            const status = JSON.parse(helmStatus);
            if (status.info && status.info.status === 'deployed') {
                console.log('  ✅ HyperPod Helm chart already installed');
                return;
            }
            console.log(`  ⚠️  HyperPod Helm chart in state "${status.info?.status}" — reinstalling`);
        } catch {
            // Not installed — proceed
        }

        console.log('  📦 Installing HyperPod Helm chart dependencies...');

        // Update kubeconfig for the EKS cluster
        try {
            execSync(
                `aws eks update-kubeconfig --name ${eksClusterName} --region ${profile.awsRegion}${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
        } catch (err) {
            console.log(`  ⚠️  Could not update kubeconfig: ${err.message.split('\n')[0]}`);
            throw new Error('Failed to configure kubectl for EKS cluster — cannot install HyperPod Helm chart');
        }

        // Ensure the caller has EKS cluster access (CDK's creation role is the
        // only default admin). Without this, helm/kubectl will fail with auth errors.
        try {
            const callerArn = execSync(
                `aws sts get-caller-identity --query "Arn" --output text${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            // Extract the role ARN from the assumed-role ARN
            // arn:aws:sts::123:assumed-role/RoleName/session → arn:aws:iam::123:role/RoleName
            const assumedMatch = callerArn.match(/arn:aws:sts::(\d+):assumed-role\/([^/]+)\//);
            if (assumedMatch) {
                const roleArn = `arn:aws:iam::${assumedMatch[1]}:role/${assumedMatch[2]}`;
                execSync(
                    `aws eks create-access-entry --cluster-name ${eksClusterName} --principal-arn ${roleArn} --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                execSync(
                    `aws eks associate-access-policy --cluster-name ${eksClusterName} --principal-arn ${roleArn} --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                console.log(`    ✅ Granted EKS cluster admin access to ${assumedMatch[2]}`);
            }
        } catch {
            // Access entry may already exist — that's fine
        }

        // Ensure lifecycle script exists in S3 (required by HyperPod CreateCluster).
        // Uses the core models bucket which must already be provisioned.
        const lifecycleBucket = `mlcc-models-${profile.accountId}-${profile.awsRegion}`;
        const lifecycleKey = 'hyperpod-lifecycle/on_create.sh';
        try {
            execSync(
                `aws s3api head-object --bucket ${lifecycleBucket} --key ${lifecycleKey} --region ${profile.awsRegion}${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
        } catch {
            // Script doesn't exist — upload a minimal no-op
            console.log('    Uploading HyperPod lifecycle script to S3...');
            execSync(
                `printf '#!/bin/bash\\necho "HyperPod lifecycle: on_create complete"\\nexit 0' | aws s3 cp - s3://${lifecycleBucket}/${lifecycleKey} --region ${profile.awsRegion}${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
        }

        // Clone the HyperPod CLI repo (if not already cached) and install the chart
        const tmpDir = path.join(MODULES_ROOT, '.hyperpod-helm-cache');
        const chartDir = path.join(tmpDir, 'sagemaker-hyperpod-cli', 'helm_chart', 'HyperPodHelmChart');

        if (!require('fs').existsSync(chartDir)) {
            console.log('    Cloning sagemaker-hyperpod-cli for Helm chart...');
            require('fs').mkdirSync(tmpDir, { recursive: true });
            execSync(
                `git clone --depth 1 https://github.com/aws/sagemaker-hyperpod-cli.git`,
                { cwd: tmpDir, encoding: 'utf8', stdio: 'inherit' }
            );
        }

        // Update Helm dependencies and install
        try {
            execSync('helm dependencies update .', {
                cwd: chartDir, encoding: 'utf8', stdio: 'inherit',
            });

            // Remove any webhook configurations that may block Helm install.
            // On a fresh cluster with Fargate, webhook-serving pods (ALB controller,
            // cert-manager) may not be running yet. These webhooks will be recreated
            // once the pods schedule on Fargate.
            console.log('    Clearing blocking webhooks before Helm install...');
            this._clearBlockingWebhooks();

            execSync('helm upgrade --install hyperpod-dependencies . --namespace kube-system --create-namespace', {
                cwd: chartDir, encoding: 'utf8', stdio: 'inherit',
            });
            console.log('  ✅ HyperPod Helm chart installed');
        } catch (err) {
            throw new Error(`Failed to install HyperPod Helm chart: ${err.message.split('\n')[0]}`);
        }
    }

    /**
     * Ensure the CDK CloudFormation execution role has iam:PassRole permission
     * to pass mlcc-* roles to sagemaker.amazonaws.com. CloudFormation uses the
     * cfn-exec role (not the operator role) when making API calls during stack
     * deployment — without this, CreateCluster fails with "Unable to retrieve
     * subnets" despite the operator role having correct PassRole permissions.
     * Idempotent: PutRolePolicy is safe to call multiple times.
     */
    _ensureCdkExecRolePassRole(profile) {
        const awsFlags = profile.awsProfile ? ` --profile ${profile.awsProfile}` : '';
        const region = profile.awsRegion || 'us-east-1';
        const accountId = profile.accountId;

        if (!accountId) {
            console.log('  ⚠️  No accountId in profile — skipping cfn-exec PassRole patch');
            return;
        }

        const roleName = `cdk-hnb659fds-cfn-exec-role-${accountId}-${region}`;
        const policyDoc = JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
                Sid: 'MlccHyperPodPassRole',
                Effect: 'Allow',
                Action: 'iam:PassRole',
                Resource: `arn:aws:iam::${accountId}:role/mlcc-*`,
                Condition: {
                    StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' }
                }
            }]
        });

        try {
            execSync(
                `aws iam put-role-policy --role-name ${roleName} --policy-name MlccHyperPodPassRole --policy-document '${policyDoc}'${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log(`  ✅ CDK cfn-exec role PassRole policy applied`);
        } catch (err) {
            console.log(`  ⚠️  Could not patch cfn-exec role PassRole: ${err.message?.split('\n')[0] || err}`);
            console.log('     If CreateCluster fails with "Unable to retrieve subnets", run manually:');
            console.log(`     aws iam put-role-policy --role-name ${roleName} --policy-name MlccHyperPodPassRole --policy-document '<json>'`);
        }
    }

    /**
     * Ensure the HyperPod instance role has the VPC subnet access policy that
     * SageMaker requires when validating VpcConfig during CreateCluster.
     * AmazonSageMakerClusterInstanceRolePolicy alone does NOT include these EC2
     * permissions — they must be added as an inline policy. This is idempotent.
     */
    _ensureHyperPodInstanceRoleVpcAccess(profile) {
        const awsFlags = profile.awsProfile ? ` --profile ${profile.awsProfile}` : '';
        const roleName = `mlcc-${profile.profileName}-hyperpod-instance-role`;
        const policyDoc = JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
                Sid: 'VpcSubnetAccess',
                Effect: 'Allow',
                Action: [
                    'ec2:DescribeSubnets',
                    'ec2:DescribeVpcs',
                    'ec2:DescribeSecurityGroups',
                    'ec2:DescribeNetworkInterfaces',
                    'ec2:CreateNetworkInterface',
                    'ec2:DeleteNetworkInterface',
                    'ec2:DescribeNetworkInterfaceAttribute'
                ],
                Resource: '*'
            }]
        });

        try {
            execSync(
                `aws iam put-role-policy --role-name ${roleName} --policy-name VpcSubnetAccess --policy-document '${policyDoc}'${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log(`  ✅ HyperPod instance role VPC access policy applied`);
        } catch (err) {
            console.log(`  ⚠️  Could not apply VPC access policy to ${roleName}: ${err.message?.split('\n')[0] || err}`);
        }
    }

    /**
     * Grant the current AWS caller (operator) cluster-admin access to the EKS
     * cluster so kubectl works without manual console steps. Uses EKS access
     * entries (works with API_AND_CONFIG_MAP auth mode). Idempotent.
     */
    _ensureEksOperatorAccess(profile) {
        const awsFlags = profile.awsProfile ? ` --profile ${profile.awsProfile}` : '';
        const region = profile.awsRegion || 'us-east-1';
        const clusterName = `mlcc-${profile.profileName}-eks`;

        // Get the current caller ARN (the operator)
        let callerArn;
        try {
            const identity = JSON.parse(
                execSync(`aws sts get-caller-identity --output json${awsFlags}`, {
                    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
                })
            );
            // Convert assumed-role session ARN → role ARN for the access entry
            callerArn = identity.Arn.replace(
                /arn:aws:sts::(\d+):assumed-role\/(.+?)\/.+/,
                'arn:aws:iam::$1:role/$2'
            );
        } catch {
            console.log('  ⚠️  Could not determine caller identity — skipping EKS access entry');
            return;
        }

        const createCmd = `aws eks create-access-entry --cluster-name ${clusterName} --principal-arn ${callerArn} --region ${region}${awsFlags}`;
        const assocCmd = `aws eks associate-access-policy --cluster-name ${clusterName} --principal-arn ${callerArn} --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster --region ${region}${awsFlags}`;

        try {
            execSync(createCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            // Already exists — that's fine
            if (!e.stderr?.includes('already exists') && !e.message?.includes('already exists')) {
                console.log(`  ⚠️  Could not create EKS access entry: ${e.message?.split('\n')[0]}`);
            }
        }
        try {
            execSync(assocCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            console.log(`  ✅ EKS cluster-admin access granted to ${callerArn}`);
        } catch (e) {
            console.log(`  ⚠️  Could not associate EKS admin policy: ${e.message?.split('\n')[0]}`);
        }
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

        // Detect retained IAM roles that already exist (from a prior
        // deploy whose stack was destroyed but roles were RETAIN'd).
        const roleAdoptFlag = this._detectRetainedRoles(stackSuffix, profile);

        // Detect retained TLS bucket for inference-operator stack
        const tlsBucketAdoptFlag = this._detectRetainedTlsBucket(stackSuffix, profile);

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
            ...roleAdoptFlag,
            ...tlsBucketAdoptFlag,
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
     * Detect whether retained IAM roles from a prior deployment already exist.
     * If any of the stack's RETAIN'd roles exist, returns ['--context adoptRoles=true']
     * so the CDK stack uses fromRoleName() instead of creating new ones.
     * @param {string} stackSuffix
     * @param {object} profile
     * @returns {string[]} context flag array (empty if no roles found)
     */
    _detectRetainedRoles(stackSuffix, profile) {
        // Only the eks-cluster stack creates the RETAIN'd roles
        if (stackSuffix !== 'eks-cluster') return [];

        const roleNames = [
            `mlcc-${profile.profileName}-eks-cluster-role`,
            `mlcc-${profile.profileName}-eks-node-role`,
            `mlcc-${profile.profileName}-hyperpod-instance-role`,
            `mlcc-${profile.profileName}-hyperpod-inference-role`,
            `mlcc-${profile.profileName}-alb-controller-role`,
            `mlcc-${profile.profileName}-keda-operator-role`,
            `mlcc-${profile.profileName}-s3-csi-role`,
            `mlcc-${profile.profileName}-fsx-csi-role`,
            `mlcc-${profile.profileName}-fargate-pod-exec-role`,
        ];

        for (const roleName of roleNames) {
            if (this._iamRoleExists(roleName, profile)) {
                console.log(`  ♻️  Existing IAM roles detected (${roleName}) — adopting instead of recreating`);
                return ['--context adoptRoles=true'];
            }
        }
        return [];
    }

    /**
     * Check whether an IAM role already exists in the account.
     * @param {string} roleName
     * @param {object} profile - { awsRegion, awsProfile? }
     * @returns {boolean}
     */
    _iamRoleExists(roleName, profile) {
        try {
            execSync(
                `aws iam get-role --role-name ${roleName}` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Detect whether the inference-operator's TLS bucket already exists
     * (RETAIN'd from a prior deploy). Returns context flag if found.
     * @param {string} stackSuffix
     * @param {object} profile
     * @returns {string[]}
     */
    _detectRetainedTlsBucket(stackSuffix, profile) {
        if (stackSuffix !== 'inference-operator') return [];

        const bucketName = `mlcc-hyperpod-tls-${profile.profileName}`;
        try {
            execSync(
                `aws s3api head-bucket --bucket ${bucketName} --region ${profile.awsRegion}` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log(`  ♻️  Existing TLS bucket detected (${bucketName}) — adopting instead of recreating`);
            return ['--context adoptTlsBucket=true'];
        } catch {
            return [];
        }
    }

    /**

    /**
     * Delete all Fargate profiles from the EKS cluster. EKS won't allow
     * cluster deletion while profiles exist. Waits for each deletion to complete.
     * @param {object} profile
     */
    _deleteAllFargateProfiles(profile) {
        const awsFlags = (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');
        const eksClusterName = `mlcc-${profile.profileName}-eks`;

        let profiles;
        try {
            const result = execSync(
                `aws eks list-fargate-profiles --cluster-name ${eksClusterName} --region ${profile.awsRegion}${awsFlags} --query "fargateProfileNames" --output json`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            profiles = JSON.parse(result);
        } catch {
            return; // Cluster doesn't exist or no profiles
        }

        if (!profiles || profiles.length === 0) return;

        for (const fpName of profiles) {
            console.log(`      Deleting Fargate profile: ${fpName}...`);
            try {
                execSync(
                    `aws eks delete-fargate-profile --cluster-name ${eksClusterName} --fargate-profile-name ${fpName} --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
                execSync(
                    `aws eks wait fargate-profile-deleted --cluster-name ${eksClusterName} --fargate-profile-name ${fpName} --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch (err) {
                console.log(`      ⚠️  Could not delete Fargate profile ${fpName}: ${err.message.split('\n')[0]}`);
            }
        }
        console.log('      ✅ Fargate profiles deleted');
    }

    /**
     * Detach the ALB controller managed policy from its IRSA role before stack
     * deletion. The role uses RemovalPolicy.RETAIN so it persists, but CDK needs
     * to delete the policy resource — which fails if it's still attached.
     * @param {object} profile
     */
    _detachAlbPolicy(profile) {
        const awsFlags = (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');
        const roleName = `mlcc-${profile.profileName}-alb-controller-role`;
        const policyName = `mlcc-${profile.profileName}-alb-controller-policy`;
        const accountId = profile.accountId;
        const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

        try {
            execSync(
                `aws iam detach-role-policy --role-name ${roleName} --policy-arn ${policyArn} --region ${profile.awsRegion}${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log(`      ✅ Detached ALB policy from ${roleName}`);
        } catch {
            // Role or policy doesn't exist, or already detached — fine
        }
    }

    /**
     * Delete orphaned ENIs in the VPC's private subnets. HyperPod leaves behind
     * ENIs from failed node scaling attempts. These block subnet deletion.
     * @param {object} profile
     */
    _cleanupOrphanedENIs(profile) {
        const awsFlags = (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');
        const vpcName = `mlcc-${profile.profileName}-eks`;

        // Discover VPC ID from SSM or by tag
        let vpcId;
        try {
            const result = execSync(
                `aws ec2 describe-vpcs --filters "Name=tag:Name,Values=*${profile.profileName}*" --region ${profile.awsRegion}${awsFlags} --query "Vpcs[0].VpcId" --output text`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            vpcId = result.trim();
            if (!vpcId || vpcId === 'None') return;
        } catch {
            return;
        }

        // Find all ENIs in the VPC that are available (not attached)
        let eniIds;
        try {
            const result = execSync(
                `aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=${vpcId}" "Name=status,Values=available" --region ${profile.awsRegion}${awsFlags} --query "NetworkInterfaces[].NetworkInterfaceId" --output json`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            eniIds = JSON.parse(result);
        } catch {
            return;
        }

        if (!eniIds || eniIds.length === 0) return;

        console.log(`      Cleaning ${eniIds.length} orphaned ENI(s)...`);
        for (const eniId of eniIds) {
            try {
                execSync(
                    `aws ec2 delete-network-interface --network-interface-id ${eniId} --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch {
                // May already be gone or in-use — skip
            }
        }
        console.log('      ✅ Orphaned ENIs cleaned');
    }

    /**
     * Delete NAT gateways in the VPC so subnets, route tables, and EIPs can be
     * freed. Waits for each NAT gateway to reach 'deleted' state.
     * @param {object} profile
     */
    _deleteNatGateways(profile) {
        const awsFlags = (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');

        // Discover VPC ID
        let vpcId;
        try {
            const result = execSync(
                `aws ec2 describe-vpcs --filters "Name=tag:Name,Values=*${profile.profileName}*" --region ${profile.awsRegion}${awsFlags} --query "Vpcs[0].VpcId" --output text`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            vpcId = result.trim();
            if (!vpcId || vpcId === 'None') return;
        } catch {
            return;
        }

        // Find NAT gateways in the VPC
        let natGateways;
        try {
            const result = execSync(
                `aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=${vpcId}" "Name=state,Values=available" --region ${profile.awsRegion}${awsFlags} --query "NatGateways[].NatGatewayId" --output json`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            natGateways = JSON.parse(result);
        } catch {
            return;
        }

        if (!natGateways || natGateways.length === 0) return;

        console.log(`      Deleting ${natGateways.length} NAT gateway(s)...`);
        for (const natId of natGateways) {
            try {
                execSync(
                    `aws ec2 delete-nat-gateway --nat-gateway-id ${natId} --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch (err) {
                console.log(`      ⚠️  Could not delete NAT gateway ${natId}: ${err.message.split('\n')[0]}`);
            }
        }

        // Wait for NAT gateways to finish deleting (they release ENIs/EIPs on deletion)
        console.log('      Waiting for NAT gateway deletion...');
        for (const natId of natGateways) {
            try {
                execSync(
                    `aws ec2 wait nat-gateway-available --nat-gateway-ids ${natId} --region ${profile.awsRegion}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 }
                );
            } catch {
                // Timeout or already deleted — continue
            }
        }
        console.log('      ✅ NAT gateways deleted');
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

            // Disable termination protection if enabled (eks-cluster stack has it)
            try {
                execSync(
                    `aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name ${stackName} --region ${profile.awsRegion}` +
                    (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch {
                // Stack doesn't exist or protection already off — fine
            }

            // EKS cluster can't be deleted while Fargate profiles exist.
            // Delete Fargate profiles before CDK destroy. CloudFormation may
            // also try to delete the profile (as a custom resource) — if it
            // fails with "not found", we retry with --retain-resources below.
            if (stackSuffix === 'eks-cluster') {
                this._deleteAllFargateProfiles(profile);
                // Detach ALB controller policy from its RETAIN'd role so CDK can delete the policy.
                this._detachAlbPolicy(profile);
                // Clean up orphaned ENIs in VPC subnets (left behind by HyperPod failed scaling attempts).
                this._cleanupOrphanedENIs(profile);
                // Delete NAT gateways so subnets and EIPs can be freed.
                this._deleteNatGateways(profile);
            }

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
                // If eks-cluster stack destroy fails (common with custom resources
                // already deleted), retry with CloudFormation delete-stack --retain
                if (stackSuffix === 'eks-cluster') {
                    console.log(`    ⚠️  CDK destroy failed — retrying with resource skip...`);
                    try {
                        // Get failed resources from the stack
                        const failedResources = execSync(
                            `aws cloudformation describe-stack-resources --stack-name ${stackName} --region ${profile.awsRegion}` +
                            (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '') +
                            ` --query "StackResources[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" --output json`,
                            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                        );
                        const resourcesToRetain = JSON.parse(failedResources);
                        if (resourcesToRetain.length > 0) {
                            const retainArgs = resourcesToRetain.map(r => `"${r}"`).join(' ');
                            execSync(
                                `aws cloudformation delete-stack --stack-name ${stackName} --retain-resources ${retainArgs} --region ${profile.awsRegion}` +
                                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                                { encoding: 'utf8', stdio: 'inherit' }
                            );
                            // Wait for deletion
                            execSync(
                                `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --region ${profile.awsRegion}` +
                                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                                { encoding: 'utf8', stdio: 'inherit', timeout: 300000 }
                            );
                            console.log(`    ✅ ${stackSuffix} destroyed (with retained resources)`);
                        } else {
                            throw err;
                        }
                    } catch (retryErr) {
                        throw new Error(`CDK destroy failed for ${this.name}/${stackSuffix}: ${err.message}`);
                    }
                } else {
                    throw new Error(`CDK destroy failed for ${this.name}/${stackSuffix}: ${err.message}`);
                }
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

        // HyperPod cluster is DESTROY'd with the stack (not retained),
        // so no manual cleanup needed here.

        // TLS bucket — RETAIN'd, skip deletion to avoid S3 DNS propagation issues.
        // The bucket is cheap to keep and avoids the 24-hour name reuse delay.
        // To truly remove it: `aws s3 rb s3://mlcc-hyperpod-tls-<profile> --force`

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
            `mlcc-${profile.profileName}-fargate-pod-exec-role`,
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
