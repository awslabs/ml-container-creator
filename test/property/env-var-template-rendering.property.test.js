// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment Variable Template Rendering Property-Based Tests
 *
 * Property 5: For any non-empty orderedEnvVars array, the Dockerfile template
 * SHALL render an ENV <key>=<value> directive for each entry, and the do/config
 * template SHALL render an export <key> statement for each entry. When
 * orderedEnvVars is empty, neither template SHALL render the env var section.
 *
 * Feature: registry-to-server-migration, Property 5: Environment variable template rendering
 * Validates: Requirements 7.4, 8.1
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── EJS template snippets (extracted from actual templates) ──────────────────

const DOCKERFILE_ENV_SNIPPET = [
    '<% if (orderedEnvVars && orderedEnvVars.length > 0) { %>',
    '# Environment variables',
    '<% orderedEnvVars.forEach(({ key, value }) => { %>',
    'ENV <%= key %>=<%= value %>',
    '<% }); %>',
    '<% } %>'
].join('\n');

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
const arbOrderedEnvVars = fc.array(arbEnvVarEntry, { minLength: 0, maxLength: 10 });

// ── Helper functions ─────────────────────────────────────────────────────────

function renderDockerfileSnippet(orderedEnvVars) {
    return ejs.render(DOCKERFILE_ENV_SNIPPET, { orderedEnvVars });
}

function renderDoConfigSnippet(orderedEnvVars) {
    return ejs.render(DO_CONFIG_ENV_SNIPPET, { orderedEnvVars });
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 5: Environment variable template rendering', () => {

    describe('Dockerfile template renders ENV directives for each entry', () => {

        it('for any non-empty orderedEnvVars, each entry produces an ENV <key>=<value> line', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDockerfileSnippet(orderedEnvVars);

                    for (const { key, value } of orderedEnvVars) {
                        const expectedLine = `ENV ${key}=${value}`;
                        assert.ok(rendered.includes(expectedLine),
                            `Dockerfile output must contain "${expectedLine}". Got:\n${rendered}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty orderedEnvVars, the number of ENV lines equals the array length', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDockerfileSnippet(orderedEnvVars);
                    const envLines = rendered.split('\n').filter(line => line.trim().startsWith('ENV '));

                    assert.strictEqual(envLines.length, orderedEnvVars.length,
                        `expected ${orderedEnvVars.length} ENV lines, got ${envLines.length}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty orderedEnvVars, the header comment is present', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDockerfileSnippet(orderedEnvVars);
                    assert.ok(rendered.includes('# Environment variables'),
                        'Dockerfile output must contain the header comment');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('do/config template renders export statements for each entry', () => {

        it('for any non-empty orderedEnvVars, each entry produces an export <key>=${<key>:-<value>} line', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDoConfigSnippet(orderedEnvVars);

                    for (const { key, value } of orderedEnvVars) {
                        const expectedLine = `export ${key}=\${${key}:-${value}}`;
                        assert.ok(rendered.includes(expectedLine),
                            `do/config output must contain "${expectedLine}". Got:\n${rendered}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty orderedEnvVars, the number of export lines equals the array length', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDoConfigSnippet(orderedEnvVars);
                    const exportLines = rendered.split('\n').filter(line => line.trim().startsWith('export '));

                    assert.strictEqual(exportLines.length, orderedEnvVars.length,
                        `expected ${orderedEnvVars.length} export lines, got ${exportLines.length}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty orderedEnvVars, the header comment is present', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbNonEmptyOrderedEnvVars,
                (orderedEnvVars) => {
                    const rendered = renderDoConfigSnippet(orderedEnvVars);
                    assert.ok(rendered.includes('# Runtime environment variables (from catalog)'),
                        'do/config output must contain the header comment');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('empty orderedEnvVars renders no env var section', () => {

        it('when orderedEnvVars is empty, Dockerfile renders no ENV lines and no header', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.constant([]),
                (orderedEnvVars) => {
                    const rendered = renderDockerfileSnippet(orderedEnvVars);
                    const trimmed = rendered.trim();

                    assert.strictEqual(trimmed, '',
                        `Dockerfile output must be empty for empty orderedEnvVars, got: "${trimmed}"`);
                }
            ), { numRuns: 10, verbose: PROPERTY_CONFIG.verbose });
        });

        it('when orderedEnvVars is empty, do/config renders no export lines and no header', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                fc.constant([]),
                (orderedEnvVars) => {
                    const rendered = renderDoConfigSnippet(orderedEnvVars);
                    const trimmed = rendered.trim();

                    assert.strictEqual(trimmed, '',
                        `do/config output must be empty for empty orderedEnvVars, got: "${trimmed}"`);
                }
            ), { numRuns: 10, verbose: PROPERTY_CONFIG.verbose });
        });

        it('when orderedEnvVars is undefined, neither template renders the env var section', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const dockerRendered = ejs.render(DOCKERFILE_ENV_SNIPPET, { orderedEnvVars: undefined });
            const configRendered = ejs.render(DO_CONFIG_ENV_SNIPPET, { orderedEnvVars: undefined });

            assert.strictEqual(dockerRendered.trim(), '',
                'Dockerfile must render empty for undefined orderedEnvVars');
            assert.strictEqual(configRendered.trim(), '',
                'do/config must render empty for undefined orderedEnvVars');
        });

        it('when orderedEnvVars is null, neither template renders the env var section', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const dockerRendered = ejs.render(DOCKERFILE_ENV_SNIPPET, { orderedEnvVars: null });
            const configRendered = ejs.render(DO_CONFIG_ENV_SNIPPET, { orderedEnvVars: null });

            assert.strictEqual(dockerRendered.trim(), '',
                'Dockerfile must render empty for null orderedEnvVars');
            assert.strictEqual(configRendered.trim(), '',
                'do/config must render empty for null orderedEnvVars');
        });
    });

    describe('both templates render consistently for the same input', () => {

        it('for any orderedEnvVars, both templates agree on whether to render the section', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbOrderedEnvVars,
                (orderedEnvVars) => {
                    const dockerRendered = renderDockerfileSnippet(orderedEnvVars).trim();
                    const configRendered = renderDoConfigSnippet(orderedEnvVars).trim();

                    const dockerHasContent = dockerRendered.length > 0;
                    const configHasContent = configRendered.length > 0;

                    assert.strictEqual(dockerHasContent, configHasContent,
                        `both templates must agree on rendering: Dockerfile=${dockerHasContent}, do/config=${configHasContent}`);

                    if (orderedEnvVars.length === 0) {
                        assert.strictEqual(dockerHasContent, false,
                            'empty array must produce empty output');
                    } else {
                        assert.strictEqual(dockerHasContent, true,
                            'non-empty array must produce non-empty output');
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
