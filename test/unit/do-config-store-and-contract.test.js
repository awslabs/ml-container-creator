// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioural tests for the do/ contract hardening (improvement plan DO-1..DO-4):
 *
 *   - lib/config-store.sh `_config_set` / `_config_unset`: values containing sed /
 *     shell metacharacters round-trip exactly through `source do/config`; duplicate
 *     keys collapse; a missing trailing newline never glues two exports; the file
 *     mode survives; invalid keys and multi-line values are refused.
 *   - No do/ script writes do/config with a hand-rolled `sed -i "s|^export …"`.
 *   - lib/script-contract.sh: restores the caller's nounset setting (DO-1), prints
 *     usage + exits 0 for --help when the guard is not met (DO-2), and reports an
 *     unknown `# guard:` as a contract violation, exit 3 (DO-3).
 *
 * Runs real bash (3.2 on macOS) against the real template files.
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DO_SRC = join(ROOT, 'templates', 'do');
const BASH = '/bin/bash';

function bash(script, { cwd, args = [] } = {}) {
    return spawnSync(BASH, ['-c', script, 'bash', ...args], { cwd, encoding: 'utf8', env: { ...process.env, VIRTUAL_ENV: '' } });
}

describe('do/ config-store (_config_set / _config_unset)', () => {
    let dir;
    const store = join(DO_SRC, 'lib', 'config-store.sh');
    before(() => { dir = mkdtempSync(join(tmpdir(), 'mlcc-cfgstore-')); });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('round-trips values with sed and shell metacharacters exactly', () => {
        const cfg = join(dir, 'config-rt');
        writeFileSync(cfg, 'export A="old"\n');
        const value = 'p|q&r\\s"t$u`v w/x#y';
        const r = bash(`source "${store}"; _config_set A "$1" "${cfg}" && source "${cfg}" && printf '%s' "$A"`, { args: [value] });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.strictEqual(r.stdout, value);
    });

    it('collapses duplicate keys, appends new keys, and fixes a missing trailing newline', () => {
        const cfg = join(dir, 'config-dup');
        writeFileSync(cfg, 'export A="1"\nexport B="2"\nexport A="dup"'); // no trailing newline
        chmodSync(cfg, 0o640);
        const r = bash(`source "${store}"; _config_set A new "${cfg}"; _config_set C 3 "${cfg}"; _config_unset B "${cfg}"`);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.strictEqual(readFileSync(cfg, 'utf8'), 'export A="new"\nexport C="3"\n');
        assert.strictEqual(statSync(cfg).mode & 0o777, 0o640, 'file mode is preserved');
    });

    it('creates the file when absent; unset on a missing file is a no-op', () => {
        const cfg = join(dir, 'config-new');
        const r = bash(`source "${store}"; _config_unset X "${cfg}.none" && _config_set N v "${cfg}"`);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.strictEqual(readFileSync(cfg, 'utf8'), 'export N="v"\n');
    });

    it('refuses invalid keys and multi-line values without touching the file', () => {
        const cfg = join(dir, 'config-bad');
        writeFileSync(cfg, 'export A="1"\n');
        for (const [key, val] of [['bad-key', 'x'], ['1X', 'x'], ['OK', 'a\nb']]) {
            const r = bash(`source "${store}"; _config_set "$1" "$2" "${cfg}"`, { args: [key, val] });
            assert.notStrictEqual(r.status, 0, `${key} should be refused`);
        }
        assert.strictEqual(readFileSync(cfg, 'utf8'), 'export A="1"\n');
    });

    it('no do/ script edits do/config with a hand-rolled sed substitution', () => {
        const offenders = [];
        const walk = (d) => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                const p = join(d, e.name);
                if (e.isDirectory()) {
                    if (e.name !== '__pycache__' && e.name !== 'python') walk(p);
                } else if (e.name !== 'config-store.sh') {
                    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
                        if (/sed -i[^\n]*s\|\^export /.test(line)) offenders.push(`${p.slice(ROOT.length + 1)}:${i + 1}`);
                    });
                }
            }
        };
        walk(DO_SRC);
        assert.deepStrictEqual(offenders, [], 'use _config_set (lib/config-store.sh) instead');
    });
});

