// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for LoRA adapter search subcommand.
 *
 * Tests that the rendered do/adapter script contains correct logic for:
 * - search: queries HF API with correct base_model filter
 * - search: displays results table with repo ID, downloads, description
 * - search: with no results shows helpful message
 * - search: respects --limit flag
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 2.1
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Feature: lora-adapter-lifecycle — do/adapter search (Req 2.1)', function () {
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

    // ── Helper to extract search section ─────────────────────────────────

    function getSearchSection() {
        const start = adapterScript.indexOf('_adapter_search()');
        const end = adapterScript.indexOf('\n# ── Main:', start);
        if (start === -1) {
            return adapterScript; // fallback to full script
        }
        return end === -1 ? adapterScript.substring(start) : adapterScript.substring(start, end);
    }

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

        it('includes limit parameter in API query', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('limit=${limit}'),
                'search must include limit parameter in API URL'
            );
        });

        it('uses HF_TOKEN for authorization when set', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('HF_TOKEN') &&
                searchSection.includes('Authorization: Bearer'),
                'search must use HF_TOKEN for authorization'
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

        it('displays numbered results with # column', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('"#"'),
                'search output must include # column for numbering'
            );
        });

        it('shows model name in search header', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('LoRA adapters for ${MODEL_NAME}'),
                'search must show model name in header'
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
    });

    // ── search error handling ────────────────────────────────────────────

    describe('search error handling', () => {

        it('shows clear error when API call fails', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('Could not reach HuggingFace Hub. Check network connectivity.'),
                'search must show clear error when API fails'
            );
        });

        it('validates MODEL_NAME is set before searching', () => {
            const searchSection = getSearchSection();
            assert.ok(
                searchSection.includes('MODEL_NAME') &&
                searchSection.includes('not configured'),
                'search must validate MODEL_NAME is set'
            );
        });
    });

    // ── search is registered in dispatch ─────────────────────────────────

    describe('search subcommand is properly registered', () => {

        it('search is listed in usage/help output', () => {
            assert.ok(
                adapterScript.includes('search [--limit N]'),
                'search must be listed in usage output'
            );
        });

        it('search is handled in case dispatch', () => {
            assert.ok(
                adapterScript.includes('search)\n        _validate_lora_enabled\n        _adapter_search'),
                'search must be handled in case dispatch'
            );
        });

        it('search validates LoRA is enabled before executing', () => {
            // Check that the dispatch calls _validate_lora_enabled before _adapter_search
            const dispatchSection = adapterScript.substring(adapterScript.lastIndexOf('case "${SUBCOMMAND}"'));
            const searchCase = dispatchSection.substring(dispatchSection.indexOf('search)'));
            assert.ok(
                searchCase.includes('_validate_lora_enabled'),
                'search must validate LoRA is enabled'
            );
        });
    });
});
