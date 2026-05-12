// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ConfigManager Secrets Integration Tests
 *
 * Tests for hfTokenArn and ngcTokenArn fields in ConfigManager,
 * including mutual exclusion validation and CLI flag wiring.
 *
 * Requirements: 7.3, 7.4
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ConfigManager from '../../src/lib/config-manager.js';
import { createMockGeneratorWithOptions } from '../helpers/mock-generator.js';

describe('ConfigManager Secrets Integration (Requirements 7.3, 7.4)', () => {
    describe('hfTokenArn parameter matrix entry', () => {
        it('should include hfTokenArn in the parameter matrix', () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({}));
            const matrix = configManager.parameterMatrix;

            assert.ok(matrix.hfTokenArn, 'hfTokenArn should exist in parameter matrix');
            assert.strictEqual(matrix.hfTokenArn.cliOption, 'hf-token-arn');
            assert.strictEqual(matrix.hfTokenArn.default, null);
            assert.strictEqual(matrix.hfTokenArn.required, false);
            assert.strictEqual(matrix.hfTokenArn.configFile, true);
        });

        it('should default hfTokenArn to null', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({}));
            const config = await configManager.loadConfiguration();

            assert.strictEqual(config.hfTokenArn, null);
        });

        it('should load hfTokenArn from CLI option', async () => {
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'hf-token-arn': arn
            }));
            const config = await configManager.loadConfiguration();

            assert.strictEqual(config.hfTokenArn, arn);
        });
    });

    describe('ngcTokenArn parameter matrix entry', () => {
        it('should include ngcTokenArn in the parameter matrix', () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({}));
            const matrix = configManager.parameterMatrix;

            assert.ok(matrix.ngcTokenArn, 'ngcTokenArn should exist in parameter matrix');
            assert.strictEqual(matrix.ngcTokenArn.cliOption, 'ngc-token-arn');
            assert.strictEqual(matrix.ngcTokenArn.default, null);
            assert.strictEqual(matrix.ngcTokenArn.required, false);
            assert.strictEqual(matrix.ngcTokenArn.configFile, true);
        });

        it('should default ngcTokenArn to null', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({}));
            const config = await configManager.loadConfiguration();

            assert.strictEqual(config.ngcTokenArn, null);
        });

        it('should load ngcTokenArn from CLI option', async () => {
            const arn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:mlcc/ngc-token/ci-XyZaBc';
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'ngc-token-arn': arn
            }));
            const config = await configManager.loadConfiguration();

            assert.strictEqual(config.ngcTokenArn, arn);
        });
    });

    describe('Mutual exclusion validation', () => {
        it('should produce error when both hfToken and hfTokenArn are set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'hf-token': 'hf_plaintext123',
                'hf-token-arn': 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf'
            }));
            await configManager.loadConfiguration();

            const errors = configManager.validateConfiguration();

            assert.ok(
                errors.some(e => e.includes('--hf-token') && e.includes('--hf-token-arn')),
                `Expected mutual exclusion error for hf-token, got: ${JSON.stringify(errors)}`
            );
        });

        it('should not produce error when only hfToken is set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'hf-token': 'hf_plaintext123',
                'deployment-config': 'http-flask'
            }));
            await configManager.loadConfiguration();

            const errors = configManager.validateConfiguration();

            assert.ok(
                !errors.some(e => e.includes('--hf-token') && e.includes('--hf-token-arn')),
                `Should not produce mutual exclusion error, got: ${JSON.stringify(errors)}`
            );
        });

        it('should not produce error when only hfTokenArn is set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'hf-token-arn': 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf',
                'deployment-config': 'http-flask'
            }));
            await configManager.loadConfiguration();

            const errors = configManager.validateConfiguration();

            assert.ok(
                !errors.some(e => e.includes('--hf-token') && e.includes('--hf-token-arn')),
                `Should not produce mutual exclusion error, got: ${JSON.stringify(errors)}`
            );
        });

        it('should produce error when both ngcToken and ngcTokenArn are set via CLI', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'ngc-token': 'nvapi-test123',
                'ngc-token-arn': 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-AbCdEf'
            }));
            await configManager.loadConfiguration();

            const errors = configManager.validateConfiguration();

            assert.ok(
                errors.some(e => e.includes('--ngc-token') && e.includes('--ngc-token-arn')),
                `Expected mutual exclusion error for ngc-token, got: ${JSON.stringify(errors)}`
            );
        });

        it('should not produce error when only ngcTokenArn is set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'ngc-token-arn': 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-AbCdEf',
                'deployment-config': 'http-flask'
            }));
            await configManager.loadConfiguration();

            const errors = configManager.validateConfiguration();

            assert.ok(
                !errors.some(e => e.includes('--ngc-token') && e.includes('--ngc-token-arn')),
                `Should not produce mutual exclusion error, got: ${JSON.stringify(errors)}`
            );
        });
    });

    describe('getFinalConfiguration() mutual exclusion enforcement', () => {
        it('should clear hfToken when hfTokenArn is set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'hf-token-arn': 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf'
            }));
            await configManager.loadConfiguration();

            const finalConfig = configManager.getFinalConfiguration({
                hfToken: 'hf_shouldbecleared',
                deploymentConfig: 'http-flask'
            });

            assert.strictEqual(finalConfig.hfToken, null, 'hfToken should be null when hfTokenArn is set');
            assert.strictEqual(
                finalConfig.hfTokenArn,
                'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf'
            );
        });

        it('should clear ngcApiKey when ngcTokenArn is set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'ngc-token-arn': 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-AbCdEf'
            }));
            await configManager.loadConfiguration();

            const finalConfig = configManager.getFinalConfiguration({
                ngcApiKey: 'nvapi-shouldbecleared',
                deploymentConfig: 'http-flask'
            });

            assert.strictEqual(finalConfig.ngcApiKey, null, 'ngcApiKey should be null when ngcTokenArn is set');
            assert.strictEqual(
                finalConfig.ngcTokenArn,
                'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-AbCdEf'
            );
        });

        it('should preserve hfToken when no ARN is set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'hf-token': 'hf_mytoken123'
            }));
            await configManager.loadConfiguration();

            const finalConfig = configManager.getFinalConfiguration({
                deploymentConfig: 'http-flask'
            });

            assert.strictEqual(finalConfig.hfToken, 'hf_mytoken123');
            assert.strictEqual(finalConfig.hfTokenArn, null);
        });

        it('should preserve ngcApiKey when no ARN is set', async () => {
            const configManager = new ConfigManager(createMockGeneratorWithOptions({}));
            await configManager.loadConfiguration();

            const finalConfig = configManager.getFinalConfiguration({
                ngcApiKey: 'nvapi-mykey456',
                deploymentConfig: 'http-flask'
            });

            assert.strictEqual(finalConfig.ngcApiKey, 'nvapi-mykey456');
            assert.strictEqual(finalConfig.ngcTokenArn, null);
        });
    });

    describe('ARN stored in explicit configuration', () => {
        it('should track hfTokenArn as explicit config when provided via CLI', async () => {
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'hf-token-arn': arn
            }));
            await configManager.loadConfiguration();

            const explicit = configManager.getExplicitConfiguration();
            assert.strictEqual(explicit.hfTokenArn, arn);
        });

        it('should track ngcTokenArn as explicit config when provided via CLI', async () => {
            const arn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:mlcc/ngc-token/ci-XyZaBc';
            const configManager = new ConfigManager(createMockGeneratorWithOptions({
                'ngc-token-arn': arn
            }));
            await configManager.loadConfiguration();

            const explicit = configManager.getExplicitConfiguration();
            assert.strictEqual(explicit.ngcTokenArn, arn);
        });
    });
});
