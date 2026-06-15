// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Do-Config Output Correctness Property-Based Tests
 *
 * Property 13: Do-Config Output Correctness
 *
 * For any project configuration: (a) if an ARN is configured for a secret type,
 * the generated do/config SHALL export the _ARN variant (e.g., HF_TOKEN_ARN);
 * (b) if a plaintext value is configured, it SHALL export the standard variable
 * (e.g., HF_TOKEN); (c) if neither is configured, it SHALL omit the export entirely.
 *
 * Feature: secrets-manager-integration, Property 13: Do-Config Output Correctness
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.5, 12.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── EJS template snippet (from templates/do/config — transformers framework section) ──

const DO_CONFIG_SECRETS_TEMPLATE = [
    '<% if (typeof hfTokenArn !== \'undefined\' && hfTokenArn) { %>',
    'export HF_TOKEN_ARN="<%= hfTokenArn %>"',
    '<% } else if (hfToken) { %>',
    'export HF_TOKEN="<%= hfToken %>"',
    '<% } %>',
    '<% if (typeof ngcTokenArn !== \'undefined\' && ngcTokenArn) { %>',
    'export NGC_API_KEY_ARN="<%= ngcTokenArn %>"',
    '<% } else if (ngcApiKey) { %>',
    'export NGC_API_KEY="<%= ngcApiKey %>"',
    '<% } %>'
].join('\n');

// ── Arbitrary generators ─────────────────────────────────────────────────────

/**
 * Generate a realistic Secrets Manager ARN string.
 */
const arbArn = fc.tuple(
    fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'),
    fc.stringMatching(/^[0-9]{12}$/),
    fc.stringMatching(/^[a-zA-Z0-9/_-]{3,20}$/)
).map(([region, account, name]) =>
    `arn:aws:secretsmanager:${region}:${account}:secret:mlcc/${name}`
);

/**
 * Generate a plaintext token value (non-empty, no ARN prefix).
 */
const arbPlaintext = fc.stringMatching(/^[a-zA-Z0-9_-]{4,40}$/).filter(
    s => !s.startsWith('arn:aws:secretsmanager:')
);

/**
 * Generate a configuration for HuggingFace token:
 * - ARN set (plaintext null/undefined)
 * - Plaintext set (ARN null/undefined)
 * - Neither set (both null/undefined)
 */
const arbHfConfig = fc.oneof(
    // ARN configured
    arbArn.map(arn => ({ hfTokenArn: arn, hfToken: null })),
    // Plaintext configured
    arbPlaintext.map(token => ({ hfTokenArn: null, hfToken: token })),
    // Neither configured
    fc.constant({ hfTokenArn: null, hfToken: null })
);

/**
 * Generate a configuration for NGC token:
 * - ARN set (plaintext null/undefined)
 * - Plaintext set (ARN null/undefined)
 * - Neither set (both null/undefined)
 */
const arbNgcConfig = fc.oneof(
    // ARN configured
    arbArn.map(arn => ({ ngcTokenArn: arn, ngcApiKey: null })),
    // Plaintext configured
    arbPlaintext.map(key => ({ ngcTokenArn: null, ngcApiKey: key })),
    // Neither configured
    fc.constant({ ngcTokenArn: null, ngcApiKey: null })
);

/**
 * Generate a full secrets configuration combining HF and NGC independently.
 */
const arbSecretsConfig = fc.tuple(arbHfConfig, arbNgcConfig).map(
    ([hf, ngc]) => ({ ...hf, ...ngc })
);

// ── Helper functions ─────────────────────────────────────────────────────────

function renderTemplate(config) {
    return ejs.render(DO_CONFIG_SECRETS_TEMPLATE, config);
}

