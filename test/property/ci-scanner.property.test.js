// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Scanner Property-Based Tests
 *
 * Property 5: Scanner record selection correctness
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    verbose: false
};

// ── Pure function mirroring scanner logic ────────────────────────────────────

/**
 * Select records for scanning based on the scanner's selection criteria.
 *
 * A record qualifies if:
 *   - testStatus === 'untested', OR
 *   - testStatus !== 'running' AND lastTestTimestamp < (now - 24 hours)
 *
 * Records with testStatus === 'running' are NEVER selected.
 *
 * @param {object[]} records - Array of CI_Record objects
 * @param {Date} now - Current timestamp
 * @returns {object[]} Records that qualify for scanning
 */
function selectRecordsForScanning(records, now) {
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    return records.filter(record => {
        const status = record.testStatus || 'untested';

        // Never select running records
        if (status === 'running') {
            return false;
        }

        // Always select untested records
        if (status === 'untested') {
            return true;
        }

        // Select non-running records with stale timestamps
        const lastTest = new Date(record.lastTestTimestamp || '1970-01-01T00:00:00Z');
        return lastTest < twentyFourHoursAgo;
    });
}

// ── Generators ───────────────────────────────────────────────────────────────

const ALL_STATUSES = ['untested', 'pass', 'fail-generate', 'fail-validate', 'fail-build', 'fail-deploy', 'fail-test', 'running'];

const arbTestStatus = fc.constantFrom(...ALL_STATUSES);

/**
 * Generate a timestamp that is either stale (>24h ago), fresh (<24h ago),
 * or epoch (for untested records).
 */
const arbTimestamp = (now) => fc.oneof(
    // Stale: 25-720 hours ago
    fc.integer({ min: 25, max: 720 }).map(hours =>
        new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString()
    ),
    // Fresh: 0-23 hours ago
    fc.integer({ min: 0, max: 23 }).map(hours =>
        new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString()
    ),
    // Epoch
    fc.constant('1970-01-01T00:00:00Z')
);

const arbConfigId = fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 16, maxLength: 16 }).map(a => a.join(''));

const arbRecord = (now) => fc.record({
    configId: arbConfigId,
    testStatus: arbTestStatus,
    lastTestTimestamp: arbTimestamp(now),
    configJson: fc.constant('{"test":"data"}')
});

const arbRecordSet = (now) => fc.array(arbRecord(now), { minLength: 0, maxLength: 20 });

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 5: Scanner record selection correctness', () => {

    const NOW = new Date('2026-06-01T12:00:00Z');

    /**
     * Validates: Requirements 3.2, 3.3, 3.4
     *
     * For any set of CI_Records with varying testStatus and lastTestTimestamp,
     * the scanner SHALL select exactly those where (testStatus=untested) OR
     * (testStatus NOT IN running AND lastTestTimestamp < now-24h), and SHALL
     * never select records with testStatus=running.
     */
    it('scanner never selects records with testStatus=running', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet(NOW),
            (records) => {
                const selected = selectRecordsForScanning(records, NOW);

                for (const record of selected) {
                    assert.notStrictEqual(record.testStatus, 'running',
                        `Scanner should never select running records, but selected configId=${record.configId}`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('scanner always selects untested records', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet(NOW),
            (records) => {
                const selected = selectRecordsForScanning(records, NOW);
                const selectedIds = new Set(selected.map(r => r.configId));

                const untestedRecords = records.filter(r => r.testStatus === 'untested');
                for (const record of untestedRecords) {
                    assert.ok(selectedIds.has(record.configId),
                        `Untested record configId=${record.configId} should be selected`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('scanner selects non-running records with stale timestamps (>24h)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet(NOW),
            (records) => {
                const selected = selectRecordsForScanning(records, NOW);
                const selectedIds = new Set(selected.map(r => r.configId));
                const twentyFourHoursAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

                for (const record of records) {
                    const status = record.testStatus || 'untested';
                    if (status === 'running' || status === 'untested') continue;

                    const lastTest = new Date(record.lastTestTimestamp || '1970-01-01T00:00:00Z');
                    if (lastTest < twentyFourHoursAgo) {
                        assert.ok(selectedIds.has(record.configId),
                            `Stale non-running record configId=${record.configId} (status=${status}, lastTest=${record.lastTestTimestamp}) should be selected`);
                    }
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('scanner does not select non-running, non-untested records with fresh timestamps (<24h)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet(NOW),
            (records) => {
                const selected = selectRecordsForScanning(records, NOW);
                const selectedIds = new Set(selected.map(r => r.configId));
                const twentyFourHoursAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

                for (const record of records) {
                    const status = record.testStatus || 'untested';
                    if (status === 'running' || status === 'untested') continue;

                    const lastTest = new Date(record.lastTestTimestamp || '1970-01-01T00:00:00Z');
                    if (lastTest >= twentyFourHoursAgo) {
                        assert.ok(!selectedIds.has(record.configId),
                            `Fresh non-running record configId=${record.configId} (status=${status}, lastTest=${record.lastTestTimestamp}) should NOT be selected`);
                    }
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });
});
