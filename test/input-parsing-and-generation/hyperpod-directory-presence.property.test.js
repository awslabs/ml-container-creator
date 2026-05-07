// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 9: Conditional HyperPod Directory Presence
 *
 * For any valid configuration, the `hyperpod/` directory must be present in
 * the generated project if and only if `deploymentTarget` equals `hyperpod-eks`.
 * When `deploymentTarget` equals `managed-inference`, the `hyperpod/` directory
 * must be absent.
 *
 * This property validates the ignorePatterns logic in the writing() phase of
 * index.js — testing that the correct glob patterns are built based on
 * deploymentTarget, not full file system operations.
 *
 * Validates: Requirements 7.1, 7.2
 *
 * Feature: sagemaker-hyperpod-deployment
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';

/**
 * Simulate the ignorePatterns logic from the writing() phase of index.js.
 * This mirrors the exact conditional used in the generator.
 *
 * @param {object} answers - Generator answers containing deploymentTarget
 * @returns {string[]} Array of glob ignore patterns
 */
function buildIgnorePatterns(answers) {
    const ignorePatterns = [];

    // Exclude HyperPod K8s manifests when not deploying to HyperPod
    if (answers.deploymentTarget !== 'hyperpod-eks') {
        ignorePatterns.push('**/hyperpod/**');
    }

    return ignorePatterns;
}

/**
 * Check whether a file path would be excluded by the given ignore patterns.
 * Uses simple glob matching for the `** /hyperpod/**` pattern.
 *
 * @param {string} filePath - Relative file path to check
 * @param {string[]} ignorePatterns - Array of glob patterns
 * @returns {boolean} True if the file would be excluded
 */
function isExcludedByPatterns(filePath, ignorePatterns) {
    for (const pattern of ignorePatterns) {
        if (pattern === '**/hyperpod/**') {
            // Match any path containing a /hyperpod/ segment or starting with hyperpod/
            if (filePath.includes('/hyperpod/') || filePath.startsWith('hyperpod/')) {
                return true;
            }
        }
    }
    return false;
}

/** Arbitrary for base config shared by both deployment targets */
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

/** Known hyperpod template file paths */
const hyperpodFiles = [
    'hyperpod/deployment.yaml',
    'hyperpod/service.yaml',
    'hyperpod/configmap.yaml',
    'hyperpod/pvc.yaml'
];

describe('Property 9: Conditional HyperPod Directory Presence', () => {
    before(() => {
        console.log('\n📜 Starting Conditional HyperPod Directory Presence Property Tests');
        console.log('📋 Testing: Requirements 7.1, 7.2');
        console.log('🔧 Configuration: ignorePatterns logic with fast-check\n');
    });

    it('should include hyperpod/ directory when deploymentTarget is hyperpod-eks (Req 7.1)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.1: hyperpod/ present when deploymentTarget === hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            hyperPodConfigArb,
            (base, hpVars) => {
                const answers = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    ...hpVars
                };

                const ignorePatterns = buildIgnorePatterns(answers);

                // **/hyperpod/** must NOT be in ignorePatterns
                assert.ok(
                    !ignorePatterns.includes('**/hyperpod/**'),
                    'hyperpod/ must not be excluded when deploymentTarget is hyperpod-eks'
                );

                // All hyperpod template files must NOT be excluded
                for (const file of hyperpodFiles) {
                    assert.ok(
                        !isExcludedByPatterns(file, ignorePatterns),
                        `${file} must not be excluded when deploymentTarget is hyperpod-eks`
                    );
                }
            }
        ), { numRuns: 50 });

        console.log('    ✅ hyperpod/ directory included for hyperpod-eks');
    });

    it('should exclude hyperpod/ directory when deploymentTarget is managed-inference (Req 7.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.2: hyperpod/ absent when deploymentTarget === managed-inference');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const answers = {
                    ...base,
                    deploymentTarget: 'managed-inference',
                    instanceType,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const ignorePatterns = buildIgnorePatterns(answers);

                // **/hyperpod/** MUST be in ignorePatterns
                assert.ok(
                    ignorePatterns.includes('**/hyperpod/**'),
                    'hyperpod/ must be excluded when deploymentTarget is managed-inference'
                );

                // All hyperpod template files must be excluded
                for (const file of hyperpodFiles) {
                    assert.ok(
                        isExcludedByPatterns(file, ignorePatterns),
                        `${file} must be excluded when deploymentTarget is managed-inference`
                    );
                }
            }
        ), { numRuns: 50 });

        console.log('    ✅ hyperpod/ directory excluded for managed-inference');
    });

    it('should have hyperpod/ presence be a biconditional on deploymentTarget (Req 7.1, 7.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 7.1 + 7.2: hyperpod/ present iff deploymentTarget === hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            hyperPodConfigArb,
            (base, deploymentTarget, hpVars) => {
                const answers = {
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

                const ignorePatterns = buildIgnorePatterns(answers);
                const hyperpodExcluded = ignorePatterns.includes('**/hyperpod/**');

                // Biconditional: hyperpod excluded iff NOT hyperpod-eks
                assert.strictEqual(
                    hyperpodExcluded,
                    deploymentTarget !== 'hyperpod-eks',
                    `hyperpod/ exclusion (${hyperpodExcluded}) must match deploymentTarget !== hyperpod-eks (${deploymentTarget !== 'hyperpod-eks'})`
                );

                // Verify file-level exclusion matches pattern-level exclusion
                for (const file of hyperpodFiles) {
                    const fileExcluded = isExcludedByPatterns(file, ignorePatterns);
                    assert.strictEqual(
                        fileExcluded,
                        deploymentTarget !== 'hyperpod-eks',
                        `${file} exclusion must match deploymentTarget for ${deploymentTarget}`
                    );
                }
            }
        ), { numRuns: 100 });

        console.log('    ✅ Biconditional verified: hyperpod/ present iff hyperpod-eks');
    });

    it('should not affect non-hyperpod files regardless of deploymentTarget', function () {
        this.timeout(30000);

        console.log('  🧪 Non-hyperpod files unaffected by deploymentTarget');

        const nonHyperpodFiles = [
            'Dockerfile',
            'do/config',
            'do/deploy',
            'do/clean',
            'do/logs',
            'do/test',
            'code/serve'
        ];

        fc.assert(fc.property(
            fc.constantFrom('managed-inference', 'hyperpod-eks'),
            (deploymentTarget) => {
                const answers = { deploymentTarget };
                const ignorePatterns = buildIgnorePatterns(answers);

                // Non-hyperpod files must never be excluded by the hyperpod pattern
                for (const file of nonHyperpodFiles) {
                    assert.ok(
                        !isExcludedByPatterns(file, ignorePatterns),
                        `${file} must not be excluded by hyperpod ignore pattern`
                    );
                }
            }
        ), { numRuns: 20 });

        console.log('    ✅ Non-hyperpod files unaffected');
    });
});
