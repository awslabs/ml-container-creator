// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL080: `mcc hey --from-plan [file]` CLI wiring.
 *
 * These tests exercise the Node wrapper's flag handling:
 *  - --from-plan + --goal is rejected as mutually exclusive (exit 1) (Req 5.4)
 *
 * Full plan execution / dry-run / malformed-file behavior is validated at the
 * Python agent layer (test/unit/agent/test_from_plan.py) since it requires the
 * agent runtime.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'bin/cli.js');

/** Run the CLI allowing non-zero exit; capture output + exit code. */
function runCliSafe(args = [], { timeout = 30000 } = {}) {
    try {
        const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
            cwd: PROJECT_ROOT, timeout, stdio: 'pipe', encoding: 'utf8'
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (error) {
        return {
            stdout: error.stdout || '',
            stderr: error.stderr || '',
            exitCode: error.status ?? 1
        };
    }
}

describe('BL080: mcc hey --from-plan CLI wiring', () => {
    describe('5.4 mutual exclusion with --goal', () => {
        it('exits with code 1 when both --from-plan and --goal are provided', () => {
            const result = runCliSafe(['hey', '--from-plan', 'plan.json', '--goal', 'deploy']);
            assert.strictEqual(result.exitCode, 1);
            const combined = result.stdout + result.stderr;
            assert.ok(
                /mutually exclusive/i.test(combined),
                `expected a mutual-exclusion error, got: ${combined}`
            );
        });
    });
});
