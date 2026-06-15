// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-Cutting Checker Property-Based Tests
 *
 * Feature: schema-driven-validation, Property 14: GPU consistency check
 * Feature: schema-driven-validation, Property 15: Tensor parallelism three-way consistency
 * Feature: schema-driven-validation, Property 16: Model source artifact URI requirement
 * Feature: schema-driven-validation, Property 17: CUDA compatibility check
 * Feature: schema-driven-validation, Property 18: Model type instance alignment
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import CrossCuttingChecker from '../../src/lib/cross-cutting-checker.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a model_type string (lowercase, alphanumeric with underscores).
 */
const arbModelType = fc.constantFrom(
    'llama', 'qwen2', 'mistral', 'gemma2', 'phi3', 'falcon',
    'gpt_neox', 'mpt', 'bloom', 'opt', 'starcoder2', 'deepseek'
);

/**
 * Generate a model server name.
 */
const arbModelServer = fc.constantFrom('vllm', 'sglang', 'tensorrt-llm');

/**
 * Generate a framework version string.
 */
const arbFrameworkVersion = fc.constantFrom(
    '0.10.1', '0.9.0', '0.8.5', '0.7.3', '0.6.0', '1.0.0'
);

/**
 * Build a model servers catalog for architecture compatibility testing.
 * @param {string} server - Server name
 * @param {string} version - Framework version
 * @param {string[]} supportedModelTypes - Array of supported model types
 */
function buildModelServersCatalog(server, version, supportedModelTypes) {
    return {
        [server]: [
            {
                image: `${server}/${server}:v${version}`,
                tag: `v${version}`,
                labels: { framework_version: version },
                supportedModelTypes
            }
        ]
    };
}

/**
 * Generate a valid SageMaker instance type name.
 */
const arbInstanceType = fc.constantFrom(
    'ml.g4dn.xlarge', 'ml.g4dn.2xlarge', 'ml.g4dn.12xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge', 'ml.g5.48xlarge',
    'ml.p3.2xlarge', 'ml.p3.8xlarge', 'ml.p3.16xlarge',
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.c5.xlarge'
);

/**
 * Generate a GPU instance type (gpus > 0).
 */
const arbGpuInstanceType = fc.constantFrom(
    'ml.g4dn.xlarge', 'ml.g4dn.2xlarge', 'ml.g4dn.12xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge', 'ml.g5.48xlarge',
    'ml.p3.2xlarge', 'ml.p3.8xlarge', 'ml.p3.16xlarge'
);

/**
 * Generate a CPU instance type (gpus === 0).
 */
const arbCpuInstanceType = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.c5.xlarge', 'ml.c5.2xlarge',
    'ml.m5.large', 'ml.m5.4xlarge', 'ml.r5.large', 'ml.r5.xlarge'
);

/**
 * Generate a positive GPU count.
 */
const arbGpuCount = fc.integer({ min: 1, max: 16 });

/**
 * Generate a CUDA version string.
 */
const arbCudaVersion = fc.constantFrom(
    '11.0', '11.4', '11.8', '12.0', '12.1', '12.2', '12.4'
);

/**
 * Generate a model server that uses tensor parallelism.
 */
const arbTpModelServer = fc.constantFrom('vllm', 'sglang', 'vLLM', 'SGLang');

/**
 * Generate a model source that requires artifact URI.
 */
const arbArtifactModelSource = fc.constantFrom('s3', 'registry');

/**
 * Build a minimal instance catalog for testing.
 */
function buildInstanceCatalog(entries) {
    return { catalog: entries };
}

/**
 * Build a minimal validation context.
 */
function buildContext(config, deploymentTarget = 'realtime-inference') {
    return {
        payloads: {},
        config: config || {},
        deploymentTarget,
        metadata: {
            generatedAt: new Date().toISOString(),
            generatorVersion: '0.2.5',
            services: ['sagemaker']
        }
    };
}

// ── Real instance catalog data for testing ───────────────────────────────────

