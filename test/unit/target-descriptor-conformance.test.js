// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ADR-008 deployment-target descriptor CONFORMANCE (Wave 8 T3 — the C safety net).
 *
 * The descriptors in templates/do/targets.d/ are the intended single source of
 * truth. This test asserts every scattered authority AGREES with them. It must
 * pass on the CURRENT tree (before any derivation) — proving the descriptors
 * faithfully capture reality — and then guards every derivation step in T4/T5:
 * if a generated authority ever drifts from the descriptors, this fails.
 *
 * Authorities checked (see ADR-008 duplication map):
 *   1. do/config template — the DEPLOYMENT_TARGET_<T>_STATUS export block
 *   2. script-contract.sh _guard_deployment_active — target→status_var + statuses
 *   3. do-config.js SHELL_VAR_TO_ANSWER — status_var→answer_key
 *   4. regenerate RUNTIME_OWNED_VARS — every status_var + per-target runtime vars
 *   5. deploy dispatcher — a source arm per deploy_script
 *   6. clean dispatcher — a source arm per clean_script
 *   7. deploy.d/<t> + clean.d/<t> files exist
 *   8. VALID_TARGETS (conformance test) === descriptor set
 *   9. deploy_schema.py STATUS_VARS / SCHEMAS / TARGET_ALIASES
 *  10. verb guards (_restrict_targets / _contract_violation) vs descriptor.verbs
 *
 * T5 also closed two eks gaps through the descriptor: the resolve-serving-config.sh
 * `eks` arm (folded into `hyperpod-eks|eks)`) and the do/logs `eks` dispatch arm.
 * The mechanical target→status_var maps in script-contract.sh and templates/do/deploy
 * are now codegen'd from the descriptors and drift-checked below.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    listTargets,
    allDescriptors,
    statusVarToAnswerKey
} from '../../src/lib/target-manifest-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const descriptors = allDescriptors();
const targets = listTargets();

