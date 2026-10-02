// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wave 6 (ADR-007): the shared AWS credential-preflight helper.
 *
 * Verifies at the template level (deterministic — no generator var plumbing):
 *   1. templates/do/lib/aws-preflight.sh exists and defines _aws_preflight,
 *      exports AWS_ACCOUNT_ID, and fails with the reserved general-error exit 1.
 *   2. Every do/ script (top-level + deploy.d/ + clean.d/) that CALLS
 *      _aws_preflight also SOURCES lib/aws-preflight.sh — the source-ordering
 *      contract that keeps the migrated scripts runnable in generated projects.
 *   3. No migrated script still open-codes the preflight block it was supposed
 *      to have replaced (guards against a half-migration regressing).
 *
 * The `.sh` lib files ship into generated projects via the same whole-do/-tree
 * copy that already emits script-contract.sh and profile.sh, so a template-level
 * assertion is sufficient and avoids coupling to the full generation var set.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DO_DIR = resolve(__dirname, '../../templates/do');
const HELPER = join(DO_DIR, 'lib', 'aws-preflight.sh');

/** Recursively list files under templates/do/, skipping lib/ (the helpers). */
function walkDoScripts(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'lib' || entry.name === '__pycache__') continue;
            out.push(...walkDoScripts(p));
        } else if (entry.isFile() && !entry.name.endsWith('.py') && !entry.name.endsWith('.json')) {
            out.push(p);
        }
    }
    return out;
}

describe('do/ aws-preflight helper (ADR-007)', () => {
    it('lib/aws-preflight.sh exists and defines the helper', () => {
        assert.ok(statSync(HELPER).isFile(), 'templates/do/lib/aws-preflight.sh must exist');
        const t = readFileSync(HELPER, 'utf-8');
        assert.ok(t.includes('_aws_preflight()'), 'must define _aws_preflight');
        assert.ok(/export AWS_ACCOUNT_ID/.test(t), 'must export AWS_ACCOUNT_ID');
        // Credential failure is a general runtime error → exit 1 (never the
        // undocumented exit 4 the copies used, and not the contract code 3).
        assert.ok(/exit 1/.test(t), 'must exit 1 on failure');
        assert.ok(!/exit 4/.test(t), 'must not use the retired exit 4');
    });

    const scripts = walkDoScripts(DO_DIR);

    it('every script that calls _aws_preflight also sources lib/aws-preflight.sh', () => {
        const callers = scripts.filter(p =>
            /(^|[^_])_aws_preflight\b/m.test(readFileSync(p, 'utf-8')));
        assert.ok(callers.length >= 8,
            `expected the migrated scripts to call _aws_preflight, found ${callers.length}`);
        for (const p of callers) {
            const t = readFileSync(p, 'utf-8');
            assert.ok(t.includes('lib/aws-preflight.sh'),
                `${relative(DO_DIR, p)} calls _aws_preflight but does not source lib/aws-preflight.sh`);
        }
    });

    it('no migrated script still open-codes an AWS-creds preflight block', () => {
        // A "preflight block" = an `if ! aws sts get-caller-identity ...` guard.
        // Inline uses inside command substitution (e.g. bucket defaults) are fine.
        for (const p of scripts) {
            const lines = readFileSync(p, 'utf-8').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (/if\s*!\s*aws sts get-caller-identity/.test(lines[i])) {
                    // clean.d/* (except eks) are deferred to BL132 — allow those.
                    const rel = relative(DO_DIR, p);
                    const deferred = rel.startsWith('clean.d/') && !rel.endsWith('clean.d/eks');
                    assert.ok(deferred,
                        `${rel}:${i + 1} still open-codes an AWS-creds preflight block (should use _aws_preflight)`);
                }
            }
        }
    });
});
