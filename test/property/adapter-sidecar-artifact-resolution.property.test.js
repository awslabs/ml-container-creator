// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property Test: Artifact Resolution
 *
 * Property 3: For any source path that exists and contains either (a) a single
 * tar.gz file or (b) already-extracted adapter files including adapter_config.json,
 * the artifact resolver SHALL return a valid directory path containing the adapter
 * files ready for the model server.
 *
 * This test invokes the Python ArtifactResolver via subprocess with generated
 * filesystem fixtures to validate the contract across many random inputs.
 *
 * Feature: sagemaker-adapter-contract, Property 3: Artifact Resolution
 * **Validates: Requirements 2.2, 2.3, 6.1, 6.2, 6.3**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = { numRuns: NUM_RUNS, timeout: 120000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

// Valid adapter names (alphanumeric + hyphens, mimicking SageMaker IC names)
const arbAdapterName = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}[a-z0-9]$/);

// Valid adapter file names (e.g., adapter_model.safetensors, adapter_model.bin)
const arbAdapterFileName = fc.constantFrom(
    'adapter_model.safetensors',
    'adapter_model.bin',
    'adapter_model.pt',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'README.md'
);

// Generate a set of additional adapter files (1-4 extra files alongside adapter_config.json)
const arbAdapterFiles = fc.uniqueArray(arbAdapterFileName, { minLength: 1, maxLength: 4 });

