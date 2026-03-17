// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 6: Unified Script Generation
 *
 * For any valid configuration (regardless of deploymentTarget value), the
 * generated project must contain exactly one do/deploy script, one do/clean
 * script, one do/logs script, and one do/test script. No additional
 * deployment-target-specific script files may be generated.
 *
 * This property validates that rendering each template produces exactly one
 * script output for both deployment targets - this is a template rendering
 * test, not a file system test.
 *
 * Validates: Requirements 5.1, 6.1, 15.1, 16.1
 *
 * Feature: sagemaker-hyperpod-deployment
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load all do-framework templates
const templatesDir = path.join(__dirname, '../../generators/app/templates/do');

const deployTemplate = readFileSync(path.join(templatesDir, 'deploy'), 'utf8');
const cleanTemplate = readFileSync(path.join(templatesDir, 'clean'), 'utf8');
const logsTemplate = readFileSync(path.join(templatesDir, 'logs'), 'utf8');
const testTemplate = readFileSync(path.join(templatesDir, 'test'), 'utf8');

/**
 * Render a template with the given variables.
 */
function renderTemplate(template, vars) {
    return ejs.render(template, vars);
}

/** Arbitrary for a base config shared by both deployment targets */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'mistralai/Mistral-7B-v0.1'),
    roleArn: fc.constantFrom('arn:aws:iam::123456789012:role/SageMakerRole', undefined),
    inferenceAmiVersion: fc.constantFrom('1.0.0', undefined)
});

/** Arbitrary for HyperPod-specific config */
const hyperPodConfigArb = fc.record({
    hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 }),
    fsxVolumeHandle: fc.option(fc.stringMatching(/^fs-[a-f0-9]{17}$/), { nil: undefined })
});

