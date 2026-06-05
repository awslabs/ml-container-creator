// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property Test: Tar.gz Packaging Integrity
 *
 * Property 9: For any adapter directory containing `adapter_config.json` and
 * additional adapter files, the `do/adapter add --from-tune` packaging step
 * SHALL produce a tar.gz archive with flat structure (no nested subdirectories)
 * containing all original files.
 *
 * This test generates random adapter directories with various files, creates
 * tar.gz archives using the same packaging approach as the do/adapter template
 * (tar -czf ... -C <dir> .), then inspects the resulting archives to verify:
 * 1. The archive is a valid tar.gz
 * 2. The archive has flat structure (no subdirectories in the archive)
 * 3. All original files are present in the archive
 * 4. adapter_config.json is always included
 *
 * Feature: sagemaker-adapter-contract, Property 9: Tar.gz Packaging Integrity
 * **Validates: Requirements 9.1, 9.3, 9.4**
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) };

// ── Generators ───────────────────────────────────────────────────────────────

// Valid adapter file names (realistic adapter artifacts)
const arbAdapterFileName = fc.constantFrom(
    'adapter_model.safetensors',
    'adapter_model.bin',
    'adapter_model.pt',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer.model',
    'README.md',
    'training_args.bin'
);

// Generate a set of additional adapter files (1-5 extra files alongside adapter_config.json)
const arbAdapterFiles = fc.uniqueArray(arbAdapterFileName, { minLength: 1, maxLength: 5 });

// adapter_config.json content (valid JSON with typical PEFT fields)
const arbAdapterConfig = fc.record({
    base_model_name_or_path: fc.constantFrom(
        'meta-llama/Llama-3.1-8B',
        'Qwen/Qwen2.5-7B',
        'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
        'mistralai/Mistral-7B-v0.1'
    ),
    peft_type: fc.constantFrom('LORA', 'QLORA'),
    r: fc.integer({ min: 4, max: 128 }),
    lora_alpha: fc.integer({ min: 8, max: 256 }),
    target_modules: fc.constantFrom(
        ['q_proj', 'v_proj'],
        ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
        ['gate_proj', 'up_proj', 'down_proj']
    )
}).map(config => JSON.stringify(config, null, 2));

