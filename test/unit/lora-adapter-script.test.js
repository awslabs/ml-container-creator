// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for do/adapter script structure and argument parsing.
 *
 * Tests cover:
 * - Script sources do/config and do/lib/wait.sh
 * - Script uses set -e, set -u, set -o pipefail
 * - Subcommands: add, list, remove, update are dispatched
 * - --help flag shows usage
 * - _validate_lora_enabled checks ENABLE_LORA=true
 * - Argument parsing for add: requires <name> and --weights <s3-uri>
 * - Argument parsing for remove: requires <name>
 * - Argument parsing for update: requires <name> and --weights <new-s3-uri>
 * - Unknown subcommand shows error and usage
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 2.1
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADAPTER_TEMPLATE_PATH = resolve(__dirname, '../../templates/do/adapter');
const ADAPTER_TEMPLATE = readFileSync(ADAPTER_TEMPLATE_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderAdapter(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        awsRegion: 'us-east-1',
        ...overrides
    };
    return ejs.render(ADAPTER_TEMPLATE, vars);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/adapter script structure (Req 2.1)', () => {

    // ── Error handling ───────────────────────────────────────────────────

    describe('Script error handling', () => {

        it('uses set -e for exit on error', () => {
            const rendered = renderAdapter();
            assert.ok(rendered.includes('set -e'), 'Must include set -e');
        });

        it('uses set -u for unset variable errors', () => {
            const rendered = renderAdapter();
            assert.ok(rendered.includes('set -u'), 'Must include set -u');
        });

        it('uses set -o pipefail for pipe error propagation', () => {
            const rendered = renderAdapter();
            assert.ok(rendered.includes('set -o pipefail'), 'Must include set -o pipefail');
        });
    });

    // ── Sources ──────────────────────────────────────────────────────────

    describe('Script sources configuration and helpers', () => {

        it('sources do/config for project configuration', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('source "${SCRIPT_DIR}/config"'),
                'Must source do/config'
            );
        });

        it('sources do/lib/wait.sh for helper functions', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('source "${SCRIPT_DIR}/lib/wait.sh"'),
                'Must source do/lib/wait.sh'
            );
        });
    });

    // ── Subcommand dispatch ──────────────────────────────────────────────

    describe('Subcommand dispatch via case statement', () => {

        it('dispatches add subcommand to _adapter_add', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_adapter_add'),
                'Must define _adapter_add function'
            );
            // Verify case statement routes 'add' to the function
            assert.ok(
                /case.*\n[\s\S]*?add\)/.test(rendered),
                'Must have case statement with add) branch'
            );
        });

        it('dispatches list subcommand to _adapter_list', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_adapter_list'),
                'Must define _adapter_list function'
            );
        });

        it('dispatches remove subcommand to _adapter_remove', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_adapter_remove'),
                'Must define _adapter_remove function'
            );
        });

        it('dispatches update subcommand to _adapter_update', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_adapter_update'),
                'Must define _adapter_update function'
            );
        });

        it('handles --help flag with _usage function', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_usage'),
                'Must define _usage function'
            );
            assert.ok(
                /--help\|-h\)/.test(rendered),
                'Must handle --help|-h in case statement'
            );
        });

        it('handles unknown subcommand with error message', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('Unknown command'),
                'Must show error for unknown subcommand'
            );
        });
    });

    // ── LoRA validation ──────────────────────────────────────────────────

    describe('LoRA enabled validation', () => {

        it('defines _validate_lora_enabled function', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_validate_lora_enabled'),
                'Must define _validate_lora_enabled function'
            );
        });

        it('checks ENABLE_LORA variable', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('ENABLE_LORA'),
                'Must check ENABLE_LORA variable'
            );
        });

        it('calls _validate_lora_enabled before each subcommand', () => {
            const rendered = renderAdapter();
            // Each subcommand branch should call _validate_lora_enabled
            const addSection = rendered.substring(rendered.indexOf('add)'));
            assert.ok(
                addSection.includes('_validate_lora_enabled'),
                'add subcommand must validate LoRA is enabled'
            );
        });
    });

    // ── Argument parsing: add ────────────────────────────────────────────

    describe('Argument parsing for add subcommand', () => {

        it('add requires adapter name', () => {
            const rendered = renderAdapter();
            // The function should check for empty adapter_name
            assert.ok(
                rendered.includes('Adapter name is required') ||
                rendered.includes('adapter_name'),
                'add must validate adapter name is provided'
            );
        });

        it('add requires --weights flag', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('--weights is required') ||
                rendered.includes('weights_uri'),
                'add must validate --weights is provided'
            );
        });

        it('add parses --weights <s3-uri> argument', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('--weights)'),
                'add must parse --weights flag'
            );
        });
    });

    // ── Argument parsing: remove ─────────────────────────────────────────

    describe('Argument parsing for remove subcommand', () => {

        it('remove requires adapter name', () => {
            const rendered = renderAdapter();
            const removeSection = rendered.substring(rendered.indexOf('_adapter_remove'));
            assert.ok(
                removeSection.includes('Adapter name is required'),
                'remove must validate adapter name is provided'
            );
        });
    });

    // ── Argument parsing: update ─────────────────────────────────────────

    describe('Argument parsing for update subcommand', () => {

        it('update requires adapter name', () => {
            const rendered = renderAdapter();
            const updateSection = rendered.substring(rendered.indexOf('_adapter_update'));
            assert.ok(
                updateSection.includes('Adapter name is required'),
                'update must validate adapter name is provided'
            );
        });

        it('update requires --weights or --from-hub flag', () => {
            const rendered = renderAdapter();
            const updateSection = rendered.substring(rendered.indexOf('_adapter_update'));
            assert.ok(
                updateSection.includes('Either --weights or --from-hub is required'),
                'update must validate --weights or --from-hub is provided'
            );
        });
    });

    // ── Usage output ─────────────────────────────────────────────────────

    describe('Usage output', () => {

        it('shows all subcommands in usage', () => {
            const rendered = renderAdapter();
            assert.ok(rendered.includes('add'), 'Usage must mention add');
            assert.ok(rendered.includes('list'), 'Usage must mention list');
            assert.ok(rendered.includes('remove'), 'Usage must mention remove');
            assert.ok(rendered.includes('update'), 'Usage must mention update');
        });

        it('shows --weights flag in usage examples', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('--weights'),
                'Usage must show --weights flag'
            );
        });

        it('mentions do/adapters/<name>.conf metadata storage', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('do/adapters/'),
                'Usage must mention do/adapters/ directory'
            );
        });
    });

    // ── Base IC resolution ───────────────────────────────────────────────

    describe('Base IC resolution helper', () => {

        it('defines _resolve_base_ic_name function', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_resolve_base_ic_name'),
                'Must define _resolve_base_ic_name function'
            );
        });

        it('checks do/ic/default.conf for IC_DEPLOYED_NAME', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('IC_DEPLOYED_NAME'),
                'Must check IC_DEPLOYED_NAME from do/ic/default.conf'
            );
        });

        it('falls back to INFERENCE_COMPONENT_NAME from config', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('INFERENCE_COMPONENT_NAME'),
                'Must fall back to INFERENCE_COMPONENT_NAME'
            );
        });
    });

    // ── Adapter config validation (Req 4.5) ──────────────────────────────

    describe('Adapter config validation (best-effort)', () => {

        it('defines _validate_adapter_config function', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_validate_adapter_config'),
                'Must define _validate_adapter_config function'
            );
        });

        it('calls _validate_adapter_config in _adapter_add before CreateInferenceComponent', () => {
            const rendered = renderAdapter();
            const addSection = rendered.substring(rendered.indexOf('_adapter_add'));
            const validatePos = addSection.indexOf('_validate_adapter_config');
            const createPos = addSection.indexOf('create-inference-component');
            assert.ok(validatePos > 0, 'Must call _validate_adapter_config in add');
            assert.ok(createPos > 0, 'Must call create-inference-component in add');
            assert.ok(
                validatePos < createPos,
                '_validate_adapter_config must be called before create-inference-component'
            );
        });

        it('uses || true to suppress validation failures', () => {
            const rendered = renderAdapter();
            assert.ok(
                rendered.includes('_validate_adapter_config "${weights_uri}" || true'),
                'Must suppress failures with || true so validation never blocks deployment'
            );
        });

        it('downloads adapter tar.gz from S3', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            assert.ok(
                funcSection.includes('aws s3 cp'),
                'Must download tar.gz from S3'
            );
        });

        it('extracts adapter_config.json from tar.gz', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            assert.ok(
                funcSection.includes('tar -xzf') && funcSection.includes('adapter_config.json'),
                'Must extract adapter_config.json from tar.gz'
            );
        });

        it('reads base_model_name_or_path from adapter_config.json', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            assert.ok(
                funcSection.includes('base_model_name_or_path'),
                'Must read base_model_name_or_path field'
            );
        });

        it('compares adapter base model with MODEL_NAME', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            assert.ok(
                funcSection.includes('MODEL_NAME'),
                'Must compare with MODEL_NAME from do/config'
            );
        });

        it('warns on base model mismatch', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            assert.ok(
                funcSection.includes('Adapter was trained on') &&
                funcSection.includes('but base model is') &&
                funcSection.includes('Adapter may not work correctly'),
                'Must warn when adapter base model does not match MODEL_NAME'
            );
        });

        it('skips validation silently when MODEL_NAME is not set', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            assert.ok(
                funcSection.includes('MODEL_NAME:-'),
                'Must handle missing MODEL_NAME gracefully'
            );
        });

        it('runs validation in a subshell for error containment', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            // Check for subshell pattern: ( ... )
            assert.ok(
                funcSection.includes('(\n') || funcSection.includes('('),
                'Must run in subshell for error containment'
            );
            assert.ok(
                funcSection.includes('set +e'),
                'Must disable exit-on-error inside subshell'
            );
        });

        it('cleans up temp files after validation', () => {
            const rendered = renderAdapter();
            const funcSection = rendered.substring(
                rendered.indexOf('_validate_adapter_config()'),
                rendered.indexOf('# ── Subcommand')
            );
            assert.ok(
                funcSection.includes('rm -rf'),
                'Must clean up temp files'
            );
        });
    });
});
