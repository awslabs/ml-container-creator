// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for adapter targeting in do/benchmark and do/logs templates.
 *
 * Tests cover:
 * - do/benchmark --adapter <name> parses the flag and resolves adapter IC
 * - do/benchmark without --adapter uses base IC (existing behavior unchanged)
 * - do/logs --adapter <name> parses the flag and resolves adapter IC
 * - do/logs without --adapter shows all endpoint logs (existing behavior unchanged)
 * - Both scripts look up do/adapters/<name>.conf and use ADAPTER_IC_NAME
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 5.1
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load templates
const benchmarkTemplatePath = path.join(__dirname, '../../templates/do/benchmark');
const logsTemplatePath = path.join(__dirname, '../../templates/do/logs');

const benchmarkTemplateContent = readFileSync(benchmarkTemplatePath, 'utf8');
const logsTemplateContent = readFileSync(logsTemplatePath, 'utf8');

/** Render do/logs template for realtime-inference */
function renderLogs() {
    return ejs.render(logsTemplateContent, { deploymentTarget: 'realtime-inference' });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — do/benchmark adapter targeting (Req 5.1)', () => {

    // ── --adapter flag parsing ───────────────────────────────────────────

    describe('--adapter flag parsing', () => {

        it('parses --adapter flag from arguments', () => {
            assert.ok(
                benchmarkTemplateContent.includes('--adapter)'),
                'do/benchmark must parse --adapter flag'
            );
        });

        it('stores adapter argument in ADAPTER_ARG variable', () => {
            assert.ok(
                benchmarkTemplateContent.includes('ADAPTER_ARG'),
                'do/benchmark must store adapter argument in ADAPTER_ARG variable'
            );
        });

        it('shows --adapter in help text', () => {
            assert.ok(
                benchmarkTemplateContent.includes('--adapter <name>'),
                'do/benchmark help must document --adapter flag'
            );
        });
    });

    // ── Adapter IC resolution ────────────────────────────────────────────

    describe('Adapter IC resolution from do/adapters/<name>.conf', () => {

        it('looks up adapter config from do/adapters/<name>.conf', () => {
            assert.ok(
                benchmarkTemplateContent.includes('adapters/${ADAPTER_ARG}.conf'),
                'do/benchmark must reference do/adapters/<ADAPTER_ARG>.conf'
            );
        });

        it('sources adapter conf to get ADAPTER_IC_NAME', () => {
            assert.ok(
                benchmarkTemplateContent.includes('ADAPTER_IC_NAME'),
                'do/benchmark must use ADAPTER_IC_NAME from adapter conf'
            );
        });

        it('errors when adapter conf is not found', () => {
            assert.ok(
                benchmarkTemplateContent.includes('Adapter config not found'),
                'do/benchmark must error when adapter conf does not exist'
            );
        });

        it('errors when ADAPTER_IC_NAME is missing from conf', () => {
            assert.ok(
                benchmarkTemplateContent.includes('missing ADAPTER_IC_NAME'),
                'do/benchmark must error when ADAPTER_IC_NAME is empty'
            );
        });

        it('uses ADAPTER_IC_NAME as IC_NAME for benchmark target', () => {
            // After sourcing adapter conf, IC_NAME should be set to ADAPTER_IC_NAME
            assert.ok(
                benchmarkTemplateContent.includes('IC_NAME="${ADAPTER_IC_NAME}"'),
                'do/benchmark must assign ADAPTER_IC_NAME to IC_NAME'
            );
        });
    });

    // ── Resolution precedence ────────────────────────────────────────────

    describe('Resolution precedence', () => {

        it('checks --adapter before --ic', () => {
            // ADAPTER_ARG check must come before IC_ARG check
            const adapterIdx = benchmarkTemplateContent.indexOf('if [ -n "${ADAPTER_ARG}"');
            const icIdx = benchmarkTemplateContent.indexOf('elif [ -n "${IC_ARG}"');
            assert.ok(adapterIdx > -1, 'Must check ADAPTER_ARG');
            assert.ok(icIdx > -1, 'Must check IC_ARG');
            assert.ok(
                adapterIdx < icIdx,
                '--adapter must be checked before --ic in resolution precedence'
            );
        });

        it('still supports --ic flag for base IC targeting', () => {
            assert.ok(
                benchmarkTemplateContent.includes('--ic)'),
                'do/benchmark must still parse --ic flag'
            );
        });

        it('falls back to first IC in do/ic/ when no flags provided', () => {
            assert.ok(
                benchmarkTemplateContent.includes('/ic/*.conf'),
                'do/benchmark must iterate do/ic/*.conf when no flags provided'
            );
        });
    });

    // ── Available adapters listing on error ──────────────────────────────

    describe('Error UX: lists available adapters', () => {

        it('lists available adapters when conf not found', () => {
            assert.ok(
                benchmarkTemplateContent.includes('Available adapters'),
                'do/benchmark must list available adapters on error'
            );
        });
    });
});

