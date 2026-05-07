// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager Unit Tests
 *
 * Tests file creation on first write, corrupted file handling,
 * schema version warning, upsert behavior, CRUD operations,
 * filtering, grouping, status counts, and path derivation.
 *
 * Validates: Requirements 1.1–1.7, 2.1–2.8, 8.1–8.7
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AssetManager, { SCHEMA_VERSION, VALID_RESOURCE_TYPES, VALID_STATUSES } from '../../src/lib/asset-manager.js';

/**
 * Create a valid Asset_Record for testing.
 * @param {Object} [overrides] - Fields to override
 * @returns {Object} A valid Asset_Record
 */
function makeRecord(overrides = {}) {
    return {
        resourceId: 'arn:aws:sagemaker:us-east-1:111111111111:endpoint/test-ep',
        resourceType: 'sagemaker-endpoint',
        createdAt: '2026-05-04T10:30:00Z',
        lastUpdatedAt: '2026-05-04T10:30:00Z',
        project: 'test-project',
        status: 'active',
        metadata: { endpointName: 'test-ep', region: 'us-east-1' },
        ...overrides
    };
}

describe('AssetManager', () => {
    let tmpDir;
    let manager;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'asset-manager-test-'));
        manager = new AssetManager('dev', { configDir: tmpDir });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // ---------------------------------------------------------------
    // Path derivation (Requirements 1.1, 8.7)
    // ---------------------------------------------------------------
    describe('path derivation', () => {
        it('derives manifest path from profile name and configDir', () => {
            const expected = join(tmpDir, 'manifests', 'dev.json');
            assert.strictEqual(manager.manifestPath, expected);
        });

        it('uses default configDir when none provided', () => {
            const defaultManager = new AssetManager('prod');
            assert.ok(defaultManager.manifestPath.includes('.ml-container-creator'));
            assert.ok(defaultManager.manifestPath.endsWith('manifests/prod.json'));
        });

        it('handles profile names with special characters', () => {
            const m = new AssetManager('my-profile-123', { configDir: tmpDir });
            assert.strictEqual(m.manifestPath, join(tmpDir, 'manifests', 'my-profile-123.json'));
        });
    });

    // ---------------------------------------------------------------
    // File creation on first write (Requirements 1.2, 1.4)
    // ---------------------------------------------------------------
    describe('file creation on first write', () => {
        it('creates manifest file and parent directories on first addResource', () => {
            const manifestDir = join(tmpDir, 'manifests');
            assert.ok(!existsSync(manifestDir), 'manifests dir should not exist yet');

            manager.addResource(makeRecord());

            assert.ok(existsSync(manager.manifestPath), 'manifest file should be created');
        });

        it('writes with 2-space indentation and trailing newline', () => {
            manager.addResource(makeRecord());

            const raw = readFileSync(manager.manifestPath, 'utf8');
            assert.ok(raw.endsWith('\n'), 'file should end with trailing newline');

            // Verify 2-space indentation (not 4-space or tabs)
            const lines = raw.split('\n');
            const indentedLines = lines.filter(l => l.startsWith(' '));
            for (const line of indentedLines) {
                const leadingSpaces = line.match(/^( +)/)[1].length;
                assert.strictEqual(leadingSpaces % 2, 0, `indentation should be multiples of 2: "${line}"`);
            }
        });

        it('manifest contains schemaVersion and resources array', () => {
            manager.addResource(makeRecord());

            const data = JSON.parse(readFileSync(manager.manifestPath, 'utf8'));
            assert.strictEqual(data.schemaVersion, SCHEMA_VERSION);
            assert.ok(Array.isArray(data.resources));
            assert.strictEqual(data.resources.length, 1);
        });
    });

    // ---------------------------------------------------------------
    // Reading missing manifest (Requirement 1.2)
    // ---------------------------------------------------------------
    describe('reading missing manifest', () => {
        it('returns empty resources when manifest file does not exist', () => {
            const resources = manager.listResources();
            assert.deepStrictEqual(resources, []);
        });

        it('getStatusCounts returns all zeros for missing manifest', () => {
            const counts = manager.getStatusCounts();
            assert.deepStrictEqual(counts, { active: 0, deleted: 0, unknown: 0 });
        });
    });

    // ---------------------------------------------------------------
    // Corrupted file handling (Requirement 1.5)
    // ---------------------------------------------------------------
    describe('corrupted file handling', () => {
        it('throws descriptive error on invalid JSON', () => {
            const manifestDir = join(tmpDir, 'manifests');
            mkdirSync(manifestDir, { recursive: true });
            writeFileSync(manager.manifestPath, '{not valid json!!!}');

            assert.throws(
                () => manager.listResources(),
                (err) => {
                    assert.ok(err.message.includes('Invalid JSON'), `error should mention Invalid JSON: ${err.message}`);
                    assert.ok(err.message.includes(manager.manifestPath), 'error should include file path');
                    return true;
                }
            );
        });

        it('throws on empty file content', () => {
            const manifestDir = join(tmpDir, 'manifests');
            mkdirSync(manifestDir, { recursive: true });
            writeFileSync(manager.manifestPath, '');

            assert.throws(
                () => manager.listResources(),
                (err) => {
                    assert.ok(err.message.includes('Invalid JSON'));
                    return true;
                }
            );
        });
    });

    // ---------------------------------------------------------------
    // Schema version warning (Requirement 1.6)
    // ---------------------------------------------------------------
    describe('schema version warning', () => {
        it('logs warning for missing schemaVersion and reads resources', () => {
            const manifestDir = join(tmpDir, 'manifests');
            mkdirSync(manifestDir, { recursive: true });
            const record = makeRecord();
            writeFileSync(manager.manifestPath, `${JSON.stringify({ resources: [record] })  }\n`);

            const warnings = [];
            const origWarn = console.warn;
            console.warn = (...args) => warnings.push(args.join(' '));

            try {
                const resources = manager.listResources();
                assert.strictEqual(resources.length, 1);
                assert.strictEqual(resources[0].resourceId, record.resourceId);
                assert.ok(warnings.some(w => w.includes('no schemaVersion')), 'should warn about missing schemaVersion');
            } finally {
                console.warn = origWarn;
            }
        });

        it('logs warning for unrecognized schemaVersion and reads resources', () => {
            const manifestDir = join(tmpDir, 'manifests');
            mkdirSync(manifestDir, { recursive: true });
            const record = makeRecord();
            writeFileSync(
                manager.manifestPath,
                `${JSON.stringify({ schemaVersion: '9999-12-31', resources: [record] })  }\n`
            );

            const warnings = [];
            const origWarn = console.warn;
            console.warn = (...args) => warnings.push(args.join(' '));

            try {
                const resources = manager.listResources();
                assert.strictEqual(resources.length, 1);
                assert.ok(warnings.some(w => w.includes('unrecognized schemaVersion')), 'should warn about unrecognized schemaVersion');
            } finally {
                console.warn = origWarn;
            }
        });

        it('does not warn for current schemaVersion', () => {
            const manifestDir = join(tmpDir, 'manifests');
            mkdirSync(manifestDir, { recursive: true });
            writeFileSync(
                manager.manifestPath,
                `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, resources: [] })  }\n`
            );

            const warnings = [];
            const origWarn = console.warn;
            console.warn = (...args) => warnings.push(args.join(' '));

            try {
                manager.listResources();
                assert.strictEqual(warnings.length, 0, 'should not warn for current schemaVersion');
            } finally {
                console.warn = origWarn;
            }
        });
    });

    // ---------------------------------------------------------------
    // Record validation (Requirements 2.1–2.8)
    // ---------------------------------------------------------------
    describe('record validation', () => {
        it('accepts a valid record', () => {
            const result = manager._validateRecord(makeRecord());
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('rejects record missing required fields', () => {
            const result = manager._validateRecord({});
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.length >= 7, 'should report all 7 missing fields');
            assert.ok(result.errors.some(e => e.includes('resourceId')));
            assert.ok(result.errors.some(e => e.includes('resourceType')));
            assert.ok(result.errors.some(e => e.includes('createdAt')));
            assert.ok(result.errors.some(e => e.includes('lastUpdatedAt')));
            assert.ok(result.errors.some(e => e.includes('project')));
            assert.ok(result.errors.some(e => e.includes('status')));
            assert.ok(result.errors.some(e => e.includes('metadata')));
        });

        it('rejects invalid resourceType', () => {
            const result = manager._validateRecord(makeRecord({ resourceType: 'invalid-type' }));
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid resourceType')));
        });

        it('accepts all valid resource types', () => {
            for (const type of VALID_RESOURCE_TYPES) {
                const result = manager._validateRecord(makeRecord({ resourceType: type }));
                assert.strictEqual(result.valid, true, `should accept resourceType: ${type}`);
            }
        });

        it('rejects invalid status', () => {
            const result = manager._validateRecord(makeRecord({ status: 'pending' }));
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid status')));
        });

        it('accepts all valid statuses', () => {
            for (const status of VALID_STATUSES) {
                const result = manager._validateRecord(makeRecord({ status }));
                assert.strictEqual(result.valid, true, `should accept status: ${status}`);
            }
        });

        it('rejects invalid ISO 8601 timestamp for createdAt', () => {
            const result = manager._validateRecord(makeRecord({ createdAt: 'not-a-date' }));
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid createdAt')));
        });

        it('rejects invalid ISO 8601 timestamp for lastUpdatedAt', () => {
            const result = manager._validateRecord(makeRecord({ lastUpdatedAt: '2026/05/04' }));
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid lastUpdatedAt')));
        });

        it('rejects non-object metadata (array)', () => {
            const result = manager._validateRecord(makeRecord({ metadata: [1, 2, 3] }));
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid metadata')));
        });

        it('rejects non-object metadata (string)', () => {
            const result = manager._validateRecord(makeRecord({ metadata: 'not-an-object' }));
            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid metadata')));
        });

        it('accepts empty object as metadata', () => {
            const result = manager._validateRecord(makeRecord({ metadata: {} }));
            assert.strictEqual(result.valid, true);
        });
    });

    // ---------------------------------------------------------------
    // addResource with upsert behavior (Requirements 8.1, 8.6)
    // ---------------------------------------------------------------
    describe('addResource', () => {
        it('adds a new resource to an empty manifest', () => {
            const record = makeRecord();
            manager.addResource(record);

            const retrieved = manager.getResource(record.resourceId);
            assert.ok(retrieved);
            assert.strictEqual(retrieved.resourceId, record.resourceId);
            assert.strictEqual(retrieved.status, 'active');
        });

        it('throws on invalid record', () => {
            assert.throws(
                () => manager.addResource({ resourceId: 'test' }),
                (err) => {
                    assert.ok(err.message.includes('Invalid asset record'));
                    return true;
                }
            );
        });

        it('upserts existing resource instead of creating duplicate', () => {
            const record = makeRecord();
            manager.addResource(record);

            // Add same resourceId with updated status
            const updated = makeRecord({
                status: 'deleted',
                lastUpdatedAt: '2026-06-01T12:00:00Z'
            });
            manager.addResource(updated);

            const resources = manager.listResources();
            assert.strictEqual(resources.length, 1, 'should not create duplicate');
            assert.strictEqual(resources[0].status, 'deleted');
            assert.strictEqual(resources[0].lastUpdatedAt, '2026-06-01T12:00:00Z');
        });

        it('preserves other fields on upsert', () => {
            const record = makeRecord();
            manager.addResource(record);

            const updated = makeRecord({
                status: 'deleted',
                lastUpdatedAt: '2026-06-01T12:00:00Z'
            });
            manager.addResource(updated);

            const retrieved = manager.getResource(record.resourceId);
            assert.strictEqual(retrieved.project, 'test-project', 'project should be preserved');
            assert.strictEqual(retrieved.createdAt, '2026-05-04T10:30:00Z', 'createdAt should be preserved');
        });

        it('adds multiple resources with different resourceIds', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1' }));
            manager.addResource(makeRecord({ resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-2' }));
            manager.addResource(makeRecord({ resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-3' }));

            const resources = manager.listResources();
            assert.strictEqual(resources.length, 3);
        });
    });

    // ---------------------------------------------------------------
    // updateStatus (Requirements 5.1–5.4, 5.9, 5.10, 8.2)
    // ---------------------------------------------------------------
    describe('updateStatus', () => {
        it('updates status of existing resource and returns true', () => {
            manager.addResource(makeRecord());

            const result = manager.updateStatus(
                'arn:aws:sagemaker:us-east-1:111111111111:endpoint/test-ep',
                'deleted'
            );
            assert.strictEqual(result, true);

            const resource = manager.getResource('arn:aws:sagemaker:us-east-1:111111111111:endpoint/test-ep');
            assert.strictEqual(resource.status, 'deleted');
        });

        it('updates lastUpdatedAt timestamp', () => {
            manager.addResource(makeRecord());
            const before = new Date().toISOString();

            manager.updateStatus(
                'arn:aws:sagemaker:us-east-1:111111111111:endpoint/test-ep',
                'deleted'
            );

            const resource = manager.getResource('arn:aws:sagemaker:us-east-1:111111111111:endpoint/test-ep');
            assert.ok(resource.lastUpdatedAt >= before, 'lastUpdatedAt should be updated to current time');
        });

        it('returns false for non-existent resourceId', () => {
            manager.addResource(makeRecord());

            const result = manager.updateStatus('arn:aws:nonexistent', 'deleted');
            assert.strictEqual(result, false);
        });

        it('returns false on empty manifest', () => {
            const result = manager.updateStatus('arn:aws:nonexistent', 'deleted');
            assert.strictEqual(result, false);
        });

        it('does not modify other resources', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:1' }));
            manager.addResource(makeRecord({ resourceId: 'arn:2' }));

            manager.updateStatus('arn:1', 'deleted');

            const r2 = manager.getResource('arn:2');
            assert.strictEqual(r2.status, 'active', 'other resource should remain unchanged');
        });
    });

    // ---------------------------------------------------------------
    // getResource (Requirement 8.4)
    // ---------------------------------------------------------------
    describe('getResource', () => {
        it('returns matching record', () => {
            const record = makeRecord();
            manager.addResource(record);

            const result = manager.getResource(record.resourceId);
            assert.ok(result);
            assert.strictEqual(result.resourceId, record.resourceId);
            assert.strictEqual(result.resourceType, record.resourceType);
        });

        it('returns null for non-existent resourceId', () => {
            manager.addResource(makeRecord());

            const result = manager.getResource('arn:aws:nonexistent');
            assert.strictEqual(result, null);
        });

        it('returns null on empty manifest', () => {
            const result = manager.getResource('arn:aws:nonexistent');
            assert.strictEqual(result, null);
        });
    });

    // ---------------------------------------------------------------
    // removeResource (Requirement 8.5)
    // ---------------------------------------------------------------
    describe('removeResource', () => {
        it('removes existing resource and returns true', () => {
            const record = makeRecord();
            manager.addResource(record);

            const result = manager.removeResource(record.resourceId);
            assert.strictEqual(result, true);

            const retrieved = manager.getResource(record.resourceId);
            assert.strictEqual(retrieved, null);
        });

        it('returns false for non-existent resourceId', () => {
            manager.addResource(makeRecord());

            const result = manager.removeResource('arn:aws:nonexistent');
            assert.strictEqual(result, false);
        });

        it('returns false on empty manifest', () => {
            const result = manager.removeResource('arn:aws:nonexistent');
            assert.strictEqual(result, false);
        });

        it('does not modify other resources', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:1' }));
            manager.addResource(makeRecord({ resourceId: 'arn:2' }));

            manager.removeResource('arn:1');

            const remaining = manager.listResources();
            assert.strictEqual(remaining.length, 1);
            assert.strictEqual(remaining[0].resourceId, 'arn:2');
        });
    });

    // ---------------------------------------------------------------
    // listResources with filtering (Requirement 8.3)
    // ---------------------------------------------------------------
    describe('listResources', () => {
        beforeEach(() => {
            manager.addResource(makeRecord({
                resourceId: 'arn:ep-1',
                resourceType: 'sagemaker-endpoint',
                project: 'project-a',
                status: 'active'
            }));
            manager.addResource(makeRecord({
                resourceId: 'arn:ep-2',
                resourceType: 'sagemaker-model',
                project: 'project-a',
                status: 'deleted'
            }));
            manager.addResource(makeRecord({
                resourceId: 'arn:ep-3',
                resourceType: 'sagemaker-endpoint',
                project: 'project-b',
                status: 'active'
            }));
        });

        it('returns all resources with no filters', () => {
            const resources = manager.listResources();
            assert.strictEqual(resources.length, 3);
        });

        it('returns all resources with empty filter object', () => {
            const resources = manager.listResources({});
            assert.strictEqual(resources.length, 3);
        });

        it('filters by resourceType', () => {
            const resources = manager.listResources({ resourceType: 'sagemaker-endpoint' });
            assert.strictEqual(resources.length, 2);
            assert.ok(resources.every(r => r.resourceType === 'sagemaker-endpoint'));
        });

        it('filters by project', () => {
            const resources = manager.listResources({ project: 'project-a' });
            assert.strictEqual(resources.length, 2);
            assert.ok(resources.every(r => r.project === 'project-a'));
        });

        it('filters by status', () => {
            const resources = manager.listResources({ status: 'deleted' });
            assert.strictEqual(resources.length, 1);
            assert.strictEqual(resources[0].resourceId, 'arn:ep-2');
        });

        it('applies AND logic for multiple filters', () => {
            const resources = manager.listResources({
                resourceType: 'sagemaker-endpoint',
                project: 'project-a'
            });
            assert.strictEqual(resources.length, 1);
            assert.strictEqual(resources[0].resourceId, 'arn:ep-1');
        });

        it('returns empty array when no resources match', () => {
            const resources = manager.listResources({ status: 'unknown' });
            assert.strictEqual(resources.length, 0);
        });
    });

    // ---------------------------------------------------------------
    // getResourcesByProject (Requirement 6.2)
    // ---------------------------------------------------------------
    describe('getResourcesByProject', () => {
        it('groups resources by project name', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:1', project: 'proj-a' }));
            manager.addResource(makeRecord({ resourceId: 'arn:2', project: 'proj-a' }));
            manager.addResource(makeRecord({ resourceId: 'arn:3', project: 'proj-b' }));

            const grouped = manager.getResourcesByProject();
            assert.ok(grouped instanceof Map);
            assert.strictEqual(grouped.size, 2);
            assert.strictEqual(grouped.get('proj-a').length, 2);
            assert.strictEqual(grouped.get('proj-b').length, 1);
        });

        it('returns empty map for empty manifest', () => {
            const grouped = manager.getResourcesByProject();
            assert.ok(grouped instanceof Map);
            assert.strictEqual(grouped.size, 0);
        });

        it('union of all groups equals total resources', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:1', project: 'proj-a' }));
            manager.addResource(makeRecord({ resourceId: 'arn:2', project: 'proj-b' }));
            manager.addResource(makeRecord({ resourceId: 'arn:3', project: 'proj-c' }));

            const grouped = manager.getResourcesByProject();
            let total = 0;
            for (const resources of grouped.values()) {
                total += resources.length;
            }
            assert.strictEqual(total, 3);
        });
    });

    // ---------------------------------------------------------------
    // getStatusCounts (Requirement 6.6)
    // ---------------------------------------------------------------
    describe('getStatusCounts', () => {
        it('counts resources by status', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:1', status: 'active' }));
            manager.addResource(makeRecord({ resourceId: 'arn:2', status: 'active' }));
            manager.addResource(makeRecord({ resourceId: 'arn:3', status: 'deleted' }));
            manager.addResource(makeRecord({ resourceId: 'arn:4', status: 'unknown' }));

            const counts = manager.getStatusCounts();
            assert.strictEqual(counts.active, 2);
            assert.strictEqual(counts.deleted, 1);
            assert.strictEqual(counts.unknown, 1);
        });

        it('returns all zeros for empty manifest', () => {
            const counts = manager.getStatusCounts();
            assert.deepStrictEqual(counts, { active: 0, deleted: 0, unknown: 0 });
        });

        it('sum of counts equals total resource count', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:1', status: 'active' }));
            manager.addResource(makeRecord({ resourceId: 'arn:2', status: 'deleted' }));
            manager.addResource(makeRecord({ resourceId: 'arn:3', status: 'unknown' }));

            const counts = manager.getStatusCounts();
            const total = counts.active + counts.deleted + counts.unknown;
            assert.strictEqual(total, 3);
        });
    });

    // ---------------------------------------------------------------
    // Round-trip integrity (Requirement 1.7)
    // ---------------------------------------------------------------
    describe('round-trip integrity', () => {
        it('reading then writing produces equivalent content', () => {
            manager.addResource(makeRecord({ resourceId: 'arn:1' }));
            manager.addResource(makeRecord({ resourceId: 'arn:2', resourceType: 'ecr-image' }));

            const contentBefore = readFileSync(manager.manifestPath, 'utf8');

            // Read and write back
            const manifest = manager._readManifest();
            manager._writeManifest(manifest);

            const contentAfter = readFileSync(manager.manifestPath, 'utf8');
            assert.strictEqual(contentAfter, contentBefore);
        });
    });

    // ---------------------------------------------------------------
    // Exported constants
    // ---------------------------------------------------------------
    describe('exported constants', () => {
        it('SCHEMA_VERSION matches YYYY-MM-DD format', () => {
            assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(SCHEMA_VERSION), `SCHEMA_VERSION should match YYYY-MM-DD: ${SCHEMA_VERSION}`);
        });

        it('VALID_RESOURCE_TYPES contains 12 types', () => {
            assert.strictEqual(VALID_RESOURCE_TYPES.length, 12);
        });

        it('VALID_STATUSES contains active, deleted, unknown', () => {
            assert.deepStrictEqual(VALID_STATUSES, ['active', 'deleted', 'unknown']);
        });
    });
});