const REAL_CATALOG = {
    'ml.g4dn.xlarge': { category: 'gpu', gpus: 1, cudaVersions: ['11.4', '11.8'] },
    'ml.g4dn.2xlarge': { category: 'gpu', gpus: 1, cudaVersions: ['11.4', '11.8'] },
    'ml.g4dn.12xlarge': { category: 'gpu', gpus: 4, cudaVersions: ['11.4', '11.8'] },
    'ml.g5.xlarge': { category: 'gpu', gpus: 1, cudaVersions: ['11.8', '12.1', '12.2'] },
    'ml.g5.2xlarge': { category: 'gpu', gpus: 1, cudaVersions: ['11.8', '12.1', '12.2'] },
    'ml.g5.12xlarge': { category: 'gpu', gpus: 4, cudaVersions: ['11.8', '12.1', '12.2'] },
    'ml.g5.48xlarge': { category: 'gpu', gpus: 8, cudaVersions: ['11.8', '12.1', '12.2'] },
    'ml.p3.2xlarge': { category: 'gpu', gpus: 1, cudaVersions: ['11.0', '11.4', '11.8'] },
    'ml.p3.8xlarge': { category: 'gpu', gpus: 4, cudaVersions: ['11.0', '11.4', '11.8'] },
    'ml.p3.16xlarge': { category: 'gpu', gpus: 8, cudaVersions: ['11.0', '11.4', '11.8'] },
    'ml.m5.large': { category: 'cpu', gpus: 0, cudaVersions: null },
    'ml.m5.xlarge': { category: 'cpu', gpus: 0, cudaVersions: null },
    'ml.m5.2xlarge': { category: 'cpu', gpus: 0, cudaVersions: null },
    'ml.m5.4xlarge': { category: 'cpu', gpus: 0, cudaVersions: null },
    'ml.c5.xlarge': { category: 'cpu', gpus: 0, cudaVersions: null },
    'ml.c5.2xlarge': { category: 'cpu', gpus: 0, cudaVersions: null },
    'ml.r5.large': { category: 'cpu', gpus: 0, cudaVersions: null },
    'ml.r5.xlarge': { category: 'cpu', gpus: 0, cudaVersions: null }
};

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Cross-Cutting Checker Property-Based Tests', () => {

    const checker = new CrossCuttingChecker();

    // Feature: schema-driven-validation, Property 14: GPU consistency check
    describe('Property 14: GPU consistency check', () => {

        /**
         * Validates: Requirements 7.1
         */

        it('reports error iff NumberOfAcceleratorDevicesRequired != instance GPU count', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbGpuInstanceType, arbGpuCount),
                ([instanceType, icGpuCount]) => {
                    const instanceInfo = REAL_CATALOG[instanceType];
                    const instanceGpuCount = instanceInfo.gpus;

                    const context = buildContext({
                        INSTANCE_TYPE: instanceType,
                        IC_GPU_COUNT: icGpuCount
                    });

                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkGpuConsistency(context, catalog);

                    if (icGpuCount === instanceGpuCount) {
                        assert.strictEqual(findings.length, 0,
                            `Matching GPU count (${icGpuCount}) should produce no errors`);
                    } else {
                        assert.strictEqual(findings.length, 1,
                            `Mismatched GPU count (IC: ${icGpuCount}, instance: ${instanceGpuCount}) should produce exactly one error`);
                        assert.strictEqual(findings[0].severity, 'error');
                        assert.strictEqual(findings[0].source, 'cross-cutting');
                        assert.strictEqual(findings[0].confidence, 'high');
                        assert.strictEqual(findings[0].fieldPath, 'NumberOfAcceleratorDevicesRequired');
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('no error for CPU instances regardless of IC_GPU_COUNT', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbCpuInstanceType, arbGpuCount),
                ([instanceType, icGpuCount]) => {
                    const context = buildContext({
                        INSTANCE_TYPE: instanceType,
                        IC_GPU_COUNT: icGpuCount
                    });

                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkGpuConsistency(context, catalog);

                    // CPU instances have gpus === 0, so the check returns early
                    assert.strictEqual(findings.length, 0,
                        'CPU instances should not trigger GPU consistency check');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: schema-driven-validation, Property 15: Tensor parallelism three-way consistency
    describe('Property 15: Tensor parallelism three-way consistency', () => {

        /**
         * Validates: Requirements 7.2
         */

        it('reports error if TP size, accelerator devices, and instance GPUs are not all equal', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbTpModelServer,
                    arbGpuInstanceType,
                    arbGpuCount,
                    arbGpuCount
                ),
                ([modelServer, instanceType, tpSize, icGpuCount]) => {
                    const instanceInfo = REAL_CATALOG[instanceType];
                    const instanceGpuCount = instanceInfo.gpus;

                    const context = buildContext({
                        MODEL_SERVER: modelServer,
                        INSTANCE_TYPE: instanceType,
                        VLLM_TENSOR_PARALLEL_SIZE: tpSize,
                        IC_GPU_COUNT: icGpuCount
                    });

                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkTensorParallelism(context, catalog);

                    const allEqual = (tpSize === icGpuCount) && (tpSize === instanceGpuCount);

                    if (allEqual) {
                        assert.strictEqual(findings.length, 0,
                            `All values equal (${tpSize}) should produce no errors`);
                    } else {
                        assert.ok(findings.length > 0,
                            `Mismatched values (TP: ${tpSize}, IC: ${icGpuCount}, instance: ${instanceGpuCount}) should produce errors`);
                        for (const finding of findings) {
                            assert.strictEqual(finding.severity, 'error');
                            assert.strictEqual(finding.source, 'cross-cutting');
                            assert.strictEqual(finding.confidence, 'high');
                        }
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('no error when model server is not vLLM or SGLang', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    fc.constantFrom('flask', 'fastapi', 'triton', 'djl'),
                    arbGpuInstanceType,
                    arbGpuCount,
                    arbGpuCount
                ),
                ([modelServer, instanceType, tpSize, icGpuCount]) => {
                    const context = buildContext({
                        MODEL_SERVER: modelServer,
                        INSTANCE_TYPE: instanceType,
                        VLLM_TENSOR_PARALLEL_SIZE: tpSize,
                        IC_GPU_COUNT: icGpuCount
                    });

                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkTensorParallelism(context, catalog);

                    assert.strictEqual(findings.length, 0,
                        'Non-vLLM/SGLang servers should not trigger tensor parallelism check');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: schema-driven-validation, Property 16: Model source artifact URI requirement
    describe('Property 16: Model source artifact URI requirement', () => {

        /**
         * Validates: Requirements 7.4
         */

        it('reports error iff MODEL_ARTIFACT_URI is empty/unset for artifact-requiring sources', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbArtifactModelSource,
                    fc.oneof(
                        fc.constant(''),
                        fc.constant(null),
                        fc.constant(undefined),
                        fc.stringMatching(/^s3:\/\/[a-z0-9-]+\/[a-z0-9/]+$/)
                    )
                ),
                ([modelSource, artifactUri]) => {
                    const config = { modelSource };
                    if (artifactUri !== null && artifactUri !== undefined) {
                        config.MODEL_ARTIFACT_URI = artifactUri;
                    }

                    const context = buildContext(config);
                    const findings = checker.checkModelSourceRequirements(context);

                    const isEmptyOrUnset = !artifactUri || (typeof artifactUri === 'string' && artifactUri.trim() === '');

                    // Filter to only artifact URI findings (not hub content arn)
                    const artifactFindings = findings.filter(f => f.fieldPath === 'MODEL_ARTIFACT_URI');

                    if (isEmptyOrUnset) {
                        assert.strictEqual(artifactFindings.length, 1,
                            `Empty/unset MODEL_ARTIFACT_URI with source "${modelSource}" should produce an error`);
                        assert.strictEqual(artifactFindings[0].severity, 'error');
                        assert.strictEqual(artifactFindings[0].source, 'cross-cutting');
                    } else {
                        assert.strictEqual(artifactFindings.length, 0,
                            `Non-empty MODEL_ARTIFACT_URI "${artifactUri}" should produce no artifact URI error`);
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('no error when model source does not require artifact URI', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom('huggingface', 'local', 'custom', 'none'),
                (modelSource) => {
                    const context = buildContext({
                        modelSource,
                        MODEL_ARTIFACT_URI: ''
                    });

                    const findings = checker.checkModelSourceRequirements(context);
                    const artifactFindings = findings.filter(f => f.fieldPath === 'MODEL_ARTIFACT_URI');

                    assert.strictEqual(artifactFindings.length, 0,
                        `Model source "${modelSource}" should not require MODEL_ARTIFACT_URI`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: schema-driven-validation, Property 17: CUDA compatibility check
    describe('Property 17: CUDA compatibility check', () => {

        /**
         * Validates: Requirements 7.6
         */

        it('reports error iff intersection of instance CUDA versions with base image CUDA major version is empty', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbGpuInstanceType,
                    arbCudaVersion
                ),
                ([instanceType, requiredCuda]) => {
                    const instanceInfo = REAL_CATALOG[instanceType];
                    const instanceCudaVersions = instanceInfo.cudaVersions;

                    const context = buildContext({
                        INSTANCE_TYPE: instanceType,
                        acceleratorVersion: requiredCuda
                    });

                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkCudaCompatibility(context, catalog);

                    // Check if any instance CUDA version shares the same major version
                    const requiredMajor = requiredCuda.split('.')[0];
                    const hasCompatible = instanceCudaVersions.some(v => v.split('.')[0] === requiredMajor);

                    if (hasCompatible) {
                        assert.strictEqual(findings.length, 0,
                            `Compatible CUDA (required: ${requiredCuda}, available: [${instanceCudaVersions}]) should produce no errors`);
                    } else {
                        assert.strictEqual(findings.length, 1,
                            `Incompatible CUDA (required: ${requiredCuda}, available: [${instanceCudaVersions}]) should produce exactly one error`);
                        assert.strictEqual(findings[0].severity, 'error');
                        assert.strictEqual(findings[0].source, 'cross-cutting');
                        assert.strictEqual(findings[0].fieldPath, 'acceleratorVersion');
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('no error when instance has no CUDA versions (CPU instance)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbCpuInstanceType, arbCudaVersion),
                ([instanceType, requiredCuda]) => {
                    const context = buildContext({
                        INSTANCE_TYPE: instanceType,
                        acceleratorVersion: requiredCuda
                    });

                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkCudaCompatibility(context, catalog);

                    assert.strictEqual(findings.length, 0,
                        'CPU instances with null cudaVersions should not trigger CUDA check');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: schema-driven-validation, Property 18: Model type instance alignment
    describe('Property 18: Model type instance alignment', () => {

        /**
         * Validates: Requirements 7.7
         */

        it('reports warning iff model type is predictor and instance is GPU', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    arbInstanceType,
                    fc.boolean()
                ),
                ([instanceType, isPredictor]) => {
                    const instanceInfo = REAL_CATALOG[instanceType];
                    if (!instanceInfo) return true; // skip unknown instances

                    const config = {
                        INSTANCE_TYPE: instanceType,
                        modelType: isPredictor ? 'predictor' : 'transformer'
                    };

                    const context = buildContext(config);
                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkModelTypeInstanceAlignment(context, catalog);

                    const isGpuInstance = instanceInfo.gpus > 0 || instanceInfo.category === 'gpu';

                    if (isPredictor && isGpuInstance) {
                        assert.strictEqual(findings.length, 1,
                            `Predictor model on GPU instance ${instanceType} should produce a warning`);
                        assert.strictEqual(findings[0].severity, 'warning');
                        assert.strictEqual(findings[0].source, 'cross-cutting');
                        assert.strictEqual(findings[0].confidence, 'high');
                        assert.strictEqual(findings[0].fieldPath, 'INSTANCE_TYPE');
                    } else {
                        assert.strictEqual(findings.length, 0,
                            'Non-predictor or CPU instance should produce no warnings');
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('no warning for predictor models on CPU instances', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCpuInstanceType,
                (instanceType) => {
                    const context = buildContext({
                        INSTANCE_TYPE: instanceType,
                        modelType: 'predictor'
                    });

                    const catalog = buildInstanceCatalog(REAL_CATALOG);
                    const findings = checker.checkModelTypeInstanceAlignment(context, catalog);

                    assert.strictEqual(findings.length, 0,
                        'Predictor model on CPU instance should produce no warnings');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: model-architecture-validation, Property 19: Model architecture compatibility
    describe('Property 19: Model architecture compatibility check', () => {

        /**
         * Validates: Requirements 5.3-5.5
         */

        it('compatible model_type produces no findings', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbModelServer, arbFrameworkVersion, arbModelType),
                ([server, version, modelType]) => {
                    // Build catalog where the model_type IS in supportedModelTypes
                    const supportedTypes = [modelType, 'other_type_1', 'other_type_2'];
                    const catalog = buildModelServersCatalog(server, version, supportedTypes);

                    const context = buildContext({
                        modelType,
                        modelServer: server,
                        baseImageVersion: version
                    });

                    const findings = checker.checkModelArchitectureCompatibility(context, catalog);

                    assert.strictEqual(findings.length, 0,
                        `Compatible model_type "${modelType}" with ${server} ${version} should produce no findings`);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('incompatible model_type produces a warning finding', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbModelServer, arbFrameworkVersion, arbModelType),
                ([server, version, modelType]) => {
                    // Build catalog where the model_type is NOT in supportedModelTypes
                    const supportedTypes = ['completely_different_arch', 'another_arch', 'third_arch'];
                    const catalog = buildModelServersCatalog(server, version, supportedTypes);

                    const context = buildContext({
                        modelType,
                        modelServer: server,
                        baseImageVersion: version
                    });

                    const findings = checker.checkModelArchitectureCompatibility(context, catalog);

                    assert.strictEqual(findings.length, 1,
                        `Incompatible model_type "${modelType}" should produce exactly one finding`);
                    assert.strictEqual(findings[0].severity, 'warning');
                    assert.strictEqual(findings[0].confidence, 'medium');
                    assert.strictEqual(findings[0].source, 'cross-cutting');
                    assert.strictEqual(findings[0].fieldPath, 'MODEL_NAME');
                    assert.strictEqual(findings[0].invalidValue, modelType);
                    assert.strictEqual(findings[0].constraint.type, 'architecture-compatibility');
                    assert.strictEqual(findings[0].constraint.server, server);
                    assert.strictEqual(findings[0].constraint.version, version);
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('empty supportedModelTypes produces no findings (graceful skip)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbModelServer, arbFrameworkVersion, arbModelType),
                ([server, version, modelType]) => {
                    // Build catalog with empty supportedModelTypes (sync not run)
                    const catalog = buildModelServersCatalog(server, version, []);

                    const context = buildContext({
                        modelType,
                        modelServer: server,
                        baseImageVersion: version
                    });

                    const findings = checker.checkModelArchitectureCompatibility(context, catalog);

                    assert.strictEqual(findings.length, 0,
                        'Empty supportedModelTypes should skip check and produce no findings');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('missing model_type produces no findings', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbModelServer, arbFrameworkVersion),
                ([server, version]) => {
                    // Build catalog with supported types but context has no modelType
                    const supportedTypes = ['llama', 'mistral', 'qwen2'];
                    const catalog = buildModelServersCatalog(server, version, supportedTypes);

                    const context = buildContext({
                        modelServer: server,
                        baseImageVersion: version
                        // modelType intentionally omitted
                    });

                    const findings = checker.checkModelArchitectureCompatibility(context, catalog);

                    assert.strictEqual(findings.length, 0,
                        'Missing model_type should skip check and produce no findings');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
