// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Stage Results Unit Tests
 *
 * Tests the extracted helper functions that implement the core logic
 * behind CodeBuild stage result handling:
 *   - Stage result parsing (DynamoDB map → plain objects)
 *   - Test status computation (first failing stage)
 *   - Skip logic (failure cascading with teardown/update exemption)
 *   - Structure validation (exactly 7 entries, required fields)
 *   - Error summary extraction
 *
 * Validates: Requirements 16.1, 16.2, 16.3, 16.4
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import {
    parseStageResults,
    computeTestStatus,
    applySkipLogic,
    validateStageResultStructure,
    extractErrorSummaries,
    STAGE_ORDER,
    ALWAYS_RUN_STAGES
} from '../../src/lib/ci-stage-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a complete valid stageResults object with all 7 stages passing.
 */
function makeAllPassingStageResults() {
    const results = {};
    for (const stage of STAGE_ORDER) {
        results[stage] = {
            status: 'pass',
            durationSeconds: 10,
            logPointer: `ml-container-creator-ci:build/abc123/${stage}`,
            errorSummary: ''
        };
    }
    return results;
}

/**
 * Build a stageResults object where a specific stage fails and
 * subsequent stages (except teardown/update) are skipped.
 */
function makeFailedAtStage(failedStage, errorSummary = 'Something went wrong') {
    const results = {};
    const failedIndex = STAGE_ORDER.indexOf(failedStage);

    for (let i = 0; i < STAGE_ORDER.length; i++) {
        const stage = STAGE_ORDER[i];
        if (i < failedIndex) {
            results[stage] = {
                status: 'pass',
                durationSeconds: 10,
                logPointer: `ml-container-creator-ci:build/abc123/${stage}`,
                errorSummary: ''
            };
        } else if (i === failedIndex) {
            results[stage] = {
                status: 'fail',
                durationSeconds: 5,
                logPointer: `ml-container-creator-ci:build/abc123/${stage}`,
                errorSummary
            };
        } else if (ALWAYS_RUN_STAGES.includes(stage)) {
            results[stage] = {
                status: 'pass',
                durationSeconds: 10,
                logPointer: `ml-container-creator-ci:build/abc123/${stage}`,
                errorSummary: ''
            };
        } else {
            results[stage] = {
                status: 'skip',
                durationSeconds: 0,
                logPointer: '',
                errorSummary: ''
            };
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// STAGE_ORDER and ALWAYS_RUN_STAGES constants
// ---------------------------------------------------------------------------

describe('CI Stage Results — Constants', () => {

    it('STAGE_ORDER contains exactly 7 stages', () => {
        assert.strictEqual(STAGE_ORDER.length, 7);
    });

    it('STAGE_ORDER has the correct execution order', () => {
        assert.deepStrictEqual(STAGE_ORDER, [
            'generate', 'validate', 'build', 'deploy_test', 'register', 'teardown', 'update'
        ]);
    });

    it('ALWAYS_RUN_STAGES contains teardown and update', () => {
        assert.ok(ALWAYS_RUN_STAGES.includes('teardown'));
        assert.ok(ALWAYS_RUN_STAGES.includes('update'));
        assert.strictEqual(ALWAYS_RUN_STAGES.length, 2);
    });
});

// ---------------------------------------------------------------------------
// parseStageResults
// ---------------------------------------------------------------------------

describe('CI Stage Results — parseStageResults', () => {

    it('returns empty object for null input', () => {
        assert.deepStrictEqual(parseStageResults(null), {});
    });

    it('returns empty object for undefined input', () => {
        assert.deepStrictEqual(parseStageResults(undefined), {});
    });

    it('parses DynamoDB map format with M wrapper', () => {
        const dynamoMap = {
            generate: {
                M: {
                    status: { S: 'pass' },
                    durationSeconds: { N: '12' },
                    logPointer: { S: 'ml-container-creator-ci:build/abc/gen' },
                    errorSummary: { S: '' }
                }
            }
        };

        const parsed = parseStageResults(dynamoMap);
        assert.strictEqual(parsed.generate.status, 'pass');
        assert.strictEqual(parsed.generate.durationSeconds, 12);
        assert.strictEqual(parsed.generate.logPointer, 'ml-container-creator-ci:build/abc/gen');
        assert.strictEqual(parsed.generate.errorSummary, '');
    });

    it('parses plain object format (already unwrapped)', () => {
        const plainMap = {
            generate: {
                status: 'fail',
                durationSeconds: 5,
                logPointer: 'some-log',
                errorSummary: 'Error occurred'
            }
        };

        const parsed = parseStageResults(plainMap);
        assert.strictEqual(parsed.generate.status, 'fail');
        assert.strictEqual(parsed.generate.durationSeconds, 5);
        assert.strictEqual(parsed.generate.errorSummary, 'Error occurred');
    });

    it('handles missing fields with defaults', () => {
        const partial = {
            generate: {
                M: {
                    status: { S: 'pass' }
                    // durationSeconds, logPointer, errorSummary missing
                }
            }
        };

        const parsed = parseStageResults(partial);
        assert.strictEqual(parsed.generate.status, 'pass');
        assert.strictEqual(parsed.generate.durationSeconds, 0);
        assert.strictEqual(parsed.generate.logPointer, '');
        assert.strictEqual(parsed.generate.errorSummary, '');
    });

    it('parses multiple stages', () => {
        const dynamoMap = {
            generate: { M: { status: { S: 'pass' }, durationSeconds: { N: '10' }, logPointer: { S: 'log1' }, errorSummary: { S: '' } } },
            build: { M: { status: { S: 'fail' }, durationSeconds: { N: '30' }, logPointer: { S: 'log2' }, errorSummary: { S: 'build error' } } }
        };

        const parsed = parseStageResults(dynamoMap);
        assert.strictEqual(Object.keys(parsed).length, 2);
        assert.strictEqual(parsed.generate.status, 'pass');
        assert.strictEqual(parsed.build.status, 'fail');
        assert.strictEqual(parsed.build.errorSummary, 'build error');
    });

    it('handles non-object stage values gracefully', () => {
        const badMap = {
            generate: 'not-an-object'
        };

        const parsed = parseStageResults(badMap);
        assert.strictEqual(parsed.generate.status, 'unknown');
        assert.strictEqual(parsed.generate.durationSeconds, 0);
    });
});

// ---------------------------------------------------------------------------
// computeTestStatus
// ---------------------------------------------------------------------------

describe('CI Stage Results — computeTestStatus', () => {

    it('returns "pass" when all stages pass', () => {
        const results = makeAllPassingStageResults();
        assert.strictEqual(computeTestStatus(results), 'pass');
    });

    it('returns "fail-generate" when generate fails', () => {
        const results = makeFailedAtStage('generate');
        assert.strictEqual(computeTestStatus(results), 'fail-generate');
    });

    it('returns "fail-validate" when validate fails', () => {
        const results = makeFailedAtStage('validate');
        assert.strictEqual(computeTestStatus(results), 'fail-validate');
    });

    it('returns "fail-build" when build fails', () => {
        const results = makeFailedAtStage('build');
        assert.strictEqual(computeTestStatus(results), 'fail-build');
    });

    it('returns "fail-deploy_test" when deploy_test fails', () => {
        const results = makeFailedAtStage('deploy_test');
        assert.strictEqual(computeTestStatus(results), 'fail-deploy_test');
    });

    it('returns "fail-register" when register fails', () => {
        const results = makeFailedAtStage('register');
        assert.strictEqual(computeTestStatus(results), 'fail-register');
    });

    it('returns the first failing stage when multiple stages fail', () => {
        const results = makeAllPassingStageResults();
        results.validate.status = 'fail';
        results.build.status = 'fail';

        assert.strictEqual(computeTestStatus(results), 'fail-validate');
    });

    it('returns "pass" for null input', () => {
        assert.strictEqual(computeTestStatus(null), 'pass');
    });

    it('returns "pass" for empty object', () => {
        assert.strictEqual(computeTestStatus({}), 'pass');
    });

    it('returns "pass" when all stages are skip', () => {
        const results = {};
        for (const stage of STAGE_ORDER) {
            results[stage] = { status: 'skip', durationSeconds: 0, logPointer: '' };
        }
        assert.strictEqual(computeTestStatus(results), 'pass');
    });

    it('ignores teardown failure for testStatus computation', () => {
        // If only teardown fails, testStatus should still reflect it
        const results = makeAllPassingStageResults();
        results.teardown.status = 'fail';
        assert.strictEqual(computeTestStatus(results), 'fail-teardown');
    });
});

// ---------------------------------------------------------------------------
// applySkipLogic
// ---------------------------------------------------------------------------

describe('CI Stage Results — applySkipLogic', () => {

    it('skips stages after the failed stage', () => {
        const results = makeAllPassingStageResults();
        applySkipLogic(results, 'build');

        // Stages before build should be unchanged
        assert.strictEqual(results.generate.status, 'pass');
        assert.strictEqual(results.validate.status, 'pass');

        // deploy_test and register should be skipped
        assert.strictEqual(results.deploy_test.status, 'skip');
        assert.strictEqual(results.deploy_test.durationSeconds, 0);
        assert.strictEqual(results.register.status, 'skip');
        assert.strictEqual(results.register.durationSeconds, 0);
    });

    it('does not skip teardown', () => {
        const results = makeAllPassingStageResults();
        applySkipLogic(results, 'generate');

        assert.strictEqual(results.teardown.status, 'pass');
    });

    it('does not skip update', () => {
        const results = makeAllPassingStageResults();
        applySkipLogic(results, 'generate');

        assert.strictEqual(results.update.status, 'pass');
    });

    it('skips validate, build, deploy_test, register when generate fails', () => {
        const results = makeAllPassingStageResults();
        applySkipLogic(results, 'generate');

        assert.strictEqual(results.validate.status, 'skip');
        assert.strictEqual(results.build.status, 'skip');
        assert.strictEqual(results.deploy_test.status, 'skip');
        assert.strictEqual(results.register.status, 'skip');
    });

    it('skips only register when deploy_test fails', () => {
        const results = makeAllPassingStageResults();
        applySkipLogic(results, 'deploy_test');

        assert.strictEqual(results.generate.status, 'pass');
        assert.strictEqual(results.validate.status, 'pass');
        assert.strictEqual(results.build.status, 'pass');
        assert.strictEqual(results.register.status, 'skip');
        assert.strictEqual(results.teardown.status, 'pass');
        assert.strictEqual(results.update.status, 'pass');
    });

    it('returns the same object reference', () => {
        const results = makeAllPassingStageResults();
        const returned = applySkipLogic(results, 'build');
        assert.strictEqual(returned, results);
    });

    it('handles null failedStage gracefully', () => {
        const results = makeAllPassingStageResults();
        applySkipLogic(results, null);

        // Nothing should be skipped
        for (const stage of STAGE_ORDER) {
            assert.strictEqual(results[stage].status, 'pass');
        }
    });

    it('handles unknown failedStage gracefully', () => {
        const results = makeAllPassingStageResults();
        applySkipLogic(results, 'nonexistent');

        // Nothing should be skipped
        for (const stage of STAGE_ORDER) {
            assert.strictEqual(results[stage].status, 'pass');
        }
    });

    it('handles null stageResults gracefully', () => {
        const result = applySkipLogic(null, 'build');
        assert.deepStrictEqual(result, {});
    });
});

// ---------------------------------------------------------------------------
// validateStageResultStructure
// ---------------------------------------------------------------------------

describe('CI Stage Results — validateStageResultStructure', () => {

    it('validates a correct all-passing structure', () => {
        const results = makeAllPassingStageResults();
        const validation = validateStageResultStructure(results);

        assert.strictEqual(validation.valid, true);
        assert.strictEqual(validation.errors.length, 0);
    });

    it('validates a correct structure with failure and skips', () => {
        const results = makeFailedAtStage('build', 'Build failed: exit code 1');
        const validation = validateStageResultStructure(results);

        assert.strictEqual(validation.valid, true);
        assert.strictEqual(validation.errors.length, 0);
    });

    it('rejects null input', () => {
        const validation = validateStageResultStructure(null);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.length > 0);
    });

    it('rejects empty object (missing all stages)', () => {
        const validation = validateStageResultStructure({});
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('Expected 7')));
    });

    it('rejects object with wrong number of stages', () => {
        const results = {
            generate: { status: 'pass', durationSeconds: 10, logPointer: 'log' },
            build: { status: 'pass', durationSeconds: 10, logPointer: 'log' }
        };
        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
    });

    it('rejects object with unexpected stage names', () => {
        const results = makeAllPassingStageResults();
        results.extra_stage = { status: 'pass', durationSeconds: 0, logPointer: '' };
        delete results.generate;

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('Unexpected stage')));
        assert.ok(validation.errors.some(e => e.includes('Missing required stage')));
    });

    it('rejects stage with missing status field', () => {
        const results = makeAllPassingStageResults();
        delete results.generate.status;

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('status')));
    });

    it('rejects stage with invalid status value', () => {
        const results = makeAllPassingStageResults();
        results.generate.status = 'unknown';

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('invalid status')));
    });

    it('rejects stage with missing durationSeconds field', () => {
        const results = makeAllPassingStageResults();
        delete results.build.durationSeconds;

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('durationSeconds')));
    });

    it('rejects stage with negative durationSeconds', () => {
        const results = makeAllPassingStageResults();
        results.build.durationSeconds = -5;

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('invalid durationSeconds')));
    });

    it('rejects stage with missing logPointer field', () => {
        const results = makeAllPassingStageResults();
        delete results.teardown.logPointer;

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('logPointer')));
    });

    it('rejects failed stage without errorSummary', () => {
        const results = makeAllPassingStageResults();
        results.build.status = 'fail';
        delete results.build.errorSummary;

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('errorSummary')));
    });

    it('rejects errorSummary exceeding 500 characters', () => {
        const results = makeAllPassingStageResults();
        results.build.status = 'fail';
        results.build.errorSummary = 'x'.repeat(501);

        const validation = validateStageResultStructure(results);
        assert.strictEqual(validation.valid, false);
        assert.ok(validation.errors.some(e => e.includes('exceeds 500')));
    });

    it('accepts errorSummary of exactly 500 characters', () => {
        const results = makeFailedAtStage('build', 'x'.repeat(500));
        const validation = validateStageResultStructure(results);

        assert.strictEqual(validation.valid, true);
    });

    it('allows durationSeconds of 0 for skipped stages', () => {
        const results = makeFailedAtStage('generate');
        const validation = validateStageResultStructure(results);

        assert.strictEqual(validation.valid, true);
        assert.strictEqual(results.validate.durationSeconds, 0);
    });
});

