// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * JumpStart Rejection Unit Tests
 *
 * Tests that jumpstart:// and jumpstart-hub:// prefixes are rejected with
 * a clear migration message directing users to use HuggingFace model IDs.
 *
 * Feature: marketplace-model-packages
 * Validates: Requirements 8.5
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { resolveModel } from '../../servers/model-picker/index.js';
import { runGenerator } from '../helpers/run-generator.js';

describe('JumpStart Rejection', () => {

    // ── CLI mode: jumpstart:// prefix rejected with process.exit(1) ──────

    describe('CLI mode rejection (process.exit)', () => {

        it('rejects jumpstart:// prefix with migration message and exit code 1', () => {
            let error;
            try {
                runGenerator({
                    'project-name': 'test-jumpstart-reject',
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'jumpstart://huggingface-llm-falcon-7b',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
            } catch (e) {
                error = e;
            }

            assert.ok(error, 'Should have thrown an error (process.exit)');
            assert.strictEqual(error.exitCode, 1, 'Should exit with code 1');
            assert.ok(
                error.stderr.includes('JumpStart is no longer supported'),
                `Should contain migration message, got: ${error.stderr.substring(0, 500)}`
            );
            assert.ok(
                error.stderr.includes('huggingface-llm-falcon-7b'),
                'Should include the bare model ID in the migration message'
            );
        });

        it('rejects jumpstart-hub:// prefix with migration message and exit code 1', () => {
            let error;
            try {
                runGenerator({
                    'project-name': 'test-jumpstart-hub-reject',
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'jumpstart-hub://my-hub/my-model',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
            } catch (e) {
                error = e;
            }

            assert.ok(error, 'Should have thrown an error (process.exit)');
            assert.strictEqual(error.exitCode, 1, 'Should exit with code 1');
            assert.ok(
                error.stderr.includes('JumpStart is no longer supported'),
                `Should contain migration message, got: ${error.stderr.substring(0, 500)}`
            );
            assert.ok(
                error.stderr.includes('my-hub/my-model'),
                'Should include the bare model ID in the migration message'
            );
        });

        it('migration message suggests valid alternatives', () => {
            let error;
            try {
                runGenerator({
                    'project-name': 'test-jumpstart-alternatives',
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'jumpstart://some-model',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
            } catch (e) {
                error = e;
            }

            assert.ok(error, 'Should have thrown an error');
            const output = error.stderr;
            assert.ok(output.includes('HuggingFace model ID'), 'Should suggest HuggingFace');
            assert.ok(output.includes('s3://'), 'Should suggest S3 prefix');
            assert.ok(output.includes('registry://'), 'Should suggest registry prefix');
            assert.ok(output.includes('marketplace://'), 'Should suggest marketplace prefix');
        });
    });

    // ── Model-picker MCP server: jumpstart:// returns empty with message ─

    describe('Model-picker MCP server rejection', () => {

        /** Helper to parse the MCP response content */
        function parseResponse(response) {
            assert.ok(Array.isArray(response.content));
            assert.strictEqual(response.content.length, 1);
            assert.strictEqual(response.content[0].type, 'text');
            return JSON.parse(response.content[0].text);
        }

        it('rejects jumpstart:// prefix with empty values and migration message', async () => {
            const response = await resolveModel({
                model_id: 'jumpstart://huggingface-llm-falcon-7b',
                mode: 'discover'
            });
            const parsed = parseResponse(response);

            assert.deepStrictEqual(parsed.values, {},
                'Should return empty values for jumpstart:// prefix');
            assert.deepStrictEqual(parsed.choices, {},
                'Should return empty choices for jumpstart:// prefix');
            assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
                'Should return a migration message');
            assert.ok(parsed.message.includes('JumpStart is no longer supported'),
                `Migration message should mention JumpStart removal, got: ${parsed.message}`);
            assert.ok(parsed.message.includes('huggingface-llm-falcon-7b'),
                'Migration message should include the bare model ID');
        });

        it('rejects jumpstart-hub:// prefix with empty values and migration message', async () => {
            const response = await resolveModel({
                model_id: 'jumpstart-hub://my-hub/my-model',
                mode: 'discover'
            });
            const parsed = parseResponse(response);

            assert.deepStrictEqual(parsed.values, {},
                'Should return empty values for jumpstart-hub:// prefix');
            assert.deepStrictEqual(parsed.choices, {},
                'Should return empty choices for jumpstart-hub:// prefix');
            assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
                'Should return a migration message');
            assert.ok(parsed.message.includes('JumpStart is no longer supported'),
                `Migration message should mention JumpStart removal, got: ${parsed.message}`);
            assert.ok(parsed.message.includes('my-hub/my-model'),
                'Migration message should include the bare model ID');
        });

        it('rejects jumpstart:// in static mode too', async () => {
            const response = await resolveModel({
                model_id: 'jumpstart://some-model',
                mode: 'static'
            });
            const parsed = parseResponse(response);

            assert.deepStrictEqual(parsed.values, {},
                'Should return empty values in static mode');
            assert.ok(parsed.message.includes('JumpStart is no longer supported'),
                'Should reject in static mode too');
        });

        it('rejects jumpstart-hub:// in static mode too', async () => {
            const response = await resolveModel({
                model_id: 'jumpstart-hub://private-hub/model-name',
                mode: 'static'
            });
            const parsed = parseResponse(response);

            assert.deepStrictEqual(parsed.values, {},
                'Should return empty values in static mode');
            assert.ok(parsed.message.includes('JumpStart is no longer supported'),
                'Should reject in static mode too');
            assert.ok(parsed.message.includes('private-hub/model-name'),
                'Should include the bare model ID');
        });

        it('strips jumpstart:// prefix correctly in migration message', async () => {
            const response = await resolveModel({
                model_id: 'jumpstart://huggingface-reasoning-qwen3-14b',
                mode: 'discover'
            });
            const parsed = parseResponse(response);

            assert.ok(parsed.message.includes('huggingface-reasoning-qwen3-14b'),
                'Should strip jumpstart:// prefix and show bare ID');
            assert.ok(!parsed.message.includes('jumpstart://huggingface-reasoning-qwen3-14b'),
                'Should not include the full prefixed URI in the suggestion');
        });

        it('strips jumpstart-hub:// prefix correctly in migration message', async () => {
            const response = await resolveModel({
                model_id: 'jumpstart-hub://team-hub/llama-fine-tuned',
                mode: 'discover'
            });
            const parsed = parseResponse(response);

            assert.ok(parsed.message.includes('team-hub/llama-fine-tuned'),
                'Should strip jumpstart-hub:// prefix and show bare ID');
        });
    });
});
