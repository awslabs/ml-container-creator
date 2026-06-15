// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema Registry Property-Based Tests
 *
 * Feature: schema-driven-validation, Property 13: Staleness detection correctness
 * Feature: schema-driven-validation, Property 21: Schema registry store-then-query round-trip
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import SchemaValidationEngine from '../../src/lib/schema-validation-engine.js';
import { storeServiceModel, loadServiceModel } from '../../src/lib/schema-sync.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temporary registry directory for testing.
 */
function createTempRegistry() {
    const tempDir = path.join(os.tmpdir(), `mlcc-test-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

/**
 * Clean up a temporary registry directory.
 */
function cleanupTempRegistry(tempDir) {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

/**
 * Write a manifest.json with a given lastSynced timestamp.
 */
function writeManifest(registryPath, lastSynced) {
    const manifest = {
        lastSynced,
        services: {
            sagemaker: { shapeCount: 100, enumCount: 10, version: '2017-07-24' }
        },
        source: 'https://github.com/aws/aws-sdk-js-v3/tree/main/codegen/sdk-codegen/aws-models'
    };
    writeFileSync(path.join(registryPath, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

// ── Property 13: Staleness detection correctness ─────────────────────────────

describe('Property 13: Staleness detection correctness', () => {
    /**
     * **Validates: Requirements 2.1**
     *
     * For any lastSynced timestamp, the staleness check SHALL return
     * stale: true if and only if the timestamp is more than 30 days
     * before the current time.
     */

    let tempRegistry;

    beforeEach(() => {
        tempRegistry = createTempRegistry();
    });

    afterEach(() => {
        cleanupTempRegistry(tempRegistry);
    });

    it('returns stale: true iff timestamp is more than 30 days old', () => {
        fc.assert(
            fc.property(
                // Generate a random number of days from 0 to 365
                fc.integer({ min: 0, max: 365 }),
                (daysAgo) => {
                    const now = new Date();
                    const syncDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
                    const lastSynced = syncDate.toISOString();

                    writeManifest(tempRegistry, lastSynced);

                    const engine = new SchemaValidationEngine({
                        registryPath: tempRegistry,
                        ignoreStaleness: true
                    });

                    const result = engine.checkStaleness();

                    const expectedStale = daysAgo > 30;

                    assert.strictEqual(
                        result.stale,
                        expectedStale,
                        `Expected stale=${expectedStale} for ${daysAgo} days ago, got stale=${result.stale}`
                    );
                    assert.strictEqual(result.lastSynced, syncDate.toISOString());
                    assert.strictEqual(result.daysSinceSync, daysAgo);
                }
            ),
            PROPERTY_CONFIG
        );
    });

    it('returns registryMissing: true when no manifest exists', () => {
        const engine = new SchemaValidationEngine({
            registryPath: tempRegistry,
            ignoreStaleness: true
        });

        const result = engine.checkStaleness();

        assert.strictEqual(result.stale, false);
        assert.strictEqual(result.lastSynced, null);
        assert.strictEqual(result.daysSinceSync, 0);
        assert.strictEqual(result.registryMissing, true);
    });

    it('returns registryMissing: true when registryPath is null', () => {
        const engine = new SchemaValidationEngine({
            registryPath: null,
            ignoreStaleness: true
        });

        const result = engine.checkStaleness();

        assert.strictEqual(result.stale, false);
        assert.strictEqual(result.lastSynced, null);
        assert.strictEqual(result.registryMissing, true);
    });
});

// ── Property 21: Schema registry store-then-query round-trip ─────────────────

describe('Property 21: Schema registry store-then-query round-trip', () => {
    /**
     * **Validates: Requirements 10.1**
     *
     * For any service name in {sagemaker, iam, ecr, s3} and for any valid
     * service model content, storing the model in the registry and then
     * loading it back SHALL produce a byte-identical file.
     */

    let tempRegistry;

    beforeEach(() => {
        tempRegistry = createTempRegistry();
    });

    afterEach(() => {
        cleanupTempRegistry(tempRegistry);
    });

    it('store then load produces byte-identical content', () => {
        const arbServiceName = fc.constantFrom('sagemaker', 'iam', 'ecr', 's3');

        // Generate random valid JSON service model content
        const arbModelContent = fc.record({
            metadata: fc.record({
                apiVersion: fc.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
                endpointPrefix: fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/),
                protocol: fc.constantFrom('json', 'query', 'rest-json', 'rest-xml')
            }),
            operations: fc.dictionary(
                fc.stringMatching(/^[A-Z][A-Za-z]{2,20}$/),
                fc.record({
                    input: fc.record({ shape: fc.stringMatching(/^[A-Z][A-Za-z]{2,15}$/) }),
                    output: fc.record({ shape: fc.stringMatching(/^[A-Z][A-Za-z]{2,15}$/) })
                })
            ),
            shapes: fc.dictionary(
                fc.stringMatching(/^[A-Z][A-Za-z]{2,15}$/),
                fc.record({
                    type: fc.constantFrom('structure', 'string', 'integer', 'boolean', 'list')
                })
            )
        }).map(model => JSON.stringify(model, null, 2));

        fc.assert(
            fc.property(
                arbServiceName,
                arbModelContent,
                (serviceName, content) => {
                    storeServiceModel(serviceName, content, tempRegistry);
                    const loaded = loadServiceModel(serviceName, tempRegistry);

                    assert.strictEqual(
                        loaded,
                        content,
                        `Round-trip failed for ${serviceName}: stored content does not match loaded content`
                    );
                }
            ),
            PROPERTY_CONFIG
        );
    });
});
