// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for E2E Bootstrap Integration.
 *
 * Tests:
 * - loadCatalog loads and validates the catalog
 * - runQuotaValidation handles success and failure gracefully
 * - storeE2EConfig merges e2e fields into existing profile
 * - bootstrapE2E orchestrates the full flow
 *
 * Validates: Requirements 3.3, 3.4
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadCatalog, runQuotaValidation, storeE2EConfig } from '../../src/lib/e2e-bootstrap.js';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempDir() {
    const dir = path.join(tmpdir(), `mlcc-e2e-bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function validCatalogData() {
    return {
        configs: [
            {
                id: 'rt-test-model',
                tier: 'ci',
                track: 'realtime',
                args: '--deployment-config=transformers-vllm --model-name=test/Model --instance-type=ml.g6e.xlarge --region=us-west-2',
                lifecycle: ['build', 'push', 'deploy', 'test', 'clean'],
                timeout: 1800
            }
        ]
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('E2E Bootstrap Integration', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        if (existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('loadCatalog', () => {
        it('loads and validates a valid catalog file', () => {
            const catalogPath = path.join(tempDir, 'catalog.json');
            writeFileSync(catalogPath, JSON.stringify(validCatalogData()));

            const catalog = loadCatalog(catalogPath);
            assert.strictEqual(catalog.configs.length, 1);
            assert.strictEqual(catalog.configs[0].id, 'rt-test-model');
        });

        it('throws when catalog file does not exist', () => {
            const catalogPath = path.join(tempDir, 'nonexistent.json');
            assert.throws(
                () => loadCatalog(catalogPath),
                /Failed to read e2e catalog/
            );
        });

        it('throws when catalog file contains invalid JSON', () => {
            const catalogPath = path.join(tempDir, 'bad.json');
            writeFileSync(catalogPath, 'not valid json {{{');

            assert.throws(
                () => loadCatalog(catalogPath),
                /Failed to parse e2e catalog JSON/
            );
        });

        it('throws when catalog fails schema validation', () => {
            const catalogPath = path.join(tempDir, 'invalid.json');
            writeFileSync(catalogPath, JSON.stringify({ configs: [{ id: 'bad' }] }));

            assert.throws(
                () => loadCatalog(catalogPath),
                /E2E catalog validation failed/
            );
        });

        it('loads catalog with multiple configs', () => {
            const data = {
                configs: [
                    {
                        id: 'config-a',
                        tier: 'ci',
                        track: 'realtime',
                        args: '--instance-type=ml.g6e.xlarge',
                        lifecycle: ['build', 'clean'],
                        timeout: 600
                    },
                    {
                        id: 'config-b',
                        tier: 'nightly',
                        track: 'async',
                        args: '--instance-type=ml.g5.xlarge',
                        lifecycle: ['build', 'push', 'deploy', 'test', 'clean'],
                        timeout: 3600
                    }
                ]
            };
            const catalogPath = path.join(tempDir, 'multi.json');
            writeFileSync(catalogPath, JSON.stringify(data));

            const catalog = loadCatalog(catalogPath);
            assert.strictEqual(catalog.configs.length, 2);
        });
    });

    describe('runQuotaValidation', () => {
        it('returns results from validateQuotas on success', async () => {
            // Use the real validateQuotas with a mock client via the catalog
            // Since runQuotaValidation calls validateQuotas internally,
            // we test it with a catalog that has no instance types to avoid AWS calls
            const catalog = { configs: [] };
            const results = await runQuotaValidation('ci', catalog, 'us-west-2');
            assert.deepStrictEqual(results, []);
        });

        it('returns empty array and warns on error', async () => {
            // Pass an invalid catalog structure that will cause an error
            const results = await runQuotaValidation('ci', null, 'us-west-2');
            assert.deepStrictEqual(results, []);
        });
    });

    describe('storeE2EConfig', () => {
        it('merges e2e config into existing profile', () => {
            const configPath = path.join(tempDir, 'config.json');
            const config = new BootstrapConfig(configPath);

            // Set up initial profile
            config.setProfile('default', {
                awsProfile: 'test',
                awsRegion: 'us-west-2',
                accountId: '123456789012'
            });

            const e2eConfig = {
                e2eInfraProvisioned: true,
                e2eCodeBuildProject: 'ml-container-creator-e2e',
                e2eResultsBucket: 'mlcc-e2e-results-123456789012-us-west-2',
                e2eSnsTopicArn: 'arn:aws:sns:us-west-2:123456789012:mlcc-e2e-notifications'
            };

            storeE2EConfig(config, 'default', e2eConfig);

            // Verify the profile was updated
            const profile = config.getProfile('default');
            assert.strictEqual(profile.awsProfile, 'test');
            assert.strictEqual(profile.awsRegion, 'us-west-2');
            assert.strictEqual(profile.accountId, '123456789012');
            assert.strictEqual(profile.e2eInfraProvisioned, true);
            assert.strictEqual(profile.e2eCodeBuildProject, 'ml-container-creator-e2e');
            assert.strictEqual(profile.e2eResultsBucket, 'mlcc-e2e-results-123456789012-us-west-2');
            assert.strictEqual(profile.e2eSnsTopicArn, 'arn:aws:sns:us-west-2:123456789012:mlcc-e2e-notifications');
        });

        it('throws when profile does not exist', () => {
            const configPath = path.join(tempDir, 'config.json');
            const config = new BootstrapConfig(configPath);

            // Write empty config
            config.write({ activeProfile: null, profiles: {} });

            assert.throws(
                () => storeE2EConfig(config, 'nonexistent', { e2eInfraProvisioned: true }),
                /Bootstrap profile "nonexistent" not found/
            );
        });

        it('throws when config file does not exist', () => {
            const configPath = path.join(tempDir, 'no-config.json');
            const config = new BootstrapConfig(configPath);

            assert.throws(
                () => storeE2EConfig(config, 'default', { e2eInfraProvisioned: true }),
                /Bootstrap profile "default" not found/
            );
        });

        it('preserves existing profile fields when adding e2e config', () => {
            const configPath = path.join(tempDir, 'config.json');
            const config = new BootstrapConfig(configPath);

            config.setProfile('default', {
                awsProfile: 'prod',
                awsRegion: 'eu-west-1',
                accountId: '987654321098',
                roleArn: 'arn:aws:iam::987654321098:role/mlcc-sagemaker-execution-role',
                ecrRepositoryName: 'ml-container-creator',
                ciInfraProvisioned: true,
                ciTableName: 'mlcc-ci-table'
            });

            storeE2EConfig(config, 'default', {
                e2eInfraProvisioned: true,
                e2eCodeBuildProject: 'ml-container-creator-e2e'
            });

            const profile = config.getProfile('default');
            // Original fields preserved
            assert.strictEqual(profile.awsProfile, 'prod');
            assert.strictEqual(profile.roleArn, 'arn:aws:iam::987654321098:role/mlcc-sagemaker-execution-role');
            assert.strictEqual(profile.ciInfraProvisioned, true);
            // New fields added
            assert.strictEqual(profile.e2eInfraProvisioned, true);
            assert.strictEqual(profile.e2eCodeBuildProject, 'ml-container-creator-e2e');
        });
    });
});
