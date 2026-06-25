// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for --from-tune flag in do/adapter add and do/add-ic.
 *
 * Tests that the rendered scripts contain correct logic for:
 * - do/adapter add --from-tune reads TUNE_OUTPUT_PATH_LATEST from config
 * - do/adapter add --from-tune sft reads technique-specific TUNE_ADAPTER_PATH_SFT
 * - do/adapter add --from-tune errors when output type is full-model
 * - do/add-ic --from-tune reads TUNE_OUTPUT_PATH_LATEST from config
 *
 * Feature: managed-model-customization
 * Validates: Requirements 8.8, 8.9, 8.10
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: managed-model-customization — --from-tune integration (Req 8.8, 8.9, 8.10)', function () {
    this.timeout(120000);

    let result;
    let adapterScript;
    let addIcScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
            'enable-lora': true,
            'region': 'us-east-1',
            'instance-type': 'ml.g5.xlarge'
        });

        // Read the rendered scripts
        const adapterPath = result.file('do/adapter');
        adapterScript = fs.readFileSync(adapterPath, 'utf8');

        const addIcPath = result.file('do/add-ic');
        addIcScript = fs.readFileSync(addIcPath, 'utf8');
    });

    after(() => {
        if (result) result.cleanup();
    });

    // ── Helper to extract the _adapter_add section ───────────────────────

    function getAdapterAddSection() {
        const start = adapterScript.indexOf('_adapter_add()');
        const end = adapterScript.indexOf('\n_adapter_list()');
        if (start === -1) {
            return adapterScript;
        }
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

    // ── do/adapter add --from-tune reads correct config variable ─────────

    describe('do/adapter add --from-tune reads TUNE_OUTPUT_PATH_LATEST', () => {

        it('parses --from-tune flag in argument parsing', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('--from-tune)'),
                'Must parse --from-tune flag in argument parsing'
            );
        });

        it('reads TUNE_OUTPUT_PATH_LATEST when no technique is specified', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_OUTPUT_PATH_LATEST'),
                'Must read TUNE_OUTPUT_PATH_LATEST from config'
            );
        });

        it('sets weights_uri from TUNE_OUTPUT_PATH_LATEST', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('weights_uri="${TUNE_OUTPUT_PATH_LATEST}"'),
                'Must set weights_uri from TUNE_OUTPUT_PATH_LATEST'
            );
        });

        it('shows error when TUNE_OUTPUT_PATH_LATEST is not set', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_OUTPUT_PATH_LATEST:-') &&
                addSection.includes('No tune output found'),
                'Must show error when TUNE_OUTPUT_PATH_LATEST is not set'
            );
        });

        it('suggests running do/tune when no output is available', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('./do/tune --technique'),
                'Must suggest running do/tune when no output is available'
            );
        });

        it('displays the resolved tune output path', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('Using latest tune adapter output'),
                'Must display the resolved tune output path'
            );
        });
    });

    // ── do/adapter add --from-tune sft reads technique-specific path ─────

    describe('do/adapter add --from-tune sft reads technique-specific path', () => {

        it('checks for optional technique argument after --from-tune', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('from_tune_technique'),
                'Must support optional technique argument after --from-tune'
            );
        });

        it('converts technique to uppercase for variable lookup', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('tr \'[:lower:]\' \'[:upper:]\''),
                'Must convert technique to uppercase for variable name'
            );
        });

        it('constructs TUNE_ADAPTER_PATH_<TECHNIQUE> variable name', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_ADAPTER_PATH_${technique_upper}'),
                'Must construct TUNE_ADAPTER_PATH_<TECHNIQUE> variable name'
            );
        });

        it('reads technique-specific adapter path using indirect variable reference', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('${!tune_var:-}'),
                'Must use indirect variable reference to read technique-specific path'
            );
        });

        it('shows error when technique-specific path is not set', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('No adapter output found for technique'),
                'Must show error when technique-specific path is not set'
            );
        });

        it('includes technique name in error message', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('${from_tune_technique}'),
                'Must include technique name in error message'
            );
        });

        it('includes variable name in error message for debugging', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('${tune_var} is not set'),
                'Must include variable name in error message'
            );
        });

        it('displays the resolved technique-specific path', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('Using tune adapter output for technique'),
                'Must display the resolved technique-specific path'
            );
        });
    });

    // ── do/adapter add --from-tune errors when output type is full-model ─

    describe('do/adapter add --from-tune errors when output type is full-model', () => {

        it('checks TUNE_OUTPUT_TYPE_LATEST before using latest output', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_OUTPUT_TYPE_LATEST'),
                'Must check TUNE_OUTPUT_TYPE_LATEST'
            );
        });

        it('compares output type against full-model', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('"full-model"'),
                'Must compare output type against "full-model"'
            );
        });

        it('shows error explaining output is a full model', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('Latest tune output is a full model, not an adapter'),
                'Must show error explaining output is a full model'
            );
        });

        it('shows TUNE_OUTPUT_TYPE_LATEST=full-model in error details', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_OUTPUT_TYPE_LATEST=full-model'),
                'Must show the current output type value in error'
            );
        });

        it('suggests using do/add-ic --from-tune instead', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('do/add-ic') && addSection.includes('--from-tune'),
                'Must suggest using do/add-ic --from-tune instead'
            );
        });

        it('exits with error code 1 when output type is full-model', () => {
            const addSection = getAdapterAddSection();
            // Find the full-model error section and verify exit 1 follows
            const fullModelIdx = addSection.indexOf('Latest tune output is a full model');
            assert.ok(fullModelIdx > 0, 'Must have full-model error message');
            const afterError = addSection.substring(fullModelIdx, fullModelIdx + 500);
            assert.ok(
                afterError.includes('exit 1'),
                'Must exit with error code 1 when output type is full-model'
            );
        });
    });

    // ── do/add-ic --from-tune reads TUNE_OUTPUT_PATH_LATEST ──────────────

    describe('do/add-ic --from-tune reads TUNE_OUTPUT_PATH_LATEST', () => {

        it('parses --from-tune flag in argument parsing', () => {
            assert.ok(
                addIcScript.includes('--from-tune)'),
                'Must parse --from-tune flag in argument parsing'
            );
        });

        it('reads TUNE_OUTPUT_PATH_LATEST from config', () => {
            assert.ok(
                addIcScript.includes('TUNE_OUTPUT_PATH_LATEST'),
                'Must read TUNE_OUTPUT_PATH_LATEST from config'
            );
        });

        it('sets MODEL_DATA from TUNE_OUTPUT_PATH_LATEST', () => {
            assert.ok(
                addIcScript.includes('MODEL_DATA="${TUNE_OUTPUT_PATH_LATEST}"'),
                'Must set MODEL_DATA from TUNE_OUTPUT_PATH_LATEST'
            );
        });

        it('shows error when TUNE_OUTPUT_PATH_LATEST is not set', () => {
            assert.ok(
                addIcScript.includes('TUNE_OUTPUT_PATH_LATEST:-') &&
                addIcScript.includes('No tune output found'),
                'Must show error when TUNE_OUTPUT_PATH_LATEST is not set'
            );
        });

        it('suggests running do/tune when no output is available', () => {
            assert.ok(
                addIcScript.includes('./do/tune --technique'),
                'Must suggest running do/tune when no output is available'
            );
        });

        it('displays the resolved tune output path', () => {
            assert.ok(
                addIcScript.includes('Using tune output'),
                'Must display the resolved tune output path'
            );
        });

        it('--from-tune and --model-data are mutually exclusive', () => {
            assert.ok(
                addIcScript.includes('--from-tune and --model-data are mutually exclusive'),
                'Must enforce mutual exclusivity between --from-tune and --model-data'
            );
        });

        it('exits with error when both --from-tune and --model-data are provided', () => {
            // Find the actual error check (with ❌ prefix), not the usage text
            const mutualIdx = addIcScript.indexOf('❌ --from-tune and --model-data are mutually exclusive');
            assert.ok(mutualIdx > 0, 'Must have mutual exclusivity error check');
            const afterError = addIcScript.substring(mutualIdx, mutualIdx + 400);
            assert.ok(
                afterError.includes('exit 1'),
                'Must exit with error code 1 when both flags are provided'
            );
        });

        it('includes --from-tune in usage/help text', () => {
            assert.ok(
                addIcScript.includes('--from-tune') &&
                addIcScript.includes('TUNE_OUTPUT_PATH_LATEST'),
                'Must document --from-tune in help text'
            );
        });

        it('does not check TUNE_OUTPUT_TYPE_LATEST (works for both types)', () => {
            // add-ic should NOT gate on output type - it works for both adapter and full-model
            // Verify it does not reject based on output type
            const fromTuneSection = addIcScript.substring(
                addIcScript.indexOf('Resolve --from-tune'),
                addIcScript.indexOf('Add New Inference Component')
            );
            assert.ok(
                !fromTuneSection.includes('TUNE_OUTPUT_TYPE_LATEST'),
                'add-ic must NOT check TUNE_OUTPUT_TYPE_LATEST (works for both types)'
            );
        });
    });

    // ── Generated project structure ──────────────────────────────────────

    describe('Generated project has --from-tune support in both scripts', () => {

        it('do/adapter script is present', () => {
            result.assertFile('do/adapter');
        });

        it('do/add-ic script is present', () => {
            result.assertFile('do/add-ic');
        });

        it('do/adapter includes --from-tune in usage text', () => {
            assert.ok(
                adapterScript.includes('--from-tune'),
                'do/adapter must include --from-tune in usage'
            );
        });

        it('do/add-ic includes --from-tune in usage text', () => {
            assert.ok(
                addIcScript.includes('--from-tune'),
                'do/add-ic must include --from-tune in usage'
            );
        });

        it('do/adapter stores ADAPTER_SOURCE="tune" in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_SOURCE') && addSection.includes('"tune"'),
                'Must store ADAPTER_SOURCE="tune" in conf file'
            );
        });

        it('do/adapter stores ADAPTER_TUNE_TECHNIQUE in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_TUNE_TECHNIQUE'),
                'Must store ADAPTER_TUNE_TECHNIQUE in conf file'
            );
        });

        it('do/adapter stores ADAPTER_PARENT_MODEL_ARN in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_PARENT_MODEL_ARN'),
                'Must store ADAPTER_PARENT_MODEL_ARN in conf file for compat check'
            );
        });

        it('do/adapter stores ADAPTER_PARENT_MODEL_SLUG in conf when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_PARENT_MODEL_SLUG'),
                'Must store ADAPTER_PARENT_MODEL_SLUG in conf file for compat check'
            );
        });

        it('do/adapter resolves parent model ARN from MODEL_PKG_ARN or list-models', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('MODEL_PKG_ARN') || addSection.includes('list-models'),
                'Must resolve parent model ARN from MODEL_PKG_ARN or deployment MPG'
            );
        });

        it('do/adapter uses MODEL_NAME as parent model slug', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('MODEL_NAME') && addSection.includes('parent_model_slug'),
                'Must use MODEL_NAME from do/config as the parent model slug'
            );
        });
    });
});
