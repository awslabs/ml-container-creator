// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the notebook export feature (deploy_notebook_generator.py template).
 *
 * Tests cover:
 * - Valid nbformat v4 JSON output for all deployment target × model server combos
 * - No secrets in rendered output when ARNs are used
 * - Env vars from config appear in configuration cell as Python literals
 * - LMI/DJL path skips CodeBuild section
 * - INFERENCE_AMI_VERSION included in endpoint config when set
 * - Adapter section present/absent based on ENABLE_LORA + realtime
 * - Tune section present/absent based on TUNE_SUPPORTED + realtime
 * - Adapter section uses BaseInferenceComponentName (no ComputeResourceRequirements)
 * - Tune section pre-fills ADAPTER_WEIGHTS_URI from TUNE_ADAPTER_PATH
 *
 * Feature: notebook-export
 * Validates: Requirements 1.2, 1.3, 4.1, 6.1, 9.1, 9.4, 9.5, 10.1, 13.1, 13.7
 */

import { describe, it, afterEach } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/deploy_notebook_generator.py');
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf-8');

// ── Helper: render the EJS template to a Python script ───────────────────────

function renderTemplate(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        modelName: 'meta-llama/Llama-2-7b-hf',
        hfToken: '',
        hfTokenArn: '',
        ngcApiKey: '',
        ngcTokenArn: '',
        orderedEnvVars: [],
        inferenceAmiVersion: '',
        enableLora: false,
        tuneSupported: false,
        existingEndpointName: null,
        ...overrides
    };
    return ejs.render(TEMPLATE, vars);
}

// ── Helper: execute the rendered Python script and return parsed notebook ─────

function executeNotebookGenerator(pythonScript, envOverrides = {}) {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'notebook-test-'));
    const scriptPath = join(tmpDir, 'deploy_notebook_generator.py');
    writeFileSync(scriptPath, pythonScript);

    const env = {
        PROJECT_NAME: 'test-project',
        AWS_REGION: 'us-east-1',
        INSTANCE_TYPE: 'ml.g5.xlarge',
        MODEL_SERVER: 'vllm',
        DEPLOYMENT_TARGET: 'realtime-inference',
        FRAMEWORK: 'transformers',
        IC_GPU_COUNT: '4',
        IC_MEMORY_SIZE: '65536',
        ...envOverrides
    };

    try {
        execFileSync('python3', [scriptPath], {
            cwd: tmpDir,
            env,
            timeout: 15000,
            stdio: 'pipe'
        });

        const notebookPath = join(tmpDir, 'deploy_notebook.ipynb');
        assert.ok(existsSync(notebookPath), 'deploy_notebook.ipynb should be created');
        const notebookContent = readFileSync(notebookPath, 'utf-8');
        const notebook = JSON.parse(notebookContent);
        return { notebook, tmpDir, notebookContent };
    } catch (error) {
        const stdout = error.stdout ? error.stdout.toString() : '';
        const stderr = error.stderr ? error.stderr.toString() : '';
        rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(
            `Python script execution failed:\n  stdout: ${stdout.substring(0, 500)}\n  stderr: ${stderr.substring(0, 500)}`
        );
    }
}

// ── Helper: validate nbformat v4 structure ───────────────────────────────────

function assertValidNbformat(notebook) {
    assert.strictEqual(notebook.nbformat, 4, 'nbformat must be 4');
    assert.strictEqual(notebook.nbformat_minor, 5, 'nbformat_minor must be 5');
    assert.ok(notebook.metadata, 'metadata must exist');
    assert.ok(notebook.metadata.kernelspec, 'kernelspec must exist');
    assert.strictEqual(notebook.metadata.kernelspec.language, 'python');
    assert.ok(Array.isArray(notebook.cells), 'cells must be an array');
    assert.ok(notebook.cells.length > 0, 'cells must not be empty');

    for (const cell of notebook.cells) {
        assert.ok(
            cell.cell_type === 'code' || cell.cell_type === 'markdown',
            `cell_type must be "code" or "markdown", got "${cell.cell_type}"`
        );
        assert.ok(Array.isArray(cell.source), 'cell source must be an array');
        assert.deepStrictEqual(cell.metadata, {}, 'cell metadata must be empty object');

        if (cell.cell_type === 'code') {
            assert.deepStrictEqual(cell.outputs, [], 'code cell outputs must be empty array');
            assert.strictEqual(cell.execution_count, null, 'execution_count must be null');
        }
    }
}

// ── Helper: get all cell sources concatenated ────────────────────────────────

function getAllCellSource(notebook) {
    return notebook.cells.map(c => c.source.join('')).join('\n');
}

