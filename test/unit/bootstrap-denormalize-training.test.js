// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Training-module denormalization unit tests.
 *
 * Regression coverage for BL056: the training module provisions a
 * TrainingBucket (dataset staging) and an AdaptersBucket (LoRA adapter
 * staging) and exports them via CfnOutput. BootstrapCommandHandler
 * ._denormalizeModuleOutputs() is responsible for bridging the nested
 * `moduleOutputs.training.{TrainingBucket,AdaptersBucket}` values onto the
 * flat profile keys `trainingS3Bucket` / `adapterS3Bucket` that
 * templates/do/lib/profile.sh reads. Before the fix it mapped only
 * MlflowAppArn, so both buckets resolved empty and do/train / do/adapter
 * fell back to invented, never-provisioned bucket names.
 *
 * These tests pin the mapping so the regression cannot silently return.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

describe('BootstrapCommandHandler._denormalizeModuleOutputs — training buckets', () => {
    it('maps moduleOutputs.training.TrainingBucket → trainingS3Bucket', () => {
        const handler = new BootstrapCommandHandler();
        const profile = {
            moduleOutputs: {
                training: { TrainingBucket: 'mlcc-training-111122223333-us-east-1' }
            }
        };
        handler._denormalizeModuleOutputs(profile);
        assert.strictEqual(profile.trainingS3Bucket, 'mlcc-training-111122223333-us-east-1');
    });

    it('maps moduleOutputs.training.AdaptersBucket → adapterS3Bucket', () => {
        const handler = new BootstrapCommandHandler();
        const profile = {
            moduleOutputs: {
                training: { AdaptersBucket: 'mlcc-training-adapters-111122223333-us-east-1' }
            }
        };
        handler._denormalizeModuleOutputs(profile);
        assert.strictEqual(profile.adapterS3Bucket, 'mlcc-training-adapters-111122223333-us-east-1');
    });

    it('maps all three training outputs together (MlflowAppArn + both buckets)', () => {
        const handler = new BootstrapCommandHandler();
        const profile = {
            moduleOutputs: {
                training: {
                    MlflowAppArn: 'arn:aws:sagemaker:us-east-1:111122223333:mlflow-tracking-server/app',
                    TrainingBucket: 'mlcc-training-111122223333-us-east-1',
                    AdaptersBucket: 'mlcc-training-adapters-111122223333-us-east-1'
                }
            }
        };
        handler._denormalizeModuleOutputs(profile);
        assert.strictEqual(profile.mlflowAppArn, 'arn:aws:sagemaker:us-east-1:111122223333:mlflow-tracking-server/app');
        assert.strictEqual(profile.trainingS3Bucket, 'mlcc-training-111122223333-us-east-1');
        assert.strictEqual(profile.adapterS3Bucket, 'mlcc-training-adapters-111122223333-us-east-1');
    });

    it('leaves bucket keys undefined when the training module is not provisioned', () => {
        const handler = new BootstrapCommandHandler();
        const profile = { moduleOutputs: {} };
        handler._denormalizeModuleOutputs(profile);
        assert.strictEqual(profile.trainingS3Bucket, undefined);
        assert.strictEqual(profile.adapterS3Bucket, undefined);
    });

    it('leaves bucket keys undefined when training outputs are present but empty', () => {
        const handler = new BootstrapCommandHandler();
        const profile = { moduleOutputs: { training: {} } };
        handler._denormalizeModuleOutputs(profile);
        assert.strictEqual(profile.trainingS3Bucket, undefined);
        assert.strictEqual(profile.adapterS3Bucket, undefined);
    });

    it('does not throw when profileData has no moduleOutputs at all', () => {
        const handler = new BootstrapCommandHandler();
        const profile = {};
        assert.doesNotThrow(() => handler._denormalizeModuleOutputs(profile));
        assert.strictEqual(profile.trainingS3Bucket, undefined);
        assert.strictEqual(profile.adapterS3Bucket, undefined);
    });

    it('maps TrainingBucket independently of AdaptersBucket (only one present)', () => {
        const handler = new BootstrapCommandHandler();
        const profile = {
            moduleOutputs: { training: { TrainingBucket: 'mlcc-training-444455556666-eu-west-1' } }
        };
        handler._denormalizeModuleOutputs(profile);
        assert.strictEqual(profile.trainingS3Bucket, 'mlcc-training-444455556666-eu-west-1');
        assert.strictEqual(profile.adapterS3Bucket, undefined);
    });
});
