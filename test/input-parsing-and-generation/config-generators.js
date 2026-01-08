// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Object Generators for Property-Based Testing
 * 
 * Provides smart generators that create realistic configuration objects
 * for testing the ML Container Creator generator. These generators
 * understand the constraints and relationships between parameters.
 */

import fc from 'fast-check';

/**
 * Framework-specific generators that understand valid combinations
 */

// Generate valid framework/server/format combinations
export const generateValidFrameworkCombination = () => {
    const combinations = [
        {
            framework: 'sklearn',
            servers: ['flask', 'fastapi'],
            formats: ['pkl', 'joblib']
        },
        {
            framework: 'xgboost',
            servers: ['flask', 'fastapi'],
            formats: ['json', 'model', 'ubj']
        },
        {
            framework: 'tensorflow',
            servers: ['flask', 'fastapi'],
            formats: ['keras', 'h5', 'SavedModel']
        },
        {
            framework: 'transformers',
            servers: ['vllm', 'sglang'],
            formats: [null] // No format needed for transformers
        }
    ];
    
    return fc.constantFrom(...combinations).chain(combo => 
        fc.record({
            framework: fc.constant(combo.framework),
            modelServer: fc.constantFrom(...combo.servers),
            modelFormat: combo.formats[0] === null ? 
                fc.constant(null) : 
                fc.constantFrom(...combo.formats)
        })
    );
};

// Generate invalid framework/server combinations (for negative testing)
export const generateInvalidFrameworkCombination = () => {
    const invalidCombinations = [
        { framework: 'sklearn', modelServer: 'vllm' },
        { framework: 'sklearn', modelServer: 'sglang' },
        { framework: 'xgboost', modelServer: 'vllm' },
        { framework: 'xgboost', modelServer: 'sglang' },
        { framework: 'tensorflow', modelServer: 'vllm' },
        { framework: 'tensorflow', modelServer: 'sglang' },
        { framework: 'transformers', modelServer: 'flask' },
        { framework: 'transformers', modelServer: 'fastapi' }
    ];
    
    return fc.constantFrom(...invalidCombinations);
};

/**
 * AWS-specific generators
 */

// Generate valid AWS regions
export const generateAwsRegion = () => fc.constantFrom(
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1'
);

// Generate valid deployment targets
export const generateDeploymentTarget = () => fc.constantFrom('sagemaker', 'codebuild');

// Generate valid CodeBuild compute types
export const generateCodeBuildComputeType = () => fc.constantFrom(
    'BUILD_GENERAL1_SMALL',
    'BUILD_GENERAL1_MEDIUM', 
    'BUILD_GENERAL1_LARGE'
);

// Generate valid CodeBuild project names
export const generateCodeBuildProjectName = () => fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/)
    .filter(name => name.length >= 2 && name.length <= 255 && !name.includes('--'));

// Generate invalid CodeBuild project names (for negative testing)
export const generateInvalidCodeBuildProjectName = () => fc.oneof(
    fc.constant(''), // Empty
    fc.constant('-invalid'), // Starts with hyphen
    fc.constant('invalid-'), // Ends with hyphen
    fc.constant('invalid--name'), // Double hyphen
    fc.stringMatching(/^[^a-zA-Z0-9]/), // Starts with invalid character
    fc.string({ minLength: 256 }) // Too long
);

// Generate valid AWS Role ARNs
export const generateAwsRoleArn = () => fc.tuple(
    fc.integer({ min: 100000000000, max: 999999999999 }),
    fc.stringMatching(/^[a-zA-Z0-9+=,.@_-]{1,64}$/)
).map(([accountId, roleName]) => `arn:aws:iam::${accountId}:role/${roleName}`);

// Generate invalid AWS Role ARNs (for negative testing)
export const generateInvalidAwsRoleArn = () => fc.oneof(
    fc.constant('invalid-arn'),
    fc.constant('arn:aws:iam::invalid:role/test'),
    fc.constant('arn:aws:s3:::bucket/key'), // Wrong service
    fc.stringMatching(/^[a-z]{1,20}$/) // Random string
);