describe('target-descriptor conformance (ADR-008 T3 — safety net)', () => {
    it('descriptor set matches VALID_TARGETS in the do-contract conformance test', () => {
        const conf = read('test/unit/do-contract-conformance.test.js');
        // VALID_TARGETS lists the deployment targets a @mlcc-script may declare.
        for (const t of targets) {
            assert.ok(conf.includes(`'${t}'`),
                `VALID_TARGETS must include '${t}'`);
        }
    });

    describe('do/config template — status export block', () => {
        const config = read('templates/do/config');
        for (const d of descriptors) {
            it(`exports ${d.status_var}`, () => {
                assert.ok(config.includes(`export ${d.status_var}=`),
                    `do/config must export ${d.status_var}`);
            });
            it(`${d.status_var} export uses the ${d.answer_key} EJS key`, () => {
                assert.ok(config.includes(d.answer_key),
                    `do/config ${d.status_var} export should reference ${d.answer_key}`);
            });
        }
    });

    describe('script-contract.sh _guard_deployment_active', () => {
        const sc = read('templates/do/lib/script-contract.sh');
        for (const d of descriptors) {
            it(`maps ${d.target} → ${d.status_var}`, () => {
                assert.ok(sc.includes(d.status_var),
                    `_guard_deployment_active must reference ${d.status_var}`);
            });
        }
        it('accepts each descriptor success_status', () => {
            for (const d of descriptors) {
                assert.ok(new RegExp(`\\b${d.success_status}\\b`).test(sc),
                    `accepted-status set must include ${d.success_status} (for ${d.target})`);
            }
        });
        // Full drift check for every generated region lives below in its own
        // describe so it covers script-contract.sh AND templates/do/deploy.
    });

    describe('codegen-target-guard generated regions (no drift)', () => {
        // Every marker-delimited block on disk must equal what the codegen would
        // emit from the descriptors. This is the byte-for-byte safety net for the
        // shell hot-path derivation (ADR-008 T5): status-var maps in
        // script-contract.sh (_guard_deployment_active) and templates/do/deploy
        // (reconfigure active-check + switch-or-deploy).
        it('every REGION matches its generator output', async () => {
            const { REGIONS, renderRegion } = await import('../../scripts/codegen-target-guard.js');
            for (const region of REGIONS) {
                const src = readFileSync(region.file, 'utf8');
                const begin = src.indexOf(region.begin);
                const end = src.indexOf(region.end, begin);
                assert.ok(begin !== -1 && end !== -1,
                    `markers for "${region.name}" must be present in ${region.file}`);
                const actual = src.slice(begin, end + region.end.length);
                const expected = renderRegion(region, descriptors);
                assert.strictEqual(actual, expected,
                    `generated block "${region.name}" drifted — run \`npm run codegen\``);
            }
        });
    });

    it('do-config.js SHELL_VAR_TO_ANSWER agrees with the descriptors', async () => {
        // do-config.js now DERIVES the status entries from the descriptors
        // (ADR-008 T4), so we check the resolved runtime value, not source text.
        const { SHELL_VAR_TO_ANSWER } = await import('../../src/lib/do-config.js');
        for (const [statusVar, answerKey] of Object.entries(statusVarToAnswerKey())) {
            assert.strictEqual(SHELL_VAR_TO_ANSWER[statusVar], answerKey,
                `SHELL_VAR_TO_ANSWER must map ${statusVar} → '${answerKey}'`);
        }
    });

    describe('regenerate RUNTIME_OWNED_VARS', () => {
        // RUNTIME_OWNED_VARS is now DERIVED (SHARED_RUNTIME_VARS ∪ per-target
        // runtime_owned_vars from the descriptors), so we check the resolved Set
        // exported for testing, not source text.
        for (const d of descriptors) {
            for (const v of d.runtime_owned_vars) {
                it(`preserves ${v} (from ${d.target})`, async () => {
                    const mod = await import('../../src/lib/regenerate-command-handler.js');
                    assert.ok(mod.RUNTIME_OWNED_VARS.has(v),
                        `RUNTIME_OWNED_VARS must include ${v}`);
                });
            }
        }
    });

    describe('deploy + clean dispatchers', () => {
        const deploy = read('templates/do/deploy');
        const clean = read('templates/do/clean');
        for (const d of descriptors) {
            it(`deploy sources ${d.deploy_script}`, () => {
                assert.ok(deploy.includes(`/${d.deploy_script}"`),
                    `deploy dispatcher must source ${d.deploy_script}`);
            });
            it(`clean sources ${d.clean_script}`, () => {
                assert.ok(clean.includes(`/${d.clean_script}"`),
                    `clean dispatcher must source ${d.clean_script}`);
            });
        }
    });

    describe('deploy.d/ + clean.d/ scripts exist', () => {
        for (const d of descriptors) {
            it(`${d.deploy_script} exists`, () => {
                assert.doesNotThrow(() => read(`templates/do/${d.deploy_script}`));
            });
            it(`${d.clean_script} exists`, () => {
                assert.doesNotThrow(() => read(`templates/do/${d.clean_script}`));
            });
        }
    });

    describe('deploy_schema.py STATUS_VARS / SCHEMAS / TARGET_ALIASES', () => {
        const ds = read('templates/do/lib/python/deploy_schema.py');
        for (const d of descriptors) {
            it(`STATUS_VARS[${d.target}] === ${d.status_var}`, () => {
                assert.ok(ds.includes(`"${d.target}": "${d.status_var}"`),
                    `deploy_schema STATUS_VARS must map ${d.target} → ${d.status_var}`);
            });
            it(`SCHEMAS.${d.target}.required matches descriptor required_vars`, () => {
                // Each required var must appear in the SCHEMAS block (structural check).
                for (const v of d.required_vars) {
                    assert.ok(ds.includes(`"${v}"`),
                        `deploy_schema SCHEMAS must reference required var ${v}`);
                }
            });
            // Alias unification landed in T5: every descriptor alias must now be
            // honored consistently across BOTH layers — deploy_schema.py's
            // TARGET_ALIASES AND the shell status-var maps (guard + deploy) via a
            // `<target>|<alias>` case arm. This is the strict form; before T5 the
            // layers diverged (shell used `managed-inference`, deploy_schema used
            // `realtime`) and this was relaxed to "honored by at least one layer".
            const guardText = read('templates/do/lib/script-contract.sh');
            const deployText = read('templates/do/deploy');
            for (const alias of d.aliases) {
                it(`alias ${alias} → ${d.target} is honored in deploy_schema AND the shell maps`, () => {
                    const inPySchema = ds.includes(`"${alias}": "${d.target}"`);
                    const aliasArm = new RegExp(`\\b${d.target}\\|(?:[\\w-]+\\|)*${alias}(?:\\|[\\w-]+)*\\)`);
                    const inGuard = aliasArm.test(guardText);
                    const inDeploy = aliasArm.test(deployText);
                    assert.ok(inPySchema,
                        `alias ${alias} → ${d.target} must be in deploy_schema TARGET_ALIASES`);
                    assert.ok(inGuard,
                        `alias ${alias} → ${d.target} must be in the guard's status-var case arm`);
                    assert.ok(inDeploy,
                        `alias ${alias} → ${d.target} must be in a deploy status-var case arm`);
                });
            }
        }
    });

    describe('verb guards agree with descriptor.verbs', () => {
        // For each verb that a target REFUSES (verbs[verb] === false and the verb
        // is target-restricted), the verb script must NOT list that target in its
        // _restrict_targets allow-list. For each target that a verb ACCEPTS, it
        // must appear in the allow-list. We check the allow-list membership.
        const verbScript = {
            optimize: read('templates/do/optimize'),
            'add-ic': read('templates/do/add-ic'),
            ci: read('templates/do/ci'),
            adapter: read('templates/do/adapter')
        };

        for (const [verb, script] of Object.entries(verbScript)) {
            // Extract the _restrict_targets allow-list (first occurrence).
            const m = script.match(/_restrict_targets\s+"([^"]+)"/);
            const allow = m ? m[1].split(',').map(s => s.trim()) : [];

            for (const d of descriptors) {
                const applies = d.verbs && d.verbs[verb] === true;
                // A target that the verb applies to must be reachable: either in the
                // _restrict_targets allow-list OR handled by an explicit branch
                // (e.g. adapter's hyperpod-eks path). We assert allow-list membership
                // for the SageMaker-endpoint accept cases and skip targets handled by
                // dedicated branches (kubernetes family for adapter).
                if (applies && d.family === 'sagemaker-endpoint') {
                    it(`${verb} allow-list includes ${d.target}`, () => {
                        assert.ok(allow.includes(d.target),
                            `do/${verb} _restrict_targets should allow ${d.target}`);
                    });
                }
                if (!applies && d.family === 'sagemaker-job') {
                    it(`${verb} allow-list excludes ${d.target}`, () => {
                        assert.ok(!allow.includes(d.target),
                            `do/${verb} _restrict_targets should not allow ${d.target}`);
                    });
                }
            }
        }
    });
});
