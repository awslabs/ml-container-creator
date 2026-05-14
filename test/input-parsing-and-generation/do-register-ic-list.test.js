// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/register IC List Interaction Tests
 *
 * Validates that the do/register template correctly builds an IC list from
 * do/ic/ directory contents and includes it in the registry metadata.
 *
 * - When do/ic/ directory exists, builds IC list from all conf files
 * - IC list stored as JSON array: [{name, image, gpuCount, copyCount}]
 * - When --ci flag is used, only includes the first IC alphabetically
 * - When no do/ic/ directory exists, uses legacy behavior (single IC from do/config)
 *
 * Validates: Requirements 2.7
 *
 * Feature: multi-ic-endpoints
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/register');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/register template with the given variables.
 */
function renderRegister(vars) {
    return ejs.render(templateContent, vars);
}

/** Base template variables for a real-time inference project */
function realtimeVars(overrides = {}) {
    return {
        projectName: 'my-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g6e.48xlarge',
        modelName: 'meta-llama/Llama-3-70B',
        modelFormat: null,
        modelEnvVars: {},
        serverEnvVars: {},
        orderedEnvVars: [],
        baseImage: 'vllm/vllm-openai:v0.8.5',
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        icCpuCount: null,
        icMemorySize: null,
        icGpuCount: 4,
        icCopyCount: 1,
        icModelWeight: null,
        endpointInitialInstanceCount: null,
        endpointDataCapturePercent: null,
        endpointVariantName: null,
        endpointVolumeSize: null,
        inferenceAmiVersion: null,
        hfToken: null,
        hfTokenArn: null,
        ngcTokenArn: null,
        ngcApiKey: null,
        ...overrides
    };
}

/** Base template variables for a batch transform project */
function batchVars(overrides = {}) {
    return {
        projectName: 'my-batch-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'batch-transform',
        instanceType: 'ml.g5.2xlarge',
        modelName: 'meta-llama/Llama-3-8B',
        modelFormat: null,
        modelEnvVars: {},
        serverEnvVars: {},
        orderedEnvVars: [],
        baseImage: 'vllm/vllm-openai:v0.8.5',
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        icCpuCount: null,
        icMemorySize: null,
        icGpuCount: null,
        icCopyCount: null,
        icModelWeight: null,
        endpointInitialInstanceCount: null,
        endpointDataCapturePercent: null,
        endpointVariantName: null,
        endpointVolumeSize: null,
        inferenceAmiVersion: null,
        hfToken: null,
        hfTokenArn: null,
        ngcTokenArn: null,
        ngcApiKey: null,
        ...overrides
    };
}