/**
 * Project-specific generators
 */

// Generate valid project names
export const generateProjectName = () => fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/)
    .filter(name => name.length >= 2 && !name.includes('--') && !name.startsWith('-') && !name.endsWith('-'));

// Generate invalid project names (for negative testing)
export const generateInvalidProjectName = () => fc.oneof(
    fc.constant(''), // Empty
    fc.constant('-invalid'), // Starts with hyphen
    fc.constant('invalid-'), // Ends with hyphen
    fc.constant('invalid--name'), // Double hyphen
    fc.stringMatching(/^[A-Z]{1,10}$/), // Uppercase
    fc.stringMatching(/^[a-z0-9_]{1,10}$/), // Contains underscore
    fc.string({ minLength: 64 }) // Too long
);

// Generate valid destination directories
export const generateDestinationDir = () => fc.oneof(
    fc.constant('.'),
    fc.constant('./output'),
    fc.constant('./build'),
    fc.stringMatching(/^\.\/[a-zA-Z0-9_-]{1,20}$/)
);

/**
 * Configuration object generators
 */

// Generate a complete valid configuration
export const generateValidConfiguration = () => 
    generateValidFrameworkCombination().chain(combo => {
        const baseConfig = fc.record({
            framework: fc.constant(combo.framework),
            modelServer: fc.constant(combo.modelServer),
            modelFormat: combo.modelFormat ? fc.constant(combo.modelFormat) : fc.constant(null),
            includeSampleModel: fc.boolean(),
            includeTesting: fc.boolean(),
            deployTarget: generateDeploymentTarget(),
            instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled'),
            awsRegion: generateAwsRegion(),
            awsRoleArn: fc.option(generateAwsRoleArn()),
            projectName: generateProjectName(),
            destinationDir: generateDestinationDir()
        });
        
        return baseConfig.chain(config => {
            // Add CodeBuild-specific parameters when deployTarget is 'codebuild'
            if (config.deployTarget === 'codebuild') {
                return fc.record({
                    framework: fc.constant(config.framework),
                    modelServer: fc.constant(config.modelServer),
                    modelFormat: fc.constant(config.modelFormat),
                    includeSampleModel: fc.constant(config.includeSampleModel),
                    includeTesting: fc.constant(config.includeTesting),
                    deployTarget: fc.constant(config.deployTarget),
                    instanceType: fc.constant(config.instanceType),
                    awsRegion: fc.constant(config.awsRegion),
                    awsRoleArn: fc.constant(config.awsRoleArn),
                    projectName: fc.constant(config.projectName),
                    destinationDir: fc.constant(config.destinationDir),
                    codebuildComputeType: generateCodeBuildComputeType(),
                    codebuildProjectName: generateCodeBuildProjectName()
                });
            }
            return fc.constant(config);
        });
    });

// Generate CodeBuild-specific configuration
export const generateCodeBuildConfiguration = () => 
    generateValidFrameworkCombination().chain(combo =>
        fc.record({
            framework: fc.constant(combo.framework),
            modelServer: fc.constant(combo.modelServer),
            modelFormat: combo.modelFormat ? fc.constant(combo.modelFormat) : fc.constant(null),
            includeSampleModel: fc.boolean(),
            includeTesting: fc.boolean(),
            deployTarget: fc.constant('codebuild'),
            instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled'),
            awsRegion: generateAwsRegion(),
            awsRoleArn: fc.option(generateAwsRoleArn()),
            projectName: generateProjectName(),
            destinationDir: generateDestinationDir(),
            codebuildComputeType: generateCodeBuildComputeType(),
            codebuildProjectName: generateCodeBuildProjectName()
        })
    );

