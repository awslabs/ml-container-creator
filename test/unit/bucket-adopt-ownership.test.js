// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Bucket adopt / ownership / import logic in module-runner.cjs (bucket consolidation
 * R1.1, R1.2, R1.5). Offline: every AWS / cdk touch point is stubbed on the runner
 * instance.
 *
 *   R1.1 — adopt-by-reference ONLY when the bucket exists AND is not already a
 *          resource of this stack. A second bootstrap must never DELETE_SKIP a bucket
 *          (i.e. never emit an adopt flag for a bucket the stack owns).
 *   R1.2 — the adopt flags derive from the stack's buckets.json declaration.
 *   R1.5 — provision() (bootstrap update / add-module) implicitly imports declared
 *          buckets that exist but are unowned: an IMPORT change set with ONLY the
 *          bucket import, refused if anything else, then the normal deploy; a fresh
 *          stack converges in one run; failures abort with no adopt fallback.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const require = createRequire(import.meta.url);
const runnerMod = require('../../infra/bootstrap-modules/module-runner.cjs');
const {
    CdkModuleRunner, CdkMultiStackModuleRunner, declaredBucketsFor, planBucketAdoption,
    findBucketLogicalId, buildImportTemplate, assertImportOnlyChangeSet,
    assertImportWithInPlaceRefresh, modifiedResourcesFromImportError
} = runnerMod;

const PROFILE = { accountId: '999988887777', awsRegion: 'eu-central-1', profileName: 'zz-p' };

function quietly(fn) {
    const orig = console.log;
    console.log = () => {};
    try { return fn(); } finally { console.log = orig; }
}
async function quietlyAsync(fn) {
    const orig = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = orig; }
}

/** Runner with existence/ownership facts stubbed (no AWS). */
function stubbedRunner(module, stack, { owned = [], existing = [] } = {}) {
    const r = new CdkModuleRunner(module, stack);
    r._stackOwnedBucketNames = () => new Set(owned);
    r._bucketExists = (name) => existing.includes(name);
    r._ecrRepoExists = () => false;
    r._iamRoleExists = () => false;
    return r;
}

const bucketFlags = (flags) => flags.filter(f => !f.includes('adoptExistingEcr') && !f.includes('adoptRoles'));

