// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager HyperPod Validation Property-Based Tests
 *
 * Property 12: HyperPod Validation Rules
 * Validates: Requirements 10.3, 10.4, 10.5, 10.6
 *
 * Property 13: Enum Validation
 * Validates: Requirements 1.5, 1.6, 10.1, 10.2
 *
 * Feature: sagemaker-hyperpod-deployment
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import TemplateManager from '../../generators/app/lib/template-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Shared arbitrary generators ──────────────────────────────────────────────

/** Base answers that are always valid (non-HyperPod fields) */
const baseValidAnswers = {
    deploymentConfig: 'http-flask',
    awsRegion: 'us-east-1'
};

/** Valid RFC 1123 DNS label: lowercase alphanumeric + hyphens, 1-63 chars, no leading/trailing hyphen */
const arbValidNamespace = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/)
    .filter(s => s.length >= 1 && s.length <= 63);

/** Invalid namespace: strings that violate RFC 1123 */
const arbInvalidNamespace = fc.oneof(
    // Starts with hyphen
    fc.stringMatching(/^-[a-z0-9-]{0,10}$/).filter(s => s.length > 0),
    // Ends with hyphen
    fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,10}-$/).filter(s => s.length > 1),
    // Contains uppercase
    fc.stringMatching(/^[a-z0-9]*[A-Z][a-zA-Z0-9-]*$/).filter(s => s.length > 0),
    // Contains special characters
    fc.stringMatching(/^[a-z0-9]*[_.!@#][a-z0-9]*$/).filter(s => s.length > 0),
    // Too long (>63 chars)
    fc.stringMatching(/^[a-z][a-z0-9]{63,80}$/)
);

/** Valid cluster name */
const arbValidClusterName = fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/).filter(s => s.length > 0);

/** Valid replicas (integer >= 1) */
const arbValidReplicas = fc.integer({ min: 1, max: 1000 });

/** Invalid replicas */
const arbInvalidReplicas = fc.oneof(
    fc.integer({ min: -100, max: 0 }),
    fc.double({ min: 0.1, max: 99.9, noNaN: true }).filter(v => !Number.isInteger(v))
);

// ── Property 12: HyperPod Validation Rules ───────────────────────────────────

