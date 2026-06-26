// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync validation test for optimization-space.json and path-prover-brain.js.
 *
 * Ensures that:
 * 1. config/optimization-space.json is valid and loadable
 * 2. Every "sweepable" dimension has a corresponding awareness in CONFIG_DIMENSIONS
 * 3. The mapping between optimization dimensions and prove dimensions stays aligned
 * 4. The schema is well-formed (has required fields per dimension)
 *
 * If these tests fail, it means optimization-space.json and path-prover-brain.js
 * have drifted apart — update one to match the other.
 *
 * Feature: ci-benchmark-pipeline
 * Validates: Requirements AC-3.5, AC-3.7
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CONFIG_DIMENSIONS,
    loadOptimizationSpace,
    getSweepableDimensions
} from '../../src/lib/path-prover-brain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Mapping between optimization-space dimension names and CONFIG_DIMENSIONS ─
// This is the authoritative mapping. If a sweepable dimension in optimization-space.json
// maps to a CONFIG_DIMENSIONS entry, it must be listed here.
const OPTIMIZATION_TO_PROVE_DIMENSION_MAP = {
    quantization: 'quantization',
    tensor_parallelism: 'tp_degree'
    // max_model_len, kv_cache_dtype are optimization dimensions that don't directly
    // map to prove dimensions (they are sweep parameters, not Cartesian axes)
};

// ── Schema Loading Tests ─────────────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Optimization Space Schema: Loading', () => {

    it('config/optimization-space.json exists and is valid JSON', () => {
        // **Validates: Requirements AC-3.1, AC-3.4**
        const schemaPath = resolve(__dirname, '..', '..', 'config', 'optimization-space.json');
        const raw = readFileSync(schemaPath, 'utf8');
        const schema = JSON.parse(raw);

        assert.ok(schema, 'Schema should parse as valid JSON');
        assert.ok(schema.schema_version, 'Schema must have schema_version field');
        assert.ok(schema.dimensions, 'Schema must have dimensions object');
    });

    it('loadOptimizationSpace() returns the schema successfully', () => {
        // **Validates: Requirements AC-3.5**
        const schema = loadOptimizationSpace();

        assert.ok(schema, 'loadOptimizationSpace() should return a non-null object');
        assert.strictEqual(schema.schema_version, '1.0');
        assert.ok(schema.dimensions, 'Schema must have dimensions');
    });

    it('getSweepableDimensions() returns sweepable dimension names', () => {
        // **Validates: Requirements AC-3.6**
        const sweepable = getSweepableDimensions();

        assert.ok(Array.isArray(sweepable), 'Should return an array');
        assert.ok(sweepable.length > 0, 'Should have at least one sweepable dimension');
        assert.ok(sweepable.includes('quantization'), 'quantization should be sweepable');
        assert.ok(sweepable.includes('tensor_parallelism'), 'tensor_parallelism should be sweepable');
    });
});

// ── Schema Structure Tests ───────────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Optimization Space Schema: Structure', () => {

    let schema;

    before(() => {
        schema = loadOptimizationSpace();
    });

    it('has schema_version field (AC-3.4)', () => {
        assert.ok(schema.schema_version, 'Must have schema_version');
        assert.strictEqual(typeof schema.schema_version, 'string');
    });

    it('defines all required dimensions (AC-3.2)', () => {
        const requiredDimensions = [
            'quantization',
            'tensor_parallelism',
            'max_model_len',
            'batching',
            'max_batch_size',
            'kv_cache_dtype',
            'speculative_decoding'
        ];

        for (const dim of requiredDimensions) {
            assert.ok(
                schema.dimensions[dim],
                `Missing required dimension: ${dim}`
            );
        }
    });

    it('each dimension has required fields: type, default, description, status (AC-3.3, AC-3.6)', () => {
        for (const [name, dim] of Object.entries(schema.dimensions)) {
            assert.ok(dim.type, `${name} must have "type" field`);
            assert.ok(dim.default !== undefined, `${name} must have "default" field`);
            assert.ok(dim.description, `${name} must have "description" field`);
            assert.ok(dim.status, `${name} must have "status" field`);
            assert.ok(
                ['sweepable', 'future'].includes(dim.status),
                `${name} status must be "sweepable" or "future", got "${dim.status}"`
            );
        }
    });

    it('categorical dimensions have "values" array (AC-3.3)', () => {
        for (const [name, dim] of Object.entries(schema.dimensions)) {
            if (dim.type === 'categorical') {
                assert.ok(
                    Array.isArray(dim.values),
                    `${name} (categorical) must have "values" array`
                );
                assert.ok(
                    dim.values.length > 0,
                    `${name} (categorical) must have at least one value`
                );
            }
        }
    });

    it('range dimensions have "min" and "max" fields', () => {
        for (const [name, dim] of Object.entries(schema.dimensions)) {
            if (dim.type === 'range') {
                assert.ok(
                    dim.min !== undefined,
                    `${name} (range) must have "min" field`
                );
                assert.ok(
                    dim.max !== undefined,
                    `${name} (range) must have "max" field`
                );
                assert.ok(
                    dim.min < dim.max,
                    `${name} (range) min must be less than max`
                );
            }
        }
    });

    it('default values are valid for each dimension', () => {
        for (const [name, dim] of Object.entries(schema.dimensions)) {
            if (dim.type === 'categorical') {
                assert.ok(
                    dim.values.includes(dim.default),
                    `${name} default "${dim.default}" must be in values array`
                );
            } else if (dim.type === 'range') {
                assert.ok(
                    dim.default >= dim.min && dim.default <= dim.max,
                    `${name} default ${dim.default} must be within [${dim.min}, ${dim.max}]`
                );
            }
        }
    });
});

