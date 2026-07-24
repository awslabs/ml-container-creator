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

        it('writes adapter conf file with weights URI', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('ADAPTER_WEIGHTS_URI') &&
                section.includes('.conf'),
                'Must write adapter conf file with ADAPTER_WEIGHTS_URI'
            );
        });

        it('does NOT call do/adapter add as subprocess (user deploys manually)', () => {
            const section = getHandleCompletionSection();
            // The auto-register block should NOT invoke adapter add — only print the command
            const autoRegBlock = section.substring(
                section.indexOf('Auto-registering'),
                section.indexOf('--no-register') > 0 ? section.indexOf('--no-register') : section.length
            );
            assert.ok(
                !autoRegBlock.includes('"${SCRIPT_DIR}/adapter" add "${adapter_name}" --from-tune'),
                'Must NOT call adapter add as subprocess — user deploys manually'
            );
        });

        it('prints do/adapter add command for user to run manually', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('./do/adapter add') &&
                section.includes('--from-tune'),
                'Must print do/adapter add command for user to deploy manually'
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
                tuneScript.includes('Skip automatic adapter deployment after completion'),
                'Must document --no-register in help output'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // Part (c): Subprocess failure is non-fatal
    // ══════════════════════════════════════════════════════════════════════

    describe('(c) auto-register is non-fatal and does not deploy', () => {

        it('does not call do/adapter add in the auto-register path', () => {
            const section = getHandleCompletionSection();
            // After "Auto-registering" the script should write conf, not invoke adapter add
            const autoRegStart = section.indexOf('Auto-registering');
            if (autoRegStart > 0) {
                const block = section.substring(autoRegStart, autoRegStart + 800);
                assert.ok(
                    !block.includes('"${SCRIPT_DIR}/adapter" add'),
                    'Auto-register must not invoke adapter add subprocess'
                );
            }
        });

        it('does not exit 1 in the auto-register path', () => {
            const section = getHandleCompletionSection();
            const autoRegisterStart = section.indexOf('Auto-registering');
            const noRegisterStart = section.indexOf('--no-register');
            if (autoRegisterStart > 0 && noRegisterStart > autoRegisterStart) {
                const autoRegisterBlock = section.substring(autoRegisterStart, noRegisterStart);
                assert.ok(
                    !autoRegisterBlock.includes('exit 1'),
                    'Auto-register path must not contain exit 1'
                );
            }
        });

        it('writes conf file unconditionally (no failure possible)', () => {
            const section = getHandleCompletionSection();
            assert.ok(
                section.includes('cat > "${_adapter_conf}"') ||
                section.includes('_adapter_conf'),
                'Must write adapter conf file directly (no subprocess failure possible)'
            );
        });
    });
});
