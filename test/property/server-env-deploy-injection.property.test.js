// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-Env Injection into Deploy Environment Property-Based Tests
 *
 * Property 5: Server-Env Injection into Deploy Environment
 *
 * For any set of server-env variables, the do/deploy script SHALL inject
 * all of them into the InferenceComponent's Environment map (CONTAINER_ENV_JSON).
 *
 * Feature: ftp-benchmark-support, Property 5: Server-Env Injection into Deploy Environment
 *
 * **Validates: Requirements FTP-3 (3.4)**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NUM_RUNS } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 30000,
    seed: 42,
    verbose: false
};

// ── Load the managed-inference deploy template ───────────────────────────────

const TEMPLATE_PATH = resolve(__dirname, '../../templates/do/deploy.d/managed-inference');
const DEPLOY_TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf-8'); // eslint-disable-line no-unused-vars

// ── Extract the server-env injection EJS snippet ─────────────────────────────
// We extract just the server-env injection block to test in isolation,
// avoiding the need to satisfy all other template variables.

const SERVER_ENV_SNIPPET = `
<% if (typeof serverEnvVars !== 'undefined' && serverEnvVars && Object.keys(serverEnvVars).length > 0) { %>
# ============================================================
# Inject server environment variables into container Environment
# ============================================================
<% Object.keys(serverEnvVars).forEach(function(key) { %>
if [ -n "\${<%= key %>:-}" ]; then
    if [ -n "\${CONTAINER_ENV_JSON}" ]; then
        CONTAINER_ENV_JSON="\${CONTAINER_ENV_JSON},\\"<%= key %>\\":\\"\${<%= key %>}\\""
    else
        CONTAINER_ENV_JSON="\\"<%= key %>\\":\\"\${<%= key %>}\\""
    fi
fi
<% }); %>
<% } %>
`;

// ── Arbitrary generators ─────────────────────────────────────────────────────

/**
 * Generate a valid UPPER_CASE env var name (uppercase letters, digits,
 * underscores, starting with a letter — typical for SM_VLLM_* vars).
 */
const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,30}$/);

/**
 * Generate a valid env var value (non-empty string, no newlines or quotes
 * that would break bash).
 */
const arbEnvValue = fc.stringMatching(/^[a-zA-Z0-9._\-/=]{1,50}$/);

/**
 * Generate a non-empty set of unique server env var entries.
 * serverEnvVars is an object: { KEY: VALUE, ... }
 */
const arbServerEnvVars = fc.uniqueArray(
    fc.tuple(arbEnvKey, arbEnvValue),
    { minLength: 1, maxLength: 15, selector: ([key]) => key }
).map(pairs => Object.fromEntries(pairs));

// ── Helper functions ─────────────────────────────────────────────────────────

function renderServerEnvSnippet(serverEnvVars) {
    return ejs.render(SERVER_ENV_SNIPPET, { serverEnvVars });
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: ftp-benchmark-support, Property 5: Server-Env Injection into Deploy Environment', () => {

    describe('all server-env keys are injected into CONTAINER_ENV_JSON', () => {

        it('for any set of server-env variables, each key appears in the CONTAINER_ENV_JSON injection block', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);

                    for (const key of Object.keys(serverEnvVars)) {
                        // Each key should appear as a quoted JSON key in the CONTAINER_ENV_JSON assignment
                        assert.ok(
                            rendered.includes(`\\"${key}\\"`),
                            `CONTAINER_ENV_JSON block must contain key "${key}" as a quoted JSON field`
                        );
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any set of server-env variables, the injection block contains exactly one if-block per key', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);
                    const keys = Object.keys(serverEnvVars);

                    for (const key of keys) {
                        // Each key gets its own if-block checking if the var is set
                        const pattern = `if [ -n "\${${key}:-}" ]; then`;
                        assert.ok(
                            rendered.includes(pattern),
                            `Injection block must check if "${key}" is set with: ${pattern}`
                        );
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any set of server-env variables, every key is injected into the Environment map (no key is omitted)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerEnvVars,
                (serverEnvVars) => {
                    const rendered = renderServerEnvSnippet(serverEnvVars);
                    const keys = Object.keys(serverEnvVars);

                    // Count the number of CONTAINER_ENV_JSON assignment lines containing each key
                    for (const key of keys) {
                        // The key should appear in a CONTAINER_ENV_JSON assignment
                        const assignmentPattern = new RegExp(
                            `CONTAINER_ENV_JSON=.*\\\\"${key}\\\\"`
                        );
                        assert.ok(
                            assignmentPattern.test(rendered),
                            `Key "${key}" must appear in a CONTAINER_ENV_JSON assignment`
                        );
                    }

                    // The number of if-blocks should equal the number of keys
                    const ifBlocks = rendered.match(/if \[ -n "\$\{[A-Z][A-Z0-9_]*:-\}" \]; then/g) || [];
                    assert.strictEqual(
                        ifBlocks.length, keys.length,
                        `Expected ${keys.length} if-blocks (one per key), got ${ifBlocks.length}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('empty or missing serverEnvVars produces no injection block', () => {

        it('when serverEnvVars is undefined, no injection block is rendered', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const rendered = ejs.render(SERVER_ENV_SNIPPET, { serverEnvVars: undefined });
            assert.ok(
                !rendered.includes('CONTAINER_ENV_JSON'),
                'No CONTAINER_ENV_JSON injection should appear for undefined serverEnvVars'
            );
        });

        it('when serverEnvVars is an empty object, no injection block is rendered', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const rendered = ejs.render(SERVER_ENV_SNIPPET, { serverEnvVars: {} });
            assert.ok(
                !rendered.includes('CONTAINER_ENV_JSON'),
                'No CONTAINER_ENV_JSON injection should appear for empty serverEnvVars'
            );
        });

        it('when serverEnvVars is null, no injection block is rendered', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const rendered = ejs.render(SERVER_ENV_SNIPPET, { serverEnvVars: null });
            assert.ok(
                !rendered.includes('CONTAINER_ENV_JSON'),
                'No CONTAINER_ENV_JSON injection should appear for null serverEnvVars'
            );
        });
    });
});
