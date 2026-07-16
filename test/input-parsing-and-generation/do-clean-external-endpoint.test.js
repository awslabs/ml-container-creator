// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for external endpoint handling in do/clean template.
 *
 * Validates: Requirement 3.5
 * - When ENDPOINT_EXTERNAL=true, do/clean endpoint only deletes ICs, not the endpoint itself
 * - do/clean ic <name> works the same regardless of external flag
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/clean.d/managed-inference');
const templateContent = readFileSync(templatePath, 'utf8');

function renderClean(vars) {
    return ejs.render(templateContent, vars, { filename: templatePath });
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

describe('External endpoint handling in clean (Requirement 3.5)', () => {

    it('should contain ENDPOINT_EXTERNAL check in clean_endpoint function', () => {
        const output = renderClean(baseVars);

        assert.ok(
            output.includes('ENDPOINT_EXTERNAL:-false'),
            'clean_endpoint must check ENDPOINT_EXTERNAL variable'
        );
        assert.ok(
            output.includes('Endpoint is external — only removing inference components'),
            'clean_endpoint must print external endpoint warning'
        );
    });

    it('should iterate do/ic/*.conf when ENDPOINT_EXTERNAL=true', () => {
        const output = renderClean(baseVars);

        // The external endpoint path should iterate IC configs
        const externalBlock = output.substring(
            output.indexOf('Endpoint is external'),
            output.indexOf('External endpoint cleanup complete')
        );

        assert.ok(
            externalBlock.includes('ic/*.conf'),
            'External endpoint path must iterate do/ic/*.conf files'
        );
        assert.ok(
            externalBlock.includes('delete-inference-component'),
            'External endpoint path must delete inference components'
        );
    });

    it('should NOT delete endpoint or endpoint config when ENDPOINT_EXTERNAL=true', () => {
        const output = renderClean(baseVars);

        // Extract the external endpoint block
        const externalStart = output.indexOf('Endpoint is external');
        const externalEnd = output.indexOf('External endpoint cleanup complete');
        const externalBlock = output.substring(externalStart, externalEnd);

        // The external block should NOT contain delete-endpoint (the endpoint itself)
        // Note: it WILL contain delete-inference-component, which is fine
        assert.ok(
            !externalBlock.includes('delete-endpoint-config'),
            'External endpoint path must NOT delete endpoint config'
        );
        // Check that delete-endpoint is not called (but delete-inference-component is OK)
        const deleteEndpointCalls = externalBlock.match(/sagemaker delete-endpoint[^-]/g);
        assert.ok(
            !deleteEndpointCalls,
            'External endpoint path must NOT call delete-endpoint on the endpoint itself'
        );
    });

    it('should have ic subcommand in case statement for realtime-inference', () => {
        const output = renderClean(baseVars);

        assert.ok(
            output.includes('ic)'),
            'realtime-inference must contain ic case in switch'
        );
        assert.ok(
            output.includes('clean_ic'),
            'realtime-inference must contain clean_ic function'
        );
    });

    it('should NOT have ic subcommand for non-realtime deployment targets', () => {
        const asyncTemplatePath = path.join(__dirname, '../../templates/do/clean.d/async-inference');
        const asyncTemplateContent = readFileSync(asyncTemplatePath, 'utf8');
        const asyncVars = { ...baseVars, deploymentTarget: 'async-inference' };
        const asyncOutput = ejs.render(asyncTemplateContent, asyncVars, { filename: asyncTemplatePath });

        assert.ok(
            !asyncOutput.includes('clean_ic'),
            'async-inference must NOT contain clean_ic function'
        );
        assert.ok(
            !asyncOutput.includes('ic)'),
            'async-inference must NOT contain ic case in switch'
        );
    });

    it('clean_ic function should look up IC_DEPLOYED_NAME from config file', () => {
        const output = renderClean(baseVars);

        // Find the clean_ic function
        const cleanIcStart = output.indexOf('clean_ic()');
        const cleanIcEnd = output.indexOf('}', output.indexOf('cleaned"', cleanIcStart));
        const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

        assert.ok(
            cleanIcBlock.includes('IC_DEPLOYED_NAME'),
            'clean_ic must look up IC_DEPLOYED_NAME from config'
        );
        assert.ok(
            cleanIcBlock.includes('ic/${ic_name}.conf') || cleanIcBlock.includes('/ic/${ic_name}.conf'),
            'clean_ic must reference the IC config file by name'
        );
    });

    it('clean_ic function should delete the inference component and clear state', () => {
        const output = renderClean(baseVars);

        const cleanIcStart = output.indexOf('clean_ic()');
        const cleanIcEnd = output.indexOf('}', output.indexOf('cleaned"', cleanIcStart));
        const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

        assert.ok(
            cleanIcBlock.includes('delete-inference-component'),
            'clean_ic must call delete-inference-component'
        );
        assert.ok(
            cleanIcBlock.includes('IC_DEPLOYED_NAME=/d'),
            'clean_ic must clear IC_DEPLOYED_NAME from config'
        );
        assert.ok(
            cleanIcBlock.includes('IC_DEPLOYED_AT=/d'),
            'clean_ic must clear IC_DEPLOYED_AT from config'
        );
    });

    it('clean_ic function should NOT check ENDPOINT_EXTERNAL flag', () => {
        const output = renderClean(baseVars);

        const cleanIcStart = output.indexOf('clean_ic()');
        const cleanIcEnd = output.indexOf('}', output.indexOf('cleaned"', cleanIcStart));
        const cleanIcBlock = output.substring(cleanIcStart, cleanIcEnd);

        assert.ok(
            !cleanIcBlock.includes('ENDPOINT_EXTERNAL'),
            'clean_ic must NOT check ENDPOINT_EXTERNAL (works the same regardless)'
        );
    });

    it('should parse CLEANUP_ARG for ic subcommand', () => {
        const output = renderClean(baseVars);

        // Verify argument parsing supports two positional args
        assert.ok(
            output.includes('CLEANUP_ARG'),
            'Must have CLEANUP_ARG variable for ic name argument'
        );

        // Verify ic case passes CLEANUP_ARG to clean_ic
        assert.ok(
            output.includes('clean_ic "${CLEANUP_ARG}"'),
            'ic case must pass CLEANUP_ARG to clean_ic function'
        );
    });

    it('should include ic <name> in usage text for realtime-inference', () => {
        const output = renderClean(baseVars);

        assert.ok(
            output.includes('ic <name>'),
            'Usage text must include ic <name> subcommand'
        );
    });
});
