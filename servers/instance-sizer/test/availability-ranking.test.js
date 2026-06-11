#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Availability Ranking function.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/availability-ranking.test.js
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 7.1, 7.2, 7.3, 7.4
 */

import assert from 'node:assert';
import {
    applyAvailabilityRanking,
    CAPACITY_TYPE_PRIORITY
} from '../lib/instance-ranker.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

/**
 * Helper: create a minimal recommendation object.
 */
function makeRec(instanceType) {
    return { instanceType, totalVramGb: 24, gpuCount: 1 };
}

// ── CAPACITY_TYPE_PRIORITY constant ──────────────────────────────────────────

console.log('\navailability-ranking: CAPACITY_TYPE_PRIORITY constant\n');

test('reserved has priority 0', () => {
    assert.strictEqual(CAPACITY_TYPE_PRIORITY.reserved, 0);
});

test('ftp has priority 1', () => {
    assert.strictEqual(CAPACITY_TYPE_PRIORITY.ftp, 1);
});

test('on-demand has priority 2', () => {
    assert.strictEqual(CAPACITY_TYPE_PRIORITY['on-demand'], 2);
});

// ── Reserved instances sort first ────────────────────────────────────────────

console.log('\navailability-ranking: reserved instances sort first\n');

test('reserved instances sort before FTP and on-demand', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.p4d.24xlarge'),
        makeRec('ml.g5.2xlarge')
    ];

    const reservations = new Map([
        ['ml.g5.2xlarge', { reservationId: 'cr-abc', type: 'odcr', count: 2, startDate: '2025-01-01', endDate: null }]
    ]);
    const ftps = new Map([
        ['ml.p4d.24xlarge', { planName: 'plan-1', remainingCapacity: 4, expiresAt: '2025-06-30' }]
    ]);
    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 1, headroom: 4 }],
        ['ml.p4d.24xlarge', { quota: 2, deployed: 0, headroom: 2 }],
        ['ml.g5.2xlarge', { quota: 3, deployed: 0, headroom: 3 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, reservations, ftps);

    assert.strictEqual(result[0].instanceType, 'ml.g5.2xlarge', 'reserved should be first');
    assert.strictEqual(result[0].capacityType, 'reserved');
});

// ── FTP instances sort after reserved, before on-demand ──────────────────────

console.log('\navailability-ranking: FTP instances sort after reserved, before on-demand\n');

test('FTP instances sort after reserved but before on-demand', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.p4d.24xlarge'),
        makeRec('ml.g5.2xlarge')
    ];

    const reservations = new Map([
        ['ml.g5.2xlarge', { reservationId: 'cr-abc', type: 'odcr', count: 2, startDate: '2025-01-01', endDate: null }]
    ]);
    const ftps = new Map([
        ['ml.p4d.24xlarge', { planName: 'plan-1', remainingCapacity: 4, expiresAt: '2025-06-30' }]
    ]);
    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 1, headroom: 4 }],
        ['ml.p4d.24xlarge', { quota: 2, deployed: 0, headroom: 2 }],
        ['ml.g5.2xlarge', { quota: 3, deployed: 0, headroom: 3 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, reservations, ftps);

    assert.strictEqual(result[0].capacityType, 'reserved', 'first should be reserved');
    assert.strictEqual(result[1].capacityType, 'ftp', 'second should be ftp');
    assert.strictEqual(result[2].capacityType, 'on-demand', 'third should be on-demand');
});

// ── Zero-quota instances filtered out ────────────────────────────────────────

console.log('\navailability-ranking: zero-quota instances filtered out\n');

test('zero-quota instances are filtered out entirely', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.g5.2xlarge'),
        makeRec('ml.p4d.24xlarge')
    ];

    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 1, headroom: 4 }],
        ['ml.g5.2xlarge', { quota: 2, deployed: 2, headroom: 0 }],
        ['ml.p4d.24xlarge', { quota: 1, deployed: 1, headroom: 0 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, null, null);

    assert.strictEqual(result.length, 1, 'should only have 1 instance remaining');
    assert.strictEqual(result[0].instanceType, 'ml.g5.xlarge');
    assert.strictEqual(result[0].quotaStatus, 'available');
});

// ── Limited instances annotated correctly ────────────────────────────────────

console.log('\navailability-ranking: limited instances annotated correctly\n');

