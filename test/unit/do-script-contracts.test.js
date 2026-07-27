// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BL071 — do/ Script Contract System.
 *
 * Tests cover:
 * - Guard functions (deployment-active, model-staged, training-infra)
 * - Contract violation output format (exit code 3, structured message)
 * - _require_guard inline escalation
 * - _guard_met non-enforcing query
 * - Auto-enforcement from sourcing script-contract.sh
 * - DEPLOYMENT_TARGET routing for all four targets
 *
 * Feature: BL071 — do/ Script Classification
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_CONTRACT_PATH = resolve(__dirname, '../../templates/do/lib/script-contract.sh');
const BENCHMARK_PATH = resolve(__dirname, '../../templates/do/benchmark');

const SCRIPT_CONTRACT = readFileSync(SCRIPT_CONTRACT_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temporary bash script that sources script-contract.sh and runs a command.
 * Returns { stdout, stderr, exitCode }.
 */
function runGuardScript(env, scriptContent) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mlcc-guard-test-'));
    const libDir = join(tmpDir, 'lib');
    mkdirSync(libDir, { recursive: true });

    // Copy the script-contract.sh to the temp lib dir
    writeFileSync(join(libDir, 'script-contract.sh'), SCRIPT_CONTRACT);

    // Create the test script
    const scriptPath = join(tmpDir, 'test-script');
    writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    try {
        const result = execSync(`bash "${scriptPath}"`, {
            env: { ...process.env, ...env, PATH: process.env.PATH },
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000
        });
        return { stdout: result, stderr: '', exitCode: 0 };
    } catch (err) {
        return {
            stdout: err.stdout || '',
            stderr: err.stderr || '',
            exitCode: err.status
        };
    }
}

/**
 * Create a script with a @mlcc-script annotation and source script-contract.sh.
 */
function makeAnnotatedScript(guard, body = 'echo "OK"') {
    return `#!/usr/bin/env bash
# @mlcc-script
# type: deployment-centric
# guard: ${guard}
# lifecycle: monitor
# targets: all

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "\${SCRIPT_DIR}/lib/script-contract.sh"
${body}
`;
}

/**
 * Create a script that calls _require_guard directly without an annotation.
 */
function makeRequireGuardScript(guard) {
    return `#!/usr/bin/env bash
# @mlcc-script
# type: hybrid
# guard: none
# lifecycle: publish
# targets: all

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "\${SCRIPT_DIR}/lib/script-contract.sh"
_require_guard ${guard}
echo "PASSED"
`;
}

/**
 * Create a script that calls _guard_met and outputs success/failure.
 */
