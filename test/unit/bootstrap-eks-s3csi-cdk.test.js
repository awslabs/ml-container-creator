// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * CDK assertion tests for the bootstrap eks module's S3 CSI fixes (Wave 6.1 R5).
 * Runs infra/bootstrap-modules/test/eks-s3csi.assertions.ts through ts-node: it
 * synthesizes the eks-cluster stack in-process with aws-cdk-lib/assertions (offline)
 * and checks the add-on ↔ role attachment (R5.1), the read grants on the core /
 * training / adapters buckets and the real MLCC TLS bucket name (R5.2), and that the
 * add-on keeps its logical ID and version (R5.3 in-place; no v1→v2 bump).
 * Expected bucket names are rendered by bucket-declarations.cjs, so the TS stack and
 * the CJS renderer of the buckets.json declarations must agree.
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

describe('bootstrap eks module — S3 CSI add-on role + grants (Wave 6.1 R5)', function () {
    this.timeout(180000);
    const tsNodeRegister = resolve(MODULES_ROOT, 'node_modules/ts-node/register/index.js');
    let result;

    before(function () {
        requireBootstrapModulesDeps(this); // skip locally without deps; fail in CI (BL238)
        const vars = { account: '111111111111', region: 'us-west-2', profileName: 'zz-test' };
        const byId = (stack, id) => {
            const hit = declaredBucketsForStack(stack, vars).find(b => b.logicalId === id);
            assert.ok(hit, `no ${stack}/${id} bucket declaration`);
            return hit.name;
        };
        const names = {
            core: byId('core', 'ModelsBucketResource'),
            training: byId('training', 'TrainingBucket'),
            adapters: byId('training', 'AdaptersBucket'),
            tls: byId('inference-operator', 'TlsBucket')
        };
        const out = execFileSync(process.execPath, ['-r', tsNodeRegister, 'test/eks-s3csi.assertions.ts'], {
            cwd: MODULES_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', MLCC_EXPECTED_NAMES: JSON.stringify(names) }
        });
        const line = out.trim().split('\n').reverse().find(l => l.startsWith('{"ok"'));
        assert.ok(line, `assertion script printed no summary:\n${out}`);
        result = JSON.parse(line);
    });

    it('all R5 assertions pass', () => {
        assert.strictEqual(result.ok, true);
    });

    it('the add-on keeps its logical ID (in-place update, no replacement)', () => {
        assert.strictEqual(result.addonLogicalId, 'S3CsiDriverAddon');
    });

    it('ServiceAccountRoleArn is the S3CsiRole ARN', () => {
        assert.deepStrictEqual(result.serviceAccountRoleArn, { 'Fn::GetAtt': [result.roleLogicalId, 'Arn'] });
    });
});
