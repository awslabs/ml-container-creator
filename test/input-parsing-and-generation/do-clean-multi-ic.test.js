// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for multi-IC cleanup in do/clean template.
 *
 * Validates: Requirements 5.2, 5.3
 * - clean_ic function handles per-IC cleanup
 * - clean_endpoint iterates do/ic/*.conf and deletes all ICs before endpoint
 * - External endpoint handling skips endpoint deletion
 * - Legacy path (no do/ic/) still works
 * - Confirmation prompt shows IC count
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/clean');
const templateContent = readFileSync(templatePath, 'utf8');

function renderClean(vars) {
    return ejs.render(templateContent, vars);
}

const baseVars = {
    projectName: 'test-project',
    deploymentTarget: 'realtime-inference',
    instanceType: 'ml.g6e.48xlarge',
    awsRegion: 'us-east-1',
    framework: 'transformers',
    modelServer: 'vllm',
    buildTarget: 'codebuild'
};

describe('Multi-IC cleanup in do/clean (Requirements 5.2, 5.3)', () => {

    describe('clean_ic function (Requirement 5.2)', () => {

        it('should exist and accept an IC name argument', () => {
            const output = renderClean(baseVars);
            assert.ok(
                output.includes('clean_ic()'),
                'clean_ic function must exist'
            );
            assert.ok(
                output.includes('local ic_name="$1"'),
                'clean_ic must accept IC name as first argument'
            );
        });

        it('should look up IC_DEPLOYED_NAME from do/ic/<name>.conf', () => {
            const output = renderClean(baseVars);
            const cleanIcStart = output.indexOf('clean_ic()');
            const cleanIcEnd = output.indexOf('cleaned"', cleanIcStart);
            const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

            assert.ok(
                cleanIcBlock.includes('ic/${ic_name}.conf'),
                'clean_ic must reference do/ic/<name>.conf'
            );
            assert.ok(
                cleanIcBlock.includes('IC_DEPLOYED_NAME'),
                'clean_ic must look up IC_DEPLOYED_NAME'
            );
        });

        it('should call DeleteInferenceComponent', () => {
            const output = renderClean(baseVars);
            const cleanIcStart = output.indexOf('clean_ic()');
            const cleanIcEnd = output.indexOf('cleaned"', cleanIcStart);
            const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

            assert.ok(
                cleanIcBlock.includes('delete-inference-component'),
                'clean_ic must call delete-inference-component'
            );
        });

        it('should wait for deletion to complete', () => {
            const output = renderClean(baseVars);
            const cleanIcStart = output.indexOf('clean_ic()');
            const cleanIcEnd = output.indexOf('cleaned"', cleanIcStart);
            const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

            assert.ok(
                cleanIcBlock.includes('wait inference-component-deleted'),
                'clean_ic must wait for IC deletion'
            );
        });

        it('should clear IC_DEPLOYED_NAME and IC_DEPLOYED_AT from conf file', () => {
            const output = renderClean(baseVars);
            const cleanIcStart = output.indexOf('clean_ic()');
            const cleanIcEnd = output.indexOf('cleaned"', cleanIcStart);
            const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

            assert.ok(
                cleanIcBlock.includes('IC_DEPLOYED_NAME=/d'),
                'clean_ic must clear IC_DEPLOYED_NAME'
            );
            assert.ok(
                cleanIcBlock.includes('IC_DEPLOYED_AT=/d'),
                'clean_ic must clear IC_DEPLOYED_AT'
            );
        });

        it('should update manifest', () => {
            const output = renderClean(baseVars);
            const cleanIcStart = output.indexOf('clean_ic()');
            const cleanIcEnd = output.indexOf('cleaned"', cleanIcStart);
            const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

            assert.ok(
                cleanIcBlock.includes('./do/manifest delete'),
                'clean_ic must update manifest'
            );
        });

        it('should NOT delete the endpoint', () => {
            const output = renderClean(baseVars);
            const cleanIcStart = output.indexOf('clean_ic()');
            const cleanIcEnd = output.indexOf('cleaned"', cleanIcStart);
            const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

            // Should not contain delete-endpoint (without the -component suffix)
            const deleteEndpointCalls = cleanIcBlock.match(/sagemaker delete-endpoint[^-]/g);
            assert.ok(
                !deleteEndpointCalls,
                'clean_ic must NOT call delete-endpoint'
            );
        });
    });

    describe('clean_endpoint multi-IC iteration (Requirement 5.3)', () => {

        it('should iterate do/ic/*.conf in the standard (non-external) path', () => {
            const output = renderClean(baseVars);

            // Find the clean_endpoint function, specifically the non-external path
            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            // The non-external path should iterate IC configs
            assert.ok(
                cleanEndpointBlock.includes('ic/*.conf'),
                'clean_endpoint standard path must iterate do/ic/*.conf files'
            );
        });

        it('should delete all ICs before deleting the endpoint', () => {
            const output = renderClean(baseVars);

            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            // IC deletion should come before endpoint deletion
            const icDeletionPos = cleanEndpointBlock.indexOf('IC_NAMES_TO_DELETE');
            const endpointDeletionPos = cleanEndpointBlock.indexOf('Deleting endpoint: ${EP_NAME}');

            assert.ok(icDeletionPos > 0, 'Must have IC deletion logic');
            assert.ok(endpointDeletionPos > 0, 'Must have endpoint deletion logic');
            assert.ok(
                icDeletionPos < endpointDeletionPos,
                'IC deletion must come before endpoint deletion (SageMaker requires ICs gone first)'
            );
        });

        it('should wait for each IC deletion sequentially', () => {
            const output = renderClean(baseVars);

            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            // The multi-IC iteration block should wait for each IC
            assert.ok(
                cleanEndpointBlock.includes('wait inference-component-deleted'),
                'clean_endpoint must wait for IC deletion'
            );
        });

        it('should show IC count in confirmation prompt', () => {
            const output = renderClean(baseVars);

            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            // Should have dynamic IC count in confirmation message
            assert.ok(
                cleanEndpointBlock.includes('${IC_COUNT}'),
                'Confirmation prompt must include IC count'
            );
            assert.ok(
                cleanEndpointBlock.includes('inference component'),
                'Confirmation prompt must mention inference components'
            );
            assert.ok(
                cleanEndpointBlock.includes('and endpoint'),
                'Confirmation prompt must mention endpoint'
            );
        });

        it('should handle legacy path when no do/ic/ directory exists', () => {
            const output = renderClean(baseVars);

            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            // Legacy path uses IC_NAME from config when IC_COUNT is 0
            assert.ok(
                cleanEndpointBlock.includes('IC_EXISTS'),
                'clean_endpoint must have legacy IC_EXISTS check'
            );
            assert.ok(
                cleanEndpointBlock.includes('IC_COUNT') && cleanEndpointBlock.includes('-eq 0'),
                'Legacy path must only activate when IC_COUNT is 0 (no do/ic/ configs found)'
            );
        });

        it('should clear IC_DEPLOYED_NAME and IC_DEPLOYED_AT from conf files during multi-IC cleanup', () => {
            const output = renderClean(baseVars);

            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            assert.ok(
                cleanEndpointBlock.includes('IC_DEPLOYED_NAME=/d') &&
                cleanEndpointBlock.includes('IC_DEPLOYED_AT=/d'),
                'clean_endpoint must clear IC_DEPLOYED_NAME and IC_DEPLOYED_AT from conf files'
            );
        });
    });

    describe('External endpoint handling (Requirement 5.3)', () => {

        it('should skip endpoint/config deletion when ENDPOINT_EXTERNAL=true', () => {
            const output = renderClean(baseVars);

            // Extract the external endpoint block
            const externalStart = output.indexOf('Endpoint is external');
            const externalEnd = output.indexOf('External endpoint cleanup complete');
            const externalBlock = output.substring(externalStart, externalEnd);

            // Should NOT contain delete-endpoint (the endpoint itself)
            const deleteEndpointCalls = externalBlock.match(/sagemaker delete-endpoint[^-]/g);
            assert.ok(
                !deleteEndpointCalls,
                'External path must NOT call delete-endpoint'
            );
            assert.ok(
                !externalBlock.includes('delete-endpoint-config'),
                'External path must NOT call delete-endpoint-config'
            );
        });

        it('should print the external endpoint warning message', () => {
            const output = renderClean(baseVars);

            assert.ok(
                output.includes('Endpoint is external — only removing inference components'),
                'Must print external endpoint warning'
            );
        });

        it('should still delete ICs when ENDPOINT_EXTERNAL=true', () => {
            const output = renderClean(baseVars);

            const externalStart = output.indexOf('Endpoint is external');
            const externalEnd = output.indexOf('External endpoint cleanup complete');
            const externalBlock = output.substring(externalStart, externalEnd);

            assert.ok(
                externalBlock.includes('delete-inference-component'),
                'External path must still delete inference components'
            );
        });
    });
});