function getCodeCellSources(notebook) {
    return notebook.cells
        .filter(c => c.cell_type === 'code')
        .map(c => c.source.join(''));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: notebook-export — Unit Tests', function () {
    this.timeout(30000);

    let tmpDirs = [];

    afterEach(() => {
        for (const dir of tmpDirs) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
        tmpDirs = [];
    });

    describe('realtime + vllm config → valid nbformat JSON', () => {
        it('renders and executes to produce valid nbformat v4 notebook', () => {
            const script = renderTemplate({
                framework: 'transformers',
                modelServer: 'vllm',
                deploymentTarget: 'realtime-inference',
                orderedEnvVars: [{ key: 'VLLM_MODEL', value: 'meta-llama/Llama-2-7b-hf' }]
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                VLLM_MODEL: 'meta-llama/Llama-2-7b-hf'
            });
            tmpDirs.push(tmpDir);

            assertValidNbformat(notebook);
            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('create_endpoint'), 'should contain endpoint creation');
            assert.ok(allSource.includes('create_inference_component'), 'should contain IC creation');
        });
    });

    describe('realtime + tensorrt-llm config → valid nbformat JSON', () => {
        it('renders and executes to produce valid nbformat v4 notebook', () => {
            const script = renderTemplate({
                framework: 'transformers',
                modelServer: 'tensorrt-llm',
                deploymentTarget: 'realtime-inference',
                orderedEnvVars: [{ key: 'TRTLLM_MODEL', value: 'meta-llama/Llama-2-7b-hf' }]
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                TRTLLM_MODEL: 'meta-llama/Llama-2-7b-hf'
            });
            tmpDirs.push(tmpDir);

            assertValidNbformat(notebook);
        });
    });

    describe('async + sglang config → valid nbformat JSON', () => {
        it('renders and executes to produce valid nbformat v4 notebook', () => {
            const script = renderTemplate({
                framework: 'transformers',
                modelServer: 'sglang',
                deploymentTarget: 'async-inference',
                orderedEnvVars: [{ key: 'SGLANG_MODEL_PATH', value: 'meta-llama/Llama-2-7b-hf' }]
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                SGLANG_MODEL_PATH: 'meta-llama/Llama-2-7b-hf'
            });
            tmpDirs.push(tmpDir);

            assertValidNbformat(notebook);
            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('AsyncInferenceConfig'), 'should contain async config');
            assert.ok(allSource.includes('invoke_endpoint_async'), 'should contain async invocation');
            assert.ok(!allSource.includes('create_inference_component'), 'should NOT contain IC for async');
        });
    });

    describe('batch + flask config → valid nbformat JSON', () => {
        it('renders and executes to produce valid nbformat v4 notebook', () => {
            const script = renderTemplate({
                framework: 'sklearn',
                modelServer: 'flask',
                deploymentTarget: 'batch-transform',
                orderedEnvVars: [{ key: 'MODEL_PATH', value: '/opt/ml/model' }]
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                MODEL_PATH: '/opt/ml/model'
            });
            tmpDirs.push(tmpDir);

            assertValidNbformat(notebook);
            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('create_transform_job'), 'should contain transform job');
            assert.ok(!allSource.includes('create_endpoint('), 'should NOT contain endpoint for batch');
            assert.ok(!allSource.includes('create_inference_component'), 'should NOT contain IC for batch');
        });
    });

    describe('no secrets in rendered output when HF_TOKEN_ARN is used', () => {
        it('does not hardcode any secret value in the notebook', () => {
            const script = renderTemplate({
                hfTokenArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hf-token-AbCdEf',
                hfToken: ''
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                HF_TOKEN_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hf-token-AbCdEf'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            // Should reference Secrets Manager resolution, not a hardcoded token
            assert.ok(allSource.includes('get_secret_value'), 'should use Secrets Manager resolution');
            assert.ok(allSource.includes('HF_TOKEN_ARN'), 'should reference the ARN variable');
            // Should not contain a hardcoded HF token value (tokens start with hf_xxxx pattern)
            // The env["HF_TOKEN"] assignment should come from secrets resolution, not a literal
            const codeCells = getCodeCellSources(notebook);
            const secretsCell = codeCells.find(src => src.includes('HF_TOKEN_ARN'));
            assert.ok(secretsCell, 'should have a cell referencing HF_TOKEN_ARN');
            assert.ok(
                secretsCell.includes('get_secret_value'),
                'HF_TOKEN should be resolved via Secrets Manager, not hardcoded'
            );
            // Ensure no cell directly assigns a literal token value to HF_TOKEN
            const hasHardcodedToken = codeCells.some(src =>
                /env\["HF_TOKEN"\]\s*=\s*"hf_/.test(src)
            );
            assert.ok(!hasHardcodedToken, 'should not contain a hardcoded HF_TOKEN literal value');
        });
    });

    describe('no secrets in rendered output when NGC_API_KEY_ARN is used', () => {
        it('does not hardcode any secret value in the notebook', () => {
            const script = renderTemplate({
                ngcTokenArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ngc-key-XyZ123',
                ngcApiKey: ''
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                NGC_API_KEY_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ngc-key-XyZ123'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('get_secret_value'), 'should use Secrets Manager resolution');
            assert.ok(allSource.includes('NGC_API_KEY_ARN'), 'should reference the ARN variable');
            assert.ok(!allSource.includes('nvapi-'), 'should not contain any nvapi- key value');
        });
    });

    describe('env vars from config appear in configuration cell as Python literals', () => {
        it('bakes ordered env vars into the env dict cell', () => {
            const script = renderTemplate({
                orderedEnvVars: [
                    { key: 'VLLM_MODEL', value: 'meta-llama/Llama-2-7b-hf' },
                    { key: 'VLLM_MAX_MODEL_LEN', value: '4096' },
                    { key: 'VLLM_TENSOR_PARALLEL_SIZE', value: '4' }
                ]
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                VLLM_MODEL: 'meta-llama/Llama-2-7b-hf',
                VLLM_MAX_MODEL_LEN: '4096',
                VLLM_TENSOR_PARALLEL_SIZE: '4'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('"VLLM_MODEL"'), 'should contain VLLM_MODEL key');
            assert.ok(allSource.includes('"VLLM_MAX_MODEL_LEN"'), 'should contain VLLM_MAX_MODEL_LEN key');
            assert.ok(allSource.includes('"VLLM_TENSOR_PARALLEL_SIZE"'), 'should contain VLLM_TENSOR_PARALLEL_SIZE key');
            assert.ok(allSource.includes('meta-llama/Llama-2-7b-hf'), 'should contain model value');
            assert.ok(allSource.includes('4096'), 'should contain max model len value');
        });
    });

    describe('LMI/DJL path skips CodeBuild section', () => {
        it('uses DLC image URI instead of CodeBuild for lmi server', () => {
            const script = renderTemplate({
                modelServer: 'lmi',
                framework: 'transformers',
                deploymentTarget: 'realtime-inference'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(!allSource.includes('codebuild'), 'should NOT contain codebuild for LMI');
            assert.ok(!allSource.includes('start_build'), 'should NOT contain start_build for LMI');
            assert.ok(allSource.includes('image_uris.retrieve'), 'should use DLC image_uris.retrieve');
            assert.ok(allSource.includes('DLC Image URI'), 'should reference DLC');
        });

        it('uses DLC image URI instead of CodeBuild for djl server', () => {
            const script = renderTemplate({
                modelServer: 'djl',
                framework: 'transformers',
                deploymentTarget: 'realtime-inference'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(!allSource.includes('codebuild'), 'should NOT contain codebuild for DJL');
            assert.ok(!allSource.includes('start_build'), 'should NOT contain start_build for DJL');
            assert.ok(allSource.includes('image_uris.retrieve'), 'should use DLC image_uris.retrieve');
        });
    });

    describe('INFERENCE_AMI_VERSION included in endpoint config when set', () => {
        it('includes InferenceAmiVersion conditional in endpoint config', () => {
            const script = renderTemplate({
                deploymentTarget: 'realtime-inference',
                inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-2.3.1'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                INFERENCE_AMI_VERSION: 'al2-ami-sagemaker-inference-gpu-2.3.1'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('INFERENCE_AMI_VERSION'), 'should reference INFERENCE_AMI_VERSION');
            assert.ok(allSource.includes('InferenceAmiVersion'), 'should include InferenceAmiVersion in endpoint config');
            assert.ok(allSource.includes('al2-ami-sagemaker-inference-gpu-2.3.1'), 'should contain the AMI version value');
        });
    });

    describe('adapter section present when ENABLE_LORA=true + realtime, absent otherwise', () => {
        it('includes adapter section when enableLora=true and realtime', () => {
            const script = renderTemplate({
                enableLora: true,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('LoRA Adapter'), 'should contain LoRA Adapter section');
            assert.ok(allSource.includes('ADAPTER_NAME'), 'should contain ADAPTER_NAME variable');
            assert.ok(allSource.includes('ADAPTER_WEIGHTS_URI'), 'should contain ADAPTER_WEIGHTS_URI variable');
        });

        it('excludes adapter section when enableLora=false', () => {
            const script = renderTemplate({
                enableLora: false,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(!allSource.includes('LoRA Adapter'), 'should NOT contain LoRA Adapter section');
            assert.ok(!allSource.includes('ADAPTER_WEIGHTS_URI'), 'should NOT contain ADAPTER_WEIGHTS_URI');
        });

        it('excludes adapter section for async even when enableLora=true', () => {
            const script = renderTemplate({
                enableLora: true,
                deploymentTarget: 'async-inference',
                framework: 'transformers'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(!allSource.includes('LoRA Adapter'), 'should NOT contain LoRA Adapter for async');
        });
    });

    describe('tune section present when TUNE_SUPPORTED=true + realtime, absent otherwise', () => {
        it('includes tune section when tuneSupported=true and realtime', () => {
            const script = renderTemplate({
                tuneSupported: true,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                MODEL_NAME: 'meta-llama/Llama-2-7b-hf',
                TUNE_S3_BUCKET: 'my-tune-bucket'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(allSource.includes('Managed Fine-Tuning'), 'should contain Fine-Tune section');
            assert.ok(allSource.includes('ModelTrainer'), 'should contain ModelTrainer');
            assert.ok(allSource.includes('TECHNIQUE'), 'should contain TECHNIQUE variable');
        });

        it('excludes tune section when tuneSupported=false', () => {
            const script = renderTemplate({
                tuneSupported: false,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(!allSource.includes('Managed Fine-Tuning'), 'should NOT contain Fine-Tune section');
            assert.ok(!allSource.includes('ModelTrainer'), 'should NOT contain ModelTrainer');
        });

        it('excludes tune section for batch even when tuneSupported=true', () => {
            const script = renderTemplate({
                tuneSupported: true,
                deploymentTarget: 'batch-transform',
                framework: 'transformers',
                modelServer: 'vllm'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(!allSource.includes('Managed Fine-Tuning'), 'should NOT contain Fine-Tune for batch');
        });
    });

    describe('adapter section uses BaseInferenceComponentName (no ComputeResourceRequirements)', () => {
        it('adapter IC creation uses BaseInferenceComponentName without ComputeResourceRequirements', () => {
            const script = renderTemplate({
                enableLora: true,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script);
            tmpDirs.push(tmpDir);

            // Find the adapter IC creation cell
            const codeCells = getCodeCellSources(notebook);
            const adapterCell = codeCells.find(src =>
                src.includes('BaseInferenceComponentName') && src.includes('adapter')
            );
            assert.ok(adapterCell, 'should have an adapter IC creation cell with BaseInferenceComponentName');
            assert.ok(
                !adapterCell.includes('ComputeResourceRequirements'),
                'adapter IC cell must NOT contain ComputeResourceRequirements'
            );
            assert.ok(
                adapterCell.includes('ArtifactUrl'),
                'adapter IC cell must contain ArtifactUrl'
            );
        });
    });

    describe('tune section pre-fills ADAPTER_WEIGHTS_URI from TUNE_ADAPTER_PATH when available', () => {
        it('pre-fills ADAPTER_WEIGHTS_URI from TUNE_ADAPTER_PATH_SFT', () => {
            const script = renderTemplate({
                enableLora: true,
                tuneSupported: true,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const tuneOutputPath = 's3://my-bucket/output/sft-adapter/adapter.tar.gz';
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                TUNE_ADAPTER_PATH_SFT: tuneOutputPath,
                MODEL_NAME: 'meta-llama/Llama-2-7b-hf',
                TUNE_S3_BUCKET: 'my-tune-bucket'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(
                allSource.includes(tuneOutputPath),
                'ADAPTER_WEIGHTS_URI should be pre-filled with TUNE_ADAPTER_PATH_SFT value'
            );
        });

        it('pre-fills ADAPTER_WEIGHTS_URI from TUNE_ADAPTER_PATH_DPO when SFT not set', () => {
            const script = renderTemplate({
                enableLora: true,
                tuneSupported: true,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const dpoPath = 's3://my-bucket/output/dpo-adapter/adapter.tar.gz';
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                TUNE_ADAPTER_PATH_DPO: dpoPath,
                MODEL_NAME: 'meta-llama/Llama-2-7b-hf',
                TUNE_S3_BUCKET: 'my-tune-bucket'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(
                allSource.includes(dpoPath),
                'ADAPTER_WEIGHTS_URI should be pre-filled with TUNE_ADAPTER_PATH_DPO value'
            );
        });

        it('uses placeholder when no TUNE_ADAPTER_PATH is set', () => {
            const script = renderTemplate({
                enableLora: true,
                tuneSupported: true,
                deploymentTarget: 'realtime-inference',
                framework: 'transformers'
            });
            const { notebook, tmpDir } = executeNotebookGenerator(script, {
                MODEL_NAME: 'meta-llama/Llama-2-7b-hf',
                TUNE_S3_BUCKET: 'my-tune-bucket'
            });
            tmpDirs.push(tmpDir);

            const allSource = getAllCellSource(notebook);
            assert.ok(
                allSource.includes('s3://your-bucket/adapters/my-adapter/adapter.tar.gz'),
                'ADAPTER_WEIGHTS_URI should use placeholder when no tune path is set'
            );
        });
    });
});