// Generate SageMaker-specific configuration
export const generateSageMakerConfiguration = () => 
    generateValidFrameworkCombination().chain(combo =>
        fc.record({
            framework: fc.constant(combo.framework),
            modelServer: fc.constant(combo.modelServer),
            modelFormat: combo.modelFormat ? fc.constant(combo.modelFormat) : fc.constant(null),
            includeSampleModel: fc.boolean(),
            includeTesting: fc.boolean(),
            deployTarget: fc.constant('sagemaker'),
            instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled'),
            awsRegion: generateAwsRegion(),
            awsRoleArn: fc.option(generateAwsRoleArn()),
            projectName: generateProjectName(),
            destinationDir: generateDestinationDir()
        })
    );

// Generate configuration with some invalid values (for negative testing)
export const generateInvalidConfiguration = () => fc.oneof(
    // Invalid framework combination
    generateInvalidFrameworkCombination().chain(combo =>
        fc.record({
            ...combo,
            includeSampleModel: fc.boolean(),
            includeTesting: fc.boolean(),
            instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled'),
            awsRegion: generateAwsRegion(),
            projectName: generateProjectName(),
            destinationDir: generateDestinationDir()
        })
    ),
    
    // Invalid AWS Role ARN
    generateValidFrameworkCombination().chain(combo =>
        fc.record({
            ...combo,
            includeSampleModel: fc.boolean(),
            includeTesting: fc.boolean(),
            instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled'),
            awsRegion: generateAwsRegion(),
            awsRoleArn: generateInvalidAwsRoleArn(),
            projectName: generateProjectName(),
            destinationDir: generateDestinationDir()
        })
    ),
    
    // Invalid project name
    generateValidFrameworkCombination().chain(combo =>
        fc.record({
            ...combo,
            includeSampleModel: fc.boolean(),
            includeTesting: fc.boolean(),
            instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled'),
            awsRegion: generateAwsRegion(),
            projectName: generateInvalidProjectName(),
            destinationDir: generateDestinationDir()
        })
    )
);

// Generate partial configuration (missing some required fields)
export const generatePartialConfiguration = () => 
    generateValidConfiguration().chain(fullConfig => {
        const requiredFields = ['framework', 'modelServer', 'instanceType', 'projectName'];
        const fieldsToRemove = fc.subarray(requiredFields, { minLength: 1, maxLength: 2 });
        
        return fieldsToRemove.map(fields => {
            const partialConfig = { ...fullConfig };
            fields.forEach(field => delete partialConfig[field]);
            return partialConfig;
        });
    });

/**
 * Source-specific generators (for testing parameter precedence)
 */

// Generate CLI options with realistic values
export const generateRealisticCliOptions = () => 
    generateValidConfiguration().chain(config => 
        fc.record({
            'skip-prompts': fc.constant(true),
            'framework': fc.option(fc.constant(config.framework)),
            'model-server': fc.option(fc.constant(config.modelServer)),
            'model-format': config.modelFormat ? fc.option(fc.constant(config.modelFormat)) : fc.constant(null),
            'include-sample': fc.option(fc.constant(config.includeSampleModel)),
            'include-testing': fc.option(fc.constant(config.includeTesting)),
            'deploy-target': fc.option(fc.constant(config.deployTarget)),
            'instance-type': fc.option(fc.constant(config.instanceType)),
            'region': fc.option(fc.constant(config.awsRegion)),
            'role-arn': config.awsRoleArn ? fc.option(fc.constant(config.awsRoleArn)) : fc.constant(null),
            'project-name': fc.option(fc.constant(config.projectName)),
            'project-dir': fc.option(fc.constant(config.destinationDir)),
            'codebuild-compute-type': config.codebuildComputeType ? fc.option(fc.constant(config.codebuildComputeType)) : fc.constant(null),
            'codebuild-project-name': config.codebuildProjectName ? fc.option(fc.constant(config.codebuildProjectName)) : fc.constant(null)
        })
    );

