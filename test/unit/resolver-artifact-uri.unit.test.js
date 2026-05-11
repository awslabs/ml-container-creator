// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Example-based unit tests for resolver artifactUri extraction.
 *
 * Tests cover:
 * - Spec with hosting_prepacked_artifact_key: artifactUri = s3://jumpstart-cache-prod-{region}/{key}
 * - Spec with only hosting_artifact_key: fallback to that key
 * - Spec with neither key: artifactUri is undefined
 * - Static catalog entries (jumpstart-public.json): none have artifactUri
 *
 * Feature: model-server-loading-adapter
 * Validates: Requirements 1.1, 1.2, 1.5, 1.6
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JumpStartPublicResolver } from '../../servers/model-picker/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helper: create resolver with a known region ──────────────────────────────

const TEST_REGION = 'us-east-1';
const EXPECTED_BUCKET = `jumpstart-cache-prod-${TEST_REGION}`;

function createResolver() {
    return new JumpStartPublicResolver({ region: TEST_REGION });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter — resolver artifactUri example-based tests', () => {

    describe('Spec with hosting_prepacked_artifact_key (Req 1.1)', () => {

        it('produces artifactUri = s3://{bucket}/{prepacked_key}', () => {
            // **Validates: Requirements 1.1**
            const resolver = createResolver();
            const spec = {
                model_id: 'huggingface-llm-falcon-7b',
                hosting_prepacked_artifact_key: 'huggingface-llm/huggingface-llm-falcon-7b/artifacts/inference-prepack/v2.0.0/'
            };
            const result = resolver._mapToMetadata(spec, spec.model_id);

            assert.ok(result !== null, 'Result should not be null');
            assert.strictEqual(
                result.artifactUri,
                `s3://${EXPECTED_BUCKET}/${spec.hosting_prepacked_artifact_key}`,
                'artifactUri should use hosting_prepacked_artifact_key'
            );
        });

        it('prefers hosting_prepacked_artifact_key over hosting_artifact_key', () => {
            // **Validates: Requirements 1.1**
            const resolver = createResolver();
            const prepackedKey = 'prepacked/model/v2/';
            const artifactKey = 'raw/model/v1/';
            const spec = {
                model_id: 'test-model',
                hosting_prepacked_artifact_key: prepackedKey,
                hosting_artifact_key: artifactKey
            };
            const result = resolver._mapToMetadata(spec, spec.model_id);

            assert.ok(result !== null);
            assert.strictEqual(
                result.artifactUri,
                `s3://${EXPECTED_BUCKET}/${prepackedKey}`,
                'artifactUri should prefer hosting_prepacked_artifact_key'
            );
            assert.ok(
                !result.artifactUri.includes(artifactKey),
                'artifactUri should NOT use hosting_artifact_key when prepacked is available'
            );
        });
    });

    describe('Spec with only hosting_artifact_key (Req 1.1)', () => {

        it('falls back to hosting_artifact_key when prepacked is absent', () => {
            // **Validates: Requirements 1.1**
            const resolver = createResolver();
            const artifactKey = 'community_models/falcon-7b/artifacts/inference/v1.0.0/';
            const spec = {
                model_id: 'huggingface-llm-falcon-7b',
                hosting_artifact_key: artifactKey
            };
            const result = resolver._mapToMetadata(spec, spec.model_id);

            assert.ok(result !== null);
            assert.strictEqual(
                result.artifactUri,
                `s3://${EXPECTED_BUCKET}/${artifactKey}`,
                'artifactUri should fall back to hosting_artifact_key'
            );
        });
    });

    describe('Spec with neither artifact key (Req 1.5)', () => {

        it('artifactUri is undefined when both keys are missing', () => {
            // **Validates: Requirements 1.5**
            const resolver = createResolver();
            const spec = {
                model_id: 'some-model-without-artifacts',
                framework: 'pytorch'
            };
            const result = resolver._mapToMetadata(spec, spec.model_id);

            assert.ok(result !== null);
            assert.strictEqual(
                result.artifactUri,
                undefined,
                'artifactUri should be undefined when both keys are missing'
            );
        });
    });

    describe('Static catalog entries have no artifactUri (Req 1.6)', () => {

        it('no entry in jumpstart-public.json has an artifactUri field', () => {
            // **Validates: Requirements 1.6**
            const catalogPath = resolve(
                __dirname,
                '../../servers/lib/catalogs/jumpstart-public.json'
            );
            const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
            const entries = Object.entries(catalog);

            assert.ok(entries.length > 0, 'Catalog should have at least one entry');

            for (const [key, entry] of entries) {
                assert.strictEqual(
                    entry.artifactUri,
                    undefined,
                    `Static catalog entry "${key}" should NOT have artifactUri (region-specific paths cannot be pre-computed)`
                );
            }
        });
    });

    describe('Region is reflected in the bucket name (Req 1.1)', () => {

        it('uses the configured region in the S3 bucket name', () => {
            // **Validates: Requirements 1.1**
            const region = 'eu-west-1';
            const resolver = new JumpStartPublicResolver({ region });
            const spec = {
                model_id: 'test-model',
                hosting_prepacked_artifact_key: 'models/test/v1/'
            };
            const result = resolver._mapToMetadata(spec, spec.model_id);

            assert.ok(result !== null);
            assert.strictEqual(
                result.artifactUri,
                `s3://jumpstart-cache-prod-${region}/${spec.hosting_prepacked_artifact_key}`,
                'artifactUri should use the resolver region in the bucket name'
            );
        });
    });
});
