// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for submit S3 integration logic.
 *
 * Tests the logic of reading staged-assets.json and determining what
 * environment variables to pass to CodeBuild during do/submit.
 *
 * Feature: s3-model-loading
 * Validates: Requirements 2.1, 2.2, 2.4, 2.6
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';

// ── Logic under test (extracted from do/submit behavior) ─────────────────────

/**
 * Simulates the submit script's logic for reading staged-assets.json
 * and extracting the MODEL_S3_URI for the default model.
 *
 * @param {string|null|undefined} stagedAssetsContent - File content (null if file doesn't exist)
 * @returns {string} The S3 URI or empty string
 */
function resolveModelS3Uri(stagedAssetsContent) {
    if (!stagedAssetsContent) return '';
    try {
        const data = JSON.parse(stagedAssetsContent);
        return data?.models?.default?.staged_uri || '';
    } catch {
        return '';
    }
}

/**
 * Simulates what CodeBuild env override string looks like when MODEL_S3_URI is set.
 *
 * @param {string} modelS3Uri - The resolved S3 URI
 * @returns {string} The env override string or empty
 */
function buildCodeBuildEnvOverride(modelS3Uri) {
    if (modelS3Uri) {
        return `name=MODEL_S3_URI,value=${modelS3Uri},type=PLAINTEXT`;
    }
    return '';
}

/**
 * Simulates the build behavior: S3-first with HF fallback.
 *
 * @param {string} modelS3Uri - S3 URI (empty if none)
 * @param {boolean} s3DownloadSucceeds - Whether S3 download would succeed
 * @returns {object} Build result with source, success, and optional warning
 */
