#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the hyperpod-cluster-picker MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/hyperpod-cluster-picker/test.js
 */

import assert from 'node:assert'
import { buildResponse } from './index.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    }
}

console.log('\nhyperpod-cluster-picker: buildResponse\n')

// --- Empty clusters returns empty choices with message ---
test('empty clusters returns empty choices with message', () => {
    const result = buildResponse([])
    assert.deepStrictEqual(result.choices.hyperPodCluster, [])
    assert.deepStrictEqual(result.values, {})
    assert.ok(result.message, 'should include a descriptive message')
    assert.ok(result.message.includes('No InService'), 'message should mention no clusters found')
})

test('null clusters returns empty choices with message', () => {
    const result = buildResponse(null)
    assert.deepStrictEqual(result.choices.hyperPodCluster, [])
    assert.deepStrictEqual(result.values, {})
    assert.ok(result.message)
})

// --- Single cluster ---
test('single cluster returns correct values and choices', () => {
    const clusters = [{
        clusterName: 'my-cluster',
        clusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/my-cluster',
        status: 'InService',
        instanceGroups: [{ name: 'gpu-workers', instanceType: 'ml.p4d.24xlarge', count: 4 }]
    }]
    const result = buildResponse(clusters)
    assert.strictEqual(result.values.hyperPodCluster, 'my-cluster')
    assert.deepStrictEqual(result.choices.hyperPodCluster, ['my-cluster'])
    assert.ok(result.metadata['my-cluster'])
    assert.strictEqual(result.metadata['my-cluster'].clusterArn, clusters[0].clusterArn)
})

// --- Multiple clusters ---
test('multiple clusters: first is default value', () => {
    const clusters = [
        { clusterName: 'cluster-a', clusterArn: 'arn:a', status: 'InService', instanceGroups: [] },
        { clusterName: 'cluster-b', clusterArn: 'arn:b', status: 'InService', instanceGroups: [] },
        { clusterName: 'cluster-c', clusterArn: 'arn:c', status: 'InService', instanceGroups: [] }
    ]
    const result = buildResponse(clusters)
    assert.strictEqual(result.values.hyperPodCluster, 'cluster-a')
    assert.strictEqual(result.choices.hyperPodCluster.length, 3)
    assert.deepStrictEqual(result.choices.hyperPodCluster, ['cluster-a', 'cluster-b', 'cluster-c'])
})

// --- Metadata includes instance groups ---
test('metadata includes instance group details', () => {
    const clusters = [{
        clusterName: 'gpu-cluster',
        clusterArn: 'arn:aws:sagemaker:us-west-2:123456789012:cluster/gpu-cluster',
        status: 'InService',
        instanceGroups: [
            { name: 'workers', instanceType: 'ml.g5.48xlarge', count: 8 },
            { name: 'controllers', instanceType: 'ml.m5.xlarge', count: 1 }
        ]
    }]
    const result = buildResponse(clusters)
    const meta = result.metadata['gpu-cluster']
    assert.strictEqual(meta.instanceGroups.length, 2)
    assert.strictEqual(meta.instanceGroups[0].instanceType, 'ml.g5.48xlarge')
    assert.strictEqual(meta.instanceGroups[1].count, 1)
})

// --- No message field when clusters are found ---
test('no message field when clusters are found', () => {
    const clusters = [
        { clusterName: 'c1', clusterArn: 'arn:c1', status: 'InService', instanceGroups: [] }
    ]
    const result = buildResponse(clusters)
    assert.strictEqual(result.message, undefined)
})

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)
