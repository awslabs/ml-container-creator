// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Push Template Unit Tests
 *
 * Verifies that the do/push template:
 * - No longer contains `create-repository` logic
 * - Contains the ECR existence check via `describe-repositories`
 * - Contains the bootstrap suggestion message
 * - Exits with code 4 when the repository is not found
 *
 * Validates: Requirements 13.1, 13.2, 13.3
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.resolve(__dirname, '../../generators/app/templates/do/push');
const templateContent = readFileSync(templatePath, 'utf-8');

describe('do/push template — bootstrap changes', () => {
    describe('Requirement 13.3: removed create-repository logic', () => {
        it('should NOT contain "create-repository"', () => {
            assert.ok(
                !templateContent.includes('create-repository'),
                'Template should not contain "create-repository" — ECR creation is now handled by bootstrap'
            );
        });

        it('should NOT contain "ecr create-repository"', () => {
            assert.ok(
                !templateContent.includes('ecr create-repository'),
                'Template should not contain "ecr create-repository" command'
            );
        });
    });

    describe('Requirement 13.1: ECR existence check via describe-repositories', () => {
        it('should contain "describe-repositories"', () => {
            assert.ok(
                templateContent.includes('describe-repositories'),
                'Template should use "describe-repositories" to check if the ECR repository exists'
            );
        });

        it('should call aws ecr describe-repositories', () => {
            assert.ok(
                templateContent.includes('aws ecr describe-repositories'),
                'Template should call "aws ecr describe-repositories" for the existence check'
            );
        });
    });

    describe('Requirement 13.2: bootstrap suggestion message', () => {
        it('should contain the bootstrap suggestion message', () => {
            assert.ok(
                templateContent.includes('Run \'yo @aws/ml-container-creator bootstrap\' to create it.'),
                'Template should tell the user to run bootstrap when the ECR repository is not found'
            );
        });

        it('should contain "not found" error messaging', () => {
            assert.ok(
                templateContent.includes('not found'),
                'Template should indicate the ECR repository was not found'
            );
        });
    });

    describe('Requirement 13.2: exit code for missing repository', () => {
        it('should exit with code 4 when the repository is not found', () => {
            // Find the describe-repositories block and verify exit 4 follows
            const describeIndex = templateContent.indexOf('describe-repositories');
            const bootstrapMsgIndex = templateContent.indexOf('Run \'yo @aws/ml-container-creator bootstrap\' to create it.');
            const exitAfterMsg = templateContent.indexOf('exit 4', bootstrapMsgIndex);

            assert.ok(describeIndex !== -1, 'describe-repositories should be present');
            assert.ok(bootstrapMsgIndex !== -1, 'bootstrap suggestion message should be present');
            assert.ok(exitAfterMsg !== -1, 'exit 4 should follow the bootstrap suggestion message');
        });
    });
});
