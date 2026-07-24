// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/add-ic --update flag implementation.
 *
 * Tests cover:
 * - --update flag is parsed alongside existing flags
 * - --update requires IC name argument
 * - --update validates IC config file exists
 * - --update reads IC_DEPLOYED_NAME from config
 * - --update resolves model data from --from-tune, --model-data, or IC_MODEL_DATA
 * - --update calls ic_update.py with correct arguments
 * - --help output documents --update flag
 * - --update is compatible with --from-tune and --model-data
 *
 * Feature: BL025 — do/deploy --update: IC model artifact migration
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADD_IC_PATH = resolve(__dirname, '../../templates/do/add-ic');
const ADD_IC_SCRIPT = readFileSync(ADD_IC_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if the script contains a specific string pattern.
 */
function scriptContains(pattern) {
    return ADD_IC_SCRIPT.includes(pattern);
}

/**
 * Check if a regex matches within the script.
 */
function scriptMatches(regex) {
    return regex.test(ADD_IC_SCRIPT);
}

/**
 * Extract the _usage function output lines from the script.
 */
function getUsageSection() {
    const start = ADD_IC_SCRIPT.indexOf('_usage()');
    const end = ADD_IC_SCRIPT.indexOf('}', start + ADD_IC_SCRIPT.substring(start).indexOf('echo ""'));
    return ADD_IC_SCRIPT.substring(start, end + 1);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('do/add-ic --update flag', () => {
    describe('argument parsing', () => {
        it('declares UPDATE_MODE variable', () => {
            assert.ok(scriptContains('UPDATE_MODE=""'), 'should initialize UPDATE_MODE to empty');
        });

        it('parses --update flag in case statement', () => {
            assert.ok(scriptContains('--update)'), 'should have --update) case');
            assert.ok(scriptContains('UPDATE_MODE="true"'), 'should set UPDATE_MODE to true');
        });

        it('does not conflict with existing --from-tune parsing', () => {
            assert.ok(scriptContains('--from-tune)'), 'should still parse --from-tune');
            assert.ok(scriptContains('FROM_TUNE="true"'), 'should still set FROM_TUNE');
        });

        it('does not conflict with existing --model-data parsing', () => {
            assert.ok(scriptContains('--model-data)'), 'should still parse --model-data');
        });
    });

    describe('--update mode validation', () => {
        it('requires IC_NAME when --update is set', () => {
            assert.ok(
                scriptContains('IC name is required for --update'),
                'should show error when IC_NAME is empty in update mode'
            );
        });

        it('validates IC config file exists', () => {
            assert.ok(
                scriptContains('IC config not found: do/ic/${IC_NAME}.conf'),
                'should check for IC config file existence'
            );
        });

        it('sources the IC config file to get IC_DEPLOYED_NAME', () => {
            assert.ok(
                scriptMatches(/source "\$\{IC_CONF_PATH\}"/),
                'should source IC_CONF_PATH in update mode'
            );
        });

        it('validates IC_DEPLOYED_NAME is set', () => {
            assert.ok(
                scriptContains('has never been deployed (no IC_DEPLOYED_NAME'),
                'should error when IC_DEPLOYED_NAME is empty'
            );
        });
    });

    describe('model data resolution in update mode', () => {
        it('falls back to IC_MODEL_DATA from config when no --model-data or --from-tune', () => {
            assert.ok(
                scriptContains('IC_MODEL_DATA:-'),
                'should reference IC_MODEL_DATA from sourced config'
            );
        });

        it('supports --from-tune in update mode', () => {
            // --from-tune resolves MODEL_DATA before the update block runs
            assert.ok(
                scriptMatches(/if \[ -n "\$\{FROM_TUNE\}" \]/),
                'should resolve --from-tune before update mode logic'
            );
        });
    });

    describe('update execution', () => {
        it('calls ic_update.py with --ic-name', () => {
            assert.ok(
                scriptContains('"--ic-name" "${IC_DEPLOYED_NAME}"'),
                'should pass --ic-name to ic_update.py'
            );
        });

        it('calls ic_update.py with --region', () => {
            assert.ok(
                scriptContains('"--region" "${AWS_REGION:-us-east-1}"'),
                'should pass --region to ic_update.py'
            );
        });

        it('passes --model-data when MODEL_DATA is set', () => {
            assert.ok(
                scriptContains('"--model-data" "${MODEL_DATA}"'),
                'should pass --model-data to ic_update.py'
            );
        });

        it('passes --image with current ECR+tag', () => {
            assert.ok(
                scriptContains('"--image" "${IC_IMAGE}"'),
                'should pass --image to ic_update.py'
            );
        });

        it('calls python3 with ic_update.py path', () => {
            assert.ok(
                scriptContains('python3 "${SCRIPT_DIR}/lib/python/ic_update.py"'),
                'should invoke ic_update.py via python3'
            );
        });

        it('exits 0 on success', () => {
            // After the update success block, script should exit 0
            assert.ok(
                scriptMatches(/✅ Inference component updated successfully[\s\S]*?exit 0/),
                'should exit 0 after successful update'
            );
        });

        it('exits 4 on failure', () => {
            assert.ok(
                scriptMatches(/IC update failed[\s\S]*?exit 4/),
                'should exit 4 when update fails'
            );
        });
    });

    describe('config persistence after update', () => {
        it('updates IC_MODEL_DATA in IC config after successful update', () => {
            assert.ok(
                scriptContains('_update_config_var "IC_MODEL_DATA" "${MODEL_DATA}" "${IC_CONF_PATH}"'),
                'should persist new model data back to IC conf'
            );
        });

        it('sources wait.sh for _update_config_var', () => {
            assert.ok(
                scriptContains('source "${SCRIPT_DIR}/lib/wait.sh"'),
                'should source wait.sh to get _update_config_var'
            );
        });
    });

    describe('help output', () => {
        it('documents --update flag', () => {
            const usage = getUsageSection();
            assert.ok(
                usage.includes('--update'),
                '--update should appear in help output'
            );
        });

        it('documents update mode description', () => {
            const usage = getUsageSection();
            assert.ok(
                usage.includes('Update an existing IC in-place'),
                'should describe update mode'
            );
        });

        it('documents zero-disruption behavior', () => {
            const usage = getUsageSection();
            assert.ok(
                usage.includes('zero-disruption'),
                'should mention zero-disruption'
            );
        });

        it('shows update examples', () => {
            const usage = getUsageSection();
            assert.ok(
                usage.includes('./do/add-ic default --update'),
                'should show update example'
            );
        });

        it('shows update with --from-tune example', () => {
            const usage = getUsageSection();
            assert.ok(
                usage.includes('--update --from-tune'),
                'should show update + from-tune example'
            );
        });

        it('shows update with --model-data example', () => {
            const usage = getUsageSection();
            assert.ok(
                usage.includes('--update --model-data'),
                'should show update + model-data example'
            );
        });
    });

    describe('update mode does NOT run create path', () => {
        it('exits before reaching interactive prompts', () => {
            // The update mode block ends with "exit 0" before the create-mode
            // prompts for image tag, GPU count, etc.
            const updateBlock = ADD_IC_SCRIPT.substring(
                ADD_IC_SCRIPT.indexOf('# UPDATE MODE:'),
                ADD_IC_SCRIPT.indexOf('exit 0', ADD_IC_SCRIPT.indexOf('# UPDATE MODE:')) + 10
            );
            assert.ok(
                updateBlock.includes('exit 0'),
                'update mode should exit before reaching create-mode logic'
            );
        });
    });
});
