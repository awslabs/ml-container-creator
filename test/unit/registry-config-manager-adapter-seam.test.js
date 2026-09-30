// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wave 5 (ADR-006, option A): RegistryConfigManager routes its accelerator and
 * env-var results through the unified Finding vocabulary and rebuilds the legacy
 * shapes at the validation-adapters boundary. These tests pin that the seam is
 * behaviour-preserving: the caller-facing shapes ({compatible,error,warning,info,
 * recommendations} and {errors,warnings,strategiesUsed}) are identical to what
 * the accelerator engine produced before the rewiring.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import RegistryConfigManager from '../../src/lib/registry-config-manager.js';

describe('RegistryConfigManager — accelerator adapter seam', () => {
    it('returns compatible+info when the framework has no accelerator requirement', () => {
        const mgr = new RegistryConfigManager();
        mgr.instanceMapping = { 'ml.m5.large': { accelerator: { type: 'cpu', versions: ['any'] } } };

        const result = mgr.validateInstanceType('ml.m5.large', { accelerator: null });
        assert.strictEqual(result.compatible, true);
        assert.ok(result.info.includes('No accelerator requirements'));
    });

    it('returns compatible+warning when the instance has no accelerator data', () => {
        const mgr = new RegistryConfigManager();
        mgr.instanceMapping = {}; // no data for the requested instance

        const result = mgr.validateInstanceType('ml.unknown.type', {
            accelerator: { type: 'cuda', version: '12.1' }
        });
        assert.strictEqual(result.compatible, true);
        assert.ok(result.warning.includes('No accelerator data'));
    });

    it('passes through a compatible accelerator match with an info message', () => {
        const mgr = new RegistryConfigManager();
        mgr.instanceMapping = {
            'ml.g5.xlarge': { accelerator: { type: 'cuda', versions: ['12.1', '12.2'] } }
        };

        const result = mgr.validateInstanceType('ml.g5.xlarge', {
            accelerator: { type: 'cuda', version: '12.1' }
        });
        assert.strictEqual(result.compatible, true);
        assert.ok(result.info.includes('12.1'));
        assert.strictEqual(result.recommendations, undefined);
    });

    it('reports incompatibility with an error and recommendation list', () => {
        const mgr = new RegistryConfigManager();
        mgr.instanceMapping = {
            'ml.g4dn.xlarge': { accelerator: { type: 'cuda', versions: ['11.8'] } },
            'ml.g5.xlarge': { accelerator: { type: 'cuda', versions: ['12.1'] } }
        };

        const result = mgr.validateInstanceType('ml.g4dn.xlarge', {
            accelerator: { type: 'cuda', version: '12.1' }
        });
        assert.strictEqual(result.compatible, false);
        assert.ok(result.error.includes('12.1'));
        assert.ok(Array.isArray(result.recommendations));
        assert.ok(result.recommendations.includes('ml.g5.xlarge'));
    });
});

describe('RegistryConfigManager — env-var adapter seam', () => {
    it('rebuilds {errors,warnings,strategiesUsed} preserving per-variable keys', () => {
        const mgr = new RegistryConfigManager();
        mgr.validateEnvVars = true;

        const frameworkConfig = {
            knownFlags: {
                MAX_BATCH_SIZE: { type: 'integer', min: 1, max: 128 },
                OLD_FLAG: { type: 'string', deprecated: true, replacement: 'NEW_FLAG' }
            }
        };
        const envVars = { MAX_BATCH_SIZE: 'not-a-number', OLD_FLAG: 'x' };

        const result = mgr.validateEnvironmentVariables(envVars, frameworkConfig);

        assert.ok(Array.isArray(result.errors));
        assert.ok(Array.isArray(result.warnings));
        assert.ok(result.strategiesUsed.includes('known-flags-registry'));

        const typeError = result.errors.find(e => e.variable === 'MAX_BATCH_SIZE');
        assert.ok(typeError, 'error entry keeps its `variable` key');
        assert.ok(typeError.message.includes('type'));

        const deprecation = result.warnings.find(w => w.variable === 'OLD_FLAG');
        assert.ok(deprecation, 'warning entry keeps its `variable` key');
        assert.strictEqual(deprecation.replacement, 'NEW_FLAG', 'extra keys survive the round-trip');
    });

    it('returns empty results with no strategies when validation is disabled', () => {
        const mgr = new RegistryConfigManager();
        mgr.validateEnvVars = false;

        const result = mgr.validateEnvironmentVariables(
            { ANY: '1' },
            { knownFlags: { ANY: { type: 'integer' } } }
        );
        assert.deepStrictEqual(result, { errors: [], warnings: [], strategiesUsed: [] });
    });
});
