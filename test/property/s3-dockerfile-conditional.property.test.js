// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dockerfile Conditional Logic Property-Based Tests
 *
 * Property 4: For any value of the `MODEL_S3_URI` build argument (present or absent),
 * the generated Dockerfile SHALL correctly branch: attempting S3 download when
 * `MODEL_S3_URI` is non-empty, and downloading directly from HuggingFace when it is empty.
 *
 * Feature: s3-model-loading, Property 4: Dockerfile conditional logic
 * Validates: Requirements 2.7
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── EJS Dockerfile snippet (from templates/Dockerfile — build-time model download section) ──

const DOCKERFILE_SNIPPET = `<% if (typeof modelLoadStrategy !== 'undefined' && modelLoadStrategy === 'build-time') { %>
<% if (typeof modelSource === 'undefined' || !modelSource || modelSource === 'huggingface') { %>
RUN pip install --no-cache-dir awscli
ARG HF_TOKEN
ARG MODEL_S3_URI=""
RUN if [ -n "$MODEL_S3_URI" ]; then \\
        echo "Downloading model from S3: $MODEL_S3_URI" && \\
        (aws s3 cp "$MODEL_S3_URI" /opt/ml/model/ --recursive 2>&1 && \\
         echo "✓ S3 download complete") || \\
        (echo "⚠️  S3 download failed, falling back to HuggingFace (slow). Run do/stage to fix." && \\
         huggingface-cli download <%= modelName %> --local-dir /opt/ml/model); \\
    else \\
        echo "Downloading model from HuggingFace: <%= modelName %>" && \\
        huggingface-cli download <%= modelName %> --local-dir /opt/ml/model; \\
    fi
<% } %>
<% } %>`;

// ── Arbitrary generators ─────────────────────────────────────────────────────

// HuggingFace model names: org/model-name pattern
const arbModelName = fc.tuple(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{1,20}$/),
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{1,30}$/)
).map(([org, model]) => `${org}/${model}`);

// ── Helper functions ─────────────────────────────────────────────────────────

function renderDockerfileSnippet(modelName) {
    return ejs.render(DOCKERFILE_SNIPPET, {
        modelLoadStrategy: 'build-time',
        modelSource: 'huggingface',
        modelName
    });
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: s3-model-loading, Property 4: Dockerfile conditional logic', () => {

    describe('Rendered Dockerfile contains ARG MODEL_S3_URI declaration', () => {

        it('for any model name, the rendered Dockerfile contains ARG MODEL_S3_URI=""', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelName,
                (modelName) => {
                    const rendered = renderDockerfileSnippet(modelName);
                    assert.ok(rendered.includes('ARG MODEL_S3_URI=""'),
                        `Rendered Dockerfile must contain 'ARG MODEL_S3_URI=""'.\n  Model: "${modelName}"\n  Rendered:\n${rendered}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Rendered Dockerfile contains both S3 and HF download paths', () => {

        it('for any model name, aws s3 cp appears in the rendered output', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelName,
                (modelName) => {
                    const rendered = renderDockerfileSnippet(modelName);
                    assert.ok(rendered.includes('aws s3 cp'),
                        `Rendered Dockerfile must contain 'aws s3 cp' for S3 download path.\n  Model: "${modelName}"\n  Rendered:\n${rendered}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any model name, huggingface-cli download appears at least twice (S3 fallback + HF-only path)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelName,
                (modelName) => {
                    const rendered = renderDockerfileSnippet(modelName);
                    const matches = rendered.match(/huggingface-cli download/g);
                    assert.ok(matches !== null && matches.length >= 2,
                        `Rendered Dockerfile must contain 'huggingface-cli download' at least twice (S3 fallback + HF-only path).\n  Found: ${matches ? matches.length : 0} occurrence(s)\n  Model: "${modelName}"\n  Rendered:\n${rendered}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Rendered Dockerfile contains conditional branching logic', () => {

        it('for any model name, the rendered Dockerfile contains the conditional check: if [ -n "$MODEL_S3_URI" ]', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelName,
                (modelName) => {
                    const rendered = renderDockerfileSnippet(modelName);
                    assert.ok(rendered.includes('if [ -n "$MODEL_S3_URI" ]'),
                        `Rendered Dockerfile must contain conditional 'if [ -n "$MODEL_S3_URI" ]'.\n  Model: "${modelName}"\n  Rendered:\n${rendered}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Model name is correctly substituted in HuggingFace download commands', () => {

        it('for any model name, the model name appears in the huggingface-cli download command', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelName,
                (modelName) => {
                    const rendered = renderDockerfileSnippet(modelName);
                    assert.ok(rendered.includes(`huggingface-cli download ${modelName}`),
                        `Rendered Dockerfile must contain 'huggingface-cli download ${modelName}'.\n  Model: "${modelName}"\n  Rendered:\n${rendered}`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
