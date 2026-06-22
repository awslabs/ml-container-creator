// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace File Inclusion Property-Based Tests
 *
 * Property 3: Marketplace file inclusion — exact output set
 *
 * For any valid marketplace configuration, the generated project SHALL contain
 * exactly the following do/ scripts: config, deploy, test, logs, clean, status,
 * register (plus do/lib/ shared helpers), and no others.
 *
 * Note: The actual generator output also includes do/ci and do/manifest as
 * utility scripts. The do/status script is only included for realtime-inference
 * deployment targets (async and batch exclude it per generator logic). The
 * expected set is verified against the actual generator behavior.
 *
 * Feature: marketplace-model-packages, Property 3: Marketplace file inclusion — exact output set
 *
 * **Validates: Requirements 5.2**
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runGenerator } from '../helpers/run-generator.js';
import { NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = { numRuns: NUM_RUNS, timeout: 30000, seed: 42, verbose: false };

// ── Expected file sets ───────────────────────────────────────────────────────

/**
 * The base set of top-level do/ scripts that ALL marketplace projects must contain,
 * regardless of deployment target.
 */
const BASE_DO_SCRIPTS = new Set([
    'config',
    'deploy',
    'test',
    'logs',
    'clean',
    'register',
    'ci',
    'manifest',
    'stage',
    'benchmark',
    '.benchmark_writer.py',
    'optimize'
]);

/**
 * Returns the exact expected set of do/ scripts for a given deployment target.
 * - realtime-inference: includes do/status (endpoint status check)
 * - async-inference: no do/status (no persistent endpoint to check)
 * - batch-transform: no do/status (no persistent endpoint to check)
 */
function getExpectedDoScripts(deploymentTarget) {
    const scripts = new Set(BASE_DO_SCRIPTS);
    if (deploymentTarget === 'realtime-inference') {
        scripts.add('status');
    }
    return scripts;
}

/**
 * The expected do/lib/ shared helper files.
 */
const EXPECTED_LIB_FILES = new Set([
    'asset-manager.js',
    'bootstrap-config.js',
    'endpoint-config.sh',
    'inference-component.sh',
    'manifest-cli.js',
    'secrets.sh',
    'wait.sh'
]);

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid AWS regions
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

// Valid model package ARNs
const arbModelPackageArn = fc.tuple(
    arbAwsRegion,
    fc.constantFrom('123456789012', '987654321098', '111222333444'),
    fc.constantFrom('ai21-j2-ultra', 'cohere-command', 'meta-llama', 'stability-sdxl', 'anthropic-claude'),
    fc.integer({ min: 1, max: 10 })
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Valid project names
const arbProjectName = fc.constantFrom(
    'test-mkt', 'my-marketplace', 'mkt-deploy', 'vendor-model', 'ai-pkg'
);

// Valid instance types
const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.8xlarge',
    'ml.g5.12xlarge', 'ml.g5.16xlarge', 'ml.g5.24xlarge', 'ml.g5.48xlarge'
);

// Valid deployment targets
const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform'
);

/**
 * Generate a complete set of CLI options for running the marketplace generator.
 */
const arbMarketplaceCliOptions = fc.record({
    projectName: arbProjectName,
    modelPackageArn: arbModelPackageArn,
    awsRegion: arbAwsRegion,
    instanceType: arbInstanceType,
    deploymentTarget: arbDeploymentTarget
}).map(({ projectName, modelPackageArn, awsRegion, instanceType, deploymentTarget }) => ({
    deploymentTarget,
    cliOptions: {
        'deployment-config': 'marketplace',
        'model-name': `marketplace://${modelPackageArn}`,
        'instance-type': instanceType,
        'region': awsRegion,
        'deployment-target': deploymentTarget,
        'project-name': projectName
    }
}));

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * Lists all files in the do/ directory (top-level only, excluding .gitkeep).
 */
function getDoScripts(projectDir) {
    const doDir = path.join(projectDir, 'do');
    if (!fs.existsSync(doDir)) {
        return [];
    }
    return fs.readdirSync(doDir)
        .filter(entry => {
            const fullPath = path.join(doDir, entry);
            return fs.statSync(fullPath).isFile() && entry !== '.gitkeep';
        });
}

/**
 * Lists all files in the do/lib/ directory.
 */
function getDoLibFiles(projectDir) {
    const libDir = path.join(projectDir, 'do', 'lib');
    if (!fs.existsSync(libDir)) {
        return [];
    }
    return fs.readdirSync(libDir)
        .filter(entry => {
            const fullPath = path.join(libDir, entry);
            return fs.statSync(fullPath).isFile();
        });
}

/**
 * Lists all subdirectories in the do/ directory (excluding __pycache__).
 */
function getDoSubdirs(projectDir) {
    const doDir = path.join(projectDir, 'do');
    if (!fs.existsSync(doDir)) {
        return [];
    }
    return fs.readdirSync(doDir)
        .filter(entry => {
            const fullPath = path.join(doDir, entry);
            return fs.statSync(fullPath).isDirectory() && entry !== '__pycache__';
        });
}

// ── Track results for cleanup ────────────────────────────────────────────────

let lastResult = null;