test('limited instances (headroom < 2) get quotaStatus = limited', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.g5.2xlarge')
    ];

    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 4, headroom: 1 }],
        ['ml.g5.2xlarge', { quota: 10, deployed: 2, headroom: 8 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, null, null);

    const limited = result.find(r => r.instanceType === 'ml.g5.xlarge');
    const available = result.find(r => r.instanceType === 'ml.g5.2xlarge');

    assert.strictEqual(limited.quotaStatus, 'limited');
    assert.strictEqual(limited.quotaHeadroom, 1);
    assert.strictEqual(available.quotaStatus, 'available');
    assert.strictEqual(available.quotaHeadroom, 8);
});

// ── Null inputs (API failures) produce unmodified ranking ────────────────────

console.log('\navailability-ranking: null inputs (API failures) produce unmodified ranking\n');

test('when all three inputs are null, returns recommendations unmodified', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.g5.2xlarge'),
        makeRec('ml.p4d.24xlarge')
    ];

    const result = applyAvailabilityRanking(recs, null, null, null);

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].instanceType, 'ml.g5.xlarge');
    assert.strictEqual(result[1].instanceType, 'ml.g5.2xlarge');
    assert.strictEqual(result[2].instanceType, 'ml.p4d.24xlarge');
    // Should not have capacityType or quotaStatus annotations
    assert.strictEqual(result[0].capacityType, undefined);
    assert.strictEqual(result[0].quotaStatus, undefined);
});

test('when reservations is null but quotas/ftps have data, still works', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.p4d.24xlarge')
    ];

    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 1, headroom: 4 }],
        ['ml.p4d.24xlarge', { quota: 2, deployed: 0, headroom: 2 }]
    ]);
    const ftps = new Map([
        ['ml.p4d.24xlarge', { planName: 'plan-1', remainingCapacity: 4, expiresAt: '2025-06-30' }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, null, ftps);

    assert.strictEqual(result.length, 2);
    // FTP should sort first since no reservations
    assert.strictEqual(result[0].instanceType, 'ml.p4d.24xlarge');
    assert.strictEqual(result[0].capacityType, 'ftp');
    assert.strictEqual(result[1].instanceType, 'ml.g5.xlarge');
    assert.strictEqual(result[1].capacityType, 'on-demand');
});

// ── Empty reservations/FTPs don't change order ───────────────────────────────

console.log('\navailability-ranking: empty reservations/FTPs don\'t change order\n');

test('empty Maps (no reservations, no FTPs) don\'t change order', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.g5.2xlarge'),
        makeRec('ml.p4d.24xlarge')
    ];

    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 1, headroom: 4 }],
        ['ml.g5.2xlarge', { quota: 3, deployed: 0, headroom: 3 }],
        ['ml.p4d.24xlarge', { quota: 2, deployed: 0, headroom: 2 }]
    ]);
    const reservations = new Map();
    const ftps = new Map();

    const result = applyAvailabilityRanking(recs, quotas, reservations, ftps);

    // All on-demand, order preserved
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].instanceType, 'ml.g5.xlarge');
    assert.strictEqual(result[1].instanceType, 'ml.g5.2xlarge');
    assert.strictEqual(result[2].instanceType, 'ml.p4d.24xlarge');
    assert.strictEqual(result[0].capacityType, 'on-demand');
    assert.strictEqual(result[1].capacityType, 'on-demand');
    assert.strictEqual(result[2].capacityType, 'on-demand');
});

// ── reservationInfo attached ─────────────────────────────────────────────────

console.log('\navailability-ranking: reservationInfo attached\n');

test('reservationInfo is attached when instance has capacity reservation', () => {
    const recs = [makeRec('ml.g5.xlarge')];

    const reservations = new Map([
        ['ml.g5.xlarge', { planName: 'my-inference-plan', planArn: 'arn:aws:sagemaker:us-west-2:123456789012:training-plan/my-inference-plan', type: 'training-plan', count: 3, startDate: '2025-01-01T00:00:00Z', endDate: null }]
    ]);
    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 1, headroom: 4 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, reservations, null);

    assert.strictEqual(result[0].capacityType, 'reserved');
    assert.strictEqual(result[0].reservationType, 'training-plan');
    assert.strictEqual(result[0].reservationInfo.planName, 'my-inference-plan');
    assert.strictEqual(result[0].reservationInfo.planArn, 'arn:aws:sagemaker:us-west-2:123456789012:training-plan/my-inference-plan');
});

