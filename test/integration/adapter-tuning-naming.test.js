// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for adapter tuning-job-aware naming (Task 4 / US-4).
 *
 * Tests that:
 * - do/tune completion handler writes all three config levels (TUNE_OUTPUT_PATH_LATEST,
 *   TUNE_ADAPTER_PATH_<TECHNIQUE>, TUNE_ADAPTER_PATH_<TECHNIQUE>_<SLUG>)
 * - do/adapter --from-tune with compound key (e.g., sft-alpaca) resolves correctly
 * - Two tune completions (sft-alpaca, sft-openorca) write distinct config vars
 * - do/adapter list shows tuning metadata from conf files
 * - Dataset slug derivation is correct for hf:// and s3:// paths
 *
 * Feature: adapter-tuning-aware-naming
 * Validates: Requirements US-4 (AC-4.1 through AC-4.8)
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';
import {
    readConfigVar,
    persistCompletionState
} from '../../src/lib/tune-config-state.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Feature: adapter-tuning-aware-naming — US-4 integration tests', function () {
    this.timeout(120000);

    let result;
    let adapterScript;
    let tuneScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
            'enable-lora': true,
            'region': 'us-east-1',
            'instance-type': 'ml.g5.xlarge'
        });

        // Read the rendered scripts
        const adapterPath = result.file('do/adapter');
        adapterScript = fs.readFileSync(adapterPath, 'utf8');

        const tunePath = result.file('do/tune');
        tuneScript = fs.readFileSync(tunePath, 'utf8');
    });

    after(() => {
        if (result) result.cleanup();
    });

    // ── Helpers ──────────────────────────────────────────────────────────────

    function getAdapterAddSection() {
        const start = adapterScript.indexOf('_adapter_add()');
        const end = adapterScript.indexOf('\n_adapter_list()');
        if (start === -1) return adapterScript;
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

    function getAdapterListSection() {
        const start = adapterScript.indexOf('_adapter_list()');
        if (start === -1) return '';
        return adapterScript.substring(start);
    }

    // ── AC-4.1: Config tracks adapter paths per technique AND per named run ──

    describe('AC-4.1: Config tracks adapter paths at three levels', () => {

        it('do/tune script contains _derive_dataset_slug function', () => {
            assert.ok(
                tuneScript.includes('_derive_dataset_slug()'),
                'do/tune must define _derive_dataset_slug function'
            );
        });

        it('do/tune completion handler writes TUNE_ADAPTER_PATH_<TECHNIQUE>_<SLUG>', () => {
            assert.ok(
                tuneScript.includes('TUNE_ADAPTER_PATH_${technique_upper}_${slug_upper}'),
                'Must write dataset-slug-specific adapter path'
            );
        });

        it('persistCompletionState writes all three levels for lora with slug', () => {
            const tempDir = join(tmpdir(), `adapter-naming-test-${Date.now()}`);
            mkdirSync(tempDir, { recursive: true });
            const configPath = join(tempDir, 'config');
            writeFileSync(configPath, '#!/bin/bash\nexport PROJECT_NAME="test"\n');

            persistCompletionState(configPath, {
                technique: 'sft',
                trainingType: 'lora',
                artifactPath: 's3://bucket/tune/sft-alpaca/output/',
                outputType: 'adapter',
                datasetSlug: 'alpaca'
            });

            assert.strictEqual(
                readConfigVar(configPath, 'TUNE_OUTPUT_PATH_LATEST'),
                's3://bucket/tune/sft-alpaca/output/'
            );
            assert.strictEqual(
                readConfigVar(configPath, 'TUNE_ADAPTER_PATH_SFT'),
                's3://bucket/tune/sft-alpaca/output/'
            );
            assert.strictEqual(
                readConfigVar(configPath, 'TUNE_ADAPTER_PATH_SFT_ALPACA'),
                's3://bucket/tune/sft-alpaca/output/'
            );

            rmSync(tempDir, { recursive: true, force: true });
        });
    });

    // ── AC-4.2: Tune completion handler writes all three levels ───────────────

    describe('AC-4.2: Tune completion handler writes three levels', () => {

        it('writes TUNE_OUTPUT_PATH_LATEST in completion handler', () => {
            assert.ok(
                tuneScript.includes('_update_config_var "TUNE_OUTPUT_PATH_LATEST"'),
                'Must write TUNE_OUTPUT_PATH_LATEST'
            );
        });

        it('writes TUNE_ADAPTER_PATH_<TECHNIQUE> in completion handler', () => {
            assert.ok(
                tuneScript.includes('_update_config_var "TUNE_ADAPTER_PATH_${technique_upper}"'),
                'Must write TUNE_ADAPTER_PATH_<TECHNIQUE>'
            );
        });

        it('writes TUNE_ADAPTER_PATH_<TECHNIQUE>_<SLUG> in completion handler', () => {
            assert.ok(
                tuneScript.includes('_update_config_var "TUNE_ADAPTER_PATH_${technique_upper}_${slug_upper}"'),
                'Must write TUNE_ADAPTER_PATH_<TECHNIQUE>_<SLUG>'
            );
        });
    });

    // ── AC-4.3: --from-tune (no technique) uses TUNE_OUTPUT_PATH_LATEST ──────

    describe('AC-4.3: --from-tune (no technique) backward compat', () => {

        it('reads TUNE_OUTPUT_PATH_LATEST when no technique is specified', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_OUTPUT_PATH_LATEST'),
                'Must read TUNE_OUTPUT_PATH_LATEST from config'
            );
        });

        it('sets weights_uri from TUNE_OUTPUT_PATH_LATEST', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('weights_uri="${TUNE_OUTPUT_PATH_LATEST}"'),
                'Must set weights_uri from TUNE_OUTPUT_PATH_LATEST'
            );
        });
    });

    // ── AC-4.4: --from-tune <technique> uses TUNE_ADAPTER_PATH_<TECHNIQUE> ──

    describe('AC-4.4: --from-tune <technique> backward compat', () => {

        it('constructs TUNE_ADAPTER_PATH_<TECHNIQUE> variable name', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_ADAPTER_PATH_${technique_upper}'),
                'Must construct TUNE_ADAPTER_PATH_<TECHNIQUE> variable name'
            );
        });
    });

    // ── AC-4.5: --from-tune <technique>-<dataset> resolves compound key ──────

    describe('AC-4.5: --from-tune <technique>-<dataset> compound resolution', () => {

        it('detects hyphen in from_tune_technique for compound parsing', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('${from_tune_technique}" == *-*'),
                'Must detect hyphen for compound key parsing'
            );
        });

        it('splits technique and slug from compound argument', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('compound_technique="${from_tune_technique%%-*}"') &&
                addSection.includes('compound_slug="${from_tune_technique#*-}"'),
                'Must split compound argument into technique and slug'
            );
        });

        it('constructs TUNE_ADAPTER_PATH_<TECHNIQUE>_<SLUG> variable', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('TUNE_ADAPTER_PATH_${compound_technique_upper}_${compound_slug_upper}'),
                'Must construct compound config variable name'
            );
        });

        it('falls back to technique-only when compound key not found', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('not found, falling back to'),
                'Must fall back with warning when compound key missing'
            );
        });
    });

    // ── AC-4.7: Adapter list shows tuning metadata ──────────────────────────

    describe('AC-4.7: do/adapter list shows tuning metadata', () => {

        it('reads ADAPTER_TUNE_TECHNIQUE from conf files', () => {
            const listSection = getAdapterListSection();
            assert.ok(
                listSection.includes('ADAPTER_TUNE_TECHNIQUE'),
                'Must read ADAPTER_TUNE_TECHNIQUE from conf files'
            );
        });

        it('reads ADAPTER_TUNE_DATASET from conf files', () => {
            const listSection = getAdapterListSection();
            assert.ok(
                listSection.includes('ADAPTER_TUNE_DATASET'),
                'Must read ADAPTER_TUNE_DATASET from conf files'
            );
        });

        it('shows "(from tune: <technique> / <dataset>)" format', () => {
            const listSection = getAdapterListSection();
            assert.ok(
                listSection.includes('(tune: {a[') ||
                listSection.includes('tune:'),
                'Must show tune metadata in format "(tune: <technique> / <dataset>)"'
            );
        });

        it('shows tune info without dataset when only technique is available', () => {
            const listSection = getAdapterListSection();
            assert.ok(
                listSection.includes('if a[') &&
                listSection.includes('dataset'),
                'Must conditionally show dataset when only technique is present'
            );
        });
    });

    // ── AC-4.7: Adapter conf stores ADAPTER_TUNE_TECHNIQUE and ADAPTER_TUNE_DATASET ──

    describe('AC-4.7: Adapter conf stores tune metadata', () => {

        it('writes ADAPTER_TUNE_TECHNIQUE to conf file', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_TUNE_TECHNIQUE'),
                'Must write ADAPTER_TUNE_TECHNIQUE to conf file'
            );
        });

        it('writes ADAPTER_TUNE_DATASET to conf file', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('ADAPTER_TUNE_DATASET'),
                'Must write ADAPTER_TUNE_DATASET to conf file'
            );
        });

        it('extracts technique from compound --from-tune argument for metadata', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('tune_technique_meta="${from_tune_technique%%-*}"'),
                'Must extract technique part for metadata'
            );
        });

        it('extracts dataset from compound --from-tune argument for metadata', () => {
            const addSection = getAdapterAddSection();
            assert.ok(
                addSection.includes('tune_dataset_meta="${from_tune_technique#*-}"'),
                'Must extract dataset part for metadata'
            );
        });
    });

    // ── AC-4.8: Two tune jobs resolve to different S3 paths ─────────────────

    describe('AC-4.8: Two tune jobs with different datasets resolve correctly', () => {

        it('sft-alpaca and sft-openorca write distinct config vars', () => {
            const tempDir = join(tmpdir(), `adapter-naming-two-jobs-${Date.now()}`);
            mkdirSync(tempDir, { recursive: true });
            const configPath = join(tempDir, 'config');
            writeFileSync(configPath, '#!/bin/bash\nexport PROJECT_NAME="test"\n');

            // Simulate first tune completion: sft with alpaca
            persistCompletionState(configPath, {
                technique: 'sft',
                trainingType: 'lora',
                artifactPath: 's3://bucket/tune/sft-job-alpaca/output/',
                outputType: 'adapter',
                datasetSlug: 'alpaca'
            });

            // Simulate second tune completion: sft with openorca
            persistCompletionState(configPath, {
                technique: 'sft',
                trainingType: 'lora',
                artifactPath: 's3://bucket/tune/sft-job-openorca/output/',
                outputType: 'adapter',
                datasetSlug: 'openorca'
            });

            // Level 1: TUNE_OUTPUT_PATH_LATEST should be the last run
            assert.strictEqual(
                readConfigVar(configPath, 'TUNE_OUTPUT_PATH_LATEST'),
                's3://bucket/tune/sft-job-openorca/output/',
                'TUNE_OUTPUT_PATH_LATEST should be the most recent run'
            );

            // Level 2: TUNE_ADAPTER_PATH_SFT should be the last run (last write wins)
            assert.strictEqual(
                readConfigVar(configPath, 'TUNE_ADAPTER_PATH_SFT'),
                's3://bucket/tune/sft-job-openorca/output/',
                'TUNE_ADAPTER_PATH_SFT should be the most recent SFT run'
            );

            // Level 3: Both dataset-specific vars should exist with distinct paths
            assert.strictEqual(
                readConfigVar(configPath, 'TUNE_ADAPTER_PATH_SFT_ALPACA'),
                's3://bucket/tune/sft-job-alpaca/output/',
                'TUNE_ADAPTER_PATH_SFT_ALPACA should point to the alpaca run'
            );
            assert.strictEqual(
                readConfigVar(configPath, 'TUNE_ADAPTER_PATH_SFT_OPENORCA'),
                's3://bucket/tune/sft-job-openorca/output/',
                'TUNE_ADAPTER_PATH_SFT_OPENORCA should point to the openorca run'
            );

            // Verify they are different
            const alpacaPath = readConfigVar(configPath, 'TUNE_ADAPTER_PATH_SFT_ALPACA');
            const openorcaPath = readConfigVar(configPath, 'TUNE_ADAPTER_PATH_SFT_OPENORCA');
            assert.notStrictEqual(alpacaPath, openorcaPath,
                'sft-alpaca and sft-openorca must resolve to different paths'
            );

            rmSync(tempDir, { recursive: true, force: true });
        });

        it('--from-tune sft-alpaca resolves to TUNE_ADAPTER_PATH_SFT_ALPACA (script logic)', () => {
            const addSection = getAdapterAddSection();
            // Verify the compound resolution logic exists
            assert.ok(
                addSection.includes('compound_var="TUNE_ADAPTER_PATH_${compound_technique_upper}_${compound_slug_upper}"'),
                'Must construct the compound variable name for resolution'
            );
            assert.ok(
                addSection.includes('compound_path="${!compound_var:-}"'),
                'Must use indirect reference to read compound variable'
            );
            assert.ok(
                addSection.includes('weights_uri="${compound_path}"'),
                'Must set weights_uri from compound path when found'
            );
        });
    });

    // ── Dataset slug derivation tests ──────────────────────────────────────────

    describe('Dataset slug derivation in do/tune script', () => {

        it('handles hf:// format (extracts name after last /)', () => {
            assert.ok(
                tuneScript.includes('hf://*') || tuneScript.includes('hf://*"'),
                'Must handle hf:// prefix for slug derivation'
            );
            // Check that it strips org prefix
            assert.ok(
                tuneScript.includes('slug="${hf_path##*/}"'),
                'Must extract last component from HF path as slug'
            );
        });

        it('handles s3:// format (extracts filename without extension)', () => {
            assert.ok(
                tuneScript.includes('s3://*'),
                'Must handle s3:// prefix for slug derivation'
            );
            assert.ok(
                tuneScript.includes('slug="${filename%.*}"'),
                'Must strip extension from S3 filename'
            );
        });

        it('applies slugification rules (lowercase, strip non-alphanum)', () => {
            assert.ok(
                tuneScript.includes('tr \'[:upper:]\' \'[:lower:]\'') &&
                tuneScript.includes('sed \'s/[^a-z0-9-]//g\''),
                'Must apply lowercase and strip non-alphanumeric chars'
            );
        });

        it('truncates slug to 20 chars', () => {
            assert.ok(
                tuneScript.includes('slug="${slug:0:20}"'),
                'Must truncate slug to 20 characters'
            );
        });

        it('collapses consecutive hyphens', () => {
            assert.ok(
                tuneScript.includes('sed \'s/-\\{2,\\}/-/g\''),
                'Must collapse consecutive hyphens in slug'
            );
        });
    });
});
