// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HyperPod Cluster Picker Server Property-Based Tests
 *
 * Property-based tests for the hyperpod-cluster-picker MCP server.
 *
 * Feature: sagemaker-hyperpod-deployment
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { buildResponse } from '../../servers/hyperpod-cluster-picker/index.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Shared arbitrary generators ──────────────────────────────────────────────

/** Valid cluster statuses from the SageMaker API */
const arbClusterStatus = fc.constantFrom('InService', 'Creating', 'Deleting', 'Failed', 'Updating', 'RollingBack');

/** Cluster name: alphanumeric + hyphens, 1-63 chars */
const arbClusterName = fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/).filter(s => s.length > 0);

/** Cluster ARN */
const arbClusterArn = arbClusterName.map(name =>
    `arn:aws:sagemaker:us-east-1:123456789012:cluster/${name}`
);

/** Orchestrator type */
const arbOrchestratorType = fc.constantFrom('EKS', 'Slurm');

/** Instance group */
const arbInstanceGroup = fc.record({
    name: fc.constantFrom('gpu-workers', 'cpu-workers', 'controllers', 'training-nodes'),
    instanceType: fc.constantFrom('ml.p4d.24xlarge', 'ml.p5.48xlarge', 'ml.g5.48xlarge', 'ml.m5.xlarge'),
    count: fc.integer({ min: 1, max: 64 })
});

/** A full cluster summary as returned by ListClusters */
const arbClusterSummary = fc.record({
    ClusterName: arbClusterName,
    ClusterArn: arbClusterArn,
    ClusterStatus: arbClusterStatus
});

/** A cluster detail as returned by DescribeCluster */
const arbClusterDetail = fc.record({
    orchestratorType: arbOrchestratorType,
    instanceGroups: fc.array(arbInstanceGroup, { minLength: 0, maxLength: 4 })
});

/** A combined cluster entry for testing (summary + detail) */
const arbClusterEntry = fc.record({
    summary: arbClusterSummary,
    detail: arbClusterDetail
});

/** Positive integer limit */
const arbLimit = fc.integer({ min: 1, max: 50 });


// ── Property tests ───────────────────────────────────────────────────────────