describe('module-runner bucket ownership (R1.1 / R1.2)', () => {
    it('declaredBucketsFor derives every training bucket from training/buckets.json', () => {
        const decl = declaredBucketsFor('training', PROFILE);
        assert.deepStrictEqual(decl.map(b => b.logicalId).sort(), ['AdaptersBucket', 'ArtifactsBucket', 'TrainingBucket']);
        for (const b of decl) {
            assert.ok(b.name.includes(PROFILE.accountId) && b.name.includes(PROFILE.awsRegion),
                `${b.logicalId} renders account + region into its name`);
            assert.ok(b.adoptContext, `${b.logicalId} declares its adopt context`);
        }
    });

    it('planBucketAdoption: owned → owned, exists-but-unowned → adopt, absent → create', () => {
        const declared = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
        const plan = planBucketAdoption(declared, new Set(['a']), (n) => n === 'a' || n === 'b');
        assert.deepStrictEqual(plan.map(p => p.decision), ['owned', 'adopt', 'create']);
    });

    for (const stack of ['core', 'training', 'benchmark', 'ci']) {
        it(`${stack}: a bucket the stack OWNS is never adopted (second bootstrap cannot DELETE_SKIP it)`, () => {
            const names = declaredBucketsFor(stack, PROFILE).map(b => b.name);
            const r = stubbedRunner(stack, stack, { owned: names, existing: names });
            const flags = quietly(() => r._computeAdoptFlags(PROFILE, { verbose: true }));
            assert.deepStrictEqual(bucketFlags(flags), [], `owned buckets must synthesize as resources: ${flags}`);
        });

        it(`${stack}: an existing bucket NOT in the stack is adopted by reference via its declared context`, () => {
            const decl = declaredBucketsFor(stack, PROFILE);
            const r = stubbedRunner(stack, stack, { owned: [], existing: decl.map(b => b.name) });
            const flags = bucketFlags(quietly(() => r._computeAdoptFlags(PROFILE)));
            assert.deepStrictEqual(flags.sort(), decl.map(b => `--context ${b.adoptContext}=true`).sort());
        });

        it(`${stack}: a fresh account (no bucket exists) adopts nothing — the stack creates them`, () => {
            const r = stubbedRunner(stack, stack, { owned: [], existing: [] });
            assert.deepStrictEqual(bucketFlags(quietly(() => r._computeAdoptFlags(PROFILE))), []);
        });
    }

    it('training: mixed state adopts only the unowned-but-existing bucket', () => {
        const decl = declaredBucketsFor('training', PROFILE);
        const art = decl.find(b => b.logicalId === 'ArtifactsBucket');
        const others = decl.filter(b => b !== art).map(b => b.name);
        const r = stubbedRunner('training', 'training', { owned: others, existing: decl.map(b => b.name) });
        assert.deepStrictEqual(bucketFlags(quietly(() => r._computeAdoptFlags(PROFILE))), [`--context ${art.adoptContext}=true`]);
    });

    it('inference-operator TLS bucket goes through the same ownership-checked path', () => {
        const [tls] = declaredBucketsFor('inference-operator', PROFILE);
        assert.ok(tls && tls.name.includes(PROFILE.profileName), 'TLS bucket is declared with the profile name');
        const owned = stubbedRunner('hyperpod', 'inference-operator', { owned: [tls.name], existing: [tls.name] });
        assert.deepStrictEqual(bucketFlags(quietly(() => owned._computeAdoptFlags(PROFILE))), []);
        const unowned = stubbedRunner('hyperpod', 'inference-operator', { owned: [], existing: [tls.name] });
        assert.deepStrictEqual(bucketFlags(quietly(() => unowned._computeAdoptFlags(PROFILE))), ['--context adoptTlsBucket=true']);
        assert.strictEqual(typeof CdkMultiStackModuleRunner.prototype._detectRetainedTlsBucket, 'undefined',
            'the separate hand-copied TLS detector is retired');
    });

    it('a stack without declared buckets never queries ownership', () => {
        const r = stubbedRunner('registry', 'registry');
        r._stackOwnedBucketNames = () => { throw new Error('must not be called'); };
        assert.deepStrictEqual(bucketFlags(r._computeAdoptFlags(PROFILE)), []);
    });
});

