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

/**
 * Config for property tests that run FULL project generation per iteration
 * (spawn the CLI / call writeProject, then package/execute artifacts). These
 * are 25s–120s per case at NUM_RUNS=100 and dominate the property-suite wall
 * time (see docs/dev/test-inventory.md, R3). They exercise the same generation
 * code path on every run, so a lower iteration count still covers the input
 * space meaningfully while keeping the suite tractable.
 *
 * Runs are capped (default 20, CI honors the lower of PROPERTY_NUM_RUNS and the
 * cap) so an env that raises PROPERTY_NUM_RUNS for logic tests does not blow up
 * the generation tests. Override the cap with PROPERTY_GEN_NUM_RUNS.
 */
export const GEN_NUM_RUNS = (() => {
    const cap = parseInt(process.env.PROPERTY_GEN_NUM_RUNS || '20', 10);
    return Math.min(NUM_RUNS, cap);
})();

export const PROPERTY_CONFIG_GEN = {
    numRuns: GEN_NUM_RUNS,
    timeout: 120000,
    verbose: false
};
