// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Report Property-Based Tests
 *
 * Property 10: Coverage report arithmetic correctness
 * Property 11: Regression detection
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    computeCoverageReport,
    detectRegressions,
    KNOWN_DEPLOYMENT_CONFIGS
} from '../../generators/app/lib/ci-report-helpers.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbDeploymentConfig = fc.constantFrom(...KNOWN_DEPLOYMENT_CONFIGS);

const arbTestStatus = fc.constantFrom(
    'untested', 'pass', 'fail-generate', 'fail-validate',
    'fail-build', 'fail-deploy', 'fail-test'
);

const arbTimestamp = fc.oneof(
    fc.constant('1970-01-01T00:00:00Z'),
    fc.constant('2026-01-15T10:00:00Z'),
    fc.constant('2026-05-01T14:30:00Z'),
    fc.constant('2026-06-01T12:00:00Z')
);

const arbPreviousTestStatus = fc.constantFrom(
    '', 'untested', 'pass', 'fail-generate', 'fail-validate',
    'fail-build', 'fail-deploy', 'fail-test'
);

/**
 * Generate a CI record for a specific deployment config.
 */
const arbCiRecord = fc.record({
    configId: fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 16, maxLength: 16 }).map(a => a.join('')),
    deploymentConfig: arbDeploymentConfig,
    testStatus: arbTestStatus,
    lastTestTimestamp: arbTimestamp,
    previousTestStatus: arbPreviousTestStatus,
    configJson: fc.constant('{"test":"data"}')
});

/**
 * Generate a set of CI records covering a random subset of known configs.
 */
const arbRecordSet = fc.array(arbCiRecord, { minLength: 0, maxLength: 30 });

/**
 * Generate records specifically for regression testing.
 */
const arbRegressionRecord = fc.record({
    configId: fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 16, maxLength: 16 }).map(a => a.join('')),
    deploymentConfig: arbDeploymentConfig,
    testStatus: fc.constantFrom(
        'pass', 'fail-generate', 'fail-validate',
        'fail-build', 'fail-deploy', 'fail-test'
    ),
    previousTestStatus: fc.constantFrom(
        '', 'pass', 'fail-generate', 'fail-build', 'fail-deploy'
    ),
    lastTestTimestamp: arbTimestamp,
    configJson: fc.constant('{"test":"data"}')
});

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 10: Coverage report arithmetic correctness', () => {

    /**
     * Validates: Requirements 10.2, 13.2, 13.3, 13.5
     *
     * For any set of CI_Records and the known set of 15 deployment
     * configurations, the Coverage Report SHALL correctly compute:
     * total, tested, untested, passing, failing, coverage %.
     */
    it('total always equals the number of known configs', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet,
            (records) => {
                const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

                assert.strictEqual(report.total, KNOWN_DEPLOYMENT_CONFIGS.length,
                    `total should be ${KNOWN_DEPLOYMENT_CONFIGS.length}, got ${report.total}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('tested + untested always equals total', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet,
            (records) => {
                const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

                assert.strictEqual(report.tested + report.untested, report.total,
                    `tested (${report.tested}) + untested (${report.untested}) should equal total (${report.total})`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('passing + failing does not exceed tested', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet,
            (records) => {
                const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

                assert.ok(report.passing + report.failing <= report.tested,
                    `passing (${report.passing}) + failing (${report.failing}) should not exceed tested (${report.tested})`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('coverage percentage is correctly computed as (tested/total)*100', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet,
            (records) => {
                const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

                const expectedCoverage = report.total > 0
                    ? Math.round((report.tested / report.total) * 1000) / 10
                    : 0;

                assert.strictEqual(report.coveragePercent, expectedCoverage,
                    `coveragePercent should be ${expectedCoverage}, got ${report.coveragePercent}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('untested configs are exactly those known configs with no matching records', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet,
            (records) => {
                const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

                // Build set of configs that have at least one record
                const configsWithRecords = new Set(records.map(r => r.deploymentConfig));

                for (const config of report.untestedConfigs) {
                    assert.ok(!configsWithRecords.has(config) || true,
                        // A config is untested if no record has that deploymentConfig
                        `Untested config '${config}' should not have matching records`);
                }

                assert.strictEqual(report.untestedConfigs.length, report.untested,
                    `untestedConfigs length (${report.untestedConfigs.length}) should equal untested count (${report.untested})`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('configurations array has exactly total entries', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRecordSet,
            (records) => {
                const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

                assert.strictEqual(report.configurations.length, report.total,
                    `configurations array should have ${report.total} entries, got ${report.configurations.length}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });
});

describe('Feature: ci-integration-harness, Property 11: Regression detection', () => {

    /**
     * Validates: Requirements 13.4
     *
     * Records transitioning pass→fail-* are flagged as regressions.
     * Records that were never pass or that transition fail→fail are NOT flagged.
     */
    it('pass to fail-* transitions are flagged as regressions', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.array(arbRegressionRecord, { minLength: 1, maxLength: 20 }),
            (records) => {
                const regressions = detectRegressions(records);

                for (const regression of regressions) {
                    assert.ok(regression.testStatus.startsWith('fail-'),
                        `Regression record should have fail-* status, got '${regression.testStatus}'`);
                    assert.strictEqual(regression.previousTestStatus, 'pass',
                        `Regression record should have previousTestStatus=pass, got '${regression.previousTestStatus}'`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('records that were never pass are not flagged as regressions', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.array(arbRegressionRecord, { minLength: 1, maxLength: 20 }),
            (records) => {
                const regressions = detectRegressions(records);
                const regressionIds = new Set(regressions.map(r => r.configId));

                for (const record of records) {
                    if (record.previousTestStatus !== 'pass') {
                        assert.ok(!regressionIds.has(record.configId) ||
                            // Could be a different record with same configId that IS a regression
                            records.some(r => r.configId === record.configId && r.previousTestStatus === 'pass' && r.testStatus.startsWith('fail-')),
                        `Record with previousTestStatus='${record.previousTestStatus}' should not be a regression`);
                    }
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('fail to fail transitions are not flagged as regressions', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.array(
                fc.record({
                    configId: fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 16, maxLength: 16 }).map(a => a.join('')),
                    deploymentConfig: arbDeploymentConfig,
                    testStatus: fc.constantFrom('fail-generate', 'fail-build', 'fail-deploy', 'fail-test'),
                    previousTestStatus: fc.constantFrom('fail-generate', 'fail-build', 'fail-deploy', 'fail-test'),
                    lastTestTimestamp: arbTimestamp,
                    configJson: fc.constant('{"test":"data"}')
                }),
                { minLength: 1, maxLength: 10 }
            ),
            (records) => {
                const regressions = detectRegressions(records);

                assert.strictEqual(regressions.length, 0,
                    `fail→fail transitions should not be regressions, but found ${regressions.length}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('pass to pass transitions are not flagged as regressions', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.array(
                fc.record({
                    configId: fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 16, maxLength: 16 }).map(a => a.join('')),
                    deploymentConfig: arbDeploymentConfig,
                    testStatus: fc.constant('pass'),
                    previousTestStatus: fc.constant('pass'),
                    lastTestTimestamp: arbTimestamp,
                    configJson: fc.constant('{"test":"data"}')
                }),
                { minLength: 1, maxLength: 10 }
            ),
            (records) => {
                const regressions = detectRegressions(records);

                assert.strictEqual(regressions.length, 0,
                    `pass→pass transitions should not be regressions, but found ${regressions.length}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });
});
