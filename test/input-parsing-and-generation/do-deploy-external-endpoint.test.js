// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for external endpoint handling in do/deploy template.
 *
 * When ENDPOINT_EXTERNAL=true in do/config:
 *   - Skip create_endpoint_config() call
 *   - Skip create-endpoint call
 *   - Skip wait_endpoint() — endpoint is already InService
 *   - Go directly to IC creation
 *   - Validate endpoint still exists and is InService before creating IC (call _get_endpoint_status)
 *   - If endpoint is gone or not InService: error with clear message
 *
 * Validates: Requirements 3.4
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

const templatePath = path.join(__dirname, '../../templates/do/deploy');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/deploy template with the given variables.
 */
function renderDeploy(vars) {
    return ejs.render(templateContent, vars, { filename: templatePath });
}

/** Base config for realtime-inference deployment */
const baseConfig = {
    projectName: 'test-project',
    deploymentConfig: 'transformers-vllm',
    framework: 'transformers',
    modelServer: 'vllm',
    awsRegion: 'us-east-1',
    buildTarget: 'codebuild',
    deploymentTarget: 'realtime-inference',
    instanceType: 'ml.g5.xlarge',
    inferenceAmiVersion: undefined,
    hyperPodCluster: undefined,
    hyperPodNamespace: undefined,
    hyperPodReplicas: undefined,
    fsxVolumeHandle: undefined
};

describe('do/deploy External Endpoint Handling (Req 3.4)', () => {
    let output;

    before(() => {
        console.log('\n🚀 Starting do/deploy External Endpoint Handling Tests');
        console.log('📋 Testing: Requirements 3.4');
        console.log('🔧 Configuration: EJS template rendering\n');

        output = renderDeploy(baseConfig);
    });

    it('should contain ENDPOINT_EXTERNAL check in the endpoint creation section', () => {
        console.log('  🧪 Req 3.4: deploy contains ENDPOINT_EXTERNAL conditional');

        assert.ok(
            output.includes('ENDPOINT_EXTERNAL:-false'),
            'Deploy must check ENDPOINT_EXTERNAL variable with default false'
        );
        assert.ok(
            output.includes('ENDPOINT_EXTERNAL:-false') && output.includes('"true"'),
            'Deploy must compare ENDPOINT_EXTERNAL against "true"'
        );

        console.log('    ✅ ENDPOINT_EXTERNAL check present');
    });

    it('should validate external endpoint status via _get_endpoint_status', () => {
        console.log('  🧪 Req 3.4: deploy validates external endpoint via _get_endpoint_status');

        // The external endpoint path must call _get_endpoint_status to validate
        assert.ok(
            output.includes('_get_endpoint_status'),
            'Deploy must call _get_endpoint_status to validate external endpoint'
        );

        console.log('    ✅ _get_endpoint_status validation present');
    });

    it('should error when external endpoint is not found (empty status)', () => {
        console.log('  🧪 Req 3.4: deploy errors when external endpoint not found');

        // Must check for empty status (endpoint not found)
        assert.ok(
            output.includes('External endpoint not found'),
            'Deploy must show "External endpoint not found" error message'
        );
        // Must exit with error code
        assert.ok(
            output.includes('exit 4'),
            'Deploy must exit with code 4 on external endpoint failure'
        );

        console.log('    ✅ Error message for missing external endpoint present');
    });

    it('should error when external endpoint is not InService', () => {
        console.log('  🧪 Req 3.4: deploy errors when external endpoint not InService');

        assert.ok(
            output.includes('External endpoint not InService'),
            'Deploy must show "External endpoint not InService" error message'
        );

        console.log('    ✅ Error message for non-InService external endpoint present');
    });

    it('should show success message when external endpoint is InService', () => {
        console.log('  🧪 Req 3.4: deploy shows success when external endpoint is InService');

        assert.ok(
            output.includes('External endpoint is InService'),
            'Deploy must show success message when external endpoint is InService'
        );

        console.log('    ✅ Success message for InService external endpoint present');
    });

    it('should skip to IC creation when external endpoint is valid', () => {
        console.log('  🧪 Req 3.4: deploy skips to IC creation for external endpoints');

        // After validating external endpoint, SKIP_TO should be set to create_ic
        assert.ok(
            output.includes('SKIP_TO="create_ic"'),
            'Deploy must set SKIP_TO="create_ic" after validating external endpoint'
        );

        console.log('    ✅ SKIP_TO=create_ic set for external endpoints');
    });

    it('should NOT call create_endpoint_config in the external endpoint path', () => {
        console.log('  🧪 Req 3.4: external endpoint path skips create_endpoint_config');

        // The external endpoint block (between the if ENDPOINT_EXTERNAL check and the else)
        // should NOT contain create_endpoint_config
        // We verify this by checking the structure: the external path sets SKIP_TO=create_ic
        // and the create_endpoint_config call is in the else branch
        const externalBlock = output.substring(
            output.indexOf('ENDPOINT_EXTERNAL:-false') ,
            output.indexOf('SKIP_TO="create_ic"') + 'SKIP_TO="create_ic"'.length
        );

        assert.ok(
            !externalBlock.includes('create_endpoint_config'),
            'External endpoint path must NOT call create_endpoint_config'
        );
        assert.ok(
            !externalBlock.includes('sagemaker create-endpoint'),
            'External endpoint path must NOT call sagemaker create-endpoint'
        );

        console.log('    ✅ External endpoint path skips endpoint config and creation');
    });

    it('should show external endpoint info in deployment header', () => {
        console.log('  🧪 Req 3.4: deploy header shows external endpoint info');

        // The header section should show "(external)" when ENDPOINT_EXTERNAL is true
        assert.ok(
            output.includes('(external)'),
            'Deploy header must show (external) marker for external endpoints'
        );

        console.log('    ✅ External endpoint info shown in header');
    });

    it('should show external endpoint info in deployment summary', () => {
        console.log('  🧪 Req 3.4: deploy summary shows external endpoint info');

        // The deployment complete section should indicate external endpoint
        assert.ok(
            output.includes('external — not managed by this project'),
            'Deploy summary must indicate external endpoint is not managed by this project'
        );

        console.log('    ✅ External endpoint info shown in deployment summary');
    });

    it('should contain the external endpoint validation before the normal endpoint creation', () => {
        console.log('  🧪 Req 3.4: external endpoint validation comes before normal creation');

        // The ENDPOINT_EXTERNAL check should appear before create_endpoint_config
        const externalCheckPos = output.indexOf('ENDPOINT_EXTERNAL:-false');
        const createConfigPos = output.indexOf('create_endpoint_config');

        assert.ok(
            externalCheckPos > 0,
            'ENDPOINT_EXTERNAL check must exist in deploy'
        );
        assert.ok(
            createConfigPos > 0,
            'create_endpoint_config must exist in deploy'
        );
        assert.ok(
            externalCheckPos < createConfigPos,
            'ENDPOINT_EXTERNAL check must come before create_endpoint_config'
        );

        console.log('    ✅ External endpoint validation ordered correctly');
    });
});
