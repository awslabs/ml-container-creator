// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Stack — SecretsManager IAM Policy Unit Tests
 *
 * Parses config/bootstrap-stack.json and asserts the SecretsManagerRead
 * IAM policy statement exists with the correct actions, resource pattern,
 * and tag-based condition.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 */

import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Bootstrap Stack — SecretsManagerRead IAM Policy', () => {
    let template;
    let statements;
    let secretsStatement;

    before(() => {
        const templatePath = resolve('config/bootstrap-stack.json');
        template = JSON.parse(readFileSync(templatePath, 'utf-8'));

        // Navigate to the mlcc-execution-policy inline policy Statement array
        const role = template.Resources.SageMakerExecutionRole;
        const policies = role.Properties.Policies;
        const executionPolicy = policies.find(p => p.PolicyName === 'mlcc-execution-policy');
        statements = executionPolicy.PolicyDocument.Statement;

        // Find the SecretsManagerRead statement
        secretsStatement = statements.find(s => s.Sid === 'SecretsManagerRead');
    });

    it('should contain a statement with Sid "SecretsManagerRead"', () => {
        assert.ok(secretsStatement, 'Expected a statement with Sid "SecretsManagerRead" in mlcc-execution-policy');
    });

    it('should have Effect set to "Allow"', () => {
        assert.strictEqual(secretsStatement.Effect, 'Allow');
    });

    it('should grant secretsmanager:GetSecretValue action', () => {
        assert.ok(
            secretsStatement.Action.includes('secretsmanager:GetSecretValue'),
            'Expected Action to include secretsmanager:GetSecretValue'
        );
    });

    it('should grant secretsmanager:DescribeSecret action', () => {
        assert.ok(
            secretsStatement.Action.includes('secretsmanager:DescribeSecret'),
            'Expected Action to include secretsmanager:DescribeSecret'
        );
    });

    it('should have exactly two actions', () => {
        assert.strictEqual(secretsStatement.Action.length, 2, 'Expected exactly 2 actions');
    });

    it('should scope Resource to arn:aws:secretsmanager:*:*:secret:mlcc/*', () => {
        assert.strictEqual(
            secretsStatement.Resource,
            'arn:aws:secretsmanager:*:*:secret:mlcc/*',
            'Expected Resource to match the mlcc/* naming pattern'
        );
    });

    it('should include a StringEquals condition on aws:ResourceTag/mlcc:managed-by', () => {
        assert.ok(secretsStatement.Condition, 'Expected a Condition block');
        assert.ok(secretsStatement.Condition.StringEquals, 'Expected a StringEquals condition');
        assert.strictEqual(
            secretsStatement.Condition.StringEquals['aws:ResourceTag/mlcc:managed-by'],
            'ml-container-creator',
            'Expected condition to require mlcc:managed-by = ml-container-creator'
        );
    });

    it('should be part of the mlcc-execution-policy inline policy on SageMakerExecutionRole', () => {
        const role = template.Resources.SageMakerExecutionRole;
        assert.strictEqual(role.Type, 'AWS::IAM::Role');

        const policy = role.Properties.Policies.find(p => p.PolicyName === 'mlcc-execution-policy');
        assert.ok(policy, 'Expected mlcc-execution-policy to exist on the role');

        const stmt = policy.PolicyDocument.Statement.find(s => s.Sid === 'SecretsManagerRead');
        assert.ok(stmt, 'Expected SecretsManagerRead statement within mlcc-execution-policy');
    });
});