describe('do/register IC List Interaction (Req 2.7)', () => {
    before(() => {
        console.log('\n🚀 Starting do/register IC List Interaction Tests');
        console.log('📋 Testing: Requirements 2.7');
        console.log('🔧 Configuration: EJS template rendering\n');
    });

    describe('IC list building from do/ic/ directory', () => {
        it('rendered register script contains IC list building logic for realtime-inference', () => {
            const rendered = renderRegister(realtimeVars());

            // Should contain the IC list building section
            assert.ok(
                rendered.includes('IC_LIST_JSON='),
                'Register script must initialize IC_LIST_JSON variable'
            );
            assert.ok(
                rendered.includes('if [ -d "${SCRIPT_DIR}/ic" ]'),
                'Register script must check for do/ic/ directory existence'
            );
        });

        it('iterates do/ic/*.conf files in alphabetical order', () => {
            const rendered = renderRegister(realtimeVars());

            assert.ok(
                rendered.includes('for conf in "${SCRIPT_DIR}"/ic/*.conf'),
                'Register script must iterate over do/ic/*.conf files'
            );
        });

        it('extracts IC_IMAGE_TAG, IC_GPU_COUNT, IC_COPY_COUNT from each conf file', () => {
            const rendered = renderRegister(realtimeVars());

            // The script sources each conf file and extracts the relevant variables
            assert.ok(
                rendered.includes('source "${conf}"'),
                'Register script must source each IC conf file'
            );
            assert.ok(
                rendered.includes('IC_IMAGE_TAG'),
                'Register script must extract IC_IMAGE_TAG from conf files'
            );
            assert.ok(
                rendered.includes('IC_GPU_COUNT'),
                'Register script must extract IC_GPU_COUNT from conf files'
            );
            assert.ok(
                rendered.includes('IC_COPY_COUNT'),
                'Register script must extract IC_COPY_COUNT from conf files'
            );
        });

        it('builds JSON array with name, image, gpuCount, copyCount fields', () => {
            const rendered = renderRegister(realtimeVars());

            // In bash heredocs with escaped quotes, the fields appear as \"name\"
            assert.ok(
                rendered.includes('\\"name\\"'),
                'IC list entries must include "name" field'
            );
            assert.ok(
                rendered.includes('\\"image\\"'),
                'IC list entries must include "image" field'
            );
            assert.ok(
                rendered.includes('\\"gpuCount\\"'),
                'IC list entries must include "gpuCount" field'
            );
            assert.ok(
                rendered.includes('\\"copyCount\\"'),
                'IC list entries must include "copyCount" field'
            );
        });

        it('derives IC name from config filename (basename without .conf)', () => {
            const rendered = renderRegister(realtimeVars());

            assert.ok(
                rendered.includes('IC_BASENAME=$(basename "${conf}" .conf)'),
                'Register script must derive IC name from config filename by stripping .conf'
            );
        });
    });

    describe('CI mode (--ci flag) behavior', () => {
        it('CI mode only includes the first IC alphabetically when multiple ICs exist', () => {
            const rendered = renderRegister(realtimeVars());

            // Should check CI_MODE and IC_COUNT
            assert.ok(
                rendered.includes('CI_MODE'),
                'Register script must check CI_MODE flag'
            );
            assert.ok(
                rendered.includes('IC_COUNT'),
                'Register script must track IC count'
            );
            // Should use head -1 to get first conf alphabetically
            assert.ok(
                rendered.includes('head -1'),
                'Register script must select first IC alphabetically in CI mode'
            );
        });

        it('CI mode builds a single-element IC list array', () => {
            const rendered = renderRegister(realtimeVars());

            // In CI mode with multiple ICs, should build a single-element array
            assert.ok(
                rendered.includes('if [ "${CI_MODE}" = true ] && [ ${IC_COUNT} -gt 1 ]'),
                'Register script must check CI_MODE and IC_COUNT > 1 for CI filtering'
            );
        });
    });

    describe('Legacy behavior (no do/ic/ directory)', () => {
        it('falls back to single IC from do/config when no do/ic/ directory', () => {
            const rendered = renderRegister(realtimeVars());

            // Should have an else branch for legacy behavior
            assert.ok(
                rendered.includes('# Legacy: single IC from do/config'),
                'Register script must have legacy fallback when no do/ic/ directory'
            );
            // Legacy should use PROJECT_NAME-latest as image and IC_GPU_COUNT from do/config
            assert.ok(
                rendered.includes('"name\\":\\"default\\"'),
                'Legacy IC list must use "default" as the IC name'
            );
            assert.ok(
                rendered.includes('${PROJECT_NAME}-latest'),
                'Legacy IC list must use ${PROJECT_NAME}-latest as the image'
            );
        });
    });

    describe('IC list included in registry output', () => {
        it('IC list is included in DEPLOYMENT_JSON for realtime-inference', () => {
            const rendered = renderRegister(realtimeVars());

            // The icList field should appear in the JSON output
            assert.ok(
                rendered.includes('"icList": ${IC_LIST_JSON}'),
                'DEPLOYMENT_JSON must include icList field with IC_LIST_JSON value'
            );
        });

        it('IC list is included in CI record configJson for realtime-inference', () => {
            const rendered = renderRegister(realtimeVars());

            // Count occurrences of icList in the rendered output
            const matches = rendered.match(/"icList": \$\{IC_LIST_JSON\}/g);
            assert.ok(
                matches && matches.length >= 2,
                'icList must appear in both DEPLOYMENT_JSON and CI record configJson'
            );
        });

        it('IC list is NOT included for non-realtime deployment targets', () => {
            const rendered = renderRegister(batchVars());

            // Batch transform should not have IC list logic
            assert.ok(
                !rendered.includes('IC_LIST_JSON'),
                'Batch transform register should not include IC_LIST_JSON'
            );
            assert.ok(
                !rendered.includes('"icList"'),
                'Batch transform register should not include icList field'
            );
        });
    });

    describe('Endpoint-level config in registry', () => {
        it('register stores endpoint name (PROJECT_NAME) in output', () => {
            const rendered = renderRegister(realtimeVars());

            assert.ok(
                rendered.includes('"projectName": "${PROJECT_NAME}"'),
                'Register output must include projectName (used as endpoint identifier)'
            );
        });

        it('register stores instance type in output for realtime-inference', () => {
            const rendered = renderRegister(realtimeVars());

            assert.ok(
                rendered.includes('"instanceType": "${INSTANCE_TYPE}"'),
                'Register output must include instanceType for realtime-inference'
            );
        });

        it('register stores region in output', () => {
            const rendered = renderRegister(realtimeVars());

            assert.ok(
                rendered.includes('"awsRegion": "${AWS_REGION}"'),
                'Register output must include awsRegion'
            );
        });
    });
});
