// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/clean endpoint adapter deletion ordering.
 *
 * Tests cover:
 * - do/clean endpoint deletes adapter ICs BEFORE base ICs
 * - Adapter deletion iterates do/adapters/*.conf
 * - Base IC deletion iterates do/ic/*.conf
 * - Ordering is correct in both external endpoint and owned endpoint paths
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 7.5
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLEAN_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/clean');
const CLEAN_TEMPLATE = readFileSync(CLEAN_TEMPLATE_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderClean(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        awsRegion: 'us-east-1',
        deploymentTarget: 'realtime-inference',
        enableLora: true,
        includeBenchmark: false,
        ...overrides
    };
    return ejs.render(CLEAN_TEMPLATE, vars);
}

/**
 * Extract the clean_endpoint() function body from the rendered template.
 */
function getCleanEndpointFunction(rendered) {
    const start = rendered.indexOf('clean_endpoint()');
    if (start === -1) return '';
    // Find the next top-level function definition to bound the search
    const nextFunc = rendered.indexOf('\nclean_ic()', start + 1);
    if (nextFunc === -1) return rendered.substring(start);
    return rendered.substring(start, nextFunc);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/clean endpoint ordering (Req 7.5)', () => {

    describe('clean_endpoint() deletes adapters before base ICs (owned endpoint)', () => {

        it('renders clean_endpoint function when deploymentTarget is realtime-inference', () => {
            const rendered = renderClean();
            assert.ok(
                rendered.includes('clean_endpoint()'),
                'Must define clean_endpoint() function'
            );
        });

        it('adapter deletion iterates do/adapters/*.conf', () => {
            const rendered = renderClean();
            const cleanFn = getCleanEndpointFunction(rendered);
            assert.ok(
                cleanFn.includes('adapters/*.conf'),
                'Must iterate do/adapters/*.conf for adapter deletion'
            );
        });

        it('base IC deletion iterates do/ic/*.conf', () => {
            const rendered = renderClean();
            const cleanFn = getCleanEndpointFunction(rendered);
            assert.ok(
                cleanFn.includes('/ic/*.conf'),
                'Must iterate do/ic/*.conf for base IC deletion'
            );
        });

        it('adapter deletion appears BEFORE base IC deletion in clean_endpoint', () => {
            const rendered = renderClean();
            const cleanFn = getCleanEndpointFunction(rendered);

            // Find the first adapter deletion reference (iterating adapters/*.conf)
            const adapterDeletionPos = cleanFn.indexOf('Deleting adapter');
            // Find the first base IC deletion reference (iterating ic/*.conf after adapters)
            const baseIcDeletionPos = cleanFn.indexOf('Deleting inference component');

            assert.ok(
                adapterDeletionPos > 0,
                'Must contain adapter deletion code'
            );
            assert.ok(
                baseIcDeletionPos > 0,
                'Must contain base IC deletion code'
            );
            assert.ok(
                adapterDeletionPos < baseIcDeletionPos,
                'Adapter deletion must appear BEFORE base IC deletion in clean_endpoint()'
            );
        });

        it('adapter deletion uses delete-inference-component before base IC deletion does', () => {
            const rendered = renderClean();
            const cleanFn = getCleanEndpointFunction(rendered);

            // Find the adapter section (starts with adapter loop)
            const adapterSectionStart = cleanFn.indexOf('LoRA adapter');
            const adapterDeleteCmd = cleanFn.indexOf('delete-inference-component', adapterSectionStart);

            // Find the base IC section (after adapter section completes)
            const baseIcSectionComment = cleanFn.indexOf('Delete inference components first');
            const baseIcDeleteCmd = cleanFn.indexOf('delete-inference-component', baseIcSectionComment);

            assert.ok(adapterDeleteCmd > 0, 'Adapter section must call delete-inference-component');
            assert.ok(baseIcDeleteCmd > 0, 'Base IC section must call delete-inference-component');
            assert.ok(
                adapterDeleteCmd < baseIcDeleteCmd,
                'Adapter delete-inference-component call must come before base IC delete-inference-component call'
            );
        });

        it('adapter deletion waits for completion before proceeding to base ICs', () => {
            const rendered = renderClean();
            const cleanFn = getCleanEndpointFunction(rendered);

            // The adapter section should wait for deletion
            const adapterSectionStart = cleanFn.indexOf('LoRA adapter');
            const adapterWait = cleanFn.indexOf('Waiting for adapter deletion', adapterSectionStart);
            const baseIcSection = cleanFn.indexOf('Delete inference components first');

            assert.ok(adapterWait > 0, 'Must wait for adapter deletion');
            assert.ok(baseIcSection > 0, 'Must have base IC deletion section');
            assert.ok(
                adapterWait < baseIcSection,
                'Adapter wait must complete before base IC deletion begins'
            );
        });

        it('includes comment explaining why adapters are deleted first', () => {
            const rendered = renderClean();
            const cleanFn = getCleanEndpointFunction(rendered);

            assert.ok(
                cleanFn.includes('adapters depend on base') ||
                cleanFn.includes('adapter') && cleanFn.includes('first'),
                'Must include comment explaining adapter-before-base ordering'
            );
        });
    });

    describe('clean_endpoint() deletes adapters before base ICs (external endpoint)', () => {

        it('external endpoint path also deletes adapters before base ICs', () => {
            const rendered = renderClean();
            const cleanFn = getCleanEndpointFunction(rendered);

            // The external endpoint section
            const externalSection = cleanFn.indexOf('Endpoint is external');
            assert.ok(externalSection > 0, 'Must have external endpoint handling');

            // In the external path, adapter deletion should come before IC deletion
            const externalAdapterDeletion = cleanFn.indexOf('adapters/*.conf', externalSection);
            const externalIcDeletion = cleanFn.indexOf('/ic/*.conf', externalSection);

            assert.ok(externalAdapterDeletion > 0, 'External path must iterate adapters/*.conf');
            assert.ok(externalIcDeletion > 0, 'External path must iterate ic/*.conf');
            assert.ok(
                externalAdapterDeletion < externalIcDeletion,
                'External path: adapter deletion must come before base IC deletion'
            );
        });
    });

    describe('clean_endpoint() without LoRA does not include adapter deletion', () => {

        it('no adapter deletion code when enableLora is false', () => {
            const rendered = renderClean({ enableLora: false });
            const cleanFn = getCleanEndpointFunction(rendered);

            assert.ok(
                !cleanFn.includes('adapters/*.conf'),
                'Must NOT include adapter deletion when LoRA is disabled'
            );
        });

        it('base IC deletion still works when enableLora is false', () => {
            const rendered = renderClean({ enableLora: false });
            const cleanFn = getCleanEndpointFunction(rendered);

            assert.ok(
                cleanFn.includes('/ic/*.conf'),
                'Must still iterate do/ic/*.conf for base IC deletion when LoRA is disabled'
            );
        });
    });
});
