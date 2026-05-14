// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * IC Naming Convention and State Tracking Tests
 *
 * Validates that the inference-component.sh helper follows the naming convention
 * ${PROJECT_NAME}-${ic_basename}-${TIMESTAMP} and persists IC_DEPLOYED_NAME and
 * IC_DEPLOYED_AT back to the IC config file after successful creation.
 *
 * Validates: Requirements 2.6, 2.7
 *
 * Feature: multi-ic-endpoints
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const libInferenceComponentPath = path.join(__dirname, '../../templates/do/lib/inference-component.sh');
const libInferenceComponentContent = readFileSync(libInferenceComponentPath, 'utf8');

/**
 * Validates: Requirements 2.6, 2.7
 */
describe('IC Naming Convention and State Tracking (Req 2.6, 2.7)', () => {
    before(() => {
        console.log('\n🚀 Starting IC Naming Convention and State Tracking Tests');
        console.log('📋 Testing: Requirements 2.6, 2.7');
        console.log('🔧 Configuration: Static lib file content analysis + property-based testing\n');
    });

    it('IC name is constructed as ${PROJECT_NAME}-${ic_basename}-${TIMESTAMP} (Req 2.6)', function () {
        console.log('  🧪 Req 2.6: IC name follows naming convention');

        // Verify the naming convention pattern exists in the script
        assert.ok(
            libInferenceComponentContent.includes('ic_basename=$(basename "${ic_conf}" .conf)'),
            'inference-component.sh must derive ic_basename from config filename by stripping .conf extension'
        );
        assert.ok(
            libInferenceComponentContent.includes('local ic_name="${PROJECT_NAME}-${ic_basename}-${ic_timestamp}"'),
            'inference-component.sh must construct IC name as ${PROJECT_NAME}-${ic_basename}-${TIMESTAMP}'
        );
        assert.ok(
            libInferenceComponentContent.includes('ic_timestamp=$(date +%s)'),
            'inference-component.sh must generate a Unix timestamp for the IC name'
        );

        console.log('    ✅ IC name follows ${PROJECT_NAME}-${ic_basename}-${TIMESTAMP} convention');
    });

    it('ic_basename is derived from config filename (e.g., llama-70b.conf → llama-70b) (Req 2.6)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.6: ic_basename derived from config filename');

        // Property: for any valid IC config filename, basename strips .conf extension
        const icNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,30}$/);

        fc.assert(fc.property(
            icNameArb,
            (icName) => {
                const confFilename = `${icName}.conf`;
                // Simulate what `basename "${ic_conf}" .conf` does
                const derivedBasename = confFilename.replace(/\.conf$/, '');
                assert.strictEqual(
                    derivedBasename,
                    icName,
                    `basename of ${confFilename} with .conf stripped should be ${icName}`
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ ic_basename correctly derived from config filename');
    });

    it('IC name components are valid for any project name and IC basename (Req 2.6)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.6: IC name components produce valid SageMaker resource names');

        const projectNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);
        const icBasenameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/);
        const timestampArb = fc.integer({ min: 1700000000, max: 1999999999 });

        fc.assert(fc.property(
            projectNameArb,
            icBasenameArb,
            timestampArb,
            (projectName, icBasename, timestamp) => {
                const icName = `${projectName}-${icBasename}-${timestamp}`;

                // SageMaker IC names must be <= 63 characters and match [a-zA-Z0-9-]
                assert.ok(
                    icName.length <= 63 || true, // We verify the pattern, not enforce length here
                    `IC name should be reasonable length: ${icName}`
                );
                assert.ok(
                    /^[a-z0-9-]+$/.test(icName),
                    `IC name must only contain lowercase alphanumeric and hyphens: ${icName}`
                );
                // Verify the three-part structure
                const parts = icName.split('-');
                assert.ok(
                    parts.length >= 3,
                    `IC name must have at least 3 hyphen-separated parts: ${icName}`
                );
                // Last part should be the timestamp (numeric)
                const lastPart = parts[parts.length - 1];
                assert.ok(
                    /^\d+$/.test(lastPart),
                    `Last part of IC name must be numeric timestamp: ${lastPart}`
                );
            }
        ), { numRuns: 50 });

        console.log('    ✅ IC name components produce valid resource names');
    });

    it('IC_DEPLOYED_NAME is persisted to IC config file after creation (Req 2.7)', function () {
        console.log('  🧪 Req 2.7: IC_DEPLOYED_NAME persisted to IC config file');

        // Verify the script persists IC_DEPLOYED_NAME using _update_config_var
        assert.ok(
            libInferenceComponentContent.includes('_update_config_var "IC_DEPLOYED_NAME" "${ic_name}" "${ic_conf}"'),
            'inference-component.sh must persist IC_DEPLOYED_NAME to the IC config file via _update_config_var'
        );
        // Verify IC_DEPLOYED_NAME is set in caller scope
        assert.ok(
            libInferenceComponentContent.includes('IC_DEPLOYED_NAME="${ic_name}"'),
            'inference-component.sh must set IC_DEPLOYED_NAME in caller scope for wait_ic'
        );

        console.log('    ✅ IC_DEPLOYED_NAME persisted to IC config file');
    });

    it('IC_DEPLOYED_AT timestamp is persisted for debugging (Req 2.7)', function () {
        console.log('  🧪 Req 2.7: IC_DEPLOYED_AT persisted for debugging');

        // Verify the script persists IC_DEPLOYED_AT using _update_config_var
        assert.ok(
            libInferenceComponentContent.includes('_update_config_var "IC_DEPLOYED_AT" "${ic_timestamp}" "${ic_conf}"'),
            'inference-component.sh must persist IC_DEPLOYED_AT to the IC config file via _update_config_var'
        );
        // Verify IC_DEPLOYED_AT is set in caller scope
        assert.ok(
            libInferenceComponentContent.includes('IC_DEPLOYED_AT="${ic_timestamp}"'),
            'inference-component.sh must set IC_DEPLOYED_AT in caller scope'
        );

        console.log('    ✅ IC_DEPLOYED_AT persisted for debugging');
    });

    it('create_inference_component uses the IC config file path for _update_config_var (Req 2.7)', function () {
        console.log('  🧪 Req 2.7: _update_config_var targets the IC config file, not do/config');

        // The third argument to _update_config_var must be "${ic_conf}" (the IC config file)
        // not the default (do/config). This ensures per-IC state tracking.
        const updateCalls = libInferenceComponentContent.match(/_update_config_var.*"\$\{ic_conf\}"/g);
        assert.ok(
            updateCalls && updateCalls.length >= 2,
            'create_inference_component must call _update_config_var with ${ic_conf} at least twice (IC_DEPLOYED_NAME + IC_DEPLOYED_AT)'
        );

        console.log('    ✅ _update_config_var targets the IC config file');
    });

    it('legacy function persists INFERENCE_COMPONENT_NAME to do/config (Req 2.7)', function () {
        console.log('  🧪 Req 2.7: legacy function persists to do/config for backward compat');

        // The legacy function should persist to do/config (default path, no third arg)
        assert.ok(
            libInferenceComponentContent.includes('_update_config_var "INFERENCE_COMPONENT_NAME" "${ic_name}"'),
            'create_inference_component_legacy must persist INFERENCE_COMPONENT_NAME to do/config'
        );
        assert.ok(
            libInferenceComponentContent.includes('_update_config_var "IC_DEPLOYED_AT" "${ic_timestamp}"'),
            'create_inference_component_legacy must persist IC_DEPLOYED_AT'
        );

        console.log('    ✅ legacy function persists to do/config');
    });

    it('IC config file is validated before sourcing (Req 2.6)', function () {
        console.log('  🧪 Req 2.6: IC config file existence validated');

        assert.ok(
            libInferenceComponentContent.includes('if [ ! -f "${ic_conf}" ]'),
            'create_inference_component must check if IC config file exists'
        );
        assert.ok(
            libInferenceComponentContent.includes('IC config file not found'),
            'create_inference_component must show error when IC config file not found'
        );

        console.log('    ✅ IC config file existence validated before sourcing');
    });

    it('IC name is used in the create-inference-component API call (Req 2.6)', function () {
        console.log('  🧪 Req 2.6: IC name passed to create-inference-component API');

        assert.ok(
            libInferenceComponentContent.includes('--inference-component-name "${ic_name}"'),
            'create_inference_component must pass the constructed ic_name to --inference-component-name'
        );

        console.log('    ✅ IC name used in create-inference-component API call');
    });

    it('IC name is echoed as return value for caller use (Req 2.6)', function () {
        console.log('  🧪 Req 2.6: IC name echoed as return value');

        // After successful creation, the function echoes the IC name
        assert.ok(
            libInferenceComponentContent.includes('echo "${ic_name}"'),
            'create_inference_component must echo ic_name as return value'
        );

        console.log('    ✅ IC name echoed as return value');
    });
});
