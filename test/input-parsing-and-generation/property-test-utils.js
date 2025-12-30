// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-Based Testing Utilities
 * 
 * Provides generators and utilities for property-based testing of the
 * ML Container Creator generator using fast-check.
 */

import fc from 'fast-check';

// Parameter Matrix Configuration (matches design document)
export const PARAMETER_MATRIX = {
    framework: {
        cliOption: 'framework',
        envVar: null,
        configFile: true,
        packageJson: false,
        promptable: true,
        required: true,
        default: null,
        values: ['sklearn', 'xgboost', 'tensorflow', 'transformers']
    },
    
    modelServer: {
        cliOption: 'model-server',
        envVar: null,
        configFile: true,
        packageJson: false,
        promptable: true,
        required: true,
        default: null,
        values: ['flask', 'fastapi', 'vllm', 'sglang']
    },
    
    modelFormat: {
        cliOption: 'model-format',
        envVar: null,
        configFile: true,
        packageJson: false,
        promptable: true,
        required: true,
        default: null,
        values: ['pkl', 'joblib', 'json', 'model', 'ubj', 'keras', 'h5', 'SavedModel']
    },
    
    includeSampleModel: {
        cliOption: 'include-sample',
        envVar: null,
        configFile: true,
        packageJson: false,
        promptable: true,
        required: true,
        default: false,
        values: [true, false]
    },
    
    includeTesting: {
        cliOption: 'include-testing',
        envVar: null,
        configFile: true,
        packageJson: false,
        promptable: true,
        required: true,
        default: true,
        values: [true, false]
    },
    
    instanceType: {
        cliOption: 'instance-type',
        envVar: 'ML_INSTANCE_TYPE',
        configFile: true,
        packageJson: false,
        promptable: true,
        required: true,
        default: null,
        values: ['cpu-optimized', 'gpu-enabled']
    },
    
    awsRegion: {
        cliOption: 'region',
        envVar: 'AWS_REGION',
        configFile: true,
        packageJson: true,
        promptable: true,
        required: false,
        default: 'us-east-1',
        values: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1']
    },
    
    awsRoleArn: {
        cliOption: 'role-arn',
        envVar: 'AWS_ROLE',
        configFile: true,
        packageJson: true,
        promptable: true,
        required: false,
        default: null,
        values: null // Generated dynamically
    },
    
    projectName: {
        cliOption: 'project-name',
        envVar: null,
        configFile: true,
        packageJson: true,
        promptable: false,
        required: true,
        default: null,
        values: null // Generated dynamically
    },
    
    destinationDir: {
        cliOption: 'project-dir',
        envVar: null,
        configFile: true,
        packageJson: true,
        promptable: false,
        required: true,
        default: '.',
        values: ['.', './output', '/tmp/test']
    },
    
    configFile: {
        cliOption: 'config',
        envVar: 'ML_CONTAINER_CREATOR_CONFIG',
        configFile: false,
        packageJson: false,
        promptable: false,
        required: false,
        default: null,
        values: null // Generated dynamically
    }
};

// Environment variable mappings
export const ENV_VAR_MAPPING = {
    'ML_INSTANCE_TYPE': 'instanceType',
    'AWS_REGION': 'awsRegion',
    'AWS_ROLE': 'awsRoleArn',
    'ML_CONTAINER_CREATOR_CONFIG': '_configFilePath'
};

// Unsupported environment variables (should be ignored)
export const UNSUPPORTED_ENV_VARS = [
    'ML_FRAMEWORK',
    'ML_MODEL_SERVER',
    'ML_MODEL_FORMAT',
    'ML_INCLUDE_SAMPLE_MODEL',
    'ML_INCLUDE_TESTING',
    'ML_AWS_REGION' // Replaced by AWS_REGION
];

/**
 * Generators for property-based testing
 */

// Generate valid AWS Role ARN
export const generateValidArn = () => 
    fc.tuple(
        fc.integer({ min: 100000000000, max: 999999999999 }),
        fc.stringMatching(/^[a-zA-Z0-9+=,.@_-]{1,64}$/)
    ).map(([accountId, roleName]) => `arn:aws:iam::${accountId}:role/${roleName}`);

