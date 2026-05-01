// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Profile Parser Property-Based Tests
 *
 * Property 3: AWS profile parsing extracts all profile names
 *
 * For any valid INI-format AWS config file containing [profile X] sections
 * and any valid credentials file containing [X] sections, the parser should
 * return a deduplicated list of all profile names from both files, with
 * `default` sorted first when present.
 *
 * Feature: bootstrap-shared-infra, Property 3: AWS profile parsing extracts all profile names
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import AwsProfileParser from '../../generators/app/lib/aws-profile-parser.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid AWS profile name (alphanumeric with hyphens, non-empty).
 * Excludes 'default' so we can control its presence explicitly.
 */
const arbProfileName = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,14}$/)
    .filter(s => s.length >= 1 && s !== 'default');

/**
 * Generate a non-empty set of unique profile names (excluding 'default').
 */
const arbProfileNames = fc.uniqueArray(arbProfileName, { minLength: 1, maxLength: 8 });


/**
 * Build INI content for a config file with [profile X] sections.
 * The 'default' profile uses [default] instead of [profile default].
 */
function buildConfigIni(profileNames, includeDefault) {
    const lines = [];
    if (includeDefault) {
        lines.push('[default]');
        lines.push('region = us-east-1');
        lines.push('output = json');
        lines.push('');
    }
    for (const name of profileNames) {
        lines.push(`[profile ${name}]`);
        lines.push('region = us-west-2');
        lines.push('output = table');
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * Build INI content for a credentials file with [X] sections.
 */
function buildCredentialsIni(profileNames, includeDefault) {
    const lines = [];
    if (includeDefault) {
        lines.push('[default]');
        lines.push('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
        lines.push('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        lines.push('');
    }
    for (const name of profileNames) {
        lines.push(`[${name}]`);
        lines.push('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
        lines.push('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        lines.push('');
    }
    return lines.join('\n');
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 3: AWS profile parsing extracts all profile names', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `aws-profile-parser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 2.1
     *
     * All profile names from both config and credentials files appear in the result,
     * no duplicates exist, and `default` is first when present.
     */
    it('extracts all profile names from config and credentials files, deduplicated, with default first', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileNames,
            arbProfileNames,
            fc.boolean(),
            fc.boolean(),
            (configProfiles, credProfiles, includeDefaultInConfig, includeDefaultInCreds) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}`);
                const credentialsPath = join(tmpDir, `credentials-${Math.random().toString(36).slice(2)}`);

                // Write INI files
                writeFileSync(configPath, buildConfigIni(configProfiles, includeDefaultInConfig), 'utf8');
                writeFileSync(credentialsPath, buildCredentialsIni(credProfiles, includeDefaultInCreds), 'utf8');

                // Parse profiles
                const parser = new AwsProfileParser({ configPath, credentialsPath });
                const result = parser.getProfiles();

                // Compute expected profile names (deduplicated)
                const expectedSet = new Set([...configProfiles, ...credProfiles]);
                if (includeDefaultInConfig || includeDefaultInCreds) {
                    expectedSet.add('default');
                }

                // 1. All profile names from both files appear in the result
                for (const name of expectedSet) {
                    assert.ok(
                        result.includes(name),
                        `Expected profile "${name}" to be in result: [${result.join(', ')}]`
                    );
                }

                // Result should not contain names not in the expected set
                for (const name of result) {
                    assert.ok(
                        expectedSet.has(name),
                        `Unexpected profile "${name}" in result`
                    );
                }

                // 2. No duplicates exist
                const uniqueResult = new Set(result);
                assert.strictEqual(
                    result.length,
                    uniqueResult.size,
                    `Result should have no duplicates, got: [${result.join(', ')}]`
                );

                // 3. `default` is first when present
                const hasDefault = includeDefaultInConfig || includeDefaultInCreds;
                if (hasDefault) {
                    assert.strictEqual(
                        result[0],
                        'default',
                        `'default' should be first in result, got: [${result.join(', ')}]`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.1
     *
     * Missing files don't cause errors — parser returns empty array gracefully.
     */
    it('returns empty array when both config and credentials files are missing', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const configPath = join(tmpDir, 'nonexistent-config');
        const credentialsPath = join(tmpDir, 'nonexistent-credentials');

        const parser = new AwsProfileParser({ configPath, credentialsPath });
        const result = parser.getProfiles();

        assert.ok(Array.isArray(result), 'Result should be an array');
        assert.strictEqual(result.length, 0, 'Result should be empty when files are missing');
    });

    /**
     * Validates: Requirements 2.1
     *
     * When only one file exists, profiles from that file are still returned.
     */
    it('returns profiles from config file when credentials file is missing', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileNames,
            fc.boolean(),
            (configProfiles, includeDefault) => {
                const configPath = join(tmpDir, `config-only-${Math.random().toString(36).slice(2)}`);
                const credentialsPath = join(tmpDir, 'nonexistent-creds');

                writeFileSync(configPath, buildConfigIni(configProfiles, includeDefault), 'utf8');

                const parser = new AwsProfileParser({ configPath, credentialsPath });
                const result = parser.getProfiles();

                const expectedSet = new Set(configProfiles);
                if (includeDefault) {
                    expectedSet.add('default');
                }

                assert.strictEqual(result.length, expectedSet.size,
                    `Expected ${expectedSet.size} profiles, got ${result.length}: [${result.join(', ')}]`);

                for (const name of expectedSet) {
                    assert.ok(result.includes(name),
                        `Expected profile "${name}" in result: [${result.join(', ')}]`);
                }

                if (includeDefault) {
                    assert.strictEqual(result[0], 'default',
                        '\'default\' should be first when present');
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.1
     *
     * When only credentials file exists, profiles from that file are still returned.
     */
    it('returns profiles from credentials file when config file is missing', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileNames,
            fc.boolean(),
            (credProfiles, includeDefault) => {
                const configPath = join(tmpDir, 'nonexistent-config');
                const credentialsPath = join(tmpDir, `creds-only-${Math.random().toString(36).slice(2)}`);

                writeFileSync(credentialsPath, buildCredentialsIni(credProfiles, includeDefault), 'utf8');

                const parser = new AwsProfileParser({ configPath, credentialsPath });
                const result = parser.getProfiles();

                const expectedSet = new Set(credProfiles);
                if (includeDefault) {
                    expectedSet.add('default');
                }

                assert.strictEqual(result.length, expectedSet.size,
                    `Expected ${expectedSet.size} profiles, got ${result.length}: [${result.join(', ')}]`);

                for (const name of expectedSet) {
                    assert.ok(result.includes(name),
                        `Expected profile "${name}" in result: [${result.join(', ')}]`);
                }

                if (includeDefault) {
                    assert.strictEqual(result[0], 'default',
                        '\'default\' should be first when present');
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