// ---------------------------------------------------------------------------
// extractErrorSummaries
// ---------------------------------------------------------------------------

describe('CI Stage Results — extractErrorSummaries', () => {

    it('returns empty array when all stages pass', () => {
        const results = makeAllPassingStageResults();
        const summaries = extractErrorSummaries(results);
        assert.strictEqual(summaries.length, 0);
    });

    it('returns error summary for a single failed stage', () => {
        const results = makeFailedAtStage('build', 'Build failed: exit code 1');
        const summaries = extractErrorSummaries(results);

        assert.strictEqual(summaries.length, 1);
        assert.strictEqual(summaries[0].stage, 'build');
        assert.strictEqual(summaries[0].errorSummary, 'Build failed: exit code 1');
    });

    it('returns error summaries in stage execution order', () => {
        const results = makeAllPassingStageResults();
        results.validate.status = 'fail';
        results.validate.errorSummary = 'Validation error';
        results.build.status = 'fail';
        results.build.errorSummary = 'Build error';

        const summaries = extractErrorSummaries(results);
        assert.strictEqual(summaries.length, 2);
        assert.strictEqual(summaries[0].stage, 'validate');
        assert.strictEqual(summaries[1].stage, 'build');
    });

    it('skips failed stages without errorSummary', () => {
        const results = makeAllPassingStageResults();
        results.build.status = 'fail';
        results.build.errorSummary = '';

        const summaries = extractErrorSummaries(results);
        assert.strictEqual(summaries.length, 0);
    });

    it('returns empty array for null input', () => {
        assert.deepStrictEqual(extractErrorSummaries(null), []);
    });

    it('returns empty array for empty object', () => {
        assert.deepStrictEqual(extractErrorSummaries({}), []);
    });
});
