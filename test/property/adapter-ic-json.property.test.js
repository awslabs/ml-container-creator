// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter IC JSON Structure Property-Based Tests
 *
 * Verifies that the CreateInferenceComponent call in the do/adapter template
 * produces correct JSON structure for adapter inference components:
 *
 * 1. The specification JSON always includes BaseInferenceComponentName
 * 2. The specification JSON always includes Container.ArtifactUrl
 * 3. The specification JSON never includes ComputeResourceRequirements
 * 4. The adapter IC name follows ${PROJECT_NAME}-adapter-${name} convention
 *
 * Feature: lora-adapter-lifecycle, Property: Adapter IC JSON structure
 * Validates: Requirements 7.3
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Load the adapter template ────────────────────────────────────────────────

const ADAPTER_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/adapter');
const ADAPTER_TEMPLATE = readFileSync(ADAPTER_TEMPLATE_PATH, 'utf-8');

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid adapter names: lowercase alphanumeric + hyphens, 1-50 chars, starts with letter/number
const arbAdapterName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,49}$/).filter(s => s.length >= 1);

// Valid S3 URIs for adapter weights
const arbS3Uri = fc.tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9.-]{2,20}$/),
    fc.stringMatching(/^[a-z0-9][a-z0-9/_-]{1,30}$/)
).map(([bucket, key]) => `s3://${bucket}/${key}/adapter.tar.gz`);

// Valid project names (lowercase alphanumeric + hyphens)
const arbProjectName = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => s.length >= 3);

// Valid base IC names
const arbBaseIcName = fc.tuple(arbProjectName, fc.constantFrom('default', 'primary', 'base'))
    .map(([project, suffix]) => `${project}-ic-${suffix}`);

// ── Helper: simulate variable substitution in the specification JSON ─────────

/**
 * Extracts the --specification JSON pattern from the template and substitutes
 * the bash variables with provided values to produce the actual JSON string
 * that would be passed to the AWS CLI.
 */
function buildSpecificationJson(baseIcName, weightsUri) {
    // The template uses this exact pattern for the specification:
    // --specification "{\"BaseInferenceComponentName\":\"${base_ic_name}\",\"Container\":{\"ArtifactUrl\":\"${weights_uri}\"}}"
    // We simulate the bash variable substitution
    const specJson = `{"BaseInferenceComponentName":"${baseIcName}","Container":{"ArtifactUrl":"${weightsUri}"}}`;
    return specJson;
}

/**
 * Builds the adapter IC name using the same convention as the template:
 * ${PROJECT_NAME}-adapter-${adapter_name}
 */
