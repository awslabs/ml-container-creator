// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/config Override Pattern Format Property-Based Tests
 *
 * Property 6: For any env var rendered in the do/config runtime section,
 * the export statement SHALL use the pattern `export <KEY>=${<KEY>:-<catalog_value>}`,
 * ensuring users can override any catalog-sourced value by setting the variable
 * before sourcing do/config.
 *
 * Feature: registry-to-server-migration, Property 6: do/config override pattern format
 * Validates: Requirements 8.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── EJS template snippet (from templates/do/config) ───────────

const DO_CONFIG_ENV_SNIPPET = [
    '<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>',
    '# Runtime environment variables (from catalog)',
    '<% orderedEnvVars.forEach(({ key, value }) => { %>',
    'export <%= key %>=${<%= key %>:-<%= value %>}',
    '<% }); %>',
    '<% } %>'
].join('\n');

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1);
const arbEnvValue = fc.stringMatching(/^[a-zA-Z0-9._/-]{0,30}$/);

const arbEnvVarEntry = fc.record({
    key: arbEnvKey,
    value: arbEnvValue
});

const arbNonEmptyOrderedEnvVars = fc.array(arbEnvVarEntry, { minLength: 1, maxLength: 10 });

// ── Regex for the override pattern ───────────────────────────────────────────
// Matches: export <KEY>=${<KEY>:-<value>}
const OVERRIDE_PATTERN = /^export ([A-Z][A-Z0-9_]*)=\$\{([A-Z][A-Z0-9_]*):-(.*)}\s*$/;

// ── Helper functions ─────────────────────────────────────────────────────────

function renderDoConfigSnippet(orderedEnvVars) {
    return ejs.render(DO_CONFIG_ENV_SNIPPET, { orderedEnvVars });
}

function getExportLines(rendered) {
    return rendered.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('export '));
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 6: do/config override pattern format', () => {

    describe('each export line matches the override pattern export <KEY>=${<KEY>:-<value>}', () => {

        it('for any env var entry, the rendered line matches the exact override pattern', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDoConfigSnippet(orderedEnvVars);
                    const exportLines = getExportLines(rendered);

                    assert.strictEqual(exportLines.length, orderedEnvVars.length,
                        `expected ${orderedEnvVars.length} export lines, got ${exportLines.length}`);

                    for (const line of exportLines) {
                        const match = line.match(OVERRIDE_PATTERN);
                        assert.ok(match,
                            `export line must match pattern "export <KEY>=\${<KEY>:-<value>}", got: "${line}"`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('the KEY appears twice in each export line (export name and ${} default syntax)', () => {

        it('for any env var entry, the key in the export name matches the key in the default syntax', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDoConfigSnippet(orderedEnvVars);
                    const exportLines = getExportLines(rendered);

                    for (let i = 0; i < exportLines.length; i++) {
                        const match = exportLines[i].match(OVERRIDE_PATTERN);
                        assert.ok(match,
                            `line ${i} must match override pattern, got: "${exportLines[i]}"`);

                        const exportKey = match[1];
                        const defaultKey = match[2];

                        assert.strictEqual(exportKey, defaultKey,
                            'KEY must appear identically in both positions: ' +
                            `export name="${exportKey}" vs default syntax="${defaultKey}"`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('the value in the default syntax matches the original input value', () => {

        it('for any env var entry, the rendered default value matches the original value', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDoConfigSnippet(orderedEnvVars);
                    const exportLines = getExportLines(rendered);

                    assert.strictEqual(exportLines.length, orderedEnvVars.length,
                        `expected ${orderedEnvVars.length} export lines, got ${exportLines.length}`);

                    for (let i = 0; i < exportLines.length; i++) {
                        const match = exportLines[i].match(OVERRIDE_PATTERN);
                        assert.ok(match,
                            `line ${i} must match override pattern, got: "${exportLines[i]}"`);

                        const renderedKey = match[1];
                        const renderedValue = match[3];
                        const original = orderedEnvVars[i];

                        assert.strictEqual(renderedKey, original.key,
                            `rendered key "${renderedKey}" must match input key "${original.key}"`);
                        assert.strictEqual(renderedValue, original.value,
                            `rendered value "${renderedValue}" must match input value "${original.value}" ` +
                            `for key "${original.key}"`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('the override pattern enables user overrides', () => {

        it('for any single env var, the pattern uses bash default-value syntax ${VAR:-default}', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvKey,
                arbEnvValue,
                (key, value) => {
                    const rendered = renderDoConfigSnippet([{ key, value }]);
                    const exportLines = getExportLines(rendered);

                    assert.strictEqual(exportLines.length, 1,
                        'single env var must produce exactly one export line');

                    const expectedLine = `export ${key}=\${${key}:-${value}}`;
                    assert.strictEqual(exportLines[0], expectedLine,
                        `expected "${expectedLine}", got "${exportLines[0]}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
