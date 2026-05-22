// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * loadCatalog() Property-Based Tests
 *
 * Property-based tests for the shared catalog loader function,
 * verifying error handling for invalid JSON input.
 *
 * Feature: mcp-server-externalization
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog } from '../../servers/base-image-picker/index.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// Resolve the __dirname of the server module for path assertions
const serverDir = path.dirname(new URL(import.meta.resolve('../../servers/base-image-picker/index.js')).pathname);

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidJSON(str) {
    try {
        JSON.parse(str);
        return true;
    } catch {
        return false;
    }
}

// Track temp dirs for cleanup
const tempDirs = [];

function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-catalog-prop-'));
    tempDirs.push(dir);
    return dir;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('loadCatalog() Property-Based Tests', () => {

    afterEach(() => {
        while (tempDirs.length > 0) {
            const dir = tempDirs.pop();
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (_) {
                // ignore cleanup errors
            }
        }
    });

    // Feature: mcp-server-externalization, Property 3: Missing file throws with path
    describe('Property 3: Missing file throws with path', () => {
        /**
         * Validates: Requirements 1.6, 2.5, 3.4
         *
         * For any random relative path that does not exist on disk,
         * calling loadCatalog should throw an error whose message
         * includes the resolved file path.
         */
        it('for any non-existent path, loadCatalog throws with the path in the error message', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.string({ minLength: 1 }),
                (relativePath) => {
                    // Prefix with a non-existent directory to guarantee the path doesn't exist
                    const safePath = `__nonexistent_catalog_dir__/${relativePath}`;
                    const expectedFullPath = path.resolve(serverDir, safePath);

                    let threw = false;
                    try {
                        loadCatalog(safePath);
                    } catch (err) {
                        threw = true;
                        // Error message must include the resolved file path
                        assert.ok(
                            err.message.includes(expectedFullPath),
                            `Error message should include path "${expectedFullPath}", got: "${err.message}"`
                        );
                        // Error message must follow the expected format
                        assert.ok(
                            err.message.startsWith('Catalog file not found'),
                            `Error message should start with "Catalog file not found", got: "${err.message}"`
                        );
                    }
                    assert.ok(threw, `loadCatalog should have thrown for missing path: ${JSON.stringify(safePath)}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: mcp-server-externalization, Property 2: Invalid JSON throws with file path
    describe('Property 2: Invalid JSON throws with file path', () => {
        /**
         * Validates: Requirements 1.5, 2.4, 3.3
         *
         * For any string that is not valid JSON, writing it to a temp file
         * and calling loadCatalog should throw an error whose message
         * includes the file path.
         */
        it('for any non-JSON string written to a file, loadCatalog throws with the file path in the error message', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.string().filter(s => !isValidJSON(s)),
                (invalidContent) => {
                    const tmpDir = createTempDir();
                    const filePath = path.join(tmpDir, 'bad-catalog.json');
                    fs.writeFileSync(filePath, invalidContent, 'utf8');

                    // Use absolute path so resolve(__dirname, absPath) returns absPath
                    let threw = false;
                    try {
                        loadCatalog(filePath);
                    } catch (err) {
                        threw = true;
                        // Error message must include the file path
                        assert.ok(
                            err.message.includes(filePath),
                            `Error message should include file path "${filePath}", got: "${err.message}"`
                        );
                        // Error message must follow the expected format
                        assert.ok(
                            err.message.startsWith('Failed to parse catalog'),
                            `Error message should start with "Failed to parse catalog", got: "${err.message}"`
                        );
                    }
                    assert.ok(threw, `loadCatalog should have thrown for invalid JSON content: ${JSON.stringify(invalidContent)}`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