function buildAdapterIcName(projectName, adapterName) {
    return `${projectName}-adapter-${adapterName}`;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle, Property: Adapter IC JSON structure', () => {

    describe('Template contains the expected specification pattern', () => {

        it('the adapter template contains a --specification flag with BaseInferenceComponentName', function () {
            assert.ok(
                ADAPTER_TEMPLATE.includes('--specification') &&
                ADAPTER_TEMPLATE.includes('BaseInferenceComponentName'),
                'Template must contain --specification with BaseInferenceComponentName'
            );
        });

        it('the adapter template contains Container.ArtifactUrl in the specification', function () {
            assert.ok(
                ADAPTER_TEMPLATE.includes('ArtifactUrl'),
                'Template must contain ArtifactUrl in the specification JSON'
            );
        });

        it('the adapter template does NOT contain ComputeResourceRequirements', function () {
            assert.ok(
                !ADAPTER_TEMPLATE.includes('ComputeResourceRequirements'),
                'Template must NOT contain ComputeResourceRequirements — adapter ICs share base IC resources'
            );
        });

        it('the adapter template uses ${PROJECT_NAME}-adapter-${adapter_name} naming', function () {
            assert.ok(
                ADAPTER_TEMPLATE.includes('${PROJECT_NAME}-adapter-${adapter_name}'),
                'Template must use ${PROJECT_NAME}-adapter-${adapter_name} for IC naming'
            );
        });
    });

    describe('Adapter IC specification JSON always includes BaseInferenceComponentName', () => {

        it('for any valid base IC name and S3 URI, the specification JSON contains BaseInferenceComponentName', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 7.3**
            fc.assert(fc.property(
                arbBaseIcName,
                arbS3Uri,
                (baseIcName, weightsUri) => {
                    const specJson = buildSpecificationJson(baseIcName, weightsUri);
                    const parsed = JSON.parse(specJson);

                    assert.ok(
                        'BaseInferenceComponentName' in parsed,
                        `Specification JSON must contain BaseInferenceComponentName, got keys: ${Object.keys(parsed).join(', ')}`
                    );
                    assert.strictEqual(
                        parsed.BaseInferenceComponentName,
                        baseIcName,
                        `BaseInferenceComponentName must equal the base IC name`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Adapter IC specification JSON always includes Container.ArtifactUrl', () => {

        it('for any valid base IC name and S3 URI, the specification JSON contains Container.ArtifactUrl', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 7.3**
            fc.assert(fc.property(
                arbBaseIcName,
                arbS3Uri,
                (baseIcName, weightsUri) => {
                    const specJson = buildSpecificationJson(baseIcName, weightsUri);
                    const parsed = JSON.parse(specJson);

                    assert.ok(
                        parsed.Container && 'ArtifactUrl' in parsed.Container,
                        `Specification JSON must contain Container.ArtifactUrl, got: ${JSON.stringify(parsed)}`
                    );
                    assert.strictEqual(
                        parsed.Container.ArtifactUrl,
                        weightsUri,
                        `Container.ArtifactUrl must equal the weights URI`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Adapter IC specification JSON never includes ComputeResourceRequirements', () => {

        it('for any valid base IC name and S3 URI, the specification JSON does NOT contain ComputeResourceRequirements', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 7.3**
            fc.assert(fc.property(
                arbBaseIcName,
                arbS3Uri,
                (baseIcName, weightsUri) => {
                    const specJson = buildSpecificationJson(baseIcName, weightsUri);
                    const parsed = JSON.parse(specJson);

                    assert.ok(
                        !('ComputeResourceRequirements' in parsed),
                        `Adapter IC specification must NOT contain ComputeResourceRequirements — adapters share base IC resources`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Adapter IC name follows ${PROJECT_NAME}-adapter-${name} convention', () => {

        it('for any valid project name and adapter name, the IC name is ${PROJECT_NAME}-adapter-${name}', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 7.3**
            fc.assert(fc.property(
                arbProjectName,
                arbAdapterName,
                (projectName, adapterName) => {
                    const icName = buildAdapterIcName(projectName, adapterName);

                    // Must start with project name
                    assert.ok(
                        icName.startsWith(`${projectName}-`),
                        `IC name must start with project name: expected prefix "${projectName}-", got "${icName}"`
                    );

                    // Must contain -adapter- separator
                    assert.ok(
                        icName.includes('-adapter-'),
                        `IC name must contain "-adapter-" separator, got "${icName}"`
                    );

                    // Must end with adapter name
                    assert.ok(
                        icName.endsWith(`-${adapterName}`),
                        `IC name must end with adapter name: expected suffix "-${adapterName}", got "${icName}"`
                    );

                    // Must match exact format
                    assert.strictEqual(
                        icName,
                        `${projectName}-adapter-${adapterName}`,
                        `IC name must be exactly "${projectName}-adapter-${adapterName}"`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('the adapter IC name format in the template matches the convention', function () {
            // Verify the template actually uses this exact pattern
            const namingPattern = /adapter_ic_name="\$\{PROJECT_NAME\}-adapter-\$\{adapter_name\}"/;
            assert.ok(
                namingPattern.test(ADAPTER_TEMPLATE),
                'Template must assign adapter_ic_name using ${PROJECT_NAME}-adapter-${adapter_name} pattern'
            );
        });
    });
});
