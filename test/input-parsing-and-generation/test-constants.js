// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Constants - Shared constants for consistent testing
 */

// Standard test AWS role ARN used across all tests
export const TEST_AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/TestRole';

// Alternative test role for testing different scenarios
export const TEST_AWS_ROLE_ARN_ALT = 'arn:aws:iam::123456789012:role/AlternativeTestRole';

// Test AWS account ID
export const TEST_AWS_ACCOUNT_ID = '123456789012';

// Standard test project configurations
export const TEST_CONFIGS = {
    MINIMAL_SKLEARN: {
        framework: 'sklearn',
        modelServer: 'flask',
        modelFormat: 'pkl',
        deployTarget: 'sagemaker',
        instanceType: 'cpu-optimized',
        awsRegion: 'us-east-1',
        awsRoleArn: TEST_AWS_ROLE_ARN,
        includeSampleModel: false,
        includeTesting: false,
        destinationDir: '.'
    },
    
    MINIMAL_CODEBUILD: {
        framework: 'sklearn',
        modelServer: 'flask',
        modelFormat: 'pkl',
        deployTarget: 'codebuild',
        codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
        codebuildProjectName: 'test-project-build',
        instanceType: 'cpu-optimized',
        awsRegion: 'us-east-1',
        awsRoleArn: TEST_AWS_ROLE_ARN,
        includeSampleModel: false,
        includeTesting: false,
        destinationDir: '.'
    },
    
    TRANSFORMERS_VLLM: {
        framework: 'transformers',
        modelServer: 'vllm',
        modelFormat: null,
        deployTarget: 'sagemaker',
        instanceType: 'gpu-enabled',
        awsRegion: 'us-east-1',
        awsRoleArn: TEST_AWS_ROLE_ARN,
        includeSampleModel: false,
        includeTesting: false,
        destinationDir: '.'
    }
};

export default {
    TEST_AWS_ROLE_ARN,
    TEST_AWS_ROLE_ARN_ALT,
    TEST_AWS_ACCOUNT_ID,
    TEST_CONFIGS
};