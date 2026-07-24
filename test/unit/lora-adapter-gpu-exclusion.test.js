// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for adapter ICs excluded from GPU capacity calculations.
 *
 * Tests cover:
 * - do/status: TOTAL_GPU_USED only iterates do/ic/*.conf, not do/adapters/*.conf
 * - do/deploy: _check_gpu_capacity only iterates do/ic/*.conf, not do/adapters/*.conf
 * - Adapter section in do/status does NOT contribute to TOTAL_GPU_USED
 * - Capacity guardrail comment documents adapter exclusion
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 6.4
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

const DEPLOY_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/deploy.d/managed-inference');
const DEPLOY_TEMPLATE = readFileSync(DEPLOY_TEMPLATE_PATH, 'utf-8');

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

function renderDeploy(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.12xlarge',
        inferenceAmiVersion: undefined,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        ...overrides
    };
    return ejs.render(DEPLOY_TEMPLATE, vars, { filename: DEPLOY_TEMPLATE_PATH });
}

/**
 * Extract the GPU counting section from the status template output.
 * This is the section that iterates do/ic/*.conf and sums TOTAL_GPU_USED.
 */
function getGpuCountingSection(rendered) {
    const start = rendered.indexOf('# Describe Inference Components');
    if (start === -1) return '';
    const adapterStart = rendered.indexOf('# Describe LoRA Adapters');
    if (adapterStart === -1) return rendered.substring(start);
    return rendered.substring(start, adapterStart);
}

/**
 * Extract the _check_gpu_capacity function body from the deploy template output.
 */
