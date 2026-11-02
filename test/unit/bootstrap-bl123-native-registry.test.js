// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BL123 (native AI Registry) bootstrap wiring.
 *
 * Offline / source-level only — NO cdk synth, NO AWS. Asserts:
 *  - _denormalizeModuleOutputs captures the Studio DomainId from the
 *    sagemaker-domain module into profile.domainId (Req 3.2), and the registry
 *    module now denormalizes to modelPackageGroupName (the branded
 *    aiRegistryHubName was retired, Req 9.1/9.3).
 *  - The registry CDK stack no longer provisions a branded AI Registry Hub
 *    (no createHub / AiRegistryHub custom resource), but keeps the Model
 *    Package Group (Req 9.1).
 *  - The core execution role (the role ai_registry creates run as — profile
 *    roleArn) carries every launch-gate action. The former training role and its
 *    MlccLaunchGate statement were deleted (bucket consolidation D4: never assumed).
 *    with the 11 required actions (Req 8 / BL123 sole-writer).
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

describe('BL123 native AI Registry — bootstrap wiring', () => {
    describe('_denormalizeModuleOutputs', () => {
        it('captures sagemaker-domain DomainId into profile.domainId', () => {
            const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
            const profileData = {
                moduleOutputs: {
                    'sagemaker-domain': { DomainId: 'd-abc123', UserProfileName: 'u' }
                }
            };
            handler._denormalizeModuleOutputs(profileData);
            assert.strictEqual(profileData.domainId, 'd-abc123');
        });

        it('leaves domainId undefined when sagemaker-domain not provisioned', () => {
            const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
            const profileData = { moduleOutputs: { core: { RoleArn: 'arn:role' } } };
            handler._denormalizeModuleOutputs(profileData);
            assert.strictEqual(profileData.domainId, undefined);
        });

        it('denormalizes registry to modelPackageGroupName (not aiRegistryHubName)', () => {
            const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
            const profileData = {
                moduleOutputs: {
                    registry: { ModelPackageGroupName: 'mlcc-default-models' }
                }
            };
            handler._denormalizeModuleOutputs(profileData);
            assert.strictEqual(profileData.modelPackageGroupName, 'mlcc-default-models');
            assert.strictEqual(profileData.aiRegistryHubName, undefined,
                'the branded aiRegistryHubName must no longer be denormalized');
        });

        it('tolerates a leftover aiRegistryHubName on an existing profile', () => {
            const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
            // A pre-BL123 profile may still carry the stale key; denormalization
            // must not throw and must not re-derive it.
            const profileData = {
                aiRegistryHubName: 'mlcc-registry-123456789012',
                moduleOutputs: { registry: { ModelPackageGroupName: 'mlcc-default-models' } }
            };
            handler._denormalizeModuleOutputs(profileData);
            assert.strictEqual(profileData.modelPackageGroupName, 'mlcc-default-models');
        });
    });

    describe('registry CDK stack (source)', () => {
        const stackSrc = readFileSync(
            resolve(PROJECT_ROOT, 'infra/bootstrap-modules/registry/stack.ts'), 'utf8');

        it('still provisions the Model Package Group', () => {
            assert.match(stackSrc, /CfnModelPackageGroup/);
            assert.match(stackSrc, /ModelPackageGroupName/);
        });

        it('no longer provisions a branded AI Registry Hub', () => {
            // Strip comments so a retirement note that *mentions* the old
            // machinery doesn't trip the guard — only live code counts.
            const code = stackSrc
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n')
                .map(l => l.replace(/\/\/.*$/, ''))
                .join('\n');
            assert.doesNotMatch(code, /AiRegistryHub/,
                'the AiRegistryHub custom resource must be retired from code');
            assert.doesNotMatch(code, /createHub|CreateHub/i,
                'no createHub custom-resource call should remain in code');
            assert.doesNotMatch(code, /AwsCustomResource/,
                'the hub AwsCustomResource must be retired');
        });
    });

    describe('core CDK stack (source) — launch gate on the execution role', () => {
        const stackSrc = readFileSync(
            resolve(PROJECT_ROOT, 'infra/bootstrap-modules/core/stack.ts'), 'utf8');
        const trainingSrc = readFileSync(
            resolve(PROJECT_ROOT, 'infra/bootstrap-modules/training/stack.ts'), 'utf8');

        const LAUNCH_GATE_ACTIONS = [
            'cloudwatch:PutMetricData',
            'ecr:GetAuthorizationToken',
            'ec2:CreateNetworkInterface',
            'ec2:CreateNetworkInterfacePermission',
            'ec2:DeleteNetworkInterface',
            'ec2:DeleteNetworkInterfacePermission',
            'ec2:DescribeDhcpOptions',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DescribeSecurityGroups',
            'ec2:DescribeSubnets',
            'ec2:DescribeVpcs'
        ];

        it('the unused training role (and its launch-gate copy) is gone (D4)', () => {
            assert.doesNotMatch(trainingSrc, /new iam\.Role\(this, 'TrainingRole'/);
            assert.doesNotMatch(trainingSrc, /sid:\s*'MlccLaunchGate'/);
        });

        it('the core execution role grants all 11 launch-gate actions', () => {
            for (const action of LAUNCH_GATE_ACTIONS) {
                assert.ok(stackSrc.includes(`'${action}'`),
                    `core execution role must include ${action}`);
            }
        });
    });
});
