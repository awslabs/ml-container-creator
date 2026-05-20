// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace ARN Validation Property-Based Tests
 *
 * Property 9: Invalid ARN format produces clear error
 *
 * For any string that does not match the model package ARN format
 * (arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>),
 * the generator SHALL reject the input with a clear error message
 * indicating the ARN format is invalid.
 *
 * Feature: marketplace-model-packages, Property 9: Invalid ARN format produces clear error
 *
 * **Validates: Requirements 8.4**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import CrossCuttingChecker from '../../src/lib/cross-cutting-checker.js';

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, seed: 42, verbose: false };

const MOCHA_TIMEOUT = PROPERTY_CONFIG.timeout + 5000;

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid AWS regions (for building valid ARNs as negative test)
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

// Valid 12-digit account IDs
const arbAccountId = fc.stringMatching(/^[0-9]{12}$/);

// Valid package names (starts with alphanumeric, then alphanumeric or hyphens)
const arbPackageName = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,20}$/);

// Valid version numbers (one or more digits)
const arbVersion = fc.integer({ min: 1, max: 999 }).map(v => String(v));

// Generator for valid ARNs (used as negative test — should NOT produce errors)
const arbValidArn = fc.tuple(
    arbAwsRegion,
    arbAccountId,
    arbPackageName,
    arbVersion
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// ── Invalid ARN generators ───────────────────────────────────────────────────

// Strategy 1: Completely random strings (very unlikely to match ARN format)
const arbRandomString = fc.string({ minLength: 1, maxLength: 100 });

// Strategy 2: Strings with wrong prefix
const arbWrongPrefix = fc.tuple(
    fc.constantFrom('arn:gcp:', 'arn:azure:', 'arn:aws:s3:', 'arn:aws:ec2:', 'arn:aws:lambda:', 'http://', 'https://', 's3://', ''),
    fc.string({ minLength: 1, maxLength: 50 })
).map(([prefix, rest]) => prefix + rest);

// Strategy 3: ARN-like strings with wrong service
const arbWrongService = fc.tuple(
    arbAwsRegion,
    arbAccountId,
    fc.constantFrom('s3', 'ec2', 'lambda', 'iam', 'dynamodb'),
    arbPackageName,
    arbVersion
).map(([region, account, service, name, version]) =>
    `arn:aws:${service}:${region}:${account}:model-package/${name}/${version}`
);

// Strategy 4: ARN with wrong account ID length (not 12 digits)
const arbWrongAccountLength = fc.tuple(
    arbAwsRegion,
    fc.oneof(
        fc.stringMatching(/^[0-9]{1,11}$/),
        fc.stringMatching(/^[0-9]{13,20}$/)
    ),
    arbPackageName,
    arbVersion
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Strategy 5: ARN with non-numeric account ID
const arbNonNumericAccount = fc.tuple(
    arbAwsRegion,
    fc.constantFrom('abcdefghijkl', 'abc!@#defghi', 'xxxxxxxxxxxx', 'aaa111bbb222'),
    arbPackageName,
    arbVersion
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Strategy 6: ARN missing model-package resource type
const arbMissingResourceType = fc.tuple(
    arbAwsRegion,
    arbAccountId,
    arbPackageName,
    arbVersion
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:${name}/${version}`
);

// Strategy 7: ARN missing version number
const arbMissingVersion = fc.tuple(
    arbAwsRegion,
    arbAccountId,
    arbPackageName
).map(([region, account, name]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}`
);

// Strategy 8: ARN with non-numeric version
const arbNonNumericVersion = fc.tuple(
    arbAwsRegion,
    arbAccountId,
    arbPackageName,
    fc.constantFrom('abc', 'v1', '1.0', 'latest', 'v2.1', 'beta')
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Strategy 9: ARN with invalid region (uppercase or special chars)
const arbInvalidRegion = fc.tuple(
    fc.constantFrom('US-EAST-1', 'Us-West-2', 'eu_west_1', 'ap.southeast.1', 'INVALID'),
    arbAccountId,
    arbPackageName,
    arbVersion
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Strategy 10: Empty or whitespace strings
const arbEmptyOrWhitespace = fc.constantFrom('', ' ', '  ', '\t', '\n');

// Combined invalid ARN generator (weighted toward more interesting cases)
const arbInvalidArn = fc.oneof(
    { weight: 2, arbitrary: arbRandomString },
    { weight: 2, arbitrary: arbWrongPrefix },
    { weight: 2, arbitrary: arbWrongService },
    { weight: 2, arbitrary: arbWrongAccountLength },
    { weight: 2, arbitrary: arbNonNumericAccount },
    { weight: 2, arbitrary: arbMissingResourceType },
    { weight: 2, arbitrary: arbMissingVersion },
    { weight: 2, arbitrary: arbNonNumericVersion },
    { weight: 1, arbitrary: arbInvalidRegion },
    { weight: 1, arbitrary: arbEmptyOrWhitespace }
);

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build a marketplace context for the cross-cutting checker.
 */
function buildMarketplaceContext(modelPackageArn) {
    return {
        payloads: {},
        config: {
            architecture: 'marketplace',
            modelPackageArn
        },
        deploymentTarget: 'realtime-inference',
        metadata: {
            generatedAt: new Date().toISOString(),
            generatorVersion: '0.2.5',
            services: ['sagemaker']
        }
    };
}

/**
 * The expected ARN pattern from the cross-cutting checker.
 */
const VALID_ARN_PATTERN = /^arn:aws:sagemaker:[a-z0-9-]+:\d{12}:model-package\/[a-zA-Z0-9]([a-zA-Z0-9\-])*\/\d+$/;

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 9: Invalid ARN format produces clear error', () => {

    const checker = new CrossCuttingChecker();

    it('for any string that does not match the ARN format, the checker produces an error finding with clear message', function () {
        this.timeout(MOCHA_TIMEOUT);

        fc.assert(fc.property(
            arbInvalidArn,
            (invalidArn) => {
                // Pre-condition: the string must NOT match the valid ARN pattern
                // (skip if the random generator accidentally produces a valid ARN)
                fc.pre(!VALID_ARN_PATTERN.test(invalidArn));

                // Also skip empty strings — the checker only validates when ARN is provided
                fc.pre(invalidArn.trim().length > 0);

                const context = buildMarketplaceContext(invalidArn);
                const findings = checker.checkMarketplaceCompatibility(context);

                // Filter to ARN format findings specifically
                const arnFindings = findings.filter(f =>
                    f.fieldPath === 'MODEL_PACKAGE_ARN' &&
                    f.constraint && f.constraint.type === 'arn-format'
                );

                // Must produce exactly one ARN format error
                assert.strictEqual(arnFindings.length, 1,
                    `Invalid ARN "${invalidArn}" should produce exactly one ARN format error, got ${arnFindings.length}`);

                // Verify the finding has correct structure
                const finding = arnFindings[0];
                assert.strictEqual(finding.severity, 'error');
                assert.strictEqual(finding.confidence, 'high');
                assert.strictEqual(finding.source, 'cross-cutting');
                assert.strictEqual(finding.invalidValue, invalidArn);

                // Verify the remediation hint contains the expected format
                assert.ok(
                    finding.remediationHint.includes('Invalid model package ARN format'),
                    `Remediation hint should mention invalid ARN format, got: "${finding.remediationHint}"`
                );
                assert.ok(
                    finding.remediationHint.includes('arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>'),
                    `Remediation hint should include expected format pattern, got: "${finding.remediationHint}"`
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose, interruptAfterTimeLimit: PROPERTY_CONFIG.timeout });
    });

    it('for any valid ARN, the checker does NOT produce an ARN format error', function () {
        this.timeout(MOCHA_TIMEOUT);

        fc.assert(fc.property(
            arbValidArn,
            (validArn) => {
                const context = buildMarketplaceContext(validArn);
                const findings = checker.checkMarketplaceCompatibility(context);

                // Filter to ARN format findings specifically
                const arnFindings = findings.filter(f =>
                    f.fieldPath === 'MODEL_PACKAGE_ARN' &&
                    f.constraint && f.constraint.type === 'arn-format'
                );

                // Must produce NO ARN format errors for valid ARNs
                assert.strictEqual(arnFindings.length, 0,
                    `Valid ARN "${validArn}" should produce no ARN format errors, got ${arnFindings.length}`);

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose, interruptAfterTimeLimit: PROPERTY_CONFIG.timeout });
    });

    it('for non-marketplace architecture, no ARN validation is performed regardless of ARN value', function () {
        this.timeout(MOCHA_TIMEOUT);

        fc.assert(fc.property(
            fc.tuple(
                arbInvalidArn,
                fc.constantFrom('transformers-vllm', 'transformers-sglang', 'sklearn-flask', 'xgboost-fastapi')
            ),
            ([invalidArn, architecture]) => {
                const context = {
                    payloads: {},
                    config: {
                        architecture,
                        modelPackageArn: invalidArn
                    },
                    deploymentTarget: 'realtime-inference',
                    metadata: {
                        generatedAt: new Date().toISOString(),
                        generatorVersion: '0.2.5',
                        services: ['sagemaker']
                    }
                };

                const findings = checker.checkMarketplaceCompatibility(context);

                // Non-marketplace architecture should return empty findings
                assert.strictEqual(findings.length, 0,
                    `Non-marketplace architecture "${architecture}" should not trigger ARN validation`);

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose, interruptAfterTimeLimit: PROPERTY_CONFIG.timeout });
    });
});
