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
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv/dist/2020.js';
import {
    listTargets,
    allDescriptors,
    statusVarToAnswerKey,
    adapterDelivery,
    pricing,
    observability,
    computeBackends,
    scaleToZero
} from '../../src/lib/target-manifest-reader.js';
import { listServeEngines, metricSignals } from '../../src/lib/serve-manifest-reader.js';

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

        // The generated target-enumeration regions carry the canonical set,
        // and the stale `managed-inference` no longer appears in a USER-FACING
        // target list (it survives only as a back-compat alias in dispatch arms).
        it('target-list regions carry the full canonical target set', async () => {
            const { REGIONS, renderRegion } = await import('../../scripts/codegen-target-guard.js');
            const canonical = descriptors.map((d) => d.target); // listTargets order
            const listRegions = REGIONS.filter((r) => r.kind === 'targetList');
            assert.ok(listRegions.length >= 5,
                'expected a generated target-list region for each enumeration script');
            for (const region of listRegions) {
                const rendered = renderRegion(region, descriptors);
                for (const target of canonical) {
                    assert.ok(rendered.includes(target),
                        `generated "${region.name}" must list the canonical target ${target}`);
                }
                assert.ok(!rendered.includes('managed-inference'),
                    `generated "${region.name}" must NOT list the stale alias managed-inference`);
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
            // Additive-deploy verbs (do/adapter, do/add-ic) gate through the DERIVED
            // ADR-013 contract (_additive_verb_supported_on), not a _restrict_targets
            // literal. Their agreement with descriptor.verbs is asserted behaviorally
            // — every verb × every descriptor target — in additive-deploy-contract.test.js.
            if (new RegExp(`_additive_verb_supported_on ${verb} `).test(script)) continue;
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

describe('Wave 6.1 R1.1 — adapter_delivery is declared in the descriptor and read by every consumer', () => {
    const schema = JSON.parse(read('templates/do/targets.d/manifest.schema.json'));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    for (const d of descriptors) {
        it(`${d.target} descriptor validates against targets.d/manifest.schema.json`, () => {
            assert.ok(validate(d), JSON.stringify(validate.errors));
        });
    }
    const k8sAdapterTargets = descriptors.filter((d) => d.family === 'kubernetes' && d.verbs && d.verbs.adapter);
    it('every kubernetes target that supports do/adapter declares a model-prefix delivery', () => {
        assert.ok(k8sAdapterTargets.length >= 2, 'hyperpod-eks and eks');
        for (const d of k8sAdapterTargets) {
            const ad = adapterDelivery(d.target);
            assert.strictEqual(ad.strategy, 'model-prefix', d.target);
            assert.match(ad.mount_path, /^\//);
            assert.ok(ad.subdir, d.target);
        }
    });
    it('the Python reader (target_manifest.py adapter_delivery) agrees with the Node reader', () => {
        const py = process.env.MLCC_PYTHON || 'python3';
        for (const d of descriptors) {
            const r = spawnSync(py, [join(ROOT, 'templates/do/lib/python/target_manifest.py'), 'adapter_delivery', d.target],
                { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.deepStrictEqual(JSON.parse(r.stdout), adapterDelivery(d.target), d.target);
        }
    });
    it('consumers read the descriptor instead of hardcoding the path', () => {
        const adapter = read('templates/do/adapter');
        assert.match(adapter, /adapter_delivery\.py" deliver/);
        assert.ok(!/\/opt\/ml\/model\/\.mlcc-adapters/.test(adapter.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')),
            'do/adapter must not hardcode the in-pod adapter path');
        assert.match(read('templates/do/lib/python/adapter_delivery.py'), /target_manifest\.adapter_delivery\(/);
        assert.match(read('templates/do/deploy.d/hyperpod-eks'), /target_manifest\.py" adapter_delivery hyperpod-eks/);
    });
});

describe('Wave 9 R7.1/R8.2 — pricing is declared in the descriptor and read by the resolver', () => {
    // Price List component values verified live (Task 1, GetProducts 2026-10-26).
    const SAGEMAKER_COMPONENTS = ['Hosting', 'AsyncInf', 'BatchTransform', 'Cluster'];
    it('every target declares a pricing block with a service and a count basis', () => {
        for (const d of descriptors) {
            const p = pricing(d.target);
            assert.ok(['AmazonSageMaker', 'AmazonEC2'].includes(p.service), d.target);
            assert.ok(p.instance_count && p.instance_count.basis, d.target);
            if (p.service === 'AmazonSageMaker') {
                assert.ok(SAGEMAKER_COMPONENTS.includes(p.component), `${d.target}: ${p.component}`);
            } else {
                assert.strictEqual(p.component, undefined, `${d.target}: EC2 has no component`);
            }
            if (p.instance_count.basis === 'replicas') {
                assert.ok(p.instance_count.replicas_var && p.instance_count.gpus_per_replica_var, d.target);
                assert.ok(d.optional_vars[p.instance_count.replicas_var] !== undefined
                    || d.required_vars.includes(p.instance_count.replicas_var), `${d.target}: replicas var is a target var`);
            }
        }
    });
    it('the Python reader (target_manifest.py pricing) agrees with the Node reader', () => {
        const py = process.env.MLCC_PYTHON || 'python3';
        for (const d of descriptors) {
            const r = spawnSync(py, [join(ROOT, 'templates/do/lib/python/target_manifest.py'), 'pricing', d.target],
                { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.deepStrictEqual(JSON.parse(r.stdout), pricing(d.target), d.target);
        }
    });
    it('the resolver derives service/component from the descriptor (no per-target branch)', () => {
        const src = read('templates/do/lib/python/pricing.py');
        assert.match(src, /target_manifest\.pricing\(/);
        for (const t of targets) {
            assert.ok(!new RegExp(`['"]${t}['"]`).test(src), `pricing.py must not name target ${t}`);
        }
        for (const c of SAGEMAKER_COMPONENTS) {
            assert.ok(!new RegExp(`['"]${c}['"]`).test(src), `pricing.py must not hardcode component ${c}`);
        }
    });
});

describe('Wave 9 (R1/R6/R12, OQ-9.9) — observability + verbs.metrics are declared and read by every consumer', () => {
    const py = process.env.MLCC_PYTHON || 'python3';
    const STORES = ['cloudwatch-promql', 'amp', 'none'];
    for (const d of descriptors) {
        it(`${d.target} declares an observability block with a known store`, () => {
            assert.ok(d.observability, `${d.target} must declare observability`);
            assert.ok(STORES.includes(d.observability.store), d.observability.store);
        });
        it(`${d.target} verbs.metrics agrees with observability.store`, () => {
            assert.strictEqual(typeof (d.verbs || {}).metrics, 'boolean', 'verbs.metrics must be declared');
            assert.strictEqual(d.verbs.metrics, d.observability.store !== 'none',
                'do/metrics applies exactly where a metrics store exists');
        });
        if (d.observability && d.observability.store !== 'none') {
            it(`${d.target} store declares the selector, histogram form and dashboard`, () => {
                assert.ok(Object.keys(d.observability.selector || {}).length > 0);
                assert.ok(['native', 'classic'].includes(d.observability.histogram_form));
                assert.ok(d.observability.dashboard);
            });
        }
        if (d.observability && d.observability.store === 'amp') {
            it(`${d.target} (amp) declares how to discover the workspace`, () => {
                assert.ok(d.observability.amp_discovery && d.observability.amp_discovery.addon);
                assert.ok(d.observability.amp_discovery.endpoint_key);
            });
        }
    }
    it('the Python reader (target_manifest.py observability) agrees with the Node reader', () => {
        for (const d of descriptors) {
            const r = spawnSync(py, [join(ROOT, 'templates/do/lib/python/target_manifest.py'), 'observability', d.target],
                { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.deepStrictEqual(JSON.parse(r.stdout), observability(d.target), d.target);
        }
    });
    it('the Python reader (serve_manifest.py metric_signals) agrees with the Node reader', () => {
        const engines = listServeEngines();
        assert.ok(engines.some((e) => Object.keys(metricSignals(e)).length > 0), 'some engine declares signals');
        for (const engine of engines) {
            const r = spawnSync(py, [join(ROOT, 'templates/do/lib/python/serve_manifest.py'), 'metric_signals', engine],
                { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.deepStrictEqual(JSON.parse(r.stdout), metricSignals(engine), engine);
        }
    });
    it('consumers derive the store from the descriptor instead of branching on target names', () => {
        const strip = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        for (const rel of ['templates/do/lib/python/gpu_metrics.py', 'templates/do/lib/python/endpoint_metrics.py']) {
            const code = strip(read(rel));
            for (const d of descriptors) {
                // boto3.client('eks') is the AWS service name, not a target branch.
                assert.ok(!new RegExp(`(?<!client\\()'${d.target}'`).test(code),
                    `${rel} must not hardcode target '${d.target}'`);
            }
        }
        const writer = read('templates/do/.benchmark_writer.py');
        const fn = writer.slice(writer.indexOf('def _collect_gpu_signals('), writer.indexOf('def collect_level_context('));
        for (const d of descriptors.filter((x) => x.target !== 'realtime-inference')) {
            assert.ok(!fn.includes(`'${d.target}'`), `_collect_gpu_signals must not branch on '${d.target}'`);
        }
        assert.match(read('templates/do/metrics'), /target_manifest\.py" verbs/);
    });
});

describe('Wave 11 R1.1 — compute_backends is declared per target and read the same by both readers', () => {
    const KNOWN = ['smtj', 'hp-eks'];
    const py = process.env.MLCC_PYTHON || 'python3';
    for (const d of descriptors) {
        it(`${d.target} declares a non-empty, known, duplicate-free compute_backends list`, () => {
            assert.ok(Array.isArray(d.compute_backends) && d.compute_backends.length > 0, 'compute_backends required');
            assert.strictEqual(new Set(d.compute_backends).size, d.compute_backends.length, 'no duplicates');
            d.compute_backends.forEach((b) => assert.ok(KNOWN.includes(b), `unknown backend '${b}'`));
        });
        it(`${d.target} defaults to smtj (OQ-11.5: hp-eks is opt-in, never the default)`, () => {
            assert.strictEqual(d.compute_backends[0], 'smtj');
        });
        it(`${d.target}: hp-eks is offered only where a cluster contract can verify it`, () => {
            if (!d.compute_backends.includes('hp-eks')) return;
            assert.strictEqual(d.family, 'kubernetes');
            assert.ok(d.cluster_contract && d.cluster_contract.script, 'hp-eks needs a cluster_contract script');
        });
        it(`${d.target}: target_manifest.py compute_backends agrees with computeBackends()`, () => {
            const r = spawnSync(py, [join(ROOT, 'templates/do/lib/python/target_manifest.py'), 'compute_backends', d.target],
                { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.deepStrictEqual(JSON.parse(r.stdout), computeBackends(d.target));
        });
    }
    it('at least one target offers the hp-eks backend (hyperpod-eks, BL148)', () => {
        assert.ok(descriptors.some((d) => d.compute_backends.includes('hp-eks')));
        assert.ok(computeBackends('hyperpod-eks').includes('hp-eks'));
    });
    it('every target declares verbs.add-pod explicitly (BL149; agreement with ADR-013 is in additive-deploy-contract)', () => {
        for (const d of descriptors) {
            assert.strictEqual(typeof (d.verbs || {})['add-pod'], 'boolean', `${d.target} verbs.add-pod`);
        }
    });
    it('the schema requires compute_backends next to scale_to_zero and rejects an unknown backend (W10 + W11 merge)', () => {
        const schema = JSON.parse(read('templates/do/targets.d/manifest.schema.json'));
        assert.ok(schema.required.includes('compute_backends') && schema.required.includes('scale_to_zero'));
        const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
        const base = descriptors.find((d) => d.compute_backends.includes('hp-eks'));
        assert.ok(validate(base), JSON.stringify(validate.errors));
        assert.ok(!validate({ ...base, compute_backends: ['smtj', 'no-such-backend'] }), 'unknown backend must be invalid');
        const without = { ...base };
        delete without.compute_backends;
        assert.ok(!validate(without), 'a descriptor without compute_backends must be invalid');
    });
});

describe('Wave 10 (ADR-014 R1, R8.1) — scale_to_zero is declared on every target and read by both readers', () => {
    const py = process.env.MLCC_PYTHON || 'python3';
    const schema = JSON.parse(read('templates/do/targets.d/manifest.schema.json'));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    it('the schema requires the block', () => {
        assert.ok(schema.required.includes('scale_to_zero'));
    });
    for (const d of descriptors) {
        it(`${d.target} declares a valid scale_to_zero block`, () => {
            assert.ok(d.scale_to_zero, `${d.target} must declare scale_to_zero`);
            assert.ok(validate(d), JSON.stringify(validate.errors));
        });
        it(`${d.target}: enabled implies native + mechanism + wake signal; disabled carries a reason`, () => {
            const s = d.scale_to_zero;
            if (s.enabled) {
                assert.strictEqual(s.support, 'native');
                assert.ok(s.mechanism && s.wake_signal);
            } else {
                assert.ok(s.reason && s.reason.length > 10, 'reason is shown verbatim on refusal');
            }
        });
    }
    it('the schema rejects enabled on a non-native target and a disabled block without a reason', () => {
        const base = descriptors.find((d) => d.scale_to_zero.enabled);
        assert.ok(base, 'at least one enabled target');
        const notNative = { ...base, scale_to_zero: { ...base.scale_to_zero, support: 'pod-only' } };
        assert.ok(!validate(notNative), 'enabled + pod-only must be invalid');
        const noMech = { ...base, scale_to_zero: { ...base.scale_to_zero, mechanism: null } };
        assert.ok(!validate(noMech), 'enabled + null mechanism must be invalid');
        const noReason = { ...base, scale_to_zero: { ...base.scale_to_zero, enabled: false } };
        assert.ok(!validate(noReason), 'disabled without a reason must be invalid');
    });
    it('flag acceptance matches enabled: --scale-to-zero / --scale-max are declared exactly on enabled targets', () => {
        for (const d of descriptors) {
            const flags = (d.answer_params || []).map((p) => p.flag).filter(Boolean);
            for (const f of ['--scale-to-zero', '--scale-max']) {
                assert.strictEqual(flags.includes(f), d.scale_to_zero.enabled,
                    `${d.target}: ${f} declared iff scale_to_zero.enabled`);
            }
        }
    });
    it('the Python reader (target_manifest.py scale_to_zero) agrees with the Node reader', () => {
        for (const d of descriptors) {
            const r = spawnSync(py, [join(ROOT, 'templates/do/lib/python/target_manifest.py'), 'scale_to_zero', d.target],
                { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.deepStrictEqual(JSON.parse(r.stdout), scaleToZero(d.target), d.target);
        }
    });
});
