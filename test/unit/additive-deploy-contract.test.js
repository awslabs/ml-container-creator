// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 6 (ADR-013 axes 2–3) — the declared kind×mechanism contract + its drift guard.
 *
 * The additive-deploy contract lives in ONE block of templates/do/lib/script-contract.sh
 * (`_additive_verb_kinds` / `_additive_verb_mechanisms` / `_additive_target_mechanisms`).
 * The legal verb×target matrix is DERIVED from the mechanism intersection. This
 * suite asserts the DERIVATION and its CONSUMERS agree — never a pinned matrix
 * literal (repo rule "tests that don't rot" #1):
 *
 *   R3.3  `_additive_verb_supported_on` accepts exactly when the verb's and the
 *         target's mechanism sets intersect (computed here from the table itself).
 *   R3.5  Consumer conformance:
 *         - the deployment-target descriptors' `verbs.<verb>` flags agree with the
 *           derived legality for every additive verb × every descriptor target;
 *         - the REAL do/adapter and do/add-ic scripts accept/refuse each target
 *           exactly as the table derives (run end-to-end in a sandbox);
 *         - each script's `# targets:` header equals the derived supported set;
 *         - no script passes a literal accepted kind to `_guard_artifact_kind`.
 *   R3.2/R8.5 the kind gate reads the table: full_model→do/adapter refused,
 *         lora_adapter→do/add-ic refused, unknown degrades.
 *   R3.4  do/add-pod (BL149, Wave 11 R8.1) landed: full_model × pod-apply, exposed by
 *         hyperpod-eks only; plain eks keeps an honest deferred note (F6, post-2.0).
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    makeSandbox, runContract, runBash, sandboxEnv, loadDescriptors, ACTIVE_STATUS_CONFIG, DO_SRC
} from '../helpers/additive-sandbox.js';

const CONTRACT_SRC = readFileSync(join(DO_SRC, 'lib/script-contract.sh'), 'utf8');
const VERB_SCRIPTS = { adapter: 'adapter', 'add-ic': 'add-ic', 'add-pod': 'add-pod' };
const words = s => s.trim().split(/\s+/).filter(Boolean);

