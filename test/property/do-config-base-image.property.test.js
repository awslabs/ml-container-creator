// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/config BASE_IMAGE Export Property-Based Tests
 *
 * Property 7: For any non-empty baseImage template variable, the do/config
 * template SHALL render `export BASE_IMAGE=${BASE_IMAGE:-<value>}`. When
 * baseImage is empty or unset, the template SHALL NOT render a BASE_IMAGE export.
 *
 * Feature: registry-to-server-migration, Property 7: do/config BASE_IMAGE export
 * Validates: Requirements 8.6, 8.7
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── EJS template snippet (from generators/app/templates/do/config) ───────────

const BASE_IMAGE_SNIPPET = [
    '<% if (baseImage) { %>',
    'export BASE_IMAGE=${BASE_IMAGE:-<%= baseImage %>}',
    '<% } %>'
].join('\n');

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Non-empty base image strings resembling real Docker image references
const arbNonEmptyBaseImage = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,80}$/)
    .filter(s => s.length >= 1);

// Falsy baseImage values that should NOT produce a BASE_IMAGE export
const arbFalsyBaseImage = fc.oneof(
    fc.constant(''),
    fc.constant(undefined),
    fc.constant(null)
);

// ── Regex for the BASE_IMAGE export pattern ──────────────────────────────────
const BASE_IMAGE_PATTERN = /^export BASE_IMAGE=\$\{BASE_IMAGE:-(.+)}\s*$/;

// ── Helper functions ─────────────────────────────────────────────────────────

function renderBaseImageSnippet(baseImage) {
    return ejs.render(BASE_IMAGE_SNIPPET, { baseImage });
}

function getExportLines(rendered) {
    return rendered.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('export '));
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 7: do/config BASE_IMAGE export', () => {

    describe('non-empty baseImage renders the BASE_IMAGE export', () => {

        it('for any non-empty baseImage, the template renders exactly one export line', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyBaseImage,
                (baseImage) => {
                    const rendered = renderBaseImageSnippet(baseImage);
                    const exportLines = getExportLines(rendered);

                    assert.strictEqual(exportLines.length, 1,
                        `expected exactly 1 export line for baseImage="${baseImage}", got ${exportLines.length}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty baseImage, the export uses the override pattern ${BASE_IMAGE:-<value>}', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyBaseImage,
                (baseImage) => {
                    const rendered = renderBaseImageSnippet(baseImage);
                    const exportLines = getExportLines(rendered);

                    assert.strictEqual(exportLines.length, 1);
                    const match = exportLines[0].match(BASE_IMAGE_PATTERN);
                    assert.ok(match,
                        'export line must match pattern "export BASE_IMAGE=${BASE_IMAGE:-<value>}", ' +
                        `got: "${exportLines[0]}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty baseImage, the rendered value matches the input', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyBaseImage,
                (baseImage) => {
                    const rendered = renderBaseImageSnippet(baseImage);
                    const exportLines = getExportLines(rendered);
                    const match = exportLines[0].match(BASE_IMAGE_PATTERN);

                    assert.ok(match, 'export line must match the override pattern');
                    assert.strictEqual(match[1], baseImage,
                        `rendered value "${match[1]}" must match input baseImage "${baseImage}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty baseImage, the full line matches the expected format exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyBaseImage,
                (baseImage) => {
                    const rendered = renderBaseImageSnippet(baseImage);
                    const exportLines = getExportLines(rendered);
                    const expectedLine = `export BASE_IMAGE=\${BASE_IMAGE:-${baseImage}}`;

                    assert.strictEqual(exportLines[0], expectedLine,
                        `expected "${expectedLine}", got "${exportLines[0]}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('empty/undefined/null baseImage renders no BASE_IMAGE export', () => {

        it('for any falsy baseImage, the template renders no export lines', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbFalsyBaseImage,
                (baseImage) => {
                    const rendered = renderBaseImageSnippet(baseImage);
                    const trimmed = rendered.trim();

                    assert.strictEqual(trimmed, '',
                        `expected empty output for baseImage=${JSON.stringify(baseImage)}, ` +
                        `got: "${trimmed}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for empty string baseImage, no BASE_IMAGE text appears in output', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = renderBaseImageSnippet('');
            assert.ok(!rendered.includes('BASE_IMAGE'),
                `output must not contain "BASE_IMAGE" for empty baseImage, got: "${rendered.trim()}"`);
        });

        it('for undefined baseImage, no BASE_IMAGE text appears in output', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = renderBaseImageSnippet(undefined);
            assert.ok(!rendered.includes('BASE_IMAGE'),
                `output must not contain "BASE_IMAGE" for undefined baseImage, got: "${rendered.trim()}"`);
        });

        it('for null baseImage, no BASE_IMAGE text appears in output', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = renderBaseImageSnippet(null);
            assert.ok(!rendered.includes('BASE_IMAGE'),
                `output must not contain "BASE_IMAGE" for null baseImage, got: "${rendered.trim()}"`);
        });
    });

    describe('conditional rendering is consistent', () => {

        it('for any baseImage (truthy or falsy), rendering is deterministic', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.oneof(arbNonEmptyBaseImage, arbFalsyBaseImage),
                (baseImage) => {
                    const rendered1 = renderBaseImageSnippet(baseImage);
                    const rendered2 = renderBaseImageSnippet(baseImage);

                    assert.strictEqual(rendered1, rendered2,
                        'rendering the same baseImage twice must produce identical output');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('truthy baseImage always produces output, falsy never does', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.oneof(
                    arbNonEmptyBaseImage.map(v => ({ value: v, truthy: true })),
                    arbFalsyBaseImage.map(v => ({ value: v, truthy: false }))
                ),
                ({ value, truthy }) => {
                    const rendered = renderBaseImageSnippet(value);
                    const hasExport = rendered.includes('export BASE_IMAGE');

                    if (truthy) {
                        assert.ok(hasExport,
                            `truthy baseImage="${value}" must produce BASE_IMAGE export`);
                    } else {
                        assert.ok(!hasExport,
                            `falsy baseImage=${JSON.stringify(value)} must NOT produce BASE_IMAGE export`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
