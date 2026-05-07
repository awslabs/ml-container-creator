// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sensitive Value Redactor
 *
 * Detects keys matching sensitive patterns and replaces their values
 * with a redaction marker. Used by the do/register template to sanitize
 * parameters before writing to DynamoDB.
 *
 * Requirements: 6.5
 */

/**
 * Redaction marker used to replace sensitive values.
 */
export const REDACTION_MARKER = '***REDACTED***';

/**
 * Exact key names that are always considered sensitive.
 */
export const SENSITIVE_EXACT_KEYS = ['HF_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

/**
 * Substrings that, when found in a key (case-insensitive), mark it as sensitive.
 */
export const SENSITIVE_SUBSTRINGS = ['SECRET', 'TOKEN'];

/**
 * Determine whether a given key matches sensitive patterns.
 *
 * A key is sensitive if:
 * - It exactly matches one of SENSITIVE_EXACT_KEYS
 * - Its uppercase form contains any of SENSITIVE_SUBSTRINGS
 *
 * @param {string} key - The environment variable key to check
 * @returns {boolean} True if the key is sensitive
 */
export function isSensitiveKey(key) {
    if (SENSITIVE_EXACT_KEYS.includes(key)) return true;
    const upper = key.toUpperCase();
    return SENSITIVE_SUBSTRINGS.some(sub => upper.includes(sub));
}

/**
 * Redact sensitive values in a parameters object.
 * Returns a new object with sensitive values replaced by the redaction marker.
 * Non-sensitive values are preserved unchanged.
 *
 * @param {Object<string, string>} params - Key-value map of parameters
 * @returns {Object<string, string>} New object with sensitive values redacted
 */
export function redactSensitiveValues(params) {
    const result = {};
    for (const [key, value] of Object.entries(params)) {
        result[key] = isSensitiveKey(key) ? REDACTION_MARKER : value;
    }
    return result;
}
