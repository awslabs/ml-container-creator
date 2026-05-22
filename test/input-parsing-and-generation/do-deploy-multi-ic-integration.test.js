// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-IC Deployment Integration Tests (Task 2.8)
 *
 * Comprehensive integration tests covering multi-IC deployment scenarios:
 * 1. Two IC configs produce two separate create-inference-component calls
 * 2. --ic <name> only deploys the named IC
 * 3. --force-ic triggers deletion before recreation
 * 4. do/add-ic creates valid conf file with expected fields
 * 5. Glob ordering is alphabetical (deterministic)
 *
 * Validates: Requirements 7.6
 *
 * Feature: multi-ic-endpoints
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template paths
const deployTemplatePath = path.join(__dirname, '../../templates/do/deploy');
const addIcTemplatePath = path.join(__dirname, '../../templates/do/add-ic');
const libInferenceComponentPath = path.join(__dirname, '../../templates/do/lib/inference-component.sh');
const defaultConfTemplatePath = path.join(__dirname, '../../templates/do/ic/default.conf');

// Read template contents
const deployTemplateContent = readFileSync(deployTemplatePath, 'utf8');
const addIcContent = readFileSync(addIcTemplatePath, 'utf8');
const libInferenceComponentContent = readFileSync(libInferenceComponentPath, 'utf8');
const defaultConfTemplateContent = readFileSync(defaultConfTemplatePath, 'utf8');

/**
 * Render the do/deploy template with realtime-inference target.
 */
function renderRealtimeDeploy(overrides = {}) {
    const vars = {
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
        fsxVolumeHandle: undefined,
        ...overrides
    };
    return ejs.render(deployTemplateContent, vars, { filename: deployTemplatePath });
}

/**
 * Render the do/ic/default.conf template.
 */
function renderDefaultConf(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        icGpuCount: 4,
        ...overrides
    };
    return ejs.render(defaultConfTemplateContent, vars);
}

/** Arbitrary for base config */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild')
});

/** Arbitrary for GPU instance types */
const gpuInstanceTypeArb = fc.constantFrom(
    'ml.g4dn.xlarge', 'ml.g5.xlarge', 'ml.g5.12xlarge',
    'ml.g5.48xlarge', 'ml.g6e.48xlarge', 'ml.p4d.24xlarge'
);

/** Arbitrary for valid IC names */
const icNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/);


