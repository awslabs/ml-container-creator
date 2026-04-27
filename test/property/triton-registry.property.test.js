// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Triton Registry Property-Based Tests
 *
 * Property 9: Triton Registry Base Images
 * Validates: Requirements 8.2, 8.3
 *
 * Property 10: Triton Backend Metadata Completeness
 * Validates: Requirement 11.1
 *
 * Feature: triton-integration
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import RegistryLoader from '../../generators/app/lib/registry-loader.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __testFilename = fileURLToPath(import.meta.url);
const __testDir = dirname(__testFilename);
const tritonBackendsCatalogPath = resolve(__testDir, '../../servers/base-image-picker/catalogs/triton-backends.json');
const tritonBackends = JSON.parse(readFileSync(tritonBackendsCatalogPath, 'utf8'));

const loader = new RegistryLoader();
const frameworkRegistry = await loader.loadFrameworkRegistry();

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

/** All 7 Triton backend keys in the framework registry */
const TRITON_REGISTRY_KEYS = [
    'triton-fil',
    'triton-onnxruntime',
    'triton-tensorflow',
    'triton-pytorch',
    'triton-vllm',
    'triton-tensorrtllm',
    'triton-python'
];

/** Required fields for every framework registry entry */
const REQUIRED_REGISTRY_FIELDS = [
    'accelerator',
    'envVars',
    'inferenceAmiVersion',
    'recommendedInstanceTypes',
    'validationLevel'
];

/** All 7 Triton backend names in the backend metadata registry */
const TRITON_BACKEND_NAMES = [
    'fil',
    'onnxruntime',
    'tensorflow',
    'pytorch',
    'vllm',
    'tensorrtllm',
    'python'
];

/** Required fields for every backend metadata entry */
const REQUIRED_METADATA_FIELDS = [
    'requiresGpu',
    'modelFormats',
    'modelArtifactName',
    'requiresModelName',
    'supportsSampleModel'
];

// ── Property 9: Triton Registry Base Images ─────────────────────────────────

describe('Triton Registry Property-Based Tests', () => {

    before(() => {
        console.log('\n🚀 Starting Triton Registry Property Tests');
        console.log('📋 Testing: Registry base images and backend metadata completeness');
        console.log(`🔧 Configuration: ${FAST_PROPERTY_CONFIG.numRuns} iterations per property`);
        console.log(`📦 Triton registry keys: ${TRITON_REGISTRY_KEYS.length}, backend names: ${TRITON_BACKEND_NAMES.length}\n`);
    });

    /**
     * Property 9: Triton Registry Base Images
     *
     * **Validates: Requirements 8.2, 8.3**
     *
     * For all Triton backend entries in frameworks.js, baseImage starts
     * with 'nvcr.io/nvidia/tritonserver' and entry contains required
     * fields (accelerator, envVars, inferenceAmiVersion,
     * recommendedInstanceTypes, validationLevel).
     */
    describe('Property 9: Triton Registry Base Images', () => {
        it('all Triton backend entries have baseImage starting with nvcr.io/nvidia/tritonserver and contain required fields', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...TRITON_REGISTRY_KEYS),
                (registryKey) => {
                    const entry = frameworkRegistry[registryKey];
                    assert.ok(entry, `Framework registry missing entry for '${registryKey}'`);

                    // Get the first (and typically only) version entry
                    const versions = Object.keys(entry);
                    assert.ok(versions.length > 0, `No version entries for '${registryKey}'`);

                    for (const version of versions) {
                        const versionEntry = entry[version];

                        // baseImage must start with nvcr.io/nvidia/tritonserver
                        assert.ok(
                            versionEntry.baseImage && versionEntry.baseImage.startsWith('nvcr.io/nvidia/tritonserver'),
                            `baseImage for '${registryKey}' v${version} must start with 'nvcr.io/nvidia/tritonserver', got '${versionEntry.baseImage}'`
                        );

                        // All required fields must be present
                        for (const field of REQUIRED_REGISTRY_FIELDS) {
                            assert.ok(
                                versionEntry[field] !== undefined && versionEntry[field] !== null,
                                `Missing required field '${field}' in '${registryKey}' v${version}`
                            );
                        }
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });

    // ── Property 10: Triton Backend Metadata Completeness ───────────────────

    /**
     * Property 10: Triton Backend Metadata Completeness
     *
     * **Validates: Requirement 11.1**
     *
     * For all 7 Triton backends, metadata specifies requiresGpu,
     * modelFormats, modelArtifactName, requiresModelName,
     * supportsSampleModel.
     */
    describe('Property 10: Triton Backend Metadata Completeness', () => {
        it('all 7 Triton backends have complete metadata with all required fields', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...TRITON_BACKEND_NAMES),
                (backendName) => {
                    const metadata = tritonBackends[backendName];
                    assert.ok(metadata, `Backend metadata missing for '${backendName}'`);

                    for (const field of REQUIRED_METADATA_FIELDS) {
                        assert.ok(
                            field in metadata,
                            `Missing required field '${field}' in backend metadata for '${backendName}'`
                        );
                    }

                    // Type checks for boolean fields
                    assert.strictEqual(
                        typeof metadata.requiresGpu,
                        'boolean',
                        `requiresGpu must be boolean for '${backendName}'`
                    );
                    assert.strictEqual(
                        typeof metadata.requiresModelName,
                        'boolean',
                        `requiresModelName must be boolean for '${backendName}'`
                    );
                    assert.strictEqual(
                        typeof metadata.supportsSampleModel,
                        'boolean',
                        `supportsSampleModel must be boolean for '${backendName}'`
                    );

                    // modelFormats must be array or null
                    assert.ok(
                        metadata.modelFormats === null || Array.isArray(metadata.modelFormats),
                        `modelFormats must be array or null for '${backendName}'`
                    );

                    // modelArtifactName must be string or null
                    assert.ok(
                        metadata.modelArtifactName === null || typeof metadata.modelArtifactName === 'string',
                        `modelArtifactName must be string or null for '${backendName}'`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