describe('Feature: lora-adapter-lifecycle — do/logs adapter targeting (Req 5.1)', () => {

    const renderedLogs = renderLogs();

    // ── --adapter flag parsing ───────────────────────────────────────────

    describe('--adapter flag parsing', () => {

        it('parses --adapter flag from arguments', () => {
            assert.ok(
                renderedLogs.includes('--adapter)'),
                'do/logs must parse --adapter flag'
            );
        });

        it('stores adapter argument in ADAPTER_ARG variable', () => {
            assert.ok(
                renderedLogs.includes('ADAPTER_ARG'),
                'do/logs must store adapter argument in ADAPTER_ARG variable'
            );
        });

        it('shows --adapter in help text', () => {
            assert.ok(
                renderedLogs.includes('--adapter <name>'),
                'do/logs help must document --adapter flag'
            );
        });
    });

    // ── Adapter IC resolution ────────────────────────────────────────────

    describe('Adapter IC resolution from do/adapters/<name>.conf', () => {

        it('looks up adapter config from do/adapters/<name>.conf', () => {
            assert.ok(
                renderedLogs.includes('adapters/${ADAPTER_ARG}.conf'),
                'do/logs must reference do/adapters/<ADAPTER_ARG>.conf'
            );
        });

        it('sources adapter conf to get ADAPTER_IC_NAME', () => {
            assert.ok(
                renderedLogs.includes('ADAPTER_IC_NAME'),
                'do/logs must use ADAPTER_IC_NAME from adapter conf'
            );
        });

        it('errors when adapter conf is not found', () => {
            assert.ok(
                renderedLogs.includes('Adapter config not found'),
                'do/logs must error when adapter conf does not exist'
            );
        });

        it('errors when ADAPTER_IC_NAME is missing from conf', () => {
            assert.ok(
                renderedLogs.includes('missing ADAPTER_IC_NAME'),
                'do/logs must error when ADAPTER_IC_NAME is empty'
            );
        });

        it('uses ADAPTER_IC_NAME as IC_NAME for log filtering', () => {
            assert.ok(
                renderedLogs.includes('IC_NAME="${ADAPTER_IC_NAME}"'),
                'do/logs must assign ADAPTER_IC_NAME to IC_NAME'
            );
        });
    });

    // ── Resolution precedence ────────────────────────────────────────────

    describe('Resolution precedence', () => {

        it('checks --adapter before --ic', () => {
            const adapterIdx = renderedLogs.indexOf('if [ -n "${ADAPTER_ARG}"');
            const icIdx = renderedLogs.indexOf('elif [ -n "${IC_ARG}"');
            assert.ok(adapterIdx > -1, 'Must check ADAPTER_ARG');
            assert.ok(icIdx > -1, 'Must check IC_ARG');
            assert.ok(
                adapterIdx < icIdx,
                '--adapter must be checked before --ic in resolution precedence'
            );
        });

        it('still supports --ic flag for IC targeting', () => {
            assert.ok(
                renderedLogs.includes('--ic)'),
                'do/logs must still parse --ic flag'
            );
        });

        it('falls back to endpoint logs when no flags provided', () => {
            // When no IC is resolved, logs should use endpoint-level log group
            assert.ok(
                renderedLogs.includes('/aws/sagemaker/Endpoints/${ENDPOINT}'),
                'do/logs must fall back to endpoint log group when no IC resolved'
            );
        });
    });

    // ── CloudWatch log group targeting ───────────────────────────────────

    describe('CloudWatch log group targeting', () => {

        it('uses IC-specific log group when adapter is resolved', () => {
            assert.ok(
                renderedLogs.includes('/aws/sagemaker/InferenceComponents/${IC_NAME}'),
                'do/logs must use IC-specific log group when IC_NAME is set'
            );
        });

        it('uses endpoint log group when no adapter/IC specified', () => {
            assert.ok(
                renderedLogs.includes('/aws/sagemaker/Endpoints/${ENDPOINT}'),
                'do/logs must use endpoint log group as fallback'
            );
        });
    });

    // ── Available adapters listing on error ──────────────────────────────

    describe('Error UX: lists available adapters', () => {

        it('lists available adapters when conf not found', () => {
            assert.ok(
                renderedLogs.includes('Available adapters'),
                'do/logs must list available adapters on error'
            );
        });
    });
});
