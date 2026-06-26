// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for LoRA adapter lifecycle.
 *
 * Tests the full adapter lifecycle by generating a project with --enable-lora
 * and verifying the rendered do/adapter script contains correct logic for:
 * - add: creates conf file with expected fields (ADAPTER_NAME, ADAPTER_IC_NAME,
 *         ADAPTER_WEIGHTS_URI, ADAPTER_CREATED_AT)
 * - list: output includes adapter name and status (NAME, SOURCE, STATUS columns)
 * - remove: deletes conf file (rm -f of do/adapters/<name>.conf)
 * - update: changes ADAPTER_WEIGHTS_URI in conf via sed
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 7.4
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: lora-adapter-lifecycle — Integration tests for adapter lifecycle (Req 7.4)', function () {
    this.timeout(120000);

    let result;
    let adapterScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
            'enable-lora': true,
            'region': 'us-east-1',
            'instance-type': 'ml.g5.xlarge'
        });

        // Read the rendered do/adapter script
        const adapterPath = result.file('do/adapter');
        adapterScript = fs.readFileSync(adapterPath, 'utf8');
    });

    after(() => {
        if (result) result.cleanup();
    });

    // ── do/adapter add creates conf file with expected fields ─────────────

    describe('do/adapter add creates conf file with expected fields', () => {

        it('creates do/adapters/ directory via mkdir -p', () => {
            assert.ok(
                adapterScript.includes('mkdir -p') &&
                adapterScript.includes('adapters'),
                'add must create do/adapters/ directory'
            );
        });

        it('writes conf file to do/adapters/<name>.conf', () => {
            assert.ok(
                adapterScript.includes('adapters/${adapter_name}.conf'),
                'add must write conf file to do/adapters/<name>.conf'
            );
        });

        it('conf file contains ADAPTER_NAME field', () => {
            assert.ok(
                adapterScript.includes('ADAPTER_NAME='),
                'conf file must contain ADAPTER_NAME field'
            );
        });

        it('conf file contains ADAPTER_IC_NAME field', () => {
            assert.ok(
                adapterScript.includes('ADAPTER_IC_NAME='),
                'conf file must contain ADAPTER_IC_NAME field'
            );
        });

        it('conf file contains ADAPTER_WEIGHTS_URI field', () => {
            assert.ok(
                adapterScript.includes('ADAPTER_WEIGHTS_URI='),
                'conf file must contain ADAPTER_WEIGHTS_URI field'
            );
        });

        it('conf file contains ADAPTER_CREATED_AT field', () => {
            assert.ok(
                adapterScript.includes('ADAPTER_CREATED_AT='),
                'conf file must contain ADAPTER_CREATED_AT field'
            );
        });

        it('all conf fields use export keyword', () => {
            assert.ok(
                adapterScript.includes('export ADAPTER_NAME='),
                'ADAPTER_NAME must use export'
            );
            assert.ok(
                adapterScript.includes('export ADAPTER_IC_NAME='),
                'ADAPTER_IC_NAME must use export'
            );
            assert.ok(
                adapterScript.includes('export ADAPTER_WEIGHTS_URI='),
                'ADAPTER_WEIGHTS_URI must use export'
            );
            assert.ok(
                adapterScript.includes('export ADAPTER_CREATED_AT='),
                'ADAPTER_CREATED_AT must use export'
            );
        });

        it('ADAPTER_IC_NAME follows ${PROJECT_NAME}-adapter-${name} convention', () => {
            assert.ok(
                adapterScript.includes('${PROJECT_NAME}-adapter-${adapter_name}'),
                'ADAPTER_IC_NAME must follow ${PROJECT_NAME}-adapter-${name} convention'
            );
        });

        it('ADAPTER_CREATED_AT uses ISO 8601 date format', () => {
            assert.ok(
                adapterScript.includes('date -u +"%Y-%m-%dT%H:%M:%SZ"'),
                'ADAPTER_CREATED_AT must use ISO 8601 date format'
            );
        });

        it('calls CreateInferenceComponent via aws sagemaker create-inference-component', () => {
            assert.ok(
                adapterScript.includes('aws sagemaker create-inference-component'),
                'add must call CreateInferenceComponent'
            );
        });

        it('passes BaseInferenceComponentName in specification', () => {
            assert.ok(
                adapterScript.includes('BaseInferenceComponentName'),
                'add must pass BaseInferenceComponentName in specification'
            );
        });

        it('passes ArtifactUrl in Container specification', () => {
            assert.ok(
                adapterScript.includes('ArtifactUrl'),
                'add must pass ArtifactUrl in Container specification'
            );
        });

        it('waits for adapter IC to reach InService after creation', () => {
            const addSection = adapterScript.substring(adapterScript.indexOf('_adapter_add'));
            assert.ok(
                addSection.includes('wait_ic') || addSection.includes('Waiting for adapter IC'),
                'add must wait for adapter IC to reach InService'
            );
        });
    });

    // ── do/adapter list output includes adapter name and status ───────────

    describe('do/adapter list output includes adapter name and status', () => {

        it('displays table header with NAME column', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('NAME'),
                'list output must include NAME column header'
            );
        });

        it('displays table header with STATUS column', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('STATUS'),
                'list output must include STATUS column header'
            );
        });

        it('displays table header with SOURCE column', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('SOURCE'),
                'list output must include SOURCE column header'
            );
        });

        it('calls ListInferenceComponents filtered by endpoint', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('list-inference-components') &&
                listSection.includes('--endpoint-name-equals'),
                'list must call ListInferenceComponents with endpoint filter'
            );
        });

        it('calls DescribeInferenceComponent for each IC', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('describe-inference-component'),
                'list must call DescribeInferenceComponent for details'
            );
        });

        it('filters to adapter ICs by checking BaseInferenceComponentName', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('BaseInferenceComponentName'),
                'list must filter by BaseInferenceComponentName'
            );
        });

        it('extracts InferenceComponentStatus for status display', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('InferenceComponentStatus'),
                'list must extract InferenceComponentStatus'
            );
        });

        it('extracts ADAPTER_SOURCE for source display', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('ADAPTER_SOURCE'),
                'list must extract ADAPTER_SOURCE for source column'
            );
        });

        it('shows endpoint name in list header', () => {
            const listSection = getListSection(adapterScript);
            assert.ok(
                listSection.includes('Adapters on endpoint'),
                'list must show endpoint name in header'
            );
        });
    });

    // ── do/adapter remove deletes conf file ──────────────────────────────

    describe('do/adapter remove deletes conf file', () => {

        it('reads ADAPTER_IC_NAME from conf file', () => {
            const removeSection = getRemoveSection(adapterScript);
            assert.ok(
                removeSection.includes('ADAPTER_IC_NAME'),
                'remove must read ADAPTER_IC_NAME from conf file'
            );
        });

        it('calls DeleteInferenceComponent via aws sagemaker', () => {
            const removeSection = getRemoveSection(adapterScript);
            assert.ok(
                removeSection.includes('delete-inference-component'),
                'remove must call DeleteInferenceComponent'
            );
        });

        it('waits for deletion to complete', () => {
            const removeSection = getRemoveSection(adapterScript);
            assert.ok(
                removeSection.includes('Waiting for adapter IC deletion') ||
                removeSection.includes('_get_ic_status'),
                'remove must wait for deletion to complete'
            );
        });

        it('removes do/adapters/<name>.conf file with rm -f', () => {
            const removeSection = getRemoveSection(adapterScript);
            assert.ok(
                removeSection.includes('rm -f') &&
                removeSection.includes('conf_file'),
                'remove must delete conf file with rm -f'
            );
        });

        it('validates adapter conf exists before removal', () => {
            const removeSection = getRemoveSection(adapterScript);
            assert.ok(
                removeSection.includes('! -f "${conf_file}"') ||
                removeSection.includes('Adapter not found'),
                'remove must validate adapter conf exists'
            );
        });
    });

    // ── do/adapter update changes ADAPTER_WEIGHTS_URI in conf ─────────────

    describe('do/adapter update changes ADAPTER_WEIGHTS_URI in conf', () => {

        it('uses sed to update ADAPTER_WEIGHTS_URI in conf file', () => {
            const updateSection = getUpdateSection(adapterScript);
            assert.ok(
                updateSection.includes('sed') &&
                updateSection.includes('ADAPTER_WEIGHTS_URI'),
                'update must use sed to change ADAPTER_WEIGHTS_URI'
            );
        });

        it('calls UpdateInferenceComponent via aws sagemaker', () => {
            const updateSection = getUpdateSection(adapterScript);
            assert.ok(
                updateSection.includes('update-inference-component'),
                'update must call UpdateInferenceComponent'
            );
        });

        it('passes new ArtifactUrl in specification', () => {
            const updateSection = getUpdateSection(adapterScript);
            assert.ok(
                updateSection.includes('ArtifactUrl') &&
                updateSection.includes('weights_uri'),
                'update must pass new ArtifactUrl in specification'
            );
        });

        it('waits for adapter IC to return to InService after update', () => {
            const updateSection = getUpdateSection(adapterScript);
            assert.ok(
                updateSection.includes('wait_ic') ||
                updateSection.includes('Waiting for adapter IC to return to InService'),
                'update must wait for IC to return to InService'
            );
        });

        it('validates adapter conf exists before update', () => {
            const updateSection = getUpdateSection(adapterScript);
            assert.ok(
                updateSection.includes('! -f "${conf_file}"') ||
                updateSection.includes('Adapter not found'),
                'update must validate adapter conf exists'
            );
        });

        it('validates new S3 URI format before update', () => {
            const updateSection = getUpdateSection(adapterScript);
            assert.ok(
                updateSection.includes('s3://') &&
                updateSection.includes('.tar.gz'),
                'update must validate new S3 URI format'
            );
        });

        it('reads ADAPTER_IC_NAME from conf for the API call', () => {
            const updateSection = getUpdateSection(adapterScript);
            assert.ok(
                updateSection.includes('ADAPTER_IC_NAME') &&
                updateSection.includes('conf_file'),
                'update must read ADAPTER_IC_NAME from conf file'
            );
        });
    });

    // ── Full lifecycle: generated project structure ───────────────────────

    describe('Generated project has correct adapter lifecycle structure', () => {

        it('do/adapter script is present', () => {
            result.assertFile('do/adapter');
        });

        it('do/adapters/ directory is present', () => {
            result.assertFile('do/adapters/.gitkeep');
        });

        it('do/config contains ENABLE_LORA=true', () => {
            result.assertFileContent('do/config', 'ENABLE_LORA=true');
        });

        it('do/adapter script is executable', () => {
            const adapterPath = result.file('do/adapter');
            const stats = fs.statSync(adapterPath);
            const isExecutable = (stats.mode & 0o111) !== 0;
            assert.ok(isExecutable, 'do/adapter must be executable');
        });

        it('do/adapter script has correct shebang', () => {
            assert.ok(
                adapterScript.startsWith('#!/bin/bash'),
                'do/adapter must start with #!/bin/bash shebang'
            );
        });
    });

    // ── Parent model metadata persisted in conf (US-3 prerequisite) ──────

    describe('do/adapter add stores parent model metadata in conf for compat check', () => {

        it('writes ADAPTER_PARENT_MODEL_ARN to conf when --from-registry is used', () => {
            assert.ok(
                adapterScript.includes('ADAPTER_PARENT_MODEL_ARN'),
                'Must write ADAPTER_PARENT_MODEL_ARN to conf file'
            );
        });

        it('writes ADAPTER_PARENT_MODEL_SLUG to conf when --from-registry is used', () => {
            assert.ok(
                adapterScript.includes('ADAPTER_PARENT_MODEL_SLUG'),
                'Must write ADAPTER_PARENT_MODEL_SLUG to conf file'
            );
        });

        it('extracts parentModelVersionArn from registry version metadata', () => {
            assert.ok(
                adapterScript.includes('parentModelVersionArn'),
                'Must extract parentModelVersionArn from registry metadata'
            );
        });

        it('extracts modelName from registry version metadata for slug', () => {
            assert.ok(
                adapterScript.includes('modelName'),
                'Must extract modelName from registry metadata for parent slug'
            );
        });

        it('uses export keyword for ADAPTER_PARENT_MODEL_ARN', () => {
            assert.ok(
                adapterScript.includes('export ADAPTER_PARENT_MODEL_ARN='),
                'ADAPTER_PARENT_MODEL_ARN must use export keyword'
            );
        });

        it('uses export keyword for ADAPTER_PARENT_MODEL_SLUG', () => {
            assert.ok(
                adapterScript.includes('export ADAPTER_PARENT_MODEL_SLUG='),
                'ADAPTER_PARENT_MODEL_SLUG must use export keyword'
            );
        });
    });
});

// ── Helper functions ──────────────────────────────────────────────────────────

function getListSection(script) {
    const start = script.indexOf('_adapter_list()');
    const end = script.indexOf('\n_adapter_remove(');
    if (start === -1 || end === -1) {
        return script; // fallback to full script
    }
    return script.substring(start, end);
}

function getRemoveSection(script) {
    const start = script.indexOf('_adapter_remove()');
    const end = script.indexOf('\n_adapter_update(');
    if (start === -1 || end === -1) {
        return script; // fallback to full script
    }
    return script.substring(start, end);
}

function getUpdateSection(script) {
    const start = script.indexOf('_adapter_update()');
    if (start === -1) {
        return script; // fallback to full script
    }
    return script.substring(start);
}
