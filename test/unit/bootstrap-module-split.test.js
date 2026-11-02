// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap module split (eks / hyperpod) — drift + behavior tests (offline).
 *
 * Covers: the HyperPod preflights are owned by stack-presence (so `eks` runs none),
 * the denormalizer maps the new eks/hyperpod outputs with NO hyperpod-cluster compat
 * alias, and the manifest/denormalizer export keys agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const MANIFEST_PATH = resolve(__dirname, '../../infra/bootstrap-modules/module-manifest.json');
const RUNNER_PATH = resolve(__dirname, '../../infra/bootstrap-modules/module-runner.cjs');
const RUNNER_SRC = readFileSync(RUNNER_PATH, 'utf8');
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

describe('preflight ownership (eks runs no HyperPod preflights)', () => {
    const { CdkMultiStackModuleRunner } = require(RUNNER_PATH);

    it('provision() gates HyperPod preflights on stack ownership, not module name', () => {
        // The runner derives `ownsHyperPod` from the presence of the hyperpod stacks,
        // so renaming the module cannot silently re-enable/disable the preflights.
        assert.match(RUNNER_SRC, /ownsHyperPod\s*=\s*this\.stacks\.includes\('hyperpod-cluster'\)/);
        // The preflight + post-deploy inference steps are guarded by ownsHyperPod.
        // (BL161: the add-on install is now a CDK-owned eks.CfnAddon, so the post-deploy
        // step is the kubectl patch + watcher verification, not an `aws eks create-addon`.)
        assert.match(RUNNER_SRC, /if \(ownsHyperPod\)\s*\{\s*\n\s*this\._ensureHyperPodServiceLinkedRole/);
        assert.match(RUNNER_SRC, /if \(ownsHyperPod\)\s*\{\s*\n\s*this\._postDeployInferenceOperator/);
    });

    it('an eks-only runner reports it does NOT own HyperPod stacks', () => {
        const eksRunner = new CdkMultiStackModuleRunner('eks', manifest.modules.eks.stacks);
        const ownsHyperPod = eksRunner.stacks.includes('hyperpod-cluster')
            || eksRunner.stacks.includes('inference-operator');
        assert.equal(ownsHyperPod, false);
    });

    it('a hyperpod runner DOES own the HyperPod stacks', () => {
        const hpRunner = new CdkMultiStackModuleRunner('hyperpod', manifest.modules.hyperpod.stacks);
        const ownsHyperPod = hpRunner.stacks.includes('hyperpod-cluster')
            || hpRunner.stacks.includes('inference-operator');
        assert.equal(ownsHyperPod, true);
    });
});

describe('denormalizer: new eks/hyperpod keys, no compat alias', () => {
    // Load the handler module source to assert the denormalizer shape without
    // constructing the full handler (which pulls many deps). Behavioral assertion
    // via a minimal reimplementation would drift; instead assert the source contract.
    const HANDLER_SRC = readFileSync(
        resolve(__dirname, '../../src/lib/bootstrap-command-handler.js'), 'utf8');

    it('reads outputs.eks → eksInferenceRoleArn + OIDC + cluster keys', () => {
        assert.match(HANDLER_SRC, /outputs\.eks\.EksInferenceRoleArn/);
        assert.match(HANDLER_SRC, /profileData\.eksInferenceRoleArn/);
        assert.match(HANDLER_SRC, /profileData\.eksOidcProviderArn/);
        assert.match(HANDLER_SRC, /profileData\.eksClusterArn/);
    });

    it('reads outputs.hyperpod → hyperpodClusterArn/Name', () => {
        assert.match(HANDLER_SRC, /outputs\.hyperpod\.HyperPodClusterName/);
        assert.match(HANDLER_SRC, /profileData\.hyperpodClusterArn/);
    });

    it('has NO outputs[\'hyperpod-cluster\'] denormalization branch (hard cutover)', () => {
        // The only remaining mention of the old key is in a comment explaining the
        // deliberate absence; there must be no `if (outputs['hyperpod-cluster'])` read.
        assert.ok(!/if \(outputs\['hyperpod-cluster'\]\)/.test(HANDLER_SRC),
            'no compat-alias read of the old module key');
    });
});

describe('manifest ↔ denormalizer export agreement', () => {
    const HANDLER_SRC = readFileSync(
        resolve(__dirname, '../../src/lib/bootstrap-command-handler.js'), 'utf8');

    it('every eks manifest export is consumed by the denormalizer', () => {
        for (const exp of manifest.modules.eks.exports) {
            assert.match(HANDLER_SRC, new RegExp(`outputs\\.eks\\.${exp}`),
                `denormalizer should consume eks export ${exp}`);
        }
    });

    it('every hyperpod manifest export is consumed (or intentionally status-only)', () => {
        // InferenceOperatorStatus is a status-only export (not denormalized to a flat
        // key); the cluster arn/name are consumed.
        assert.match(HANDLER_SRC, /outputs\.hyperpod\.HyperPodClusterName/);
        assert.match(HANDLER_SRC, /outputs\.hyperpod\.HyperPodClusterArn/);
    });
});

describe('legacy-module removal (cutover)', () => {
    const HANDLER_SRC = readFileSync(
        resolve(__dirname, '../../src/lib/bootstrap-command-handler.js'), 'utf8');

    it('defines a LEGACY_REMOVABLE_MODULES entry for the retired hyperpod-cluster', () => {
        // The documented cutover `remove-module hyperpod-cluster` must still work even
        // though the module is gone from the manifest — a provisioned pre-split profile
        // needs to tear down its old 3-stack set.
        assert.match(HANDLER_SRC, /LEGACY_REMOVABLE_MODULES/);
        assert.match(HANDLER_SRC, /'hyperpod-cluster':\s*\{/);
        assert.match(HANDLER_SRC, /stacks:\s*\['eks-cluster', 'hyperpod-cluster', 'inference-operator'\]/);
    });

    it('remove-module falls back to the legacy descriptor only when provisioned', () => {
        // Guard: the fallback requires the module to be in provisionedModules, so an
        // unknown module name still errors.
        assert.match(HANDLER_SRC, /LEGACY_REMOVABLE_MODULES\[moduleName\] && provisioned\.includes\(moduleName\)/);
    });
});

describe('remove-module purges profile memory', () => {
    const HANDLER_SRC = readFileSync(
        resolve(__dirname, '../../src/lib/bootstrap-command-handler.js'), 'utf8');

    it('DENORMALIZED_FLAT_KEYS covers every flat key the denormalizer writes (no drift)', () => {
        // Extract every `profileData.<key> =` assignment inside _denormalizeModuleOutputs,
        // and assert each is listed in DENORMALIZED_FLAT_KEYS (minus structural keys).
        const denormStart = HANDLER_SRC.indexOf('_denormalizeModuleOutputs(profileData)');
        const denormEnd = HANDLER_SRC.indexOf('_forgetModuleFromProfile(');
        const denormBody = HANDLER_SRC.slice(denormStart, denormEnd);
        const written = new Set();
        for (const m of denormBody.matchAll(/profileData\.([A-Za-z0-9_]+)\s*=/g)) {
            written.add(m[1]);
        }
        // the structural keys set at build-final-profile time, not by the denormalizer
        const structural = new Set(['awsProfile', 'accountId', 'awsRegion',
            'provisionedModules', 'moduleOutputs']);
        const listBlock = HANDLER_SRC.slice(
            HANDLER_SRC.indexOf('const DENORMALIZED_FLAT_KEYS'),
            HANDLER_SRC.indexOf('export default class'));
        for (const key of written) {
            if (structural.has(key)) continue;
            assert.ok(listBlock.includes(`'${key}'`),
                `DENORMALIZED_FLAT_KEYS is missing '${key}' — a removed module would leave it stale`);
        }
    });

    it('_forgetModuleFromProfile purges flat keys and re-derives from survivors', () => {
        // Behavioral: build a profile with core + hyperpod outputs + their flat keys,
        // forget hyperpod, assert hyperpod flat keys are gone and core's survive.
        const require2 = require; // reuse createRequire
        // Minimal handler with an isolated in-memory config.
        const HandlerMod = require2(resolve(__dirname, '../../src/lib/bootstrap-command-handler.js'));
        // ESM default export under CJS interop:
        const Handler = HandlerMod.default || HandlerMod;
        const saved = {};
        const h = new Handler({});
        h.config = { setProfile: (n, cfg) => { saved[n] = cfg; } };
        const profileConfig = {
            provisionedModules: ['core', 'hyperpod'],
            moduleOutputs: {
                core: { RoleArn: 'arn:aws:iam::1:role/x', EcrRepositoryName: 'repo' },
                hyperpod: { HyperPodClusterName: 'hp', HyperPodClusterArn: 'arn:hp' }
            },
            roleArn: 'arn:aws:iam::1:role/x',
            ecrRepositoryName: 'repo',
            hyperpodClusterName: 'hp',
            hyperpodClusterArn: 'arn:hp'
        };
        h._forgetModuleFromProfile('t', profileConfig, 'hyperpod');
        assert.deepEqual(profileConfig.provisionedModules, ['core']);
        assert.ok(!('hyperpod' in profileConfig.moduleOutputs), 'hyperpod outputs dropped');
        assert.strictEqual(profileConfig.hyperpodClusterName, undefined, 'stale flat key purged');
        assert.strictEqual(profileConfig.hyperpodClusterArn, undefined, 'stale flat key purged');
        // core survivors re-derived
        assert.strictEqual(profileConfig.roleArn, 'arn:aws:iam::1:role/x', 'survivor flat key kept');
        assert.strictEqual(profileConfig.ecrRepositoryName, 'repo', 'survivor flat key kept');
    });

    it('teardown failure still reconciles the profile (always purges)', () => {
        // The teardown is wrapped so a failure captures the error but STILL calls
        // _forgetModuleFromProfile — assert that control flow in source.
        assert.match(HANDLER_SRC, /catch \(err\) \{\s*\n\s*teardownFailed = err;/);
        assert.match(HANDLER_SRC, /this\._forgetModuleFromProfile\(name, profileConfig, moduleName\);/);
    });

    it('handle() extracts --skip-teardown from passThroughOptions args into options', async () => {
        // Regression: --skip-teardown was declared in cli.js but NOT in handle()'s
        // flag-extraction loop, so it stayed buried in args and the teardown ran anyway.
        const require2 = require;
        const HandlerMod = require2(resolve(__dirname, '../../src/lib/bootstrap-command-handler.js'));
        const Handler = HandlerMod.default || HandlerMod;
        const h = new Handler({});
        let seenOpts = null;
        h._handleModuleRemove = async (_mod, opts) => { seenOpts = opts; };
        await h.handle(['remove-module', 'eks', '--skip-teardown'], {});
        assert.ok(seenOpts, '_handleModuleRemove was called');
        assert.strictEqual(seenOpts.skipTeardown, true, '--skip-teardown reached options.skipTeardown');
    });
});
