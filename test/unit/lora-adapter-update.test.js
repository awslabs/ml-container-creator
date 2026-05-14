// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/adapter update implementation.
 *
 * Tests cover:
 * - Validates adapter conf file exists (do/adapters/<name>.conf)
 * - Validates new S3 URI format
 * - Reads ADAPTER_IC_NAME from conf file
 * - Calls UpdateInferenceComponent with correct arguments
 * - Waits for IC to return to InService (uses wait_ic)
 * - Updates ADAPTER_WEIGHTS_URI in do/adapters/<name>.conf
 * - Shows progress messages during update
 * - Handles errors gracefully
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 2.5
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
 * Extract the _adapter_update function body from the rendered script.
 */
function getUpdateSection(rendered) {
    const start = rendered.indexOf('_adapter_update()');
    const end = rendered.indexOf('\n# ── Main: parse subcommand');
    return rendered.substring(start, end);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/adapter update (Req 2.5)', () => {

    // ── S3 URI validation ────────────────────────────────────────────────

    describe('S3 URI format validation', () => {

        it('validates new S3 URI format', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('s3://') && updateSection.includes('.tar.gz'),
                'Must validate S3 URI starts with s3:// and ends with .tar.gz'
            );
        });

        it('shows error for invalid S3 URI', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Invalid S3 URI'),
                'Must show error message for invalid S3 URI'
            );
        });
    });

    // ── Adapter conf validation ──────────────────────────────────────────

    describe('Adapter conf file validation', () => {

        it('checks that do/adapters/<name>.conf exists', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('adapters/${adapter_name}.conf'),
                'Must check for adapter conf file existence'
            );
        });

        it('shows error when adapter conf not found', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Adapter not found'),
                'Must show error when adapter not found'
            );
        });

        it('lists available adapters when name not found', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Available adapters'),
                'Must list available adapters on not-found error'
            );
        });
    });

    // ── Read ADAPTER_IC_NAME from conf ───────────────────────────────────

    describe('Reading adapter IC name from conf', () => {

        it('reads ADAPTER_IC_NAME from the conf file', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('ADAPTER_IC_NAME'),
                'Must read ADAPTER_IC_NAME from conf file'
            );
        });

        it('handles corrupted conf file gracefully', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('corrupted') || updateSection.includes('Could not read'),
                'Must handle missing ADAPTER_IC_NAME in conf'
            );
        });
    });

    // ── UpdateInferenceComponent call ────────────────────────────────────

    describe('UpdateInferenceComponent API call', () => {

        it('calls aws sagemaker update-inference-component', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('aws sagemaker update-inference-component'),
                'Must call UpdateInferenceComponent API'
            );
        });

        it('passes --inference-component-name with adapter IC name', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('--inference-component-name "${adapter_ic_name}"'),
                'Must pass adapter IC name to update command'
            );
        });

        it('passes --specification with new ArtifactUrl', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('--specification') && updateSection.includes('ArtifactUrl'),
                'Must pass specification with new ArtifactUrl'
            );
        });

        it('includes Container.ArtifactUrl in specification JSON', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Container') && updateSection.includes('ArtifactUrl'),
                'Must include Container.ArtifactUrl in specification'
            );
        });

        it('passes --region with AWS_REGION', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('--region "${AWS_REGION}"'),
                'Must pass region to update command'
            );
        });

        it('handles update failure gracefully', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Failed to update adapter inference component'),
                'Must show error on update failure'
            );
        });
    });

    // ── Wait for InService ───────────────────────────────────────────────

    describe('Waiting for IC to return to InService', () => {

        it('calls wait_ic to wait for InService', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('wait_ic'),
                'Must call wait_ic to wait for IC to return to InService'
            );
        });

        it('passes adapter IC name to wait_ic', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('wait_ic "${adapter_ic_name}"'),
                'Must pass adapter IC name to wait_ic'
            );
        });

        it('mentions Updating state in progress message', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Updating'),
                'Must mention Updating state transition'
            );
        });
    });

    // ── Update conf file ─────────────────────────────────────────────────

    describe('Updating ADAPTER_WEIGHTS_URI in conf file', () => {

        it('updates ADAPTER_WEIGHTS_URI using sed', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('sed') && updateSection.includes('ADAPTER_WEIGHTS_URI'),
                'Must update ADAPTER_WEIGHTS_URI in conf file using sed'
            );
        });

        it('uses in-place sed edit', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('sed -i'),
                'Must use sed -i for in-place editing'
            );
        });

        it('cleans up sed backup file', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('.bak') && updateSection.includes('rm -f'),
                'Must clean up .bak file created by sed -i'
            );
        });
    });

    // ── Progress messages ────────────────────────────────────────────────

    describe('Progress messages', () => {

        it('shows updating message at start', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Updating adapter'),
                'Must show updating message'
            );
        });

        it('shows updating inference component message', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Updating inference component'),
                'Must show updating IC message'
            );
        });

        it('shows waiting for InService message', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Waiting for adapter IC to return to InService'),
                'Must show waiting message'
            );
        });

        it('shows success message after update', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Adapter updated successfully'),
                'Must show success message'
            );
        });

        it('shows test command suggestion', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('./do/test'),
                'Must suggest test command after update'
            );
        });
    });

    // ── --from-hub support ───────────────────────────────────────────────

    describe('--from-hub support', () => {

        it('accepts --from-hub as alternative to --weights', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('--from-hub'),
                'Must accept --from-hub option'
            );
        });

        it('--weights and --from-hub are mutually exclusive', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('--weights and --from-hub are mutually exclusive'),
                'Must enforce mutual exclusivity of --weights and --from-hub'
            );
        });

        it('requires either --weights or --from-hub', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Either --weights or --from-hub is required'),
                'Must require one of --weights or --from-hub'
            );
        });

        it('validates HuggingFace repo ID format', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('Invalid HuggingFace repo ID'),
                'Must validate HF repo ID format'
            );
        });

        it('calls _download_from_hub when --from-hub is used', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('_download_from_hub "${from_hub}" "${adapter_name}"'),
                'Must call _download_from_hub with repo ID and adapter name'
            );
        });

        it('updates ADAPTER_SOURCE in conf when --from-hub is used', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('ADAPTER_SOURCE') && updateSection.includes('hub'),
                'Must update ADAPTER_SOURCE to hub in conf file'
            );
        });

        it('updates ADAPTER_HF_REPO in conf when --from-hub is used', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('ADAPTER_HF_REPO') && updateSection.includes('${from_hub}'),
                'Must update ADAPTER_HF_REPO in conf file'
            );
        });

        it('shows HuggingFace Hub source in progress output', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('HuggingFace Hub'),
                'Must show HuggingFace Hub source in output'
            );
        });

        it('shows --from-hub in help text', () => {
            const rendered = renderAdapter();
            const updateSection = getUpdateSection(rendered);
            assert.ok(
                updateSection.includes('--from-hub <hf-repo-id>'),
                'Must show --from-hub in help text'
            );
        });
    });
});
