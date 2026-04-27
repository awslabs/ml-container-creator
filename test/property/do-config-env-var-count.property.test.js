// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/config Env Var Count in Summary Property-Based Tests
 *
 * Property 13: For any non-empty set of runtime env vars, the do/config
 * configuration summary echo block SHALL include a line reporting the count
 * of runtime env vars, and that count SHALL equal the number of env vars
 * actually exported.
 *
 * Feature: registry-to-server-migration, Property 13: do/config env var count in summary
 * Validates: Requirements 8.5
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── EJS template snippets (from generators/app/templates/do/config) ──────────

const DO_CONFIG_ENV_EXPORT_SNIPPET = [
    '<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>',
    '# Runtime environment variables (from catalog)',
    '<% orderedEnvVars.forEach(({ key, value }) => { %>',
    'export <%= key %>=${<%= key %>:-<%= value %>}',
    '<% }); %>',
    '<% } %>'
].join('\n');

const DO_CONFIG_SUMMARY_SNIPPET = [
    '<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>',
    'echo "   Runtime env vars: <%= orderedEnvVars.length %>"',
    '<% } %>'
].join('\n');

// Combined template to test both sections together
const DO_CONFIG_COMBINED_SNIPPET = [
    DO_CONFIG_ENV_EXPORT_SNIPPET,
    '',
    'echo "⚙️  Configuration loaded"',
    DO_CONFIG_SUMMARY_SNIPPET
].join('\n');

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1);
const arbEnvValue = fc.stringMatching(/^[a-zA-Z0-9._/-]{0,30}$/);

const arbEnvVarEntry = fc.record({
    key: arbEnvKey,
    value: arbEnvValue
});

const arbNonEmptyOrderedEnvVars = fc.array(arbEnvVarEntry, { minLength: 1, maxLength: 15 });
const arbOrderedEnvVars = fc.array(arbEnvVarEntry, { minLength: 0, maxLength: 15 });

// ── Regex for the summary count line ─────────────────────────────────────────
const SUMMARY_COUNT_PATTERN = /echo\s+" {3}Runtime env vars: (\d+)"/;

// ── Helper functions ─────────────────────────────────────────────────────────

function renderCombinedSnippet(orderedEnvVars) {
    return ejs.render(DO_CONFIG_COMBINED_SNIPPET, { orderedEnvVars });
}

function renderSummarySnippet(orderedEnvVars) {
    return ejs.render(DO_CONFIG_SUMMARY_SNIPPET, { orderedEnvVars });
}

function renderExportSnippet(orderedEnvVars) {
    return ejs.render(DO_CONFIG_ENV_EXPORT_SNIPPET, { orderedEnvVars });
}

function getExportLines(rendered) {
    return rendered.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('export '));
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 13: do/config env var count in summary', () => {

    describe('non-empty orderedEnvVars includes count in summary', () => {

        it('for any non-empty orderedEnvVars, the summary contains the Runtime env vars line', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderSummarySnippet(orderedEnvVars);
                    assert.ok(rendered.includes('Runtime env vars:'),
                        `summary must contain "Runtime env vars:" for non-empty env vars, got: "${rendered.trim()}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty orderedEnvVars, the reported count equals orderedEnvVars.length', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderSummarySnippet(orderedEnvVars);
                    const match = rendered.match(SUMMARY_COUNT_PATTERN);

                    assert.ok(match,
                        `summary must match pattern 'echo "   Runtime env vars: N"', got: "${rendered.trim()}"`);

                    const reportedCount = parseInt(match[1], 10);
                    assert.strictEqual(reportedCount, orderedEnvVars.length,
                        `reported count ${reportedCount} must equal orderedEnvVars.length ${orderedEnvVars.length}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('summary count matches actual number of export lines', () => {

        it('for any non-empty orderedEnvVars, the summary count equals the number of rendered export lines', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const combinedRendered = renderCombinedSnippet(orderedEnvVars);
                    const exportLines = getExportLines(combinedRendered);
                    const summaryMatch = combinedRendered.match(SUMMARY_COUNT_PATTERN);

                    assert.ok(summaryMatch,
                        'combined output must contain the summary count line');

                    const reportedCount = parseInt(summaryMatch[1], 10);
                    assert.strictEqual(reportedCount, exportLines.length,
                        `summary count ${reportedCount} must equal actual export lines ${exportLines.length}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty orderedEnvVars, export line count equals orderedEnvVars.length equals summary count', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const exportRendered = renderExportSnippet(orderedEnvVars);
                    const summaryRendered = renderSummarySnippet(orderedEnvVars);

                    const exportLines = getExportLines(exportRendered);
                    const summaryMatch = summaryRendered.match(SUMMARY_COUNT_PATTERN);

                    assert.ok(summaryMatch, 'summary must contain the count line');

                    const summaryCount = parseInt(summaryMatch[1], 10);

                    // Three-way equality: input length == export lines == summary count
                    assert.strictEqual(exportLines.length, orderedEnvVars.length,
                        `export lines (${exportLines.length}) must equal input length (${orderedEnvVars.length})`);
                    assert.strictEqual(summaryCount, orderedEnvVars.length,
                        `summary count (${summaryCount}) must equal input length (${orderedEnvVars.length})`);
                    assert.strictEqual(summaryCount, exportLines.length,
                        `summary count (${summaryCount}) must equal export lines (${exportLines.length})`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('empty orderedEnvVars omits the Runtime env vars line from summary', () => {

        it('when orderedEnvVars is empty, the summary does NOT contain "Runtime env vars"', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = renderSummarySnippet([]);
            assert.ok(!rendered.includes('Runtime env vars'),
                `summary must not contain "Runtime env vars" for empty array, got: "${rendered.trim()}"`);
        });

        it('when orderedEnvVars is undefined, the summary does NOT contain "Runtime env vars"', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = ejs.render(DO_CONFIG_SUMMARY_SNIPPET, { orderedEnvVars: undefined });
            assert.ok(!rendered.includes('Runtime env vars'),
                `summary must not contain "Runtime env vars" for undefined, got: "${rendered.trim()}"`);
        });

        it('when orderedEnvVars is null, the summary does NOT contain "Runtime env vars"', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = ejs.render(DO_CONFIG_SUMMARY_SNIPPET, { orderedEnvVars: null });
            assert.ok(!rendered.includes('Runtime env vars'),
                `summary must not contain "Runtime env vars" for null, got: "${rendered.trim()}"`);
        });

        it('when orderedEnvVars is empty, the combined output has no export lines and no count', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = renderCombinedSnippet([]);
            const exportLines = getExportLines(rendered);
            const summaryMatch = rendered.match(SUMMARY_COUNT_PATTERN);

            assert.strictEqual(exportLines.length, 0,
                'empty orderedEnvVars must produce zero export lines');
            assert.strictEqual(summaryMatch, null,
                'empty orderedEnvVars must not produce a summary count line');
        });
    });

    describe('conditional rendering is consistent between export and summary sections', () => {

        it('for any orderedEnvVars, both sections agree on whether to render', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbOrderedEnvVars,
                (orderedEnvVars) => {
                    const exportRendered = renderExportSnippet(orderedEnvVars);
                    const summaryRendered = renderSummarySnippet(orderedEnvVars);

                    const hasExports = getExportLines(exportRendered).length > 0;
                    const hasSummaryCount = SUMMARY_COUNT_PATTERN.test(summaryRendered);

                    assert.strictEqual(hasExports, hasSummaryCount,
                        `export section (hasExports=${hasExports}) and summary section ` +
                        `(hasSummaryCount=${hasSummaryCount}) must agree on rendering`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
