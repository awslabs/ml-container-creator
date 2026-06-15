// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Notebook Export Property-Based Tests
 *
 * Feature: notebook-export, Property 1: Valid JSON output for all config combos
 * Feature: notebook-export, Property 4: All code cells have valid Python syntax
 * Feature: notebook-export, Property 5: Section presence/absence matches branching matrix
 * Feature: notebook-export, Property 7: Adapter IC creation never contains ComputeResourceRequirements
 * Feature: notebook-export, Property 8: Tune section uses ModelTrainer with model_id matching MODEL_NAME
 *
 * Validates: Requirements 1.2, 1.3, 6.1, 7.1, 9.1, 9.5, 10.1, 10.4, 12.4, 12.5
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { NUM_RUNS } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Template loading ─────────────────────────────────────────────────────────

const TEMPLATE_PATH = path.join(__dirname, '../../templates/deploy_notebook_generator.py');

let TEMPLATE_CONTENT;
if (existsSync(TEMPLATE_PATH)) {
    TEMPLATE_CONTENT = readFileSync(TEMPLATE_PATH, 'utf8');
} else {
    // Template doesn't exist yet — notebook-export not implemented
    describe('Feature: notebook-export (template not yet implemented)', () => {
        it('skipped — deploy_notebook_generator.py does not exist yet');
    });
}

// If template not loaded, skip all remaining tests
const TEMPLATE_AVAILABLE = !!TEMPLATE_CONTENT;

// ── Constants ────────────────────────────────────────────────────────────────

const DEPLOYMENT_TARGETS = ['realtime-inference', 'async-inference', 'batch-transform'];
const MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl', 'flask'];

/** Map model server to framework */
function frameworkForServer(server) {
    if (['flask'].includes(server)) return 'predictors';
    return 'transformers';
}

const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 120000,
    verbose: false
};

// ── Temp directory for script execution ──────────────────────────────────────

