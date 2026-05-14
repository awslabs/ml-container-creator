// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/status adapter section.
 *
 * Tests cover:
 * - Adapter section rendered when enableLora=true
 * - Adapter section NOT rendered when enableLora=false or undefined
 * - Adapter section gated by ENABLE_LORA=true runtime check
 * - Calls list-inference-components with endpoint name
 * - Calls describe-inference-component for each IC
 * - Checks BaseInferenceComponentName to identify adapter ICs
 * - Displays table with NAME, STATUS, WEIGHTS columns
 * - Strips PROJECT_NAME-adapter- prefix from IC names for display
 * - Shows "No adapters deployed" when none found
 * - Uses jq for JSON parsing
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 6.3
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATUS_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/status');
const STATUS_TEMPLATE = readFileSync(STATUS_TEMPLATE_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderStatus(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        awsRegion: 'us-east-1',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.12xlarge',
        framework: 'transformers',
        modelServer: 'vllm',
        enableLora: true,
        maxLoras: 30,
        ...overrides
    };
    return ejs.render(STATUS_TEMPLATE, vars);
}

function getAdapterSection(rendered) {
    const start = rendered.indexOf('# Describe LoRA Adapters');
    if (start === -1) return '';
    return rendered.substring(start);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/status adapter section (Req 6.3)', () => {

    // ── EJS conditional rendering ────────────────────────────────────────

    describe('EJS conditional rendering', () => {

        it('includes adapter section when enableLora=true', () => {
            const rendered = renderStatus({ enableLora: true });
            assert.ok(
                rendered.includes('Describe LoRA Adapters') ||
                rendered.includes('Adapters (LoRA)'),
                'Must include adapter section when enableLora=true'
            );
        });

        it('excludes adapter section when enableLora=false', () => {
            const rendered = renderStatus({ enableLora: false });
            assert.ok(
                !rendered.includes('Describe LoRA Adapters') &&
                !rendered.includes('Adapters (LoRA)'),
                'Must NOT include adapter section when enableLora=false'
            );
        });

        it('excludes adapter section when enableLora is undefined', () => {
            const rendered = renderStatus({ enableLora: undefined });
            assert.ok(
                !rendered.includes('Describe LoRA Adapters') &&
                !rendered.includes('Adapters (LoRA)'),
                'Must NOT include adapter section when enableLora is undefined'
            );
        });
    });

    // ── Runtime ENABLE_LORA check ────────────────────────────────────────

    describe('Runtime ENABLE_LORA check', () => {

        it('checks ENABLE_LORA=true from config at runtime', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('ENABLE_LORA') &&
                section.includes('"true"'),
                'Must check ENABLE_LORA=true at runtime'
            );
        });
    });

    // ── ListInferenceComponents API call ─────────────────────────────────

    describe('ListInferenceComponents API call', () => {

        it('calls aws sagemaker list-inference-components', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('aws sagemaker list-inference-components'),
                'Must call list-inference-components'
            );
        });

        it('filters by endpoint name using --endpoint-name-equals', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('--endpoint-name-equals "${ENDPOINT_NAME}"'),
                'Must filter by endpoint name'
            );
        });

        it('passes --region flag', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('--region "${AWS_REGION}"'),
                'Must pass --region flag'
            );
        });
    });

    // ── DescribeInferenceComponent for each IC ───────────────────────────

    describe('DescribeInferenceComponent for each IC', () => {

        it('calls describe-inference-component for each IC', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('aws sagemaker describe-inference-component'),
                'Must call describe-inference-component for each IC'
            );
        });

        it('passes --inference-component-name', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('--inference-component-name'),
                'Must pass --inference-component-name'
            );
        });
    });

    // ── Filtering adapter ICs ────────────────────────────────────────────

    describe('Filtering adapter ICs by BaseInferenceComponentName', () => {

        it('checks for BaseInferenceComponentName in describe output', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('BaseInferenceComponentName'),
                'Must check for BaseInferenceComponentName to identify adapters'
            );
        });

        it('skips ICs without BaseInferenceComponentName (base ICs)', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('-z "${base_ic}"') ||
                section.includes('empty'),
                'Must skip ICs that are not adapters'
            );
        });
    });

    // ── Table output format ──────────────────────────────────────────────

    describe('Table output format', () => {

        it('displays header with NAME, STATUS, WEIGHTS columns', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('NAME') &&
                section.includes('STATUS') &&
                section.includes('WEIGHTS'),
                'Must display table header with NAME, STATUS, WEIGHTS'
            );
        });

        it('uses printf for column alignment', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('printf'),
                'Must use printf for table alignment'
            );
        });

        it('displays "Adapters (LoRA):" section header', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('Adapters (LoRA)'),
                'Must display "Adapters (LoRA):" section header'
            );
        });
    });

    // ── Display name derivation ──────────────────────────────────────────

    describe('Display name derivation', () => {

        it('strips PROJECT_NAME-adapter- prefix from IC names for display', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('${PROJECT_NAME}-adapter-') ||
                section.includes('PROJECT_NAME}-adapter-'),
                'Must strip project prefix from adapter IC name for display'
            );
        });
    });

    // ── Empty state handling ─────────────────────────────────────────────

    describe('Empty state handling', () => {

        it('shows "No adapters deployed" when no adapters found', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('No adapters deployed'),
                'Must show "No adapters deployed" when none found'
            );
        });
    });

    // ── JSON parsing ─────────────────────────────────────────────────────

    describe('JSON parsing', () => {

        it('uses jq for JSON parsing', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('jq'),
                'Must use jq for JSON parsing'
            );
        });

        it('extracts InferenceComponentStatus via jq', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('InferenceComponentStatus'),
                'Must extract InferenceComponentStatus'
            );
        });

        it('extracts Container.ArtifactUrl via jq', () => {
            const rendered = renderStatus({ enableLora: true });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('ArtifactUrl'),
                'Must extract ArtifactUrl for weights display'
            );
        });
    });

    // ── maxLoras display ─────────────────────────────────────────────────

    describe('maxLoras display', () => {

        it('displays maxLoras value in section header', () => {
            const rendered = renderStatus({ enableLora: true, maxLoras: 30 });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('30'),
                'Must display maxLoras value (30) in section header'
            );
        });

        it('uses custom maxLoras value when overridden', () => {
            const rendered = renderStatus({ enableLora: true, maxLoras: 50 });
            const section = getAdapterSection(rendered);
            assert.ok(
                section.includes('50'),
                'Must display custom maxLoras value (50) in section header'
            );
        });
    });
});
