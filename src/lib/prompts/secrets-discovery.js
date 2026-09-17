// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Manager discovery helpers for prompt-time secret selection.
 *
 * BL067: Provides SDK-based discovery and creation of Secrets Manager secrets
 * for use in interactive prompts (HuggingFace token, NGC API key, etc.).
 *
 * Designed for reuse across multiple secret types (Requirement 6.1).
 */

import {
    SecretsManagerClient,
    ListSecretsCommand,
    CreateSecretCommand
} from '@aws-sdk/client-secrets-manager';
import { fromIni } from '@aws-sdk/credential-providers';

/**
 * Build a SecretsManagerClient respecting the given profile and region.
 * @param {string} awsProfile - AWS profile name for credentials
 * @param {string} region - AWS region
 * @returns {SecretsManagerClient}
 */
function buildClient(awsProfile, region) {
    const clientConfig = { region };
    if (awsProfile) {
        clientConfig.credentials = fromIni({ profile: awsProfile });
    }
    return new SecretsManagerClient(clientConfig);
}

/**
 * Query Secrets Manager for secrets matching a name filter.
 * Returns an array of { name, arn } or an empty array on any error.
 * Never throws.
 *
 * @param {string} nameFilter - Name prefix filter (e.g., 'huggingface', 'hf-token')
 * @param {string} awsProfile - AWS profile name for credentials
 * @param {string} region - AWS region
 * @returns {Promise<Array<{name: string, arn: string}>>}
 */
export async function discoverSecrets(nameFilter, awsProfile, region) {
    try {
        const client = buildClient(awsProfile, region);
        const command = new ListSecretsCommand({
            Filters: [{ Key: 'name', Values: [nameFilter] }]
        });
        const response = await client.send(command);
        const secretList = response.SecretList || [];
        return secretList.map(secret => ({
            name: secret.Name,
            arn: secret.ARN
        }));
    } catch {
        return [];
    }
}

/**
 * Patterns that indicate a placeholder / test token value that must never be
 * written to Secrets Manager (BL091). These are values used by tests and docs
 * examples, not real credentials — creating a secret from one produces a broken
 * secret that later causes "Access denied" when pulling gated models.
 */
const PLACEHOLDER_SECRET_PATTERNS = [
    /^hf_new_token/i,
    /^hf_test/i,
    /^hf_fallback/i,
    /^placeholder/i,
    /^test[-_]?token/i,
    /^changeme/i,
    /^xxx+$/i
];

/**
 * Return true if the given secret value looks like a placeholder / test value
 * rather than a real credential.
 * @param {string} value
 * @returns {boolean}
 */
export function isPlaceholderSecretValue(value) {
    if (typeof value !== 'string' || value.trim() === '') return true;
    return PLACEHOLDER_SECRET_PATTERNS.some(re => re.test(value.trim()));
}

/**
 * Create a new secret in Secrets Manager.
 * Returns { arn } on success; throws on failure.
 *
 * @param {string} name - Secret name
 * @param {string} value - Secret string value
 * @param {string} awsProfile - AWS profile name for credentials
 * @param {string} region - AWS region
 * @returns {Promise<{arn: string}>}
 * @throws {Error} If the CreateSecretCommand fails
 */
export async function createSecret(name, value, awsProfile, region) {
    // BL091: refuse to write placeholder/test values as real secrets. This is a
    // safety guard against test fixtures or docs examples reaching a live AWS call.
    if (isPlaceholderSecretValue(value)) {
        throw new Error(
            `Refusing to create secret "${name}": the provided value looks like a ` +
            'placeholder or test token, not a real credential. Enter your actual token.'
        );
    }
    const client = buildClient(awsProfile, region);
    const command = new CreateSecretCommand({
        Name: name,
        SecretString: value,
        Tags: [
            { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
            { Key: 'mlcc:secret-type', Value: 'hf-token' }
        ]
    });
    const response = await client.send(command);
    return { arn: response.ARN };
}
