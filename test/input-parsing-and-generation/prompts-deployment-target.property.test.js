// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-Based Tests for Deployment Target Prompt System
 * 
 * Tests universal correctness properties for the build/deployment target
 * separation and conditional prompt visibility.
 * 
 * Property 1: Build/Deploy Separation
 * Property 2: Deployment-Target-Conditional Prompt Visibility
 * 
 * Validates Requirements: 1.3, 1.4, 2.1, 2.2, 2.3, 2.4
 */

import fc from 'fast-check';
import assert from 'assert';
import { setupTestHooks } from './test-utils.js';
import { infrastructurePrompts } from '../../generators/app/lib/prompts.js';

describe('Deployment Target Prompt Properties', () => {
    setupTestHooks('Deployment Target Prompt Properties');

    /**
     * Helper to find a prompt by name in the infrastructurePrompts array
     */
    function findPrompt(name) {
        return infrastructurePrompts.find(p => p.name === name);
    }

    /**
     * Helper to evaluate a prompt's `when` function with given answers
     */
    function evaluateWhen(prompt, answers) {
        if (!prompt) return false;
        if (typeof prompt.when === 'function') {
            return prompt.when(answers);
        }
        // If no `when` function, prompt is always shown
        return prompt.when !== false;
    }

    describe('Property 2: Deployment-Target-Conditional Prompt Visibility', () => {
        /**
         * Property 2a: When deploymentTarget === 'managed-inference':
         * - instanceType prompt's `when` function must return true
         * - All HyperPod-specific prompts' `when` functions must return false
         * 
         * Validates: Requirements 2.1, 2.2
         */
        it('should show instanceType and hide HyperPod prompts when deploymentTarget is managed-inference', function() {
            this.timeout(10000);

            fc.assert(fc.property(
                fc.record({
                    // Generate various valid answer states that might exist before these prompts
                    buildTarget: fc.constantFrom('codebuild'),
                    deploymentConfig: fc.constantFrom(
                        'transformers-vllm', 'transformers-sglang', 'transformers-tensorrt-llm',
                        'sklearn-flask', 'sklearn-fastapi', 'xgboost-flask', 'xgboost-fastapi',
                        'tensorflow-flask', 'tensorflow-fastapi'
                    ),
                    // Additional properties that might be set
                    _mcpInstanceChoices: fc.option(fc.array(fc.constantFrom(
                        'ml.m5.xlarge', 'ml.g5.xlarge', 'ml.g5.2xlarge'
                    ), { minLength: 0, maxLength: 5 }))
                }),
                (baseAnswers) => {
                    // Set deploymentTarget to managed-inference
                    const answers = {
                        ...baseAnswers,
                        deploymentTarget: 'managed-inference'
                    };

                    // Get the prompts
                    const instanceTypePrompt = findPrompt('instanceType');
                    const hyperPodClusterPrompt = findPrompt('hyperPodCluster');
                    const hyperPodNamespacePrompt = findPrompt('hyperPodNamespace');
                    const hyperPodReplicasPrompt = findPrompt('hyperPodReplicas');
                    const fsxVolumeHandlePrompt = findPrompt('fsxVolumeHandle');

                    // instanceType should be shown for managed-inference
                    // Note: instanceType prompt doesn't have a `when` guard in current implementation
                    // but if it does, it should return true for managed-inference
                    if (instanceTypePrompt && instanceTypePrompt.when) {
                        const instanceTypeVisible = evaluateWhen(instanceTypePrompt, answers);
                        assert.strictEqual(
                            instanceTypeVisible,
                            true,
                            'instanceType prompt should be visible when deploymentTarget is managed-inference'
                        );
                    }

                    // All HyperPod prompts should be hidden for managed-inference
                    if (hyperPodClusterPrompt) {
                        const clusterVisible = evaluateWhen(hyperPodClusterPrompt, answers);
                        assert.strictEqual(
                            clusterVisible,
                            false,
                            'hyperPodCluster prompt should be hidden when deploymentTarget is managed-inference'
                        );
                    }

                    if (hyperPodNamespacePrompt) {
                        const namespaceVisible = evaluateWhen(hyperPodNamespacePrompt, answers);
                        assert.strictEqual(
                            namespaceVisible,
                            false,
                            'hyperPodNamespace prompt should be hidden when deploymentTarget is managed-inference'
                        );
                    }

                    if (hyperPodReplicasPrompt) {
                        const replicasVisible = evaluateWhen(hyperPodReplicasPrompt, answers);
                        assert.strictEqual(
                            replicasVisible,
                            false,
                            'hyperPodReplicas prompt should be hidden when deploymentTarget is managed-inference'
                        );
                    }

                    if (fsxVolumeHandlePrompt) {
                        const fsxVisible = evaluateWhen(fsxVolumeHandlePrompt, answers);
                        assert.strictEqual(
                            fsxVisible,
                            false,
                            'fsxVolumeHandle prompt should be hidden when deploymentTarget is managed-inference'
                        );
                    }

                    return true;
                }
            ), { numRuns: 5 });
        });

        /**
         * Property 2b: When deploymentTarget === 'hyperpod-eks':
         * - HyperPod cluster, namespace, replicas, and FSx prompts' `when` functions must return true
         * - instanceType prompt's `when` function must also return true (used for nodeSelector)
         * 
         * Validates: Requirements 2.3, 2.4
         */
        it('should show HyperPod prompts and instanceType when deploymentTarget is hyperpod-eks', function() {
            this.timeout(10000);

            fc.assert(fc.property(
                fc.record({
                    buildTarget: fc.constantFrom('codebuild'),
                    deploymentConfig: fc.constantFrom(
                        'transformers-vllm', 'transformers-sglang', 'transformers-tensorrt-llm',
                        'sklearn-flask', 'sklearn-fastapi', 'xgboost-flask', 'xgboost-fastapi',
                        'tensorflow-flask', 'tensorflow-fastapi'
                    ),
                    _mcpHyperPodChoices: fc.option(fc.array(fc.constantFrom(
                        'my-hyperpod-cluster', 'prod-cluster', 'dev-cluster'
                    ), { minLength: 0, maxLength: 3 }))
                }),
                (baseAnswers) => {
                    // Set deploymentTarget to hyperpod-eks
                    const answers = {
                        ...baseAnswers,
                        deploymentTarget: 'hyperpod-eks'
                    };

                    // Get the prompts
                    const instanceTypePrompt = findPrompt('instanceType');
                    const hyperPodClusterPrompt = findPrompt('hyperPodCluster');
                    const hyperPodNamespacePrompt = findPrompt('hyperPodNamespace');
                    const hyperPodReplicasPrompt = findPrompt('hyperPodReplicas');
                    const fsxVolumeHandlePrompt = findPrompt('fsxVolumeHandle');

                    // instanceType should also be visible for hyperpod-eks (used for nodeSelector in deployment.yaml)
                    if (instanceTypePrompt && instanceTypePrompt.when) {
                        const instanceTypeVisible = evaluateWhen(instanceTypePrompt, answers);
                        assert.strictEqual(
                            instanceTypeVisible,
                            true,
                            'instanceType prompt should be visible when deploymentTarget is hyperpod-eks'
                        );
                    }

                    // All HyperPod prompts should be visible for hyperpod-eks
                    if (hyperPodClusterPrompt) {
                        const clusterVisible = evaluateWhen(hyperPodClusterPrompt, answers);
                        assert.strictEqual(
                            clusterVisible,
                            true,
                            'hyperPodCluster prompt should be visible when deploymentTarget is hyperpod-eks'
                        );
                    }

                    if (hyperPodNamespacePrompt) {
                        const namespaceVisible = evaluateWhen(hyperPodNamespacePrompt, answers);
                        assert.strictEqual(
                            namespaceVisible,
                            true,
                            'hyperPodNamespace prompt should be visible when deploymentTarget is hyperpod-eks'
                        );
                    }

                    if (hyperPodReplicasPrompt) {
                        const replicasVisible = evaluateWhen(hyperPodReplicasPrompt, answers);
                        assert.strictEqual(
                            replicasVisible,
                            true,
                            'hyperPodReplicas prompt should be visible when deploymentTarget is hyperpod-eks'
                        );
                    }

                    if (fsxVolumeHandlePrompt) {
                        const fsxVisible = evaluateWhen(fsxVolumeHandlePrompt, answers);
                        assert.strictEqual(
                            fsxVisible,
                            true,
                            'fsxVolumeHandle prompt should be visible when deploymentTarget is hyperpod-eks'
                        );
                    }

                    return true;
                }
            ), { numRuns: 5 });
        });

        /**
         * Property 2c: instanceType is shown for both deployment targets,
         * HyperPod prompts are only shown for hyperpod-eks
         * 
         * Validates: Requirements 2.1, 2.2, 2.3, 2.4
         */
        it('should ensure instanceType and HyperPod prompts are mutually exclusive', function() {
            this.timeout(10000);

            fc.assert(fc.property(
                fc.record({
                    buildTarget: fc.constantFrom('codebuild'),
                    deploymentTarget: fc.constantFrom('managed-inference', 'hyperpod-eks'),
                    deploymentConfig: fc.constantFrom(
                        'transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'
                    )
                }),
                (answers) => {
                    const instanceTypePrompt = findPrompt('instanceType');
                    const hyperPodClusterPrompt = findPrompt('hyperPodCluster');

                    // Evaluate visibility
                    const instanceTypeVisible = instanceTypePrompt && instanceTypePrompt.when
                        ? evaluateWhen(instanceTypePrompt, answers)
                        : true; // Default visible if no when guard
                    
                    const hyperPodVisible = hyperPodClusterPrompt
                        ? evaluateWhen(hyperPodClusterPrompt, answers)
                        : false;

                    // instanceType should be visible for both deployment targets
                    if (instanceTypePrompt && instanceTypePrompt.when) {
                        assert.strictEqual(
                            instanceTypeVisible,
                            true,
                            'instanceType should be visible for both managed-inference and hyperpod-eks'
                        );
                    }

                    // HyperPod prompts should only be visible for hyperpod-eks
                    if (answers.deploymentTarget === 'managed-inference') {
                        assert.strictEqual(
                            hyperPodVisible,
                            false,
                            'hyperPodCluster should be hidden for managed-inference'
                        );
                    } else {
                        assert.strictEqual(
                            hyperPodVisible,
                            true,
                            'hyperPodCluster should be visible for hyperpod-eks'
                        );
                    }

                    return true;
                }
            ), { numRuns: 5 });
        });
    });

    describe('Property 1: Build/Deploy Separation', () => {
        /**
         * Property 1a: buildTarget and deploymentTarget are independent prompts
         * 
         * Validates: Requirements 1.3, 1.4
         */
        it('should have separate buildTarget and deploymentTarget prompts', function() {
            this.timeout(10000);

            const buildTargetPrompt = findPrompt('buildTarget');
            const deploymentTargetPrompt = findPrompt('deploymentTarget');

            // Both prompts must exist
            assert.ok(buildTargetPrompt, 'buildTarget prompt must exist');
            assert.ok(deploymentTargetPrompt, 'deploymentTarget prompt must exist');

            // They must be different prompts
            assert.notStrictEqual(
                buildTargetPrompt,
                deploymentTargetPrompt,
                'buildTarget and deploymentTarget must be separate prompts'
            );

            // buildTarget should have 'codebuild' as an option
            const buildTargetChoices = typeof buildTargetPrompt.choices === 'function'
                ? buildTargetPrompt.choices({})
                : buildTargetPrompt.choices;
            
            const hasCodebuild = buildTargetChoices.some(
                choice => (typeof choice === 'object' ? choice.value : choice) === 'codebuild'
            );
            assert.ok(hasCodebuild, 'buildTarget must have codebuild as an option');

            // deploymentTarget should have both managed-inference and hyperpod-eks
            const deploymentTargetChoices = typeof deploymentTargetPrompt.choices === 'function'
                ? deploymentTargetPrompt.choices({})
                : deploymentTargetPrompt.choices;
            
            const hasManagedInference = deploymentTargetChoices.some(
                choice => (typeof choice === 'object' ? choice.value : choice) === 'managed-inference'
            );
            const hasHyperPodEks = deploymentTargetChoices.some(
                choice => (typeof choice === 'object' ? choice.value : choice) === 'hyperpod-eks'
            );
            
            assert.ok(hasManagedInference, 'deploymentTarget must have managed-inference as an option');
            assert.ok(hasHyperPodEks, 'deploymentTarget must have hyperpod-eks as an option');
        });

        /**
         * Property 1b: Changing buildTarget should not affect deployment-related prompt visibility
         * 
         * Validates: Requirements 1.3, 1.4
         */
        it('should not change deployment prompt visibility when buildTarget changes', function() {
            this.timeout(10000);

            fc.assert(fc.property(
                fc.record({
                    deploymentTarget: fc.constantFrom('managed-inference', 'hyperpod-eks'),
                    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask')
                }),
                (baseAnswers) => {
                    // Test with buildTarget = 'codebuild'
                    const answersWithCodebuild = {
                        ...baseAnswers,
                        buildTarget: 'codebuild'
                    };

                    // Get deployment-related prompts
                    const instanceTypePrompt = findPrompt('instanceType');
                    const hyperPodClusterPrompt = findPrompt('hyperPodCluster');

                    // Evaluate visibility with codebuild
                    const instanceTypeVisibleCodebuild = instanceTypePrompt && instanceTypePrompt.when
                        ? evaluateWhen(instanceTypePrompt, answersWithCodebuild)
                        : true;
                    
                    const hyperPodVisibleCodebuild = hyperPodClusterPrompt
                        ? evaluateWhen(hyperPodClusterPrompt, answersWithCodebuild)
                        : false;

                    // The visibility should depend only on deploymentTarget, not buildTarget
                    // Since we only have 'codebuild' as a build target currently,
                    // we verify that the visibility is consistent with deploymentTarget
                    if (baseAnswers.deploymentTarget === 'managed-inference') {
                        if (instanceTypePrompt && instanceTypePrompt.when) {
                            assert.strictEqual(
                                instanceTypeVisibleCodebuild,
                                true,
                                'instanceType visibility should depend on deploymentTarget, not buildTarget'
                            );
                        }
                        assert.strictEqual(
                            hyperPodVisibleCodebuild,
                            false,
                            'hyperPodCluster visibility should depend on deploymentTarget, not buildTarget'
                        );
                    } else {
                        // hyperpod-eks: both instanceType and HyperPod prompts should be visible
                        if (instanceTypePrompt && instanceTypePrompt.when) {
                            assert.strictEqual(
                                instanceTypeVisibleCodebuild,
                                true,
                                'instanceType visibility should depend on deploymentTarget, not buildTarget'
                            );
                        }
                        assert.strictEqual(
                            hyperPodVisibleCodebuild,
                            true,
                            'hyperPodCluster visibility should depend on deploymentTarget, not buildTarget'
                        );
                    }

                    return true;
                }
            ), { numRuns: 5 });
        });

        /**
         * Property 1c: codebuildComputeType should depend only on buildTarget
         * 
         * Validates: Requirements 1.3, 1.4
         */
        it('should show codebuildComputeType only when buildTarget is codebuild', function() {
            this.timeout(10000);

            fc.assert(fc.property(
                fc.record({
                    deploymentTarget: fc.constantFrom('managed-inference', 'hyperpod-eks'),
                    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask')
                }),
                (baseAnswers) => {
                    const codebuildComputeTypePrompt = findPrompt('codebuildComputeType');
                    
                    if (!codebuildComputeTypePrompt) {
                        // If prompt doesn't exist, skip this test
                        return true;
                    }

                    // With buildTarget = 'codebuild', should be visible
                    const answersWithCodebuild = {
                        ...baseAnswers,
                        buildTarget: 'codebuild'
                    };
                    
                    const visibleWithCodebuild = evaluateWhen(codebuildComputeTypePrompt, answersWithCodebuild);
                    assert.strictEqual(
                        visibleWithCodebuild,
                        true,
                        'codebuildComputeType should be visible when buildTarget is codebuild'
                    );

                    // Visibility should not change based on deploymentTarget
                    // (it should only depend on buildTarget)
                    const answersWithDifferentDeployment = {
                        ...answersWithCodebuild,
                        deploymentTarget: baseAnswers.deploymentTarget === 'managed-inference' 
                            ? 'hyperpod-eks' 
                            : 'managed-inference'
                    };
                    
                    const visibleWithDifferentDeployment = evaluateWhen(
                        codebuildComputeTypePrompt, 
                        answersWithDifferentDeployment
                    );
                    
                    assert.strictEqual(
                        visibleWithCodebuild,
                        visibleWithDifferentDeployment,
                        'codebuildComputeType visibility should not depend on deploymentTarget'
                    );

                    return true;
                }
            ), { numRuns: 5 });
        });
    });

    describe('Prompt Default Values', () => {
        /**
         * Verify HyperPod prompts have correct default values
         * 
         * Validates: Requirements 2.5, 2.6
         */
        it('should have correct default values for HyperPod prompts', () => {
            const hyperPodNamespacePrompt = findPrompt('hyperPodNamespace');
            const hyperPodReplicasPrompt = findPrompt('hyperPodReplicas');

            if (hyperPodNamespacePrompt) {
                const defaultNamespace = typeof hyperPodNamespacePrompt.default === 'function'
                    ? hyperPodNamespacePrompt.default({})
                    : hyperPodNamespacePrompt.default;
                
                assert.strictEqual(
                    defaultNamespace,
                    'default',
                    'hyperPodNamespace should default to "default"'
                );
            }

            if (hyperPodReplicasPrompt) {
                const defaultReplicas = typeof hyperPodReplicasPrompt.default === 'function'
                    ? hyperPodReplicasPrompt.default({})
                    : hyperPodReplicasPrompt.default;
                
                assert.strictEqual(
                    defaultReplicas,
                    1,
                    'hyperPodReplicas should default to 1'
                );
            }
        });

        /**
         * Verify deploymentTarget defaults to managed-inference
         */
        it('should default deploymentTarget to managed-inference', () => {
            const deploymentTargetPrompt = findPrompt('deploymentTarget');
            
            assert.ok(deploymentTargetPrompt, 'deploymentTarget prompt must exist');
            
            const defaultValue = typeof deploymentTargetPrompt.default === 'function'
                ? deploymentTargetPrompt.default({})
                : deploymentTargetPrompt.default;
            
            assert.strictEqual(
                defaultValue,
                'managed-inference',
                'deploymentTarget should default to managed-inference'
            );
        });
    });
});