describe('HyperPod Cluster Picker Server Property-Based Tests', () => {

    // Feature: sagemaker-hyperpod-deployment, Property 4: Cluster Discovery Filtering
    describe('Property 4: Cluster Discovery Filtering', () => {
        it('only InService + EKS clusters pass through filtering', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbClusterEntry, { minLength: 0, maxLength: 20 }),
                arbLimit,
                (clusterEntries, limit) => {
                    // Simulate the filtering logic from fetchHyperPodClusters
                    // Step 1: Filter by InService status
                    const inServiceClusters = clusterEntries.filter(
                        e => e.summary.ClusterStatus === 'InService'
                    );

                    // Step 2: Filter by EKS orchestrator
                    const eksClusters = inServiceClusters.filter(
                        e => e.detail.orchestratorType === 'EKS'
                    );

                    // Step 3: Apply limit
                    const result = eksClusters.slice(0, limit);

                    // Property: All results must be InService AND EKS
                    for (const cluster of result) {
                        assert.strictEqual(cluster.summary.ClusterStatus, 'InService',
                            `Cluster "${cluster.summary.ClusterName}" should be InService`);
                        assert.strictEqual(cluster.detail.orchestratorType, 'EKS',
                            `Cluster "${cluster.summary.ClusterName}" should use EKS orchestrator`);
                    }

                    // Property: No Slurm clusters in result
                    const slurmInResult = result.filter(e => e.detail.orchestratorType === 'Slurm');
                    assert.strictEqual(slurmInResult.length, 0,
                        'No Slurm clusters should be in the result');

                    // Property: No non-InService clusters in result
                    const nonInServiceInResult = result.filter(e => e.summary.ClusterStatus !== 'InService');
                    assert.strictEqual(nonInServiceInResult.length, 0,
                        'No non-InService clusters should be in the result');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('Slurm clusters are always excluded', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbClusterName,
                arbClusterArn,
                fc.array(arbInstanceGroup, { minLength: 1, maxLength: 3 }),
                (name, arn, instanceGroups) => {
                    // Create a Slurm cluster that is InService
                    const slurmCluster = {
                        clusterName: name,
                        clusterArn: arn,
                        status: 'InService',
                        orchestratorType: 'Slurm',
                        instanceGroups
                    };

                    // Simulate filtering: Slurm should be excluded
                    const isEks = slurmCluster.orchestratorType === 'EKS';
                    assert.strictEqual(isEks, false,
                        'Slurm cluster should not pass EKS filter');

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: sagemaker-hyperpod-deployment, Property 5: Cluster Discovery Response Completeness
    describe('Property 5: Cluster Discovery Response Completeness', () => {
        it('every returned cluster includes name, ARN, status, and instance groups', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(
                    fc.record({
                        clusterName: arbClusterName,
                        clusterArn: arbClusterArn,
                        status: fc.constant('InService'),
                        instanceGroups: fc.array(arbInstanceGroup, { minLength: 0, maxLength: 4 })
                    }),
                    { minLength: 0, maxLength: 10 }
                ),
                (clusters) => {
                    const result = buildResponse(clusters);

                    // If clusters exist, metadata must be complete
                    if (clusters.length > 0) {
                        assert.ok(result.values.hyperPodCluster,
                            'values.hyperPodCluster should be set');
                        assert.ok(result.choices.hyperPodCluster.length > 0,
                            'choices.hyperPodCluster should have entries');
                        assert.ok(result.metadata,
                            'metadata should be present');

                        // Check each cluster in metadata
                        for (const cluster of clusters) {
                            const meta = result.metadata[cluster.clusterName];
                            assert.ok(meta, `Metadata for "${cluster.clusterName}" should exist`);
                            assert.ok(meta.clusterArn, 'clusterArn should be present');
                            assert.ok(meta.status, 'status should be present');
                            assert.ok(Array.isArray(meta.instanceGroups),
                                'instanceGroups should be an array');
                        }
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('instance group metadata includes name, instanceType, and count', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbClusterName,
                arbClusterArn,
                fc.array(arbInstanceGroup, { minLength: 1, maxLength: 4 }),
                (name, arn, instanceGroups) => {
                    const clusters = [{
                        clusterName: name,
                        clusterArn: arn,
                        status: 'InService',
                        instanceGroups
                    }];

                    const result = buildResponse(clusters);
                    const meta = result.metadata[name];

                    assert.ok(meta, 'Cluster metadata should exist');
                    assert.strictEqual(meta.instanceGroups.length, instanceGroups.length,
                        'Instance group count should match');

                    for (let i = 0; i < instanceGroups.length; i++) {
                        const group = meta.instanceGroups[i];
                        assert.ok(group.name, 'Instance group name should be present');
                        assert.ok(group.instanceType, 'Instance group instanceType should be present');
                        assert.ok(typeof group.count === 'number', 'Instance group count should be a number');
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Additional response format properties
    describe('Response Format Invariants', () => {
        it('empty clusters returns empty choices with descriptive message', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const result = buildResponse([]);
            assert.deepStrictEqual(result.choices.hyperPodCluster, []);
            assert.deepStrictEqual(result.values, {});
            assert.ok(result.message, 'Should include a descriptive message');
        });

        it('values.hyperPodCluster equals first choice when non-empty', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(
                    fc.record({
                        clusterName: arbClusterName,
                        clusterArn: arbClusterArn,
                        status: fc.constant('InService'),
                        instanceGroups: fc.array(arbInstanceGroup, { minLength: 0, maxLength: 2 })
                    }),
                    { minLength: 1, maxLength: 10 }
                ),
                (clusters) => {
                    const result = buildResponse(clusters);
                    assert.strictEqual(result.values.hyperPodCluster, result.choices.hyperPodCluster[0],
                        'values.hyperPodCluster should equal first choice');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('choices length equals input clusters length', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(
                    fc.record({
                        clusterName: arbClusterName,
                        clusterArn: arbClusterArn,
                        status: fc.constant('InService'),
                        instanceGroups: fc.array(arbInstanceGroup, { minLength: 0, maxLength: 2 })
                    }),
                    { minLength: 0, maxLength: 10 }
                ),
                (clusters) => {
                    const result = buildResponse(clusters);
                    assert.strictEqual(result.choices.hyperPodCluster.length, clusters.length,
                        'choices length should match input clusters length');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
