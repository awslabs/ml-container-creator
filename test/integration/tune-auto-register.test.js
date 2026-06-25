// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for auto-register flow in do/tune _handle_completion().
 *
 * Tests that the rendered script contains correct logic for:
 * - (a) _handle_completion() calls do/adapter add and do/register as subprocesses
 *       when output_type == "adapter"
 * - (b) --no-register skips auto-stage and auto-register
 * - (c) subprocess failure is non-fatal (warning printed, exit 0)
 *
 * Feature: tune-register-loop
 * Validates: Requirements US-1 (auto-register on tune completion)
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: tune-register-loop — auto-register flow (Req US-1)', function () {
    this.timeout(120000);

    let result;
    let tuneScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
            'enable-lora': true,
            'region': 'us-east-1',
            'instance-type': 'ml.g5.xlarge'
        });

        // Read the rendered do/tune script
        const tunePath = result.file('do/tune');
        tuneScript = fs.readFileSync(tunePath, 'utf8');
    });

    after(() => {
        if (result) result.cleanup();
    });

    // ── Helper to extract the _handle_completion section ─────────────────

    function getHandleCompletionSection() {
        const start = tuneScript.indexOf('_handle_completion()');
        if (start === -1) {
            return tuneScript;
        }
        // Find the next top-level function definition after _handle_completion
        const afterStart = tuneScript.substring(start);
        const nextFnMatch = afterStart.match(/\n# ── _[a-z]/);
        if (nextFnMatch) {
            return afterStart.substring(0, nextFnMatch.index);
        }
        return afterStart;
    }

    function getParseArgsSection() {
        const start = tuneScript.indexOf('_parse_args()');
        if (start === -1) {
            return tuneScript;
        }
        const afterStart = tuneScript.substring(start);
        // Find the closing of the function (next top-level function or section)
        const nextFnMatch = afterStart.match(/\n# ── _[a-z]/);
        if (nextFnMatch) {
            return afterStart.substring(0, nextFnMatch.index);
        }
        return afterStart;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Part (a): Auto-register subprocess calls
    // ══════════════════════════════════════════════════════════════════════

    describe('(a) _handle_completion() calls do/adapter add and do/register as subprocesses', () => {

        it('contains auto-register logic block when output_type == "adapter"', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('"${output_type}" = "adapter"') ||
                section.includes('output_type}" = "adapter"') ||
                section.includes('output_type" = "adapter"'),
                'Must check output_type == "adapter" before auto-registering'
            );
        });

        it('checks ARG_NO_REGISTER before auto-registering', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('ARG_NO_REGISTER'),
                'Must check ARG_NO_REGISTER flag before auto-register'
            );
        });

        it('calls do/adapter add as subprocess with --from-tune technique', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('"${SCRIPT_DIR}/adapter" add "${adapter_name}" --from-tune "${ARG_TECHNIQUE}"'),
                'Must call "${SCRIPT_DIR}/adapter" add "${adapter_name}" --from-tune "${ARG_TECHNIQUE}" as subprocess'
            );
        });

        it('calls do/register as subprocess on adapter-add success', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('"${SCRIPT_DIR}/register"'),
                'Must call "${SCRIPT_DIR}/register" as subprocess'
            );
        });

        it('extracts adapter deployment ARN using grep and jq', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('grep "${adapter_name}"') &&
                section.includes('grep -E \'^\\{\'') &&
                section.includes('tail -1') &&
                section.includes('jq -r \'.model_package_arn\''),
                'Must extract ARN using grep "${adapter_name}" | grep -E \'^\\{\' | tail -1 | jq -r \'.model_package_arn\''
            );
        });

        it('stores TUNE_ADAPTER_DEPLOY_ARN_${technique_upper} via _update_config_var', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('_update_config_var "TUNE_ADAPTER_DEPLOY_ARN_${technique_upper}"'),
                'Must store TUNE_ADAPTER_DEPLOY_ARN_${technique_upper} in do/config via _update_config_var'
            );
        });

        it('derives adapter name using _derive_dataset_slug', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('_derive_dataset_slug'),
                'Must derive adapter name slug using _derive_dataset_slug'
            );
        });

        it('constructs adapter name as tuned-${ARG_TECHNIQUE}-${dataset_slug}', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('tuned-${ARG_TECHNIQUE}-${dataset_slug}'),
                'Must construct adapter name as tuned-${ARG_TECHNIQUE}-${dataset_slug}'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // Part (b): --no-register skips auto-stage and auto-register
    // ══════════════════════════════════════════════════════════════════════

    describe('(b) --no-register skips auto-stage and auto-register', () => {

        it('ARG_NO_REGISTER defaults to false', () => {
            assert.ok(
                tuneScript.includes('ARG_NO_REGISTER=false'),
                'ARG_NO_REGISTER must default to false'
            );
        });

        it('--no-register flag sets ARG_NO_REGISTER=true in _parse_args()', () => {
            const parseSection = getParseArgsSection();
            assert.ok(
                parseSection.includes('--no-register) ARG_NO_REGISTER=true; shift ;;'),
                'Must parse --no-register) ARG_NO_REGISTER=true; shift ;; in _parse_args()'
            );
        });

        it('when ARG_NO_REGISTER is true, prints next-step commands instead of auto-registering', () => {
            const section = getHandleCompletionSection();
            // The elif branch for --no-register should contain "Next steps" guidance
            assert.ok(
                section.includes('Next steps') || section.includes('next steps'),
                'When --no-register is set, must print next-step commands'
            );
        });

        it('the --no-register path suggests do/adapter add manually', () => {
            const section = getHandleCompletionSection();
            // After the auto-register block there should be an elif/else that shows manual commands
            assert.ok(
                section.includes('./do/adapter add tuned-${ARG_TECHNIQUE}'),
                'The --no-register path must suggest ./do/adapter add as a manual step'
            );
        });

        it('--no-register is documented in --help output', () => {
            assert.ok(
                tuneScript.includes('--no-register') &&
                tuneScript.includes('Skip auto-stage and auto-register'),
                'Must document --no-register in help output'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // Part (c): Subprocess failure is non-fatal
    // ══════════════════════════════════════════════════════════════════════

    describe('(c) subprocess failure is non-fatal (warning printed, exit 0)', () => {

        it('uses if pattern to capture adapter-add exit code', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('if adapter_add_output=$('),
                'Must use "if adapter_add_output=$(...)" pattern to capture exit code non-fatally'
            );
        });

        it('prints warning when adapter staging fails', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('Adapter staging failed') ||
                section.includes('adapter staging failed'),
                'Must print warning message when adapter staging fails'
            );
        });

        it('suggests manual commands on failure (do/adapter add + do/register)', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('./do/adapter add') &&
                section.includes('./do/register'),
                'Must suggest manual commands (./do/adapter add ... + ./do/register) on failure'
            );
        });

        it('does not exit 1 in the auto-register failure path', () => {
            const section = getHandleCompletionSection();
            // Find the auto-register block (between the adapter condition and the elif/else)
            const autoRegisterStart = section.indexOf('Auto-register');
            const noRegisterStart = section.indexOf('--no-register');
            if (autoRegisterStart > 0 && noRegisterStart > autoRegisterStart) {
                const autoRegisterBlock = section.substring(autoRegisterStart, noRegisterStart);
                assert.ok(
                    !autoRegisterBlock.includes('exit 1'),
                    'Auto-register failure path must not contain exit 1 — failures are non-fatal'
                );
            } else {
                // Fallback: check that the overall function doesn't exit 1 in the adapter staging failure messages
                const stagingFailIdx = section.indexOf('Adapter staging failed');
                if (stagingFailIdx > 0) {
                    // Check the 300 chars after failure message for exit 1
                    const afterFail = section.substring(stagingFailIdx, stagingFailIdx + 300);
                    assert.ok(
                        !afterFail.includes('exit 1'),
                        'After "Adapter staging failed" warning, must not exit 1'
                    );
                }
            }
        });

        it('registration failure is also non-fatal', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('Registration failed') ||
                section.includes('registration failed'),
                'Must print warning when registration fails (non-fatal)'
            );
        });

        it('uses if pattern to capture register exit code', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('if register_output=$('),
                'Must use "if register_output=$(...)" pattern to capture register exit code non-fatally'
            );
        });
    });
});