// Generate valid project names
export const generateProjectName = () =>
    fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/)
        .filter(name => name.length >= 2 && !name.includes('--'));

// Generate valid file paths
export const generateFilePath = () =>
    fc.oneof(
        fc.constant('.'),
        fc.constant('./output'),
        fc.stringMatching(/^[a-zA-Z0-9._/-]{1,100}$/)
    );

// Generate configuration objects
export const generateConfiguration = () => fc.record({
    framework: fc.constantFrom(...PARAMETER_MATRIX.framework.values),
    modelServer: fc.constantFrom(...PARAMETER_MATRIX.modelServer.values),
    modelFormat: fc.constantFrom(...PARAMETER_MATRIX.modelFormat.values),
    includeSampleModel: fc.boolean(),
    includeTesting: fc.boolean(),
    instanceType: fc.constantFrom(...PARAMETER_MATRIX.instanceType.values),
    awsRegion: fc.constantFrom(...PARAMETER_MATRIX.awsRegion.values),
    awsRoleArn: fc.option(generateValidArn()),
    projectName: generateProjectName(),
    destinationDir: fc.constantFrom(...PARAMETER_MATRIX.destinationDir.values)
});

// Generate CLI options object
export const generateCliOptions = () => fc.record({
    'framework': fc.option(fc.constantFrom(...PARAMETER_MATRIX.framework.values)),
    'model-server': fc.option(fc.constantFrom(...PARAMETER_MATRIX.modelServer.values)),
    'model-format': fc.option(fc.constantFrom(...PARAMETER_MATRIX.modelFormat.values)),
    'include-sample': fc.option(fc.boolean()),
    'include-testing': fc.option(fc.boolean()),
    'instance-type': fc.option(fc.constantFrom(...PARAMETER_MATRIX.instanceType.values)),
    'region': fc.option(fc.constantFrom(...PARAMETER_MATRIX.awsRegion.values)),
    'role-arn': fc.option(generateValidArn()),
    'project-name': fc.option(generateProjectName()),
    'project-dir': fc.option(fc.constantFrom(...PARAMETER_MATRIX.destinationDir.values)),
    'config': fc.option(generateFilePath()),
    'skip-prompts': fc.constant(true) // Always skip prompts for testing
});

// Generate environment variables object
export const generateEnvironmentVariables = () => fc.record({
    'ML_INSTANCE_TYPE': fc.option(fc.constantFrom(...PARAMETER_MATRIX.instanceType.values)),
    'AWS_REGION': fc.option(fc.constantFrom(...PARAMETER_MATRIX.awsRegion.values)),
    'AWS_ROLE': fc.option(generateValidArn()),
    'ML_CONTAINER_CREATOR_CONFIG': fc.option(generateFilePath()),
    // Include some unsupported variables that should be ignored
    'ML_FRAMEWORK': fc.option(fc.constantFrom(...PARAMETER_MATRIX.framework.values)),
    'ML_MODEL_SERVER': fc.option(fc.constantFrom(...PARAMETER_MATRIX.modelServer.values)),
    'ML_AWS_REGION': fc.option(fc.constantFrom(...PARAMETER_MATRIX.awsRegion.values))
});

// Generate package.json configuration (only supported parameters)
export const generatePackageJsonConfig = () => fc.record({
    projectName: fc.option(generateProjectName()),
    awsRegion: fc.option(fc.constantFrom(...PARAMETER_MATRIX.awsRegion.values)),
    awsRoleArn: fc.option(generateValidArn()),
    destinationDir: fc.option(fc.constantFrom(...PARAMETER_MATRIX.destinationDir.values)),
    // Include some unsupported parameters that should be ignored
    framework: fc.option(fc.constantFrom(...PARAMETER_MATRIX.framework.values)),
    modelServer: fc.option(fc.constantFrom(...PARAMETER_MATRIX.modelServer.values)),
    includeSampleModel: fc.option(fc.boolean()),
    includeTesting: fc.option(fc.boolean())
});