function getCapacityGuardrailFunction(rendered) {
    const start = rendered.indexOf('_check_gpu_capacity()');
    if (start === -1) return '';
    const end = rendered.indexOf('# Run capacity guardrail before deploying ICs');
    if (end === -1) return rendered.substring(start);
    return rendered.substring(start, end);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — Adapter ICs excluded from GPU capacity (Req 6.4)', () => {

    // ── do/status: GPU counting only uses do/ic/*.conf ───────────────────

    describe('do/status: TOTAL_GPU_USED excludes adapter ICs', () => {

        it('GPU counting loop iterates only do/ic/*.conf files', () => {
            const rendered = renderStatus({ enableLora: true });
            const gpuSection = getGpuCountingSection(rendered);

            // The GPU counting section must iterate do/ic/*.conf
            assert.ok(
                gpuSection.includes('"${SCRIPT_DIR}"/ic/*.conf'),
                'GPU counting must iterate do/ic/*.conf files'
            );
        });

        it('GPU counting loop does NOT iterate do/adapters/*.conf files', () => {
            const rendered = renderStatus({ enableLora: true });
            const gpuSection = getGpuCountingSection(rendered);

            // The for loop in the GPU counting section must NOT target adapters directory
            const forLoops = gpuSection.match(/for conf in [^\n]+/g) || [];
            for (const loop of forLoops) {
                assert.ok(
                    !loop.includes('adapters'),
                    'GPU counting for-loop must NOT iterate do/adapters/ directory'
                );
            }
        });

        it('TOTAL_GPU_USED is only incremented in the base IC loop', () => {
            const rendered = renderStatus({ enableLora: true });
            const gpuSection = getGpuCountingSection(rendered);

            // TOTAL_GPU_USED should be incremented in the IC section
            assert.ok(
                gpuSection.includes('TOTAL_GPU_USED=$('),
                'TOTAL_GPU_USED must be incremented in the base IC section'
            );

            // The adapter section should NOT modify TOTAL_GPU_USED
            const adapterStart = rendered.indexOf('# Describe LoRA Adapters');
            if (adapterStart !== -1) {
                const adapterSection = rendered.substring(adapterStart);
                assert.ok(
                    !adapterSection.includes('TOTAL_GPU_USED'),
                    'Adapter section must NOT modify TOTAL_GPU_USED'
                );
            }
        });

        it('includes a comment explaining why adapters are excluded from GPU count', () => {
            const rendered = renderStatus({ enableLora: true });
            const gpuSection = getGpuCountingSection(rendered);

            assert.ok(
                gpuSection.includes('Adapter') || gpuSection.includes('adapter'),
                'GPU counting section must include a comment about adapter exclusion'
            );
        });

        it('adapter section does not contain NumberOfAcceleratorDevicesRequired', () => {
            const rendered = renderStatus({ enableLora: true });
            const adapterStart = rendered.indexOf('# Describe LoRA Adapters');
            if (adapterStart !== -1) {
                const adapterSection = rendered.substring(adapterStart);
                assert.ok(
                    !adapterSection.includes('NumberOfAcceleratorDevicesRequired'),
                    'Adapter section must NOT reference NumberOfAcceleratorDevicesRequired (adapters have no GPU allocation)'
                );
            }
        });
    });

    // ── do/deploy: capacity guardrail only uses do/ic/*.conf ─────────────

    describe('do/deploy: _check_gpu_capacity excludes adapter ICs', () => {

        it('capacity guardrail iterates only do/ic/*.conf files', () => {
            const rendered = renderDeploy();
            const guardrail = getCapacityGuardrailFunction(rendered);

            assert.ok(
                guardrail.includes('"${SCRIPT_DIR}"/ic/*.conf'),
                'Capacity guardrail must iterate do/ic/*.conf files'
            );
        });

        it('capacity guardrail does NOT iterate do/adapters/*.conf files', () => {
            const rendered = renderDeploy();
            const guardrail = getCapacityGuardrailFunction(rendered);

            // The for loop in the guardrail must NOT target adapters directory
            const forLoops = guardrail.match(/for conf in [^\n]+/g) || [];
            for (const loop of forLoops) {
                assert.ok(
                    !loop.includes('adapters'),
                    'Capacity guardrail for-loop must NOT iterate do/adapters/ directory'
                );
            }
        });

        it('capacity guardrail includes comment explaining adapter exclusion', () => {
            const rendered = renderDeploy();
            const guardrail = getCapacityGuardrailFunction(rendered);

            assert.ok(
                guardrail.includes('Adapter') || guardrail.includes('adapter'),
                'Capacity guardrail must include a comment about adapter exclusion'
            );
        });

        it('capacity guardrail only sums IC_GPU_COUNT from base IC confs', () => {
            const rendered = renderDeploy();
            const guardrail = getCapacityGuardrailFunction(rendered);

            // Must read IC_GPU_COUNT
            assert.ok(
                guardrail.includes('IC_GPU_COUNT'),
                'Capacity guardrail must read IC_GPU_COUNT from conf files'
            );

            // The for loop must only target ic/*.conf
            const forLoopMatch = guardrail.match(/for conf in .+\.conf/);
            assert.ok(forLoopMatch, 'Must have a for loop iterating conf files');
            assert.ok(
                forLoopMatch[0].includes('/ic/'),
                'For loop must target /ic/ directory specifically'
            );
            assert.ok(
                !forLoopMatch[0].includes('/adapters/'),
                'For loop must NOT target /adapters/ directory'
            );
        });
    });

    // ── Structural separation ────────────────────────────────────────────

    describe('Structural separation: adapters in do/adapters/, not do/ic/', () => {

        it('status template adapter section is separate from IC section', () => {
            const rendered = renderStatus({ enableLora: true });

            const icSectionStart = rendered.indexOf('# Describe Inference Components');
            const adapterSectionStart = rendered.indexOf('# Describe LoRA Adapters');

            assert.ok(icSectionStart !== -1, 'IC section must exist');
            assert.ok(adapterSectionStart !== -1, 'Adapter section must exist');
            assert.ok(
                adapterSectionStart > icSectionStart,
                'Adapter section must come after IC section'
            );
        });

        it('GPU total is printed before adapter section', () => {
            const rendered = renderStatus({ enableLora: true });

            const gpuTotalIndex = rendered.indexOf('Total GPU usage:');
            const adapterSectionStart = rendered.indexOf('# Describe LoRA Adapters');

            assert.ok(gpuTotalIndex !== -1, 'GPU total line must exist');
            assert.ok(adapterSectionStart !== -1, 'Adapter section must exist');
            assert.ok(
                gpuTotalIndex < adapterSectionStart,
                'GPU total must be printed before adapter section (adapters not counted)'
            );
        });
    });
});