const TMP_DIR = path.join(__dirname, '../../.kiro/tmp');
mkdirSync(TMP_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Render the EJS template with given config and return the Python script content.
 */
function renderTemplate(config) {
    if (!TEMPLATE_AVAILABLE) return '';
    const vars = {
        deploymentTarget: config.deploymentTarget,
        modelServer: config.modelServer,
        framework: config.framework,
        enableLora: config.enableLora || false,
        tuneSupported: config.tuneSupported || false,
        orderedEnvVars: config.orderedEnvVars || [
            { key: 'HF_MODEL_ID', value: 'meta-llama/Llama-3-8B' }
        ],
        hfTokenArn: config.hfTokenArn || '',
        hfToken: config.hfToken || '',
        ngcTokenArn: config.ngcTokenArn || '',
        ngcApiKey: config.ngcApiKey || '',
        inferenceAmiVersion: config.inferenceAmiVersion || '',
        existingEndpointName: config.existingEndpointName || ''
    };
    return ejs.render(TEMPLATE_CONTENT, vars);
}

/**
 * Execute the rendered Python script and return the notebook JSON.
 * Sets required environment variables for the script.
 */
function executeScript(scriptContent, config) {
    const scriptPath = path.join(TMP_DIR, `notebook-test-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
    const outputPath = path.join(TMP_DIR, `notebook-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ipynb`);

    // Patch the script to write to our specific output path
    const patchedScript = scriptContent.replace(
        'output_path = "deploy_notebook.ipynb"',
        `output_path = "${outputPath.replace(/\\/g, '/')}"`
    );

    writeFileSync(scriptPath, patchedScript, { mode: 0o755 });

    const envVars = {
        ...process.env,
        PROJECT_NAME: 'test-project',
        AWS_REGION: 'us-west-2',
        INSTANCE_TYPE: 'ml.g5.2xlarge',
        MODEL_SERVER: config.modelServer,
        FRAMEWORK: config.framework,
        DEPLOYMENT_TARGET: config.deploymentTarget,
        IC_GPU_COUNT: '1',
        IC_MEMORY_SIZE: '4096',
        CODEBUILD_PROJECT_NAME: 'test-project-build',
        ENABLE_LORA: config.enableLora ? 'true' : 'false',
        TUNE_SUPPORTED: config.tuneSupported ? 'true' : 'false',
        TUNE_S3_BUCKET: 'test-tune-bucket',
        MODEL_NAME: 'meta-llama/Llama-3-8B-Instruct',
        HF_TOKEN_ARN: config.hfTokenArn || '',
        HF_TOKEN: config.hfToken || '',
        NGC_API_KEY_ARN: config.ngcTokenArn || '',
        NGC_API_KEY: config.ngcApiKey || '',
        INFERENCE_AMI_VERSION: config.inferenceAmiVersion || ''
    };

    try {
        execSync(`python3 "${scriptPath}"`, {
            encoding: 'utf8',
            timeout: 10000,
            env: envVars,
            cwd: TMP_DIR
        });

        const notebookContent = readFileSync(outputPath, 'utf8');
        return JSON.parse(notebookContent);
    } finally {
        try { unlinkSync(scriptPath); } catch (e) { /* ignore */ }
        try { unlinkSync(outputPath); } catch (e) { /* ignore */ }
    }
}

/**
 * Render and execute the template for a given config, returning the notebook JSON.
 */
function generateNotebook(config) {
    const script = renderTemplate(config);
    return executeScript(script, config);
}

/**
 * Extract all code cell sources as strings from a notebook.
 */
function getCodeCells(notebook) {
    return notebook.cells
        .filter(c => c.cell_type === 'code')
        .map(c => c.source.join(''));
}

/**
 * Extract all markdown cell sources as strings from a notebook.
 */
function getMarkdownCells(notebook) {
    return notebook.cells
        .filter(c => c.cell_type === 'markdown')
        .map(c => c.source.join(''));
}

/**
 * Get all cell sources concatenated (for searching).
 */
function getAllCellText(notebook) {
    return notebook.cells.map(c => c.source.join('')).join('\n');
}

// ── Arbitrary generators ─────────────────────────────────────────────────────

/** Generate a valid config combination */
const arbConfig = fc.record({
    deploymentTarget: fc.constantFrom(...DEPLOYMENT_TARGETS),
    modelServer: fc.constantFrom(...MODEL_SERVERS),
    enableLora: fc.boolean(),
    tuneSupported: fc.boolean()
}).map(config => ({
    ...config,
    framework: frameworkForServer(config.modelServer)
}));

// ── Property 1: Valid JSON output ────────────────────────────────────────────

describe('Feature: notebook-export, Property 1: Valid JSON output for all config combos', function () {
    this.timeout(PROPERTY_CONFIG.timeout);
    before(function () { if (!TEMPLATE_AVAILABLE) this.skip(); });

    it('every (deploymentTarget × modelServer × enableLora × tuneSupported) combo produces valid JSON', () => {
        /**
         * Validates: Requirements 1.2, 12.4, 12.5
         */
        fc.assert(fc.property(
            arbConfig,
            (config) => {
                const notebook = generateNotebook(config);

                // Must have nbformat v4 structure
                assert.strictEqual(notebook.nbformat, 4, 'nbformat must be 4');
                assert.strictEqual(notebook.nbformat_minor, 5, 'nbformat_minor must be 5');
                assert.ok(notebook.metadata, 'metadata must exist');
                assert.ok(notebook.metadata.kernelspec, 'kernelspec must exist');
                assert.ok(Array.isArray(notebook.cells), 'cells must be an array');

                // Every cell must have valid cell_type
                for (const cell of notebook.cells) {
                    assert.ok(
                        cell.cell_type === 'code' || cell.cell_type === 'markdown',
                        `cell_type must be "code" or "markdown", got "${cell.cell_type}"`
                    );
                    assert.ok(Array.isArray(cell.source), 'source must be an array');
                    assert.deepStrictEqual(cell.metadata, {}, 'metadata must be empty object');

                    if (cell.cell_type === 'code') {
                        assert.deepStrictEqual(cell.outputs, [], 'outputs must be empty array');
                        assert.strictEqual(cell.execution_count, null, 'execution_count must be null');
                    }
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 4: All code cells have valid Python syntax ──────────────────────

describe('Feature: notebook-export, Property 4: All code cells have valid Python syntax', function () {
    this.timeout(PROPERTY_CONFIG.timeout);
    before(function () { if (!TEMPLATE_AVAILABLE) this.skip(); });

    it('every code cell passes ast.parse()', () => {
        /**
         * Validates: Requirements 1.3, 12.5
         */
        fc.assert(fc.property(
            arbConfig,
            (config) => {
                const notebook = generateNotebook(config);
                const codeCells = getCodeCells(notebook);

                for (const code of codeCells) {
                    // Skip pip magic commands (not valid Python syntax for ast.parse)
                    if (code.trim().startsWith('%pip') || code.trim().startsWith('!')) {
                        continue;
                    }

                    // Use python3 -c to validate syntax via ast.parse
                    const checkScript = path.join(TMP_DIR, `syntax-check-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
                    const codeB64 = Buffer.from(code).toString('base64');
                    writeFileSync(checkScript, `import ast, base64\ncode = base64.b64decode("${codeB64}").decode("utf-8")\nast.parse(code)\n`);

                    try {
                        execSync(`python3 "${checkScript}"`, {
                            encoding: 'utf8',
                            timeout: 5000
                        });
                    } catch (e) {
                        assert.fail(
                            `Code cell failed ast.parse() for config ${JSON.stringify({
                                deploymentTarget: config.deploymentTarget,
                                modelServer: config.modelServer
                            })}:\n${code.substring(0, 200)}...\nError: ${e.stderr || e.message}`
                        );
                    } finally {
                        try { unlinkSync(checkScript); } catch (e) { /* ignore */ }
                    }
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 5: Section presence/absence matches branching matrix ────────────

describe('Feature: notebook-export, Property 5: Section presence/absence matches branching matrix', function () {
    this.timeout(PROPERTY_CONFIG.timeout);
    before(function () { if (!TEMPLATE_AVAILABLE) this.skip(); });

    it('IC section only present for realtime-inference', () => {
        /**
         * Validates: Requirements 6.1, 7.1
         */
        fc.assert(fc.property(
            arbConfig,
            (config) => {
                const notebook = generateNotebook(config);
                const allText = getAllCellText(notebook);

                const hasICSection = allText.includes('Create Inference Component') ||
                    allText.includes('create_inference_component');

                if (config.deploymentTarget === 'realtime-inference') {
                    assert.ok(hasICSection,
                        'realtime-inference must have IC section');
                } else {
                    // For async/batch, the base IC section should not be present
                    // (no "Create Inference Component" heading)
                    const hasICHeading = getMarkdownCells(notebook).some(
                        md => md.includes('## Create Inference Component')
                    );
                    assert.ok(!hasICHeading,
                        `${config.deploymentTarget} must NOT have IC section heading`);
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('adapter section only present for realtime + enableLora', () => {
        /**
         * Validates: Requirements 9.1
         */
        fc.assert(fc.property(
            arbConfig,
            (config) => {
                const notebook = generateNotebook(config);
                const allText = getAllCellText(notebook);

                const hasAdapterSection = allText.includes('LoRA Adapter') &&
                    allText.includes('BaseInferenceComponentName');

                if (config.deploymentTarget === 'realtime-inference' && config.enableLora) {
                    assert.ok(hasAdapterSection,
                        'realtime + enableLora must have adapter section');
                } else {
                    assert.ok(!hasAdapterSection,
                        `${config.deploymentTarget} + enableLora=${config.enableLora} must NOT have adapter section`);
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('tune section only present for realtime + tuneSupported', () => {
        /**
         * Validates: Requirements 10.1
         */
        fc.assert(fc.property(
            arbConfig,
            (config) => {
                const notebook = generateNotebook(config);
                const allText = getAllCellText(notebook);

                const hasTuneSection = allText.includes('Managed Fine-Tuning') &&
                    allText.includes('ModelTrainer');

                if (config.deploymentTarget === 'realtime-inference' && config.tuneSupported) {
                    assert.ok(hasTuneSection,
                        'realtime + tuneSupported must have tune section');
                } else {
                    assert.ok(!hasTuneSection,
                        `${config.deploymentTarget} + tuneSupported=${config.tuneSupported} must NOT have tune section`);
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('async config only present for async-inference', () => {
        /**
         * Validates: Requirements 6.1
         */
        fc.assert(fc.property(
            arbConfig,
            (config) => {
                const notebook = generateNotebook(config);
                const allText = getAllCellText(notebook);

                const hasAsyncConfig = allText.includes('AsyncInferenceConfig');

                if (config.deploymentTarget === 'async-inference') {
                    assert.ok(hasAsyncConfig,
                        'async-inference must have AsyncInferenceConfig');
                } else {
                    assert.ok(!hasAsyncConfig,
                        `${config.deploymentTarget} must NOT have AsyncInferenceConfig`);
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('transform job only present for batch-transform', () => {
        /**
         * Validates: Requirements 6.1
         */
        fc.assert(fc.property(
            arbConfig,
            (config) => {
                const notebook = generateNotebook(config);
                const allText = getAllCellText(notebook);

                const hasTransformJob = allText.includes('create_transform_job');

                if (config.deploymentTarget === 'batch-transform') {
                    assert.ok(hasTransformJob,
                        'batch-transform must have create_transform_job');
                } else {
                    assert.ok(!hasTransformJob,
                        `${config.deploymentTarget} must NOT have create_transform_job`);
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 7: Adapter IC never contains ComputeResourceRequirements ────────

describe('Feature: notebook-export, Property 7: Adapter IC creation never contains ComputeResourceRequirements', function () {
    this.timeout(PROPERTY_CONFIG.timeout);
    before(function () { if (!TEMPLATE_AVAILABLE) this.skip(); });

    it('adapter IC uses BaseInferenceComponentName without ComputeResourceRequirements', () => {
        /**
         * Validates: Requirements 9.5
         */
        fc.assert(fc.property(
            arbConfig.filter(c => c.deploymentTarget === 'realtime-inference' && c.enableLora),
            (config) => {
                const notebook = generateNotebook(config);
                const codeCells = getCodeCells(notebook);

                // Find the adapter IC creation cell (contains BaseInferenceComponentName)
                const adapterCells = codeCells.filter(code =>
                    code.includes('BaseInferenceComponentName')
                );

                assert.ok(adapterCells.length > 0,
                    'Must have at least one cell with BaseInferenceComponentName');

                for (const adapterCode of adapterCells) {
                    assert.ok(!adapterCode.includes('ComputeResourceRequirements'),
                        'Adapter IC creation must NOT contain ComputeResourceRequirements');
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 8: Tune section uses ModelTrainer with model_id matching MODEL_NAME ─

describe('Feature: notebook-export, Property 8: Tune section uses ModelTrainer with model_id matching MODEL_NAME', function () {
    this.timeout(PROPERTY_CONFIG.timeout);
    before(function () { if (!TEMPLATE_AVAILABLE) this.skip(); });

    it('tune section references ModelTrainer with model_id=MODEL_NAME from env', () => {
        /**
         * Validates: Requirements 10.4
         */
        fc.assert(fc.property(
            arbConfig.filter(c => c.deploymentTarget === 'realtime-inference' && c.tuneSupported),
            (config) => {
                const notebook = generateNotebook(config);
                const codeCells = getCodeCells(notebook);

                // Find the cell that imports and uses ModelTrainer
                const trainerCells = codeCells.filter(code =>
                    code.includes('ModelTrainer')
                );

                assert.ok(trainerCells.length > 0,
                    'Must have at least one cell with ModelTrainer');

                // The trainer cell must use model_id=MODEL_NAME
                const trainerCell = trainerCells.find(code =>
                    code.includes('model_id=MODEL_NAME')
                );
                assert.ok(trainerCell,
                    'ModelTrainer must use model_id=MODEL_NAME');

                // MODEL_NAME must be set from the env var
                const modelNameCell = codeCells.find(code =>
                    code.includes('MODEL_NAME') && code.includes('meta-llama/Llama-3-8B-Instruct')
                );
                assert.ok(modelNameCell,
                    'MODEL_NAME variable must be set from MODEL_NAME env var');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