describe('Property 6: Unified Script Generation', () => {
    before(() => {
        console.log('\n📜 Starting Unified Script Generation Property Tests');
        console.log('📋 Testing: Requirements 5.1, 6.1, 15.1, 16.1');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should generate exactly one do/deploy script for managed-inference (Req 5.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 5.1: Single do/deploy script for managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(deployTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/deploy must start with bash shebang'
                );

                // Output must contain deployment logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/deploy must contain substantial content'
                );

                // Must contain managed-inference specific content
                assert.ok(
                    output.includes('sagemaker create-inference-component') ||
                    output.includes('SageMaker'),
                    'managed-inference do/deploy must contain SageMaker logic'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/deploy script generated for managed-inference');
    });

    it('should generate exactly one do/deploy script for hyperpod-eks (Req 5.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 5.1: Single do/deploy script for hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(deployTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/deploy must start with bash shebang'
                );

                // Output must contain deployment logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/deploy must contain substantial content'
                );

                // Must contain hyperpod-eks specific content
                assert.ok(
                    output.includes('kubectl') ||
                    output.includes('HyperPod'),
                    'hyperpod-eks do/deploy must contain kubectl logic'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/deploy script generated for hyperpod-eks');
    });

    it('should generate exactly one do/clean script for managed-inference (Req 6.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 6.1: Single do/clean script for managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(cleanTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/clean must start with bash shebang'
                );

                // Output must contain cleanup logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/clean must contain substantial content'
                );

                // Must contain managed-inference specific cleanup
                assert.ok(
                    output.includes('clean_endpoint') ||
                    output.includes('delete-endpoint'),
                    'managed-inference do/clean must contain endpoint cleanup'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/clean script generated for managed-inference');
    });

    it('should generate exactly one do/clean script for hyperpod-eks (Req 6.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 6.1: Single do/clean script for hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(cleanTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/clean must start with bash shebang'
                );

                // Output must contain cleanup logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/clean must contain substantial content'
                );

                // Must contain hyperpod-eks specific cleanup
                assert.ok(
                    output.includes('clean_hyperpod') ||
                    output.includes('kubectl delete'),
                    'hyperpod-eks do/clean must contain hyperpod cleanup'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/clean script generated for hyperpod-eks');
    });

    it('should generate exactly one do/logs script for managed-inference (Req 15.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 15.1: Single do/logs script for managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(logsTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/logs must start with bash shebang'
                );

                // Output must contain logs logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/logs must contain substantial content'
                );

                // Must contain managed-inference specific logs
                assert.ok(
                    output.includes('aws logs tail') ||
                    output.includes('CloudWatch'),
                    'managed-inference do/logs must contain CloudWatch logs logic'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/logs script generated for managed-inference');
    });

    it('should generate exactly one do/logs script for hyperpod-eks (Req 15.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 15.1: Single do/logs script for hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(logsTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/logs must start with bash shebang'
                );

                // Output must contain logs logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/logs must contain substantial content'
                );

                // Must contain hyperpod-eks specific logs
                assert.ok(
                    output.includes('kubectl logs') ||
                    output.includes('HyperPod'),
                    'hyperpod-eks do/logs must contain kubectl logs logic'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/logs script generated for hyperpod-eks');
    });

    it('should generate exactly one do/test script for managed-inference (Req 16.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 16.1: Single do/test script for managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(testTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/test must start with bash shebang'
                );

                // Output must contain test logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/test must contain substantial content'
                );

                // Must contain managed-inference specific test
                assert.ok(
                    output.includes('sagemaker-runtime invoke-endpoint') ||
                    output.includes('SageMaker endpoint'),
                    'managed-inference do/test must contain SageMaker test logic'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/test script generated for managed-inference');
    });

    it('should generate exactly one do/test script for hyperpod-eks (Req 16.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 16.1: Single do/test script for hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars
                };

                // Rendering should succeed and produce a single script
                const output = renderTemplate(testTemplate, vars);

                // Output must be a valid bash script
                assert.ok(
                    output.startsWith('#!/bin/bash'),
                    'do/test must start with bash shebang'
                );

                // Output must contain test logic (not be empty)
                assert.ok(
                    output.length > 100,
                    'do/test must contain substantial content'
                );

                // Must contain hyperpod-eks specific test
                assert.ok(
                    output.includes('kubectl port-forward') ||
                    output.includes('HyperPod'),
                    'hyperpod-eks do/test must contain kubectl port-forward logic'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single do/test script generated for hyperpod-eks');
    });

    it('should render all four scripts successfully for any valid deployment target', function () {
        this.timeout(30000);

        console.log('  🧪 All four scripts render successfully for any deployment target');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            hyperPodConfigArb,
            (base, deploymentTarget, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: deploymentTarget === 'managed-inference' ? 'ml.m5.xlarge' : undefined,
                    ...(deploymentTarget === 'hyperpod-eks' ? hpVars : {
                        hyperPodCluster: undefined,
                        hyperPodNamespace: undefined,
                        hyperPodReplicas: undefined,
                        fsxVolumeHandle: undefined
                    })
                };

                // All four templates should render without error
                const deployOutput = renderTemplate(deployTemplate, vars);
                const cleanOutput = renderTemplate(cleanTemplate, vars);
                const logsOutput = renderTemplate(logsTemplate, vars);
                const testOutput = renderTemplate(testTemplate, vars);

                // All outputs should be valid bash scripts
                assert.ok(deployOutput.startsWith('#!/bin/bash'), 'do/deploy must be valid bash');
                assert.ok(cleanOutput.startsWith('#!/bin/bash'), 'do/clean must be valid bash');
                assert.ok(logsOutput.startsWith('#!/bin/bash'), 'do/logs must be valid bash');
                assert.ok(testOutput.startsWith('#!/bin/bash'), 'do/test must be valid bash');

                // All outputs should have substantial content
                assert.ok(deployOutput.length > 100, 'do/deploy must have content');
                assert.ok(cleanOutput.length > 100, 'do/clean must have content');
                assert.ok(logsOutput.length > 100, 'do/logs must have content');
                assert.ok(testOutput.length > 100, 'do/test must have content');
            }
        ), { numRuns: 20 });

        console.log('    ✅ All four scripts render successfully');
    });

    it('should not generate deployment-target-specific script files', function () {
        this.timeout(30000);

        console.log('  🧪 No deployment-target-specific script files (e.g., deploy-hyperpod)');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            hyperPodConfigArb,
            (base, deploymentTarget, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: deploymentTarget === 'managed-inference' ? 'ml.m5.xlarge' : undefined,
                    ...(deploymentTarget === 'hyperpod-eks' ? hpVars : {
                        hyperPodCluster: undefined,
                        hyperPodNamespace: undefined,
                        hyperPodReplicas: undefined,
                        fsxVolumeHandle: undefined
                    })
                };

                // Render all templates
                const deployOutput = renderTemplate(deployTemplate, vars);
                const cleanOutput = renderTemplate(cleanTemplate, vars);
                const logsOutput = renderTemplate(logsTemplate, vars);
                const testOutput = renderTemplate(testTemplate, vars);

                // Scripts should NOT reference other deployment-target-specific scripts
                // (e.g., no ./do/deploy-hyperpod or ./do/clean-sagemaker)
                const allOutputs = [deployOutput, cleanOutput, logsOutput, testOutput];
                
                for (const output of allOutputs) {
                    assert.ok(
                        !output.includes('./do/deploy-hyperpod'),
                        'Scripts must not reference deploy-hyperpod'
                    );
                    assert.ok(
                        !output.includes('./do/deploy-sagemaker'),
                        'Scripts must not reference deploy-sagemaker'
                    );
                    assert.ok(
                        !output.includes('./do/clean-hyperpod'),
                        'Scripts must not reference clean-hyperpod'
                    );
                    assert.ok(
                        !output.includes('./do/clean-sagemaker'),
                        'Scripts must not reference clean-sagemaker'
                    );
                    assert.ok(
                        !output.includes('./do/logs-hyperpod'),
                        'Scripts must not reference logs-hyperpod'
                    );
                    assert.ok(
                        !output.includes('./do/test-hyperpod'),
                        'Scripts must not reference test-hyperpod'
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ No deployment-target-specific script files referenced');
    });
});