// Generate file content of various sizes (simulating real adapter weight files)
const arbFileContent = fc.oneof(
    fc.constant('binary-content-placeholder'),
    fc.string({ minLength: 10, maxLength: 200 }),
    fc.constant('{"key": "value"}')
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a tar.gz archive from a directory using the same approach as
 * the do/adapter template: tar -czf <output> -C <source_dir> .
 *
 * This replicates the flat packaging behavior exactly.
 * COPYFILE_DISABLE=1 prevents macOS from including ._AppleDouble metadata files.
 */
function createFlatTarGz(sourceDir, outputPath) {
    execSync(`tar -czf "${outputPath}" -C "${sourceDir}" .`, {
        timeout: 10000,
        env: { ...process.env, COPYFILE_DISABLE: '1' }
    });
}

/**
 * Inspect a tar.gz archive using Python's tarfile module.
 * Returns a JSON object with archive contents and metadata.
 */
function inspectTarGz(archivePath, tmpDir) {
    const scriptContent = `
import tarfile
import json
import sys
import os

archive_path = sys.argv[1]

try:
    with tarfile.open(archive_path, 'r:gz') as tar:
        members = tar.getmembers()
        result = {
            "valid": True,
            "files": [],
            "dirs": [],
            "has_nested_dirs": False,
            "error": None
        }
        for member in members:
            name = member.name
            # Normalize: strip leading ./ if present
            if name.startswith('./'):
                name = name[2:]
            # Skip the root '.' entry
            if name == '' or name == '.':
                continue
            if member.isdir():
                result["dirs"].append(name)
                result["has_nested_dirs"] = True
            else:
                result["files"].append(name)
                # Check if there's a path separator indicating nesting
                if '/' in name:
                    result["has_nested_dirs"] = True
        print(json.dumps(result))
except Exception as e:
    print(json.dumps({"valid": False, "files": [], "dirs": [], "has_nested_dirs": False, "error": str(e)}))
`;
    const scriptPath = join(tmpDir, '_inspect_tar.py');
    writeFileSync(scriptPath, scriptContent);

    const output = execSync(`python3 "${scriptPath}" "${archivePath}"`, {
        encoding: 'utf-8',
        timeout: 10000
    }).trim();

    return JSON.parse(output);
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: sagemaker-adapter-contract, Property 9: Tar.gz Packaging Integrity', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tar-pkg-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('Archive is a valid tar.gz', () => {

        it('for any adapter directory with adapter_config.json, packaging produces a valid tar.gz', { timeout: 120000 }, () => {
            // **Validates: Requirements 9.1**
            fc.assert(fc.property(
                arbAdapterConfig,
                arbAdapterFiles,
                arbFileContent,
                (configContent, extraFiles, fileContent) => {
                    // Create adapter directory with adapter_config.json and extra files
                    const adapterDir = join(tmpDir, 'adapter_files');
                    mkdirSync(adapterDir, { recursive: true });
                    writeFileSync(join(adapterDir, 'adapter_config.json'), configContent);

                    for (const fileName of extraFiles) {
                        writeFileSync(join(adapterDir, fileName), fileContent);
                    }

                    // Create tar.gz using same approach as do/adapter template
                    const archivePath = join(tmpDir, 'adapter.tar.gz');
                    createFlatTarGz(adapterDir, archivePath);

                    // Inspect the archive
                    const result = inspectTarGz(archivePath, tmpDir);

                    assert.ok(result.valid,
                        `Archive must be a valid tar.gz, got error: ${result.error}`);

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                    rmSync(archivePath, { force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('Archive has flat structure (no nested subdirectories)', () => {

        it('for any adapter directory, the tar.gz archive has no nested subdirectories', { timeout: 120000 }, () => {
            // **Validates: Requirements 9.4**
            fc.assert(fc.property(
                arbAdapterConfig,
                arbAdapterFiles,
                arbFileContent,
                (configContent, extraFiles, fileContent) => {
                    // Create adapter directory
                    const adapterDir = join(tmpDir, 'adapter_files');
                    mkdirSync(adapterDir, { recursive: true });
                    writeFileSync(join(adapterDir, 'adapter_config.json'), configContent);

                    for (const fileName of extraFiles) {
                        writeFileSync(join(adapterDir, fileName), fileContent);
                    }

                    // Create tar.gz
                    const archivePath = join(tmpDir, 'adapter.tar.gz');
                    createFlatTarGz(adapterDir, archivePath);

                    // Inspect the archive
                    const result = inspectTarGz(archivePath, tmpDir);

                    assert.ok(result.valid, 'Archive must be valid tar.gz');
                    assert.equal(result.has_nested_dirs, false,
                        'Archive must have flat structure (no nested subdirectories). ' +
                        `Found dirs: [${result.dirs.join(', ')}], ` +
                        `files with paths: [${result.files.filter(f => f.includes('/')).join(', ')}]`);

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                    rmSync(archivePath, { force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('Archive contains all original files', () => {

        it('for any adapter directory, all original files are present in the archive', { timeout: 120000 }, () => {
            // **Validates: Requirements 9.3**
            fc.assert(fc.property(
                arbAdapterConfig,
                arbAdapterFiles,
                arbFileContent,
                (configContent, extraFiles, fileContent) => {
                    // Create adapter directory
                    const adapterDir = join(tmpDir, 'adapter_files');
                    mkdirSync(adapterDir, { recursive: true });
                    writeFileSync(join(adapterDir, 'adapter_config.json'), configContent);

                    for (const fileName of extraFiles) {
                        writeFileSync(join(adapterDir, fileName), fileContent);
                    }

                    // Expected files = adapter_config.json + extra files
                    const expectedFiles = ['adapter_config.json', ...extraFiles].sort();

                    // Create tar.gz
                    const archivePath = join(tmpDir, 'adapter.tar.gz');
                    createFlatTarGz(adapterDir, archivePath);

                    // Inspect the archive
                    const result = inspectTarGz(archivePath, tmpDir);

                    assert.ok(result.valid, 'Archive must be valid tar.gz');

                    const archiveFiles = result.files.sort();
                    assert.deepEqual(archiveFiles, expectedFiles,
                        'Archive must contain all original files. ' +
                        `Expected: [${expectedFiles.join(', ')}], ` +
                        `Got: [${archiveFiles.join(', ')}]`);

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                    rmSync(archivePath, { force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('adapter_config.json is always included in the archive', () => {

        it('for any adapter directory with adapter_config.json, the archive always contains it', { timeout: 120000 }, () => {
            // **Validates: Requirements 9.1, 9.3**
            fc.assert(fc.property(
                arbAdapterConfig,
                arbAdapterFiles,
                arbFileContent,
                (configContent, extraFiles, fileContent) => {
                    // Create adapter directory
                    const adapterDir = join(tmpDir, 'adapter_files');
                    mkdirSync(adapterDir, { recursive: true });
                    writeFileSync(join(adapterDir, 'adapter_config.json'), configContent);

                    for (const fileName of extraFiles) {
                        writeFileSync(join(adapterDir, fileName), fileContent);
                    }

                    // Create tar.gz
                    const archivePath = join(tmpDir, 'adapter.tar.gz');
                    createFlatTarGz(adapterDir, archivePath);

                    // Inspect the archive
                    const result = inspectTarGz(archivePath, tmpDir);

                    assert.ok(result.valid, 'Archive must be valid tar.gz');
                    assert.ok(result.files.includes('adapter_config.json'),
                        'Archive must always contain adapter_config.json. ' +
                        `Archive files: [${result.files.join(', ')}]`);

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                    rmSync(archivePath, { force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('Flattening removes nested subdirectories before packaging', () => {

        it('for any adapter directory with nested subdirs, flattening + packaging produces flat archive with all files', { timeout: 120000 }, () => {
            // **Validates: Requirements 9.4**
            // This tests the flattening logic that the do/adapter template applies
            // before creating the tar.gz (find -mindepth 2 -type f -exec mv {} ... ;)
            fc.assert(fc.property(
                arbAdapterConfig,
                arbAdapterFiles,
                arbFileContent,
                (configContent, extraFiles, fileContent) => {
                    // Create adapter directory with nested structure (simulating raw tune output)
                    const adapterDir = join(tmpDir, 'adapter_files');
                    const nestedDir = join(adapterDir, 'checkpoints', 'hf');
                    mkdirSync(nestedDir, { recursive: true });

                    // Place files in nested location
                    writeFileSync(join(nestedDir, 'adapter_config.json'), configContent);
                    for (const fileName of extraFiles) {
                        writeFileSync(join(nestedDir, fileName), fileContent);
                    }

                    // Apply flattening logic (same as do/adapter template):
                    // find ... -mindepth 2 -type f -exec mv {} <dir>/ ;
                    // find ... -mindepth 1 -type d -exec rm -rf {} +
                    execSync(
                        `find "${adapterDir}" -mindepth 2 -type f -exec mv {} "${adapterDir}/" \\;`,
                        { timeout: 5000 }
                    );
                    execSync(
                        `find "${adapterDir}" -mindepth 1 -type d -exec rm -rf {} + 2>/dev/null || true`,
                        { timeout: 5000 }
                    );

                    // Create tar.gz from flattened directory
                    const archivePath = join(tmpDir, 'adapter.tar.gz');
                    createFlatTarGz(adapterDir, archivePath);

                    // Inspect the archive
                    const result = inspectTarGz(archivePath, tmpDir);

                    assert.ok(result.valid, 'Archive must be valid tar.gz');
                    assert.equal(result.has_nested_dirs, false,
                        'Archive must be flat after flattening nested structure');
                    assert.ok(result.files.includes('adapter_config.json'),
                        'adapter_config.json must be present after flattening');

                    // Verify all expected files are present
                    const expectedFiles = ['adapter_config.json', ...extraFiles].sort();
                    const archiveFiles = result.files.sort();
                    assert.deepEqual(archiveFiles, expectedFiles,
                        'All files must be preserved after flattening');

                    // Clean up for next iteration
                    rmSync(adapterDir, { recursive: true, force: true });
                    rmSync(archivePath, { force: true });
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });
});