// ── Sync Validation Tests (AC-3.7) ──────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline — Optimization Space Schema: Sync with CONFIG_DIMENSIONS (AC-3.7)', () => {

    let schema;
    let sweepableDimensions;

    before(() => {
        schema = loadOptimizationSpace();
        sweepableDimensions = getSweepableDimensions(schema);
    });

    it('every sweepable dimension that maps to a prove dimension exists in CONFIG_DIMENSIONS', () => {
        // For each sweepable dimension that has a known mapping to a prove dimension,
        // verify the prove dimension exists in CONFIG_DIMENSIONS
        for (const optDim of sweepableDimensions) {
            const proveDim = OPTIMIZATION_TO_PROVE_DIMENSION_MAP[optDim];
            if (proveDim) {
                assert.ok(
                    CONFIG_DIMENSIONS.includes(proveDim),
                    `Sweepable dimension "${optDim}" maps to prove dimension "${proveDim}" ` +
                    `which is NOT in CONFIG_DIMENSIONS: [${CONFIG_DIMENSIONS.join(', ')}]. ` +
                    `Either add "${proveDim}" to CONFIG_DIMENSIONS or update the mapping.`
                );
            }
        }
    });

    it('no sweepable dimension is added without brain awareness (drift detection)', () => {
        // Every sweepable dimension must either:
        // 1. Have a mapping entry in OPTIMIZATION_TO_PROVE_DIMENSION_MAP, OR
        // 2. Be an optimization-only dimension (sweep param, not a Cartesian axis)
        //
        // If a new sweepable dimension is added that SHOULD be a prove dimension,
        // it must be added to OPTIMIZATION_TO_PROVE_DIMENSION_MAP above.
        //
        // Known optimization-only dimensions (sweepable but not prove axes):
        const OPTIMIZATION_ONLY_DIMENSIONS = ['max_model_len', 'kv_cache_dtype'];

        for (const optDim of sweepableDimensions) {
            const hasMappedProveDim = optDim in OPTIMIZATION_TO_PROVE_DIMENSION_MAP;
            const isOptimizationOnly = OPTIMIZATION_ONLY_DIMENSIONS.includes(optDim);

            assert.ok(
                hasMappedProveDim || isOptimizationOnly,
                `Sweepable dimension "${optDim}" is not accounted for! ` +
                'Add it to OPTIMIZATION_TO_PROVE_DIMENSION_MAP (if it maps to a prove dimension) ' +
                'or to OPTIMIZATION_ONLY_DIMENSIONS (if it\'s optimization-only). ' +
                'This prevents silent drift between optimization-space.json and path-prover-brain.js.'
            );
        }
    });

    it('mapped prove dimensions still exist in CONFIG_DIMENSIONS (reverse sync)', () => {
        // Ensure none of the mapped prove dimensions have been removed from CONFIG_DIMENSIONS
        for (const [optDim, proveDim] of Object.entries(OPTIMIZATION_TO_PROVE_DIMENSION_MAP)) {
            assert.ok(
                CONFIG_DIMENSIONS.includes(proveDim),
                `OPTIMIZATION_TO_PROVE_DIMENSION_MAP maps "${optDim}" → "${proveDim}" ` +
                `but "${proveDim}" no longer exists in CONFIG_DIMENSIONS. ` +
                'Update the mapping or restore the dimension.'
            );
        }
    });

    it('CONFIG_DIMENSIONS has not lost quantization or tp_degree', () => {
        // These are the critical prove dimensions that correspond to sweepable optimization dims
        assert.ok(
            CONFIG_DIMENSIONS.includes('quantization'),
            'CONFIG_DIMENSIONS must include "quantization" (maps to optimization-space quantization)'
        );
        assert.ok(
            CONFIG_DIMENSIONS.includes('tp_degree'),
            'CONFIG_DIMENSIONS must include "tp_degree" (maps to optimization-space tensor_parallelism)'
        );
    });
});
