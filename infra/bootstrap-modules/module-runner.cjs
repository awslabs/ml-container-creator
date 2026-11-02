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

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { declaredBucketsForStack } = require('./bucket-declarations.cjs');

const MODULES_ROOT = path.resolve(__dirname);

/**
 * The RETAIN'd service roles the eks-cluster stack creates, and the trust principals +
 * AWS-managed policies each requires. CDK attaches these on the CREATE path, but when a
 * role is ADOPTED (imported) CDK CANNOT set its trust policy and CANNOT attach a managed
 * policy to it — so an adopted role freezes at whatever it had and drifts out of spec as
 * the stack evolves. The provision-time reconciler (_ensureAdoptedServiceRoles) re-asserts
 * trust + managed policies for ALL of these via the AWS CLI, which CDK cannot do for an
 * imported role.
 *
 * derive-dont-hardcode (ADR-008): each entry MUST mirror the trust principal(s) and
 * managed-policy array passed to the matching _createOrAdoptRole(...) call in
 * eks/stacks/eks-cluster-stack.ts. test/unit/hyperpod-cdk-stacks.test.js has a drift test
 * asserting the two agree for every role — update BOTH together or that test fails.
 *
 * The roleName is `mlcc-<profile>-<suffix>`. trustPrincipals is the FULL desired set
 * (the reconciler writes the whole trust document). managedPolicies is the FULL set
 * (attach is idempotent).
 */
const ADOPTED_SERVICE_ROLES = [
    {
        suffix: 'eks-cluster-role',
        trustPrincipals: ['eks.amazonaws.com'],
        managedPolicies: ['arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'],
    },
    {
        suffix: 'eks-node-role',
        trustPrincipals: ['ec2.amazonaws.com'],
        managedPolicies: [
            'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
            'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
            'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
        ],
    },
    {
        suffix: 'hyperpod-instance-role',
        trustPrincipals: ['sagemaker.amazonaws.com', 'ec2.amazonaws.com'],
        managedPolicies: [
            'arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy',
            'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
            'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
            'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
        ],
    },
    {
        suffix: 'fargate-pod-exec-role',
        trustPrincipals: ['eks-fargate-pods.amazonaws.com'],
        managedPolicies: ['arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy'],
    },
];

/**
 * The S3 buckets a stack declares (its buckets.json), with rendered physical names.
 * Replaces the former hand-copied retainedBucketFor / retainedAdaptersBucketFor /
 * TLS-bucket name maps: the declaration next to each stack is the ONE source
 * (ADR-008; bucket consolidation R1.2).
 * @param {string} stackNameSuffix
 * @param {object} profile - { accountId, awsRegion, profileName }
 * @returns {Array<object>} [{ logicalId, name, adoptContext, ... }]
 */
function declaredBucketsFor(stackNameSuffix, profile) {
    return declaredBucketsForStack(stackNameSuffix, {
        account: profile.accountId,
        region: profile.awsRegion,
        profileName: profile.profileName
    });
}

/**
 * Decide, per declared bucket, whether the stack must adopt it by reference.
 * Adopt ONLY when the bucket exists AND is not already a resource of this stack.
 * A bucket the stack already owns is always kept as a resource — adopting it by
 * reference would drop it from the template and CloudFormation would orphan it
 * (DELETE_SKIPPED) on the next update (bucket consolidation R1.1, report F1).
 * Pure: the caller supplies the existence and ownership facts.
 * @param {Array<object>} declared - from declaredBucketsFor()
 * @param {Set<string>} ownedNames - physical IDs of AWS::S3::Bucket resources in the stack
 * @param {(name: string) => boolean} exists
 * @returns {Array<{bucket: object, decision: 'owned'|'adopt'|'create'}>}
 */
function planBucketAdoption(declared, ownedNames, exists) {
    return declared.map((bucket) => {
        if (ownedNames.has(bucket.name)) return { bucket, decision: 'owned' };
        if (exists(bucket.name)) return { bucket, decision: 'adopt' };
        return { bucket, decision: 'create' };
    });
}

/**
 * Locate a declared bucket's logical ID in a synthesized CDK template: by the
 * aws:cdk:path metadata (`<stack>/<constructId>/Resource`), else by BucketName.
 * @returns {string|undefined}
 */
function findBucketLogicalId(template, stackName, bucket) {
    const resources = (template && template.Resources) || {};
    const wantedPath = `${stackName}/${bucket.logicalId}/Resource`;
    for (const [logicalId, res] of Object.entries(resources)) {
        if (!res || res.Type !== 'AWS::S3::Bucket') continue;
        if (res.Metadata && res.Metadata['aws:cdk:path'] === wantedPath) return logicalId;
    }
    for (const [logicalId, res] of Object.entries(resources)) {
        if (!res || res.Type !== 'AWS::S3::Bucket') continue;
        if (res.Properties && res.Properties.BucketName === bucket.name) return logicalId;
    }
    return undefined;
}

/**
 * Build the template + resources-to-import for a CloudFormation IMPORT change set
 * that contains ONLY the bucket import (R1.5; report risk R3). The template is the
 * DEPLOYED template verbatim plus one minimal AWS::S3::Bucket per imported bucket
 * (BucketName + Retain policies). Properties are deliberately minimal: import does
 * not reconcile properties, so the follow-up normal deploy must see a diff to apply
 * the configured versioning / encryption / public-access block / lifecycle / tags.
 * Pure.
 * @param {object} deployedTemplate - current stack template (parsed)
 * @param {Array<{logicalId: string, bucketName: string}>} imports
 * @returns {{ template: object, resourcesToImport: Array<object> }}
 */
function buildImportTemplate(deployedTemplate, imports) {
    const template = JSON.parse(JSON.stringify(deployedTemplate));
    template.Resources = template.Resources || {};
    const resourcesToImport = [];
    for (const { logicalId, bucketName } of imports) {
        if (template.Resources[logicalId]) {
            throw new Error(`Cannot import ${bucketName}: logical ID ${logicalId} already exists in the deployed template`);
        }
        template.Resources[logicalId] = {
            Type: 'AWS::S3::Bucket',
            DeletionPolicy: 'Retain',
            UpdateReplacePolicy: 'Retain',
            Properties: { BucketName: bucketName }
        };
        resourcesToImport.push({
            ResourceType: 'AWS::S3::Bucket',
            LogicalResourceId: logicalId,
            ResourceIdentifier: { BucketName: bucketName }
        });
    }
    return { template, resourcesToImport };
}

/**
 * Assert a described IMPORT change set contains exactly the expected bucket imports
 * and nothing else (no Add / Modify / Remove). Pure; throws on any extra change.
 * @param {object} changeSet - `describe-change-set` output
 * @param {string[]} expectedLogicalIds
 */
/**
 * The resources CloudFormation names when it rejects an IMPORT change set because the
 * template "modifies" resources that aren't being imported, e.g.
 *   "You have modified resources [BenchmarkResultsTable] in your template that are not
 *    being imported."
 * Seen live for an UNCHANGED AWS::Glue::Table: CloudFormation re-evaluates its
 * properties on any re-submitted template and reports them modified, which an IMPORT
 * change set forbids. Returns [] when the error is anything else. Pure.
 * @param {string} message
 * @returns {string[]}
 */
function modifiedResourcesFromImportError(message) {
    const m = /You have modified resources \[([^\]]*)\] in your template that are not being imported/.exec(String(message || ''));
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Guard for the fallback path (an UPDATE change set with --import-existing-resources):
 * it must import exactly the expected buckets, and every other change must be an
 * in-place Modify of a resource CloudFormation itself named as "modified" in the
 * rejected IMPORT attempt. No Add, no Remove, no replacement (Replacement 'True').
 * Pure; throws on anything else.
 * @param {object} changeSet - `describe-change-set` output
 * @param {string[]} expectedLogicalIds - bucket logical IDs to import
 * @param {string[]} allowedModify - logical IDs CloudFormation named in its error
 */
