// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-Env Accumulation and Preservation Property-Based Tests
 *
 * Property 4: Server-Env Accumulation and Preservation
 *
 * For any list of KEY=VALUE pairs passed via --server-env, ALL pairs SHALL
 * appear as `export KEY=${KEY:-VALUE}` lines in the generated do/config.
 *
 * Feature: ftp-benchmark-support, Property 4: Server-Env Accumulation and Preservation
 *
 * **Validates: Requirements FTP-3 (3.1, 3.2, 3.3)**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── EJS template snippet (extracted from templates/do/config) ────────────────

const SERVER_ENV_TEMPLATE_SNIPPET = [
    '<% if (typeof serverEnvVars !== \'undefined\' && serverEnvVars && Object.keys(serverEnvVars).length > 0) { %>',
    '# Server environment variables',
    '<% Object.entries(serverEnvVars).forEach(([key, value]) => { %>',
    'export <%= key %>=${<%= key %>:-<%= value %>}',
    '<% }); %>',
    '<% } %>'
].join('\n');

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid env var key: uppercase letters, digits, underscores,
 * starting with a letter or underscore. Prefixed with SM_ to match the
 * typical server-env pattern (SM_VLLM_*, SM_SGLANG_*, etc.).
 */
const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,25}$/);

/**
 * Generate a valid env var value: alphanumeric with common value characters.
 * Avoids characters that would break shell export syntax (no newlines,
 * quotes, or backticks).
 */
const arbEnvValue = fc.stringMatching(/^[a-zA-Z0-9._\-/]{1,40}$/);

/**
 * Generate a serverEnvVars object with unique keys (1-15 entries).
 */
const arbServerEnvVars = fc.uniqueArray(
    fc.tuple(arbEnvKey, arbEnvValue),
    { minLength: 1, maxLength: 15, selector: ([key]) => key }
).map(pairs => Object.fromEntries(pairs));

// ── Helper functions ─────────────────────────────────────────────────────────

function renderServerEnvSnippet(serverEnvVars) {
    return ejs.render(SERVER_ENV_TEMPLATE_SNIPPET, { serverEnvVars });
}

function getExportLines(rendered) {
    return rendered.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('export '));
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: ftp-benchmark-support, Property 4: Server-Env Accumulation and Preservation', () => {

    describe('all server-env pairs appear as export lines in do/config', () => {

        /**
         * Validates: Requirements FTP-3 (3.1, 3.2, 3.3)
         */

        it('for any non-empty serverEnvVars object, each entry produces an export line preserving key and value', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);

                    for (const [key, value] of Object.entries(serverEnvVars)) {
                        const expectedLine = `export ${key}=\${${key}:-${value}}`;
                        assert.ok(rendered.includes(expectedLine),
                            `do/config output must contain "${expectedLine}". Got:\n${rendered}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty serverEnvVars object, the number of export lines equals the number of entries', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);
                    const exportLines = getExportLines(rendered);
                    const expectedCount = Object.keys(serverEnvVars).length;

                    assert.strictEqual(exportLines.length, expectedCount,
                        `expected ${expectedCount} export lines, got ${exportLines.length}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any non-empty serverEnvVars object, the header comment is present', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);
                    assert.ok(rendered.includes('# Server environment variables'),
                        'do/config output must contain the "# Server environment variables" header');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('empty or missing serverEnvVars renders no server-env section', () => {

        it('when serverEnvVars is an empty object, no export lines are rendered', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = renderServerEnvSnippet({});
            const trimmed = rendered.trim();

            assert.strictEqual(trimmed, '',
                `do/config output must be empty for empty serverEnvVars, got: "${trimmed}"`);
        });

        it('when serverEnvVars is undefined, no export lines are rendered', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = ejs.render(SERVER_ENV_TEMPLATE_SNIPPET, { serverEnvVars: undefined });
            const trimmed = rendered.trim();

            assert.strictEqual(trimmed, '',
                `do/config output must be empty for undefined serverEnvVars, got: "${trimmed}"`);
        });

        it('when serverEnvVars is null, no export lines are rendered', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const rendered = ejs.render(SERVER_ENV_TEMPLATE_SNIPPET, { serverEnvVars: null });
            const trimmed = rendered.trim();

            assert.strictEqual(trimmed, '',
                `do/config output must be empty for null serverEnvVars, got: "${trimmed}"`);
        });
    });

    describe('key and value preservation is exact', () => {

        it('for any serverEnvVars, keys in export lines match input keys exactly (case-sensitive)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);
                    const exportLines = getExportLines(rendered);

                    const renderedKeys = exportLines.map(line => {
                        // export KEY=${KEY:-VALUE} → extract KEY
                        const match = line.match(/^export\s+([A-Z][A-Z0-9_]*)=/);
                        return match ? match[1] : null;
                    }).filter(Boolean);

                    const inputKeys = Object.keys(serverEnvVars).sort();
                    const sortedRenderedKeys = [...renderedKeys].sort();

                    assert.deepStrictEqual(sortedRenderedKeys, inputKeys,
                        'rendered keys must match input keys exactly');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any serverEnvVars, values in export lines match input values exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);
                    const exportLines = getExportLines(rendered);

                    for (const line of exportLines) {
                        // export KEY=${KEY:-VALUE} → extract KEY and VALUE
                        const match = line.match(/^export\s+([A-Z][A-Z0-9_]*)=\$\{[^:]+:-(.+)\}$/);
                        assert.ok(match, `export line should match expected pattern: "${line}"`);

                        const [, key, value] = match;
                        assert.strictEqual(value, serverEnvVars[key],
                            `value for "${key}" should be "${serverEnvVars[key]}", got "${value}"`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
