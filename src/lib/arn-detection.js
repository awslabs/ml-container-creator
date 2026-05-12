// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ARN Detection Utility
 *
 * Provides a pure function for distinguishing AWS Secrets Manager ARNs
 * from plaintext values. Used by the prompt flow and CLI to determine
 * whether user input should be treated as a secret reference or a
 * literal token value.
 */

const SECRETS_MANAGER_ARN_PREFIX = 'arn:aws:secretsmanager:';

/**
 * Determines if a value is a Secrets Manager ARN.
 * @param {*} value - The input value to check
 * @returns {boolean} True if the value is a Secrets Manager ARN
 */
export function isSecretsManagerArn(value) {
    return typeof value === 'string' && value.startsWith(SECRETS_MANAGER_ARN_PREFIX);
}
