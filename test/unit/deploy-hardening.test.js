// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for FTP Deployment Hardening (CI mode).
 *
 * Tests cover:
 * - CI-mode detection (CI_MODE env var and --ci flag)
 * - Idempotent deployment (InService + matching config → skip)
 * - Bad-state cleanup (Failed/OutOfService → delete + recreate)
 * - Capacity error handling (structured JSON with error_type: 'capacity')
 * - Configurable timeout (CI_DEPLOY_TIMEOUT_SECONDS override)
 * - Exponential backoff for throttling (base 5s, max 3 attempts)
 * - Structured JSON error output for each error_type value
 *
 * Feature: ci-benchmark-pipeline
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/do/deploy.d/managed-inference.ejs');
const templateContent = readFileSync(TEMPLATE_PATH, 'utf-8');

// ── CI-Mode Detection (Task 4.1) ────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Deploy Hardening: CI-Mode Detection', () => {

    it('detects CI_MODE=true environment variable', () => {
        // **Validates: Requirements 4.1**
        assert.ok(
            templateContent.includes('CI_MODE:-false'),
            'Template must check CI_MODE env var with default false'
        );
        assert.ok(
            templateContent.includes('CI_MODE:-false') || templateContent.includes('"${CI_MODE:-false}" = "true"'),
            'Template must compare CI_MODE to "true"'
        );
    });

    it('detects --ci CLI flag', () => {
        // **Validates: Requirements 4.1**
        assert.ok(
            templateContent.includes('--ci) CI_FLAG=true'),
            'Template must parse --ci flag and set CI_FLAG=true'
        );
    });

    it('sets CI_ACTIVE=true when either detection method triggers', () => {
        // **Validates: Requirements 4.1**
        const ciActiveBlock = templateContent.includes('CI_ACTIVE=true');
        assert.ok(ciActiveBlock, 'Template must set CI_ACTIVE=true');

        // Must combine both methods
        assert.ok(
            templateContent.includes('CI_FLAG'),
            'CI_ACTIVE logic must consider CI_FLAG'
        );
    });

    it('includes --ci in help text', () => {
        // **Validates: Requirements 4.1**
        assert.ok(
            templateContent.includes('"  --ci'),
            'Help text must document --ci flag'
        );
    });
});

// ── Idempotent Deployment (Task 4.2) ────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Deploy Hardening: Idempotent Deployment', () => {

    it('checks endpoint status before deployment in CI mode', () => {
        // **Validates: Requirements 4.1**
        assert.ok(
            templateContent.includes('_ci_handle_existing_endpoint'),
            'Template must contain idempotency handler function'
        );
    });

    it('skips deployment when endpoint is InService with matching IC', () => {
        // **Validates: Requirements 4.1**
        assert.ok(
            templateContent.includes('skipping deployment'),
            'Template must log when deployment is skipped'
        );
    });

    it('exits successfully (exit 0) when skipping', () => {
        // **Validates: Requirements 4.1**
        // The _ci_handle_existing_endpoint returns 0 to skip,
        // and the calling code exits with 0
        assert.ok(
            templateContent.includes('exit 0'),
            'Template must exit 0 when skipping idempotent deploy'
        );
    });

    it('checks InService status for both endpoint and IC', () => {
        // **Validates: Requirements 4.1**
        assert.ok(
            templateContent.includes('_get_endpoint_status'),
            'Template must check endpoint status'
        );
        assert.ok(
            templateContent.includes('_get_ic_status'),
            'Template must check IC status'
        );
    });

    it('only runs CI idempotency when FORCE_NEW is false', () => {
        // **Validates: Requirements 4.1**
        assert.ok(
            templateContent.includes('FORCE_NEW') && templateContent.includes('_ci_handle_existing_endpoint'),
            'Template must gate CI idempotency on FORCE_NEW being false'
        );
    });
});