function getExportLines(rendered) {
    return rendered.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('export '));
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration, Property 13: Do-Config Output Correctness', () => {

    /**
     * Validates: Requirements 11.1, 11.2, 11.3, 11.5, 12.4
     */

    it('when hfTokenArn is set, output contains HF_TOKEN_ARN and does NOT contain HF_TOKEN=', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbArn,
            arbNgcConfig,
            (arn, ngcConfig) => {
                const config = { hfTokenArn: arn, hfToken: null, ...ngcConfig };
                const rendered = renderTemplate(config);
                const exportLines = getExportLines(rendered);

                // Must contain HF_TOKEN_ARN export with the correct value
                const hasArnExport = exportLines.some(line =>
                    line.includes('HF_TOKEN_ARN=') && line.includes(arn)
                );
                assert.strictEqual(hasArnExport, true,
                    `Expected HF_TOKEN_ARN="${arn}" in output but not found`);

                // Must NOT contain plain HF_TOKEN= (without _ARN suffix)
                const hasPlaintextExport = exportLines.some(line =>
                    line.match(/export HF_TOKEN="/) && !line.includes('HF_TOKEN_ARN')
                );
                assert.strictEqual(hasPlaintextExport, false,
                    'HF_TOKEN_ARN is set but found plain HF_TOKEN= export in output');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('when hfToken plaintext is set (no ARN), output contains HF_TOKEN and does NOT contain HF_TOKEN_ARN', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbPlaintext,
            arbNgcConfig,
            (token, ngcConfig) => {
                const config = { hfTokenArn: null, hfToken: token, ...ngcConfig };
                const rendered = renderTemplate(config);
                const exportLines = getExportLines(rendered);

                // Must contain HF_TOKEN export with the correct value
                const hasPlaintextExport = exportLines.some(line =>
                    line.includes(`export HF_TOKEN="${token}"`)
                );
                assert.strictEqual(hasPlaintextExport, true,
                    `Expected HF_TOKEN="${token}" in output but not found`);

                // Must NOT contain HF_TOKEN_ARN
                const hasArnExport = exportLines.some(line =>
                    line.includes('HF_TOKEN_ARN=')
                );
                assert.strictEqual(hasArnExport, false,
                    'hfToken plaintext is set but found HF_TOKEN_ARN= export in output');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('when neither hfTokenArn nor hfToken is set, output contains neither HF_TOKEN nor HF_TOKEN_ARN', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNgcConfig,
            (ngcConfig) => {
                const config = { hfTokenArn: null, hfToken: null, ...ngcConfig };
                const rendered = renderTemplate(config);
                const exportLines = getExportLines(rendered);

                const hasAnyHfExport = exportLines.some(line =>
                    line.includes('HF_TOKEN')
                );
                assert.strictEqual(hasAnyHfExport, false,
                    'Neither hfTokenArn nor hfToken is set but found HF_TOKEN export in output');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('when ngcTokenArn is set, output contains NGC_API_KEY_ARN and does NOT contain NGC_API_KEY=', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbArn,
            arbHfConfig,
            (arn, hfConfig) => {
                const config = { ...hfConfig, ngcTokenArn: arn, ngcApiKey: null };
                const rendered = renderTemplate(config);
                const exportLines = getExportLines(rendered);

                // Must contain NGC_API_KEY_ARN export with the correct value
                const hasArnExport = exportLines.some(line =>
                    line.includes('NGC_API_KEY_ARN=') && line.includes(arn)
                );
                assert.strictEqual(hasArnExport, true,
                    `Expected NGC_API_KEY_ARN="${arn}" in output but not found`);

                // Must NOT contain plain NGC_API_KEY= (without _ARN suffix)
                const hasPlaintextExport = exportLines.some(line =>
                    line.match(/export NGC_API_KEY="/) && !line.includes('NGC_API_KEY_ARN')
                );
                assert.strictEqual(hasPlaintextExport, false,
                    'NGC_API_KEY_ARN is set but found plain NGC_API_KEY= export in output');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('when ngcApiKey plaintext is set (no ARN), output contains NGC_API_KEY and does NOT contain NGC_API_KEY_ARN', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbPlaintext,
            arbHfConfig,
            (key, hfConfig) => {
                const config = { ...hfConfig, ngcTokenArn: null, ngcApiKey: key };
                const rendered = renderTemplate(config);
                const exportLines = getExportLines(rendered);

                // Must contain NGC_API_KEY export with the correct value
                const hasPlaintextExport = exportLines.some(line =>
                    line.includes(`export NGC_API_KEY="${key}"`)
                );
                assert.strictEqual(hasPlaintextExport, true,
                    `Expected NGC_API_KEY="${key}" in output but not found`);

                // Must NOT contain NGC_API_KEY_ARN
                const hasArnExport = exportLines.some(line =>
                    line.includes('NGC_API_KEY_ARN=')
                );
                assert.strictEqual(hasArnExport, false,
                    'ngcApiKey plaintext is set but found NGC_API_KEY_ARN= export in output');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('when neither ngcTokenArn nor ngcApiKey is set, output contains neither NGC_API_KEY nor NGC_API_KEY_ARN', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbHfConfig,
            (hfConfig) => {
                const config = { ...hfConfig, ngcTokenArn: null, ngcApiKey: null };
                const rendered = renderTemplate(config);
                const exportLines = getExportLines(rendered);

                const hasAnyNgcExport = exportLines.some(line =>
                    line.includes('NGC_API_KEY')
                );
                assert.strictEqual(hasAnyNgcExport, false,
                    'Neither ngcTokenArn nor ngcApiKey is set but found NGC_API_KEY export in output');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('for any random configuration, ARN and plaintext exports are mutually exclusive per secret type', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbSecretsConfig,
            (config) => {
                const rendered = renderTemplate(config);
                const exportLines = getExportLines(rendered);

                // HF: cannot have both HF_TOKEN_ARN and HF_TOKEN
                const hasHfArn = exportLines.some(line => line.includes('HF_TOKEN_ARN='));
                const hasHfPlain = exportLines.some(line =>
                    line.match(/export HF_TOKEN="/) && !line.includes('HF_TOKEN_ARN')
                );
                assert.ok(!(hasHfArn && hasHfPlain),
                    'Output contains both HF_TOKEN_ARN and HF_TOKEN — they must be mutually exclusive');

                // NGC: cannot have both NGC_API_KEY_ARN and NGC_API_KEY
                const hasNgcArn = exportLines.some(line => line.includes('NGC_API_KEY_ARN='));
                const hasNgcPlain = exportLines.some(line =>
                    line.match(/export NGC_API_KEY="/) && !line.includes('NGC_API_KEY_ARN')
                );
                assert.ok(!(hasNgcArn && hasNgcPlain),
                    'Output contains both NGC_API_KEY_ARN and NGC_API_KEY — they must be mutually exclusive');

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
