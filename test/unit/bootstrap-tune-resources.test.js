// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Stack — Tune Resources Validation
 *
 * Validates that the bootstrap CloudFormation template contains the required
 * resources and IAM permissions for the managed model customization (tune) feature:
 * - TuneS3Bucket resource with correct properties
 * - SageMakerModelCustomization IAM statement with all required actions
 * - SageMakerMLflow IAM statement with sagemaker-mlflow:*
 * - LambdaInvokeForReward IAM statement with lambda:InvokeFunction
 * - PassRoleToSageMaker IAM statement with iam:PassRole
 * - TuneS3BucketName output
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.6, 10.7, 10.8
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Bootstrap Stack — Tune Resources', () => {
    let template;
    let resources;
    let outputs;
    let conditions;
    let policyStatements;

    before(() => {
        const templatePath = resolve(__dirname, '../../config/bootstrap-stack.json');
        template = JSON.parse(readFileSync(templatePath, 'utf8'));
        resources = template.Resources;
        outputs = template.Outputs;
        conditions = template.Conditions;

        // Extract IAM policy statements from SageMakerExecutionRole
        const role = resources.SageMakerExecutionRole;
        const policy = role.Properties.Policies[0];
        policyStatements = policy.PolicyDocument.Statement;
    });

    describe('TuneS3Bucket resource', () => {
        it('should exist in the template', () => {
            assert.ok(
                resources.TuneS3Bucket,
                'TuneS3Bucket resource should exist'
            );
        });

        it('should be of type AWS::S3::Bucket', () => {
            assert.strictEqual(
                resources.TuneS3Bucket.Type,
                'AWS::S3::Bucket',
                'TuneS3Bucket should be an S3 bucket'
            );
        });

        it('should be gated on ShouldCreateS3Buckets condition', () => {
            assert.strictEqual(
                resources.TuneS3Bucket.Condition,
                'ShouldCreateS3Buckets',
                'TuneS3Bucket should have Condition: ShouldCreateS3Buckets'
            );
        });

        it('should have correct bucket name pattern (mlcc-tune-${AccountId}-${Region})', () => {
            const bucketName = resources.TuneS3Bucket.Properties.BucketName;
            assert.ok(bucketName['Fn::Sub'], 'BucketName should use Fn::Sub');
            assert.strictEqual(
                bucketName['Fn::Sub'],
                'mlcc-tune-${AWS::AccountId}-${AWS::Region}',
                'BucketName should follow mlcc-tune-${AccountId}-${Region} pattern'
            );
        });

        it('should have versioning enabled', () => {
            const versioning = resources.TuneS3Bucket.Properties.VersioningConfiguration;
            assert.ok(versioning, 'VersioningConfiguration should exist');
            assert.strictEqual(
                versioning.Status,
                'Enabled',
                'Versioning should be enabled'
            );
        });

        it('should have AES256 server-side encryption', () => {
            const encryption = resources.TuneS3Bucket.Properties.BucketEncryption;
            assert.ok(encryption, 'BucketEncryption should exist');

            const sseConfig = encryption.ServerSideEncryptionConfiguration;
            assert.ok(Array.isArray(sseConfig), 'ServerSideEncryptionConfiguration should be an array');
            assert.ok(sseConfig.length > 0, 'Should have at least one encryption rule');

            const algorithm = sseConfig[0].ServerSideEncryptionByDefault.SSEAlgorithm;
            assert.strictEqual(algorithm, 'AES256', 'Should use AES256 encryption');
        });

        it('should have DeletionPolicy set to Retain', () => {
            assert.strictEqual(
                resources.TuneS3Bucket.DeletionPolicy,
                'Retain',
                'DeletionPolicy should be Retain'
            );
        });
    });

    describe('ShouldCreateS3Buckets condition', () => {
        it('should exist in the template', () => {
            assert.ok(
                conditions.ShouldCreateS3Buckets,
                'ShouldCreateS3Buckets condition should exist'
            );
        });

        it('should check CreateS3Buckets parameter equals "true"', () => {
            const condition = conditions.ShouldCreateS3Buckets;
            assert.ok(condition['Fn::Equals'], 'Should use Fn::Equals');

            const equalsArgs = condition['Fn::Equals'];
            assert.strictEqual(equalsArgs.length, 2, 'Fn::Equals should have two arguments');

            // One arg should reference CreateS3Buckets, the other should be "true"
            const refArg = equalsArgs.find(a => a.Ref === 'CreateS3Buckets');
            assert.ok(refArg, 'Should reference CreateS3Buckets parameter');
            assert.ok(
                equalsArgs.includes('true'),
                'Should compare against "true"'
            );
        });
    });

    describe('SageMakerModelCustomization IAM statement', () => {
        let statement;

        before(() => {
            statement = policyStatements.find(s => s.Sid === 'SageMakerModelCustomization');
        });

        it('should exist', () => {
            assert.ok(statement, 'SageMakerModelCustomization statement should exist');
        });

        it('should have Effect: Allow', () => {
            assert.strictEqual(statement.Effect, 'Allow');
        });

        it('should include all required SageMaker actions', () => {
            const requiredActions = [
                'sagemaker:CreateTrainingJob',
                'sagemaker:DescribeTrainingJob',
                'sagemaker:ListTrainingJobs',
                'sagemaker:StopTrainingJob',
                'sagemaker:CreateModelPackage',
                'sagemaker:CreateModelPackageGroup',
                'sagemaker:DescribeModelPackage',
                'sagemaker:DescribeModelPackageGroup',
                'sagemaker:ListModelPackages',
                'sagemaker:CallMlflowAppApi'
            ];

            for (const action of requiredActions) {
                assert.ok(
                    statement.Action.includes(action),
                    `Should include action: ${action}`
                );
            }
        });

        it('should have Resource: "*"', () => {
            assert.strictEqual(statement.Resource, '*');
        });
    });

    describe('SageMakerMLflow IAM statement', () => {
        let statement;

        before(() => {
            statement = policyStatements.find(s => s.Sid === 'SageMakerMLflow');
        });

        it('should exist', () => {
            assert.ok(statement, 'SageMakerMLflow statement should exist');
        });

        it('should have Effect: Allow', () => {
            assert.strictEqual(statement.Effect, 'Allow');
        });

        it('should grant sagemaker-mlflow:* action', () => {
            assert.strictEqual(
                statement.Action,
                'sagemaker-mlflow:*',
                'Should grant sagemaker-mlflow:* action'
            );
        });

        it('should have Resource: "*"', () => {
            assert.strictEqual(statement.Resource, '*');
        });
    });

    describe('LambdaInvokeForReward IAM statement', () => {
        let statement;

        before(() => {
            statement = policyStatements.find(s => s.Sid === 'LambdaInvokeForReward');
        });

        it('should exist', () => {
            assert.ok(statement, 'LambdaInvokeForReward statement should exist');
        });

        it('should have Effect: Allow', () => {
            assert.strictEqual(statement.Effect, 'Allow');
        });

        it('should grant lambda:InvokeFunction action', () => {
            assert.strictEqual(
                statement.Action,
                'lambda:InvokeFunction',
                'Should grant lambda:InvokeFunction action'
            );
        });

        it('should scope resource to Lambda functions in the account', () => {
            const resource = statement.Resource;
            assert.ok(resource['Fn::Sub'], 'Resource should use Fn::Sub');
            assert.ok(
                resource['Fn::Sub'].includes('arn:aws:lambda:'),
                'Resource ARN should reference Lambda service'
            );
            assert.ok(
                resource['Fn::Sub'].includes(':function:*'),
                'Resource ARN should scope to functions'
            );
        });
    });

    describe('PassRoleToSageMaker IAM statement', () => {
        let statement;

        before(() => {
            statement = policyStatements.find(s => s.Sid === 'PassRoleToSageMaker');
        });

        it('should exist', () => {
            assert.ok(statement, 'PassRoleToSageMaker statement should exist');
        });

        it('should have Effect: Allow', () => {
            assert.strictEqual(statement.Effect, 'Allow');
        });

        it('should grant iam:PassRole action', () => {
            assert.strictEqual(
                statement.Action,
                'iam:PassRole',
                'Should grant iam:PassRole action'
            );
        });

        it('should have a condition restricting to sagemaker.amazonaws.com', () => {
            assert.ok(statement.Condition, 'Should have a Condition');
            assert.ok(
                statement.Condition.StringEquals,
                'Should use StringEquals condition'
            );
            assert.strictEqual(
                statement.Condition.StringEquals['iam:PassedToService'],
                'sagemaker.amazonaws.com',
                'Should restrict PassRole to sagemaker.amazonaws.com'
            );
        });
    });

    describe('TuneS3BucketName output', () => {
        it('should exist', () => {
            assert.ok(
                outputs.TuneS3BucketName,
                'TuneS3BucketName output should exist'
            );
        });

        it('should be gated on ShouldCreateS3Buckets condition', () => {
            assert.strictEqual(
                outputs.TuneS3BucketName.Condition,
                'ShouldCreateS3Buckets',
                'TuneS3BucketName output should have Condition: ShouldCreateS3Buckets'
            );
        });

        it('should reference the TuneS3Bucket resource', () => {
            const value = outputs.TuneS3BucketName.Value;
            assert.ok(
                value.Ref === 'TuneS3Bucket',
                'TuneS3BucketName output should reference TuneS3Bucket'
            );
        });

        it('should have a description', () => {
            assert.ok(
                outputs.TuneS3BucketName.Description,
                'TuneS3BucketName output should have a description'
            );
        });
    });
});
