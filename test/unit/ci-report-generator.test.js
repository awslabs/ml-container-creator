// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Report Generator Unit Tests
 *
 * Tests the extracted helper functions that implement the core logic
 * behind `do/ci report`:
 *   - Coverage report computation (total, tested, passing, failing, untested, %)
 *   - Regression detection (pass → fail-* transitions)
 *   - Grouping by deployment config
 *   - Empty table handling
 *   - Coverage arithmetic edge cases
 *
 * Validates: Requirements 10.2, 13.2, 13.3, 13.4, 13.5
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import {
    computeCoverageReport,
    detectRegressions,
    groupByDeploymentConfig,
    KNOWN_DEPLOYMENT_CONFIGS
} from '../../src/lib/ci-report-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CI record for testing.
 */
function makeRecord(overrides = {}) {
    return {
        configId: overrides.configId || 'abc123',
        deploymentConfig: overrides.deploymentConfig || 'transformers-vllm',
        testStatus: overrides.testStatus || 'untested',
        lastTestTimestamp: overrides.lastTestTimestamp || '1970-01-01T00:00:00Z',
        previousTestStatus: overrides.previousTestStatus || '',
        ...overrides
    };
}

// ---------------------------------------------------------------------------
// KNOWN_DEPLOYMENT_CONFIGS
// ---------------------------------------------------------------------------

describe('CI Report — Known Deployment Configs', () => {

    it('contains exactly 15 deployment configurations', () => {
        assert.strictEqual(KNOWN_DEPLOYMENT_CONFIGS.length, 15);
    });

    it('includes all expected architecture prefixes', () => {
        const prefixes = new Set(KNOWN_DEPLOYMENT_CONFIGS.map(c => c.split('-')[0]));
        assert.ok(prefixes.has('transformers'));
        assert.ok(prefixes.has('http'));
        assert.ok(prefixes.has('triton'));
        assert.ok(prefixes.has('diffusors'));
    });

    it('has no duplicate entries', () => {
        const unique = new Set(KNOWN_DEPLOYMENT_CONFIGS);
        assert.strictEqual(unique.size, KNOWN_DEPLOYMENT_CONFIGS.length);
    });
});

// ---------------------------------------------------------------------------
// groupByDeploymentConfig
// ---------------------------------------------------------------------------

describe('CI Report — groupByDeploymentConfig', () => {

    it('returns an empty map for an empty array', () => {
        const groups = groupByDeploymentConfig([]);
        assert.strictEqual(groups.size, 0);
    });

    it('groups records by deploymentConfig', () => {
        const records = [
            makeRecord({ deploymentConfig: 'http-flask', configId: '1' }),
            makeRecord({ deploymentConfig: 'http-flask', configId: '2' }),
            makeRecord({ deploymentConfig: 'triton-fil', configId: '3' })
        ];

        const groups = groupByDeploymentConfig(records);
        assert.strictEqual(groups.size, 2);
        assert.strictEqual(groups.get('http-flask').length, 2);
        assert.strictEqual(groups.get('triton-fil').length, 1);
    });

    it('treats missing deploymentConfig as empty string', () => {
        const records = [
            makeRecord({ deploymentConfig: undefined, configId: '1' })
        ];

        const groups = groupByDeploymentConfig(records);
        assert.strictEqual(groups.size, 1);
        assert.ok(groups.has(''));
    });
});

// ---------------------------------------------------------------------------
// detectRegressions
// ---------------------------------------------------------------------------

describe('CI Report — detectRegressions', () => {

    it('returns empty array when no records exist', () => {
        assert.deepStrictEqual(detectRegressions([]), []);
    });

    it('detects a pass → fail-build regression', () => {
        const records = [
            makeRecord({ testStatus: 'fail-build', previousTestStatus: 'pass' })
        ];

        const regressions = detectRegressions(records);
        assert.strictEqual(regressions.length, 1);
        assert.strictEqual(regressions[0].testStatus, 'fail-build');
    });

    it('detects a pass → fail-deploy_test regression', () => {
        const records = [
            makeRecord({ testStatus: 'fail-deploy_test', previousTestStatus: 'pass' })
        ];

        const regressions = detectRegressions(records);
        assert.strictEqual(regressions.length, 1);
    });

    it('does not flag fail → fail as a regression', () => {
        const records = [
            makeRecord({ testStatus: 'fail-build', previousTestStatus: 'fail-generate' })
        ];

        const regressions = detectRegressions(records);
        assert.strictEqual(regressions.length, 0);
    });

    it('does not flag untested → fail as a regression', () => {
        const records = [
            makeRecord({ testStatus: 'fail-build', previousTestStatus: 'untested' })
        ];

        const regressions = detectRegressions(records);
        assert.strictEqual(regressions.length, 0);
    });

    it('does not flag records with no previousTestStatus as regressions', () => {
        const records = [
            makeRecord({ testStatus: 'fail-build', previousTestStatus: '' })
        ];

        const regressions = detectRegressions(records);
        assert.strictEqual(regressions.length, 0);
    });

    it('does not flag passing records as regressions', () => {
        const records = [
            makeRecord({ testStatus: 'pass', previousTestStatus: 'pass' })
        ];

        const regressions = detectRegressions(records);
        assert.strictEqual(regressions.length, 0);
    });

    it('handles multiple records with mixed regression states', () => {
        const records = [
            makeRecord({ configId: '1', testStatus: 'fail-build', previousTestStatus: 'pass' }),
            makeRecord({ configId: '2', testStatus: 'pass', previousTestStatus: 'pass' }),
            makeRecord({ configId: '3', testStatus: 'fail-generate', previousTestStatus: 'fail-build' }),
            makeRecord({ configId: '4', testStatus: 'fail-deploy_test', previousTestStatus: 'pass' })
        ];

        const regressions = detectRegressions(records);
        assert.strictEqual(regressions.length, 2);
        const ids = regressions.map(r => r.configId);
        assert.ok(ids.includes('1'));
        assert.ok(ids.includes('4'));
    });
});

