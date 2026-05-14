// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/adapter add implementation.
 *
 * Tests cover:
 * - Adapter name validation (lowercase alphanumeric + hyphens, 1-50 chars)
 * - S3 URI format validation (must start with s3:// and end with .tar.gz)
 * - Adapter name uniqueness check (do/adapters/<name>.conf must not exist)
 * - Base IC status validation (must be InService)
 * - S3 object existence check (best-effort, warn on failure)
 * - Adapter IC name format: ${PROJECT_NAME}-adapter-${name}
 * - CreateInferenceComponent call with correct JSON structure
 * - Adapter conf file creation with expected metadata fields
 * - wait_ic polling for InService status
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 2.2, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/adapter add (Req 2.2, 3.1-3.5, 4.1-4.4)', () => {

    // ── Adapter name validation (Req 4.4) ────────────────────────────────

    describe('Adapter name validation', () => {

        it('validates adapter name with regex for lowercase alphanumeric + hyphens', () => {
            const rendered = renderAdapter();
            // Must use grep with a regex pattern for name validation
            assert.ok(
                rendered.includes('[a-z0-9]') && rendered.includes('[a-z0-9-]'),
                'Must validate adapter name with lowercase alphanumeric + hyphens pattern'
            );
        });

        it('enforces 1-50 character length limit', () => {
            const rendered = renderAdapter();
            // The regex should enforce {0,49} (plus the first char = 50 total)
            assert.ok(
                rendered.includes('{0,49}'),
                'Must enforce max 50 character length via regex'
            );
        });

        it('shows helpful error message for invalid names', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('Invalid adapter name'),
                'Must show "Invalid adapter name" error'
            );
            assert.ok(
                rendered.includes('Lowercase alphanumeric and hyphens only'),
                'Must explain valid characters'
            );
        });

        it('shows examples of valid adapter names', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('ectsum') || rendered.includes('finance-qa'),
                'Must show examples of valid adapter names'
            );
        });
    });

    // ── S3 URI validation (Req 3.4) ──────────────────────────────────────

    describe('S3 URI format validation', () => {

        it('validates URI starts with s3://', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('^s3://'),
                'Must validate S3 URI starts with s3://'
            );
        });

        it('validates URI ends with .tar.gz', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('\\.tar\\.gz$'),
                'Must validate S3 URI ends with .tar.gz'
            );
        });

        it('shows helpful error message for invalid S3 URI', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('Invalid S3 URI'),
                'Must show "Invalid S3 URI" error'
            );
        });

        it('shows example of valid S3 URI', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('s3://my-bucket/adapters/ectsum/adapter.tar.gz') ||
                rendered.includes('s3://'),
                'Must show example of valid S3 URI'
            );
        });
    });

    // ── Adapter name uniqueness (Req 4.4) ────────────────────────────────

    describe('Adapter name uniqueness check', () => {

        it('checks if do/adapters/<name>.conf already exists', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('adapters/${adapter_name}.conf'),
                'Must check for existing adapter conf file'
            );
        });

        it('shows error when adapter already exists', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('Adapter already exists'),
                'Must show "Adapter already exists" error'
            );
        });

        it('suggests update or remove for existing adapters', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('do/adapter update') || rendered.includes('./do/adapter update'),
                'Must suggest update command for existing adapter'
            );
            assert.ok(
                rendered.includes('do/adapter remove') || rendered.includes('./do/adapter remove'),
                'Must suggest remove command for existing adapter'
            );
        });
    });

    // ── Base IC validation (Req 4.1) ─────────────────────────────────────

    describe('Base IC InService validation', () => {

        it('calls _resolve_base_ic_name to get base IC', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(rendered.indexOf('_adapter_add'));
            assert.ok(
                addSection.includes('_resolve_base_ic_name'),
                'Must call _resolve_base_ic_name in add function'
            );
        });

        it('calls _get_ic_status to check base IC status', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(rendered.indexOf('_adapter_add'));
            assert.ok(
                addSection.includes('_get_ic_status'),
                'Must call _get_ic_status to check base IC'
            );
        });

        it('requires base IC to be InService', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('!= "InService"') || rendered.includes('!= "InService"'),
                'Must check base IC status equals InService'
            );
        });

        it('shows error with deploy suggestion when base IC not InService', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('Base inference component is not InService'),
                'Must show error when base IC not InService'
            );
            assert.ok(
                rendered.includes('./do/deploy'),
                'Must suggest ./do/deploy when base IC not ready'
            );
        });
    });

    // ── S3 object existence check (Req 4.2) ──────────────────────────────

    describe('S3 object existence check (best-effort)', () => {

        it('uses aws s3 ls to check object exists', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(rendered.indexOf('_adapter_add'));
            assert.ok(
                addSection.includes('aws s3 ls'),
                'Must use aws s3 ls to verify S3 object'
            );
        });

        it('warns but does not block on S3 check failure', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('Could not verify S3 object') ||
                rendered.includes('Proceeding anyway'),
                'Must warn but not block when S3 check fails'
            );
        });
    });

    // ── Adapter IC name format (Req 3.1) ─────────────────────────────────

    describe('Adapter IC name format', () => {

        it('builds IC name as ${PROJECT_NAME}-adapter-${name}', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('${PROJECT_NAME}-adapter-${adapter_name}'),
                'Must build adapter IC name with PROJECT_NAME-adapter-name format'
            );
        });
    });

    // ── CreateInferenceComponent call (Req 3.2, 3.3) ─────────────────────

    describe('CreateInferenceComponent API call', () => {

        it('calls aws sagemaker create-inference-component', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(rendered.indexOf('_adapter_add'));
            assert.ok(
                addSection.includes('aws sagemaker create-inference-component'),
                'Must call aws sagemaker create-inference-component'
            );
        });

        it('passes --inference-component-name with adapter IC name', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('--inference-component-name "${adapter_ic_name}"'),
                'Must pass --inference-component-name'
            );
        });

        it('passes --endpoint-name with ENDPOINT_NAME', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('--endpoint-name "${ENDPOINT_NAME}"'),
                'Must pass --endpoint-name'
            );
        });

        it('includes BaseInferenceComponentName in specification', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('BaseInferenceComponentName'),
                'Must include BaseInferenceComponentName in specification'
            );
        });

        it('includes Container.ArtifactUrl in specification', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('ArtifactUrl'),
                'Must include ArtifactUrl in specification'
            );
        });

        it('does NOT include ComputeResourceRequirements', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(
                rendered.indexOf('_adapter_add'),
                rendered.indexOf('_adapter_list')
            );
            assert.ok(
                !addSection.includes('ComputeResourceRequirements'),
                'Must NOT include ComputeResourceRequirements (adapters share base IC resources)'
            );
        });

        it('passes --region with AWS_REGION', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(rendered.indexOf('create-inference-component'));
            assert.ok(
                addSection.includes('--region "${AWS_REGION}"'),
                'Must pass --region'
            );
        });
    });

    // ── Wait for InService ───────────────────────────────────────────────

    describe('Wait for adapter IC InService', () => {

        it('calls wait_ic with adapter IC name', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(rendered.indexOf('_adapter_add'));
            assert.ok(
                addSection.includes('wait_ic "${adapter_ic_name}"'),
                'Must call wait_ic with adapter IC name'
            );
        });
    });

    // ── Adapter conf file creation (Req 3.5) ─────────────────────────────

    describe('Adapter conf file creation', () => {

        it('creates do/adapters/<name>.conf file', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('${SCRIPT_DIR}/adapters/${adapter_name}.conf'),
                'Must create conf file at do/adapters/<name>.conf'
            );
        });

        it('creates adapters directory with mkdir -p', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('mkdir -p "${SCRIPT_DIR}/adapters"'),
                'Must create adapters directory if it does not exist'
            );
        });

        it('writes ADAPTER_NAME to conf file', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('export ADAPTER_NAME='),
                'Must write ADAPTER_NAME to conf'
            );
        });

        it('writes ADAPTER_IC_NAME to conf file', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('export ADAPTER_IC_NAME='),
                'Must write ADAPTER_IC_NAME to conf'
            );
        });

        it('writes ADAPTER_WEIGHTS_URI to conf file', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('export ADAPTER_WEIGHTS_URI='),
                'Must write ADAPTER_WEIGHTS_URI to conf'
            );
        });

        it('writes ADAPTER_CREATED_AT with UTC timestamp', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('export ADAPTER_CREATED_AT='),
                'Must write ADAPTER_CREATED_AT to conf'
            );
            assert.ok(
                rendered.includes('date -u +"%Y-%m-%dT%H:%M:%SZ"'),
                'Must use date -u for UTC ISO timestamp'
            );
        });
    });

    // ── Success output ───────────────────────────────────────────────────

    describe('Success output', () => {

        it('shows success message after adapter is added', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('Adapter added successfully'),
                'Must show success message'
            );
        });

        it('shows test command suggestion', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('./do/test ${adapter_name}'),
                'Must suggest test command with adapter name'
            );
        });

        it('shows remove command suggestion', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('./do/adapter remove ${adapter_name}'),
                'Must suggest remove command'
            );
        });
    });
});
