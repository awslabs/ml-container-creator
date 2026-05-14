// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/adapter remove implementation.
 *
 * Tests cover:
 * - Validates adapter conf file exists (do/adapters/<name>.conf)
 * - Reads ADAPTER_IC_NAME from conf file
 * - Calls DeleteInferenceComponent with correct arguments
 * - Waits for deletion (polls _get_ic_status until empty/not-found)
 * - Removes do/adapters/<name>.conf after deletion
 * - Handles already-deleted IC gracefully
 * - Shows progress messages during deletion
 * - Lists available adapters when name not found
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 2.4
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADAPTER_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/adapter');
const ADAPTER_TEMPLATE = readFileSync(ADAPTER_TEMPLATE_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderAdapter(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        awsRegion: 'us-east-1',
        ...overrides
    };
    return ejs.render(ADAPTER_TEMPLATE, vars);
}

/**
 * Extract the _adapter_remove function body from the rendered script.
 */
function getRemoveSection(rendered) {
    const start = rendered.indexOf('_adapter_remove()');
    const end = rendered.indexOf('\n_adapter_update(');
    return rendered.substring(start, end);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/adapter remove (Req 2.4)', () => {

    // ── Adapter conf validation ──────────────────────────────────────────

    describe('Adapter conf file validation', () => {

        it('checks that do/adapters/<name>.conf exists', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('adapters/${adapter_name}.conf'),
                'Must check for adapter conf file existence'
            );
        });

        it('shows error when adapter conf not found', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('Adapter not found'),
                'Must show error when adapter not found'
            );
        });

        it('lists available adapters when name not found', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('Available adapters'),
                'Must list available adapters on not-found error'
            );
        });
    });

    // ── Read ADAPTER_IC_NAME from conf ───────────────────────────────────

    describe('Reading adapter IC name from conf', () => {

        it('reads ADAPTER_IC_NAME from the conf file', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('ADAPTER_IC_NAME'),
                'Must read ADAPTER_IC_NAME from conf file'
            );
        });

        it('handles corrupted conf file gracefully', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('corrupted') || removeSection.includes('Could not read'),
                'Must handle missing ADAPTER_IC_NAME in conf'
            );
        });
    });

    // ── DeleteInferenceComponent call ────────────────────────────────────

    describe('DeleteInferenceComponent API call', () => {

        it('calls aws sagemaker delete-inference-component', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('aws sagemaker delete-inference-component'),
                'Must call DeleteInferenceComponent API'
            );
        });

        it('passes --inference-component-name with adapter IC name', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('--inference-component-name "${adapter_ic_name}"'),
                'Must pass adapter IC name to delete command'
            );
        });

        it('passes --region with AWS_REGION', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('--region "${AWS_REGION}"'),
                'Must pass region to delete command'
            );
        });

        it('handles already-deleted IC gracefully', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('already deleted') || removeSection.includes('not found'),
                'Must handle case where IC is already deleted'
            );
        });
    });

    // ── Wait for deletion ────────────────────────────────────────────────

    describe('Waiting for deletion to complete', () => {

        it('polls _get_ic_status in a loop', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('_get_ic_status'),
                'Must poll _get_ic_status for deletion status'
            );
        });

        it('breaks when status is empty (IC deleted)', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('-z "${status}"') || removeSection.includes('[ -z'),
                'Must break loop when status is empty'
            );
        });

        it('has a timeout to prevent infinite waiting', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('timeout'),
                'Must have a timeout for the deletion wait loop'
            );
        });

        it('shows elapsed time during wait', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('elapsed'),
                'Must show elapsed time during wait'
            );
        });
    });

    // ── Conf file removal ────────────────────────────────────────────────

    describe('Conf file cleanup', () => {

        it('removes the adapter conf file after deletion', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('rm -f "${conf_file}"') || removeSection.includes('rm -f'),
                'Must remove adapter conf file'
            );
        });

        it('shows success message after removal', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('Adapter removed successfully'),
                'Must show success message'
            );
        });
    });

    // ── Progress messages ────────────────────────────────────────────────

    describe('Progress messages', () => {

        it('shows removing message at start', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('Removing adapter'),
                'Must show removing message'
            );
        });

        it('shows deleting inference component message', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('Deleting inference component'),
                'Must show deleting IC message'
            );
        });

        it('shows waiting for deletion message', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('Waiting for adapter IC deletion'),
                'Must show waiting message'
            );
        });

        it('shows IC deleted confirmation', () => {
            const rendered = renderAdapter();
            const removeSection = getRemoveSection(rendered);
            assert.ok(
                removeSection.includes('Adapter IC deleted'),
                'Must confirm IC deletion'
            );
        });
    });
});
