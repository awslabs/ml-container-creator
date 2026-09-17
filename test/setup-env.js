// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mocha global setup (BL091 hardening).
 *
 * Mocha does NOT set NODE_ENV automatically, and this project runs with
 * `--parallel`, so each worker process must independently mark itself as a
 * test context. This file is loaded via `--require` in .mocharc.json for every
 * mocha process (main and parallel workers) BEFORE any test module is imported.
 *
 * Setting these env vars activates the runtime guards that prevent tests from
 * mutating the real bootstrap config (`~/.ml-container-creator/config.json`) or
 * performing real Secrets Manager side effects:
 *   - NODE_ENV=test                → `_persistProfileSecret` env-guard no-op
 *   - MLCC_SKIP_SECRET_DISCOVERY=1 → same guard + skips runtime secret discovery
 *
 * Individual tests that must exercise the real production write path (e.g. the
 * Property 2 test) clear these within a try/finally for their scope only.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.MLCC_SKIP_SECRET_DISCOVERY) {
    process.env.MLCC_SKIP_SECRET_DISCOVERY = '1';
}