describe('Template Manager HyperPod Validation Property-Based Tests', () => {

    describe('Property 12: HyperPod Validation Rules', () => {

        it('valid HyperPod config always passes validation (Req 10.3, 10.4, 10.5)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbValidClusterName,
                arbValidNamespace,
                arbValidReplicas,
                (cluster, namespace, replicas) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget: 'codebuild',
                        deploymentTarget: 'hyperpod-eks',
                        hyperPodCluster: cluster,
                        hyperPodNamespace: namespace,
                        hyperPodReplicas: replicas
                    };

                    const manager = new TemplateManager(answers);
                    // Should not throw
                    manager.validate();
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('empty or missing hyperPodCluster always fails validation (Req 10.3)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.oneof(
                    fc.constant(''),
                    fc.constant('   '),
                    fc.constant(undefined),
                    fc.constant(null)
                ),
                arbValidNamespace,
                arbValidReplicas,
                (cluster, namespace, replicas) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget: 'codebuild',
                        deploymentTarget: 'hyperpod-eks',
                        hyperPodCluster: cluster,
                        hyperPodNamespace: namespace,
                        hyperPodReplicas: replicas
                    };

                    const manager = new TemplateManager(answers);
                    assert.throws(
                        () => manager.validate(),
                        /hyperPodCluster is required/,
                        'Should throw for empty/missing hyperPodCluster'
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('invalid namespace always fails validation (Req 10.4, 10.6)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbValidClusterName,
                arbInvalidNamespace,
                arbValidReplicas,
                (cluster, namespace, replicas) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget: 'codebuild',
                        deploymentTarget: 'hyperpod-eks',
                        hyperPodCluster: cluster,
                        hyperPodNamespace: namespace,
                        hyperPodReplicas: replicas
                    };

                    const manager = new TemplateManager(answers);
                    assert.throws(
                        () => manager.validate(),
                        /Invalid hyperPodNamespace/,
                        `Namespace "${namespace}" should fail RFC 1123 validation`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('invalid replicas always fails validation (Req 10.5, 10.6)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbValidClusterName,
                arbValidNamespace,
                arbInvalidReplicas,
                (cluster, namespace, replicas) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget: 'codebuild',
                        deploymentTarget: 'hyperpod-eks',
                        hyperPodCluster: cluster,
                        hyperPodNamespace: namespace,
                        hyperPodReplicas: replicas
                    };

                    const manager = new TemplateManager(answers);
                    assert.throws(
                        () => manager.validate(),
                        /Invalid hyperPodReplicas/,
                        `Replicas "${replicas}" should fail validation`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('validation errors always include descriptive field name (Req 10.6)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            // Test cluster error message
            const clusterAnswers = {
                ...baseValidAnswers,
                buildTarget: 'codebuild',
                deploymentTarget: 'hyperpod-eks',
                hyperPodCluster: '',
                hyperPodNamespace: 'default',
                hyperPodReplicas: 1
            };
            const clusterManager = new TemplateManager(clusterAnswers);
            assert.throws(() => clusterManager.validate(), /hyperPodCluster/);

            // Test namespace error message
            const nsAnswers = {
                ...baseValidAnswers,
                buildTarget: 'codebuild',
                deploymentTarget: 'hyperpod-eks',
                hyperPodCluster: 'my-cluster',
                hyperPodNamespace: '-invalid',
                hyperPodReplicas: 1
            };
            const nsManager = new TemplateManager(nsAnswers);
            assert.throws(() => nsManager.validate(), /hyperPodNamespace/);

            // Test replicas error message
            const repAnswers = {
                ...baseValidAnswers,
                buildTarget: 'codebuild',
                deploymentTarget: 'hyperpod-eks',
                hyperPodCluster: 'my-cluster',
                hyperPodNamespace: 'default',
                hyperPodReplicas: 0
            };
            const repManager = new TemplateManager(repAnswers);
            assert.throws(() => repManager.validate(), /hyperPodReplicas/);
        });

        it('HyperPod validation is skipped for managed-inference (Req 10.3, 10.4, 10.5)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constant('managed-inference'),
                (deploymentTarget) => {
                    // managed-inference should not require HyperPod fields
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget: 'codebuild',
                        deploymentTarget,
                        instanceType: 'ml.m5.large'
                        // No hyperPodCluster, hyperPodNamespace, hyperPodReplicas
                    };

                    const manager = new TemplateManager(answers);
                    manager.validate();
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // ── Property 13: Enum Validation ─────────────────────────────────────────

    describe('Property 13: Enum Validation', () => {

        it('valid buildTarget values always pass validation (Req 1.5, 10.1)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom('codebuild'),
                (buildTarget) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget,
                        deploymentTarget: 'managed-inference',
                        instanceType: 'ml.m5.large'
                    };

                    const manager = new TemplateManager(answers);
                    manager.validate();
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('invalid buildTarget values always fail validation (Req 1.5, 10.1)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 30 })
                    .filter(s => !['codebuild'].includes(s)),
                (buildTarget) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget,
                        deploymentTarget: 'managed-inference',
                        instanceType: 'ml.m5.large'
                    };

                    const manager = new TemplateManager(answers);
                    assert.throws(
                        () => manager.validate(),
                        /not implemented yet for buildTarget/,
                        `buildTarget "${buildTarget}" should fail validation`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('valid deploymentTarget values always pass validation (Req 1.6, 10.2)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom('managed-inference', 'hyperpod-eks'),
                (deploymentTarget) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget: 'codebuild',
                        deploymentTarget
                    };

                    // Add required fields based on deployment target
                    if (deploymentTarget === 'managed-inference') {
                        answers.instanceType = 'ml.m5.large';
                    } else {
                        answers.hyperPodCluster = 'my-cluster';
                        answers.hyperPodNamespace = 'default';
                        answers.hyperPodReplicas = 1;
                    }

                    const manager = new TemplateManager(answers);
                    manager.validate();
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('invalid deploymentTarget values always fail validation (Req 1.6, 10.2)', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 30 })
                    .filter(s => !['managed-inference', 'hyperpod-eks'].includes(s)),
                (deploymentTarget) => {
                    const answers = {
                        ...baseValidAnswers,
                        buildTarget: 'codebuild',
                        deploymentTarget
                    };

                    const manager = new TemplateManager(answers);
                    assert.throws(
                        () => manager.validate(),
                        /not implemented yet for deploymentTarget/,
                        `deploymentTarget "${deploymentTarget}" should fail validation`
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
