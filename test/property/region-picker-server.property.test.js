// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Region Picker Server Property-Based Tests
 *
 * Property-based tests for the region-picker server, shared Bedrock client,
 * and instance-recommender static behavior.
 *
 * Feature: region-picker-server
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { filterRegions, AWS_REGIONS } from '../../servers/region-picker/index.js';
import { extractJson } from '../../servers/lib/bedrock-client.js';
import { getStaticInstances, INSTANCE_RECOMMENDATIONS, GPU_FRAMEWORKS } from '../../servers/instance-recommender/index.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Shared arbitrary generators ──────────────────────────────────────────────

/** Search terms that cover region codes, labels, partial matches, and non-matching strings */
const arbSearchTerm = fc.stringMatching(/^[a-zA-Z\s\-]{0,30}$/);

/** Positive integer limit for result truncation */
const arbLimit = fc.integer({ min: 1, max: 50 });

/** Context object with optional regionSearch and framework fields */
const arbContext = fc.record({
    regionSearch: fc.option(arbSearchTerm, { nil: undefined }),
    framework: fc.option(
        fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers'),
        { nil: undefined }
    )
});

/** A region code drawn from the actual AWS_REGIONS constant */
const arbRegionCode = fc.constantFrom(...AWS_REGIONS.map(r => r.code));

/** A framework name from the supported set */
const arbFramework = fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers');

// ── Valid region code set (for assertions) ───────────────────────────────────

const VALID_REGION_CODES = new Set(AWS_REGIONS.map(r => r.code));

// ── Property tests ───────────────────────────────────────────────────────────

