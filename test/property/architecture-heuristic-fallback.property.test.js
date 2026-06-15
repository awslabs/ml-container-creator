// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture-Based Heuristic Fallback Property Test
 *
 * Feature: mcp-catalog-consolidation, Property 5: Architecture-based heuristic fallback correctness
 *
 * For any modelType value, when the Instance_Sizer returns an empty recommendation list,
 * the Prompt_Runner SHALL select the correct heuristic default.
 *
 * Validates: Requirements 3.9, 4.6
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import PromptRunner from '../../src/lib/prompt-runner.js';
import { NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 30000,
    verbose: false
};

// Expected heuristic defaults from the design doc
const EXPECTED_DEFAULTS = {
    'transformers': 'ml.g5.xlarge',
    'transformer': 'ml.g5.xlarge',
    'diffusors': 'ml.g5.2xlarge',
    'diffusor': 'ml.g5.2xlarge',
    'predictor': 'ml.m5.large',
    'http': 'ml.m5.large'
};

describe('Feature: mcp-catalog-consolidation, Property 5: Architecture-based heuristic fallback correctness', function () {
    this.timeout(30000);

    // Create a minimal PromptRunner instance to test the heuristic method
    const runner = new PromptRunner({ configManager: null, options: {} });

    it('for any known architecture, returns the correct heuristic default', () => {
        const arbArchitecture = fc.constantFrom(
            'transformers', 'transformer', 'diffusors', 'diffusor', 'predictor', 'http'
        );

        fc.assert(
            fc.property(arbArchitecture, (architecture) => {
                const result = runner._getArchitectureHeuristicDefault(architecture);
                assert.strictEqual(
                    result,
                    EXPECTED_DEFAULTS[architecture],
                    `Architecture "${architecture}" should default to ${EXPECTED_DEFAULTS[architecture]}, got ${result}`
                );
            }),
            PROPERTY_CONFIG
        );
    });

    it('for unknown architectures, falls back to ml.g5.xlarge', () => {
        const arbUnknown = fc.string({ minLength: 1, maxLength: 20 })
            .filter(s => !Object.keys(EXPECTED_DEFAULTS).includes(s));

        fc.assert(
            fc.property(arbUnknown, (architecture) => {
                const result = runner._getArchitectureHeuristicDefault(architecture);
                assert.strictEqual(
                    result,
                    'ml.g5.xlarge',
                    `Unknown architecture "${architecture}" should default to ml.g5.xlarge, got ${result}`
                );
            }),
            PROPERTY_CONFIG
        );
    });

    it('transformer architectures always get GPU instances', () => {
        const arbTransformer = fc.constantFrom('transformers', 'transformer');

        fc.assert(
            fc.property(arbTransformer, (architecture) => {
                const result = runner._getArchitectureHeuristicDefault(architecture);
                assert.ok(
                    result.includes('g5') || result.includes('g4') || result.includes('p3'),
                    `Transformer architecture should get GPU instance, got ${result}`
                );
            }),
            PROPERTY_CONFIG
        );
    });

    it('predictor architectures always get CPU instances', () => {
        const arbPredictor = fc.constantFrom('predictor', 'http');

        fc.assert(
            fc.property(arbPredictor, (architecture) => {
                const result = runner._getArchitectureHeuristicDefault(architecture);
                assert.ok(
                    result.includes('m5') || result.includes('c5'),
                    `Predictor architecture should get CPU instance, got ${result}`
                );
            }),
            PROPERTY_CONFIG
        );
    });
});
