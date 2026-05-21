// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Config Parsing Property-Based Tests
 *
 * Property 8: YAML config parsing extracts all supported fields
 *
 * For any valid YAML configuration file containing all supported fields
 * (image, script, instance_type, instance_count, dataset, output_path,
 * hyperparameters, max_runtime_seconds, volume_size_gb, enable_spot),
 * the parser SHALL extract each field with its correct value and type.
 *
 * Feature: fine-tuning-training, Property 8: YAML config parsing extracts all supported fields
 * Validates: Requirements 2.1–2.11
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'node:assert';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

import { parseTrainingConfig, parseTrainingConfigFromString } from '../../src/lib/train-config-parser.js';

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid ECR image URI.
 * Pattern: <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>
 */
const accountIdArb = fc.stringMatching(/^[0-9]{12}$/);
const regionArb = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);
const repoNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);
const tagArb = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,10}$/);

const imageUriArb = fc.tuple(accountIdArb, regionArb, repoNameArb, tagArb)
    .map(([account, region, repo, tag]) =>
        `${account}.dkr.ecr.${region}.amazonaws.com/${repo}:${tag}`
    );

/**
 * Generate a valid S3 path for training scripts.
 */
const s3BucketArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,20}$/);
const s3KeyArb = fc.stringMatching(/^[a-z0-9][a-z0-9/_-]{2,30}$/);

const scriptPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/${key}/train.py`);

/**
 * Generate a valid SageMaker instance type.
 */
const instanceTypeArb = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.m5.4xlarge',
    'ml.g4dn.xlarge', 'ml.g4dn.2xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge',
    'ml.p3.2xlarge', 'ml.p4d.24xlarge'
);

/**
 * Generate a valid instance count (1-8).
 */
const instanceCountArb = fc.integer({ min: 1, max: 8 });

/**
 * Generate a valid S3 dataset path.
 */
const datasetPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/${key}/`);

/**
 * Generate a valid S3 output path.
 */
const outputPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/output/${key}/`);

/**
 * Generate valid hyperparameters (string key-value map).
 * We use fc.record-style generation to produce a plain object (not null-prototype).
 */
const hyperparamKeyArb = fc.stringMatching(/^[a-z][a-z0-9_]{1,15}$/);
const hyperparamValueArb = fc.oneof(
    fc.integer({ min: 1, max: 10000 }).map(String),
    fc.float({ min: Math.fround(0.0001), max: Math.fround(1.0), noNaN: true }).map(v => v.toFixed(4)),
    fc.constantFrom('adam', 'sgd', 'cosine', 'linear')
);

const hyperparametersArb = fc.array(
    fc.tuple(hyperparamKeyArb, hyperparamValueArb),
    { minLength: 0, maxLength: 5 }
).map(pairs => {
    const obj = {};
    for (const [k, v] of pairs) {
        obj[k] = v;
    }
    return obj;
});

/**
 * Generate a valid max_runtime_seconds (1 hour to 5 days).
 */
const maxRuntimeArb = fc.integer({ min: 3600, max: 432000 });

/**
 * Generate a valid volume_size_gb (10-500).
 */
const volumeSizeArb = fc.integer({ min: 10, max: 500 });

/**
 * Generate enable_spot boolean.
 */
const enableSpotArb = fc.boolean();

/**
 * Generate a valid checkpoint path (S3 URI).
 */
const checkpointPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/checkpoints/${key}/`);

/**
 * Generate a valid max_wait_seconds (must be >= max_runtime_seconds).
 */
const maxWaitArb = fc.integer({ min: 7200, max: 864000 });

/**
 * Generate a complete valid training config object with all supported fields.
 */
