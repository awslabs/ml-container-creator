// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune Dataset Validator
 *
 * Parses dataset arguments (S3 URIs and Hugging Face references) and
 * validates JSONL dataset lines against catalog-driven schemas.
 *
 * Requirements: 3.1, 3.5, 3.6, 3.7, 3.8, 3.10, 3.11, 3.12
 */

/**
 * Parse a dataset argument string into a structured object.
 * Accepts S3 URIs (`s3://bucket/key`) or Hugging Face references
 * (`hf://org/name` or `hf://org/name/split`).
 *
 * @param {string} datasetStr - The dataset argument string
 * @returns {{ valid: boolean, type?: string, bucket?: string, key?: string, org?: string, name?: string, split?: string, error?: string }}
 */
export function parseDatasetArg(datasetStr) {
    if (!datasetStr || typeof datasetStr !== 'string') {
        return {
            valid: false,
            error: 'Dataset argument is required and must be a non-empty string.'
        };
    }

    const trimmed = datasetStr.trim();

    if (trimmed.startsWith('s3://')) {
        return _parseS3Uri(trimmed);
    }

    if (trimmed.startsWith('hf://')) {
        return _parseHfReference(trimmed);
    }

    return {
        valid: false,
        error: `Invalid dataset format: "${trimmed}". Expected s3://bucket/key or hf://org/name[/split].`
    };
}

/**
 * Validate JSONL lines against a dataset schema from the catalog.
 * Inspects only the first 10 lines per requirement.
 *
 * @param {string[]} lines - Array of JSONL line strings
 * @param {Object} schema - The datasetSchema object from the catalog
 * @param {string[]} schema.required - Array of required top-level keys
 * @param {Object} schema.types - Object mapping key to expected type ("string", "array", "object", "number")
 * @returns {{ valid: boolean, error: string|null, lineNumber: number|null, malformedLine: string|null, expectedFormat: string|null }}
 */
export function validateDatasetFormat(lines, schema) {
    if (!lines || !Array.isArray(lines)) {
        return {
            valid: false,
            error: 'Lines must be provided as an array.',
            lineNumber: null,
            malformedLine: null,
            expectedFormat: _buildExpectedFormat(schema)
        };
    }

    if (!schema || !schema.required || !Array.isArray(schema.required)) {
        return {
            valid: false,
            error: 'Schema must include a "required" array of keys.',
            lineNumber: null,
            malformedLine: null,
            expectedFormat: null
        };
    }

    const linesToInspect = lines.slice(0, 10);

    for (let i = 0; i < linesToInspect.length; i++) {
        const line = linesToInspect[i];
        const lineNumber = i + 1;

        // Skip empty lines
        if (!line || line.trim() === '') {
            continue;
        }

        // Try to parse as JSON
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            return {
                valid: false,
                error: `Line ${lineNumber} is not valid JSON: ${e.message}`,
                lineNumber,
                malformedLine: line,
                expectedFormat: _buildExpectedFormat(schema)
            };
        }

        // Check that parsed value is an object
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return {
                valid: false,
                error: `Line ${lineNumber} must be a JSON object.`,
                lineNumber,
                malformedLine: line,
                expectedFormat: _buildExpectedFormat(schema)
            };
        }

        // Check required keys
        for (const key of schema.required) {
            if (!Object.hasOwn(parsed, key)) {
                return {
                    valid: false,
                    error: `Line ${lineNumber} is missing required key "${key}".`,
                    lineNumber,
                    malformedLine: line,
                    expectedFormat: _buildExpectedFormat(schema)
                };
            }
        }

        // Check types if specified
        if (schema.types) {
            for (const [key, expectedType] of Object.entries(schema.types)) {
                if (!Object.hasOwn(parsed, key)) {
                    continue;
                }

                const value = parsed[key];
                if (!_checkType(value, expectedType)) {
                    return {
                        valid: false,
                        error: `Line ${lineNumber} has key "${key}" with wrong type. Expected "${expectedType}", got "${_getType(value)}".`,
                        lineNumber,
                        malformedLine: line,
                        expectedFormat: _buildExpectedFormat(schema)
                    };
                }
            }
        }
    }

    return {
        valid: true,
        error: null,
        lineNumber: null,
        malformedLine: null,
        expectedFormat: null
    };
}

/**
 * Parse an S3 URI into bucket and key components.
 * @param {string} uri - The S3 URI (e.g., "s3://bucket/path/to/file.jsonl")
 * @returns {Object} Parsed result
 * @private
 */
function _parseS3Uri(uri) {
    const withoutScheme = uri.slice(5); // Remove "s3://"
    const slashIndex = withoutScheme.indexOf('/');

    if (slashIndex === -1 || slashIndex === 0) {
        return {
            valid: false,
            error: `Invalid S3 URI: "${uri}". Expected format: s3://bucket/key.`
        };
    }

    const bucket = withoutScheme.slice(0, slashIndex);
    const key = withoutScheme.slice(slashIndex + 1);

    if (!bucket) {
        return {
            valid: false,
            error: `Invalid S3 URI: "${uri}". Bucket name is empty.`
        };
    }

    if (!key) {
        return {
            valid: false,
            error: `Invalid S3 URI: "${uri}". Key path is empty.`
        };
    }

    return {
        valid: true,
        type: 's3',
        bucket,
        key
    };
}

/**
 * Parse a Hugging Face dataset reference into org, name, and split.
 * Defaults to 'train' split if not specified.
 * @param {string} ref - The HF reference (e.g., "hf://org/name" or "hf://org/name/split")
 * @returns {Object} Parsed result
 * @private
 */
function _parseHfReference(ref) {
    const withoutScheme = ref.slice(5); // Remove "hf://"
    const parts = withoutScheme.split('/');

    if (parts.length < 2 || !parts[0] || !parts[1]) {
        return {
            valid: false,
            error: `Invalid Hugging Face reference: "${ref}". Expected format: hf://org/name[/split].`
        };
    }

    const org = parts[0];
    const name = parts[1];
    const split = parts.length >= 3 && parts[2] ? parts[2] : 'train';

    return {
        valid: true,
        type: 'hf',
        org,
        name,
        split
    };
}

/**
 * Check if a value matches the expected schema type.
 * @param {*} value - The value to check
 * @param {string} expectedType - One of "string", "array", "object", "number"
 * @returns {boolean} True if the value matches the expected type
 * @private
 */
function _checkType(value, expectedType) {
    switch (expectedType) {
    case 'string':
        return typeof value === 'string';
    case 'number':
        return typeof value === 'number';
    case 'array':
        return Array.isArray(value);
    case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
        return true;
    }
}

/**
 * Get a human-readable type name for a value.
 * @param {*} value - The value to describe
 * @returns {string} The type name
 * @private
 */
function _getType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/**
 * Build a human-readable expected format description from a schema.
 * @param {Object} schema - The dataset schema
 * @returns {string|null} Description of expected format
 * @private
 */
function _buildExpectedFormat(schema) {
    if (!schema || !schema.required) {
        return null;
    }

    const fields = schema.required.map(key => {
        const type = schema.types && schema.types[key] ? schema.types[key] : 'any';
        return `"${key}": <${type}>`;
    });

    return `Each line must be a JSON object with: {${fields.join(', ')}}`;
}