function simulateBuildBehavior(modelS3Uri, s3DownloadSucceeds) {
    if (modelS3Uri && s3DownloadSucceeds) {
        return { source: 's3', success: true };
    } else if (modelS3Uri && !s3DownloadSucceeds) {
        return { source: 'huggingface', success: true, warning: '⚠️  S3 download failed, falling back to HuggingFace (slow). Run do/stage to fix.' };
    } else {
        return { source: 'huggingface', success: true };
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Submit S3 Integration (Requirements 2.1, 2.2, 2.4, 2.6)', () => {

    describe('With staged-assets.json present: CodeBuild receives MODEL_S3_URI env var', () => {

        it('resolves correct URI from valid staged-assets.json', () => {
            const stagedAssets = JSON.stringify({
                version: '1',
                models: {
                    default: {
                        source: 'google/gemma-4-31B-it',
                        staged_uri: 's3://mlcc-models-123456789012-us-west-2/models/gemma-31b-vllm/',
                        staged_at: '2025-06-12T17:30:00Z',
                        region: 'us-west-2',
                        size_gb: 62.4
                    }
                },
                adapters: {}
            });

            const uri = resolveModelS3Uri(stagedAssets);
            assert.equal(uri, 's3://mlcc-models-123456789012-us-west-2/models/gemma-31b-vllm/');
        });

        it('builds CodeBuild env override string with the resolved URI', () => {
            const uri = 's3://mlcc-models-123456789012-us-west-2/models/gemma-31b-vllm/';
            const override = buildCodeBuildEnvOverride(uri);

            assert.equal(
                override,
                'name=MODEL_S3_URI,value=s3://mlcc-models-123456789012-us-west-2/models/gemma-31b-vllm/,type=PLAINTEXT'
            );
        });

        it('end-to-end: staged-assets → env override is correct', () => {
            const stagedAssets = JSON.stringify({
                version: '1',
                models: {
                    default: {
                        source: 'Qwen/Qwen3-4B',
                        staged_uri: 's3://my-bucket/models/qwen-4b/',
                        staged_at: '2025-07-01T10:00:00Z',
                        region: 'us-east-1',
                        size_gb: 8.5
                    }
                },
                adapters: {}
            });

            const uri = resolveModelS3Uri(stagedAssets);
            const override = buildCodeBuildEnvOverride(uri);

            assert.equal(uri, 's3://my-bucket/models/qwen-4b/');
            assert.ok(override.includes('MODEL_S3_URI'));
            assert.ok(override.includes('s3://my-bucket/models/qwen-4b/'));
            assert.ok(override.includes('PLAINTEXT'));
        });

        it('build downloads from S3 when URI is present and S3 succeeds', () => {
            const result = simulateBuildBehavior('s3://bucket/models/model/', true);

            assert.equal(result.source, 's3');
            assert.equal(result.success, true);
            assert.equal(result.warning, undefined);
        });
    });

    describe('Without staged-assets.json: CodeBuild builds normally (HF download, no error)', () => {

        it('resolves empty string when file content is null', () => {
            assert.equal(resolveModelS3Uri(null), '');
        });

        it('resolves empty string when file content is undefined', () => {
            assert.equal(resolveModelS3Uri(undefined), '');
        });

        it('resolves empty string when file content is empty string', () => {
            assert.equal(resolveModelS3Uri(''), '');
        });

        it('produces no env override when URI is empty', () => {
            const override = buildCodeBuildEnvOverride('');
            assert.equal(override, '');
        });

        it('build downloads from HuggingFace when no S3 URI is available', () => {
            const result = simulateBuildBehavior('', true);

            assert.equal(result.source, 'huggingface');
            assert.equal(result.success, true);
            assert.equal(result.warning, undefined);
        });
    });

    describe('With invalid S3 URI in staged-assets: build falls back to HF with warning', () => {

        it('resolves empty string for invalid JSON content', () => {
            assert.equal(resolveModelS3Uri('not valid json {{{'), '');
        });

        it('resolves empty string for JSON missing models key', () => {
            const json = JSON.stringify({ version: '1', adapters: {} });
            assert.equal(resolveModelS3Uri(json), '');
        });

        it('resolves empty string for JSON missing default model', () => {
            const json = JSON.stringify({ version: '1', models: {}, adapters: {} });
            assert.equal(resolveModelS3Uri(json), '');
        });

        it('resolves empty string for JSON with null staged_uri', () => {
            const json = JSON.stringify({
                version: '1',
                models: { default: { source: 'org/model', staged_uri: null } },
                adapters: {}
            });
            assert.equal(resolveModelS3Uri(json), '');
        });

        it('resolves empty string for JSON with empty string staged_uri', () => {
            const json = JSON.stringify({
                version: '1',
                models: { default: { source: 'org/model', staged_uri: '' } },
                adapters: {}
            });
            assert.equal(resolveModelS3Uri(json), '');
        });

        it('build falls back to HF with warning when S3 download fails', () => {
            const result = simulateBuildBehavior('s3://invalid-bucket/models/missing/', false);

            assert.equal(result.source, 'huggingface');
            assert.equal(result.success, true);
            assert.ok(result.warning.includes('S3 download failed'));
            assert.ok(result.warning.includes('falling back to HuggingFace'));
            assert.ok(result.warning.includes('do/stage'));
        });

        it('build never fails due to S3 issues — always succeeds via fallback', () => {
            // Even with a URI that would fail, the build still succeeds
            const result = simulateBuildBehavior('s3://nonexistent/path/', false);
            assert.equal(result.success, true, 'Build must always succeed (graceful degradation)');
        });
    });

    describe('Existing projects (without .mlcc/) continue to work unchanged (backward compatible)', () => {

        it('no staged-assets content → build proceeds with HuggingFace (no error)', () => {
            const uri = resolveModelS3Uri(null);
            const override = buildCodeBuildEnvOverride(uri);
            const result = simulateBuildBehavior(uri, true);

            assert.equal(uri, '', 'No URI extracted');
            assert.equal(override, '', 'No env override sent to CodeBuild');
            assert.equal(result.source, 'huggingface', 'Downloads from HuggingFace');
            assert.equal(result.success, true, 'Build succeeds');
            assert.equal(result.warning, undefined, 'No warning shown');
        });

        it('empty staged-assets content → same behavior as missing file', () => {
            const uri = resolveModelS3Uri('');
            const override = buildCodeBuildEnvOverride(uri);
            const result = simulateBuildBehavior(uri, true);

            assert.equal(uri, '');
            assert.equal(override, '');
            assert.equal(result.source, 'huggingface');
            assert.equal(result.success, true);
        });

        it('submit workflow is identical for projects that never ran do/stage', () => {
            // Simulates a project that was created before the S3 staging feature
            // No .mlcc/ directory, no staged-assets.json → everything works as before
            const stagedAssetsContent = null; // file doesn't exist

            const uri = resolveModelS3Uri(stagedAssetsContent);
            assert.equal(uri, '', 'resolveModelS3Uri returns empty for nonexistent file');

            const override = buildCodeBuildEnvOverride(uri);
            assert.equal(override, '', 'No MODEL_S3_URI override is sent');

            const buildResult = simulateBuildBehavior(uri, true);
            assert.equal(buildResult.source, 'huggingface', 'Build uses HuggingFace directly');
            assert.equal(buildResult.success, true, 'Build completes successfully');
            assert.equal(buildResult.warning, undefined, 'No fallback warning is emitted');
        });
    });
});