describe('Wave 6 — additive-deploy contract table (ADR-013, R3)', function () {
    this.timeout(120000);
    let sb;
    let table; // { verbs, targets, kinds{}, verbMechs{}, targetMechs{}, mech{v}{t}, supported{v}{t} }
    const descriptors = loadDescriptors();
    const descriptorTargets = descriptors.map(d => d.target);

    before(() => {
        sb = makeSandbox();
        // Query the whole contract in one bash run (verbs/targets as the table
        // enumerates them, plus every descriptor target and an unset target).
        const probeTargets = [...new Set([...descriptorTargets, 'realtime-inference', 'hyperpod-eks', 'eks', 'not-a-target'])];
        const body = [
            'echo "VERBS|$(_additive_verbs)"',
            'echo "TARGETS|$(_additive_targets)"',
            'for v in $(_additive_verbs); do',
            '  echo "KIND|$v|$(_additive_accepts_kind "$v")"',
            '  echo "VMECH|$v|$(_additive_verb_mechanisms "$v")"',
            `  for t in ${probeTargets.join(' ')}; do`,
            '    echo "MECH|$v|$t|$(_additive_mechanism_for "$v" "$t")"',
            '    rc=0; ( _additive_verb_supported_on "$v" "$t" ) >/dev/null 2>&1 || rc=$?',
            '    echo "SUP|$v|$t|$rc"',
            '  done',
            'done',
            `for t in ${probeTargets.join(' ')}; do echo "TMECH|$t|$(_additive_target_mechanisms "$t")"; done`
        ].join('\n');
        const r = runContract(sb, body);
        assert.strictEqual(r.code, 0, r.stderr);
        table = { kinds: {}, verbMechs: {}, targetMechs: {}, mech: {}, supported: {} };
        for (const line of r.stdout.split('\n')) {
            const p = line.split('|');
            if (p[0] === 'VERBS') table.verbs = words(p[1]);
            if (p[0] === 'TARGETS') table.targets = words(p[1]);
            if (p[0] === 'KIND') table.kinds[p[1]] = words(p[2]);
            if (p[0] === 'VMECH') table.verbMechs[p[1]] = words(p[2]);
            if (p[0] === 'TMECH') table.targetMechs[p[1]] = words(p[2]);
            if (p[0] === 'MECH') (table.mech[p[1]] = table.mech[p[1]] || {})[p[2]] = words(p[3]);
            if (p[0] === 'SUP') (table.supported[p[1]] = table.supported[p[1]] || {})[p[2]] = Number(p[3]);
        }
    });
    after(() => sb.cleanup());

    it('declares at least the two shipped additive verbs, each with kinds and mechanisms', () => {
        assert.ok(table.verbs.includes('adapter') && table.verbs.includes('add-ic'), table.verbs.join(','));
        for (const v of table.verbs) {
            assert.ok(table.kinds[v].length > 0, `${v} must accept at least one kind`);
            assert.ok(table.verbMechs[v].length > 0, `${v} must drive at least one mechanism`);
        }
    });

    it('every contract target is a real deployment-target descriptor', () => {
        for (const t of table.targets) {
            assert.ok(descriptorTargets.includes(t), `contract target '${t}' has no templates/do/targets.d descriptor`);
        }
    });

    it('_additive_mechanism_for is exactly verb-mechanisms ∩ target-mechanisms', () => {
        for (const v of table.verbs) {
            for (const t of Object.keys(table.targetMechs)) {
                const expected = table.verbMechs[v].filter(m => table.targetMechs[t].includes(m));
                assert.deepStrictEqual(table.mech[v][t], expected, `${v} on ${t}`);
            }
        }
    });

    it('_additive_verb_supported_on accepts iff the intersection is non-empty (refuses with exit 3)', () => {
        for (const v of table.verbs) {
            for (const t of Object.keys(table.targetMechs)) {
                const expected = table.mech[v][t].length > 0 ? 0 : 3;
                assert.strictEqual(table.supported[v][t], expected, `${v} on ${t}`);
            }
        }
    });

    it('conformance: descriptor verbs.<verb> agrees with the derived legality for every target', () => {
        for (const v of table.verbs) {
            for (const d of descriptors) {
                if (!d.verbs || !(v in d.verbs)) continue;
                const derived = table.supported[v][d.target] === 0;
                assert.strictEqual(derived, d.verbs[v] === true,
                    `do/${v} on ${d.target}: descriptor says ${d.verbs[v]}, contract derives ${derived}`);
            }
        }
    });

    it('conformance: each verb script header `# targets:` equals the derived supported set', () => {
        for (const [verb, file] of Object.entries(VERB_SCRIPTS)) {
            const src = readFileSync(join(DO_SRC, file), 'utf8');
            const m = src.match(/^# targets:\s*(.+)$/m);
            assert.ok(m, `do/${file} must declare # targets:`);
            const declared = m[1].split(',').map(s => s.trim()).sort();
            const derived = descriptorTargets.filter(t => table.supported[verb][t] === 0).sort();
            assert.deepStrictEqual(declared, derived, `do/${file} # targets: header drifted from the contract`);
        }
    });

    it('conformance: verb scripts gate through the contract, not hand-listed targets or literal kinds', () => {
        for (const [verb, file] of Object.entries(VERB_SCRIPTS)) {
            const code = readFileSync(join(DO_SRC, file), 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
            assert.ok(new RegExp(`_additive_verb_supported_on ${verb} "\\$\\{DEPLOYMENT_TARGET:-\\}"`).test(code),
                `do/${file} must gate with _additive_verb_supported_on ${verb}`);
            assert.ok(!/_restrict_targets\s+"/.test(code), `do/${file} must not hand-list targets with _restrict_targets`);
        }
        // No consumer anywhere in do/ passes a literal accepted kind to the gate.
        const doFiles = readdirSync(DO_SRC, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
        for (const f of doFiles) {
            const code = readFileSync(join(DO_SRC, f), 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
            assert.ok(!/_guard_artifact_kind\s+"[^"]*"\s+"(lora_adapter|full_model)"/.test(code),
                `do/${f} passes a literal accepted kind to _guard_artifact_kind — use "$(_additive_accepts_kind <verb>)"`);
        }
    });

    it('a refused verb×target names the supported targets and the verb that serves the target (derived)', () => {
        for (const v of table.verbs) {
            for (const t of table.targets) {
                if (table.supported[v][t] === 0) continue;
                const r = runContract(sb, `_additive_verb_supported_on ${v} ${t}`);
                assert.strictEqual(r.code, 3);
                assert.match(r.stdout, /Contract violation: target/);
                const okTargets = table.targets.filter(x => table.supported[v][x] === 0);
                okTargets.forEach(x => assert.ok(r.stdout.includes(x), `refusal must name supported target ${x}`));
                table.verbs.filter(o => table.supported[o][t] === 0)
                    .forEach(o => assert.ok(r.stdout.includes(`do/${o}`), `refusal on ${t} must point at do/${o}`));
            }
        }
    });

    it('a kind no verb can serve on a target is refused honestly as "not servable yet" (do/add-pod deferred)', () => {
        // Find a (verb, target) where the target is served by SOME verb, but none
        // of the verbs serving it accepts this verb's kinds. Today: full_model on
        // a cluster. The assertion is on the derivation, not on that literal pair.
        let checked = 0;
        for (const v of table.verbs) {
            for (const t of table.targets) {
                if (table.supported[v][t] === 0) continue;
                const servingVerbs = table.verbs.filter(o => table.supported[o][t] === 0);
                if (servingVerbs.length === 0) continue;
                const served = servingVerbs.some(o => table.kinds[o].some(k => table.kinds[v].includes(k)));
                if (served) continue;
                const r = runContract(sb, `_additive_verb_supported_on ${v} ${t}`);
                assert.match(r.stdout, /not servable on .* yet/);
                checked++;
            }
        }
        if (/^\s*# add-pod\) echo "full_model"/m.test(CONTRACT_SRC)) {
            assert.ok(checked > 0, 'with do/add-pod deferred, a full model on a cluster must be an honest gap');
            assert.match(runContract(sb, '_additive_verb_supported_on add-ic hyperpod-eks').stdout, /do\/add-pod/);
        }
    });

    it('R3.4 / R8.1: do/add-pod joined the contract as full_model × pod-apply', () => {
        assert.ok(table.verbs.includes('add-pod'), 'add-pod is an additive verb');
        assert.deepStrictEqual(table.kinds['add-pod'], ['full_model']);
        assert.deepStrictEqual(table.verbMechs['add-pod'], ['pod-apply']);
        // Every target that exposes pod-apply supports add-pod, and its descriptor says so.
        for (const d of descriptors) {
            const exposes = (table.targetMechs[d.target] || []).includes('pod-apply');
            assert.strictEqual(table.supported['add-pod'][d.target] === 0, exposes, d.target);
            assert.strictEqual(d.verbs['add-pod'], exposes, `${d.target} verbs.add-pod must equal the derived legality`);
        }
    });

    it('R8.2: refusal guidance for a full model is derived per target (add-pod where it exists, the deferred note elsewhere)', () => {
        for (const t of table.targets) {
            const r = runContract(sb, `_additive_kind_guidance full_model ${t}`);
            assert.strictEqual(r.code, 0, r.stderr);
            const servers = table.verbs.filter(v => table.kinds[v].includes('full_model') && table.supported[v][t] === 0);
            if (servers.length) {
                servers.forEach(v => assert.ok(r.stdout.includes(`do/${v}`), `${t}: must name do/${v}`));
            } else {
                assert.match(r.stdout, /not servable on/);
                assert.match(r.stdout, /planned: /);
            }
        }
        const hp = runContract(sb, '_additive_kind_guidance full_model hyperpod-eks').stdout;
        if (table.supported['add-pod']['hyperpod-eks'] === 0) assert.match(hp, /do\/add-pod/);
    });

    it('R8.2: no verb script carries a hand-written full-model refusal literal', () => {
        for (const f of ['adapter', 'add-ic', 'add-pod']) {
            const code = readFileSync(join(DO_SRC, f), 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
            assert.ok(!/do\/add-pod[^"]*(deferred|not supported yet)/.test(code), `do/${f} hardcodes the add-pod deferral`);
            assert.ok(!/use realtime-inference \+ do\/add-ic/.test(code), `do/${f} hardcodes the full-model route`);
        }
    });

    describe('kind gate driven by the table (R3.2 / R8.5)', () => {
        const gate = (kind, verb) => runContract(sb,
            `_guard_artifact_kind "${kind}" "$(_additive_accepts_kind ${verb})" "guidance-text"`);

        it('every verb accepts each of its own kinds', () => {
            for (const v of table.verbs) {
                for (const k of table.kinds[v]) assert.strictEqual(gate(k, v).code, 0, `${v} must accept ${k}`);
            }
        });

        it('every verb refuses another verb\'s kind with a contract violation (exit 3) + guidance', () => {
            for (const v of table.verbs) {
                for (const o of table.verbs) {
                    for (const k of table.kinds[o]) {
                        if (table.kinds[v].includes(k)) continue;
                        const r = gate(k, v);
                        assert.strictEqual(r.code, 3, `${v} must refuse ${k}`);
                        assert.match(r.stdout, /Contract violation: artifact-kind/);
                        assert.match(r.stdout, /guidance-text/);
                    }
                }
            }
        });

        it('an unknown (legacy) kind degrades — passes with a notice, never blocks', () => {
            for (const v of table.verbs) {
                const r = gate('', v);
                assert.strictEqual(r.code, 0);
                assert.match(r.stderr, /artifact_kind unknown/);
            }
        });
    });
});

describe('Wave 6 — real do/adapter + do/add-ic obey the derived target legality (R3.5)', function () {
    this.timeout(180000);
    const descriptors = loadDescriptors();
    let sb;
    let supported;

    before(() => {
        sb = makeSandbox({ scripts: Object.values(VERB_SCRIPTS) });
        const targets = descriptors.map(d => d.target).join(' ');
        const r = runContract(sb, [
            'for v in $(_additive_verbs); do',
            `  for t in ${targets}; do rc=0; ( _additive_verb_supported_on "$v" "$t" ) >/dev/null 2>&1 || rc=$?; echo "$v|$t|$rc"; done`,
            'done'
        ].join('\n'));
        supported = {};
        r.stdout.split('\n').filter(Boolean).forEach((l) => {
            const [v, t, rc] = l.split('|');
            (supported[v] = supported[v] || {})[t] = rc === '0';
        });
    });
    after(() => sb.cleanup());

    for (const [verb, file] of Object.entries(VERB_SCRIPTS)) {
        for (const d of descriptors) {
            it(`do/${file} on ${d.target}: accept/refuse matches the contract`, () => {
                sb.write('do/config', [
                    ACTIVE_STATUS_CONFIG,
                    `export DEPLOYMENT_TARGET="${d.target}"`,
                    'export PROJECT_NAME="proj"',
                    'export AWS_REGION="us-west-2"',
                    'export HP_LORA_ENABLED="true"',
                    'export ENABLE_LORA="true"',
                    ''
                ].join('\n'), 0o644);
                const r = runBash(join(sb.doDir, file), ['--help'], sandboxEnv(sb));
                const refused = r.code === 3 && /Contract violation: target/.test(r.stdout);
                assert.strictEqual(!refused, supported[verb][d.target],
                    `do/${file} on ${d.target}: exit ${r.code}\n${r.stdout}\n${r.stderr}`);
                if (supported[verb][d.target]) {
                    assert.strictEqual(r.code, 0, `--help must succeed on a supported target:\n${r.stdout}\n${r.stderr}`);
                }
            });
        }
    }
});
