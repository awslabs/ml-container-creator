// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * CDK assertion tests for the bucket-owning bootstrap stacks (bucket consolidation
 * R1.1-R1.4, R1.6). Runs infra/bootstrap-modules/test/bucket-stacks.assertions.ts
 * through ts-node: it synthesizes core / training / benchmark / ci in-process with
 * aws-cdk-lib/assertions (offline — no AWS calls, no cdk CLI) and checks:
 *   - every bucket is DeletionPolicy + UpdateReplacePolicy Retain;
 *   - training ArtifactsBucket: versioning OFF, lifecycle = abort-incomplete-MPU 7d
 *     only, ArtifactsBucketOutput exported; the training role is gone;
 *   - core models bucket: versioned + NoncurrentVersionExpiration 30d + abort 7d;
 *   - adopt mode (pre-import) synthesizes no bucket resource but keeps outputs;
 *   - names equal the bucket-declarations.cjs rendering (TS and CJS agree).
 * It then asserts the buckets' logical IDs are the stable, construct-path-derived IDs
 * the one-time `bootstrap import-buckets` imports under.
 */
import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBootstrapModulesDeps } from '../helpers/bootstrap-modules-deps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES_ROOT = resolve(__dirname, '../../infra/bootstrap-modules');
const require = createRequire(import.meta.url);
const { declaredBucketsForStack } = require('../../infra/bootstrap-modules/bucket-declarations.cjs');

describe('bootstrap bucket stacks — CDK assertions (bucket consolidation R1)', function () {
    this.timeout(180000);

    const tsNodeRegister = resolve(MODULES_ROOT, 'node_modules/ts-node/register/index.js');

    let result;
    before(function () {
        requireBootstrapModulesDeps(this); // skip locally without deps; fail in CI (BL238)
        const expected = {};
        for (const stack of ['core', 'training', 'benchmark', 'ci']) {
            for (const b of declaredBucketsForStack(stack, { account: '111111111111', region: 'us-west-2', profileName: 'zz-test' })) {
                expected[`${stack}/${b.logicalId}`] = b.name;
            }
        }
        const out = execFileSync(process.execPath, ['-r', tsNodeRegister, 'test/bucket-stacks.assertions.ts'], {
            cwd: MODULES_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', MLCC_EXPECTED_BUCKETS: JSON.stringify(expected) }
        });
        const line = out.trim().split('\n').reverse().find(l => l.startsWith('{"ok"'));
        assert.ok(line, `assertion script printed no summary:\n${out}`);
        result = JSON.parse(line);
    });

    it('all stack-level assertions pass (Retain, lifecycle, versioning, outputs, no training role)', () => {
        assert.strictEqual(result.ok, true);
    });

    it('buckets keep stable construct-path logical IDs (the import targets)', () => {
        // Construct IDs are the buckets.json keys; CDK derives the logical ID from the
        // construct path, so a renamed construct would silently change the import target.
        assert.match(result.logicalIds.training.artifactsId, /^ArtifactsBucket[0-9A-F]{8}$/);
        assert.strictEqual(result.logicalIds.training.trainingId, 'TrainingBucketEB7BB5C9');
        assert.strictEqual(result.logicalIds.training.adaptersId, 'AdaptersBucket91CC3455');
        assert.strictEqual(result.logicalIds.core.modelsId, 'ModelsBucketResource2D4F0B9A');
        assert.strictEqual(result.logicalIds.benchmark.benchmarkId, 'BenchmarkBucketDD7D1D2F');
        assert.strictEqual(result.logicalIds.ci.sourceId, 'SourceBucketResourceB217D9BF');
    });
});
