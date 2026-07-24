// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for --status flag in do/deploy (FR-2.8, FR-4.7).
 *
 * Tests cover:
 * - --status flag is parsed in the case statement
 * - FLAG_STATUS variable is set when --status is provided
 * - Status display block calls .deploy_helper.py status
 * - Status display exits 0 without dispatching deploy logic
 * - --target flag is passed through to status helper when combined
 * - --help output includes --status documentation
 *
 * Feature: interactive-deploy-ux
 * Validates: Requirements FR-2.8, FR-4.7
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/do/deploy');
const templateContent = readFileSync(TEMPLATE_PATH, 'utf-8');

// ── Flag Parsing (FR-2.8) ───────────────────────────────────────────────────

describe('Feature: interactive-deploy-ux — Status Flag: Parsing', () => {

    it('parses --status flag in the case statement', () => {
        // **Validates: Requirements FR-2.8**
        assert.ok(
            templateContent.includes('--status)'),
            'Must have --status) case in flag parsing'
        );
    });

    it('sets FLAG_STATUS=1 when --status is encountered', () => {
        // **Validates: Requirements FR-2.8**
        assert.ok(
            templateContent.includes('FLAG_STATUS=1'),
            'Must set FLAG_STATUS=1 when --status is parsed'
        );
    });

    it('shifts after consuming --status flag', () => {
        // **Validates: Requirements FR-2.8**
        const statusCase = templateContent.split('--status)')[1];
        const nextCase = statusCase.split(';;')[0];
        assert.ok(
            nextCase.includes('shift'),
            'Must shift after consuming --status flag'
        );
    });
});

// ── Status Display Block (FR-2.8, FR-4.7) ──────────────────────────────────

describe('Feature: interactive-deploy-ux — Status Flag: Display Block', () => {

    it('checks FLAG_STATUS after flag parsing loop', () => {
        // **Validates: Requirements FR-2.8**
        assert.ok(
            templateContent.includes('${FLAG_STATUS:-0}'),
            'Must check FLAG_STATUS with default 0'
        );
    });

    it('calls .deploy_helper.py status subcommand', () => {
        // **Validates: Requirements FR-2.8**
        const statusBlock = templateContent.split('Status display')[1];
        assert.ok(
            statusBlock && statusBlock.includes('.deploy_helper.py" status'),
            'Must call .deploy_helper.py with status subcommand'
        );
    });

    it('passes --config-file to the status helper', () => {
        // **Validates: Requirements FR-2.8**
        const statusBlock = templateContent.split('Status display')[1];
        assert.ok(
            statusBlock && statusBlock.includes('--config-file "${SCRIPT_DIR}/config"'),
            'Must pass --config-file "${SCRIPT_DIR}/config" to status helper'
        );
    });

    it('passes --target when FLAG_TARGET is set', () => {
        // **Validates: Requirements FR-2.8**
        const statusBlock = templateContent.split('Status display')[1];
        assert.ok(
            statusBlock && statusBlock.includes('${FLAG_TARGET:+--target "$FLAG_TARGET"}'),
            'Must conditionally pass --target when FLAG_TARGET is set'
        );
    });

    it('exits 0 after displaying status (no deploy dispatch)', () => {
        // **Validates: Requirements FR-2.8**
        const statusBlock = templateContent.split('Status display')[1];
        const beforeSwitch = statusBlock.split('Switch-or-deploy')[0];
        assert.ok(
            beforeSwitch && beforeSwitch.includes('exit 0'),
            'Must exit 0 within status block before switch-or-deploy logic'
        );
    });

    it('status block is placed before switch-or-deploy logic', () => {
        // **Validates: Requirements FR-2.8**
        const lines = templateContent.split('\n');
        const statusLine = lines.findIndex(l => l.includes('Status display'));
        const switchLine = lines.findIndex(l => l.includes('Switch-or-deploy logic'));
        assert.ok(
            statusLine > 0 && switchLine > 0 && statusLine < switchLine,
            'Status display block must appear before switch-or-deploy logic'
        );
    });
});

// ── Human-Readable Formatting (FR-4.7) ─────────────────────────────────────

describe('Feature: interactive-deploy-ux — Status Flag: Formatting', () => {

    it('formats output with Python inline script', () => {
        // **Validates: Requirements FR-4.7**
        const statusBlock = templateContent.split('Status display')[1];
        const beforeSwitch = statusBlock.split('Switch-or-deploy')[0];
        assert.ok(
            beforeSwitch && beforeSwitch.includes('python3 -c'),
            'Must use inline Python script for formatting status output'
        );
    });

    it('prints active target at the bottom of output', () => {
        // **Validates: Requirements FR-4.7**
        const statusBlock = templateContent.split('Status display')[1];
        const beforeSwitch = statusBlock.split('Switch-or-deploy')[0];
        assert.ok(
            beforeSwitch && beforeSwitch.includes('Active target'),
            'Must print "Active target" in the formatted output'
        );
    });

    it('shows "not deployed" for targets without status', () => {
        // **Validates: Requirements FR-4.7**
        const statusBlock = templateContent.split('Status display')[1];
        const beforeSwitch = statusBlock.split('Switch-or-deploy')[0];
        assert.ok(
            beforeSwitch && beforeSwitch.includes('not deployed'),
            'Must show "not deployed" for targets with empty status'
        );
    });

    it('includes target-specific details for managed-inference (endpoint_name)', () => {
        // **Validates: Requirements FR-4.7**
        const statusBlock = templateContent.split('Status display')[1];
        const beforeSwitch = statusBlock.split('Switch-or-deploy')[0];
        assert.ok(
            beforeSwitch && beforeSwitch.includes('endpoint_name'),
            'Must include endpoint_name detail for managed-inference'
        );
    });

    it('includes target-specific details for hyperpod-eks (gpu_count)', () => {
        // **Validates: Requirements FR-4.7**
        const statusBlock = templateContent.split('Status display')[1];
        const beforeSwitch = statusBlock.split('Switch-or-deploy')[0];
        assert.ok(
            beforeSwitch && beforeSwitch.includes('gpu_count'),
            'Must include gpu_count detail for hyperpod-eks'
        );
    });
});

// ── Help Text (FR-2.8) ──────────────────────────────────────────────────────

describe('Feature: interactive-deploy-ux — Status Flag: Help Text', () => {

    it('--help output mentions --status flag', () => {
        // **Validates: Requirements FR-2.8**
        const helpBlock = templateContent.split('--help|-h)')[1];
        const helpEnd = helpBlock.split('exit 0')[0];
        assert.ok(
            helpEnd && helpEnd.includes('--status'),
            '--help output must document the --status flag'
        );
    });
});