// Generate environment variables with realistic values
export const generateRealisticEnvironmentVars = () => fc.record({
    'ML_INSTANCE_TYPE': fc.option(fc.constantFrom('cpu-optimized', 'gpu-enabled')),
    'ML_DEPLOY_TARGET': fc.option(fc.constantFrom('sagemaker', 'codebuild')),
    'ML_CODEBUILD_COMPUTE_TYPE': fc.option(fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE')),
    'AWS_REGION': fc.option(generateAwsRegion()),
    'AWS_ROLE': fc.option(generateAwsRoleArn()),
    'ML_CONTAINER_CREATOR_CONFIG': fc.option(fc.constantFrom('config.json', 'ml-config.json')),
    
    // Include unsupported variables that should be ignored
    'ML_FRAMEWORK': fc.option(fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers')),
    'ML_MODEL_SERVER': fc.option(fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang')),
    'ML_AWS_REGION': fc.option(generateAwsRegion()) // Should be ignored in favor of AWS_REGION
});

// Generate package.json config with only supported parameters
export const generateRealisticPackageJsonConfig = () => fc.record({
    // Supported in package.json
    projectName: fc.option(generateProjectName()),
    awsRegion: fc.option(generateAwsRegion()),
    awsRoleArn: fc.option(generateAwsRoleArn()),
    destinationDir: fc.option(generateDestinationDir()),
    
    // Unsupported in package.json (should be ignored)
    framework: fc.option(fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers')),
    modelServer: fc.option(fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang')),
    deployTarget: fc.option(fc.constantFrom('sagemaker', 'codebuild')),
    codebuildComputeType: fc.option(fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE')),
    codebuildProjectName: fc.option(generateCodeBuildProjectName()),
    includeSampleModel: fc.option(fc.boolean()),
    includeTesting: fc.option(fc.boolean())
});

/**
 * Test scenario generators
 */

// Generate a complete test scenario with multiple configuration sources
export const generateMultiSourceScenario = () => fc.record({
    cliOptions: generateRealisticCliOptions(),
    environmentVars: generateRealisticEnvironmentVars(),
    packageJsonConfig: generateRealisticPackageJsonConfig(),
    configFileContent: generateValidConfiguration()
});

// Generate edge case scenarios
export const generateEdgeCaseScenario = () => fc.oneof(
    // All optional parameters missing
    fc.record({
        framework: fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers'),
        modelServer: fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
        instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled'),
        projectName: generateProjectName()
        // All optional parameters omitted
    }),
    
    // Minimal configuration
    fc.record({
        framework: fc.constant('sklearn'),
        modelServer: fc.constant('flask'),
        modelFormat: fc.constant('pkl'),
        instanceType: fc.constant('cpu-optimized'),
        projectName: fc.constant('minimal-test'),
        includeSampleModel: fc.constant(false),
        includeTesting: fc.constant(false)
    }),
    
    // Maximum configuration
    generateValidConfiguration().map(config => ({
        ...config,
        includeSampleModel: true,
        includeTesting: true,
        awsRoleArn: 'arn:aws:iam::123456789012:role/MaximalTestRole'
    }))
);

export default {
    generateValidFrameworkCombination,
    generateInvalidFrameworkCombination,
    generateAwsRegion,
    generateDeploymentTarget,
    generateCodeBuildComputeType,
    generateCodeBuildProjectName,
    generateInvalidCodeBuildProjectName,
    generateAwsRoleArn,
    generateInvalidAwsRoleArn,
    generateProjectName,
    generateInvalidProjectName,
    generateDestinationDir,
    generateValidConfiguration,
    generateCodeBuildConfiguration,
    generateSageMakerConfiguration,
    generateInvalidConfiguration,
    generatePartialConfiguration,
    generateRealisticCliOptions,
    generateRealisticEnvironmentVars,
    generateRealisticPackageJsonConfig,
    generateMultiSourceScenario,
    generateEdgeCaseScenario
};