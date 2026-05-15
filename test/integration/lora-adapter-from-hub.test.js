// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for LoRA adapter --from-hub and search functionality.
 *
 * Tests that the rendered do/adapter script contains correct logic for:
 * - --from-hub downloads adapter files, creates tar.gz, uploads to S3
 * - --from-hub stores ADAPTER_SOURCE=hub and ADAPTER_HF_REPO in conf
 * - --from-hub with gated repo uses HF_TOKEN
 * - --from-hub with invalid repo ID returns clear error
 * - --weights and --from-hub together returns mutual exclusivity error
 * - search queries HF API with correct base_model filter
 * - search displays results table with repo ID, downloads, description
 * - search with no results shows helpful message
 * - search respects --limit flag
 * - base model mismatch in adapter_config.json produces warning (not error)
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 7.4
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: lora-adapter-lifecycle — --from-hub and search integration (Req 7.4)', function () {
    this.timeout(120000);

    let result;
    let adapterScript;

    before(() => {
        result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.2-3B-Instruct',
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

    // ── Helper to extract _download_from_hub section ─────────────────────

    function getDownloadFromHubSection() {
        const start = adapterScript.indexOf('_download_from_hub()');
        const end = adapterScript.indexOf('\n# ── Subcommand implementations');
        if (start === -1) {
            return adapterScript;
        }
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

    function getAddSection() {
        const start = adapterScript.indexOf('_adapter_add()');
        const end = adapterScript.indexOf('\n_adapter_list()');
        if (start === -1) {
            return adapterScript;
        }
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

    function getSearchSection() {
        const start = adapterScript.indexOf('_adapter_search()');
        const end = adapterScript.indexOf('\n# ── Main:');
        if (start === -1) {
            return adapterScript;
        }
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

    // ── --from-hub downloads adapter files, creates tar.gz, uploads to S3 ──

    describe('--from-hub downloads adapter files, creates tar.gz, uploads to S3', () => {

        it('defines _download_from_hub function', () => {
            assert.ok(
                adapterScript.includes('_download_from_hub()'),
                'Must define _download_from_hub function'
            );
        });

        it('downloads adapter files using huggingface-cli when available', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('huggingface-cli') && section.includes('download'),
                'Must use huggingface-cli download when available'
            );
        });

        it('falls back to curl when huggingface-cli is not available', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('curl') && section.includes('huggingface.co'),
                'Must fall back to curl for downloading'
            );
        });

        it('queries HF API to get file listing for curl fallback', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('https://huggingface.co/api/models/${hf_repo_id}'),
                'Must query HF API for file listing'
            );
        });

        it('downloads files from resolve/main endpoint', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('resolve/main'),
                'Must download files from resolve/main endpoint'
            );
        });

        it('validates adapter_config.json exists in downloaded files', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('adapter_config.json') &&
                section.includes('not found in downloaded files'),
                'Must validate adapter_config.json exists'
            );
        });

        it('creates tar.gz from downloaded files', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('tar -czf') && section.includes('adapter.tar.gz'),
                'Must create tar.gz from downloaded files'
            );
        });

        it('creates tar.gz with flat structure (no subdirectories)', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('-C "${tmp_dir}/adapter_files"'),
                'Must create tar.gz from adapter_files directory (flat)'
            );
        });

        it('uploads tar.gz to S3 using aws s3 cp', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('aws s3 cp') && section.includes('${s3_path}'),
                'Must upload tar.gz to S3'
            );
        });

        it('constructs S3 path with project name and adapter name', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('adapters/${PROJECT_NAME}/${adapter_name}/adapter.tar.gz'),
                'Must construct S3 path with project name and adapter name'
            );
        });

        it('resolves S3 bucket from ADAPTER_S3_BUCKET or account-based pattern', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('ADAPTER_S3_BUCKET') &&
                section.includes('mlcc-adapters-${account_id}-${AWS_REGION}'),
                'Must resolve S3 bucket from ADAPTER_S3_BUCKET or account pattern'
            );
        });

        it('sets weights_uri variable for the caller after upload', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('weights_uri="${s3_path}"'),
                'Must set weights_uri for the caller'
            );
        });

        it('cleans up temp directory after download', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('rm -rf "${tmp_dir}"'),
                'Must clean up temp directory'
            );
        });

        it('removes .huggingface metadata and hidden files', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('.huggingface') && section.includes('.cache'),
                'Must remove .huggingface metadata'
            );
        });

        it('skips subdirectory files (only root-level adapter files)', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('grep -q') && section.includes('/'),
                'Must skip files in subdirectories'
            );
        });
    });

    // ── --from-hub stores ADAPTER_SOURCE=hub and ADAPTER_HF_REPO in conf ──

    describe('--from-hub stores ADAPTER_SOURCE=hub and ADAPTER_HF_REPO in conf', () => {

        it('writes ADAPTER_SOURCE="hub" to conf when --from-hub is used', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('ADAPTER_SOURCE') && addSection.includes('"hub"'),
                'Must write ADAPTER_SOURCE="hub" to conf file'
            );
        });

        it('writes ADAPTER_HF_REPO with the repo ID to conf', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('ADAPTER_HF_REPO') && addSection.includes('${from_hub}'),
                'Must write ADAPTER_HF_REPO with repo ID to conf file'
            );
        });

        it('only adds hub metadata when --from-hub is used (not --weights)', () => {
            const addSection = getAddSection();
            // The hub metadata should be conditional on from_hub being non-empty
            assert.ok(
                addSection.includes('-n "${from_hub}"'),
                'Must conditionally add hub metadata only when --from-hub is used'
            );
        });

        it('uses export keyword for ADAPTER_SOURCE', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('export ADAPTER_SOURCE='),
                'Must use export for ADAPTER_SOURCE'
            );
        });

        it('uses export keyword for ADAPTER_HF_REPO', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('export ADAPTER_HF_REPO='),
                'Must use export for ADAPTER_HF_REPO'
            );
        });
    });

    // ── --from-hub with gated repo uses HF_TOKEN ─────────────────────────

    describe('--from-hub with gated repo uses HF_TOKEN', () => {

        it('passes HF_TOKEN to huggingface-cli via --token flag', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('--token') && section.includes('HF_TOKEN'),
                'Must pass HF_TOKEN to huggingface-cli'
            );
        });

        it('passes HF_TOKEN as Authorization Bearer header for curl', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('Authorization: Bearer ${HF_TOKEN}') ||
                section.includes('Authorization: Bearer $HF_TOKEN'),
                'Must pass HF_TOKEN as Bearer header for curl'
            );
        });

        it('checks if HF_TOKEN is set before adding auth header', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('HF_TOKEN:-'),
                'Must check if HF_TOKEN is set before using it'
            );
        });

        it('suggests setting HF_TOKEN in error message for gated repos', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('For gated repos, set HF_TOKEN environment variable'),
                'Must suggest HF_TOKEN in error message'
            );
        });
    });

    // ── --from-hub with invalid repo ID returns clear error ──────────────

    describe('--from-hub with invalid repo ID returns clear error', () => {

        it('validates HF repo ID format with regex', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('grep -qE') && addSection.includes('a-zA-Z0-9'),
                'Must validate HF repo ID format with regex'
            );
        });

        it('shows "Invalid HuggingFace repo ID" error for bad format', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('Invalid HuggingFace repo ID'),
                'Must show clear error for invalid repo ID'
            );
        });

        it('explains valid repo ID format in error message', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('org/name') || addSection.includes('\'org/name\''),
                'Must explain valid format (org/name or name)'
            );
        });

        it('shows examples of valid repo IDs', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('predibase/') || addSection.includes('my-adapter'),
                'Must show examples of valid repo IDs'
            );
        });

        it('shows error when repo does not exist on HuggingFace', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('Failed to') &&
                section.includes('HuggingFace Hub'),
                'Must show error when repo access fails'
            );
        });

        it('includes repo URL in error message for verification', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('https://huggingface.co/${hf_repo_id}'),
                'Must include repo URL for user verification'
            );
        });
    });

    // ── --weights and --from-hub together returns mutual exclusivity error ──

    describe('--weights and --from-hub together returns mutual exclusivity error', () => {

        it('checks for mutual exclusivity in add subcommand', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('--weights and --from-hub are mutually exclusive'),
                'Must show mutual exclusivity error in add'
            );
        });

        it('exits with error when both flags are provided', () => {
            const addSection = getAddSection();
            // Check that the mutual exclusivity check leads to exit 1
            const mutualCheck = addSection.substring(
                addSection.indexOf('--weights and --from-hub are mutually exclusive')
            );
            assert.ok(
                mutualCheck.includes('exit 1'),
                'Must exit with error code 1 when both flags provided'
            );
        });

        it('shows correct usage for both options separately', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('--weights <s3-uri>') &&
                addSection.includes('--from-hub <hf-repo-id>'),
                'Must show both options in usage hint'
            );
        });

        it('requires at least one of --weights or --from-hub', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('Either --weights or --from-hub is required'),
                'Must require at least one source option'
            );
        });
    });

    // ── search queries HF API with correct base_model filter ─────────────

    describe('search queries HF API with correct base_model filter', () => {

        it('calls HuggingFace API at huggingface.co/api/models', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('huggingface.co/api/models'),
                'search must call HuggingFace API'
            );
        });

        it('includes peft filter in API query', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('filter=peft'),
                'search must include peft filter'
            );
        });

        it('includes base_model:adapter filter with MODEL_NAME', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('base_model:adapter:'),
                'search must include base_model:adapter filter'
            );
        });

        it('sorts results by downloads in descending order', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('sort=downloads') &&
                searchSection.includes('direction=-1'),
                'search must sort by downloads descending'
            );
        });
    });

    // ── search displays results table with repo ID, downloads, description ──

    describe('search displays results table with repo ID, downloads, description', () => {

        it('displays table header with REPO ID column', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('REPO ID'),
                'search output must include REPO ID column header'
            );
        });

        it('displays table header with DOWNLOADS column', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('DOWNLOADS'),
                'search output must include DOWNLOADS column header'
            );
        });

        it('displays table header with DESCRIPTION column', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('DESCRIPTION'),
                'search output must include DESCRIPTION column header'
            );
        });

        it('shows hint to add adapter from search results', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('Add an adapter: ./do/adapter add <name> --from-hub <repo-id>'),
                'search must show hint to add adapter from results'
            );
        });
    });

    // ── search with no results shows helpful message ─────────────────────

    describe('search with no results shows helpful message', () => {

        it('shows "No adapters found" message when count is 0', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('No adapters found'),
                'search must show "No adapters found" when no results'
            );
        });

        it('suggests checking HuggingFace directly', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('https://huggingface.co/models'),
                'search must suggest checking HuggingFace directly'
            );
        });
    });

    // ── search respects --limit flag ─────────────────────────────────────

    describe('search respects --limit flag', () => {

        it('defaults limit to 10', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('local limit=10'),
                'search must default limit to 10'
            );
        });

        it('accepts --limit argument to override default', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('--limit)') &&
                searchSection.includes('limit="$2"'),
                'search must accept --limit argument'
            );
        });

        it('passes limit to API URL', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('limit=${limit}'),
                'search must pass limit to API URL'
            );
        });
    });

    // ── base model mismatch in adapter_config.json produces warning ──────

    describe('base model mismatch in adapter_config.json produces warning (not error)', () => {

        it('checks base_model_name_or_path in _download_from_hub', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('base_model_name_or_path'),
                'Must check base_model_name_or_path in downloaded adapter_config.json'
            );
        });

        it('compares adapter base model with MODEL_NAME', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('MODEL_NAME') &&
                section.includes('adapter_base_model'),
                'Must compare adapter base model with MODEL_NAME'
            );
        });

        it('produces warning (not error) on mismatch', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('⚠️') &&
                section.includes('Adapter was trained on') &&
                section.includes('Adapter may not work correctly'),
                'Must produce warning on base model mismatch'
            );
        });

        it('does not exit on base model mismatch (continues with add)', () => {
            const section = getDownloadFromHubSection();
            // Find the mismatch warning section and verify no exit follows
            const mismatchIdx = section.indexOf('Adapter may not work correctly');
            assert.ok(mismatchIdx > 0, 'Must have mismatch warning');
            // After the warning, the function should continue (no exit 1 immediately after)
            const afterMismatch = section.substring(mismatchIdx, mismatchIdx + 200);
            assert.ok(
                !afterMismatch.includes('exit 1'),
                'Must NOT exit after base model mismatch warning'
            );
        });

        it('skips base model check when MODEL_NAME is not set', () => {
            const section = getDownloadFromHubSection();
            assert.ok(
                section.includes('MODEL_NAME:-'),
                'Must handle missing MODEL_NAME gracefully'
            );
        });

        it('also validates in _validate_adapter_config for --weights path', () => {
            assert.ok(
                adapterScript.includes('_validate_adapter_config'),
                'Must also have _validate_adapter_config for --weights path'
            );
            // Verify it uses || true (best-effort, non-blocking)
            assert.ok(
                adapterScript.includes('_validate_adapter_config "${weights_uri}" || true'),
                'Must use || true to ensure validation never blocks'
            );
        });
    });

    // ── _download_from_hub is called from add subcommand ─────────────────

    describe('_download_from_hub integration with add subcommand', () => {

        it('add calls _download_from_hub when --from-hub is provided', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('_download_from_hub "${from_hub}" "${adapter_name}"'),
                'add must call _download_from_hub with repo ID and adapter name'
            );
        });

        it('add shows source as HuggingFace Hub in progress output', () => {
            const addSection = getAddSection();
            assert.ok(
                addSection.includes('HuggingFace Hub'),
                'add must show HuggingFace Hub as source'
            );
        });

        it('add proceeds with CreateInferenceComponent after download', () => {
            const addSection = getAddSection();
            const downloadPos = addSection.indexOf('_download_from_hub');
            const createPos = addSection.indexOf('create-inference-component');
            assert.ok(
                downloadPos > 0 && createPos > 0 && downloadPos < createPos,
                'Must call _download_from_hub before create-inference-component'
            );
        });
    });
});