describe('do/ script contract (nounset, --help, unknown guard)', () => {
    let proj;
    const writeScript = (name, guard, body) => {
        const p = join(proj, 'do', name);
        writeFileSync(p, [
            '#!/bin/bash',
            '# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.',
            '# SPDX-License-Identifier: Apache-2.0',
            '#',
            `# do/${name} — a test script.`,
            '#',
            `# Usage: ./do/${name} [--help]`,
            '#',
            '# @mlcc-script',
            '# type: deployment-centric',
            `# guard: ${guard}`,
            '# lifecycle: monitor',
            '# targets: all',
            '',
            'set -e',
            'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
            'source "${SCRIPT_DIR}/lib/script-contract.sh"',
            body,
            ''
        ].join('\n'));
        chmodSync(p, 0o755);
        return p;
    };
    before(() => {
        proj = mkdtempSync(join(tmpdir(), 'mlcc-contract-'));
        mkdirSync(join(proj, 'do', 'lib'), { recursive: true });
        for (const f of ['script-contract.sh', 'config-store.sh']) {
            copyFileSync(join(DO_SRC, 'lib', f), join(proj, 'do', 'lib', f));
        }
        writeFileSync(join(proj, 'do', 'lib', 'profile.sh'), ':\n');
        // Nothing deployed: the deployment-active guard is NOT met.
        writeFileSync(join(proj, 'do', 'config'), 'export DEPLOYMENT_TARGET="realtime-inference"\nexport DEPLOYMENT_TARGET_SMAI_STATUS=""\n');
    });
    after(() => rmSync(proj, { recursive: true, force: true }));

    it('does not impose nounset on a script that only declared set -e', () => {
        const s = writeScript('nounset-probe', 'none', 'case $- in *u*) echo NOUNSET_ON ;; *) echo NOUNSET_OFF ;; esac');
        const r = spawnSync(BASH, [s], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /NOUNSET_OFF/);
    });

    it('keeps nounset for a script that enabled it before sourcing the contract', () => {
        const s = writeScript('nounset-keep', 'none', 'case $- in *u*) echo NOUNSET_ON ;; *) echo NOUNSET_OFF ;; esac');
        writeFileSync(s, readFileSync(s, 'utf8').replace('set -e\n', 'set -e\nset -u\n'));
        const r = spawnSync(BASH, [s], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /NOUNSET_ON/);
    });

    it('--help on an unmet guard prints the header usage and exits 0', () => {
        const s = writeScript('helpme', 'deployment-active', 'echo SHOULD_NOT_RUN');
        for (const flag of ['--help', '-h']) {
            const r = spawnSync(BASH, [s, flag], { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, `${flag}: ${r.stdout}${r.stderr}`);
            assert.match(r.stdout, /Usage: \.\/do\/helpme/);
            assert.doesNotMatch(r.stdout, /SHOULD_NOT_RUN|Copyright|@mlcc-script/);
        }
    });

    it('without --help the unmet guard is still a contract violation (exit 3)', () => {
        const s = writeScript('guarded', 'deployment-active', 'echo SHOULD_NOT_RUN');
        const r = spawnSync(BASH, [s], { encoding: 'utf8' });
        assert.strictEqual(r.status, 3, r.stdout + r.stderr);
        assert.doesNotMatch(r.stdout, /SHOULD_NOT_RUN/);
    });

    it('an unknown guard name is a contract violation (exit 3), not "command not found"', () => {
        const s = writeScript('typo', 'deployment-actve', 'echo SHOULD_NOT_RUN');
        const r = spawnSync(BASH, [s], { encoding: 'utf8' });
        assert.strictEqual(r.status, 3, r.stdout + r.stderr);
        assert.match(r.stdout, /Contract violation: unknown-guard/);
    });

    it('the contract exposes the config writer to every script', () => {
        const s = writeScript('writer', 'none', '_config_set FOO "a|b" && grep FOO "${SCRIPT_DIR}/config"');
        const r = spawnSync(BASH, [s], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /export FOO="a\|b"/);
    });
});

describe('do/deploy + do/clean target dispatch (DO-5)', () => {
    it('every descriptor target and alias dispatches to its driver and is normalized', async () => {
        const { allDescriptors } = await import('../../src/lib/target-manifest-reader.js');
        for (const [verb, field] of [['deploy', 'deploy_script'], ['clean', 'clean_script']]) {
            const src = readFileSync(join(DO_SRC, verb), 'utf8');
            const block = src.slice(src.indexOf('# >>> GENERATED: target dispatch'), src.indexOf('# <<< END GENERATED target dispatch'));
            assert.ok(block.length > 0, `${verb}: generated dispatch region present`);
            for (const d of allDescriptors()) {
                const arm = `    ${[d.target, ...(d.aliases || [])].join('|')})`;
                assert.ok(block.includes(arm), `${verb}: arm for ${d.target} with aliases ${d.aliases}`);
                assert.ok(block.includes(`source "\${SCRIPT_DIR}/${d[field]}"`), `${verb}: sources ${d[field]}`);
                if ((d.aliases || []).length) {
                    assert.ok(block.includes(`DEPLOYMENT_TARGET="${d.target}"`), `${verb}: normalizes ${d.target} aliases`);
                }
            }
            assert.ok(!/^case "\$DEPLOYMENT_TARGET" in/m.test(src.replace(block, '')),
                `${verb}: no hand-written dispatcher outside the generated region`);
        }
    });
});
