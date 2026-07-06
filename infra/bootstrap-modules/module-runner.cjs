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
     * Provision this module's infrastructure. Idempotent.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @returns {Promise<Record<string, string>>} Stack outputs
     */
    async provision(profile) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);

        // Check if already provisioned (idempotent)
        const currentStatus = await this.status(profile);
        if (currentStatus.state === 'provisioned') {
            console.log(`  ✅ ${this.name} already provisioned (${stackName})`);
            return this._getStackOutputs(stackName, profile);
        }

        console.log(`  🚀 Deploying ${this.name} module (${stackName})...`);

        // If this module owns a retained S3 bucket that already exists (from a
        // prior teardown), tell the CDK app to adopt it rather than recreate it.
        const adoptFlags = [];
        const bucketName = retainedBucketFor(this.name, profile.accountId, profile.awsRegion);
        if (bucketName && this._bucketExists(bucketName, profile)) {
            console.log(`  ♻️  Existing bucket detected (${bucketName}) — adopting instead of recreating`);
            adoptFlags.push('--context adoptExistingBuckets=true');
        }

        // Same for a retained ECR repository (core module).
        const ecrRepo = retainedEcrRepoFor(this.name);
        if (ecrRepo && this._ecrRepoExists(ecrRepo, profile)) {
            console.log(`  ♻️  Existing ECR repo detected (${ecrRepo}) — adopting instead of recreating`);
            adoptFlags.push('--context adoptExistingEcr=true');
        }

        const cdkCmd = [
            'npx cdk deploy', stackName,
            '--require-approval never',
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
                    map[o.OutputKey] = o.OutputValue;
                }
            }
            return map;
        } catch (err) {
            return {};
        }
    }
}

module.exports = { CdkModuleRunner };
