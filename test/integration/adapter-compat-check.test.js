// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for ADAPTER_SOURCE="s3" default and adapter compatibility check.
 *
 * Tests that the rendered do/adapter script contains correct logic for:
 * - Part (a): When no --from-* flag is used, ADAPTER_SOURCE="s3" is written to conf
 * - Part (b): Compat check logic:
 *   - Mismatch produces warning and prompts/aborts
 *   - --force bypasses check
 *   - Missing parent metadata skips check with info message
 *   - Fallback slug match treats as compatible
 *
 * Feature: tune-register-loop
 * Validates: Requirements US-3, US-4 AC-4.5
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: tune-register-loop — ADAPTER_SOURCE="s3" default and compat check (US-3, US-4 AC-4.5)', function () {
    this.timeout(120000);

    let result;
    let adapterScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
            'enable-lora': true,
            'region': 'us-east-1',
            'instance-type': 'ml.g5.xlarge'
        });

        // Read the rendered do/adapter script
        const adapterPath = result.file('do/adapter');
        adapterScript = fs.readFileSync(adapterPath, 'utf8');
    });

    after(() => {
        if (result) result.cleanup();
    });

    // ── Helper to extract the _adapter_add section ───────────────────────

    function getAdapterAddSection() {
        const start = adapterScript.indexOf('_adapter_add()');
        const end = adapterScript.indexOf('\n_adapter_list(');
        if (start === -1) {
            return adapterScript;
        }
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

    // ── Part (a): ADAPTER_SOURCE="s3" written when no --from-* flag ──────

    describe('Part (a): ADAPTER_SOURCE="s3" is written when no --from-* flag is used', () => {

        it('writes ADAPTER_SOURCE="s3" to conf file in the default (bare S3 URI) path', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_SOURCE="s3"'),
                'Must write ADAPTER_SOURCE="s3" to conf when no --from-* flag is used'
            );
        });

        it('ADAPTER_SOURCE="s3" is guarded by absence of from_hub, from_tune, from_registry', () => {
            const addSection = getAdapterAddSection();
            // Find the block that writes ADAPTER_SOURCE="s3"
            const s3SourceIdx = addSection.indexOf('ADAPTER_SOURCE="s3"');
            assert.ok(s3SourceIdx > 0, 'ADAPTER_SOURCE="s3" must exist in add section');

            // Look at the surrounding context (the conditional guard)
            const contextBefore = addSection.substring(Math.max(0, s3SourceIdx - 300), s3SourceIdx);
            assert.ok(
                contextBefore.includes('from_hub') &&
                contextBefore.includes('from_tune') &&
                contextBefore.includes('from_registry'),
                'ADAPTER_SOURCE="s3" must be guarded by checking from_hub, from_tune, and from_registry are empty'
            );
        });

        it('uses export keyword for ADAPTER_SOURCE in the s3 default path', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('export ADAPTER_SOURCE="s3"'),
                'ADAPTER_SOURCE must use export keyword in the s3 default path'
            );
        });

        it('ADAPTER_SOURCE="s3" is distinct from other source values (tune, hub, registry)', () => {
            const addSection = getAdapterAddSection();
            // Verify all four ADAPTER_SOURCE values exist in the script
            assert.ok(addSection.includes('ADAPTER_SOURCE="s3"'), 'Must have s3 source');
            assert.ok(addSection.includes('ADAPTER_SOURCE="tune"'), 'Must have tune source');
            assert.ok(addSection.includes('ADAPTER_SOURCE="hub"'), 'Must have hub source');
            assert.ok(addSection.includes('ADAPTER_SOURCE="registry"'), 'Must have registry source');
        });
    });

    // ── Part (b): Compatibility check ────────────────────────────────────

    describe('Part (b): Compat check — mismatch produces warning and prompts/aborts', () => {

        it('contains the compatibility check block in _adapter_add', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('Compatibility check') ||
                addSection.includes('compatibility check') ||
                addSection.includes('compat'),
                'Must contain the compatibility check block'
            );
        });

        it('compares adapter parent model ARN against deployed model ARN', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('_compat_parent_arn') &&
                addSection.includes('MODEL_PKG_ARN'),
                'Must compare adapter parent ARN against MODEL_PKG_ARN'
            );
        });

        it('calls DescribeInferenceComponent to get deployed model identity', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('describe-inference-component') &&
                addSection.includes('ArtifactUrl'),
                'Must call DescribeInferenceComponent to get ArtifactUrl'
            );
        });

        it('prints warning with both identities on mismatch', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('Adapter was trained on') &&
                addSection.includes('Deployed model'),
                'Must print warning showing adapter parent and deployed model on mismatch'
            );
        });

        it('prompts user in interactive mode (TTY check)', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('-t 0') &&
                addSection.includes('Continue anyway? [y/N]'),
                'Must check if stdin is a TTY and prompt user'
            );
        });

        it('aborts in non-interactive mode with helpful message', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('Aborting (non-interactive)') &&
                addSection.includes('--force to override'),
                'Must abort in non-interactive mode and suggest --force'
            );
        });

        it('exits with code 1 on non-interactive mismatch', () => {
            const addSection = getAdapterAddSection();
            const abortIdx = addSection.indexOf('Aborting (non-interactive)');
            assert.ok(abortIdx > 0, 'Must have non-interactive abort message');
            const afterAbort = addSection.substring(abortIdx, abortIdx + 200);
            assert.ok(
                afterAbort.includes('exit 1'),
                'Must exit 1 after non-interactive abort'
            );
        });
    });

    describe('Part (b): Compat check — --force bypasses check', () => {

        it('parses --force flag in argument parsing', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('--force)') &&
                addSection.includes('force="true"'),
                'Must parse --force flag and set force="true"'
            );
        });

        it('skips compatibility check when --force is set', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('force') &&
                addSection.includes('skipping compatibility check'),
                'Must skip compat check when --force is set'
            );
        });

        it('prints info message when --force skips check', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('--force: skipping compatibility check') ||
                addSection.includes('--force') && addSection.includes('skipping compatibility check'),
                'Must print info message when --force skips check'
            );
        });
    });

    describe('Part (b): Compat check — missing parent metadata skips check', () => {

        it('checks for parent model metadata before performing compat check', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('_compat_parent_arn') &&
                addSection.includes('_compat_parent_slug'),
                'Must check for parent model ARN and slug before compat check'
            );
        });

        it('prints info message when no parent metadata is available', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('No parent model metadata') &&
                addSection.includes('skipping compatibility check'),
                'Must print info when no parent metadata — skip check'
            );
        });

        it('does not abort when parent metadata is missing', () => {
            const addSection = getAdapterAddSection();
            // The "No parent model metadata" path should NOT have exit 1
            const noMetaIdx = addSection.indexOf('No parent model metadata');
            assert.ok(noMetaIdx > 0, 'Must have "No parent model metadata" message');
            const afterNoMeta = addSection.substring(noMetaIdx, noMetaIdx + 200);
            assert.ok(
                !afterNoMeta.includes('exit 1'),
                'Must NOT exit 1 when parent metadata is missing — just skip'
            );
        });
    });

    describe('Part (b): Compat check — fallback slug match treats as compatible', () => {

        it('stores parent model slug for fallback comparison', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('_compat_parent_slug') ||
                addSection.includes('_compat_expected_slug'),
                'Must store parent model slug for fallback'
            );
        });

        it('checks if deployed artifact URL contains the expected model slug', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('_compat_expected_slug') &&
                addSection.includes('_compat_deployed_model'),
                'Must check if artifact URL contains expected slug'
            );
        });

        it('uses glob/pattern match for slug in artifact URL', () => {
            const addSection = getAdapterAddSection();
            // Bash pattern: [[ "${var}" == *"${slug}"* ]]
            assert.ok(
                addSection.includes('*"${_compat_expected_slug}"*'),
                'Must use pattern match (*slug*) to check slug in artifact URL'
            );
        });

        it('treats slug match as compatible (no warning, no prompt)', () => {
            const addSection = getAdapterAddSection();
            // After slug match, there's just a ":" (no-op) — no warning/abort
            const slugMatchIdx = addSection.indexOf('*"${_compat_expected_slug}"*');
            assert.ok(slugMatchIdx > 0, 'Must have slug pattern match');
            const afterSlugMatch = addSection.substring(slugMatchIdx, slugMatchIdx + 200);
            // The slug match path should contain a no-op (:) indicating compatibility
            assert.ok(
                afterSlugMatch.includes('Slug match') ||
                afterSlugMatch.includes('compatible') ||
                afterSlugMatch.includes(': #'),
                'Slug match path must treat adapter as compatible (no-op or comment)'
            );
        });
    });

    // ── Compat check: derives parent metadata from --from-tune and --from-registry ──

    describe('Part (b): Compat check — derives parent metadata from source flags', () => {

        it('derives parent slug from MODEL_NAME when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('_compat_parent_slug="${MODEL_NAME:-}"'),
                'Must derive parent slug from MODEL_NAME for --from-tune'
            );
        });

        it('derives parent ARN from MODEL_PKG_ARN when --from-tune is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('_compat_parent_arn="${MODEL_PKG_ARN}"') ||
                (addSection.includes('MODEL_PKG_ARN') && addSection.includes('_compat_parent_arn')),
                'Must derive parent ARN from MODEL_PKG_ARN for --from-tune'
            );
        });

        it('extracts parentModelVersionArn from registry metadata when --from-registry is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('parentModelVersionArn') &&
                addSection.includes('from_registry'),
                'Must extract parentModelVersionArn from registry metadata'
            );
        });

        it('extracts modelName from registry metadata for slug when --from-registry is used', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('modelName') &&
                addSection.includes('_compat_parent_slug'),
                'Must extract modelName from registry metadata for slug'
            );
        });
    });
});