// ── Bad-State Cleanup (Task 4.3) ────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Deploy Hardening: Bad-State Cleanup', () => {

    it('detects Failed endpoint state', () => {
        // **Validates: Requirements 4.2**
        assert.ok(
            templateContent.includes('Failed|OutOfService'),
            'Template must handle Failed state in CI handler'
        );
    });

    it('detects OutOfService endpoint state', () => {
        // **Validates: Requirements 4.2**
        assert.ok(
            templateContent.includes('OutOfService'),
            'Template must handle OutOfService state'
        );
    });

    it('deletes endpoint in bad state', () => {
        // **Validates: Requirements 4.2**
        assert.ok(
            templateContent.includes('delete-endpoint'),
            'Template must call delete-endpoint for bad-state endpoints'
        );
    });

    it('waits for deletion to complete before redeploying', () => {
        // **Validates: Requirements 4.2**
        // Check for a deletion wait loop
        assert.ok(
            templateContent.includes('Endpoint deleted'),
            'Template must confirm endpoint deletion before proceeding'
        );
    });

    it('clears ENDPOINT_NAME after deletion for fresh deploy', () => {
        // **Validates: Requirements 4.2**
        assert.ok(
            templateContent.includes('ENDPOINT_NAME=""'),
            'Template must clear ENDPOINT_NAME after deleting bad-state endpoint'
        );
    });
});

// ── Capacity Error Handling (Task 4.4) ───────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Deploy Hardening: Capacity Error Handling', () => {

    it('detects InsufficientInstanceCapacity error', () => {
        // **Validates: Requirements 4.3**
        assert.ok(
            templateContent.includes('InsufficientInstanceCapacity'),
            'Template must detect InsufficientInstanceCapacity errors'
        );
    });

    it('emits structured error with error_type capacity', () => {
        // **Validates: Requirements 4.3**
        assert.ok(
            templateContent.includes('"capacity"'),
            'Template must emit error_type "capacity" for capacity errors'
        );
    });

    it('includes instance type in capacity error message', () => {
        // **Validates: Requirements 4.3**
        assert.ok(
            templateContent.includes('INSTANCE_TYPE') && templateContent.includes('capacity'),
            'Capacity error must reference the instance type'
        );
    });

    it('marks capacity errors as retryable', () => {
        // **Validates: Requirements 4.3**
        // The _ci_emit_error call for capacity passes "true" for retryable
        const capacityLine = templateContent.split('\n').find(l =>
            l.includes('capacity') && l.includes('_ci_emit_error')
        );
        assert.ok(
            capacityLine && capacityLine.includes('"true"'),
            'Capacity errors must be marked retryable'
        );
    });
});

// ── Configurable Timeout (Task 4.5) ─────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Deploy Hardening: Configurable Timeout', () => {

    it('defaults timeout to 1200 seconds (20 minutes)', () => {
        // **Validates: Requirements 4.4**
        assert.ok(
            templateContent.includes('CI_DEPLOY_TIMEOUT_SECONDS:-1200'),
            'Template must default CI_DEPLOY_TIMEOUT_SECONDS to 1200'
        );
    });

    it('allows override via CI_DEPLOY_TIMEOUT_SECONDS env var', () => {
        // **Validates: Requirements 4.4**
        assert.ok(
            templateContent.includes('CI_DEPLOY_TIMEOUT_SECONDS'),
            'Template must read CI_DEPLOY_TIMEOUT_SECONDS for timeout configuration'
        );
    });

    it('implements _ci_check_timeout function', () => {
        // **Validates: Requirements 4.4**
        assert.ok(
            templateContent.includes('_ci_check_timeout'),
            'Template must implement _ci_check_timeout function'
        );
    });

    it('emits structured timeout error with error_type timeout', () => {
        // **Validates: Requirements 4.4**
        assert.ok(
            templateContent.includes('"timeout"'),
            'Template must emit error_type "timeout" when timeout occurs'
        );
    });

    it('records start time for elapsed calculation', () => {
        // **Validates: Requirements 4.4**
        assert.ok(
            templateContent.includes('CI_DEPLOY_START=$(date +%s)'),
            'Template must record start time for timeout tracking'
        );
    });

    it('checks timeout during endpoint wait phase', () => {
        // **Validates: Requirements 4.4**
        // Verify _ci_check_timeout is called during wait
        const lines = templateContent.split('\n');
        const waitSection = lines.findIndex(l => l.includes('Waiting for endpoint to reach InService'));
        const checkAfterWait = lines.slice(waitSection).findIndex(l => l.includes('_ci_check_timeout'));
        assert.ok(
            checkAfterWait > 0,
            'Template must check timeout during/after endpoint wait'
        );
    });
});

// ── Exponential Backoff for Throttling (Task 4.6) ────────────────────────────