test('reservationInfo includes endDate for time-bounded training plans', () => {
    const recs = [makeRec('ml.p4d.24xlarge')];

    const reservations = new Map([
        ['ml.p4d.24xlarge', { planName: 'eval-plan', planArn: 'arn:aws:sagemaker:us-west-2:123456789012:training-plan/eval-plan', type: 'training-plan', count: 2, startDate: '2025-05-01T00:00:00Z', endDate: '2025-06-01T00:00:00Z' }]
    ]);
    const quotas = new Map([
        ['ml.p4d.24xlarge', { quota: 2, deployed: 0, headroom: 2 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, reservations, null);

    assert.strictEqual(result[0].capacityType, 'reserved');
    assert.strictEqual(result[0].reservationType, 'training-plan');
    assert.strictEqual(result[0].reservationInfo.endDate, '2025-06-01T00:00:00Z');
});

// ── ftpInfo attached ─────────────────────────────────────────────────────────

console.log('\navailability-ranking: ftpInfo attached\n');

test('ftpInfo is attached when instance is covered by FTP', () => {
    const recs = [makeRec('ml.p4d.24xlarge')];

    const ftps = new Map([
        ['ml.p4d.24xlarge', { planName: 'my-training-plan', remainingCapacity: 8, expiresAt: '2025-06-30T00:00:00Z' }]
    ]);
    const quotas = new Map([
        ['ml.p4d.24xlarge', { quota: 2, deployed: 0, headroom: 2 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, null, ftps);

    assert.strictEqual(result[0].capacityType, 'ftp');
    assert.deepStrictEqual(result[0].ftpInfo, {
        planName: 'my-training-plan',
        remainingCapacity: 8,
        expiresAt: '2025-06-30T00:00:00Z'
    });
});

// ── Existing order within same tier preserved (stable sort) ──────────────────

console.log('\navailability-ranking: existing order within same tier preserved\n');

test('existing order within same tier is preserved (stable sort)', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.g5.2xlarge'),
        makeRec('ml.g5.4xlarge'),
        makeRec('ml.g5.8xlarge')
    ];

    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 0, headroom: 5 }],
        ['ml.g5.2xlarge', { quota: 5, deployed: 0, headroom: 5 }],
        ['ml.g5.4xlarge', { quota: 5, deployed: 0, headroom: 5 }],
        ['ml.g5.8xlarge', { quota: 5, deployed: 0, headroom: 5 }]
    ]);
    const reservations = new Map();
    const ftps = new Map();

    const result = applyAvailabilityRanking(recs, quotas, reservations, ftps);

    // All on-demand, original order should be preserved
    assert.strictEqual(result[0].instanceType, 'ml.g5.xlarge');
    assert.strictEqual(result[1].instanceType, 'ml.g5.2xlarge');
    assert.strictEqual(result[2].instanceType, 'ml.g5.4xlarge');
    assert.strictEqual(result[3].instanceType, 'ml.g5.8xlarge');
});

test('order within reserved tier is preserved', () => {
    const recs = [
        makeRec('ml.g5.xlarge'),
        makeRec('ml.g5.2xlarge'),
        makeRec('ml.g5.4xlarge')
    ];

    const reservations = new Map([
        ['ml.g5.xlarge', { reservationId: 'cr-1', type: 'odcr', count: 1, startDate: '2025-01-01', endDate: null }],
        ['ml.g5.2xlarge', { reservationId: 'cr-2', type: 'odcr', count: 1, startDate: '2025-01-01', endDate: null }],
        ['ml.g5.4xlarge', { reservationId: 'cr-3', type: 'odcr', count: 1, startDate: '2025-01-01', endDate: null }]
    ]);
    const quotas = new Map([
        ['ml.g5.xlarge', { quota: 5, deployed: 0, headroom: 5 }],
        ['ml.g5.2xlarge', { quota: 5, deployed: 0, headroom: 5 }],
        ['ml.g5.4xlarge', { quota: 5, deployed: 0, headroom: 5 }]
    ]);

    const result = applyAvailabilityRanking(recs, quotas, reservations, null);

    assert.strictEqual(result[0].instanceType, 'ml.g5.xlarge');
    assert.strictEqual(result[1].instanceType, 'ml.g5.2xlarge');
    assert.strictEqual(result[2].instanceType, 'ml.g5.4xlarge');
});

// ── Empty recommendations ────────────────────────────────────────────────────

console.log('\navailability-ranking: empty recommendations\n');

test('empty recommendations array returns empty array', () => {
    const quotas = new Map([['ml.g5.xlarge', { quota: 5, deployed: 0, headroom: 5 }]]);
    const result = applyAvailabilityRanking([], quotas, null, null);
    assert.deepStrictEqual(result, []);
});

test('null recommendations returns empty array', () => {
    const result = applyAvailabilityRanking(null, null, null, null);
    assert.deepStrictEqual(result, []);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);