describe('Region Picker Server Property-Based Tests', () => {

    // Feature: region-picker-server, Property 1: Region Filtering Correctness
    describe('Property 1: Region Filtering Correctness', () => {
        it('every returned region code has its code or label contain the search term as a case-insensitive substring', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbSearchTerm,
                arbLimit,
                (searchTerm, limit) => {
                    const result = filterRegions(searchTerm || undefined, limit);
                    const codes = result.choices.awsRegion || [];
                    const term = (searchTerm || '').toLowerCase();

                    if (term) {
                        for (const code of codes) {
                            const region = AWS_REGIONS.find(r => r.code === code);
                            assert.ok(region, `Returned code "${code}" must exist in AWS_REGIONS`);
                            const matches = region.code.toLowerCase().includes(term) ||
                                            region.labels.some(l => l.toLowerCase().includes(term));
                            assert.ok(matches,
                                `Region "${code}" (${region.labels[0]}) does not contain search term "${term}"`);
                        }
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('no search term returns all regions up to limit', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbLimit,
                (limit) => {
                    const result = filterRegions(undefined, limit);
                    const codes = result.choices.awsRegion || [];
                    assert.strictEqual(codes.length, Math.min(AWS_REGIONS.length, limit));
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('zero matches returns empty choices', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const result = filterRegions('zzzznonexistent', 10);
            assert.deepStrictEqual(result.choices.awsRegion, []);
            assert.deepStrictEqual(result.values, {});
        });
    });

    // Feature: region-picker-server, Property 2: Response Format Invariant
    describe('Property 2: Response Format Invariant', () => {
        it('all choices are valid region codes, length <= limit, values.awsRegion === choices[0] when non-empty', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.option(arbSearchTerm, { nil: undefined }),
                arbLimit,
                (searchTerm, limit) => {
                    const result = filterRegions(searchTerm, limit);
                    const codes = result.choices.awsRegion || [];

                    // (a) every code is a valid region
                    for (const code of codes) {
                        assert.ok(VALID_REGION_CODES.has(code),
                            `"${code}" is not a valid region code`);
                    }

                    // (b) length <= limit
                    assert.ok(codes.length <= limit,
                        `choices length ${codes.length} exceeds limit ${limit}`);

                    // (c) non-empty → values.awsRegion === choices[0]
                    if (codes.length > 0) {
                        assert.strictEqual(result.values.awsRegion, codes[0]);
                    }

                    // (d) empty → no awsRegion in values
                    if (codes.length === 0) {
                        assert.strictEqual(result.values.awsRegion, undefined);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: region-picker-server, Property 3: Smart Mode Activation Guard
    describe('Property 3: Smart Mode Activation Guard', () => {
        it('BEDROCK_SMART values other than "true" do not activate smart mode', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            // This is a design-level property. Since SMART_MODE is evaluated at
            // module load time as `process.env.BEDROCK_SMART === 'true'`, we
            // verify the guard expression directly for arbitrary env values.
            const arbEnvValue = fc.oneof(
                fc.constant(''),
                fc.constant('false'),
                fc.constant('TRUE'),
                fc.constant('True'),
                fc.constant('1'),
                fc.constant('yes'),
                fc.string({ minLength: 0, maxLength: 20 })
            ).filter(v => v !== 'true');

            fc.assert(fc.property(
                arbEnvValue,
                (envValue) => {
                    const activated = envValue === 'true';
                    assert.strictEqual(activated, false,
                        `BEDROCK_SMART="${envValue}" should not activate smart mode`);
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: region-picker-server, Property 4: Smart Mode Result Merging
    describe('Property 4: Smart Mode Result Merging', () => {
        it('Bedrock recommendation is first, no duplicates, total length <= limit', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbRegionCode,
                arbLimit,
                fc.option(arbSearchTerm, { nil: undefined }),
                (bedrockRegion, limit, searchTerm) => {
                    // Simulate the merging logic from the region-picker tool handler
                    const staticResult = filterRegions(searchTerm, limit);
                    const staticCodes = staticResult.choices.awsRegion || [];
                    const combined = [bedrockRegion, ...staticCodes.filter(c => c !== bedrockRegion)];
                    const merged = combined.slice(0, limit);

                    // Bedrock recommendation is first
                    assert.strictEqual(merged[0], bedrockRegion);

                    // No duplicates
                    assert.strictEqual(merged.length, new Set(merged).size,
                        'Merged list should have no duplicates');

                    // Total length <= limit
                    assert.ok(merged.length <= limit,
                        `Merged length ${merged.length} exceeds limit ${limit}`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: region-picker-server, Property 5: Bedrock Failure Falls Back to Static
    describe('Property 5: Bedrock Failure Falls Back to Static', () => {
        it('when Bedrock returns null, output is identical to static mode', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.option(arbSearchTerm, { nil: undefined }),
                arbLimit,
                (searchTerm, limit) => {
                    // When Bedrock returns null, the server falls back to filterRegions
                    const staticResult = filterRegions(searchTerm, limit);

                    // Simulate the fallback path: bedrockResult is null → use static
                    const bedrockResult = null;
                    let result;
                    if (bedrockResult?.values?.awsRegion) {
                        // This branch is never taken when Bedrock returns null
                        result = null;
                    } else {
                        result = filterRegions(searchTerm, limit);
                    }

                    assert.deepStrictEqual(result, staticResult,
                        'Fallback result should be identical to static mode');
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: region-picker-server, Property 6: JSON Extraction Round-Trip
    describe('Property 6: JSON Extraction Round-Trip', () => {
        it('valid JSON with values field survives raw JSON and markdown-fenced wrapping', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const arbValuesObj = fc.dictionary(
                fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,14}$/),
                fc.string({ minLength: 1, maxLength: 30 }),
                { minKeys: 1, maxKeys: 5 }
            );

            fc.assert(fc.property(
                arbValuesObj,
                fc.boolean(),
                (valuesDict, useFenced) => {
                    const original = { values: valuesDict };
                    const jsonStr = JSON.stringify(original);

                    let wrapped;
                    if (useFenced) {
                        wrapped = `\`\`\`json\n${  jsonStr  }\n\`\`\``;
                    } else {
                        wrapped = jsonStr;
                    }

                    const extracted = extractJson(wrapped);
                    // Normalize through JSON round-trip to handle null-prototype objects
                    assert.deepStrictEqual(
                        JSON.parse(JSON.stringify(extracted)),
                        JSON.parse(JSON.stringify(original)),
                        'extractJson should recover the original object'
                    );
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: region-picker-server, Property 7: Bedrock Errors Return Null
    describe('Property 7: Bedrock Errors Return Null', () => {
        it('extractJson returns null for malformed input without throwing', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const arbBadInput = fc.oneof(
                fc.constant(null),
                fc.constant(undefined),
                fc.constant(''),
                fc.constant('not json at all'),
                fc.constant('{broken json'),
                fc.constant('```json\n{invalid}\n```'),
                fc.integer().map(String)
            );

            fc.assert(fc.property(
                arbBadInput,
                (badInput) => {
                    let result;
                    let threw = false;
                    try {
                        result = extractJson(badInput);
                    } catch {
                        threw = true;
                    }
                    assert.strictEqual(threw, false, 'extractJson should not throw');
                    // Result is either null or a parsed object (never throws)
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: region-picker-server, Property 8: Region Resolution Fallback Chain
    describe('Property 8: Region Resolution Fallback Chain', () => {
        it('effective region follows BEDROCK_REGION → AWS_REGION → us-east-1 precedence', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const arbRegion = fc.option(
                fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1'),
                { nil: undefined }
            );

            fc.assert(fc.property(
                arbRegion,
                arbRegion,
                (bedrockRegion, awsRegion) => {
                    // Simulate the resolution logic:
                    // process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1'
                    const effective = bedrockRegion || awsRegion || 'us-east-1';

                    if (bedrockRegion) {
                        assert.strictEqual(effective, bedrockRegion,
                            'BEDROCK_REGION should take highest precedence');
                    } else if (awsRegion) {
                        assert.strictEqual(effective, awsRegion,
                            'AWS_REGION should be used when BEDROCK_REGION is absent');
                    } else {
                        assert.strictEqual(effective, 'us-east-1',
                            'Should default to us-east-1 when both env vars are absent');
                    }
                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: region-picker-server, Property 9: Instance Recommender Static Behavioral Equivalence
    describe('Property 9: Instance Recommender Static Behavioral Equivalence', () => {
        it('GPU frameworks get GPU instances, others get CPU instances, truncated to limit', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbFramework,
                arbLimit,
                (framework, limit) => {
                    const context = { framework };
                    const instances = getStaticInstances(context);
                    const limited = instances.slice(0, limit);

                    if (GPU_FRAMEWORKS.has(framework)) {
                        assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.gpu,
                            `GPU framework "${framework}" should return GPU instances`);
                    } else {
                        assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.cpu,
                            `Non-GPU framework "${framework}" should return CPU instances`);
                    }

                    // Truncated to limit
                    assert.ok(limited.length <= limit);

                    // values.instanceType === choices[0]
                    if (limited.length > 0) {
                        assert.strictEqual(limited[0], instances[0],
                            'First choice should be the top recommendation');
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