function assertImportWithInPlaceRefresh(changeSet, expectedLogicalIds, allowedModify) {
    const changes = (changeSet && changeSet.Changes) || [];
    const seen = [];
    const unexpected = [];
    for (const c of changes) {
        const rc = c.ResourceChange || {};
        if (rc.Action === 'Import' && rc.ResourceType === 'AWS::S3::Bucket' && expectedLogicalIds.includes(rc.LogicalResourceId)) {
            seen.push(rc.LogicalResourceId);
        } else if (rc.Action === 'Modify' && allowedModify.includes(rc.LogicalResourceId) && rc.Replacement !== 'True') {
            // in-place refresh of a resource CloudFormation reported as re-evaluated
        } else {
            unexpected.push(`${rc.Action || c.Type} ${rc.ResourceType || '?'} ${rc.LogicalResourceId || '?'}${rc.Replacement ? ` (replacement: ${rc.Replacement})` : ''}`);
        }
    }
    const missing = expectedLogicalIds.filter((id) => !seen.includes(id));
    if (unexpected.length > 0 || missing.length > 0) {
        const detail = [
            unexpected.length ? `Unexpected: ${unexpected.join('; ')}.` : '',
            missing.length ? `Missing imports: ${missing.join(', ')}.` : ''
        ].filter(Boolean).join(' ');
        throw new Error(`import change set contains more than the bucket import and an in-place refresh of ${allowedModify.join(', ')} — refusing to execute. ${detail}`);
    }
}

function assertImportOnlyChangeSet(changeSet, expectedLogicalIds) {
    const changes = (changeSet && changeSet.Changes) || [];
    const seen = [];
    const unexpected = [];
    for (const c of changes) {
        const rc = c.ResourceChange || {};
        if (rc.Action === 'Import' && rc.ResourceType === 'AWS::S3::Bucket' && expectedLogicalIds.includes(rc.LogicalResourceId)) {
            seen.push(rc.LogicalResourceId);
        } else {
            unexpected.push(`${rc.Action || c.Type} ${rc.ResourceType || '?'} ${rc.LogicalResourceId || '?'}`);
        }
    }
    const missing = expectedLogicalIds.filter((id) => !seen.includes(id));
    if (unexpected.length > 0 || missing.length > 0) {
        const detail = [
            unexpected.length ? `Unexpected: ${unexpected.join('; ')}.` : '',
            missing.length ? `Missing imports: ${missing.join(', ')}.` : ''
        ].filter(Boolean).join(' ');
        throw new Error(`IMPORT change set is not import-only — refusing to execute. ${detail}`);
    }
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
 * Build the exact `aws cloudformation continue-update-rollback` command string a user
 * can copy-paste to recover a wedged stack by hand. Centralized so the auto-recovery
 * path and the thrown error message always agree (BL143 Req 1.4).
 *
 * @param {string} stackName
 * @param {string} region
 * @param {string} [awsProfile]
 * @param {string[]} [resourcesToSkip] - logical IDs to pass to --resources-to-skip
 * @returns {string}
 */
function buildContinueRollbackCommand(stackName, region, awsProfile, resourcesToSkip) {
    let cmd = `aws cloudformation continue-update-rollback --stack-name ${stackName} --region ${region}`;
    if (resourcesToSkip && resourcesToSkip.length > 0) {
        cmd += ` --resources-to-skip ${resourcesToSkip.join(' ')}`;
    }
    if (awsProfile) {
        cmd += ` --profile ${awsProfile}`;
    }
    return cmd;
}

/**
 * Parse the logical resource IDs that CloudFormation reports as un-rollback-able from a
 * failed `continue-update-rollback` error. CFN phrasing varies; this matches the common
 * shapes without being brittle:
 *   "... resource(s) [LogicalIdA, LogicalIdB] ... cannot be rolled back"
 *   "The following resource(s) could not be ... : LogicalIdA, LogicalIdB"
 * Returns a de-duplicated list (possibly empty — the caller falls back to the exact
 * manual command when it cannot parse IDs).
 *
 * NOTE: the precise CFN error text is to be confirmed against a live wedged stack
 * (BL143 task A2); until then this is best-effort and the throw-exact-command fallback
 * (Req 1.4) guarantees the user always gets an actionable command.
 *
 * @param {string} errorText
 * @returns {string[]}
 */
function parseStuckResources(errorText) {
    if (!errorText || typeof errorText !== 'string') return [];
    const ids = new Set();

    // Shape 1: a bracketed list, e.g. "[LogicalIdA, LogicalIdB]".
    const bracket = errorText.match(/\[([^\]]+)\]/);
    if (bracket) {
        for (const tok of bracket[1].split(/[,\s]+/)) {
            if (/^[A-Za-z][A-Za-z0-9]*$/.test(tok)) ids.add(tok);
        }
    }

    // Shape 2: "resource(s) ... : Id1, Id2" after a colon near "resource". Take only the
    // leading COMMA-separated run of identifier-shaped tokens, so trailing prose
    // ("... failed to roll back") is not swept in. A token ends the run once it is not
    // followed by a comma AND is followed by more words (i.e. it's prose, not an id).
    if (ids.size === 0) {
        const colon = errorText.match(/resource[^:]*:\s*(.+)$/i);
        if (colon) {
            // Split on commas; each comma-separated segment's FIRST word is a candidate
            // id. Stop at the first segment whose first token isn't identifier-shaped.
            for (const seg of colon[1].split(',')) {
                const first = seg.trim().split(/\s+/)[0];
                if (/^[A-Za-z][A-Za-z0-9]*$/.test(first)) {
                    ids.add(first);
                } else {
                    break;
                }
            }
        }
    }

    return [...ids];
}

/**
 * Recover a stack stuck in UPDATE_ROLLBACK_FAILED (BL143 Group A).
 *
 * An UPDATE_ROLLBACK_FAILED stack is INTACT (a failed UPDATE) — it must NOT be deleted.
 * CloudFormation blocks all further updates until the rollback is continued. This runs
 * `continue-update-rollback`, re-checks status, retries ONCE with --resources-to-skip if
 * the first attempt names stuck resources, and — if still stuck — throws an Error whose
 * message is the EXACT manual recovery command (never a generic failure).
 *
 * Pure w.r.t. side effects: all AWS calls go through the injected `runCmd`, so this is
 * unit-testable offline (Req 1.6).
 *
 * @param {object} args
 * @param {string} args.stackName
 * @param {string} args.region
 * @param {string} [args.awsProfile]
 * @param {(argv: string[]) => string} args.runCmd - runs an aws CLI arg list, returns
 *   stdout; throws an Error (with .message/.stderr) on non-zero exit.
 * @param {(msg: string) => void} [args.log]
 * @returns {{ recovered: boolean, action: string }}
 * @throws {Error} with the exact manual recovery command when recovery fails.
 */