describe('module-runner bucket-import helpers (R1.5)', () => {
    const deployed = {
        Parameters: { BootstrapVersion: { Type: 'AWS::SSM::Parameter::Value<String>' } },
        Resources: { Role: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'r' } } },
        Outputs: { X: { Value: 'y' } }
    };

    it('buildImportTemplate adds ONLY minimal Retain bucket resources to the deployed template', () => {
        const { template, resourcesToImport } = buildImportTemplate(deployed, [{ logicalId: 'ArtifactsBucketABCD1234', bucketName: 'zz-art' }]);
        const { ArtifactsBucketABCD1234: added, ...rest } = template.Resources;
        assert.deepStrictEqual(rest, deployed.Resources, 'existing resources unchanged');
        assert.deepStrictEqual(template.Outputs, deployed.Outputs, 'outputs unchanged');
        assert.deepStrictEqual(template.Parameters, deployed.Parameters, 'parameters unchanged');
        assert.deepStrictEqual(added, {
            Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
            Properties: { BucketName: 'zz-art' }
        });
        assert.deepStrictEqual(resourcesToImport, [{
            ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'ArtifactsBucketABCD1234',
            ResourceIdentifier: { BucketName: 'zz-art' }
        }]);
        assert.ok(!deployed.Resources.ArtifactsBucketABCD1234, 'input template is not mutated');
    });

    it('buildImportTemplate refuses a logical ID already in the deployed template', () => {
        assert.throws(() => buildImportTemplate(deployed, [{ logicalId: 'Role', bucketName: 'x' }]), /already exists/);
    });

    it('assertImportOnlyChangeSet accepts exactly the expected imports and rejects anything else', () => {
        const imp = (id) => ({ Type: 'Resource', ResourceChange: { Action: 'Import', ResourceType: 'AWS::S3::Bucket', LogicalResourceId: id } });
        assert.doesNotThrow(() => assertImportOnlyChangeSet({ Changes: [imp('A'), imp('B')] }, ['A', 'B']));
        assert.throws(() => assertImportOnlyChangeSet({
            Changes: [imp('A'), { Type: 'Resource', ResourceChange: { Action: 'Modify', ResourceType: 'AWS::IAM::Role', LogicalResourceId: 'Role' } }]
        }, ['A']), /not import-only/);
        assert.throws(() => assertImportOnlyChangeSet({ Changes: [imp('A')] }, ['A', 'B']), /Missing imports: B/);
    });

    it('findBucketLogicalId resolves by cdk path metadata, then by BucketName', () => {
        const t = { Resources: {
            Other: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'n2' } },
            ArtifactsBucket2AAC5544: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': 'mlcc-p-training/ArtifactsBucket/Resource' } }
        } };
        assert.strictEqual(findBucketLogicalId(t, 'mlcc-p-training', { logicalId: 'ArtifactsBucket', name: 'n1' }), 'ArtifactsBucket2AAC5544');
        assert.strictEqual(findBucketLogicalId(t, 'mlcc-p-training', { logicalId: 'Nope', name: 'n2' }), 'Other');
        assert.strictEqual(findBucketLogicalId(t, 'mlcc-p-training', { logicalId: 'Nope', name: 'n3' }), undefined);
    });
});

/**
 * Simulated AWS for the implicit import (R1.5). Tracks stack existence and the set of
 * buckets the stack owns; an executed IMPORT change set adds its buckets, a deploy
 * creates the stack and owns every declared bucket that was NOT adopted by reference.
 */
