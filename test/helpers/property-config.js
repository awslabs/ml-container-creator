// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared property test configuration.
 * Import this in ALL property tests instead of defining numRuns inline.
 *
 * CI sets PROPERTY_NUM_RUNS=30 for speed.
 * Local default is 100 for thorough coverage.
 */

export const NUM_RUNS = parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10);

export const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 30000,
    verbose: false
};

// Extended config for tests that render EJS templates (slower per iteration)
export const PROPERTY_CONFIG_EJS = {
    numRuns: NUM_RUNS,
    timeout: 60000,
    verbose: false
};
