// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wave 6 (ADR-007): do/ script contract CONFORMANCE.
 *
 * The guard *behavior* is tested in do-script-contracts.test.js via synthetic
 * scripts. This file does the thing that was missing: it iterates every real
 * top-level `do/` script shipped in templates/do/ and validates that each one
 * actually follows the documented contract (docs/do-script-contract.md):
 *
 *   - a `#!/bin/bash` shebang on line 1, followed by the copyright + SPDX header
 *     BEFORE the @mlcc-script block;
 *   - an @mlcc-script block with all four fields, each a valid enum value;
 *   - it sources lib/script-contract.sh (the enforcer).
 *
 * Two documented exceptions (see ADR-007):
 *   - `config`  is a sourced data file: it carries the contract block for the
 *     agent, but is not an executable step and does not source the enforcer.
 *   - `manifest` is a thin Node shim: it sources the enforcer but delegates to
 *     lib/manifest-cli.js instead of sourcing config/profile.
 *
 * It also asserts that any hand-rolled target-restriction ("not supported on")
 * exits with the reserved contract-violation code 3 — not 1 or 4.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DO_DIR = resolve(__dirname, '../../templates/do');

// Valid enum values per docs/do-script-contract.md.
const VALID_TYPE = ['model-centric', 'deployment-centric', 'hybrid'];
const VALID_GUARD = ['none', 'artifact-ready', 'model-staged', 'deployment-active', 'training-infra'];
const VALID_LIFECYCLE = [
    'configuration', 'build', 'local-test', 'pre-deploy', 'publish', 'deploy',
    'monitor', 'post-deploy', 'teardown', 'training', 'ci', 'metadata'
];
// `eks` = EKS without the HyperPod Inference Operator (first-class, currently
// untested/unvalidated). It is a supported DEPLOYMENT_TARGET, not deprecated.
const VALID_TARGETS = ['realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks', 'eks'];

// Documented exceptions (ADR-007):
//   - `config` is a sourced data file: it does not source the enforcer.
//   - `manifest` is a Node shim: it sources the enforcer but not config/profile,
//     so it still passes every check here (no special-case needed).
const DATA_FILE = 'config';         // sourced data file — exempt from enforcer-source check
const NOT_A_SCRIPT = ['README.md'];

/**
 * Enumerate contract-bearing top-level do/ scripts: every regular file in
 * templates/do/ that is not README and not a dotfile helper (.foo.py).
 */
function listDoScripts() {
    return readdirSync(DO_DIR)
        .filter(name => !NOT_A_SCRIPT.includes(name))
        .filter(name => !name.startsWith('.'))
        .filter(name => statSync(join(DO_DIR, name)).isFile())
        .sort();
}

/**
 * Extract the @mlcc-script field values from a script's text.
 * @returns {{type,guard,lifecycle,targets}|null}
 */
function parseContract(text) {
    if (!text.includes('@mlcc-script')) return null;
    const field = (name) => {
        const m = text.match(new RegExp(`^#\\s*${name}:\\s*(.+?)\\s*$`, 'm'));
        return m ? m[1].trim() : null;
    };
    return {
        type: field('type'),
        guard: field('guard'),
        lifecycle: field('lifecycle'),
        targets: field('targets')
    };
}

function parseTargets(raw) {
    if (!raw) return null;
    if (raw === 'all') return 'all';
    return raw.split(',').map(t => t.trim()).filter(Boolean);
}

const scripts = listDoScripts();

describe('do/ contract conformance — every shipped script (ADR-007)', () => {
    it('found the expected set of top-level scripts', () => {
        // Sanity: the enumeration should include the well-known verbs and config.
        assert.ok(scripts.includes('build'));
        assert.ok(scripts.includes('deploy'));
        assert.ok(scripts.includes('draft'), 'draft must be enumerated (registry drift)');
        assert.ok(scripts.includes('config'));
        assert.ok(scripts.length >= 24, `expected >=24 scripts, got ${scripts.length}`);
    });

    for (const name of scripts) {
        describe(`do/${name}`, () => {
            const text = readFileSync(join(DO_DIR, name), 'utf-8');
            const lines = text.split('\n');

            it('carries an @mlcc-script contract block', () => {
                assert.ok(text.includes('@mlcc-script'),
                    `do/${name} is missing its @mlcc-script contract block`);
            });

            it('starts with a #!/bin/bash shebang', () => {
                assert.strictEqual(lines[0], '#!/bin/bash',
                    `do/${name} line 1 must be "#!/bin/bash", got: ${JSON.stringify(lines[0])}`);
            });

            it('has the copyright + SPDX header before the contract block', () => {
                const contractIdx = lines.findIndex(l => l.includes('@mlcc-script'));
                const header = lines.slice(0, contractIdx).join('\n');
                assert.ok(/Copyright Amazon\.com/.test(header),
                    `do/${name} must have the Copyright line before @mlcc-script`);
                assert.ok(/SPDX-License-Identifier:\s*Apache-2\.0/.test(header),
                    `do/${name} must have the SPDX header before @mlcc-script`);
            });

            it('declares all four contract fields with valid enum values', () => {
                const c = parseContract(text);
                assert.ok(c, `do/${name} contract block did not parse`);
                assert.ok(VALID_TYPE.includes(c.type), `do/${name} type invalid: ${c.type}`);
                assert.ok(VALID_GUARD.includes(c.guard), `do/${name} guard invalid: ${c.guard}`);
                assert.ok(VALID_LIFECYCLE.includes(c.lifecycle),
                    `do/${name} lifecycle invalid: ${c.lifecycle}`);
                const targets = parseTargets(c.targets);
                assert.ok(targets, `do/${name} targets missing`);
                if (targets !== 'all') {
                    for (const t of targets) {
                        assert.ok(VALID_TARGETS.includes(t),
                            `do/${name} targets has invalid value: ${t}`);
                    }
                }
            });

            if (name !== DATA_FILE) {
                it('sources lib/script-contract.sh (the enforcer)', () => {
                    assert.ok(text.includes('lib/script-contract.sh'),
                        `do/${name} must source lib/script-contract.sh`);
                });
            }

            // Any hand-rolled target restriction must exit with the reserved
            // contract-violation code 3 — either via the sanctioned primitives
            // (_restrict_targets / _contract_violation, which exit 3 internally)
            // or, if it uses a bare `exit`, that exit must be 3 (never 1/4).
            it('hand-rolled target restrictions exit with code 3', () => {
                const restrictionLines = lines
                    .map((l, i) => ({ l, i }))
                    .filter(({ l }) => /is not supported on/.test(l));
                for (const { i } of restrictionLines) {
                    // Look at the surrounding block for how it terminates. The
                    // phrase may sit inside a _contract_violation string argument,
                    // so include a few lines before the match as well as after.
                    const block = lines.slice(Math.max(0, i - 3), i + 8).join('\n');
                    const usesPrimitive = /_contract_violation|_restrict_targets/.test(block);
                    if (usesPrimitive) {
                        continue; // primitives exit 3 by construction
                    }
                    const exitMatch = block.match(/exit\s+(\d+)/);
                    assert.ok(exitMatch,
                        `do/${name}: target-restriction near line ${i + 1} has no exit code (use _contract_violation or exit 3)`);
                    assert.strictEqual(exitMatch[1], '3',
                        `do/${name}: target-restriction near line ${i + 1} must exit 3, got ${exitMatch[1]}`);
                }
            });
        });
    }
});