function simulatedRunner({ module = 'training', stack = 'training', stackExists, owned = [], existing, failDescribe = false, profile = PROFILE,
    rejectImportFor = null, rejectImportWith = null, fallbackChanges = [] }) {
    const stackName = `mlcc-${profile.profileName}-${stack}`;
    const decl = declaredBucketsFor(stack, profile);
    const state = { exists: stackExists, owned: new Set(owned), lastImport: [] };
    const calls = [];
    const r = new CdkModuleRunner(module, stack);
    r._cleanupUnupdatableStack = async () => {};
    r._ecrRepoExists = () => false;
    r._iamRoleExists = () => false;
    r._bucketExists = (name) => existing.includes(name);
    r._stackOwnedBucketNames = () => new Set(state.owned);
    r.status = async () => ({ state: state.exists ? 'provisioned' : 'not-provisioned' });
    r._getStackOutputs = () => ({ stack: stackName });
    r._synthTemplate = () => ({ Resources: Object.fromEntries(decl.map(b => [`${b.logicalId}0000ABCD`, {
        Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': `${stackName}/${b.logicalId}/Resource` }
    }])) });
    r._getDeployedTemplate = () => ({ Parameters: { BootstrapVersion: { Type: 'String' } }, Resources: { Other: { Type: 'AWS::IAM::Role' } } });
    r._cdkDeploy = (p) => {
        const flags = r._computeAdoptFlags(p);
        calls.push(['deploy', bucketFlags(flags)]);
        const adopted = new Set(bucketFlags(flags).map(f => f.replace('--context ', '').replace('=true', '')));
        for (const b of decl) if (!adopted.has(b.adoptContext)) state.owned.add(b.name);
        state.exists = true;
    };
    r._aws = (_p, args) => {
        calls.push(args);
        const verb = args[1];
        if (verb === 'create-change-set') {
            state.lastType = args[args.indexOf('--change-set-type') + 1];
            if (state.lastType === 'IMPORT') {
                if (rejectImportFor) {
                    throw new Error(`Command failed: aws cloudformation create-change-set ...\naws: [ERROR]: An error occurred (ValidationError) when calling the CreateChangeSet operation: You have modified resources [${rejectImportFor.join(', ')}] in your template that are not being imported. Update, create or delete operations cannot be executed during import operations.`);
                }
                if (rejectImportWith) throw new Error(rejectImportWith);
                const file = args[args.indexOf('--resources-to-import') + 1].replace('file://', '');
                state.lastImport = JSON.parse(readFileSync(file, 'utf8'));
            } else {
                // UPDATE + --import-existing-resources: the template's unowned buckets get imported.
                const file = args[args.indexOf('--template-body') + 1].replace('file://', '');
                const tpl = JSON.parse(readFileSync(file, 'utf8'));
                state.lastImport = Object.entries(tpl.Resources)
                    .filter(([, res]) => res.Type === 'AWS::S3::Bucket' && !state.owned.has(res.Properties.BucketName))
                    .map(([id, res]) => ({ LogicalResourceId: id, ResourceIdentifier: { BucketName: res.Properties.BucketName } }));
            }
        }
        if (verb === 'describe-change-set') {
            if (failDescribe) {
                return JSON.stringify({ Changes: [{ Type: 'Resource', ResourceChange: { Action: 'Modify', ResourceType: 'AWS::IAM::Role', LogicalResourceId: 'Other' } }] });
            }
            const imports = state.lastImport.map(i => ({ Type: 'Resource', ResourceChange: { Action: 'Import', ResourceType: 'AWS::S3::Bucket', LogicalResourceId: i.LogicalResourceId } }));
            return JSON.stringify({ Changes: [...imports, ...(state.lastType === 'UPDATE' ? fallbackChanges : [])] });
        }
        if (verb === 'execute-change-set') for (const i of state.lastImport) state.owned.add(i.ResourceIdentifier.BucketName);
        return '';
    };
    const verbs = () => calls.map(c => (c[0] === 'deploy' ? 'deploy' : `${c[1]}${c[1] === 'wait' ? `:${c[2]}` : ''}`));
    return { r, calls, state, decl, verbs };
}

const IMPORT_SEQUENCE = ['create-change-set', 'wait:change-set-create-complete', 'describe-change-set',
    'execute-change-set', 'wait:stack-import-complete'];