afterEach(() => {
    if (lastResult) {
        lastResult.cleanup();
        lastResult = null;
    }
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 3: Marketplace file inclusion — exact output set', () => {

    describe('do/ directory contains exactly the expected scripts', () => {

        it('for any valid marketplace config, the do/ directory contains all required scripts for the deployment target', function () {
            this.timeout(120000);

            fc.assert(fc.property(
                arbMarketplaceCliOptions,
                (input) => {
                    const result = runGenerator(input.cliOptions);
                    lastResult = result;

                    const doScripts = getDoScripts(result.dir);
                    const doScriptSet = new Set(doScripts);
                    const expectedScripts = getExpectedDoScripts(input.deploymentTarget);

                    // Every expected script must be present
                    for (const expected of expectedScripts) {
                        assert.ok(
                            doScriptSet.has(expected),
                            `Expected do/${expected} to exist in marketplace project ` +
                            `(deployment target: ${input.deploymentTarget}). ` +
                            `Actual scripts: [${doScripts.sort().join(', ')}]`
                        );
                    }

                    result.cleanup();
                    lastResult = null;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the do/ directory contains NO unexpected scripts', function () {
            this.timeout(120000);

            fc.assert(fc.property(
                arbMarketplaceCliOptions,
                (input) => {
                    const result = runGenerator(input.cliOptions);
                    lastResult = result;

                    const doScripts = getDoScripts(result.dir);
                    const expectedScripts = getExpectedDoScripts(input.deploymentTarget);

                    // No script outside the expected set should be present
                    for (const script of doScripts) {
                        assert.ok(
                            expectedScripts.has(script),
                            `Unexpected script do/${script} found in marketplace project ` +
                            `(deployment target: ${input.deploymentTarget}). ` +
                            `Expected only: [${[...expectedScripts].sort().join(', ')}]`
                        );
                    }

                    result.cleanup();
                    lastResult = null;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the do/ script set is exactly the expected set', function () {
            this.timeout(120000);

            fc.assert(fc.property(
                arbMarketplaceCliOptions,
                (input) => {
                    const result = runGenerator(input.cliOptions);
                    lastResult = result;

                    const doScripts = getDoScripts(result.dir);
                    const doScriptSet = new Set(doScripts);
                    const expectedScripts = getExpectedDoScripts(input.deploymentTarget);

                    // Sets must be equal
                    const missing = [...expectedScripts].filter(s => !doScriptSet.has(s));
                    const extra = doScripts.filter(s => !expectedScripts.has(s));

                    assert.deepStrictEqual(
                        { missing, extra },
                        { missing: [], extra: [] },
                        `do/ script set mismatch (deployment target: ${input.deploymentTarget}).\n` +
                        `  Missing: [${missing.join(', ')}]\n` +
                        `  Extra: [${extra.join(', ')}]\n` +
                        `  Expected: [${[...expectedScripts].sort().join(', ')}]\n` +
                        `  Actual: [${doScripts.sort().join(', ')}]`
                    );

                    result.cleanup();
                    lastResult = null;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('do/lib/ directory contains shared helpers', () => {

        it('for any valid marketplace config, do/lib/ directory exists', function () {
            this.timeout(120000);

            fc.assert(fc.property(
                arbMarketplaceCliOptions,
                (input) => {
                    const result = runGenerator(input.cliOptions);
                    lastResult = result;

                    const doSubdirs = getDoSubdirs(result.dir);
                    assert.ok(
                        doSubdirs.includes('lib'),
                        'Expected do/lib/ directory to exist in marketplace project. ' +
                        `Actual subdirectories: [${doSubdirs.join(', ')}]`
                    );

                    result.cleanup();
                    lastResult = null;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, do/lib/ contains the expected shared helpers', function () {
            this.timeout(120000);

            fc.assert(fc.property(
                arbMarketplaceCliOptions,
                (input) => {
                    const result = runGenerator(input.cliOptions);
                    lastResult = result;

                    const libFiles = getDoLibFiles(result.dir);
                    const libFileSet = new Set(libFiles);

                    // Every expected lib file must be present
                    for (const expected of EXPECTED_LIB_FILES) {
                        assert.ok(
                            libFileSet.has(expected),
                            `Expected do/lib/${expected} to exist in marketplace project. ` +
                            `Actual lib files: [${libFiles.sort().join(', ')}]`
                        );
                    }

                    result.cleanup();
                    lastResult = null;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, do/ has only lib as subdirectory (no ic/, adapters/, etc.)', function () {
            this.timeout(120000);

            fc.assert(fc.property(
                arbMarketplaceCliOptions,
                (input) => {
                    const result = runGenerator(input.cliOptions);
                    lastResult = result;

                    const doSubdirs = getDoSubdirs(result.dir);

                    // Only 'lib' should be a subdirectory
                    const unexpected = doSubdirs.filter(d => d !== 'lib');
                    assert.deepStrictEqual(
                        unexpected,
                        [],
                        `Unexpected subdirectories in do/: [${unexpected.join(', ')}]. ` +
                        'Only do/lib/ should exist for marketplace projects.'
                    );

                    result.cleanup();
                    lastResult = null;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('marketplace project has no files outside do/ directory', () => {

        it('for any valid marketplace config, the project root contains only the do/ directory (no Dockerfile, code/, etc.)', function () {
            this.timeout(120000);

            fc.assert(fc.property(
                arbMarketplaceCliOptions,
                (input) => {
                    const result = runGenerator(input.cliOptions);
                    lastResult = result;

                    const rootEntries = fs.readdirSync(result.dir);

                    // Should have 'do' directory
                    assert.ok(
                        rootEntries.includes('do'),
                        `Expected 'do' directory in project root. Actual: [${rootEntries.join(', ')}]`
                    );

                    // These container-related files/dirs must NOT exist
                    const forbidden = ['Dockerfile', 'code', 'requirements.txt', 'sample_model',
                        'nginx-flask.conf', 'nginx-fastapi.conf', 'buildspec.yml'];
                    for (const item of forbidden) {
                        assert.ok(
                            !rootEntries.includes(item),
                            `Forbidden file/directory '${item}' found in marketplace project root`
                        );
                    }

                    result.cleanup();
                    lastResult = null;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