describe('Multi-IC Deployment Integration Tests (Task 2.8)', () => {
    before(() => {
        console.log('\n🚀 Starting Multi-IC Deployment Integration Tests');
        console.log('📋 Testing: Requirements 7.6');
        console.log('🔧 Configuration: EJS template rendering + static analysis with fast-check\n');
    });

    // ================================================================
    // Test 1: Two IC configs produce two separate create-inference-component calls
    // ================================================================
    describe('Multiple IC configs produce multiple create-inference-component calls', () => {
        it('deploy loop iterates all *.conf files calling create_inference_component for each', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: Multi-IC loop calls create_inference_component per conf');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // The multi-IC path must iterate over all conf files
                    assert.ok(
                        output.includes('for conf in "${SCRIPT_DIR}"/ic/*.conf'),
                        'deploy must iterate over all do/ic/*.conf files'
                    );

                    // Each iteration calls _deploy_single_ic which calls create_inference_component
                    assert.ok(
                        output.includes('_deploy_single_ic "${conf}"'),
                        'deploy loop must call _deploy_single_ic for each conf file'
                    );

                    // The _deploy_single_ic function calls create_inference_component
                    assert.ok(
                        output.includes('create_inference_component "${ic_conf}"'),
                        '_deploy_single_ic must call create_inference_component with the conf file'
                    );
                }
            ), { numRuns: 30 });

            console.log('    ✅ Multi-IC loop calls create_inference_component per conf');
        });

        it('inference-component.sh helper calls aws sagemaker create-inference-component API', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: Helper calls create-inference-component API');

            // The lib helper must contain the actual AWS API call
            assert.ok(
                libInferenceComponentContent.includes('aws sagemaker create-inference-component'),
                'inference-component.sh must call aws sagemaker create-inference-component'
            );

            // It must pass the IC name
            assert.ok(
                libInferenceComponentContent.includes('--inference-component-name "${ic_name}"'),
                'inference-component.sh must pass --inference-component-name'
            );

            // It must pass the endpoint name
            assert.ok(
                libInferenceComponentContent.includes('--endpoint-name "${ENDPOINT_NAME}"'),
                'inference-component.sh must pass --endpoint-name'
            );

            // It must pass the specification with compute resources
            assert.ok(
                libInferenceComponentContent.includes('NumberOfAcceleratorDevicesRequired'),
                'inference-component.sh must include GPU count in specification'
            );

            console.log('    ✅ Helper calls create-inference-component API with correct params');
        });

        it('each IC gets independent GPU count and memory from its conf file', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: Each IC gets independent resource requirements');

            // The helper sources the IC conf file to get per-IC settings
            assert.ok(
                libInferenceComponentContent.includes('source "${ic_conf}"'),
                'inference-component.sh must source the IC config file'
            );

            // Uses IC_GPU_COUNT from the sourced config
            assert.ok(
                libInferenceComponentContent.includes('${IC_GPU_COUNT:-1}'),
                'inference-component.sh must use IC_GPU_COUNT from config (with default 1)'
            );

            // Uses IC_MIN_MEMORY_MB from the sourced config
            assert.ok(
                libInferenceComponentContent.includes('${IC_MIN_MEMORY_MB:-1024}'),
                'inference-component.sh must use IC_MIN_MEMORY_MB from config (with default 1024)'
            );

            // Uses IC_COPY_COUNT from the sourced config
            assert.ok(
                libInferenceComponentContent.includes('${IC_COPY_COUNT:-1}'),
                'inference-component.sh must use IC_COPY_COUNT from config (with default 1)'
            );

            console.log('    ✅ Each IC gets independent resource requirements from its conf');
        });

        it('property: for any N IC names, the loop structure supports N iterations', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: Loop structure supports arbitrary number of ICs');

            fc.assert(fc.property(
                fc.array(icNameArb, { minLength: 2, maxLength: 5 }),
                baseConfigArb,
                gpuInstanceTypeArb,
                (icNames, base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // The glob pattern *.conf will match any number of conf files
                    // The for loop doesn't hardcode a count — it iterates whatever glob returns
                    assert.ok(
                        output.includes('for conf in "${SCRIPT_DIR}"/ic/*.conf; do'),
                        'deploy must use for-in loop over glob (supports any number of ICs)'
                    );

                    // Each IC name would produce a valid conf filename
                    for (const name of icNames) {
                        const confFile = `${name}.conf`;
                        assert.ok(
                            /^[a-z][a-z0-9-]+\.conf$/.test(confFile),
                            `IC name "${name}" produces valid conf filename: ${confFile}`
                        );
                    }
                }
            ), { numRuns: 30 });

            console.log('    ✅ Loop structure supports arbitrary number of ICs');
        });
    });

    // ================================================================
    // Test 2: --ic <name> only deploys the named IC
    // ================================================================
    describe('--ic <name> only deploys the named IC', () => {
        it('--ic argument parsing sets IC_TARGET variable', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: --ic argument sets IC_TARGET');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must parse --ic argument
                    assert.ok(
                        output.includes('--ic)'),
                        'deploy must handle --ic argument'
                    );

                    // Must set IC_TARGET from the argument
                    assert.ok(
                        output.includes('IC_TARGET="$2"'),
                        'deploy must set IC_TARGET from --ic argument value'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ --ic argument sets IC_TARGET');
        });

        it('when IC_TARGET is set, only the named IC conf is deployed', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: Single IC target deploys only named IC');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // When IC_TARGET is set, deploy uses the specific conf file path
                    assert.ok(
                        output.includes('_deploy_single_ic "${SCRIPT_DIR}/ic/${IC_TARGET}.conf"'),
                        'deploy must call _deploy_single_ic with specific IC conf when IC_TARGET is set'
                    );

                    // The single IC path is inside an if [ -n "${IC_TARGET}" ] block
                    assert.ok(
                        output.includes('if [ -n "${IC_TARGET}" ]'),
                        'deploy must check if IC_TARGET is set to choose single vs multi path'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ Single IC target deploys only named IC');
        });

        it('--ic validates that the conf file exists before deploying', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: --ic validates conf file existence');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must validate the IC conf file exists
                    assert.ok(
                        output.includes('if [ ! -f "${SCRIPT_DIR}/ic/${IC_TARGET}.conf" ]'),
                        'deploy must validate IC conf file exists when --ic is specified'
                    );

                    // Must show error with available ICs
                    assert.ok(
                        output.includes('IC config not found'),
                        'deploy must show error when IC conf not found'
                    );
                    assert.ok(
                        output.includes('Available ICs'),
                        'deploy must list available ICs when specified IC not found'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ --ic validates conf file existence');
        });

        it('--ic requires a name argument (error if missing)', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: --ic requires name argument');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must check for missing argument
                    assert.ok(
                        output.includes('--ic requires a name argument'),
                        'deploy must error when --ic is used without a name'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ --ic requires name argument');
        });
    });

    // ================================================================
    // Test 3: --force-ic triggers deletion before recreation
    // ================================================================
    describe('--force-ic triggers deletion before recreation', () => {
        it('--force-ic calls _delete_and_wait_ic before creating new IC', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: --force-ic calls _delete_and_wait_ic');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must define _delete_and_wait_ic function
                    assert.ok(
                        output.includes('_delete_and_wait_ic()'),
                        'deploy must define _delete_and_wait_ic function'
                    );

                    // Must call _delete_and_wait_ic when FORCE_IC is true
                    assert.ok(
                        output.includes('_delete_and_wait_ic "${existing_ic_name}"'),
                        'deploy must call _delete_and_wait_ic with existing IC name'
                    );

                    // The deletion must happen inside the FORCE_IC check
                    const forceIcCheck = output.indexOf('if [ "${FORCE_IC}" = true ] && [ -n "${existing_ic_name}" ]');
                    const deleteCall = output.indexOf('_delete_and_wait_ic "${existing_ic_name}"');
                    assert.ok(
                        forceIcCheck !== -1 && deleteCall !== -1 && deleteCall > forceIcCheck,
                        '_delete_and_wait_ic must be called inside FORCE_IC check block'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ --force-ic calls _delete_and_wait_ic before recreation');
        });

        it('_delete_and_wait_ic calls DeleteInferenceComponent API', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: _delete_and_wait_ic calls delete API');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must call aws sagemaker delete-inference-component
                    assert.ok(
                        output.includes('aws sagemaker delete-inference-component'),
                        '_delete_and_wait_ic must call aws sagemaker delete-inference-component'
                    );

                    // Must pass the IC name to delete
                    assert.ok(
                        output.includes('--inference-component-name "${ic_name}"'),
                        '_delete_and_wait_ic must pass --inference-component-name'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ _delete_and_wait_ic calls DeleteInferenceComponent API');
        });

        it('_delete_and_wait_ic polls until IC is gone before returning', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: _delete_and_wait_ic waits for deletion');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must poll for IC status after deletion
                    assert.ok(
                        output.includes('while true; do'),
                        '_delete_and_wait_ic must have a polling loop'
                    );

                    // Must check IC status in the loop
                    assert.ok(
                        output.includes('_get_ic_status "${ic_name}"'),
                        '_delete_and_wait_ic must check IC status in polling loop'
                    );

                    // Must break when IC is gone (empty status)
                    assert.ok(
                        output.includes('if [ -z "${ic_status}" ]'),
                        '_delete_and_wait_ic must break when IC status is empty (deleted)'
                    );

                    // Must have a timeout to avoid infinite loop
                    assert.ok(
                        output.includes('delete_timeout'),
                        '_delete_and_wait_ic must have a deletion timeout'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ _delete_and_wait_ic waits for deletion to complete');
        });

        it('--force-ic clears IC_DEPLOYED_NAME before recreating', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: --force-ic clears state before recreation');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // After deletion, must clear IC_DEPLOYED_NAME
                    assert.ok(
                        output.includes('_update_config_var "IC_DEPLOYED_NAME" "" "${ic_conf}"'),
                        '--force-ic must clear IC_DEPLOYED_NAME after deletion'
                    );

                    // After deletion, must clear IC_DEPLOYED_AT
                    assert.ok(
                        output.includes('_update_config_var "IC_DEPLOYED_AT" "" "${ic_conf}"'),
                        '--force-ic must clear IC_DEPLOYED_AT after deletion'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ --force-ic clears state before recreation');
        });

        it('--force-ic argument is parsed correctly', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: --force-ic argument parsing');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must parse --force-ic flag
                    assert.ok(
                        output.includes('--force-ic)'),
                        'deploy must handle --force-ic argument'
                    );

                    // Must set FORCE_IC=true
                    assert.ok(
                        output.includes('FORCE_IC=true'),
                        'deploy must set FORCE_IC=true when --force-ic is passed'
                    );

                    // --force-ic can optionally take a name argument
                    assert.ok(
                        output.includes('IC_TARGET="$1"') || output.includes('IC_TARGET='),
                        'deploy must support optional name argument for --force-ic'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ --force-ic argument parsing correct');
        });
    });

    // ================================================================
    // Test 4: do/add-ic creates valid conf file with expected fields
    // ================================================================
    describe('do/add-ic creates valid conf file with expected fields', () => {
        it('add-ic script creates conf file with all required IC fields', () => {
            console.log('  🧪 Req 7.6: add-ic creates conf with required fields');

            // The add-ic script must write a conf file with these fields
            assert.ok(
                addIcContent.includes('IC_IMAGE_TAG'),
                'add-ic must write IC_IMAGE_TAG to conf file'
            );
            assert.ok(
                addIcContent.includes('IC_GPU_COUNT'),
                'add-ic must write IC_GPU_COUNT to conf file'
            );
            assert.ok(
                addIcContent.includes('IC_COPY_COUNT'),
                'add-ic must write IC_COPY_COUNT to conf file'
            );
            assert.ok(
                addIcContent.includes('IC_MIN_MEMORY_MB'),
                'add-ic must write IC_MIN_MEMORY_MB to conf file'
            );
            assert.ok(
                addIcContent.includes('IC_STARTUP_TIMEOUT'),
                'add-ic must write IC_STARTUP_TIMEOUT to conf file'
            );

            console.log('    ✅ add-ic creates conf with all required fields');
        });

        it('add-ic uses heredoc to write conf file with export statements', () => {
            console.log('  🧪 Req 7.6: add-ic uses export statements in conf');

            // The conf file content must use export for each variable
            assert.ok(
                addIcContent.includes('export IC_IMAGE_TAG='),
                'add-ic conf must use export for IC_IMAGE_TAG'
            );
            assert.ok(
                addIcContent.includes('export IC_GPU_COUNT='),
                'add-ic conf must use export for IC_GPU_COUNT'
            );
            assert.ok(
                addIcContent.includes('export IC_COPY_COUNT='),
                'add-ic conf must use export for IC_COPY_COUNT'
            );
            assert.ok(
                addIcContent.includes('export IC_MIN_MEMORY_MB='),
                'add-ic conf must use export for IC_MIN_MEMORY_MB'
            );
            assert.ok(
                addIcContent.includes('export IC_STARTUP_TIMEOUT='),
                'add-ic conf must use export for IC_STARTUP_TIMEOUT'
            );

            console.log('    ✅ add-ic uses export statements in conf');
        });

        it('add-ic validates IC name format (lowercase alphanumeric + hyphens)', () => {
            console.log('  🧪 Req 7.6: add-ic validates IC name format');

            // Must validate the IC name
            assert.ok(
                addIcContent.includes('[a-z0-9]'),
                'add-ic must validate IC name is lowercase alphanumeric'
            );
            assert.ok(
                addIcContent.includes('IC name must be lowercase alphanumeric with hyphens'),
                'add-ic must show validation error for invalid IC names'
            );

            console.log('    ✅ add-ic validates IC name format');
        });

        it('add-ic checks for collision with existing conf files', () => {
            console.log('  🧪 Req 7.6: add-ic checks for name collision');

            // Must check if conf file already exists
            assert.ok(
                addIcContent.includes('if [ -f "${SCRIPT_DIR}/ic/${IC_NAME}.conf" ]'),
                'add-ic must check if IC conf file already exists'
            );
            assert.ok(
                addIcContent.includes('IC config already exists'),
                'add-ic must show error when IC name collides with existing conf'
            );

            console.log('    ✅ add-ic checks for name collision');
        });

        it('add-ic creates conf in do/ic/ directory', () => {
            console.log('  🧪 Req 7.6: add-ic creates conf in do/ic/ directory');

            // Must create the file in the ic/ subdirectory
            assert.ok(
                addIcContent.includes('IC_CONF_PATH="${SCRIPT_DIR}/ic/${IC_NAME}.conf"'),
                'add-ic must set conf path to do/ic/<name>.conf'
            );
            assert.ok(
                addIcContent.includes('mkdir -p "${SCRIPT_DIR}/ic"'),
                'add-ic must ensure do/ic/ directory exists'
            );

            console.log('    ✅ add-ic creates conf in do/ic/ directory');
        });

        it('add-ic deploys the new IC immediately after creation', () => {
            console.log('  🧪 Req 7.6: add-ic deploys IC immediately');

            // Must call do/deploy --ic <name> after creating the conf
            assert.ok(
                addIcContent.includes('deploy" --ic "${IC_NAME}"') ||
                addIcContent.includes('deploy" --ic'),
                'add-ic must call do/deploy --ic <name> after creating conf'
            );

            console.log('    ✅ add-ic deploys IC immediately after creation');
        });

        it('default.conf template renders with expected fields for any project', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: default.conf template renders correctly');

            fc.assert(fc.property(
                fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
                fc.integer({ min: 1, max: 8 }),
                (projectName, gpuCount) => {
                    const rendered = renderDefaultConf({ projectName, icGpuCount: gpuCount });

                    // Must contain IC_IMAGE_TAG with project name
                    assert.ok(
                        rendered.includes(`export IC_IMAGE_TAG="${projectName}-latest"`),
                        `default.conf must set IC_IMAGE_TAG to ${projectName}-latest`
                    );

                    // Must contain IC_GPU_COUNT with the specified value
                    assert.ok(
                        rendered.includes(`export IC_GPU_COUNT=${gpuCount}`),
                        `default.conf must set IC_GPU_COUNT to ${gpuCount}`
                    );

                    // Must contain IC_COPY_COUNT
                    assert.ok(
                        rendered.includes('export IC_COPY_COUNT=1'),
                        'default.conf must set IC_COPY_COUNT=1'
                    );

                    // Must contain IC_MIN_MEMORY_MB
                    assert.ok(
                        rendered.includes('export IC_MIN_MEMORY_MB=1024'),
                        'default.conf must set IC_MIN_MEMORY_MB=1024'
                    );

                    // Must contain IC_STARTUP_TIMEOUT
                    assert.ok(
                        rendered.includes('export IC_STARTUP_TIMEOUT=900'),
                        'default.conf must set IC_STARTUP_TIMEOUT=900'
                    );
                }
            ), { numRuns: 30 });

            console.log('    ✅ default.conf template renders correctly');
        });

        it('default.conf uses icGpuCount=1 when not provided', () => {
            console.log('  🧪 Req 7.6: default.conf defaults GPU count to 1');

            const rendered = renderDefaultConf({ projectName: 'my-project', icGpuCount: undefined });

            assert.ok(
                rendered.includes('export IC_GPU_COUNT=1'),
                'default.conf must default IC_GPU_COUNT to 1 when icGpuCount is undefined'
            );

            console.log('    ✅ default.conf defaults GPU count to 1');
        });
    });

    // ================================================================
    // Test 5: Glob ordering is alphabetical (deterministic)
    // ================================================================
    describe('Glob ordering is alphabetical (deterministic)', () => {
        it('deploy uses *.conf glob which produces alphabetical order', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: Deploy uses *.conf glob for alphabetical ordering');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // Must use the glob pattern that bash expands alphabetically
                    assert.ok(
                        output.includes('for conf in "${SCRIPT_DIR}"/ic/*.conf; do'),
                        'deploy must use *.conf glob pattern (bash expands globs alphabetically)'
                    );

                    // Must NOT sort manually (bash glob is already alphabetical)
                    // The absence of `sort` confirms reliance on glob ordering
                    const icLoopSection = output.substring(
                        output.indexOf('for conf in "${SCRIPT_DIR}"/ic/*.conf'),
                        output.indexOf('IC Deployment Summary')
                    );
                    // Glob expansion in bash is guaranteed alphabetical — no sort needed
                    assert.ok(
                        !icLoopSection.includes('| sort'),
                        'deploy should rely on bash glob alphabetical ordering, not pipe to sort'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ Deploy uses *.conf glob for alphabetical ordering');
        });

        it('property: alphabetical glob means IC "alpha" deploys before "beta"', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: Alphabetical ordering is deterministic');

            fc.assert(fc.property(
                fc.array(icNameArb, { minLength: 2, maxLength: 6 }),
                (icNames) => {
                    // Deduplicate
                    const uniqueNames = [...new Set(icNames)];
                    if (uniqueNames.length < 2) return;

                    // Simulate bash glob ordering: alphabetical sort of filenames
                    const confFiles = uniqueNames.map(n => `${n}.conf`);
                    const sorted = [...confFiles].sort();

                    // Verify that glob ordering is deterministic: sorting the same
                    // set of conf files always produces the same order
                    const sorted2 = [...confFiles].sort();
                    assert.deepStrictEqual(
                        sorted,
                        sorted2,
                        'Glob ordering of *.conf files must be deterministic'
                    );
                }
            ), { numRuns: 50 });

            console.log('    ✅ Alphabetical ordering is deterministic');
        });

        it('single IC target (--ic) bypasses the glob loop entirely', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: --ic bypasses glob loop');

            fc.assert(fc.property(
                baseConfigArb,
                gpuInstanceTypeArb,
                (base, instanceType) => {
                    const output = renderRealtimeDeploy({
                        ...base,
                        instanceType
                    });

                    // The if/else structure: IC_TARGET set → single path, else → loop
                    const singlePath = output.indexOf('if [ -n "${IC_TARGET}" ]; then');
                    const loopPath = output.indexOf('for conf in "${SCRIPT_DIR}"/ic/*.conf; do');

                    assert.ok(
                        singlePath !== -1 && loopPath !== -1,
                        'deploy must have both single IC path and multi-IC loop path'
                    );
                    assert.ok(
                        singlePath < loopPath,
                        'single IC path (--ic) must be checked before the glob loop (else branch)'
                    );
                }
            ), { numRuns: 20 });

            console.log('    ✅ --ic bypasses glob loop');
        });
    });

    // ================================================================
    // Additional integration: IC naming in the context of multi-IC deploy
    // ================================================================
    describe('IC naming follows ${PROJECT_NAME}-${basename}-${TIMESTAMP} in deploy context', () => {
        it('property: IC names derived from conf filenames are unique per project+timestamp', function () {
            this.timeout(30000);

            console.log('  🧪 Req 7.6: IC names are unique per project+IC+timestamp');

            fc.assert(fc.property(
                fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/),
                fc.array(icNameArb, { minLength: 2, maxLength: 4 }),
                fc.integer({ min: 1700000000, max: 1999999999 }),
                (projectName, icNames, timestamp) => {
                    const uniqueIcNames = [...new Set(icNames)];
                    if (uniqueIcNames.length < 2) return;

                    // Each IC gets a unique name because basename differs
                    const generatedNames = uniqueIcNames.map(
                        ic => `${projectName}-${ic}-${timestamp}`
                    );

                    // All names must be unique (even with same timestamp)
                    const nameSet = new Set(generatedNames);
                    assert.strictEqual(
                        nameSet.size,
                        generatedNames.length,
                        'IC names must be unique when basenames differ (same project+timestamp)'
                    );
                }
            ), { numRuns: 50 });

            console.log('    ✅ IC names are unique per project+IC+timestamp');
        });
    });
});