describe('CdkModuleRunner.provision — implicit bucket import (R1.5, stubbed AWS)', () => {
    it('update on an existing stack with unowned buckets: imports FIRST, then deploys with no adopt flag', async () => {
        const names = declaredBucketsFor('training', PROFILE).map(b => b.name);
        const { r, calls, state, verbs } = simulatedRunner({ stackExists: true, existing: names });
        await quietlyAsync(() => r.provision(PROFILE, { forceDeploy: true }));
        assert.deepStrictEqual(verbs(), [...IMPORT_SEQUENCE, 'deploy']);
        assert.deepStrictEqual(calls[calls.length - 1], ['deploy', []], 'the deploy after import adopts nothing');
        const create = calls[0];
        assert.strictEqual(create[create.indexOf('--change-set-type') + 1], 'IMPORT');
        assert.ok(create.includes('ParameterKey=BootstrapVersion,UsePreviousValue=true'));
        assert.deepStrictEqual([...state.owned].sort(), [...names].sort(), 'every declared bucket ends owned');
    });

    it('prints one import line and one plan line per bucket', async () => {
        const names = declaredBucketsFor('training', PROFILE).map(b => b.name);
        const { r } = simulatedRunner({ stackExists: true, existing: names });
        const logs = [];
        const orig = console.log;
        console.log = (m) => logs.push(String(m));
        try { await r.provision(PROFILE, { forceDeploy: true }); } finally { console.log = orig; }
        for (const n of names) {
            assert.strictEqual(logs.filter(l => l.includes(`📥 Bringing existing bucket s3://${n} under CloudFormation (import, no data change)`)).length, 1);
            assert.strictEqual(logs.filter(l => l.includes(`• s3://${n} `) && l.includes('will be imported')).length, 1);
        }
    });

    it('fresh stack with a retained bucket: create (referenced), import, deploy again — owned in one run', async () => {
        const art = declaredBucketsFor('training', PROFILE).find(b => b.logicalId === 'ArtifactsBucket');
        const { r, calls, state, verbs } = simulatedRunner({ stackExists: false, existing: [art.name] });
        await quietlyAsync(() => r.provision(PROFILE));
        assert.deepStrictEqual(verbs(), ['deploy', ...IMPORT_SEQUENCE, 'deploy']);
        assert.deepStrictEqual(calls[0], ['deploy', [`--context ${art.adoptContext}=true`]], 'create references the retained bucket');
        assert.deepStrictEqual(calls[calls.length - 1], ['deploy', []], 'second deploy owns it');
        assert.ok(state.owned.has(art.name));
    });

    it('fresh stack with no existing bucket: a single deploy, no import', async () => {
        const { r, verbs } = simulatedRunner({ stackExists: false, existing: [] });
        await quietlyAsync(() => r.provision(PROFILE));
        assert.deepStrictEqual(verbs(), ['deploy']);
    });

    it('add-module short-circuit (stack exists, no forceDeploy) still imports, then deploys once', async () => {
        const names = declaredBucketsFor('core', PROFILE).map(b => b.name);
        const { r, state, verbs } = simulatedRunner({ module: 'core', stack: 'core', stackExists: true, existing: names });
        await quietlyAsync(() => r.provision(PROFILE));
        assert.deepStrictEqual(verbs(), [...IMPORT_SEQUENCE, 'deploy']);
        assert.ok(names.every(n => state.owned.has(n)));
    });

    it('already owned: no change set; add-module short-circuits without deploying', async () => {
        const names = declaredBucketsFor('training', PROFILE).map(b => b.name);
        const { r, verbs } = simulatedRunner({ stackExists: true, owned: names, existing: names });
        await quietlyAsync(() => r.provision(PROFILE));
        assert.deepStrictEqual(verbs(), []);
        const upd = simulatedRunner({ stackExists: true, owned: names, existing: names });
        await quietlyAsync(() => upd.r.provision(PROFILE, { forceDeploy: true }));
        assert.deepStrictEqual(upd.verbs(), ['deploy'], 'update only deploys — nothing to import');
    });

    it('import failure aborts: change set deleted, no execute, NO deploy (no adopt-by-reference fallback)', async () => {
        const names = declaredBucketsFor('training', PROFILE).map(b => b.name);
        const { r, verbs } = simulatedRunner({ stackExists: true, existing: names, failDescribe: true });
        await assert.rejects(() => quietlyAsync(() => r.provision(PROFILE, { forceDeploy: true })), (err) => {
            assert.match(err.message, /not import-only/);
            assert.ok(err.message.includes(`mlcc-${PROFILE.profileName}-training`), 'names the stack');
            assert.ok(names.every(n => err.message.includes(n)), 'names the buckets');
            return true;
        });
        const v = verbs();
        assert.ok(v.includes('delete-change-set'));
        assert.ok(!v.includes('execute-change-set'));
        assert.ok(!v.includes('deploy'), 'never deploys after a failed import');
    });

    it('IMPORT rejected for a re-evaluated resource: falls back to an update that imports the bucket and refreshes only that resource', async () => {
        const [bucket] = declaredBucketsFor('benchmark', PROFILE);
        const { r, calls, state, verbs } = simulatedRunner({
            module: 'benchmark', stack: 'benchmark', stackExists: true, existing: [bucket.name],
            rejectImportFor: ['BenchmarkResultsTable'],
            fallbackChanges: [{ ResourceChange: { Action: 'Modify', ResourceType: 'AWS::Glue::Table', LogicalResourceId: 'BenchmarkResultsTable', Replacement: 'Conditional' } }]
        });
        await quietlyAsync(() => r.provision(PROFILE, { forceDeploy: true }));
        assert.deepStrictEqual(verbs(), ['create-change-set', 'delete-change-set',
            'create-change-set', 'wait:change-set-create-complete', 'describe-change-set',
            'execute-change-set', 'wait:stack-update-complete', 'deploy']);
        const retry = calls.filter(c => c[1] === 'create-change-set')[1];
        assert.strictEqual(retry[retry.indexOf('--change-set-type') + 1], 'UPDATE');
        assert.ok(retry.includes('--import-existing-resources'));
        assert.ok(!retry.includes('--resources-to-import'));
        assert.ok(state.owned.has(bucket.name));
    });

    it('fallback refuses anything beyond the bucket import and an in-place refresh of the named resource', async () => {
        const [bucket] = declaredBucketsFor('benchmark', PROFILE);
        for (const extra of [
            { ResourceChange: { Action: 'Modify', ResourceType: 'AWS::Glue::Table', LogicalResourceId: 'BenchmarkResultsTable', Replacement: 'True' } },
            { ResourceChange: { Action: 'Modify', ResourceType: 'AWS::Glue::Database', LogicalResourceId: 'GlueDatabase', Replacement: 'False' } },
            { ResourceChange: { Action: 'Add', ResourceType: 'AWS::IAM::Role', LogicalResourceId: 'NewRole' } }
        ]) {
            const { r, verbs } = simulatedRunner({
                module: 'benchmark', stack: 'benchmark', stackExists: true, existing: [bucket.name],
                rejectImportFor: ['BenchmarkResultsTable'], fallbackChanges: [extra]
            });
            await assert.rejects(() => quietlyAsync(() => r.provision(PROFILE, { forceDeploy: true })), /refusing to execute/);
            const v = verbs();
            assert.strictEqual(v.filter(x => x === 'delete-change-set').length, 2, 'both change sets deleted');
            assert.ok(!v.includes('execute-change-set') && !v.includes('deploy'));
        }
    });

    it('an IMPORT rejected for any other reason does not fall back', async () => {
        const names = declaredBucketsFor('training', PROFILE).map(b => b.name);
        const { r, verbs } = simulatedRunner({ stackExists: true, existing: names, rejectImportWith: 'ValidationError: Template format error' });
        await assert.rejects(() => quietlyAsync(() => r.provision(PROFILE, { forceDeploy: true })), /IMPORT change set failed/);
        assert.deepStrictEqual(verbs(), ['create-change-set', 'delete-change-set']);
    });

    it('modifiedResourcesFromImportError parses the CloudFormation message', () => {
        const msg = 'An error occurred (ValidationError) when calling the CreateChangeSet operation: You have modified resources [BenchmarkResultsTable, Other] in your template that are not being imported. Update, create or delete operations cannot be executed during import operations.';
        assert.deepStrictEqual(modifiedResourcesFromImportError(msg), ['BenchmarkResultsTable', 'Other']);
        assert.deepStrictEqual(modifiedResourcesFromImportError('Template format error'), []);
    });

    it('assertImportWithInPlaceRefresh: exact imports + in-place Modify of named resources only', () => {
        const imp = { ResourceChange: { Action: 'Import', ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'B' } };
        const mod = (rep) => ({ ResourceChange: { Action: 'Modify', ResourceType: 'AWS::Glue::Table', LogicalResourceId: 'T', Replacement: rep } });
        assert.doesNotThrow(() => assertImportWithInPlaceRefresh({ Changes: [imp, mod('Conditional')] }, ['B'], ['T']));
        assert.doesNotThrow(() => assertImportWithInPlaceRefresh({ Changes: [imp, mod('False')] }, ['B'], ['T']));
        assert.throws(() => assertImportWithInPlaceRefresh({ Changes: [imp, mod('True')] }, ['B'], ['T']), /refusing/);
        assert.throws(() => assertImportWithInPlaceRefresh({ Changes: [imp, mod('False')] }, ['B'], ['Other']), /refusing/);
        assert.throws(() => assertImportWithInPlaceRefresh({ Changes: [mod('False')] }, ['B'], ['T']), /Missing imports: B/);
    });

    it('fresh-stack path: a failed import after create aborts without the second deploy', async () => {
        const art = declaredBucketsFor('training', PROFILE).find(b => b.logicalId === 'ArtifactsBucket');
        const { r, verbs } = simulatedRunner({ stackExists: false, existing: [art.name], failDescribe: true });
        await assert.rejects(() => quietlyAsync(() => r.provision(PROFILE)), /aborted/);
        assert.deepStrictEqual(verbs().filter(v => v === 'deploy'), ['deploy']);
        assert.ok(verbs().includes('delete-change-set'));
    });

    it('a template over the 51,200-byte inline limit aborts before any change set', async () => {
        const names = declaredBucketsFor('training', PROFILE).map(b => b.name);
        const { r, verbs } = simulatedRunner({ stackExists: true, existing: names });
        r._getDeployedTemplate = () => ({ Resources: { Big: { Type: 'AWS::IAM::Role', Properties: { X: 'x'.repeat(52000) } } } });
        await assert.rejects(() => quietlyAsync(() => r.provision(PROFILE, { forceDeploy: true })), /51,200/);
        assert.deepStrictEqual(verbs(), []);
    });

    it('a stack without declared buckets keeps the old flow (no ownership query, no import)', async () => {
        const r = new CdkModuleRunner('registry', 'registry');
        const seen = [];
        r._cleanupUnupdatableStack = async () => {};
        r._stackOwnedBucketNames = () => { throw new Error('must not be called'); };
        r._aws = (_p, args) => { seen.push(args[1]); return ''; };
        r.status = async () => { seen.push('status'); return { state: 'provisioned' }; };
        r._cdkDeploy = () => seen.push('deploy');
        r._getStackOutputs = () => ({});
        await quietlyAsync(() => r.provision(PROFILE, { forceDeploy: true }));
        assert.deepStrictEqual(seen, ['deploy'], 'forceDeploy on a bucket-less stack: deploy only');
    });

    it('dry run (diff) shows planned imports read-only: no change set, no deploy, post-import diff', async () => {
        const names = declaredBucketsFor('training', PROFILE).map(b => b.name);
        const { r, verbs } = simulatedRunner({ stackExists: true, existing: names });
        let diffFlags;
        r._cdkDiff = (_p, flags) => { diffFlags = flags; };
        const logs = [];
        const orig = console.log;
        console.log = (m) => logs.push(String(m));
        try { await r.diff(PROFILE); } finally { console.log = orig; }
        assert.deepStrictEqual(verbs(), [], 'no AWS write: no change set, no deploy');
        assert.ok(logs.some(l => l.includes('Would import into') && names.every(n => l.includes(n))));
        assert.deepStrictEqual(bucketFlags(diffFlags), [], 'diff of an existing stack synthesizes post-import (no adopt flag)');
    });

    it('dry run on a not-yet-created stack previews create-then-import and diffs the create template', async () => {
        const art = declaredBucketsFor('training', PROFILE).find(b => b.logicalId === 'ArtifactsBucket');
        const { r, verbs } = simulatedRunner({ stackExists: false, existing: [art.name] });
        let diffFlags;
        r._cdkDiff = (_p, flags) => { diffFlags = flags; };
        const logs = [];
        const orig = console.log;
        console.log = (m) => logs.push(String(m));
        try { await r.diff(PROFILE); } finally { console.log = orig; }
        assert.deepStrictEqual(verbs(), []);
        assert.ok(logs.some(l => l.includes(art.name) && l.includes('then imported in the same run')));
        assert.deepStrictEqual(bucketFlags(diffFlags), [`--context ${art.adoptContext}=true`]);
    });

    it('cdk diff runs with --method template (the default would create a change set)', () => {
        const src = readFileSync(new URL('../../infra/bootstrap-modules/module-runner.cjs', import.meta.url), 'utf8');
        const body = src.slice(src.indexOf('    _cdkDiff(profile, adoptFlags) {'));
        assert.ok(body.slice(0, 800).includes('\'--method template\''));
    });
});

