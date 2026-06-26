// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/adapter list subcommand.
 *
 * Tests cover:
 * - Calls ListInferenceComponents with EndpointNameEquals
 * - Filters ICs to only those with BaseInferenceComponentName (adapters)
 * - Calls DescribeInferenceComponent for each IC to get details
 * - Displays table with NAME, SOURCE, STATUS columns
 * - Checks local do/adapters/*.conf for ownership (marks others as "external")
 * - Handles empty endpoint (no adapters found)
 * - Uses json.loads for JSON parsing (Python heredoc implementation)
 * - Strips project prefix from adapter IC names for display
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 2.3
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

function getListSection(rendered) {
    const start = rendered.indexOf('_adapter_list()');
    const end = rendered.indexOf('\n_adapter_remove(');
    return rendered.substring(start, end);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/adapter list (Req 2.3)', () => {

    // ── ListInferenceComponents API call ─────────────────────────────────

    describe('ListInferenceComponents API call', () => {

        it('calls aws sagemaker list-inference-components', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('list-inference-components'),
                'Must call list-inference-components'
            );
        });

        it('passes --endpoint-name-equals with ENDPOINT_NAME', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('--endpoint-name-equals'),
                'Must filter by endpoint name using --endpoint-name-equals'
            );
        });

        it('passes --region with AWS_REGION', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('--region'),
                'Must pass --region flag'
            );
        });
    });

    // ── DescribeInferenceComponent for details ───────────────────────────

    describe('DescribeInferenceComponent for adapter details', () => {

        it('calls aws sagemaker describe-inference-component for each IC', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('describe-inference-component'),
                'Must call describe-inference-component for each IC'
            );
        });

        it('passes --inference-component-name for each IC', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('--inference-component-name'),
                'Must pass --inference-component-name'
            );
        });
    });

    // ── Filtering adapter ICs ────────────────────────────────────────────

    describe('Filtering adapter ICs by BaseInferenceComponentName', () => {

        it('checks for BaseInferenceComponentName in describe output', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('BaseInferenceComponentName'),
                'Must check for BaseInferenceComponentName to identify adapters'
            );
        });

        it('skips ICs without BaseInferenceComponentName (base ICs)', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            // Python implementation uses "if not base_ic: continue"
            assert.ok(
                listSection.includes('not base_ic') ||
                listSection.includes('continue'),
                'Must skip ICs that are not adapters'
            );
        });
    });

    // ── Table output format ──────────────────────────────────────────────

    describe('Table output format', () => {

        it('displays header with NAME, SOURCE, STATUS columns', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('NAME') &&
                listSection.includes('STATUS') &&
                listSection.includes('SOURCE'),
                'Must display table header with NAME, SOURCE, STATUS'
            );
        });

        it('shows endpoint name in output header', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('Adapters on endpoint:'),
                'Must show endpoint name in output'
            );
        });

        it('uses format strings for column alignment', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('fmt') ||
                listSection.includes('format'),
                'Must use format strings for table alignment'
            );
        });
    });

    // ── Adapter status and source extraction ────────────────────────────

    describe('Adapter status and source extraction', () => {

        it('extracts InferenceComponentStatus from describe output', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('InferenceComponentStatus'),
                'Must extract InferenceComponentStatus'
            );
        });

        it('extracts ADAPTER_SOURCE from conf files for source column', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('ADAPTER_SOURCE'),
                'Must extract ADAPTER_SOURCE from conf for source column'
            );
        });

        it('uses json.loads for JSON parsing', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('json.loads'),
                'Must use json.loads for JSON parsing'
            );
        });
    });

    // ── Ownership check (local vs external) ──────────────────────────────

    describe('Ownership check via local do/adapters/*.conf', () => {

        it('checks do/adapters/*.conf files for local adapter ownership', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('*.conf') ||
                listSection.includes('adapters'),
                'Must check local do/adapters/*.conf for ownership'
            );
        });

        it('reads ADAPTER_IC_NAME from conf files', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('ADAPTER_IC_NAME'),
                'Must read ADAPTER_IC_NAME from conf files'
            );
        });

        it('marks non-local adapters as external', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('external'),
                'Must mark non-local adapters as external'
            );
        });
    });

    // ── Display name derivation ──────────────────────────────────────────

    describe('Display name derivation', () => {

        it('strips PROJECT_NAME-adapter- prefix for display', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('{project_name}-adapter-') ||
                listSection.includes('project_name}-adapter-'),
                'Must strip project prefix from adapter IC name for display'
            );
        });
    });

    // ── Empty state handling ─────────────────────────────────────────────

    describe('Empty state handling', () => {

        it('shows helpful message when no adapters found', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('No adapters found'),
                'Must show message when no adapters are found'
            );
        });

        it('suggests add command when no adapters found', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('./do/adapter add'),
                'Must suggest add command when no adapters found'
            );
        });
    });

    // ── Error handling ───────────────────────────────────────────────────

    describe('Error handling', () => {

        it('handles missing ENDPOINT_NAME', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('ENDPOINT_NAME') &&
                (listSection.includes('No endpoint configured') ||
                 listSection.includes('not deployed')),
                'Must handle missing ENDPOINT_NAME gracefully'
            );
        });

        it('handles ListInferenceComponents API failure', () => {
            const rendered = renderAdapter();
            const listSection = getListSection(rendered);
            assert.ok(
                listSection.includes('Could not query endpoint'),
                'Must handle API failure with error message'
            );
        });
    });
});
