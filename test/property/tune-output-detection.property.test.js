// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Output Detection Property-Based Tests
 *
 * Property 14: Output type detection from training type
 *
 * For any completed job, if `training_type === 'lora'` then `output_type`
 * SHALL be `adapter`, and if `training_type === 'full-rank'` then
 * `output_type` SHALL be `full-model`.
 *
 * Feature: managed-model-customization, Property 14: Output type detection from training type
 * Validates: Requirements 8.3
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectOutputType } from '../../src/lib/tune-output-resolver.js';
import { persistCompletionState, readConfigVar } from '../../src/lib/tune-config-state.js';

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

const trainingTypeArb = fc.constantFrom('lora', 'full-rank');

// ── Property 14: Output type detection from training type ────────────────────

describe('Feature: managed-model-customization, Property 14: Output type detection from training type', () => {

    it('lora training type always produces adapter output type', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constant('lora'),
            (trainingType) => {
                const outputType = detectOutputType(trainingType);

                assert.strictEqual(outputType, 'adapter',
                    `detectOutputType("lora") must return "adapter", got "${outputType}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('full-rank training type always produces full-model output type', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constant('full-rank'),
            (trainingType) => {
                const outputType = detectOutputType(trainingType);

                assert.strictEqual(outputType, 'full-model',
                    `detectOutputType("full-rank") must return "full-model", got "${outputType}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('for any valid training type, output type is deterministic and correct', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            trainingTypeArb,
            (trainingType) => {
                const outputType = detectOutputType(trainingType);

                if (trainingType === 'lora') {
                    assert.strictEqual(outputType, 'adapter',
                        `detectOutputType("${trainingType}") must return "adapter", got "${outputType}"`);
                } else if (trainingType === 'full-rank') {
                    assert.strictEqual(outputType, 'full-model',
                        `detectOutputType("${trainingType}") must return "full-model", got "${outputType}"`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('output type is always one of the two valid values for valid training types', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            trainingTypeArb,
            (trainingType) => {
                const outputType = detectOutputType(trainingType);
                const validOutputTypes = ['adapter', 'full-model'];

                assert.ok(validOutputTypes.includes(outputType),
                    `detectOutputType("${trainingType}") must return one of ${JSON.stringify(validOutputTypes)}, got "${outputType}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('mapping is bijective: distinct training types produce distinct output types', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fc.constant(['lora', 'full-rank']),
            (trainingTypes) => {
                const outputTypes = trainingTypes.map(tt => detectOutputType(tt));

                // Verify the two training types map to different output types
                assert.notStrictEqual(outputTypes[0], outputTypes[1],
                    'Different training types must produce different output types. ' +
                    `"lora" → "${outputTypes[0]}", "full-rank" → "${outputTypes[1]}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});


// ── Generators for Property 15 ──────────────────────────────────────────────

const techniqueArb = fc.constantFrom('sft', 'dpo', 'rlaif', 'rlvr');
const trainingTypeArbP15 = fc.constantFrom('lora', 'full-rank');

const s3BucketArb = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const s3KeyArb = fc.array(
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/),
    { minLength: 1, maxLength: 4 }
).map(parts => parts.join('/'));

const artifactPathArb = fc.tuple(s3BucketArb, s3KeyArb).map(
    ([bucket, key]) => `s3://${bucket}/${key}/output/model.tar.gz`
);

// ── Property 15: Output state persistence after completion ───────────────────

/**
 * Feature: managed-model-customization, Property 15: Output state persistence after completion
 *
 * For any completed job with technique T and training type TT:
 * - If TT is 'lora', then TUNE_ADAPTER_PATH_<T> SHALL contain the artifact S3 path
 * - If TT is 'full-rank', then TUNE_MODEL_PATH_<T> SHALL contain the artifact S3 path
 * - TUNE_OUTPUT_PATH_LATEST SHALL equal the artifact path
 * - TUNE_OUTPUT_TYPE_LATEST SHALL equal the output type
 *
 * Validates: Requirements 8.4, 8.5, 8.6, 8.7
 */
describe('Feature: managed-model-customization, Property 15: Output state persistence after completion', () => {

    it('lora completion persists TUNE_ADAPTER_PATH_<T> with artifact path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            artifactPathArb,
            (technique, artifactPath) => {
                const tmpDir = mkdtempSync(join(tmpdir(), 'tune-p15-'));
                const configPath = join(tmpDir, 'config');
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                try {
                    const outputType = detectOutputType('lora');
                    persistCompletionState(configPath, {
                        technique,
                        trainingType: 'lora',
                        artifactPath,
                        outputType
                    });

                    const techniqueUpper = technique.toUpperCase();
                    const storedPath = readConfigVar(configPath, `TUNE_ADAPTER_PATH_${techniqueUpper}`);

                    assert.strictEqual(storedPath, artifactPath,
                        `TUNE_ADAPTER_PATH_${techniqueUpper} must equal artifact path. ` +
                        `Expected "${artifactPath}", got "${storedPath}"`);
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('full-rank completion persists TUNE_MODEL_PATH_<T> with artifact path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            artifactPathArb,
            (technique, artifactPath) => {
                const tmpDir = mkdtempSync(join(tmpdir(), 'tune-p15-'));
                const configPath = join(tmpDir, 'config');
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                try {
                    const outputType = detectOutputType('full-rank');
                    persistCompletionState(configPath, {
                        technique,
                        trainingType: 'full-rank',
                        artifactPath,
                        outputType
                    });

                    const techniqueUpper = technique.toUpperCase();
                    const storedPath = readConfigVar(configPath, `TUNE_MODEL_PATH_${techniqueUpper}`);

                    assert.strictEqual(storedPath, artifactPath,
                        `TUNE_MODEL_PATH_${techniqueUpper} must equal artifact path. ` +
                        `Expected "${artifactPath}", got "${storedPath}"`);
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('TUNE_OUTPUT_PATH_LATEST always equals the artifact path regardless of training type', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArbP15,
            artifactPathArb,
            (technique, trainingType, artifactPath) => {
                const tmpDir = mkdtempSync(join(tmpdir(), 'tune-p15-'));
                const configPath = join(tmpDir, 'config');
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                try {
                    const outputType = detectOutputType(trainingType);
                    persistCompletionState(configPath, {
                        technique,
                        trainingType,
                        artifactPath,
                        outputType
                    });

                    const latestPath = readConfigVar(configPath, 'TUNE_OUTPUT_PATH_LATEST');

                    assert.strictEqual(latestPath, artifactPath,
                        'TUNE_OUTPUT_PATH_LATEST must equal artifact path. ' +
                        `Expected "${artifactPath}", got "${latestPath}"`);
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('TUNE_OUTPUT_TYPE_LATEST equals the detected output type', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArbP15,
            artifactPathArb,
            (technique, trainingType, artifactPath) => {
                const tmpDir = mkdtempSync(join(tmpdir(), 'tune-p15-'));
                const configPath = join(tmpDir, 'config');
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                try {
                    const outputType = detectOutputType(trainingType);
                    persistCompletionState(configPath, {
                        technique,
                        trainingType,
                        artifactPath,
                        outputType
                    });

                    const storedType = readConfigVar(configPath, 'TUNE_OUTPUT_TYPE_LATEST');
                    const expectedType = trainingType === 'lora' ? 'adapter' : 'full-model';

                    assert.strictEqual(storedType, expectedType,
                        `TUNE_OUTPUT_TYPE_LATEST must equal "${expectedType}" for training type "${trainingType}". ` +
                        `Got "${storedType}"`);
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('lora does NOT write TUNE_MODEL_PATH and full-rank does NOT write TUNE_ADAPTER_PATH', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArb,
            trainingTypeArbP15,
            artifactPathArb,
            (technique, trainingType, artifactPath) => {
                const tmpDir = mkdtempSync(join(tmpdir(), 'tune-p15-'));
                const configPath = join(tmpDir, 'config');
                writeFileSync(configPath, '#!/bin/bash\n# do/config\n', 'utf8');

                try {
                    const outputType = detectOutputType(trainingType);
                    persistCompletionState(configPath, {
                        technique,
                        trainingType,
                        artifactPath,
                        outputType
                    });

                    const techniqueUpper = technique.toUpperCase();

                    if (trainingType === 'lora') {
                        const modelPath = readConfigVar(configPath, `TUNE_MODEL_PATH_${techniqueUpper}`);
                        assert.strictEqual(modelPath, null,
                            `TUNE_MODEL_PATH_${techniqueUpper} must NOT be set for lora training type`);
                    } else {
                        const adapterPath = readConfigVar(configPath, `TUNE_ADAPTER_PATH_${techniqueUpper}`);
                        assert.strictEqual(adapterPath, null,
                            `TUNE_ADAPTER_PATH_${techniqueUpper} must NOT be set for full-rank training type`);
                    }
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});


// ── Generators for Property 16 ──────────────────────────────────────────────

import { generateNextStepCommands } from '../../src/lib/tune-output-resolver.js';

const outputTypeArb = fc.constantFrom('adapter', 'full-model');
const techniqueArbP16 = fc.constantFrom('sft', 'dpo', 'rlaif', 'rlvr');

const s3BucketArbP16 = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const s3KeyArbP16 = fc.array(
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/),
    { minLength: 1, maxLength: 4 }
).map(parts => parts.join('/'));

const artifactPathArbP16 = fc.tuple(s3BucketArbP16, s3KeyArbP16).map(
    ([bucket, key]) => `s3://${bucket}/${key}/output/model.tar.gz`
);

// ── Property 16: Context-aware next-step commands ────────────────────────────

/**
 * Feature: managed-model-customization, Property 16: Context-aware next-step commands
 *
 * For any completed job, if `output_type === 'adapter'` then the displayed
 * next-step commands SHALL include `do/adapter add` with `--from-tune`;
 * if `output_type === 'full-model'` then the displayed next-step commands
 * SHALL include `do/add-ic` with `--from-tune`.
 *
 * Validates: Requirements 8.11
 */
describe('Feature: managed-model-customization, Property 16: Context-aware next-step commands', () => {

    it('adapter output type always includes do/adapter add with --from-tune', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArbP16,
            artifactPathArbP16,
            (technique, artifactPath) => {
                const commands = generateNextStepCommands('adapter', technique, artifactPath);

                const hasAdapterAdd = commands.some(cmd =>
                    cmd.includes('do/adapter add') && cmd.includes('--from-tune')
                );

                assert.ok(hasAdapterAdd,
                    'For adapter output type, at least one command must include "do/adapter add" AND "--from-tune". ' +
                    `Got commands: ${JSON.stringify(commands)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('full-model output type always includes do/add-ic with --from-tune', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArbP16,
            artifactPathArbP16,
            (technique, artifactPath) => {
                const commands = generateNextStepCommands('full-model', technique, artifactPath);

                const hasAddIc = commands.some(cmd =>
                    cmd.includes('do/add-ic') && cmd.includes('--from-tune')
                );

                assert.ok(hasAddIc,
                    'For full-model output type, at least one command must include "do/add-ic" AND "--from-tune". ' +
                    `Got commands: ${JSON.stringify(commands)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('adapter commands include the artifact path in at least one variant', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArbP16,
            artifactPathArbP16,
            (technique, artifactPath) => {
                const commands = generateNextStepCommands('adapter', technique, artifactPath);

                const hasArtifactPath = commands.some(cmd => cmd.includes(artifactPath));

                assert.ok(hasArtifactPath,
                    `For adapter output, at least one command must include the artifact path "${artifactPath}". ` +
                    `Got commands: ${JSON.stringify(commands)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('full-model commands include the artifact path in at least one variant', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArbP16,
            artifactPathArbP16,
            (technique, artifactPath) => {
                const commands = generateNextStepCommands('full-model', technique, artifactPath);

                const hasArtifactPath = commands.some(cmd => cmd.includes(artifactPath));

                assert.ok(hasArtifactPath,
                    `For full-model output, at least one command must include the artifact path "${artifactPath}". ` +
                    `Got commands: ${JSON.stringify(commands)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('adapter commands include the technique name', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            techniqueArbP16,
            artifactPathArbP16,
            (technique, artifactPath) => {
                const commands = generateNextStepCommands('adapter', technique, artifactPath);

                const hasTechnique = commands.some(cmd => cmd.includes(technique));

                assert.ok(hasTechnique,
                    `For adapter output, at least one command must include the technique name "${technique}". ` +
                    `Got commands: ${JSON.stringify(commands)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('for any output type, generateNextStepCommands returns a non-empty array', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputTypeArb,
            techniqueArbP16,
            artifactPathArbP16,
            (outputType, technique, artifactPath) => {
                const commands = generateNextStepCommands(outputType, technique, artifactPath);

                assert.ok(Array.isArray(commands) && commands.length > 0,
                    `generateNextStepCommands must return a non-empty array for output type "${outputType}". ` +
                    `Got: ${JSON.stringify(commands)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