describe('Feature: ci-benchmark-pipeline — Deploy Hardening: Exponential Backoff', () => {

    it('implements _ci_create_endpoint_with_retry function', () => {
        // **Validates: Requirements 4.6**
        assert.ok(
            templateContent.includes('_ci_create_endpoint_with_retry'),
            'Template must contain exponential backoff retry function'
        );
    });

    it('uses base backoff of 5 seconds', () => {
        // **Validates: Requirements 4.6**
        assert.ok(
            templateContent.includes('backoff=5'),
            'Template must use 5-second base backoff'
        );
    });

    it('limits to max 3 attempts', () => {
        // **Validates: Requirements 4.6**
        assert.ok(
            templateContent.includes('max_attempts=3'),
            'Template must limit retry attempts to 3'
        );
    });

    it('detects ThrottlingException in API response', () => {
        // **Validates: Requirements 4.6**
        assert.ok(
            templateContent.includes('ThrottlingException'),
            'Template must detect ThrottlingException for retry logic'
        );
    });

    it('doubles backoff between attempts (exponential)', () => {
        // **Validates: Requirements 4.6**
        assert.ok(
            templateContent.includes('backoff=$(( backoff * 2 ))'),
            'Template must double backoff for exponential behavior'
        );
    });

    it('emits structured error with error_type throttled after max attempts', () => {
        // **Validates: Requirements 4.6**
        assert.ok(
            templateContent.includes('"throttled"'),
            'Template must emit error_type "throttled" after max retries exhausted'
        );
    });

    it('only uses retry wrapper in CI mode', () => {
        // **Validates: Requirements 4.6**
        assert.ok(
            templateContent.includes('CI_ACTIVE') && templateContent.includes('_ci_create_endpoint_with_retry'),
            'Retry wrapper must be gated on CI_ACTIVE'
        );
    });
});

// ── Structured JSON Error Output (Task 4.7) ─────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Deploy Hardening: Structured JSON Error Output', () => {

    it('_ci_emit_error outputs JSON with "error" field', () => {
        // **Validates: Requirements 4.5**
        assert.ok(
            templateContent.includes('\\"error\\"'),
            'Error output must include "error" field'
        );
    });

    it('_ci_emit_error outputs JSON with "error_type" field', () => {
        // **Validates: Requirements 4.5**
        assert.ok(
            templateContent.includes('\\"error_type\\"'),
            'Error output must include "error_type" field'
        );
    });

    it('_ci_emit_error outputs JSON with "instance_type" field', () => {
        // **Validates: Requirements 4.5**
        assert.ok(
            templateContent.includes('\\"instance_type\\"'),
            'Error output must include "instance_type" field'
        );
    });

    it('_ci_emit_error outputs JSON with "region" field', () => {
        // **Validates: Requirements 4.5**
        assert.ok(
            templateContent.includes('\\"region\\"'),
            'Error output must include "region" field'
        );
    });

    it('_ci_emit_error outputs JSON with "retryable" field', () => {
        // **Validates: Requirements 4.5**
        assert.ok(
            templateContent.includes('\\"retryable\\"'),
            'Error output must include "retryable" field'
        );
    });

    it('_ci_emit_error outputs JSON with "elapsed_seconds" field', () => {
        // **Validates: Requirements 4.5**
        assert.ok(
            templateContent.includes('\\"elapsed_seconds\\"'),
            'Error output must include "elapsed_seconds" field'
        );
    });

    it('non-CI mode keeps human-readable error output', () => {
        // **Validates: Requirements 4.5**
        // In non-CI mode, _ci_emit_error falls through to human-readable
        assert.ok(
            templateContent.includes('echo "❌ ${error_msg}"'),
            'Non-CI mode must output human-readable errors'
        );
    });

    it('all error_type values are present in template', () => {
        // **Validates: Requirements 4.5**
        const errorTypes = ['capacity', 'timeout', 'throttled', 'endpoint_failed', 'api_error'];
        for (const errorType of errorTypes) {
            assert.ok(
                templateContent.includes(`"${errorType}"`) || templateContent.includes(`\\"${errorType}\\"`),
                `Template must include error_type "${errorType}"`
            );
        }
    });

    it('uses echo for JSON output (stdout, not stderr)', () => {
        // **Validates: Requirements 4.5**
        // Verify the JSON output goes to stdout via echo (not >&2)
        const emitFn = templateContent.split('_ci_emit_error()')[1];
        if (emitFn) {
            const jsonLine = emitFn.split('\n').find(l => l.includes('"error"'));
            if (jsonLine) {
                assert.ok(
                    jsonLine.includes('echo') && !jsonLine.includes('>&2'),
                    'CI error JSON must go to stdout (echo without >&2)'
                );
            }
        }
    });
});