describe('CdkMultiStackModuleRunner — implicit import for bucket-owning stacks (R1.5)', () => {
    it('inference-operator: an unowned TLS bucket is imported (with SSM synth context) before the deploy', async () => {
        const [tls] = declaredBucketsFor('inference-operator', PROFILE);
        const { r, verbs, state } = simulatedRunner({ module: 'hyperpod', stack: 'inference-operator', stackExists: true, existing: [tls.name] });
        let synthCtx;
        const origSynth = r._synthTemplate;
        r._synthTemplate = (p, ctx) => { synthCtx = ctx; return origSynth(p, ctx); };
        const multi = new CdkMultiStackModuleRunner('hyperpod', ['inference-operator']);
        const deploys = [];
        multi._cdkDeployStack = () => { deploys.push('deploy'); };
        await quietlyAsync(() => multi._provisionStack(r, 'inference-operator', PROFILE, { forceDeploy: true }, { EksClusterName: 'zz-eks' }));
        assert.deepStrictEqual(verbs(), IMPORT_SEQUENCE);
        assert.deepStrictEqual(deploys, ['deploy']);
        assert.deepStrictEqual(synthCtx, { EksClusterName: 'zz-eks' });
        assert.ok(state.owned.has(tls.name));
    });

    it('eks-cluster / hyperpod-cluster declare no buckets — the multi-stack path never imports there', async () => {
        for (const stack of ['eks-cluster', 'hyperpod-cluster']) {
            assert.deepStrictEqual(declaredBucketsFor(stack, PROFILE), []);
            const r = new CdkModuleRunner('hyperpod', stack);
            r._cleanupUnupdatableStack = async () => {};
            r._stackOwnedBucketNames = () => { throw new Error('must not be called'); };
            r._aws = () => { throw new Error('no AWS call expected'); };
            r._getStackOutputs = () => ({});
            const multi = new CdkMultiStackModuleRunner('hyperpod', [stack]);
            const deploys = [];
            multi._cdkDeployStack = () => { deploys.push(stack); };
            await quietlyAsync(() => multi._provisionStack(r, stack, PROFILE, { forceDeploy: true }, {}));
            assert.deepStrictEqual(deploys, [stack]);
        }
    });
});

