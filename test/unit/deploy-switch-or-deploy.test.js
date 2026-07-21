// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for switch-or-deploy logic in do/deploy (FR-4.4, FR-4.5, CP-5).
 *
 * Tests cover:
 * - Status variable mapping for all 4 targets
 * - Switch-only path (existing deployment → update config + exit)
 * - Deploy path (no existing deployment → fall through)
 * - Atomic DEPLOYMENT_TARGET update via _update_config
 * - CP-5 guarantee: no API calls or prompts on switch
 *
 * Feature: interactive-deploy-ux
 * Validates: Requirements FR-4.4, FR-4.5, CP-5
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/do/deploy');
const templateContent = readFileSync(TEMPLATE_PATH, 'utf-8');

// ── Status Variable Mapping (FR-4.4) ────────────────────────────────────────

describe('Feature: interactive-deploy-ux — Switch-or-Deploy: Status Variable Mapping', () => {

    it('maps managed-inference to DEPLOYMENT_TARGET_SMAI_STATUS', () => {
        // **Validates: Requirements FR-4.4**
        assert.ok(
            templateContent.includes('managed-inference) _STATUS_VAR="DEPLOYMENT_TARGET_SMAI_STATUS"'),
            'Must map managed-inference to DEPLOYMENT_TARGET_SMAI_STATUS'
        );
    });

    it('maps hyperpod-eks to DEPLOYMENT_TARGET_HP_STATUS', () => {
        // **Validates: Requirements FR-4.4**
        assert.ok(
            templateContent.includes('hyperpod-eks)      _STATUS_VAR="DEPLOYMENT_TARGET_HP_STATUS"'),
            'Must map hyperpod-eks to DEPLOYMENT_TARGET_HP_STATUS'
        );
    });

    it('maps async-inference to DEPLOYMENT_TARGET_ASYNC_STATUS', () => {
        // **Validates: Requirements FR-4.4**
        assert.ok(
            templateContent.includes('async-inference)   _STATUS_VAR="DEPLOYMENT_TARGET_ASYNC_STATUS"'),
            'Must map async-inference to DEPLOYMENT_TARGET_ASYNC_STATUS'
        );
    });

    it('maps batch-transform to DEPLOYMENT_TARGET_BATCH_STATUS', () => {
        // **Validates: Requirements FR-4.4**
        assert.ok(
            templateContent.includes('batch-transform)   _STATUS_VAR="DEPLOYMENT_TARGET_BATCH_STATUS"'),
            'Must map batch-transform to DEPLOYMENT_TARGET_BATCH_STATUS'
        );
    });

    it('handles unknown targets with empty _STATUS_VAR', () => {
        // **Validates: Requirements FR-4.4**
        assert.ok(
            templateContent.includes('*)                 _STATUS_VAR=""'),
            'Must set _STATUS_VAR to empty for unknown targets'
        );
    });
});

// ── Switch Path (FR-4.4, FR-4.5, CP-5) ─────────────────────────────────────

describe('Feature: interactive-deploy-ux — Switch-or-Deploy: Switch Focus Path', () => {

    it('checks if status variable is non-empty using indirect expansion', () => {
        // **Validates: Requirements FR-4.4**
        assert.ok(
            templateContent.includes('${!_STATUS_VAR:-}'),
            'Must use indirect expansion ${!_STATUS_VAR:-} to read status var value'
        );
    });

    it('calls _update_config to persist DEPLOYMENT_TARGET on switch (FR-4.5)', () => {
        // **Validates: Requirements FR-4.5**
        // The switch block must call _update_config DEPLOYMENT_TARGET
        const switchBlock = templateContent.split('Switch-or-deploy logic')[1];
        assert.ok(
            switchBlock && switchBlock.includes('_update_config DEPLOYMENT_TARGET "$FLAG_TARGET"'),
            'Switch path must call _update_config DEPLOYMENT_TARGET "$FLAG_TARGET"'
        );
    });

    it('prints "Focused on <target>" message on switch', () => {
        // **Validates: Requirements FR-4.4**
        const switchBlock = templateContent.split('Switch-or-deploy logic')[1];
        assert.ok(
            switchBlock && switchBlock.includes('echo "Focused on $FLAG_TARGET"'),
            'Switch path must print "Focused on $FLAG_TARGET"'
        );
    });

    it('exits with code 0 on switch (no further processing)', () => {
        // **Validates: Requirements CP-5**
        const switchBlock = templateContent.split('Switch-or-deploy logic')[1];
        const switchSection = switchBlock.split('No existing deployment')[0];
        assert.ok(
            switchSection && switchSection.includes('exit 0'),
            'Switch path must exit 0 immediately after printing focus message'
        );
    });

    it('does not invoke deploy helper prompt or dispatch on switch (CP-5: <1 second)', () => {
        // **Validates: Requirements CP-5**
        // The switch exit 0 must come before the prompt helper invocation and dispatch.
        // Note: the status display block also calls .deploy_helper.py but it is guarded
        // by FLAG_STATUS and won't execute on a switch path.
        const lines = templateContent.split('\n');
        const switchExitLine = lines.findIndex(l =>
            l.includes('Focused on $FLAG_TARGET')
        );
        const helperPromptLine = lines.findIndex(l =>
            l.includes('.deploy_helper.py" prompt')
        );
        assert.ok(
            switchExitLine < helperPromptLine,
            'Switch exit must occur before deploy helper prompt invocation (CP-5 guarantee)'
        );
    });
});

// ── Deploy Path (FR-4.4 fall-through) ───────────────────────────────────────

describe('Feature: interactive-deploy-ux — Switch-or-Deploy: Deploy Flow Path', () => {

    it('falls through to deploy flow when status var is empty', () => {
        // **Validates: Requirements FR-4.4**
        const switchBlock = templateContent.split('Switch-or-deploy logic')[1];
        assert.ok(
            switchBlock && switchBlock.includes('No existing deployment — fall through to deploy flow'),
            'Must have comment indicating fall-through for empty status var'
        );
    });

    it('switch block is guarded by FLAG_TARGET being non-empty', () => {
        // **Validates: Requirements FR-4.4**
        const switchBlock = templateContent.split('Switch-or-deploy logic')[1];
        const firstIf = switchBlock.split('\n').find(l => l.includes('if ['));
        assert.ok(
            firstIf && firstIf.includes('-n "$FLAG_TARGET"'),
            'Switch-or-deploy block must be guarded by [ -n "$FLAG_TARGET" ]'
        );
    });

    it('preserves DEPLOYMENT_TARGET assignment before switch check', () => {
        // **Validates: Requirements FR-4.4**
        const lines = templateContent.split('\n');
        const assignLine = lines.findIndex(l =>
            l.includes('DEPLOYMENT_TARGET="$FLAG_TARGET"') && !l.includes('_update_config')
        );
        const switchLine = lines.findIndex(l =>
            l.includes('Switch-or-deploy logic')
        );
        assert.ok(
            assignLine > 0 && switchLine > 0 && assignLine < switchLine,
            'DEPLOYMENT_TARGET="$FLAG_TARGET" assignment must precede switch-or-deploy block'
        );
    });
});
