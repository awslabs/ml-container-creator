// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * KEY=VALUE Parser Utility
 *
 * Parses KEY=VALUE strings for --model-env and --server-env CLI flags.
 * Splits only on the first '=' character, allowing values to contain
 * additional '=' characters.
 *
 * Requirements: 3.4, 3.5, 4.4, 4.5
 */

import { ValidationError } from './config-manager.js';

/**
 * Parse a KEY=VALUE string, splitting only on the first '=' character.
 * @param {string} input - Raw CLI value (e.g., "TENSOR_PARALLEL_SIZE=4")
 * @returns {{ key: string, value: string }}
 * @throws {ValidationError} if no '=' is present
 */
export function parseKeyValue(input) {
    const idx = input.indexOf('=');

    if (idx === -1) {
        throw new ValidationError(
            `Invalid format for env var: expected KEY=VALUE, got '${input}'`,
            'env',
            input
        );
    }

    const key = input.substring(0, idx);
    const value = input.substring(idx + 1);

    return { key, value };
}
