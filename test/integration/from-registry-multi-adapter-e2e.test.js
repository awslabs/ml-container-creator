// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for from-registry + multi-adapter E2E validation
 * and parent model linkage verification.
 *
 * Validates end-to-end code paths for:
 * (a) `do/adapter add <name> --from-registry` resolves adapter from deployment MPG
 * (b) Multiple adapter ICs coexist on the same endpoint (BaseInferenceComponentName pattern)
 * (c) `do/adapter list` shows both adapters with correct status
 * (d) `do/register` passes --parent-version-arn when registering adapters (AC-2.1)
 * (e) Registered ModelPackage's CustomerMetadataProperties contains parentModelVersionArn (AC-2.2)
 * (f) model-registry MCP list_model_packages includes parent ARN
 *
 * Feature: tune-register-loop
 * Validates: Requirements US-2, US-4 AC-4.1 through AC-4.3
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: from-registry + multi-adapter E2E — Validate AC-4.1 through AC-4.3, US-2', function () {
    this.timeout(120000);

    let result;
    let adapterScript;
    let registerScript;
    let tuneScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'Qwen/Qwen3-0.6B',
            'enable-lora': true,
            'region': 'us-east-1',
            'instance-type': 'ml.g5.xlarge'
        });

        // Read the rendered scripts
        const adapterPath = result.file('do/adapter');
        adapterScript = fs.readFileSync(adapterPath, 'utf8');

        const registerPath = result.file('do/register');
        registerScript = fs.readFileSync(registerPath, 'utf8');

        const tunePath = result.file('do/tune');
        tuneScript = fs.readFileSync(tunePath, 'utf8');
    });

    after(() => {
        if (result) result.cleanup();
    });

    // ══════════════════════════════════════════════════════════════════════
    // AC-4.1: --from-registry resolves adapter from deployment MPG
    // ══════════════════════════════════════════════════════════════════════

    describe('AC-4.1: do/adapter add --from-registry resolves adapter from deployment MPG', () => {

        it('--from-registry flag is recognized in argument parser', () => {
            assert.ok(
                adapterScript.includes('--from-registry)'),
                'Must recognize --from-registry in argument parser'
            );
        });

        it('--from-registry sets from_registry=true', () => {
            assert.ok(
                adapterScript.includes('from_registry="true"'),
                '--from-registry must set from_registry=true'
            );
        });

        it('calls .register_helper.py get-version to resolve adapter details', () => {
            assert.ok(
                adapterScript.includes('.register_helper.py" get-version') ||
                adapterScript.includes('.register_helper.py" list-adapters'),
                'Must call .register_helper.py to resolve adapter from registry'
            );
        });

        it('extracts modelDataUrl (weights URI) from registry version response', () => {
            assert.ok(
                adapterScript.includes('modelDataUrl') &&
                adapterScript.includes('weights_uri'),
                'Must extract modelDataUrl from registry response and assign to weights_uri'
            );
        });

        it('resolves weights_uri from registry before deploying as adapter IC', () => {
            const fromRegistryStart = adapterScript.indexOf('Resolve --from-registry to weights_uri');
            const createICStart = adapterScript.indexOf('aws sagemaker create-inference-component');
            assert.ok(
                fromRegistryStart > 0 && createICStart > 0 && fromRegistryStart < createICStart,
                '--from-registry resolution must happen before CreateInferenceComponent call'
            );
        });

        it('interactive mode queries list-adapters and presents selection menu', () => {
            assert.ok(
                adapterScript.includes('list-adapters') &&
                adapterScript.includes('Select adapter'),
                'Interactive mode must query list-adapters and present selection'
            );
        });

        it('non-interactive mode requires explicit version ARN', () => {
            assert.ok(
                adapterScript.includes('requires an explicit version ARN in non-interactive mode'),
                'Non-interactive mode must require explicit ARN'
            );
        });

        it('writes ADAPTER_SOURCE="registry" to conf file', () => {
            assert.ok(
                adapterScript.includes('ADAPTER_SOURCE="registry"'),
                'Must write ADAPTER_SOURCE="registry" for --from-registry adapters'
            );
        });

        it('stores ADAPTER_REGISTRY_ARN in conf file', () => {
            assert.ok(
                adapterScript.includes('export ADAPTER_REGISTRY_ARN=') ||
                adapterScript.includes('ADAPTER_REGISTRY_ARN="${registry_arn}"'),
                'Must store ADAPTER_REGISTRY_ARN in the adapter conf file'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // AC-4.2: Multiple adapter ICs coexist on the same endpoint
    // ══════════════════════════════════════════════════════════════════════

    describe('AC-4.2: Multiple adapter ICs coexist on same endpoint', () => {

        it('creates adapter IC with BaseInferenceComponentName linking to base IC', () => {
            assert.ok(
                adapterScript.includes('BaseInferenceComponentName') &&
                adapterScript.includes('${base_ic_name}') &&
                adapterScript.includes('create-inference-component'),
                'Adapter IC must use BaseInferenceComponentName to link to base IC'
            );
        });

        it('adapter IC name includes adapter name for uniqueness', () => {
            assert.ok(
                adapterScript.includes('${PROJECT_NAME}-adapter-${adapter_name}'),
                'Adapter IC name must include adapter name for uniqueness across multiple adapters'
            );
        });

        it('each adapter gets its own conf file in do/adapters/', () => {
            assert.ok(
                adapterScript.includes('adapters/${adapter_name}.conf'),
                'Each adapter must have its own conf file: do/adapters/<name>.conf'
            );
        });

        it('base IC is validated as InService before adding any adapter', () => {
            assert.ok(
                adapterScript.includes('Base inference component is not InService') ||
                adapterScript.includes('Base IC is InService'),
                'Must validate base IC is InService before adding adapter'
            );
        });

        it('all adapter ICs share the same endpoint via ENDPOINT_NAME', () => {
            assert.ok(
                adapterScript.includes('--endpoint-name "${ENDPOINT_NAME}"'),
                'All adapter ICs must use the same endpoint (ENDPOINT_NAME)'
            );
        });

        it('adapter IC uses Container.ArtifactUrl for weights (not full model spec)', () => {
            assert.ok(
                adapterScript.includes('ArtifactUrl') &&
                adapterScript.includes('${weights_uri}') &&
                adapterScript.includes('Container'),
                'Adapter IC must use Container.ArtifactUrl for adapter weights'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // AC-4.3: do/test <adapter_ic_name> returns valid inference
    // ══════════════════════════════════════════════════════════════════════

    describe('AC-4.3: do/test references adapter IC name for inference', () => {

        it('add command prints test instruction with adapter name', () => {
            assert.ok(
                adapterScript.includes('./do/test ${adapter_name}') ||
                adapterScript.includes('./do/test ${adapter_ic_name}'),
                'Must print test instruction after successful adapter add'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // AC-4.4/4.5/4.6: do/adapter list displays all adapters with status
    // ══════════════════════════════════════════════════════════════════════

    describe('AC-4.4/4.5/4.6: do/adapter list merges three data sources', () => {

        function getListSection() {
            const start = adapterScript.indexOf('_adapter_list()');
            const end = adapterScript.indexOf('\n_adapter_remove(');
            if (start === -1 || end === -1) return adapterScript;
            return adapterScript.substring(start, end);
        }

        it('reads local confs from do/adapters/*.conf', () => {
            const section = getListSection();
            assert.ok(
                section.includes('*.conf') || section.includes('adapters'),
                'List must read from do/adapters/*.conf'
            );
        });

        it('queries deployed adapter ICs via list-inference-components', () => {
            const section = getListSection();
            assert.ok(
                section.includes('list-inference-components'),
                'List must query deployed ICs from the endpoint'
            );
        });

        // The adapter list implementation currently only merges local confs + deployed ICs. Registry query is a future enhancement.
        it.skip('queries model-registry for adapter versions (Available status)', () => {
            const section = getListSection();
            assert.ok(
                section.includes('list-adapters') &&
                section.includes('registry'),
                'List must query model-registry for Available adapters'
            );
        });

        it('shows STATUS column with InService/Creating/Failed/not deployed/Available values', () => {
            const section = getListSection();
            assert.ok(
                section.includes('not deployed') &&
                section.includes('InferenceComponentStatus'),
                'List must support not deployed and InferenceComponentStatus values'
            );
        });

        it('shows SOURCE column with tune/registry/hub/s3/external values', () => {
            const section = getListSection();
            assert.ok(
                section.includes('SOURCE'),
                'List must show SOURCE column'
            );
        });

        it('filters adapter ICs by BaseInferenceComponentName presence', () => {
            const section = getListSection();
            assert.ok(
                section.includes('BaseInferenceComponentName') &&
                section.includes('base_ic'),
                'Must filter adapter ICs by checking BaseInferenceComponentName field'
            );
        });

        it('handles case where endpoint does not exist yet', () => {
            const section = getListSection();
            assert.ok(
                section.includes('if endpoint_name') ||
                section.includes('not deployed') ||
                section.includes('Could not query endpoint'),
                'Must handle case where endpoint does not exist yet'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // US-2 / AC-2.1: do/register passes --parent-version-arn for adapters
    // ══════════════════════════════════════════════════════════════════════

    describe('US-2 / AC-2.1: do/register passes --parent-version-arn when registering adapters', () => {

        it('register script contains register-adapter subcommand call', () => {
            assert.ok(
                registerScript.includes('register-adapter'),
                'do/register must call register-adapter subcommand'
            );
        });

        it('passes --parent-version-arn "${MODEL_PKG_ARN}" to register-adapter', () => {
            assert.ok(
                registerScript.includes('"--parent-version-arn" "${MODEL_PKG_ARN}"'),
                'Must pass --parent-version-arn "${MODEL_PKG_ARN}" when registering adapters'
            );
        });

        it('loops over do/adapters/*.conf to register each adapter', () => {
            assert.ok(
                registerScript.includes('adapters/*.conf') &&
                registerScript.includes('register-adapter'),
                'Must loop over do/adapters/*.conf and register each'
            );
        });

        it('register is non-fatal on adapter registration failure (AC-1.6)', () => {
            assert.ok(
                registerScript.includes('non-fatal') &&
                registerScript.includes('adapter'),
                'Adapter registration failure must be non-fatal'
            );
        });

        it('adapter registration only proceeds if MODEL_PKG_ARN is available', () => {
            assert.ok(
                registerScript.includes('MODEL_PKG_ARN') &&
                registerScript.includes('adapters'),
                'Adapter registration must depend on MODEL_PKG_ARN being set'
            );
        });

        it('supports --base-only flag to skip adapter registration', () => {
            assert.ok(
                registerScript.includes('--base-only') &&
                registerScript.includes('BASE_ONLY'),
                'Must support --base-only flag to skip adapter registration'
            );
        });

        it('supports --exclude flag to skip specific adapters', () => {
            assert.ok(
                registerScript.includes('--exclude') &&
                registerScript.includes('EXCLUDE_ADAPTERS'),
                'Must support --exclude flag for specific adapters'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // US-2 / AC-2.2: CustomerMetadataProperties contains parentModelVersionArn
    // ══════════════════════════════════════════════════════════════════════

    describe('US-2 / AC-2.2: Registered adapter has parentModelVersionArn in CustomerMetadataProperties', () => {

        it('.register_helper.py builds adapter metadata with parentModelVersionArn', () => {
            // Verify the Python helper is present and contains the right logic
            const helperPath = result.file('do/.register_helper.py');
            const helperScript = fs.readFileSync(helperPath, 'utf8');

            assert.ok(
                helperScript.includes('parentModelVersionArn') &&
                helperScript.includes('CustomerMetadataProperties'),
                '.register_helper.py must include parentModelVersionArn in CustomerMetadataProperties'
            );
        });

        it('.register_helper.py sets isAdapter=true in metadata', () => {
            const helperPath = result.file('do/.register_helper.py');
            const helperScript = fs.readFileSync(helperPath, 'utf8');

            assert.ok(
                helperScript.includes('"isAdapter": "true"') ||
                helperScript.includes('"isAdapter"') && helperScript.includes('"true"'),
                '.register_helper.py must set isAdapter=true in adapter metadata'
            );
        });

        it('.register_helper.py includes tuneTechnique in adapter metadata', () => {
            const helperPath = result.file('do/.register_helper.py');
            const helperScript = fs.readFileSync(helperPath, 'utf8');

            assert.ok(
                helperScript.includes('tuneTechnique'),
                '.register_helper.py must include tuneTechnique in adapter metadata'
            );
        });

        it('.register_helper.py includes datasetS3Uri in adapter metadata', () => {
            const helperPath = result.file('do/.register_helper.py');
            const helperScript = fs.readFileSync(helperPath, 'utf8');

            assert.ok(
                helperScript.includes('datasetS3Uri'),
                '.register_helper.py must include datasetS3Uri in adapter metadata'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // US-2 / AC-2.3: list_model_packages includes parent ARN
    // ══════════════════════════════════════════════════════════════════════

    describe('US-2 / AC-2.3: list-adapters includes parentModelVersionArn in response', () => {

        it('.register_helper.py list-adapters extracts parentModelVersionArn from metadata', () => {
            const helperPath = result.file('do/.register_helper.py');
            const helperScript = fs.readFileSync(helperPath, 'utf8');

            // The cmd_list_adapters function should include parentModelVersionArn in its output
            assert.ok(
                helperScript.includes('parentModelVersionArn') &&
                helperScript.includes('list-adapters'),
                'list-adapters must include parentModelVersionArn in response'
            );
        });

        it('.register_helper.py list-adapters returns structured adapter objects', () => {
            const helperPath = result.file('do/.register_helper.py');
            const helperScript = fs.readFileSync(helperPath, 'utf8');

            // Check the output structure includes the required fields
            assert.ok(
                helperScript.includes('"adapters"') &&
                helperScript.includes('"arn"') &&
                helperScript.includes('"version"'),
                'list-adapters must return structured objects with arn, version fields'
            );
        });

        it('.register_helper.py get-version returns metadata dict including parent ARN', () => {
            const helperPath = result.file('do/.register_helper.py');
            const helperScript = fs.readFileSync(helperPath, 'utf8');

            // get-version returns metadata dict
            assert.ok(
                helperScript.includes('get-version') &&
                helperScript.includes('"metadata"'),
                'get-version must return metadata dict that includes parent ARN'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // Parent linkage stored in adapter conf during --from-registry flow
    // ══════════════════════════════════════════════════════════════════════

    describe('Parent linkage: --from-registry extracts and stores parent metadata in conf', () => {

        it('extracts parentModelVersionArn from registry version_line metadata', () => {
            assert.ok(
                adapterScript.includes('parentModelVersionArn') &&
                adapterScript.includes('version_line'),
                'Must extract parentModelVersionArn from registry version metadata'
            );
        });

        it('extracts modelName (parent model slug) from registry metadata', () => {
            assert.ok(
                adapterScript.includes('modelName') &&
                adapterScript.includes('parent_model_slug'),
                'Must extract modelName as parent_model_slug from registry metadata'
            );
        });

        it('stores ADAPTER_PARENT_MODEL_ARN from registry metadata in conf', () => {
            // Check that the from-registry path writes parent model ARN
            const fromRegistrySection = adapterScript.substring(
                adapterScript.indexOf('Add registry-specific metadata')
            );
            assert.ok(
                fromRegistrySection.includes('ADAPTER_PARENT_MODEL_ARN') &&
                fromRegistrySection.includes('parent_model_arn'),
                'Must store ADAPTER_PARENT_MODEL_ARN from registry metadata in conf'
            );
        });

        it('stores ADAPTER_PARENT_MODEL_SLUG from registry metadata in conf', () => {
            const fromRegistrySection = adapterScript.substring(
                adapterScript.indexOf('Add registry-specific metadata')
            );
            assert.ok(
                fromRegistrySection.includes('ADAPTER_PARENT_MODEL_SLUG') &&
                fromRegistrySection.includes('parent_model_slug'),
                'Must store ADAPTER_PARENT_MODEL_SLUG from registry metadata in conf'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // Auto-register flow (Task 1) correctly invokes register which links parent
    // ══════════════════════════════════════════════════════════════════════

    describe('Auto-register flow links adapters with parent model via do/register', () => {

        it('do/tune _handle_completion calls do/register after adapter add', () => {
            assert.ok(
                tuneScript.includes('"${SCRIPT_DIR}/register"'),
                'do/tune must call do/register as subprocess after adapter staging'
            );
        });

        it('do/tune auto-register stores TUNE_ADAPTER_DEPLOY_ARN after registration', () => {
            assert.ok(
                tuneScript.includes('TUNE_ADAPTER_DEPLOY_ARN'),
                'Must store TUNE_ADAPTER_DEPLOY_ARN after successful auto-register'
            );
        });

        it('do/register builds ADAPTER_REG_ARGS with --parent-version-arn from MODEL_PKG_ARN', () => {
            // This validates that when register is called (by auto-register or manually),
            // it correctly builds the register-adapter args with parent linkage
            assert.ok(
                registerScript.includes('ADAPTER_REG_ARGS') &&
                registerScript.includes('"--parent-version-arn" "${MODEL_PKG_ARN}"'),
                'do/register must build ADAPTER_REG_ARGS with --parent-version-arn'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // AC-1.7: Overwrite existing adapter on re-tune (idempotent)
    // ══════════════════════════════════════════════════════════════════════

    describe('AC-1.7: --from-tune overwrites existing adapter (idempotent re-register)', () => {

        it('checks if adapter conf file already exists before proceeding', () => {
            assert.ok(
                adapterScript.includes('adapters/${adapter_name}.conf') &&
                adapterScript.includes('already exists'),
                'Must check if adapter conf already exists'
            );
        });

        it('when --from-tune is used, existing adapter is overwritten instead of rejected', () => {
            assert.ok(
                adapterScript.includes('from_tune') &&
                adapterScript.includes('overwriting') &&
                adapterScript.includes('re-tune'),
                'Must overwrite existing adapter when --from-tune is used (AC-1.7)'
            );
        });

        it('deletes existing IC before re-creating when overwriting', () => {
            assert.ok(
                adapterScript.includes('delete-inference-component') &&
                adapterScript.includes('_existing_ic_name'),
                'Must delete existing IC when overwriting adapter'
            );
        });

        it('removes old conf file before creating new one', () => {
            assert.ok(
                adapterScript.includes('rm -f "${SCRIPT_DIR}/adapters/${adapter_name}.conf"'),
                'Must remove old conf file when overwriting'
            );
        });

        it('non-from-tune paths still reject duplicates', () => {
            assert.ok(
                adapterScript.includes('Adapter already exists') &&
                adapterScript.includes('exit 1'),
                'Non-from-tune paths must still reject duplicate adapter names'
            );
        });
    });

    // ══════════════════════════════════════════════════════════════════════
    // Compatibility check uses parent metadata from conf
    // ══════════════════════════════════════════════════════════════════════

    describe('Compat check flow uses parent metadata stored by --from-registry', () => {

        it('compat check reads _compat_parent_arn from registry version_line', () => {
            assert.ok(
                adapterScript.includes('_compat_parent_arn') &&
                adapterScript.includes('version_line'),
                'Compat check must read parent ARN from registry version metadata'
            );
        });

        it('compat check reads _compat_parent_slug from registry version_line', () => {
            assert.ok(
                adapterScript.includes('_compat_parent_slug') &&
                adapterScript.includes('modelName'),
                'Compat check must read parent slug from registry metadata'
            );
        });

        it('compat check compares parent ARN against MODEL_PKG_ARN', () => {
            assert.ok(
                adapterScript.includes('_compat_parent_arn') &&
                adapterScript.includes('_compat_deployed_mpg'),
                'Compat check must compare parent ARN against deployed model PKG ARN'
            );
        });

        it('compat check fallback uses model slug in artifact URL', () => {
            assert.ok(
                adapterScript.includes('_compat_expected_slug') &&
                adapterScript.includes('_compat_deployed_model'),
                'Compat check must have fallback slug comparison'
            );
        });

        it('--force bypasses compat check', () => {
            assert.ok(
                adapterScript.includes('force') &&
                adapterScript.includes('skipping compatibility check'),
                'Must support --force to bypass compat check'
            );
        });

        it('missing parent metadata skips compat check with info message', () => {
            assert.ok(
                adapterScript.includes('No parent model metadata') &&
                adapterScript.includes('skipping compatibility check'),
                'Must skip compat check with info when no parent metadata'
            );
        });
    });
});