describe('import-buckets subcommand is retired (R1.5: import is implicit)', () => {
    it('no handler method, no runner method, no help line', () => {
        const h = new BootstrapCommandHandler();
        assert.strictEqual(typeof h._handleImportBuckets, 'undefined');
        assert.strictEqual(typeof CdkModuleRunner.prototype.importBuckets, 'undefined');
        const logs = [];
        const orig = console.log;
        console.log = (m) => logs.push(String(m));
        try { h._showHelp(); } finally { console.log = orig; }
        assert.ok(!logs.join('\n').includes('import-buckets'));
    });
});

describe('remove-module persistent-bucket warning derives from the declarations (R1.2)', () => {
    it('lists every declared bucket of the removed modules — not a hand-copied subset', () => {
        const logs = [];
        const orig = console.log;
        console.log = (m) => logs.push(String(m));
        try {
            new BootstrapCommandHandler()._warnPersistentBuckets(['training', 'core', 'ci'],
                { accountId: PROFILE.accountId, awsRegion: PROFILE.awsRegion }, PROFILE.profileName);
        } finally { console.log = orig; }
        const expected = ['training', 'core', 'ci'].flatMap(s => declaredBucketsFor(s, PROFILE).map(b => `s3://${b.name}`));
        for (const name of expected) assert.ok(logs.some(l => l.includes(name)), `warning lists ${name}`);
        assert.ok(!logs.some(l => l.includes('import-buckets')), 'no retired command is suggested');
        assert.ok(logs.some(l => l.includes('bootstrap update')) && logs.some(l => l.includes('automatically')),
            're-adding the module (or bootstrap update) re-imports automatically');
    });
});
