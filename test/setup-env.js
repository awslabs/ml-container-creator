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
 * We set ONLY `MLCC_SKIP_SECRET_DISCOVERY=1`. It fully activates the guard in
 * `_persistProfileSecret` that prevents tests from mutating the real bootstrap
 * config (`~/.ml-container-creator/config.json`) and skips runtime secret
 * discovery. We deliberately do NOT set `NODE_ENV=test` globally: that value
 * also flips an unrelated branch in `src/lib/mcp-query-runner.js` (throw-instead-
 * of-prompt on instance-type validation failure), so forcing it process-wide
 * would widen the blast radius beyond the secret-write guard. Tests that need the
 * `NODE_ENV==='test'` branch set it locally in a try/finally.
 *
 * Individual tests that must exercise the real production write path (e.g. the
 * Property 2 test) clear this within a try/finally for their scope only.
 */
if (!process.env.MLCC_SKIP_SECRET_DISCOVERY) {
    process.env.MLCC_SKIP_SECRET_DISCOVERY = '1';
}