const fullConfigArb = fc.record({
    image: imageUriArb,
    script: scriptPathArb,
    instance_type: instanceTypeArb,
    instance_count: instanceCountArb,
    dataset: datasetPathArb,
    output_path: outputPathArb,
    hyperparameters: hyperparametersArb,
    max_runtime_seconds: maxRuntimeArb,
    volume_size_gb: volumeSizeArb,
    enable_spot: enableSpotArb,
    checkpoint_path: checkpointPathArb,
    max_wait_seconds: maxWaitArb
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempFiles = [];

function createTempConfigFile(configObj) {
    const tempDir = join(tmpdir(), `train-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    const configPath = join(tempDir, 'config.yaml');
    const yamlContent = yaml.dump(configObj, { lineWidth: -1 });
    writeFileSync(configPath, yamlContent, 'utf8');
    tempFiles.push(configPath);
    return configPath;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

afterEach(() => {
    for (const f of tempFiles) {
        try { unlinkSync(f); } catch (e) { /* ignore */ }
    }
    tempFiles.length = 0;
});

// ── Property 8: YAML config parsing extracts all supported fields ────────────

describe('Feature: fine-tuning-training, Property 8: YAML config parsing extracts all supported fields', () => {

    it('extracts image field correctly from any valid ECR URI', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.image, config.image,
                    `image must be "${config.image}", got "${parsed.image}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts script field correctly from any valid S3 path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.script, config.script,
                    `script must be "${config.script}", got "${parsed.script}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts instance_type field correctly', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.instance_type, config.instance_type,
                    `instance_type must be "${config.instance_type}", got "${parsed.instance_type}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts instance_count field correctly as string', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.instance_count, String(config.instance_count),
                    `instance_count must be "${config.instance_count}", got "${parsed.instance_count}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts dataset field correctly from any valid S3 path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.dataset, config.dataset,
                    `dataset must be "${config.dataset}", got "${parsed.dataset}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts output_path field correctly from any valid S3 path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.output_path, config.output_path,
                    `output_path must be "${config.output_path}", got "${parsed.output_path}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts hyperparameters as object with correct key-value pairs', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.deepStrictEqual(parsed.hyperparameters, config.hyperparameters,
                    `hyperparameters must match input. Expected: ${JSON.stringify(config.hyperparameters)}, got: ${JSON.stringify(parsed.hyperparameters)}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts max_runtime_seconds correctly as string', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.max_runtime_seconds, String(config.max_runtime_seconds),
                    `max_runtime_seconds must be "${config.max_runtime_seconds}", got "${parsed.max_runtime_seconds}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts volume_size_gb correctly as string', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.volume_size_gb, String(config.volume_size_gb),
                    `volume_size_gb must be "${config.volume_size_gb}", got "${parsed.volume_size_gb}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts enable_spot correctly as "true" or "false" string', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                const expected = config.enable_spot ? 'true' : 'false';
                assert.strictEqual(parsed.enable_spot, expected,
                    `enable_spot must be "${expected}", got "${parsed.enable_spot}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts checkpoint_path correctly from any valid S3 path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                assert.strictEqual(parsed.checkpoint_path, config.checkpoint_path,
                    `checkpoint_path must be "${config.checkpoint_path}", got "${parsed.checkpoint_path}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('extracts all fields simultaneously from a single config', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                // Verify all scalar fields
                assert.strictEqual(parsed.image, config.image);
                assert.strictEqual(parsed.script, config.script);
                assert.strictEqual(parsed.instance_type, config.instance_type);
                assert.strictEqual(parsed.instance_count, String(config.instance_count));
                assert.strictEqual(parsed.dataset, config.dataset);
                assert.strictEqual(parsed.output_path, config.output_path);
                assert.strictEqual(parsed.max_runtime_seconds, String(config.max_runtime_seconds));
                assert.strictEqual(parsed.volume_size_gb, String(config.volume_size_gb));
                assert.strictEqual(parsed.enable_spot, config.enable_spot ? 'true' : 'false');
                assert.strictEqual(parsed.checkpoint_path, config.checkpoint_path);
                assert.strictEqual(parsed.max_wait_seconds, String(config.max_wait_seconds));

                // Verify complex fields
                assert.deepStrictEqual(parsed.hyperparameters, config.hyperparameters);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('parseTrainingConfigFromString produces same result as file-based parsing', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const yamlContent = yaml.dump(config, { lineWidth: -1 });
                const configPath = createTempConfigFile(config);

                const fromFile = parseTrainingConfig(configPath);
                const fromString = parseTrainingConfigFromString(yamlContent);

                assert.deepStrictEqual(fromFile, fromString,
                    'File-based and string-based parsing must produce identical results');
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('applies correct defaults when optional fields are missing', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            imageUriArb,
            scriptPathArb,
            instanceTypeArb,
            datasetPathArb,
            outputPathArb,
            (image, script, instanceType, dataset, outputPath) => {
                // Config with only required fields
                const minimalConfig = { image, script, instance_type: instanceType, dataset, output_path: outputPath };
                const configPath = createTempConfigFile(minimalConfig);
                const parsed = parseTrainingConfig(configPath);

                // Required fields extracted correctly
                assert.strictEqual(parsed.image, image);
                assert.strictEqual(parsed.script, script);
                assert.strictEqual(parsed.instance_type, instanceType);
                assert.strictEqual(parsed.dataset, dataset);
                assert.strictEqual(parsed.output_path, outputPath);

                // Optional fields get defaults
                assert.strictEqual(parsed.instance_count, '1');
                assert.strictEqual(parsed.max_runtime_seconds, '86400');
                assert.strictEqual(parsed.volume_size_gb, '50');
                assert.strictEqual(parsed.enable_spot, 'false');
                assert.strictEqual(parsed.max_wait_seconds, '172800');
                assert.strictEqual(parsed.checkpoint_path, '');
                assert.deepStrictEqual(parsed.hyperparameters, {});
                assert.deepStrictEqual(parsed.metric_definitions, []);
                assert.deepStrictEqual(parsed.environment, {});
                assert.deepStrictEqual(parsed.tags, {});
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('preserves hyperparameter values as strings through YAML roundtrip', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            fullConfigArb,
            (config) => {
                const configPath = createTempConfigFile(config);
                const parsed = parseTrainingConfig(configPath);

                // All hyperparameter values should be strings (matching bash behavior)
                for (const [key, value] of Object.entries(parsed.hyperparameters)) {
                    assert.strictEqual(typeof value, 'string',
                        `Hyperparameter "${key}" value must be a string, got ${typeof value}: ${value}`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