// ---------------------------------------------------------------------------
// computeCoverageReport — empty table
// ---------------------------------------------------------------------------

describe('CI Report — computeCoverageReport (empty table)', () => {

    it('returns all configs as untested when no records exist', () => {
        const report = computeCoverageReport([], KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.total, 15);
        assert.strictEqual(report.tested, 0);
        assert.strictEqual(report.untested, 15);
        assert.strictEqual(report.passing, 0);
        assert.strictEqual(report.failing, 0);
        assert.strictEqual(report.coveragePercent, 0);
    });

    it('lists all known configs as untested', () => {
        const report = computeCoverageReport([], KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.untestedConfigs.length, 15);
        assert.deepStrictEqual(report.untestedConfigs, KNOWN_DEPLOYMENT_CONFIGS);
    });

    it('returns empty regressions array', () => {
        const report = computeCoverageReport([], KNOWN_DEPLOYMENT_CONFIGS);

        assert.deepStrictEqual(report.regressions, []);
    });

    it('returns 15 configuration entries all with status untested', () => {
        const report = computeCoverageReport([], KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.configurations.length, 15);
        for (const config of report.configurations) {
            assert.strictEqual(config.status, 'untested');
            assert.strictEqual(config.recordCount, 0);
        }
    });
});

// ---------------------------------------------------------------------------
// computeCoverageReport — various record sets
// ---------------------------------------------------------------------------

