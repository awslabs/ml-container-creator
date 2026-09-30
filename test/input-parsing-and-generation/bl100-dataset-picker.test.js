// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL100 — do/benchmark dataset picker (BYOD) template content.
 *
 * The corrected BL100 design (supersedes the Hub-import approach) adds a
 * `--dataset <name>` flag that resolves a registered dataset to its S3 URI via
 * the sidecar registry and passes it as the create-ai-workload-config
 * DatasetConfig parameter — a SIBLING of --ai-workload-configs, NOT a Hub import.
 *
 * These structural assertions guard the wiring that the functional bash test
 * (bl100-benchmark-dataset-construction.test.sh) does not reach: the flag, the
 * resolver reuse, the --dataset-config CLI arg, and the help text.
 *
 * Feature: BL100
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const benchmarkPath = path.join(__dirname, '../../templates/do/benchmark');
const content = readFileSync(benchmarkPath, 'utf8');

describe('BL100 — do/benchmark dataset picker (BYOD)', () => {
    describe('flag parsing', () => {
        it('parses a --dataset <name> flag into ARG_DATASET', () => {
            assert.match(content, /--dataset\)\s*shift;\s*ARG_DATASET="\$\{1:-\}";\s*shift/);
        });

        it('initializes ARG_DATASET to empty by default', () => {
            assert.match(content, /^ARG_DATASET=""/m);
        });

        it('propagates --dataset on multi-level concurrency reinvoke', () => {
            assert.match(content, /_REINVOKE_ARGS="\$\{_REINVOKE_ARGS\} --dataset \$\{ARG_DATASET\}"/);
        });
    });

    describe('resolution reuses the shared dataset registry helper', () => {
        it('calls the register_helper resolve-dataset subcommand (no duplicated lookup)', () => {
            assert.match(content, /\.register_helper\.py"\s+resolve-dataset/);
        });

        it('reads s3_uri and format from the resolver JSON', () => {
            assert.match(content, /BENCHMARK_DATASET_S3URI=.*get\('s3_uri'/);
            assert.match(content, /BENCHMARK_DATASET_FORMAT=.*get\('format'/);
        });

        it('supports @vN / @v1.2.3 version-pin syntax', () => {
            assert.match(content, /@v\(\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\$/);
            assert.match(content, /--version.*_DATASET_VERSION/);
        });

        it('errors clearly when the dataset cannot be resolved', () => {
            assert.match(content, /Could not resolve dataset/);
        });
    });

    describe('DatasetConfig construction (BL100 corrected design)', () => {
        it('builds a top-level DatasetConfig with an InputDataConfig channel', () => {
            assert.match(content, /DATASET_CONFIG_JSON=.*InputDataConfig/);
        });

        it('uses ChannelName "traffic" (matches AWS docs example)', () => {
            assert.match(content, /BENCHMARK_DATASET_CHANNEL:-traffic/);
            assert.match(content, /ChannelName.*traffic/);
        });

        it('points S3DataSource.S3Uri at the resolved dataset URI', () => {
            assert.match(content, /S3DataSource.*S3Uri.*BENCHMARK_DATASET_S3URI/);
        });

        it('passes --dataset-config as a SIBLING of --ai-workload-configs (not a replacement)', () => {
            // --ai-workload-configs must still be present unconditionally.
            assert.match(content, /--ai-workload-configs\s+"\$\{WORKLOAD_CONFIGS\}"/);
            // --dataset-config is added only when a dataset is set.
            assert.match(content, /_CREATE_WLC_ARGS\+=\(--dataset-config "\$\{DATASET_CONFIG_JSON\}"\)/);
        });

        it('only adds --dataset-config when DATASET_CONFIG_JSON is non-empty', () => {
            assert.match(content, /if \[ -n "\$\{DATASET_CONFIG_JSON\}" \]; then\s*\n\s*_CREATE_WLC_ARGS\+=\(--dataset-config/);
        });
    });

    describe('workload-spec params: BYOD vs synthetic mutual exclusivity', () => {
        it('sets custom_dataset_type and input_file from the dataset', () => {
            assert.match(content, /custom_dataset_type.*BENCHMARK_DATASET_FORMAT/);
            assert.match(content, /input_file.*BENCHMARK_DATASET_INPUT_FILE/);
        });

        it('emits synthetic token-mean params only in the non-dataset branch', () => {
            // The token-mean assignment lives in the else (synthetic) branch.
            assert.match(
                content,
                /else\s*\n\s*#[^\n]*[Ss]ynthetic[^\n]*\n\s*PARAMS_JSON="\$\{PARAMS_JSON\},\\"prompt_input_tokens_mean\\"/
            );
        });

        it('keeps concurrency/streaming/tokenizer in the shared base params', () => {
            assert.match(content, /PARAMS_JSON="\{\\"concurrency\\":\$\{BENCHMARK_CONCURRENCY\}/);
        });

        it('derives input_file under the channel mount path', () => {
            assert.match(content, /\/opt\/ml\/input\/data\/\$\{BENCHMARK_DATASET_CHANNEL\}/);
        });
    });

    describe('help text', () => {
        it('documents --dataset in the usage synopsis', () => {
            assert.match(content, /Usage:.*--workload <name> --dataset <name>/s);
        });

        it('has a "Custom dataset (BYOD)" section', () => {
            assert.match(content, /Custom dataset \(BYOD\)/);
        });

        it('references do/register dataset as the source of registered datasets', () => {
            assert.match(content, /do\/register dataset/);
        });

        it('lists --dataset among the options', () => {
            assert.match(content, /--dataset <name>\s+Use a registered dataset \(BYOD\)/);
        });
    });
});
