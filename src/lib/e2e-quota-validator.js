// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Quota Validator
 *
 * Validates that the AWS account has sufficient service quotas for the
 * instance types required by a given tier in the e2e catalog.
 *
 * Requirements: 3.3, 3.4
 */

import { ServiceQuotasClient, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { filterByTier } from './e2e-catalog-validator.js';

/**
 * Instance type to Service Quotas quota code mapping.
 * SageMaker real-time endpoint instance quotas follow a naming pattern.
 * This map covers the instance types used in the e2e catalog.
 */
const INSTANCE_QUOTA_CODES = {
    'ml.g6e.xlarge': 'L-2D6591FA',
    'ml.g6e.2xlarge': 'L-2D6591FA',
    'ml.g6e.4xlarge': 'L-2D6591FA',
    'ml.g6e.12xlarge': 'L-2D6591FA',
    'ml.g5.xlarge': 'L-0100B498',
    'ml.g5.2xlarge': 'L-0100B498',
    'ml.m5.xlarge': 'L-ABB2FAC3',
    'ml.p5.48xlarge': 'L-E89A212B'
};

const SAGEMAKER_SERVICE_CODE = 'sagemaker';

/**
 * Parse the instance type from a CLI args string.
 *
 * Looks for `--instance-type=<value>` or `--instance-type <value>` patterns.
 *
 * @param {string} args - The CLI args string
 * @returns {string|null} The instance type value, or null if not found
 */
export function parseInstanceType(args) {
    if (!args || typeof args !== 'string') {
        return null;
    }

    // Match --instance-type=value or --instance-type value
    const equalMatch = args.match(/--instance-type=(\S+)/);
    if (equalMatch) {
        return equalMatch[1];
    }

    const spaceMatch = args.match(/--instance-type\s+(\S+)/);
    if (spaceMatch) {
        return spaceMatch[1];
    }

    return null;
}

/**
 * Sum instance counts per type for a given tier in the catalog.
 *
 * @param {string} tier - The tier to filter by
 * @param {Object} catalog - The catalog object
 * @returns {Map<string, number>} Map of instance type to required count
 */
export function sumInstanceRequirements(tier, catalog) {
    const configs = filterByTier(catalog, tier);
    const counts = new Map();

    for (const config of configs) {
        const instanceType = parseInstanceType(config.args);
        if (instanceType) {
            counts.set(instanceType, (counts.get(instanceType) || 0) + 1);
        }
    }

    return counts;
}

/**
 * Validate that the AWS account has sufficient quotas for the instance types
 * required by a given tier.
 *
 * @param {string} tier - The tier to validate quotas for
 * @param {Object} catalog - The catalog object
 * @param {string} region - The AWS region to check quotas in
 * @param {Object} [options] - Optional configuration
 * @param {Object} [options.client] - Pre-configured ServiceQuotasClient (for testing)
 * @returns {Promise<Array<{instanceType: string, required: number, available: number, sufficient: boolean}>>}
 */
export async function validateQuotas(tier, catalog, region, options = {}) {
    const instanceRequirements = sumInstanceRequirements(tier, catalog);
    const results = [];

    if (instanceRequirements.size === 0) {
        return results;
    }

    const client = options.client || new ServiceQuotasClient({ region });

    for (const [instanceType, required] of instanceRequirements) {
        const quotaCode = INSTANCE_QUOTA_CODES[instanceType];
        let available = 0;

        if (quotaCode) {
            try {
                const command = new GetServiceQuotaCommand({
                    ServiceCode: SAGEMAKER_SERVICE_CODE,
                    QuotaCode: quotaCode
                });
                const response = await client.send(command);
                available = response.Quota?.Value ?? 0;
            } catch (err) {
                // If we can't fetch the quota, assume 0 and warn
                console.warn(`⚠️  Could not fetch quota for ${instanceType}: ${err.message}`);
                available = 0;
            }
        } else {
            console.warn(`⚠️  No quota code mapping for ${instanceType}, skipping quota check`);
            available = 0;
        }

        const sufficient = available >= required;

        if (!sufficient) {
            console.warn(`⚠️  ${instanceType} quota is ${available}, need ${required} for ${tier} tier`);
        }

        results.push({ instanceType, required, available, sufficient });
    }

    return results;
}
