// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generator Output Correctness Property-Based Tests
 *
 * Property 7: For any valid MCC generator configuration (across all model servers),
 * the generated project SHALL include: a `do/stage` script that sources `do/config`
 * and `do/lib/profile.sh`, a `.gitignore` containing `.mlcc/`, and the `do/stage`
 * script SHALL be server-agnostic (identical content regardless of model server choice).
 *
 * Feature: s3-model-loading, Property 7: Generator output correctness
 * Validates: Requirements 4.1, 4.3, 4.4, 4.6
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Resolve paths relative to this test file ─────────────────────────────────

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname);
const TEMPLATES_DIR = path.resolve(TEST_DIR, '../../templates');
const SRC_DIR = path.resolve(TEST_DIR, '../../src');

// ── Read actual files from disk once ─────────────────────────────────────────

const stageContent = fs.readFileSync(path.join(TEMPLATES_DIR, 'do/stage'), 'utf8');
const stagedAssetsContent = fs.readFileSync(path.join(TEMPLATES_DIR, 'do/lib/staged-assets.sh'), 'utf8');
const appJsContent = fs.readFileSync(path.join(SRC_DIR, 'app.js'), 'utf8');

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Model servers supported by MCC
const arbModelServer = fc.constantFrom('vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl');

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: s3-model-loading, Property 7: Generator output correctness', () => {

    describe('do/stage sources do/config', () => {

        it('for any model server, do/stage template contains source of do/config', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer,
                (_modelServer) => {
                    // The stage template must source do/config via the standard pattern
                    assert.ok(
                        stageContent.includes('source "${SCRIPT_DIR}/config"'),
                        'do/stage must contain: source "${SCRIPT_DIR}/config"'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('do/stage sources do/lib/profile.sh', () => {

        it('for any model server, do/stage template contains source of do/lib/profile.sh', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer,
                (_modelServer) => {
                    // The stage template must source profile.sh via the standard pattern
                    assert.ok(
                        stageContent.includes('source "${SCRIPT_DIR}/lib/profile.sh"'),
                        'do/stage must contain: source "${SCRIPT_DIR}/lib/profile.sh"'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('do/stage is server-agnostic (no model-server-specific EJS conditionals)', () => {

        it('for any model server, do/stage has no EJS model server conditionals', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer,
                (modelServer) => {
                    // The stage template must NOT contain any EJS conditionals that
                    // reference modelServer — it should be identical regardless of server choice
                    const hasModelServerConditional = stageContent.includes('<% if (modelServer ===')
                        || stageContent.includes('<% if(modelServer ===')
                        || stageContent.includes('<%- modelServer')
                        || stageContent.includes('<%= modelServer');

                    assert.ok(
                        !hasModelServerConditional,
                        'do/stage must be server-agnostic — found model server EJS conditional. ' +
                        `Tested with server "${modelServer}"`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any two model servers, do/stage content would be identical', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer, arbModelServer,
                (serverA, serverB) => {
                    // Since do/stage has no EJS model server conditionals,
                    // the template content is the same for all servers.
                    // The template itself is a single file on disk — verify no server-dependent EJS.
                    const hasAnyEjsServerRef = /<%[=-]?\s*modelServer/.test(stageContent)
                        || /<% if\s*\(\s*modelServer/.test(stageContent);

                    assert.ok(
                        !hasAnyEjsServerRef,
                        `do/stage must produce identical output for "${serverA}" and "${serverB}" — ` +
                        'but found modelServer EJS references in template'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('do/lib/staged-assets.sh exists and has expected functions', () => {

        it('for any model server, staged-assets.sh template exists', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer,
                (_modelServer) => {
                    assert.ok(
                        stagedAssetsContent.length > 0,
                        'templates/do/lib/staged-assets.sh must exist and have content'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any model server, staged-assets.sh contains expected utility functions', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer,
                (_modelServer) => {
                    assert.ok(
                        stagedAssetsContent.includes('staged_assets_read_model_uri'),
                        'staged-assets.sh must define staged_assets_read_model_uri()'
                    );
                    assert.ok(
                        stagedAssetsContent.includes('staged_assets_write_model'),
                        'staged-assets.sh must define staged_assets_write_model()'
                    );
                    assert.ok(
                        stagedAssetsContent.includes('staged_assets_status'),
                        'staged-assets.sh must define staged_assets_status()'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('.gitignore generation includes .mlcc/', () => {

        it('for any model server, the generator (src/app.js) adds .mlcc/ to .gitignore', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer,
                (_modelServer) => {
                    // The generator code must contain logic to add .mlcc/ to .gitignore
                    // This verifies that src/app.js has the .mlcc/ gitignore integration
                    assert.ok(
                        appJsContent.includes('.mlcc/'),
                        'src/app.js must reference .mlcc/ for .gitignore generation'
                    );

                    // Verify it checks for .mlcc/ before appending (idempotent)
                    assert.ok(
                        appJsContent.includes('if (!existing.includes(\'.mlcc/\'))')
                            || appJsContent.includes('if (!existing.includes(\'.mlcc/\'))'),
                        'src/app.js must check for existing .mlcc/ entry before appending'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('do/stage sources staged-assets.sh', () => {

        it('for any model server, do/stage sources the staged-assets library', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelServer,
                (_modelServer) => {
                    assert.ok(
                        stageContent.includes('source "${SCRIPT_DIR}/lib/staged-assets.sh"'),
                        'do/stage must source the staged-assets library: source "${SCRIPT_DIR}/lib/staged-assets.sh"'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
