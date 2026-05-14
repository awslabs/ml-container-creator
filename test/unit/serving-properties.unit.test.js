// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Example-based unit tests for the serving.properties template.
 *
 * Tests cover:
 * - HuggingFace backward compatibility: rendered output matches current template behavior
 * - JumpStart without URI: option.model_id is commented out with explanation
 * - S3 source: option.model_id equals artifactUri
 *
 * Feature: model-server-loading-adapter
 * Validates: Requirements 7.1, 7.3, 7.4, 11.3
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVING_PROPS_TEMPLATE_PATH = resolve(__dirname, '../../templates/code/serving.properties');
const SERVING_PROPS_TEMPLATE = readFileSync(SERVING_PROPS_TEMPLATE_PATH, 'utf-8');

// ── Helper: render serving.properties template with defaults ─────────────────

function renderServingProperties(overrides = {}) {
    const vars = {
        modelServer: 'lmi',
        modelSource: 'huggingface',
        modelName: 'meta-llama/Llama-2-7b-hf',
        artifactUri: '',
        hfToken: '',
        chatTemplate: '',
        orderedEnvVars: [],
        enableLora: false,
        maxLoras: 30,
        ...overrides
    };
    return ejs.render(SERVING_PROPS_TEMPLATE, vars);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter — serving.properties example-based tests', () => {

    // ── HuggingFace backward compatibility (Req 7.3, 11.3) ──────────────────

    describe('HuggingFace backward compatibility (Req 7.3, 11.3)', () => {

        for (const modelServer of ['lmi', 'djl']) {
            it(`${modelServer}: modelSource=huggingface sets option.model_id to modelName`, () => {
                // **Validates: Requirements 7.3, 11.3**
                const rendered = renderServingProperties({
                    modelServer,
                    modelSource: 'huggingface',
                    modelName: 'meta-llama/Llama-2-7b-hf'
                });
                assert.ok(
                    rendered.includes('option.model_id=meta-llama/Llama-2-7b-hf'),
                    `${modelServer}: HuggingFace source must set option.model_id to modelName`
                );
            });

            it(`${modelServer}: unset modelSource defaults to modelName`, () => {
                // **Validates: Requirements 7.3, 11.3**
                const rendered = renderServingProperties({
                    modelServer,
                    modelSource: '',
                    modelName: 'mistralai/Mistral-7B-v0.1'
                });
                assert.ok(
                    rendered.includes('option.model_id=mistralai/Mistral-7B-v0.1'),
                    `${modelServer}: unset modelSource must default option.model_id to modelName`
                );
            });

            it(`${modelServer}: HuggingFace source does NOT comment out option.model_id`, () => {
                // **Validates: Requirements 7.3, 11.3**
                const rendered = renderServingProperties({
                    modelServer,
                    modelSource: 'huggingface',
                    modelName: 'meta-llama/Llama-2-7b-hf'
                });
                const activeLines = rendered.split('\n').filter(
                    l => l.trim().startsWith('option.model_id=')
                );
                assert.strictEqual(
                    activeLines.length, 1,
                    `${modelServer}: HuggingFace source must have exactly one active option.model_id line`
                );
            });
        }
    });

    // ── JumpStart without URI (Req 7.4) ──────────────────────────────────────

    describe('jumpstart without URI comments out option.model_id (Req 7.4)', () => {

        for (const modelServer of ['lmi', 'djl']) {
            it(`${modelServer}: jumpstart with empty artifactUri comments out option.model_id`, () => {
                // **Validates: Requirements 7.4**
                const rendered = renderServingProperties({
                    modelServer,
                    modelSource: 'jumpstart',
                    modelName: 'huggingface-llm-falcon-7b',
                    artifactUri: ''
                });
                assert.ok(
                    rendered.includes('# option.model_id=/opt/ml/model'),
                    `${modelServer}: jumpstart without URI must comment out option.model_id`
                );
            });

            it(`${modelServer}: jumpstart with empty artifactUri includes explanatory note`, () => {
                // **Validates: Requirements 7.4**
                const rendered = renderServingProperties({
                    modelServer,
                    modelSource: 'jumpstart',
                    modelName: 'huggingface-llm-falcon-7b',
                    artifactUri: ''
                });
                assert.ok(
                    rendered.includes('Model will be loaded from /opt/ml/model'),
                    `${modelServer}: jumpstart without URI must include explanatory note`
                );
                assert.ok(
                    rendered.includes('SageMaker ModelDataUrl'),
                    `${modelServer}: jumpstart without URI must mention SageMaker ModelDataUrl`
                );
            });

            it(`${modelServer}: jumpstart with empty artifactUri has no active option.model_id`, () => {
                // **Validates: Requirements 7.4**
                const rendered = renderServingProperties({
                    modelServer,
                    modelSource: 'jumpstart',
                    modelName: 'huggingface-llm-falcon-7b',
                    artifactUri: ''
                });
                const activeLines = rendered.split('\n').filter(
                    l => l.trim().startsWith('option.model_id=')
                );
                assert.strictEqual(
                    activeLines.length, 0,
                    `${modelServer}: jumpstart without URI must NOT have active option.model_id`
                );
            });
        }
    });

    // ── S3 source (Req 7.1) ─────────────────────────────────────────────────

    describe('S3 source sets option.model_id to artifactUri (Req 7.1)', () => {

        for (const modelServer of ['lmi', 'djl']) {
            it(`${modelServer}: s3 source with artifactUri sets option.model_id to the URI`, () => {
                // **Validates: Requirements 7.1**
                const artifactUri = 's3://my-model-bucket/models/llama-7b/';
                const rendered = renderServingProperties({
                    modelServer,
                    modelSource: 's3',
                    modelName: 'my-custom-model',
                    artifactUri
                });
                assert.ok(
                    rendered.includes(`option.model_id=${artifactUri}`),
                    `${modelServer}: S3 source must set option.model_id to artifactUri`
                );
                assert.ok(
                    !rendered.includes('option.model_id=my-custom-model'),
                    `${modelServer}: S3 source must NOT set option.model_id to modelName`
                );
            });
        }
    });

    // ── Other non-HF sources with artifactUri (Req 7.2) ─────────────────────

    describe('non-HF sources with artifactUri set option.model_id to artifactUri (Req 7.2)', () => {

        const nonHfSources = ['jumpstart', 'jumpstart-hub', 'registry'];

        for (const modelServer of ['lmi', 'djl']) {
            for (const modelSource of nonHfSources) {
                it(`${modelSource}+${modelServer}: artifactUri present sets option.model_id to URI`, () => {
                    // **Validates: Requirements 7.2**
                    const artifactUri = 's3://jumpstart-cache-prod-us-east-1/huggingface-llm/model.tar.gz';
                    const rendered = renderServingProperties({
                        modelServer,
                        modelSource,
                        modelName: 'some-model-id',
                        artifactUri
                    });
                    assert.ok(
                        rendered.includes(`option.model_id=${artifactUri}`),
                        `${modelSource}+${modelServer}: must set option.model_id to artifactUri`
                    );
                });
            }
        }
    });
});
