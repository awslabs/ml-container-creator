// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Serving Versions — Catalog Serialization Property-Based Tests
 *
 * Verifies that writeCatalog produces JSON with correct key ordering and indentation.
 *
 * Feature: sync-serving-versions
 * Property 7: Catalog serialization preserves key ordering
 *
 * **Validates: Requirements 10.1, 10.2**
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCatalog } from '../../scripts/sync-serving-versions.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempFiles = [];

function createTempPath() {
    const tempFile = path.join(os.tmpdir(), `catalog-serialization-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    tempFiles.push(tempFile);
    return tempFile;
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a realistic catalog entry array for a server.
 * Uses tuple+map to produce standard JS objects (avoids null-prototype from fc.record).
 */
const arbEntry = fc.tuple(
    fc.stringMatching(/^[a-z/]+:[v]?\d+\.\d+\.\d+$/),
    fc.stringMatching(/^v?\d+\.\d+\.\d+$/),
    fc.stringMatching(/^\d+\.\d+\.\d+$/)
).map(([image, tag, frameworkVersion]) => ({
    image,
    tag,
    architecture: 'amd64',
    created: '2024-01-15T10:00:00Z',
    labels: { framework_version: frameworkVersion }
}));

const arbEntries = fc.array(arbEntry, { minLength: 0, maxLength: 5 });

/**
 * Generate a catalog object with keys in ANY order (including shuffled).
 * The keys are always a subset of [vllm, sglang, tensorrt-llm] but in random order.
 */
const arbCatalog = fc.tuple(
    arbEntries,
    arbEntries,
    arbEntries,
    fc.shuffledSubarray(['vllm', 'sglang', 'tensorrt-llm'], { minLength: 1, maxLength: 3 })
).map(([vllmEntries, sglangEntries, trtEntries, keyOrder]) => {
    const entriesMap = {
        'vllm': vllmEntries,
        'sglang': sglangEntries,
        'tensorrt-llm': trtEntries
    };
    const catalog = {};
    for (const key of keyOrder) {
        catalog[key] = entriesMap[key];
    }
    return catalog;
});

/**
 * Generate a catalog that always contains all three keys (in random order).
 */
const arbFullCatalog = fc.tuple(
    arbEntries,
    arbEntries,
    arbEntries,
    fc.shuffledSubarray(['vllm', 'sglang', 'tensorrt-llm'], { minLength: 3, maxLength: 3 })
).map(([vllmEntries, sglangEntries, trtEntries, keyOrder]) => {
    const entriesMap = {
        'vllm': vllmEntries,
        'sglang': sglangEntries,
        'tensorrt-llm': trtEntries
    };
    const catalog = {};
    for (const key of keyOrder) {
        catalog[key] = entriesMap[key];
    }
    return catalog;
});

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Sync Serving Versions — Catalog Serialization Property-Based Tests', () => {

    afterEach(() => {
        // Clean up temp files
        while (tempFiles.length > 0) {
            const file = tempFiles.pop();
            if (existsSync(file)) {
                try { unlinkSync(file); } catch { /* ignore cleanup errors */ }
            }
        }
    });

    describe('Property 7: Catalog serialization preserves key ordering', () => {

        /**
         * **Validates: Requirements 10.1, 10.2**
         */

        it('writing and reading back produces JSON with keys in order [vllm, sglang, tensorrt-llm]', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullCatalog,
                (catalog) => {
                    const tempPath = createTempPath();

                    // Write catalog to disk
                    writeCatalog(catalog, tempPath);

                    // Read back the file
                    const content = readFileSync(tempPath, 'utf8');
                    const parsed = JSON.parse(content);

                    // Verify key order is [vllm, sglang, tensorrt-llm]
                    const keys = Object.keys(parsed);
                    const expectedOrder = ['vllm', 'sglang', 'tensorrt-llm'];

                    assert.deepStrictEqual(keys, expectedOrder,
                        `Expected top-level keys in order [${expectedOrder.join(', ')}] but got [${keys.join(', ')}]`);

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('output uses 4-space indentation', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalog,
                (catalog) => {
                    const tempPath = createTempPath();

                    // Write catalog to disk
                    writeCatalog(catalog, tempPath);

                    // Read back the file
                    const content = readFileSync(tempPath, 'utf8');

                    // Verify 4-space indentation: the first indented line should start with 4 spaces
                    const lines = content.split('\n');
                    const indentedLines = lines.filter(l => l.startsWith(' '));

                    if (indentedLines.length > 0) {
                        // All indentation levels should be multiples of 4 spaces
                        for (const line of indentedLines) {
                            const match = line.match(/^( +)/);
                            if (match) {
                                const spaces = match[1].length;
                                assert.strictEqual(spaces % 4, 0,
                                    `Expected indentation to be a multiple of 4 spaces, got ${spaces} spaces in line: "${line.trim()}"`);
                            }
                        }

                        // First indented line should be at level 1 (4 spaces)
                        const firstIndented = indentedLines[0];
                        const firstMatch = firstIndented.match(/^( +)/);
                        assert.strictEqual(firstMatch[1].length, 4,
                            `Expected first indentation level to be 4 spaces, got ${firstMatch[1].length}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('output ends with a trailing newline', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalog,
                (catalog) => {
                    const tempPath = createTempPath();

                    // Write catalog to disk
                    writeCatalog(catalog, tempPath);

                    // Read back the file
                    const content = readFileSync(tempPath, 'utf8');

                    assert.ok(content.endsWith('\n'),
                        'Written catalog file should end with a trailing newline');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('content round-trips correctly (write then parse produces equivalent data)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFullCatalog,
                (catalog) => {
                    const tempPath = createTempPath();

                    // Write catalog to disk
                    writeCatalog(catalog, tempPath);

                    // Read back and parse
                    const content = readFileSync(tempPath, 'utf8');
                    const parsed = JSON.parse(content);

                    // Verify the values are equivalent for all keys present in the original
                    for (const key of Object.keys(catalog)) {
                        assert.deepStrictEqual(parsed[key], catalog[key],
                            `Data for key "${key}" should round-trip correctly`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