function makeGuardMetScript(guard) {
    return `#!/usr/bin/env bash
# @mlcc-script
# type: hybrid
# guard: none
# lifecycle: publish
# targets: all

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "\${SCRIPT_DIR}/lib/script-contract.sh"
if _guard_met ${guard}; then
    echo "GUARD_MET"
else
    echo "GUARD_NOT_MET"
fi
`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('do/lib/script-contract.sh (BL071)', () => {

    describe('_guard_deployment_active', () => {
        it('exits code 3 when DEPLOYMENT_TARGET_SMAI_STATUS is not InService', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: '' },
                makeAnnotatedScript('deployment-active')
            );
            assert.strictEqual(result.exitCode, 3, `Expected exit code 3, got ${result.exitCode}`);
            assert(result.stdout.includes('Contract violation'), 'Expected contract violation message');
            assert(result.stdout.includes('deployment-active'), 'Expected guard name in output');
        });

        it('exits 0 when DEPLOYMENT_TARGET_SMAI_STATUS is InService', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: 'InService' },
                makeAnnotatedScript('deployment-active')
            );
            assert.strictEqual(result.exitCode, 0, `Expected exit code 0, got ${result.exitCode}. stdout: ${result.stdout}`);
        });

        it('handles all four DEPLOYMENT_TARGET values correctly', () => {
            const targets = [
                { target: 'realtime-inference', statusVar: 'DEPLOYMENT_TARGET_SMAI_STATUS' },
                { target: 'managed-inference', statusVar: 'DEPLOYMENT_TARGET_SMAI_STATUS' },
                { target: 'hyperpod-eks', statusVar: 'DEPLOYMENT_TARGET_HP_STATUS' },
                { target: 'async-inference', statusVar: 'DEPLOYMENT_TARGET_ASYNC_STATUS' },
                { target: 'batch-transform', statusVar: 'DEPLOYMENT_TARGET_BATCH_STATUS' }
            ];

            for (const { target, statusVar } of targets) {
                // Should fail with no status
                const failResult = runGuardScript(
                    { DEPLOYMENT_TARGET: target, [statusVar]: '' },
                    makeAnnotatedScript('deployment-active')
                );
                assert.strictEqual(failResult.exitCode, 3, `Expected exit 3 for ${target} without status`);

                // Should pass with InService
                const passResult = runGuardScript(
                    { DEPLOYMENT_TARGET: target, [statusVar]: 'InService' },
                    makeAnnotatedScript('deployment-active')
                );
                assert.strictEqual(passResult.exitCode, 0, `Expected exit 0 for ${target} with InService`);
            }
        });
    });

    describe('_guard_model_staged', () => {
        it('exits code 3 when STAGED_MODEL_PATH is empty', () => {
            const result = runGuardScript(
                { STAGED_MODEL_PATH: '' },
                makeAnnotatedScript('model-staged')
            );
            assert.strictEqual(result.exitCode, 3, `Expected exit code 3, got ${result.exitCode}`);
            assert(result.stdout.includes('model-staged'), 'Expected model-staged in output');
        });

        it('exits 0 when STAGED_MODEL_PATH is set', () => {
            const result = runGuardScript(
                { STAGED_MODEL_PATH: 's3://bucket/model' },
                makeAnnotatedScript('model-staged')
            );
            assert.strictEqual(result.exitCode, 0, `Expected exit code 0, got ${result.exitCode}`);
        });
    });

    describe('_contract_violation output format', () => {
        it('output contains: guard name, reason, remedy', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: '' },
                makeAnnotatedScript('deployment-active')
            );
            assert.strictEqual(result.exitCode, 3);
            // Check all three parts of the structured message
            assert(result.stdout.includes('Contract violation: deployment-active'),
                'Expected "Contract violation: deployment-active"');
            assert(result.stdout.includes('No active deployment found'),
                'Expected reason about no active deployment');
            assert(result.stdout.includes('→'),
                'Expected remedy arrow (→)');
            assert(result.stdout.includes('do/deploy'),
                'Expected remedy to reference do/deploy');
        });
    });

    describe('_require_guard inline escalation', () => {
        it('exits code 3 when guard is not met via _require_guard', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: '' },
                makeRequireGuardScript('deployment-active')
            );
            assert.strictEqual(result.exitCode, 3, `Expected exit code 3, got ${result.exitCode}`);
            assert(result.stdout.includes('Contract violation'), 'Expected contract violation');
        });

        it('passes when guard is met via _require_guard', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: 'InService' },
                makeRequireGuardScript('deployment-active')
            );
            assert.strictEqual(result.exitCode, 0);
            assert(result.stdout.includes('PASSED'), 'Expected PASSED output');
        });
    });

    describe('_guard_met non-enforcing query', () => {
        it('returns 0 without exiting when guard is satisfied', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: 'InService' },
                makeGuardMetScript('deployment-active')
            );
            assert.strictEqual(result.exitCode, 0);
            assert(result.stdout.includes('GUARD_MET'), 'Expected GUARD_MET output');
        });

        it('returns 1 without exiting when guard is not satisfied', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: '' },
                makeGuardMetScript('deployment-active')
            );
            assert.strictEqual(result.exitCode, 0, 'Script should not exit — _guard_met is non-enforcing');
            assert(result.stdout.includes('GUARD_NOT_MET'), 'Expected GUARD_NOT_MET output');
        });
    });

    describe('Auto-enforcement on source', () => {
        it('script with guard: deployment-active exits code 3 when deployment not active', () => {
            const result = runGuardScript(
                { DEPLOYMENT_TARGET: 'realtime-inference', DEPLOYMENT_TARGET_SMAI_STATUS: '' },
                makeAnnotatedScript('deployment-active', 'echo "SHOULD NOT REACH"')
            );
            assert.strictEqual(result.exitCode, 3);
            assert(!result.stdout.includes('SHOULD NOT REACH'),
                'Script body should not execute when guard fails');
            assert(result.stdout.includes('Contract violation'),
                'Expected contract violation message');
        });

        it('script with guard: none always runs', () => {
            const result = runGuardScript(
                {},
                makeAnnotatedScript('none', 'echo "EXECUTED"')
            );
            assert.strictEqual(result.exitCode, 0);
            assert(result.stdout.includes('EXECUTED'));
        });
    });

    describe('do/benchmark contract enforcement', () => {
        it('benchmark script has deployment-active guard annotation', () => {
            const benchmark = readFileSync(BENCHMARK_PATH, 'utf-8');
            assert(benchmark.includes('# guard: deployment-active'),
                'do/benchmark should have guard: deployment-active');
            assert(benchmark.includes('# type: deployment-centric'),
                'do/benchmark should have type: deployment-centric');
            assert(benchmark.includes('source "${SCRIPT_DIR}/lib/script-contract.sh"'),
                'do/benchmark should source script-contract.sh');
        });
    });

    describe('do/register hybrid contract', () => {
        it('register script has hybrid type and guard: none', () => {
            const register = readFileSync(resolve(__dirname, '../../templates/do/register'), 'utf-8');
            assert(register.includes('# type: hybrid'), 'do/register should be hybrid');
            assert(register.includes('# guard: none'), 'do/register base guard should be none');
        });

        it('register --with-endpoint calls _require_guard deployment-active', () => {
            const register = readFileSync(resolve(__dirname, '../../templates/do/register'), 'utf-8');
            // Find the --with-endpoint case and verify it calls _require_guard
            const withEndpointIdx = register.indexOf('--with-endpoint)');
            assert(withEndpointIdx > -1, 'Expected --with-endpoint flag');
            const afterFlag = register.substring(withEndpointIdx, withEndpointIdx + 200);
            assert(afterFlag.includes('_require_guard deployment-active'),
                'Expected _require_guard deployment-active after --with-endpoint');
        });

        it('register --ic shows deprecation warning', () => {
            const register = readFileSync(resolve(__dirname, '../../templates/do/register'), 'utf-8');
            const icIdx = register.indexOf('--ic)');
            assert(icIdx > -1, 'Expected --ic flag');
            const afterIc = register.substring(icIdx, icIdx + 200);
            assert(afterIc.includes('deprecated'), 'Expected deprecation warning for --ic');
        });
    });
});