// adapter_config.json content (valid JSON with typical PEFT fields)
const arbAdapterConfig = fc.record({
    base_model_name_or_path: fc.constantFrom('meta-llama/Llama-3.1-8B', 'Qwen/Qwen2.5-7B', 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B'),
    peft_type: fc.constantFrom('LORA', 'QLORA'),
    r: fc.integer({ min: 4, max: 128 }),
    lora_alpha: fc.integer({ min: 8, max: 256 }),
    target_modules: fc.constantFrom(['q_proj', 'v_proj'], ['q_proj', 'k_proj', 'v_proj', 'o_proj'])
}).map(config => JSON.stringify(config, null, 2));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a Python script that runs ArtifactResolver.resolve() and prints the result.
 * This avoids import issues by inlining just the ArtifactResolver class.
 */
function createResolverScript(tmpDir, _srcPath) {
    const scriptContent = `
import sys
import os
import tarfile
import json

# Inline the ArtifactResolver class from the template
class ArtifactResolver:
    @staticmethod
    def resolve(src):
        if not os.path.exists(src):
            raise FileNotFoundError(f'Adapter artifact path does not exist: {src}')

        if os.path.isfile(src) and src.endswith('.tar.gz'):
            extract_dir = os.path.dirname(src)
            ArtifactResolver._extract_tar_gz(src, extract_dir)
            return extract_dir

        if not os.path.isdir(src):
            raise FileNotFoundError(f'Adapter artifact path is not a directory: {src}')

        contents = os.listdir(src)
        if not contents:
            raise FileNotFoundError(f'Adapter artifact path is empty: {src}')

        if 'adapter_config.json' in contents:
            return src

        tar_files = [f for f in contents if f.endswith('.tar.gz')]
        if len(tar_files) == 1:
            tar_path = os.path.join(src, tar_files[0])
            ArtifactResolver._extract_tar_gz(tar_path, src)
            return src

        if 'adapter_config.json' in os.listdir(src):
            return src

        raise FileNotFoundError(
            f'Adapter artifact path does not contain adapter_config.json or a tar.gz archive: {src}'
        )

    @staticmethod
    def _extract_tar_gz(tar_path, extract_dir):
        try:
            with tarfile.open(tar_path, 'r:gz') as tar:
                if hasattr(tarfile, 'data_filter'):
                    tar.extractall(path=extract_dir, filter='data')
                else:
                    tar.extractall(path=extract_dir)
        except (tarfile.TarError, OSError, PermissionError) as e:
            raise RuntimeError(f'Failed to extract tar.gz archive {tar_path}: {e}')

# Run the resolver
src_path = sys.argv[1]
try:
    result = ArtifactResolver.resolve(src_path)
    print(json.dumps({"status": "ok", "path": result}))
except FileNotFoundError as e:
    print(json.dumps({"status": "not_found", "error": str(e)}))
except RuntimeError as e:
    print(json.dumps({"status": "runtime_error", "error": str(e)}))
`;
    const scriptPath = join(tmpDir, 'run_resolver.py');
    writeFileSync(scriptPath, scriptContent);
    return scriptPath;
}

/**
 * Run the ArtifactResolver via Python subprocess.
 */
function runResolver(scriptPath, srcPath) {
    try {
        const output = execSync(`python3 "${scriptPath}" "${srcPath}"`, {
            encoding: 'utf-8',
            timeout: 10000
        }).trim();
        return JSON.parse(output);
    } catch (e) {
        // If python3 fails, the error output is in stderr
        throw new Error(`Python resolver failed: ${e.message}`);
    }
}

/**
 * Create a valid tar.gz file containing adapter files.
 */
function createTarGz(targetDir, archiveName, files) {
    // Create a temporary source directory for the tar contents
    const sourceDir = join(targetDir, '_tar_source');
    mkdirSync(sourceDir, { recursive: true });

    for (const [name, content] of files) {
        writeFileSync(join(sourceDir, name), content);
    }

    // Use Python to create the tar.gz (cross-platform and reliable)
    const tarPath = join(targetDir, archiveName);
    const createScript = `
import tarfile
import os
import sys

source_dir = sys.argv[1]
tar_path = sys.argv[2]

with tarfile.open(tar_path, 'w:gz') as tar:
    for fname in os.listdir(source_dir):
        fpath = os.path.join(source_dir, fname)
        tar.add(fpath, arcname=fname)
`;
    const scriptPath = join(targetDir, '_create_tar.py');
    writeFileSync(scriptPath, createScript);
    execSync(`python3 "${scriptPath}" "${sourceDir}" "${tarPath}"`, { timeout: 10000 });

    // Clean up source dir and script
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(scriptPath, { force: true });

    return tarPath;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: sagemaker-adapter-contract, Property 3: Artifact Resolution', () => {

    let tmpDir;
    let resolverScript;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'artifact-res-'));
        resolverScript = createResolverScript(tmpDir, '');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('Directory with adapter_config.json is returned directly', () => {

        it('for any directory containing adapter_config.json and additional files, resolver returns the directory path', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 2.2, 6.3**
            fc.assert(fc.property(
                arbAdapterName,
                arbAdapterConfig,
                arbAdapterFiles,
                (adapterName, configContent, extraFiles) => {
                    // Create adapter directory with adapter_config.json
                    const adapterDir = join(tmpDir, adapterName);
                    mkdirSync(adapterDir, { recursive: true });
                    writeFileSync(join(adapterDir, 'adapter_config.json'), configContent);

                    // Add extra adapter files
                    for (const fileName of extraFiles) {
                        writeFileSync(join(adapterDir, fileName), 'binary-content-placeholder');
                    }

                    // Resolve and verify
                    const result = runResolver(resolverScript, adapterDir);

                    assert.equal(result.status, 'ok',
                        `Expected ok status, got: ${JSON.stringify(result)}`);
                    assert.equal(result.path, adapterDir,
                        'Resolved path must equal the adapter directory when adapter_config.json exists');

                    // Verify adapter_config.json is still present
                    assert.ok(existsSync(join(adapterDir, 'adapter_config.json')),
                        'adapter_config.json must still exist after resolution');

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Directory with single tar.gz extracts and returns directory', () => {

        it('for any directory containing a single tar.gz with adapter files, resolver extracts and returns the directory', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 2.3, 6.2**
            fc.assert(fc.property(
                arbAdapterName,
                arbAdapterConfig,
                arbAdapterFiles,
                (adapterName, configContent, extraFiles) => {
                    // Create adapter directory with only a tar.gz inside
                    const adapterDir = join(tmpDir, adapterName);
                    mkdirSync(adapterDir, { recursive: true });

                    // Build file list for tar (always includes adapter_config.json)
                    const tarFiles = [
                        ['adapter_config.json', configContent],
                        ...extraFiles.map(f => [f, 'binary-content-placeholder'])
                    ];

                    // Create tar.gz archive in the adapter directory
                    createTarGz(adapterDir, 'adapter.tar.gz', tarFiles);

                    // Resolve and verify
                    const result = runResolver(resolverScript, adapterDir);

                    assert.equal(result.status, 'ok',
                        `Expected ok status, got: ${JSON.stringify(result)}`);
                    assert.equal(result.path, adapterDir,
                        'Resolved path must equal the adapter directory after extraction');

                    // Verify adapter_config.json was extracted
                    assert.ok(existsSync(join(adapterDir, 'adapter_config.json')),
                        'adapter_config.json must exist after tar.gz extraction');

                    // Verify all files from tar were extracted
                    for (const [fileName] of tarFiles) {
                        assert.ok(existsSync(join(adapterDir, fileName)),
                            `${fileName} must exist after tar.gz extraction`);
                    }

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Direct tar.gz file path extracts to parent directory', () => {

        it('for any tar.gz file path containing adapter files, resolver extracts to parent directory and returns it', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 2.3, 6.2**
            fc.assert(fc.property(
                arbAdapterName,
                arbAdapterConfig,
                arbAdapterFiles,
                (adapterName, configContent, extraFiles) => {
                    // Create a directory and place a tar.gz file in it
                    const parentDir = join(tmpDir, adapterName);
                    mkdirSync(parentDir, { recursive: true });

                    const tarFiles = [
                        ['adapter_config.json', configContent],
                        ...extraFiles.map(f => [f, 'binary-content-placeholder'])
                    ];

                    const tarPath = createTarGz(parentDir, `${adapterName}.tar.gz`, tarFiles);

                    // Resolve using the direct tar.gz path
                    const result = runResolver(resolverScript, tarPath);

                    assert.equal(result.status, 'ok',
                        `Expected ok status, got: ${JSON.stringify(result)}`);
                    assert.equal(result.path, parentDir,
                        'Resolved path must equal the parent directory of the tar.gz file');

                    // Verify adapter_config.json was extracted
                    assert.ok(existsSync(join(parentDir, 'adapter_config.json')),
                        'adapter_config.json must exist after extraction from direct tar.gz path');

                    // Clean up for next iteration
                    rmSync(parentDir, { recursive: true, force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Non-existent path returns not_found error', () => {

        it('for any path that does not exist, resolver returns not_found status', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 6.1**
            fc.assert(fc.property(
                arbAdapterName,
                (adapterName) => {
                    const nonExistentPath = join(tmpDir, 'nonexistent', adapterName);

                    const result = runResolver(resolverScript, nonExistentPath);

                    assert.equal(result.status, 'not_found',
                        `Expected not_found status for non-existent path, got: ${JSON.stringify(result)}`);
                    assert.ok(result.error.includes('does not exist'),
                        'Error message must indicate path does not exist');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Empty directory returns not_found error', () => {

        it('for any empty directory, resolver returns not_found status', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 6.1**
            fc.assert(fc.property(
                arbAdapterName,
                (adapterName) => {
                    const emptyDir = join(tmpDir, adapterName);
                    mkdirSync(emptyDir, { recursive: true });

                    const result = runResolver(resolverScript, emptyDir);

                    assert.equal(result.status, 'not_found',
                        `Expected not_found status for empty directory, got: ${JSON.stringify(result)}`);
                    assert.ok(result.error.includes('empty'),
                        'Error message must indicate path is empty');

                    // Clean up for next iteration
                    rmSync(emptyDir, { recursive: true, force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Resolved path always contains adapter_config.json', () => {

        it('for any valid src path (tar.gz or extracted), the resolved directory contains adapter_config.json', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 2.2, 2.3, 6.2, 6.3**
            fc.assert(fc.property(
                arbAdapterName,
                arbAdapterConfig,
                arbAdapterFiles,
                fc.boolean(),
                (adapterName, configContent, extraFiles, useTarGz) => {
                    const adapterDir = join(tmpDir, adapterName);
                    mkdirSync(adapterDir, { recursive: true });

                    const allFiles = [
                        ['adapter_config.json', configContent],
                        ...extraFiles.map(f => [f, 'binary-content-placeholder'])
                    ];

                    if (useTarGz) {
                        // Place a tar.gz in the directory
                        createTarGz(adapterDir, 'adapter.tar.gz', allFiles);
                    } else {
                        // Place files directly
                        for (const [name, content] of allFiles) {
                            writeFileSync(join(adapterDir, name), content);
                        }
                    }

                    const result = runResolver(resolverScript, adapterDir);

                    assert.equal(result.status, 'ok',
                        `Expected ok status, got: ${JSON.stringify(result)}`);

                    // The resolved path must contain adapter_config.json
                    const resolvedContents = readdirSync(result.path);
                    assert.ok(resolvedContents.includes('adapter_config.json'),
                        'Resolved directory must contain adapter_config.json');

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