describe('CI Report — computeCoverageReport (various record sets)', () => {

    it('computes correct stats for a single passing config', () => {
        const records = [
            makeRecord({
                deploymentConfig: 'transformers-vllm',
                testStatus: 'pass',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.total, 15);
        assert.strictEqual(report.tested, 1);
        assert.strictEqual(report.passing, 1);
        assert.strictEqual(report.failing, 0);
        assert.strictEqual(report.untested, 14);
        assert.ok(report.coveragePercent > 6 && report.coveragePercent < 7);
    });

    it('computes correct stats for a single failing config', () => {
        const records = [
            makeRecord({
                deploymentConfig: 'http-flask',
                testStatus: 'fail-build',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.tested, 1);
        assert.strictEqual(report.passing, 0);
        assert.strictEqual(report.failing, 1);
        assert.strictEqual(report.untested, 14);
    });

    it('computes correct stats for all configs passing', () => {
        const records = KNOWN_DEPLOYMENT_CONFIGS.map(dc =>
            makeRecord({
                deploymentConfig: dc,
                testStatus: 'pass',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        );

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.total, 15);
        assert.strictEqual(report.tested, 15);
        assert.strictEqual(report.passing, 15);
        assert.strictEqual(report.failing, 0);
        assert.strictEqual(report.untested, 0);
        assert.strictEqual(report.coveragePercent, 100);
        assert.strictEqual(report.untestedConfigs.length, 0);
    });

    it('computes correct stats for mixed pass/fail/untested', () => {
        const records = [
            makeRecord({ deploymentConfig: 'transformers-vllm', testStatus: 'pass', lastTestTimestamp: '2025-06-01T12:00:00Z' }),
            makeRecord({ deploymentConfig: 'transformers-sglang', testStatus: 'pass', lastTestTimestamp: '2025-06-01T12:00:00Z' }),
            makeRecord({ deploymentConfig: 'http-flask', testStatus: 'fail-build', lastTestTimestamp: '2025-06-01T12:00:00Z' }),
            makeRecord({ deploymentConfig: 'triton-fil', testStatus: 'fail-deploy_test', lastTestTimestamp: '2025-06-01T12:00:00Z' })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.tested, 4);
        assert.strictEqual(report.passing, 2);
        assert.strictEqual(report.failing, 2);
        assert.strictEqual(report.untested, 11);
    });

    it('uses the most recent record when multiple exist for a config', () => {
        const records = [
            makeRecord({
                deploymentConfig: 'transformers-vllm',
                testStatus: 'fail-build',
                lastTestTimestamp: '2025-05-01T12:00:00Z'
            }),
            makeRecord({
                deploymentConfig: 'transformers-vllm',
                testStatus: 'pass',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.passing, 1);
        assert.strictEqual(report.failing, 0);

        const vllmConfig = report.configurations.find(c => c.deploymentConfig === 'transformers-vllm');
        assert.strictEqual(vllmConfig.status, 'pass');
        assert.strictEqual(vllmConfig.recordCount, 2);
    });

    it('ignores records for unknown deployment configs in coverage stats', () => {
        const records = [
            makeRecord({
                deploymentConfig: 'unknown-config',
                testStatus: 'pass',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

        // Unknown config is not in the known list, so tested count stays 0
        assert.strictEqual(report.tested, 0);
        assert.strictEqual(report.untested, 15);
    });

    it('handles records with "running" status as tested but neither passing nor failing', () => {
        const records = [
            makeRecord({
                deploymentConfig: 'http-flask',
                testStatus: 'running',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);

        assert.strictEqual(report.tested, 1);
        assert.strictEqual(report.passing, 0);
        assert.strictEqual(report.failing, 0);
    });
});

// ---------------------------------------------------------------------------
// computeCoverageReport — coverage arithmetic
// ---------------------------------------------------------------------------

describe('CI Report — Coverage Arithmetic', () => {

    it('coverage percent is 0 when no configs are tested', () => {
        const report = computeCoverageReport([], KNOWN_DEPLOYMENT_CONFIGS);
        assert.strictEqual(report.coveragePercent, 0);
    });

    it('coverage percent is 100 when all configs are tested', () => {
        const records = KNOWN_DEPLOYMENT_CONFIGS.map(dc =>
            makeRecord({ deploymentConfig: dc, testStatus: 'pass', lastTestTimestamp: '2025-06-01T12:00:00Z' })
        );
        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);
        assert.strictEqual(report.coveragePercent, 100);
    });

    it('coverage percent rounds to one decimal place', () => {
        // 1 out of 15 = 6.666...% → should round to 6.7
        const records = [
            makeRecord({ deploymentConfig: 'transformers-vllm', testStatus: 'pass', lastTestTimestamp: '2025-06-01T12:00:00Z' })
        ];
        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);
        assert.strictEqual(report.coveragePercent, 6.7);
    });

    it('total equals tested + untested', () => {
        const records = [
            makeRecord({ deploymentConfig: 'transformers-vllm', testStatus: 'pass', lastTestTimestamp: '2025-06-01T12:00:00Z' }),
            makeRecord({ deploymentConfig: 'http-flask', testStatus: 'fail-build', lastTestTimestamp: '2025-06-01T12:00:00Z' }),
            makeRecord({ deploymentConfig: 'triton-fil', testStatus: 'pass', lastTestTimestamp: '2025-06-01T12:00:00Z' })
        ];
        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);
        assert.strictEqual(report.total, report.tested + report.untested);
    });

    it('handles empty knownConfigs list gracefully', () => {
        const report = computeCoverageReport([], []);
        assert.strictEqual(report.total, 0);
        assert.strictEqual(report.tested, 0);
        assert.strictEqual(report.coveragePercent, 0);
    });

    it('handles custom knownConfigs list', () => {
        const customConfigs = ['config-a', 'config-b', 'config-c'];
        const records = [
            makeRecord({ deploymentConfig: 'config-a', testStatus: 'pass', lastTestTimestamp: '2025-06-01T12:00:00Z' })
        ];
        const report = computeCoverageReport(records, customConfigs);
        assert.strictEqual(report.total, 3);
        assert.strictEqual(report.tested, 1);
        assert.strictEqual(report.untested, 2);
        // 1/3 = 33.3%
        assert.strictEqual(report.coveragePercent, 33.3);
    });
});

// ---------------------------------------------------------------------------
// computeCoverageReport — regression detection integration
// ---------------------------------------------------------------------------

describe('CI Report — Regression Detection in Coverage Report', () => {

    it('includes regressions in the coverage report', () => {
        const records = [
            makeRecord({
                deploymentConfig: 'transformers-vllm',
                testStatus: 'fail-build',
                previousTestStatus: 'pass',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);
        assert.strictEqual(report.regressions.length, 1);
        assert.strictEqual(report.regressions[0].deploymentConfig, 'transformers-vllm');
    });

    it('does not include non-regressions in the regressions array', () => {
        const records = [
            makeRecord({
                deploymentConfig: 'transformers-vllm',
                testStatus: 'fail-build',
                previousTestStatus: 'fail-generate',
                lastTestTimestamp: '2025-06-01T12:00:00Z'
            })
        ];

        const report = computeCoverageReport(records, KNOWN_DEPLOYMENT_CONFIGS);
        assert.strictEqual(report.regressions.length, 0);
    });
});
