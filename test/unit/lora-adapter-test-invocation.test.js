// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/test adapter invocation support.
 *
 * Tests cover:
 * - Adapter name resolution: checks do/adapters/<name>.conf first
 * - Sources ADAPTER_IC_NAME from adapter conf
 * - Precedence: do/adapters/ → do/ic/ → legacy config
 * - No change to request payload format (LoRA is transparent)
 * - Error when adapter conf is missing ADAPTER_IC_NAME
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 5.1, 5.2, 5.3
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/test');
const TEST_TEMPLATE = readFileSync(TEST_TEMPLATE_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderTest(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g6e.48xlarge',
        awsRegion: 'us-east-1',
        framework: 'transformers',
        modelServer: 'vllm',
        modelName: 'meta-llama/Llama-3.1-8B-Instruct',
        buildTarget: 'codebuild',
        ...overrides
    };
    return ejs.render(TEST_TEMPLATE, vars);
}

function getIcResolutionSection(rendered) {
    const start = rendered.indexOf('# Resolve inference component name');
    const end = rendered.indexOf('INVOKE_ARGS=(');
    return rendered.substring(start, end);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/test adapter invocation (Req 5.1, 5.2, 5.3)', () => {

    // ── Adapter precedence (Req 5.1) ─────────────────────────────────────

    describe('Adapter name resolution precedence', () => {

        it('checks do/adapters/<name>.conf before do/ic/<name>.conf', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);

            const adapterCheckPos = section.indexOf('adapters/${IC_ARG}.conf');
            const icCheckPos = section.indexOf('ic/${IC_ARG}.conf');

            assert.ok(adapterCheckPos > 0, 'Must check adapters/<name>.conf');
            assert.ok(icCheckPos > 0, 'Must check ic/<name>.conf');
            assert.ok(
                adapterCheckPos < icCheckPos,
                'Adapter check must come before IC check (precedence: adapters → ic → legacy)'
            );
        });

        it('documents precedence order in comment', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            assert.ok(
                section.includes('Precedence: do/adapters/') &&
                section.includes('do/ic/') &&
                section.includes('legacy config'),
                'Must document precedence order in comment'
            );
        });

        it('falls through to do/ic/ when adapter conf does not exist', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);

            // The elif branch for IC should be after the adapter check
            assert.ok(
                section.includes('elif [ -n "${IC_ARG}" ]'),
                'Must have elif branch for IC lookup when adapter not found'
            );
        });

        it('falls through to legacy INFERENCE_COMPONENT_NAME when no do/ic/ directory', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            assert.ok(
                section.includes('INFERENCE_COMPONENT_NAME'),
                'Must fall back to INFERENCE_COMPONENT_NAME for legacy path'
            );
        });
    });

    // ── Adapter IC name sourcing (Req 5.1) ───────────────────────────────

    describe('Adapter IC name sourcing', () => {

        it('sources adapter conf file to get ADAPTER_IC_NAME', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            assert.ok(
                section.includes('source "${SCRIPT_DIR}/adapters/${IC_ARG}.conf"'),
                'Must source do/adapters/<name>.conf'
            );
        });

        it('reads ADAPTER_IC_NAME from adapter conf', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            assert.ok(
                section.includes('ADAPTER_IC_NAME'),
                'Must reference ADAPTER_IC_NAME variable'
            );
        });

        it('uses ADAPTER_IC_NAME as IC_NAME for invoke-endpoint', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            assert.ok(
                section.includes('IC_NAME="${ADAPTER_IC_NAME}"'),
                'Must assign ADAPTER_IC_NAME to IC_NAME'
            );
        });

        it('errors when ADAPTER_IC_NAME is empty in conf', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            assert.ok(
                section.includes('-z "${ADAPTER_IC_NAME}"'),
                'Must check for empty ADAPTER_IC_NAME'
            );
            assert.ok(
                section.includes('missing ADAPTER_IC_NAME'),
                'Must show error about missing ADAPTER_IC_NAME'
            );
        });
    });

    // ── Transparent payload (Req 5.3) ────────────────────────────────────

    describe('Transparent payload format', () => {

        it('uses same invoke-endpoint command regardless of adapter or base IC', () => {
            const rendered = renderTest();
            // The invoke-endpoint call should be the same — only IC_NAME changes
            assert.ok(
                rendered.includes('--inference-component-name "${IC_NAME}"'),
                'Must use IC_NAME variable (same for adapter and base IC)'
            );
        });

        it('does not modify payload format for adapter invocations', () => {
            const rendered = renderTest();
            // The payload construction should be before IC resolution
            // and should not reference adapters
            const payloadSection = rendered.substring(
                rendered.indexOf('TEST_PAYLOAD='),
                rendered.indexOf('Invoking SageMaker endpoint')
            );
            assert.ok(
                !payloadSection.includes('adapter'),
                'Payload construction must not reference adapters (LoRA is transparent)'
            );
        });
    });

    // ── Base IC unchanged behavior (Req 5.2) ─────────────────────────────

    describe('Base IC unchanged behavior (no adapter argument)', () => {

        it('uses first IC from do/ic/ when no argument provided', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            assert.ok(
                section.includes('/ic/*.conf'),
                'Must iterate do/ic/*.conf when no argument provided'
            );
        });

        it('does not check adapters when no argument provided', () => {
            const rendered = renderTest();
            const section = getIcResolutionSection(rendered);
            // The adapter check is gated by [ -n "${IC_ARG}" ]
            assert.ok(
                section.includes('[ -n "${IC_ARG}" ] && [ -f "${SCRIPT_DIR}/adapters/${IC_ARG}.conf"'),
                'Adapter check must be gated by IC_ARG being non-empty'
            );
        });
    });
});