function recoverUpdateRollbackFailed({ stackName, region, awsProfile, runCmd, log = () => {} }) {
    const profileArgs = awsProfile ? ['--profile', awsProfile] : [];
    const describe = () => {
        try {
            const out = runCmd(['cloudformation', 'describe-stacks', '--stack-name', stackName,
                '--region', region, '--output', 'json', ...profileArgs]);
            const parsed = JSON.parse(out);
            return parsed.Stacks && parsed.Stacks[0] && parsed.Stacks[0].StackStatus;
        } catch {
            return undefined;
        }
    };
    // Recovered = stack is gone, or reached a terminal *_COMPLETE state (incl.
    // UPDATE_ROLLBACK_COMPLETE) rather than still sitting in UPDATE_ROLLBACK_FAILED.
    const isRecovered = (status) =>
        !status || (status.endsWith('_COMPLETE') && status !== 'UPDATE_ROLLBACK_FAILED');

    const attempt = (resourcesToSkip) => {
        const argv = ['cloudformation', 'continue-update-rollback', '--stack-name', stackName,
            '--region', region, ...profileArgs];
        if (resourcesToSkip && resourcesToSkip.length > 0) {
            argv.push('--resources-to-skip', ...resourcesToSkip);
        }
        return runCmd(argv);
    };

    log(`  🔧 Stack ${stackName} is in UPDATE_ROLLBACK_FAILED — attempting continue-update-rollback...`);

    // Attempt 1: bare continue-update-rollback (clears many cases on its own).
    let stuck = [];
    try {
        attempt();
        if (isRecovered(describe())) {
            log(`  ✅ Recovered ${stackName} — proceeding with deploy`);
            return { recovered: true, action: 'continue-update-rollback' };
        }
    } catch (err) {
        stuck = parseStuckResources((err && (err.stderr || err.message) || '').toString());
    }

    // Attempt 2 (once): retry skipping the stuck resources, if we parsed any.
    if (stuck.length > 0) {
        log(`  🔧 Retrying with --resources-to-skip ${stuck.join(' ')}...`);
        try {
            attempt(stuck);
            if (isRecovered(describe())) {
                log(`  ✅ Recovered ${stackName} (skipped: ${stuck.join(', ')}) — proceeding`);
                return { recovered: true, action: 'continue-update-rollback --resources-to-skip' };
            }
        } catch {
            // fall through to the throw below
        }
    }

    // Could not recover automatically — hand the user the exact command (Req 1.4).
    const command = buildContinueRollbackCommand(stackName, region, awsProfile, stuck);
    throw new Error(
        `Stack ${stackName} is stuck in UPDATE_ROLLBACK_FAILED and could not be auto-recovered. ` +
        `Run this to recover it manually, then retry bootstrap:\n    ${command}`
    );
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
     * Compute the CDK context flags for adopting retained resources (S3 buckets,
     * ECR repo, service roles) that already exist. Shared by provision() and diff()
     * so the dry-run preview synthesizes the SAME template as the real deploy.
     *
     * Buckets come from this stack's buckets.json. A bucket is adopted by reference
     * ONLY when it exists AND is not already a resource of this stack; a bucket the
     * stack owns stays a resource, so a second bootstrap never DELETE_SKIPs it (R1.1).
     * Adopt-by-reference only happens while CREATING a stack (the bucket survived a
     * teardown); provision() imports the bucket in the same run (R1.5).
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @param {object} [opts] - { verbose?: boolean } — print ♻️ adoption notices;
     *   { assumeImported?: boolean } — synthesize as if every existing-but-unowned bucket
     *   were already imported (diff() on an existing stack: provision() imports first,
     *   so the deploy that follows carries no bucket adopt flag)
     * @returns {string[]} array of --context flags (possibly empty)
     */
    _computeAdoptFlags(profile, opts = {}) {
        const flags = [];
        const declared = declaredBucketsFor(this.stackNameSuffix, profile);
        if (declared.length > 0) {
            const stackName = getStackName(profile.profileName, this.stackNameSuffix);
            const owned = this._stackOwnedBucketNames(stackName, profile);
            const plan = planBucketAdoption(declared, owned, (name) => this._bucketExists(name, profile));
            for (const { bucket, decision } of plan) {
                if (decision !== 'adopt' || opts.assumeImported) continue;
                if (opts.verbose) {
                    console.log(`  ♻️  Existing bucket ${bucket.name} is not a resource of ${stackName} — referencing it while the stack is created`);
                    console.log('     (it is imported into the stack right after, in this same run)');
                }
                flags.push(`--context ${bucket.adoptContext}=true`);
            }
        }
        const ecrRepo = retainedEcrRepoFor(this.name);
        if (ecrRepo && this._ecrRepoExists(ecrRepo, profile)) {
            if (opts.verbose) console.log(`  ♻️  Existing ECR repo detected (${ecrRepo}) — adopting instead of recreating`);
            flags.push('--context adoptExistingEcr=true');
        }
        // RETAIN'd service IAM roles (eks-cluster stack) — adopt if they already exist,
        // so a re-provision/update doesn't try to CREATE them and collide. Must be in
        // THIS shared helper (used by BOTH provision and diff) so `diff` previews the
        // SAME template the real deploy applies. (BL143 — a dry-run that synthesizes in
        // create-mode while the deploy adopts is the exact drift this fixes.)
        flags.push(...this._detectRetainedRoles(this.stackNameSuffix, profile, { verbose: opts.verbose }));
        return flags;
    }

    /**
     * Detect whether the eks-cluster stack's RETAIN'd SERVICE roles already
     * exist (from a prior deploy). Returns the adopt context flag if so, so a
     * re-provision/update/diff adopts them instead of trying to CREATE and
     * colliding. Shared by provision() and diff() via _computeAdoptFlags().
     * @param {string} stackSuffix
     * @param {object} profile
     * @param {object} [opts] - { verbose?: boolean }
     * @returns {string[]} context flag array (empty if no roles found)
     */
    _detectRetainedRoles(stackSuffix, profile, opts = {}) {
        // Only the eks-cluster stack creates the RETAIN'd roles
        if (stackSuffix !== 'eks-cluster') return [];

        // Only the SERVICE roles are RETAIN'd + adopted (static service-principal trust,
        // valid across cluster rebuilds). The IRSA roles (hyperpod-inference, alb, keda,
        // s3-csi, fsx-csi, eks-inference) are OIDC-bound → DESTROY + always-created, so
        // they are NOT adopt-eligible and are deliberately NOT in this list (BL143
        // Option 1). The `adoptRoles` flag governs only the _createOrAdoptRole path.
        const roleNames = [
            `mlcc-${profile.profileName}-eks-cluster-role`,
            `mlcc-${profile.profileName}-eks-node-role`,
            `mlcc-${profile.profileName}-hyperpod-instance-role`,
            `mlcc-${profile.profileName}-fargate-pod-exec-role`,
        ];

        for (const roleName of roleNames) {
            if (this._iamRoleExists(roleName, profile)) {
                if (opts.verbose) {
                    console.log(`  ♻️  Existing service IAM role detected (${roleName}) — adopting service roles`);
                }
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
     * Provision this module's infrastructure. Idempotent.
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @param {object} [opts] - { forceDeploy?: boolean }
     *   forceDeploy=true (used by `bootstrap update`) always runs `cdk deploy`
     *   so CloudFormation diffs the template and applies any changes, instead of
     *   short-circuiting when the stack already exists.
     * Declared buckets that exist but are not stack resources are IMPORTED into the
     * stack as part of this call (R1.5, implicit — there is no separate command):
     *   • stack exists → import first, then the normal deploy (the buckets are now
     *     owned, so their configured properties apply);
     *   • stack does not exist yet (bucket retained after a teardown) → create the
     *     stack referencing the bucket, import it, deploy again — one run converges.
     * The add-module short-circuit (stack already provisioned) still imports, and
     * deploys once when it did import. A failed import throws (change set deleted);
     * there is no adopt-by-reference fallback.
     * @returns {Promise<Record<string, string>>} Stack outputs
     */
    async provision(profile, opts = {}) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);

        // A prior failed deploy can leave the stack in a state CDK cannot update
        // (e.g. ROLLBACK_COMPLETE). Detect and delete it first so this deploy
        // starts clean, rather than failing with an un-updatable-stack error.
        await this._cleanupUnupdatableStack(stackName, profile);

        return this._provisionConverged(profile, opts, {
            alreadyProvisioned: () => console.log(`  ✅ ${this.name} already provisioned (${stackName})`),
            deploy: (isUpdate) => this._cdkDeploy(profile, isUpdate)
        });
    }

    /**
     * Shared provision flow (single-stack runner and each stack of the multi-stack
     * runner): idempotency short-circuit + implicit bucket import (R1.5).
     * @param {object} profile
     * @param {object} opts - { forceDeploy?: boolean, synthContext?: Record<string,string> }
     * @param {object} hooks - { deploy(isUpdate): Promise|void, alreadyProvisioned(): void }
     * @returns {Promise<Record<string, string>>} Stack outputs
     */
    async _provisionConverged(profile, opts, hooks) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);
        const hasBuckets = declaredBucketsFor(this.stackNameSuffix, profile).length > 0;
        const importOpts = { synthContext: opts.synthContext || {} };

        // Stack existence is needed for the add-module short-circuit and to decide
        // whether the import runs before or after the deploy.
        const existed = (hasBuckets || !opts.forceDeploy)
            ? (await this.status(profile)).state === 'provisioned'
            : true;

        let imported = [];
        if (hasBuckets && existed) imported = this._importUnownedBuckets(profile, importOpts);

        // Idempotency short-circuit for `add-module`: an existing stack is not
        // redeployed — unless it just imported buckets, which need one deploy to
        // apply their configured properties. `bootstrap update` passes forceDeploy.
        if (!opts.forceDeploy && existed && imported.length === 0) {
            hooks.alreadyProvisioned();
            return this._getStackOutputs(stackName, profile);
        }

        await hooks.deploy(opts.forceDeploy === true || existed);

        if (hasBuckets && !existed) {
            // Created while referencing retained buckets — import them now and
            // deploy again so the run ends with every declared bucket owned.
            const late = this._importUnownedBuckets(profile, importOpts);
            if (late.length > 0) await hooks.deploy(true);
        }
        return this._getStackOutputs(stackName, profile);
    }

    /**
     * Run `cdk deploy` for this stack with the current adopt flags.
     * @param {object} profile
     * @param {boolean} isUpdate - label only
     */
    _cdkDeploy(profile, isUpdate) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);
        console.log(`  ${isUpdate ? '🔄 Updating' : '🚀 Deploying'} ${this.name} module (${stackName})...`);

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

        // Planned bucket imports (R1.5), read-only: no change set is created.
        let existed = false;
        if (declaredBucketsFor(this.stackNameSuffix, profile).length > 0) {
            existed = (await this.status(profile)).state === 'provisioned';
            this._previewBucketImports(profile, existed);
        }

        // Use the SAME adopt flags the real deploy would use, so the diff
        // reflects reality. On an existing stack provision() imports unowned
        // buckets BEFORE deploying, so the deploy (and this diff) carries no bucket
        // adopt flag; the imported buckets show as [+] AWS::S3::Bucket here.
        const adoptFlags = this._computeAdoptFlags(profile, { verbose: false, assumeImported: existed });
        this._cdkDiff(profile, adoptFlags);
    }

    /**
     * Run `cdk diff` for this stack and stream the output.
     * @param {object} profile
     * @param {string[]} adoptFlags
     */
    _cdkDiff(profile, adoptFlags) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);
        // --method template: compare templates directly. The default ('auto')
        // creates a temporary change set, and the preview must stay read-only.
        const cdkCmd = [
            'npx cdk diff', stackName,
            '--method template',
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
     * Plan this stack's declared buckets (owned / to import / to create). Read-only.
     * @returns {{ stackName: string, plan: Array<{bucket: object, decision: string}> }}
     */
    _bucketPlan(profile) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);
        const declared = declaredBucketsFor(this.stackNameSuffix, profile);
        if (declared.length === 0) return { stackName, plan: [] };
        const owned = this._stackOwnedBucketNames(stackName, profile);
        return { stackName, plan: planBucketAdoption(declared, owned, (name) => this._bucketExists(name, profile)) };
    }

    /**
     * Print one plan line per declared bucket.
     * @param {Array<object>} plan
     * @param {boolean} stackExists - false: an unowned bucket is referenced while the
     *   stack is created, then imported in the same run
     */
    _printBucketPlan(plan, stackExists) {
        const adoptLabel = stackExists
            ? 'exists, not in the stack — will be imported'
            : 'exists, stack not created yet — referenced at create, then imported in the same run';
        for (const { bucket, decision } of plan) {
            const label = { owned: 'owned by the stack — nothing to import', adopt: adoptLabel, create: 'does not exist — the deploy creates it' }[decision];
            console.log(`    • s3://${bucket.name} (${bucket.logicalId}): ${label}`);
        }
    }

    /**
     * Read-only preview of the implicit bucket import (dry run / diff). Creates no
     * change set and writes nothing.
     * @param {object} profile
     * @param {boolean} stackExists
     * @returns {string[]} names of the buckets that would be imported
     */
    _previewBucketImports(profile, stackExists) {
        const { stackName, plan } = this._bucketPlan(profile);
        if (plan.length === 0) return [];
        this._printBucketPlan(plan, stackExists);
        const names = plan.filter((p) => p.decision === 'adopt').map((p) => p.bucket.name);
        console.log(names.length > 0
            ? `    📥 Would import into ${stackName}: ${names.map((n) => `s3://${n}`).join(', ')} (IMPORT change set, no data change)`
            : `    ✓  ${stackName}: nothing to import`);
        return names;
    }

    /**
     * Implicit bucket import (R1.5) — a step of provision(), never a separate command.
     *
     * For each bucket this stack declares that EXISTS but is NOT yet a resource of
     * the (existing) stack: create a CloudFormation IMPORT change set whose template
     * is the deployed template plus ONLY those buckets (no other diff — report risk
     * R3), verify the change set is import-only, execute it and wait. The caller then
     * runs the normal deploy so the configured properties (versioning, encryption,
     * public access block, lifecycle, tags) apply. Idempotent: owned buckets are
     * skipped. Any failure deletes the change set and throws, naming the stack and
     * buckets — the caller must not fall back to adopt-by-reference.
     *
     * @param {object} profile - { accountId, awsRegion, awsProfile?, profileName }
     * @param {object} [opts] - { synthContext?: Record<string,string> } extra CDK context
     *   for the offline synth (the multi-stack runner's SSM context)
     * @returns {string[]} names of the buckets imported (empty = nothing to do)
     */
    _importUnownedBuckets(profile, opts = {}) {
        const { stackName, plan } = this._bucketPlan(profile);
        if (plan.length === 0) return [];
        this._printBucketPlan(plan, true);
        const toImport = plan.filter((p) => p.decision === 'adopt').map((p) => p.bucket);
        if (toImport.length === 0) return [];

        const what = `${stackName} (${toImport.map((b) => `s3://${b.name}`).join(', ')})`;
        for (const b of toImport) {
            console.log(`    📥 Bringing existing bucket s3://${b.name} under CloudFormation (import, no data change)`);
        }

        let imports;
        let deployed;
        let body;
        try {
            const synthesized = this._synthTemplate(profile, opts.synthContext || {});
            imports = toImport.map((bucket) => {
                const logicalId = findBucketLogicalId(synthesized, stackName, bucket);
                if (!logicalId) {
                    throw new Error(`synthesized template has no AWS::S3::Bucket for ${bucket.name} (${bucket.logicalId})`);
                }
                return { logicalId, bucketName: bucket.name };
            });
            deployed = this._getDeployedTemplate(stackName, profile);
            const built = buildImportTemplate(deployed, imports);
            body = { template: JSON.stringify(built.template), resourcesToImport: built.resourcesToImport };
        } catch (err) {
            throw new Error(`Bucket import into ${what} failed before any change set was created: ${err.message}`);
        }
        const size = Buffer.byteLength(body.template, 'utf8');
        if (size > 51200) {
            throw new Error(`Bucket import into ${what} aborted: import template is ${size} bytes (> 51,200 inline limit); import manually with --template-url`);
        }

        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `mlcc-import-${this.stackNameSuffix}-`));
        const templateFile = path.join(workDir, 'import-template.json');
        const resourcesFile = path.join(workDir, 'resources-to-import.json');
        try {
            fs.writeFileSync(templateFile, body.template);
            fs.writeFileSync(resourcesFile, JSON.stringify(body.resourcesToImport, null, 2));

            const params = Object.keys(deployed.Parameters || {}).map((k) => `ParameterKey=${k},UsePreviousValue=true`);
            const expectedIds = imports.map((i) => i.logicalId);
            const deleteChangeSet = (name) => {
                try {
                    this._aws(profile, ['cloudformation', 'delete-change-set', '--stack-name', stackName, '--change-set-name', name]);
                } catch { /* best-effort cleanup; the original error is what matters */ }
            };
            const createAndDescribe = (name, typeArgs) => {
                this._aws(profile, [
                    'cloudformation', 'create-change-set',
                    '--stack-name', stackName,
                    '--change-set-name', name,
                    ...typeArgs,
                    '--template-body', `file://${templateFile}`,
                    '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND',
                    ...(params.length ? ['--parameters', ...params] : [])
                ]);
                this._aws(profile, ['cloudformation', 'wait', 'change-set-create-complete', '--stack-name', stackName, '--change-set-name', name]);
                return JSON.parse(this._aws(profile, ['cloudformation', 'describe-change-set', '--stack-name', stackName, '--change-set-name', name, '--output', 'json']));
            };

            // 1) Preferred: an IMPORT change set that contains ONLY the bucket import.
            let changeSetName = `mlcc-import-buckets-${Date.now()}`;
            let waitFor = 'stack-import-complete';
            let refreshed = [];
            try {
                const described = createAndDescribe(changeSetName, ['--change-set-type', 'IMPORT', '--resources-to-import', `file://${resourcesFile}`]);
                assertImportOnlyChangeSet(described, expectedIds);
            } catch (err) {
                deleteChangeSet(changeSetName);
                refreshed = modifiedResourcesFromImportError(err.message);
                if (refreshed.length === 0) {
                    throw new Error(`Bucket import into ${what} aborted — IMPORT change set failed or was not import-only (deleted it; nothing changed): ${err.message}`);
                }
                // 2) Fallback: CloudFormation rejected the import because it re-evaluates
                // other, unchanged resources (seen for AWS::Glue::Table). Use an UPDATE
                // change set with --import-existing-resources over the SAME template, and
                // allow only the bucket import plus an in-place Modify of exactly the
                // resources CloudFormation named.
                console.log(`    ↪  CloudFormation re-evaluates ${refreshed.join(', ')} on any re-submitted template, so an import-only change set isn't possible here.`);
                console.log('       Retrying as an update that imports the bucket and re-applies those resources unchanged (no add, remove, or replacement allowed).');
                changeSetName = `mlcc-import-buckets-${Date.now()}`;
                waitFor = 'stack-update-complete';
                try {
                    const described = createAndDescribe(changeSetName, ['--change-set-type', 'UPDATE', '--import-existing-resources']);
                    assertImportWithInPlaceRefresh(described, expectedIds, refreshed);
                } catch (err2) {
                    deleteChangeSet(changeSetName);
                    throw new Error(`Bucket import into ${what} aborted — neither an import-only change set nor an import with an in-place refresh of ${refreshed.join(', ')} was possible (deleted both; nothing changed): ${err2.message}`);
                }
            }
            try {
                this._aws(profile, ['cloudformation', 'execute-change-set', '--stack-name', stackName, '--change-set-name', changeSetName]);
                this._aws(profile, ['cloudformation', 'wait', waitFor, '--stack-name', stackName]);
            } catch (err) {
                throw new Error(`Bucket import into ${what} failed while executing change set ${changeSetName}: ${err.message}. Check the stack events, then re-run.`);
            }
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
        console.log(`    ✅ Imported into ${stackName}: ${imports.map((i) => i.bucketName).join(', ')}`);
        return toImport.map((b) => b.name);
    }

    /**
     * Run an AWS CLI command (argv form — no shell interpolation) and return stdout.
     * @param {object} profile - { awsRegion, awsProfile? }
     * @param {string[]} args
     * @returns {string}
     */
    _aws(profile, args) {
        const argv = [...args, '--region', profile.awsRegion];
        if (profile.awsProfile) argv.push('--profile', profile.awsProfile);
        return execFileSync('aws', argv, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    }

    /**
     * The stack's CURRENT deployed template (`get-template --template-stage Original`).
     * @returns {object}
     */
    _getDeployedTemplate(stackName, profile) {
        const out = this._aws(profile, [
            'cloudformation', 'get-template', '--stack-name', stackName,
            '--template-stage', 'Original', '--query', 'TemplateBody', '--output', 'json'
        ]);
        const body = JSON.parse(out);
        return typeof body === 'string' ? JSON.parse(body) : body;
    }

    /**
     * Synthesize this stack WITHOUT any bucket adopt flags (every declared bucket as a
     * resource) and return the parsed template. Used only to read the buckets'
     * logical IDs for the import; offline (no AWS calls).
     * @returns {object}
     */
    _synthTemplate(profile, extraContext = {}) {
        const stackName = getStackName(profile.profileName, this.stackNameSuffix);
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `mlcc-synth-${this.stackNameSuffix}-`));
        execFileSync('npx', [
            'cdk', 'synth', stackName, '--quiet', '--output', outDir,
            ...Object.entries(extraContext).flatMap(([k, v]) => ['--context', `${k}=${v}`]),
            '--context', `module=${this.stackNameSuffix}`,
            '--context', `profileName=${profile.profileName}`,
            '--context', `accountId=${profile.accountId}`,
            '--context', `region=${profile.awsRegion}`
        ], {
            cwd: MODULES_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CDK_DEFAULT_REGION: profile.awsRegion, CDK_DEFAULT_ACCOUNT: profile.accountId }
        });
        try {
            return JSON.parse(fs.readFileSync(path.join(outDir, `${stackName}.template.json`), 'utf8'));
        } finally {
            fs.rmSync(outDir, { recursive: true, force: true });
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
     * Recoverable-in-place (do NOT delete — the stack is intact):
     *   UPDATE_ROLLBACK_FAILED               — failed UPDATE; continue-update-rollback
     *                                          (auto-recover, or throw the exact command)
     *   UPDATE_ROLLBACK_COMPLETE             — failed UPDATE, already rolled back
     *   *_COMPLETE, *_IN_PROGRESS            — leave alone
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

        // UPDATE_ROLLBACK_FAILED is an INTACT stack with a failed update — it must NOT
        // be deleted. Continue the rollback (auto-recover) or throw the exact manual
        // command. This is NOT in UNUPDATABLE (BL143 Req 1.1).
        if (cfnStatus === 'UPDATE_ROLLBACK_FAILED') {
            recoverUpdateRollbackFailed({
                stackName,
                region: profile.awsRegion,
                awsProfile: profile.awsProfile,
                runCmd: (argv) => execSync(
                    `aws ${argv.join(' ')}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                ),
                log: (msg) => console.log(msg)
            });
            return; // recovered → caller proceeds; unrecovered → threw with the command.
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
     * Physical names of the AWS::S3::Bucket resources currently in a stack
     * (`describe-stack-resources`). A stack that does not exist owns nothing → empty
     * set. Any OTHER failure throws: guessing "not owned" for a bucket the stack
     * does own would adopt it by reference and orphan it (R1.1), so never guess.
     * @param {string} stackName
     * @param {object} profile - { awsRegion, awsProfile? }
     * @returns {Set<string>}
     */
    _stackOwnedBucketNames(stackName, profile) {
        let out;
        try {
            out = this._aws(profile, [
                'cloudformation', 'describe-stack-resources', '--stack-name', stackName, '--output', 'json'
            ]);
        } catch (err) {
            const msg = (err.stderr || err.message || '').toString();
            if (/does not exist/i.test(msg)) return new Set();
            throw new Error(
                `Could not determine which buckets ${stackName} owns (describe-stack-resources failed): ` +
                `${msg.split('\n')[0]}. Refusing to guess — adopting an owned bucket by reference would orphan it.`
            );
        }
        const parsed = JSON.parse(out || '{}');
        const names = new Set();
        for (const r of parsed.StackResources || []) {
            if (r.ResourceType !== 'AWS::S3::Bucket' || !r.PhysicalResourceId) continue;
            if (/^DELETE_/.test(r.ResourceStatus || '')) continue;
            names.add(r.PhysicalResourceId);
        }
        return names;
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

        // HyperPod-only preflights run ONLY when this module owns the HyperPod stacks
        // (BL143 — the `eks` module must NOT run them). Keyed off stack OWNERSHIP, not a
        // module-name literal, so it stays correct if the module is renamed.
        const ownsHyperPod = this.stacks.includes('hyperpod-cluster')
            || this.stacks.includes('inference-operator');

        // Pre-flight: ensure the HyperPod service-linked role exists.
        // SageMaker needs this to manage VPC/subnet resources when creating
        // a HyperPod cluster. Without it, CreateCluster fails with
        // "Unable to retrieve subnets".
        if (ownsHyperPod) {
            this._ensureHyperPodServiceLinkedRole(profile);
        }

        for (let i = 0; i < this.stacks.length; i++) {
            const stackSuffix = this.stacks[i];
            const stackName = getStackName(profile.profileName, stackSuffix);

            // After the eks-cluster stack (which OWNS the RETAIN'd service roles)
            // deploys, reconcile the trust policy + managed policies of ALL adopted
            // service roles. CDK cannot set either on an imported/adopted role, so this
            // closes the adopt-drift gap for every one of them (not just the HyperPod
            // instance role) — e.g. restoring the ec2 trust principal the HyperPod role
            // needs before CreateCluster validates it. (BL143 adopt-drift.)
            if (stackSuffix === 'eks-cluster') {
                this._ensureAdoptedServiceRoles(profile);
            }

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

        // Post-deploy inference-operator steps (BL161). The add-on itself is now a
        // CDK-owned eks.CfnAddon in the inference-operator stack (created/destroyed by
        // CloudFormation, symmetric, no stale-ARN wedge). What REMAINS here are the two
        // non-CloudFormation concerns that cannot live in the stack:
        //   • the read-only, warn-not-block cluster-inference watcher verification
        //     (_ensureHyperPodClusterInferenceEnabled — R2), and
        //   • the kubectl post-install patches (_postInstallInferenceOperator — R3).
        // HyperPod-only (BL143 — the `eks` module has no inference operator).
        if (ownsHyperPod) {
            this._postDeployInferenceOperator(profile);
        }

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
    _clearBlockingWebhooks(profile) {
        console.log('    Clearing blocking webhooks...');
        const webhooks = [
            'mutatingwebhookconfiguration/aws-load-balancer-webhook',
            'validatingwebhookconfiguration/aws-load-balancer-webhook',
            'mutatingwebhookconfiguration/cert-manager-webhook',
            'validatingwebhookconfiguration/cert-manager-webhook',
        ];
        // kubectl resolves identity from the env, not a flag — pin it to the MLCC
        // profile so it matches the EKS access entry (BL143 #10). `profile` is optional
        // for backward-compat; when omitted, inherit the ambient env as before.
        const env = profile ? this._subprocessEnv(profile) : process.env;
        for (const wh of webhooks) {
            try {
                execSync(`kubectl delete ${wh} --ignore-not-found`, {
                    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env,
                });
            } catch {
                // kubectl not available or cluster not reachable — best effort
            }
        }
    }

    /**
     * Post-deploy inference-operator steps (BL161).
     *
     * The inference add-on itself is now a CDK-owned `eks.CfnAddon` in the
     * inference-operator stack — the normal stack loop materializes it, and
     * `cdk destroy` removes it (symmetric, no stale-ARN wedge). What remains here are
     * the two concerns that are NOT CloudFormation resources and so cannot live in the
     * stack:
     *   • the kubectl post-install patches (HYPERPOD_CLUSTER_ARN env + the conditional
     *     gateway nodeSelector — R3), and
     *   • the read-only, warn-not-block cluster-inference watcher verification (R2).
     * Both run AFTER the stack loop (the add-on already exists by then). Neither gates
     * the stack.
     *
     * Idempotent + best-effort: a missing HyperPod cluster ARN (e.g. a partial deploy)
     * is logged and skipped rather than failing the deploy.
     * @param {object} profile
     */
    _postDeployInferenceOperator(profile) {
        const awsFlags = (profile.awsProfile ? ` --profile ${profile.awsProfile}` : '');
        const ssmPrefix = `/mlcc/${profile.profileName}/hyperpod`;
        let hyperpodClusterArn = '';
        try {
            hyperpodClusterArn = execSync(
                `aws ssm get-parameter --name ${ssmPrefix}/HyperPodClusterArn --region ${profile.awsRegion}${awsFlags} --query "Parameter.Value" --output text`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
        } catch {
            hyperpodClusterArn = '';
        }
        if (!hyperpodClusterArn || hyperpodClusterArn === 'None') {
            hyperpodClusterArn = this._readSsmParamsForContext?.(profile)?.HyperPodClusterArn || '';
        }

        if (!hyperpodClusterArn) {
            console.log('  ⚠️  Skipping inference operator post-install — HyperPod cluster ARN not found');
            return;
        }

        // The add-on is created by CDK; apply the kubectl fixups it needs, then verify
        // the cluster-inference watcher reached Enabled (read-only, warn-not-block).
        this._postInstallInferenceOperator(profile, hyperpodClusterArn);
        this._ensureHyperPodClusterInferenceEnabled(profile);
    }

    /**
     * Verify (and wait for) the HyperPod cluster's inference capability to be enabled.
     *
     * The SageMaker HyperPod inference operator creates the managed SageMaker endpoint
     * (CreateModel → CreateEndpointConfig → CreateEndpoint) only once the CLUSTER is
     * inference-enabled. The EKS add-on's controller triggers that enablement
     * (EnableClusterInference) asynchronously; it can take 5-15+ minutes. Until it
     * completes, `describe-cluster` returns `InferenceConfig: null` and ANY model deploy
     * hangs: the serving pods + ALB come up, but the operator's SageMakerEndpointRegistration
     * controller polls DescribeEndpoint forever because the control-plane create is never
     * issued. (BL143 live-rehearsal root cause.)
     *
     * This polls describe-cluster until InferenceConfig is non-null, and surfaces a clear,
     * actionable warning (not a silent success) if it does not enable in time. Idempotent
     * and read-only — it only observes; it does not mutate the cluster.
     */
    _ensureHyperPodClusterInferenceEnabled(profile) {
        const clusterName = `mlcc-${profile.profileName}-hyperpod`;
        const ns = 'hyperpod-inference-system';
        const env = this._subprocessEnv(profile);

        // SIGNAL (BL143 — corrected 2026-10-15): gate on the OPERATOR'S OWN watcher
        // status, NOT `describe-cluster InferenceConfig`. The live rehearsal proved the
        // two are DECOUPLED: the operator reaches watcher status "Enabled" (its
        // GetInferenceWatcherStatus API) while `describe-cluster InferenceConfig` stays
        // null indefinitely — `InferenceConfig` is a red herring and gating on it produced
        // a false-negative "did not enable" warning on clusters that were in fact enabled.
        // The operator logs the authoritative outcome; we read that. Read-only, idempotent.
        console.log('  ⏳ Verifying cluster inference capability (operator watcher status, up to 25 min)...');
        const start = Date.now();
        const timeout = 1500000; // 25 min — a recreate-after-teardown watcher drain can push
                                 // EnableClusterInference success past 15 min (observed ~17-20 min).
        const grep = (needle) => {
            try {
                const logs = execSync(
                    `kubectl logs -n ${ns} deployment/hyperpod-inference-controller-manager -c manager --tail=400`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env }
                );
                return logs.includes(needle);
            } catch {
                return false; // operator not reachable yet — keep waiting
            }
        };
        while (Date.now() - start < timeout) {
            // Either phrasing the operator emits once the watcher is enabled.
            if (grep('Cluster inference watcher enabled successfully')
                || grep('Service side watcher is already enabled')
                || grep('Desired watcher status reached')) {
                console.log('  ✅ Cluster inference capability is enabled (operator watcher status: Enabled)');
                return;
            }
            execSync('sleep 30', { stdio: 'pipe', env });
        }
        // Non-fatal warning (the deploy driver is warn-not-block too). Note: this is only a
        // WARNING — do not treat `InferenceConfig: null` as proof of failure (it stays null
        // by design). A separate, confirmed operator/control-plane issue can prevent the
        // SageMaker endpoint from ever being created even when the watcher IS enabled; see
        // docs/architecture/eks-hyperpod-migration.md. That is NOT fixed here and is outside
        // MLCC's control.
        console.log('  ⚠️  Could not confirm cluster inference watcher reached "Enabled" within 25 minutes.');
        console.log('      This is a non-blocking check. Inspect the operator directly:');
        console.log(`      kubectl logs -n ${ns} deployment/hyperpod-inference-controller-manager -c manager | grep -i watcher`);
        console.log(`      (describe-cluster InferenceConfig is NOT a reliable signal — it stays null even when enabled.)`);
    }

    /**
     * Apply post-install patches to the HyperPod inference operator after the
     * EKS addon reaches ACTIVE state. Centralises all kubectl fixups in one place
     * so new patches are easy to add and the bootstrap log is readable.
     *
     * Current patches:
     *   1. HYPERPOD_CLUSTER_ARN env var — operator can't auto-detect on Fargate
     *   2. inference-gateway-controller nodeSelector — uses hostPath volumes
     *      unsupported by Fargate; must run on HyperPod EC2 worker nodes
     *
     * All patches are idempotent (kubectl set env / patch are safe to re-run).
     *
     * @param {object} profile
     * @param {string} hyperpodClusterArn
     */
    _postInstallInferenceOperator(profile, hyperpodClusterArn) {
        const awsFlags = profile.awsProfile ? ` --profile ${profile.awsProfile}` : '';
        const ns = 'hyperpod-inference-system';

        // The operator runs on the EKS cluster (ns hyperpod-inference-system). Write a
        // kubeconfig for THAT cluster here rather than assuming a path some other step
        // created — the previous code built `.kube/hyperpod-<profileName>`, which does not
        // match the deploy driver's `.kube/hyperpod-<HP_CLUSTER_NAME>` and often did not
        // exist at all, so every patch failed with a kubeconfig/connection error. Deriving
        // the eks cluster name + running update-kubeconfig makes this self-contained and
        // deterministic. (BL143 live-rehearsal finding.)
        const eksClusterName = `mlcc-${profile.profileName}-eks`;
        const kubeconfig = `${process.env.HOME}/.kube/mlcc-eks-${profile.profileName}`;
        try {
            execSync(
                `aws eks update-kubeconfig --name ${eksClusterName} --region ${profile.awsRegion}${awsFlags} --kubeconfig ${kubeconfig}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: this._subprocessEnv(profile) }
            );
        } catch (e) {
            console.log(`  ⚠️  Could not write kubeconfig for ${eksClusterName}: ${e.message.split('\n')[0]}`);
            console.log('     Post-install patches will likely fail; apply them manually (see below).');
        }

        const patches = [
            {
                description: 'HYPERPOD_CLUSTER_ARN on controller manager',
                cmd: `kubectl set env deployment/hyperpod-inference-controller-manager -n ${ns} HYPERPOD_CLUSTER_ARN=${hyperpodClusterArn} --kubeconfig ${kubeconfig}`,
                manual: `kubectl set env deployment/hyperpod-inference-controller-manager -n ${ns} HYPERPOD_CLUSTER_ARN=${hyperpodClusterArn}`,
            },
            {
                description: 'inference-gateway-controller nodeSelector (EC2 only — hostPath volumes)',
                // Only applicable when the Inference Gateway is ENABLED. MLCC's add-on config
                // sets inferenceGateway.enabled=false (matching the console Quick Install),
                // so the add-on does NOT create this deployment — the patch would then fail
                // with "deployments.apps inference-gateway-controller not found", a FALSE
                // alarm that misleadingly logs "operator may not work correctly". Guard it on
                // the deployment actually existing (self-correcting: patches when present,
                // skips cleanly when the gateway is disabled). (BL143 2026-10-15.)
                requiresDeployment: 'inference-gateway-controller',
                cmd: `kubectl patch deployment inference-gateway-controller -n ${ns} --patch '{"spec":{"template":{"spec":{"nodeSelector":{"sagemaker.amazonaws.com/compute-type":"hyperpod"}}}}}' --kubeconfig ${kubeconfig}`,
                manual: `kubectl patch deployment inference-gateway-controller -n ${ns} --patch '{"spec":{"template":{"spec":{"nodeSelector":{"sagemaker.amazonaws.com/compute-type":"hyperpod"}}}}}'`,
            },
        ];

        console.log('  🔧 Applying inference operator post-install patches...');
        const patchEnv = this._subprocessEnv(profile);
        let allOk = true;
        for (const patch of patches) {
            // Skip a patch whose target deployment legitimately does not exist (e.g. the
            // gateway controller when inferenceGateway.enabled=false). This is NOT a failure.
            if (patch.requiresDeployment) {
                let exists = false;
                try {
                    execSync(
                        `kubectl get deployment ${patch.requiresDeployment} -n ${ns} --kubeconfig ${kubeconfig}`,
                        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: patchEnv }
                    );
                    exists = true;
                } catch {
                    exists = false;
                }
                if (!exists) {
                    console.log(`     ⏭️  ${patch.description} — skipped (${patch.requiresDeployment} not present; expected when its feature is disabled)`);
                    continue;
                }
            }
            try {
                execSync(patch.cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: patchEnv });
                console.log(`     ✅ ${patch.description}`);
            } catch (e) {
                allOk = false;
                console.log(`     ⚠️  ${patch.description}: ${e.message.split('\n')[0]}`);
                console.log(`        Run manually: ${patch.manual}`);
            }
        }
        if (allOk) {
            console.log('  ✅ Inference operator post-install patches applied');
        } else {
            console.log('  ⚠️  Some patches failed — operator may not work correctly until applied manually');
        }
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

        // Also ensure the base SageMaker SLR (AWSServiceRoleForAmazonSageMakerHyperPod).
        // Required for HyperPod to provision EC2 instances — without it, UpdateCluster
        // accepts the API call but InstanceGroupStatus stays null indefinitely.
        try {
            execSync(
                `aws iam create-service-linked-role --aws-service-name sagemaker.amazonaws.com` +
                (profile.awsProfile ? ` --profile ${profile.awsProfile}` : ''),
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            console.log('  ✅ Created SageMaker base service-linked role');
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

    /**
     * Build the subprocess env for helm/kubectl calls (BL143 finding #10).
     *
     * `aws` CLI calls pass `--profile ${profile.awsProfile}` explicitly, but helm and
     * kubectl take no such flag — they resolve identity from the ambient environment.
     * If the operator's shell has AWS_PROFILE set to a profile that assumes a DIFFERENT
     * IAM role than profile.awsProfile (the identity the EKS access entry was granted
     * to), the helm/kubectl token is minted for the wrong principal and the cluster
     * rejects it ("server has asked for the client to provide credentials"). Force these
     * subprocesses onto the MLCC profile's identity so it cannot diverge from the grant.
     * @param {object} profile
     * @returns {NodeJS.ProcessEnv}
     */
    _subprocessEnv(profile) {
        const env = { ...process.env };
        if (profile.awsProfile) {
            env.AWS_PROFILE = profile.awsProfile;
            // AWS_PROFILE and static-credential env vars are mutually exclusive in the
            // resolver; drop any inherited static creds / default-profile override so the
            // named profile wins deterministically.
            delete env.AWS_ACCESS_KEY_ID;
            delete env.AWS_SECRET_ACCESS_KEY;
            delete env.AWS_SESSION_TOKEN;
            delete env.AWS_DEFAULT_PROFILE;
        }
        if (profile.awsRegion) {
            env.AWS_REGION = profile.awsRegion;
            env.AWS_DEFAULT_REGION = profile.awsRegion;
        }
        return env;
    }

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
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: this._subprocessEnv(profile) }
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

        // Update kubeconfig for the EKS cluster. Pass --profile so the written exec block
        // bakes in the MLCC profile, and set the subprocess env so the token minted here
        // uses the same identity helm/kubectl will use (BL143 #10).
        try {
            execSync(
                `aws eks update-kubeconfig --name ${eksClusterName} --region ${profile.awsRegion}${awsFlags}`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: this._subprocessEnv(profile) }
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
        // Uses the core models bucket which must already be provisioned; its name
        // comes from the core stack's declaration (core/buckets.json).
        const coreBucket = declaredBucketsFor('core', profile).find((b) => b.logicalId === 'ModelsBucketResource');
        const lifecycleBucket = coreBucket.name;
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

        // Update Helm dependencies and install. helm/kubectl take no --profile flag, so
        // force them onto the MLCC profile's identity via the subprocess env (BL143 #10).
        const helmEnv = this._subprocessEnv(profile);
        try {
            execSync('helm dependencies update .', {
                cwd: chartDir, encoding: 'utf8', stdio: 'inherit', env: helmEnv,
            });

            // Remove any webhook configurations that may block Helm install.
            // On a fresh cluster with Fargate, webhook-serving pods (ALB controller,
            // cert-manager) may not be running yet. These webhooks will be recreated
            // once the pods schedule on Fargate.
            console.log('    Clearing blocking webhooks before Helm install...');
            this._clearBlockingWebhooks(profile);

            execSync('helm upgrade --install hyperpod-dependencies . --namespace kube-system --create-namespace', {
                cwd: chartDir, encoding: 'utf8', stdio: 'inherit', env: helmEnv,
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
     * Reconcile the TRUST policy and AWS-MANAGED policies of EVERY adopted RETAIN'd
     * service role (ADOPTED_SERVICE_ROLES) to match the stack's intended spec.
     *
     * This exists because CDK CANNOT, for an ADOPTED (imported) role:
     *   - modify its assume-role (trust) policy, OR
     *   - attach a managed policy (addManagedPolicy(fromManagedPolicyArn(...)) is refused
     *     with "Can't combine imported IManagedPolicy ... Use ManagedPolicy directly" and
     *     silently no-ops).
     * The CREATE path sets both via `new iam.Role({ assumedBy, managedPolicies })`, but a
     * RETAIN'd role that is adopted keeps only what it already had and drifts as the stack
     * evolves — e.g. the HyperPod instance role missing the ec2 trust principal fails
     * CreateCluster with "execution role permissions are invalid". This reconciler closes
     * that gap for ALL adopted service roles, not just the HyperPod one.
     *
     * Idempotent: update-assume-role-policy writes the FULL desired trust document, and
     * attach-role-policy on an already-attached policy is a no-op. Skips any role that
     * does not yet exist (a fresh create already has correct trust/policies from CDK).
     *
     * Inline get-role existence check — `_iamRoleExists` lives on CdkModuleRunner, not
     * this multi-stack class, so do not depend on it here.
     */
    _ensureAdoptedServiceRoles(profile) {
        const awsFlags = profile.awsProfile ? ` --profile ${profile.awsProfile}` : '';

        for (const role of ADOPTED_SERVICE_ROLES) {
            const roleName = `mlcc-${profile.profileName}-${role.suffix}`;

            // Only reconcile a role that already exists (adopted/drifted case).
            try {
                execSync(
                    `aws iam get-role --role-name ${roleName}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch {
                continue; // role doesn't exist yet — nothing to reconcile
            }

            // 1) Trust policy — write the FULL desired principal set.
            const trustDoc = JSON.stringify({
                Version: '2012-10-17',
                Statement: [{
                    Effect: 'Allow',
                    Principal: { Service: role.trustPrincipals },
                    Action: 'sts:AssumeRole',
                }],
            });
            const tmpTrust = path.join(
                require('os').tmpdir(),
                `mlcc-trust-${role.suffix}-${Date.now()}.json`,
            );
            try {
                require('fs').writeFileSync(tmpTrust, trustDoc, 'utf8');
                execSync(
                    `aws iam update-assume-role-policy --role-name ${roleName} --policy-document file://${tmpTrust}${awsFlags}`,
                    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                );
            } catch (err) {
                console.log(`  ⚠️  Could not reconcile trust policy on ${roleName}: ${err.message?.split('\n')[0] || err}`);
            } finally {
                try { require('fs').unlinkSync(tmpTrust); } catch { /* best-effort cleanup */ }
            }

            // 2) Managed policies — attach the FULL set (idempotent).
            for (const policyArn of role.managedPolicies) {
                try {
                    execSync(
                        `aws iam attach-role-policy --role-name ${roleName} --policy-arn ${policyArn}${awsFlags}`,
                        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
                    );
                } catch (err) {
                    console.log(`  ⚠️  Could not attach ${policyArn} to ${roleName}: ${err.message?.split('\n')[0] || err}`);
                }
            }
            console.log(`  ✅ Adopted service role reconciled: ${roleName}`);
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

        // Same flow as the single-stack runner: idempotency short-circuit plus the
        // implicit import of declared-but-unowned buckets (R1.5, e.g. the
        // inference-operator TLS bucket). Stacks without declared buckets behave
        // exactly as before.
        return runner._provisionConverged(profile, { ...opts, synthContext: ssmContext }, {
            alreadyProvisioned: () => console.log(`    ✅ ${stackSuffix} already provisioned (${stackName})`),
            deploy: (isUpdate) => this._cdkDeployStack(runner, stackSuffix, profile, isUpdate, ssmContext)
        });
    }

    /**
     * Run `cdk deploy` for one stack of this module with SSM context injected.
     */
    _cdkDeployStack(runner, stackSuffix, profile, isUpdate, ssmContext) {
        const stackName = getStackName(profile.profileName, stackSuffix);
        console.log(`    ${isUpdate ? '🔄 Updating' : '🚀 Deploying'} ${stackSuffix} (${stackName})...`);

        // Compile TypeScript before deploying so source changes are always picked up.
        // This is a fast no-op when nothing changed (tsc incremental).
        try {
            execSync('npm run build', { cwd: MODULES_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            console.error('  ❌ TypeScript build failed — fix errors before deploying:\n' + e.stderr);
            throw new Error('Bootstrap TypeScript build failed');
        }

        // Build adopt flags for this specific stack. _computeAdoptFlags covers the
        // declared buckets (incl. the inference-operator TLS bucket, ownership-checked),
        // ECR AND the RETAIN'd service-role adoption (shared with diff), so no flag is
        // computed separately here (avoids duplicate --context flags).
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

        // BL161: the inference EKS add-on is now a CDK-owned `eks.CfnAddon` in the
        // inference-operator stack, so the normal reverse `cdk destroy` below removes it
        // with its stack. No out-of-band delete hook is needed — the old
        // stale-`hyperpodClusterArn` dangling-add-on wedge (and the imperative delete
        // hack that papered over it) are gone; create and destroy are now symmetric.

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
        // To truly remove it: `aws s3 rb s3://<tls bucket> --force` (name: hyperpod/stacks/buckets.json)

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

module.exports = {
    CdkModuleRunner,
    CdkMultiStackModuleRunner,
    // Bucket ownership / import (bucket consolidation R1.1, R1.2, R1.5) — pure helpers
    // exported for unit tests.
    declaredBucketsFor,
    planBucketAdoption,
    findBucketLogicalId,
    buildImportTemplate,
    assertImportOnlyChangeSet,
    assertImportWithInPlaceRefresh,
    modifiedResourcesFromImportError,
    // Exported for unit testing (BL143 Group A — offline recovery state machine).
    recoverUpdateRollbackFailed,
    parseStuckResources,
    buildContinueRollbackCommand,
};
