// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for catalog enum validation.
 *
 * Tests:
 * - Valid catalog entries pass validation
 * - Invalid inferenceAmiVersion values are caught
 * - Error report includes catalog file path and entry key
 *
 * Validates: Requirements 14.1, 14.2, 14.3
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import CatalogValidator from '../../src/lib/validators/catalog-validator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createServiceModel(enumValues) {
    return {
        metadata: { apiVersion: '2017-07-24' },
        operations: new Map([
            ['CreateEndpointConfig', { input: 'CreateEndpointConfigInput', output: null, errors: [] }]
        ]),
        shapes: new Map([
            ['InferenceAmiVersion', {
                type: 'string',
                enum: enumValues,
                required: [],
                members: new Map(),
                min: null,
                max: null,
                pattern: null,
                member: null,
                key: null,
                value: null
            }]
        ])
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CatalogValidator', () => {
    const validEnums = [
        'al2-ami-sagemaker-inference-gpu-2',
        'al2-ami-sagemaker-inference-gpu-3',
        'al2-ami-sagemaker-inference-cpu-2'
    ];

    describe('basic properties', () => {
        it('has name "catalog"', () => {
            const validator = new CatalogValidator();
            assert.strictEqual(validator.name, 'catalog');
        });

        it('has mode "static"', () => {
            const validator = new CatalogValidator();
            assert.strictEqual(validator.mode, 'static');
        });
    });

    describe('valid catalog entries pass', () => {
        it('returns no findings for entries with valid inferenceAmiVersion', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: {
                            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-2'
                        }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 0);
        });

        it('returns no findings when catalog has no inferenceAmiVersion fields', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                flask: [
                    {
                        image: 'python:3.11-slim',
                        tag: '3.11-slim',
                        defaults: {
                            envVars: { PORT: '8080' }
                        }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 0);
        });

        it('returns no findings when all entries across multiple server groups are valid', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-2' }
                    }
                ],
                sglang: [
                    {
                        image: 'lmsysorg/sglang:v0.2.0',
                        tag: 'v0.2.0',
                        defaults: { inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 0);
        });
    });

    describe('invalid inferenceAmiVersion values are caught', () => {
        it('reports error for invalid inferenceAmiVersion in defaults', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: {
                            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2'
                        }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].invalidValue, 'al2-ami-sagemaker-inference-gpu-3-2');
            assert.strictEqual(findings[0].fieldName, 'inferenceAmiVersion');
            assert.strictEqual(findings[0].severity, 'error');
            assert.strictEqual(findings[0].confidence, 'definitive');
        });

        it('reports errors for multiple invalid entries', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'invalid-version-1' }
                    },
                    {
                        image: 'vllm/vllm-openai:v0.3.0',
                        tag: 'v0.3.0',
                        defaults: { inferenceAmiVersion: 'invalid-version-2' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 2);
            assert.strictEqual(findings[0].invalidValue, 'invalid-version-1');
            assert.strictEqual(findings[1].invalidValue, 'invalid-version-2');
        });

        it('reports error for invalid inferenceAmiVersion at top level', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                custom: [
                    {
                        image: 'custom:latest',
                        tag: 'latest',
                        inferenceAmiVersion: 'totally-invalid'
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].invalidValue, 'totally-invalid');
        });

        it('includes valid enum set in the constraint', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'bad-value' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.deepStrictEqual(findings[0].constraint.type, 'enum');
            assert.deepStrictEqual(findings[0].constraint.values, validEnums);
        });
    });

    describe('error report includes catalog file path and entry key', () => {
        it('includes catalogFile in finding', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                sglang: [
                    {
                        image: 'lmsysorg/sglang:v0.2.0',
                        tag: 'v0.2.0',
                        defaults: { inferenceAmiVersion: 'invalid-value' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: '/path/to/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].catalogFile, '/path/to/model-servers.json');
        });

        it('includes entryKey identifying the server group and index', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                tensorrt: [
                    {
                        image: 'nvcr.io/nvidia/tensorrt:1.0',
                        tag: '1.0',
                        defaults: { inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-2' }
                    },
                    {
                        image: 'nvcr.io/nvidia/tensorrt:2.0',
                        tag: '2.0',
                        defaults: { inferenceAmiVersion: 'bad-value' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].entryKey, 'tensorrt[1]');
        });

        it('includes fieldName in finding', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'nope' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].fieldName, 'inferenceAmiVersion');
        });

        it('includes fieldPath with entry key and field name', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                lmi: [
                    {
                        image: 'djl-inference:0.30.0',
                        tag: '0.30.0',
                        defaults: { inferenceAmiVersion: 'wrong' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].fieldPath, 'lmi[0].inferenceAmiVersion');
        });

        it('includes source as "catalog"', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'invalid' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].source, 'catalog');
        });
    });

    describe('edge cases', () => {
        it('returns no findings when no service models provided', async () => {
            const validator = new CatalogValidator();

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'anything' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 0);
        });

        it('returns no findings when service model has no InferenceAmiVersion shape', async () => {
            const validator = new CatalogValidator();
            const serviceModel = {
                metadata: { apiVersion: '2017-07-24' },
                operations: new Map(),
                shapes: new Map([
                    ['SomeOtherShape', { type: 'string', enum: ['a', 'b'], required: [], members: new Map(), min: null, max: null, pattern: null, member: null, key: null, value: null }]
                ])
            };

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'anything' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 0);
        });

        it('handles non-array entries in catalog gracefully', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                metadata: { version: '1.0' },
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-2' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 0);
        });

        it('includes remediation hint in finding', async () => {
            const validator = new CatalogValidator();
            const serviceModel = createServiceModel(validEnums);

            const catalogData = {
                vllm: [
                    {
                        image: 'vllm/vllm-openai:v0.4.0',
                        tag: 'v0.4.0',
                        defaults: { inferenceAmiVersion: 'bad' }
                    }
                ]
            };

            const findings = await validator.validate({}, {
                serviceModels: [serviceModel],
                catalogData,
                catalogPath: 'servers/lib/catalogs/model-servers.json'
            });

            assert.strictEqual(findings.length, 1);
            assert.ok(findings[0].remediationHint.includes('bad'));
            assert.ok(findings[0].remediationHint.includes('inferenceAmiVersion'));
        });
    });
});