// Generate config file content (all parameters supported)
export const generateConfigFileContent = () => fc.record({
    projectName: fc.option(generateProjectName()),
    framework: fc.option(fc.constantFrom(...PARAMETER_MATRIX.framework.values)),
    modelServer: fc.option(fc.constantFrom(...PARAMETER_MATRIX.modelServer.values)),
    modelFormat: fc.option(fc.constantFrom(...PARAMETER_MATRIX.modelFormat.values)),
    includeSampleModel: fc.option(fc.boolean()),
    includeTesting: fc.option(fc.boolean()),
    instanceType: fc.option(fc.constantFrom(...PARAMETER_MATRIX.instanceType.values)),
    awsRegion: fc.option(fc.constantFrom(...PARAMETER_MATRIX.awsRegion.values)),
    awsRoleArn: fc.option(generateValidArn()),
    destinationDir: fc.option(fc.constantFrom(...PARAMETER_MATRIX.destinationDir.values))
});

/**
 * Utility functions for property testing
 */

// Check if a parameter supports a specific source
export function isSourceSupported(parameter, source) {
    const paramConfig = PARAMETER_MATRIX[parameter];
    if (!paramConfig) return false;
    
    switch (source) {
    case 'cliOption':
        return paramConfig.cliOption !== null;
    case 'envVar':
        return paramConfig.envVar !== null;
    case 'configFile':
        return paramConfig.configFile === true;
    case 'packageJson':
        return paramConfig.packageJson === true;
    default:
        return false;
    }
}

// Get the CLI option name for a parameter
export function getCliOptionName(parameter) {
    const paramConfig = PARAMETER_MATRIX[parameter];
    return paramConfig ? paramConfig.cliOption : null;
}

// Get the environment variable name for a parameter
export function getEnvVarName(parameter) {
    const paramConfig = PARAMETER_MATRIX[parameter];
    return paramConfig ? paramConfig.envVar : null;
}

// Check if a parameter is promptable
export function isPromptable(parameter) {
    const paramConfig = PARAMETER_MATRIX[parameter];
    return paramConfig ? paramConfig.promptable : false;
}

// Check if a parameter is required
export function isRequired(parameter) {
    const paramConfig = PARAMETER_MATRIX[parameter];
    return paramConfig ? paramConfig.required : false;
}

// Get the default value for a parameter
export function getDefaultValue(parameter) {
    const paramConfig = PARAMETER_MATRIX[parameter];
    return paramConfig ? paramConfig.default : null;
}

// Validate framework/server compatibility
export function isValidFrameworkServerCombination(framework, modelServer) {
    const validCombinations = {
        sklearn: ['flask', 'fastapi'],
        xgboost: ['flask', 'fastapi'],
        tensorflow: ['flask', 'fastapi'],
        transformers: ['vllm', 'sglang']
    };
    
    return validCombinations[framework]?.includes(modelServer) || false;
}

// Validate framework/format compatibility
export function isValidFrameworkFormatCombination(framework, modelFormat) {
    const validCombinations = {
        sklearn: ['pkl', 'joblib'],
        xgboost: ['json', 'model', 'ubj'],
        tensorflow: ['keras', 'h5', 'SavedModel'],
        transformers: [] // No format needed for transformers
    };
    
    return validCombinations[framework]?.includes(modelFormat) || 
           (framework === 'transformers' && !modelFormat);
}

// Create a minimal valid configuration for testing
export function createMinimalValidConfig() {
    return {
        framework: 'sklearn',
        modelServer: 'flask',
        modelFormat: 'pkl',
        includeSampleModel: false,
        includeTesting: true,
        instanceType: 'cpu-optimized',
        awsRegion: 'us-east-1',
        projectName: 'test-project',
        destinationDir: '.'
    };
}

// Property test configuration
export const PROPERTY_TEST_CONFIG = {
    numRuns: 100, // Minimum 100 iterations as specified in design
    timeout: 30000, // 30 second timeout per property test
    verbose: true,
    seed: 42 // For reproducible tests
};