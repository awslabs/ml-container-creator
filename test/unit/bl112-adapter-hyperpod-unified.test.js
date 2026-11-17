// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * v18-w4-01-bl112 — Unified do/adapter verbs on hyperpod-eks.
 *
 * Example / integration / regression tests (per the design's Testing Strategy)
 * for behaviors that act over fixed invocation shapes or tiny input sets, so
 * property-based generation adds no coverage:
 *   - Direct-pod port-forward (Req 5.1): pod/<name> on 8080, never svc/.
 *   - --profile forwarding (Req 6.1): threaded to describe-cluster + update-kubeconfig.
 *   - vLLM error paths: 409 already-exists, load/unload failure, empty list.
 *   - Sourcing verbs (Wave 6 / BL169): from-* ACCEPTED on k8s via the shared resolver.
 *   - Legacy-flag deprecation (Req 8.1, 8.2): --load-lora/--unload-lora warn + redirect.
 *   - SMAI unchanged (Req 9.1): realtime-inference never enters _adapter_hyperpod.
 *
 * The router is bash text; these assertions target the rendered do/adapter
 * script's _adapter_hyperpod function.
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');

const ADAPTER_SRC = readFileSync(path.join(REPO, 'templates/do/adapter'), 'utf8');

function renderAdapter(vars = {}) {
    return ejs.render(ADAPTER_SRC, {
        projectName: 'test-project',
        awsRegion: 'us-east-1',
        ...vars
    });
}

/** _adapter_hyperpod function body (excludes the SMAI dispatch below it). */
function hyperpodBody(rendered) {
    const start = rendered.indexOf('_adapter_hyperpod() {');
    assert.ok(start !== -1, 'must define _adapter_hyperpod()');
    const callSite = rendered.indexOf('_adapter_hyperpod "$@"', start);
    assert.ok(callSite !== -1, 'must invoke _adapter_hyperpod "$@"');
    return rendered.slice(start, callSite);
}

/** Non-comment lines only, so explanatory prose can't satisfy a command assertion. */
function commandLines(src) {
    return src
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
}

const RENDERED = renderAdapter();
const CONTRACT = readFileSync(path.join(REPO, 'templates/do/lib/script-contract.sh'), 'utf8');
const HP = hyperpodBody(RENDERED);
const HP_CMDS = commandLines(HP);

describe('Feature: v18-w4-01-bl112 — direct-pod port-forward (Req 5.1)', () => {
    it('port-forwards to pod/<name>, never svc/', () => {
        assert.ok(
            /kubectl port-forward "pod\/\$\{_pod\}" "\$\{HP_LOCAL_PORT:-8080\}:8080"/.test(HP_CMDS),
            'must port-forward directly to the resolved pod on 8080'
        );
        assert.ok(
            !/kubectl port-forward "svc\//.test(HP_CMDS),
            'must NOT port-forward a svc/ resource'
        );
    });

    it('resolves the Running serving pod by app=${PROJECT_NAME} with the phase guard', () => {
        assert.ok(
            /kubectl get pod -n "\$\{HP_NAMESPACE:-default\}"/.test(HP_CMDS),
            'must query pods in HP_NAMESPACE'
        );
        assert.ok(/-l "app=\$\{PROJECT_NAME\}"/.test(HP_CMDS), 'must select by app=${PROJECT_NAME}');
        assert.ok(
            /--field-selector=status\.phase=Running/.test(HP_CMDS),
            'must filter to Running pods (same guard as do/benchmark)'
        );
        // Wave 6.1 R1.6: EVERY Running pod (was: only the first).
        assert.ok(
            /jsonpath='\{range \.items\[\*\]\}\{\.metadata\.name\}\{"\\n"\}\{end\}'/.test(HP_CMDS),
            'must list every Running pod name'
        );
        assert.ok(/for _pod in \$\{_PODS\}; do/.test(HP_CMDS), 'must act on each Running pod');
    });

    it('errors clearly when no Running pod is found (before port-forward)', () => {
        assert.ok(
            /No Running pod found for app=\$\{PROJECT_NAME\}/.test(HP),
            'must emit a no-pod error'
        );
        const noPodPos = HP.indexOf('No Running pod found');
        const pfPos = HP.indexOf('kubectl port-forward "pod/', noPodPos);
        assert.ok(noPodPos !== -1 && pfPos !== -1 && noPodPos < pfPos,
            'the no-pod guard must precede the port-forward');
    });

    it('fails fast if the port-forward does not start', () => {
        assert.ok(/kill -0 \$\{_PF_PID\}/.test(HP_CMDS), 'must verify the port-forward PID');
        assert.ok(/Port-forward to pod\/\$\{_pod\} failed to start/.test(HP), 'must report a failed port-forward');
    });
});

describe('Feature: v18-w4-01-bl112 — --profile forwarding (Req 6.1)', () => {
    it('builds a --profile arg from _PROFILE_awsProfile', () => {
        assert.ok(
            /_profile_arg="--profile \$\{_PROFILE_awsProfile\}"/.test(HP),
            'must build ${_profile_arg} from _PROFILE_awsProfile'
        );
    });

    it('threads ${_profile_arg} into aws sagemaker describe-cluster', () => {
        const describe = HP.slice(
            HP.indexOf('aws sagemaker describe-cluster'),
            HP.indexOf('EKS_CLUSTER_NAME=')
        );
        assert.ok(/\$\{_profile_arg\}/.test(describe), 'describe-cluster must receive ${_profile_arg}');
    });

    it('threads ${_profile_arg} into aws eks update-kubeconfig', () => {
        const upd = HP.slice(
            HP.indexOf('aws eks update-kubeconfig'),
            HP.indexOf('export KUBECONFIG')
        );
        assert.ok(/\$\{_profile_arg\}/.test(upd), 'update-kubeconfig must receive ${_profile_arg}');
    });
});

describe('Feature: v18-w4-01-bl112 — vLLM error handling', () => {
    it('reports a 409 already-loaded with a remove remediation', () => {
        assert.ok(/STATUS_CODE.*=.*"409"/.test(HP) || /"409"/.test(HP), 'must detect 409');
        assert.ok(/already exists\./.test(HP), 'must say the adapter already exists');
        assert.ok(/do\/adapter remove \$\{_name\}/.test(HP), 'must point to do/adapter remove');
    });

    it('reports a generic load failure with the error message', () => {
        assert.ok(/Failed to load LoRA adapter/.test(HP), 'must report load failure');
    });

    it('reports an unload failure with the error message', () => {
        assert.ok(/Failed to unload LoRA adapter/.test(HP), 'must report unload failure');
    });

    it('update aborts before load when unload fails', () => {
        const dispatch = HP.slice(HP.indexOf('# ── Dispatch to lora_vllm.py'));
        const updateArm = dispatch.slice(dispatch.indexOf('                update)'), dispatch.indexOf('                list)'));
        assert.ok(
            /_lora_do_unload "\$\{LORA_NAME\}" \|\| return 1\s*\n\s*_lora_do_load/.test(updateArm),
            'a failed unload must abort (per pod) before the load runs'
        );
    });

    it('treats an empty list as success (exit 0) with an add hint', () => {
        assert.ok(/No LoRA adapters loaded\./.test(HP), 'must handle empty list');
        assert.ok(/do\/adapter add <name> --from-weights s3:\/\//.test(HP), 'must hint the add verb');
    });
});

describe('Wave 6 / BL169 — sourcing verbs ACCEPTED on Kubernetes (supersedes the BL112 Req 7 guard)', () => {
    // BL112 refused from-hub/from-tune/from-train/from-registry on k8s. Wave 6
    // (ADR-013 R1.2 target-uniform sources) deletes that refusal: the k8s path
    // takes the SAME --from-* flag surface as the SMAI path and routes it through
    // the shared resolver into the existing vLLM hot-load. Behavior is exercised
    // end-to-end in additive-deploy-verbs.test.js; these are structural guards.
    it('no longer refuses the sourcing verbs', () => {
        assert.ok(!/from-hub\|from-tune\|from-train\|from-registry\)/.test(HP_CMDS),
            'the BL112 sourcing-verb refusal branch must be gone');
        assert.ok(!/_contract_violation "target"/.test(HP_CMDS),
            'the k8s router must not raise a target violation for a source verb');
    });

    ['--from-weights', '--from-hub', '--from-tune', '--from-train', '--from-registry'].forEach((f) => {
        it(`add/update parse ${f} (the SMAI flag surface)`, () => {
            assert.ok(HP_CMDS.includes(f), `k8s parser must accept ${f}`);
        });
    });

    it('resolves through the shared _resolve_additive_source before the port-forward', () => {
        const resolvePos = HP_CMDS.indexOf('_resolve_additive_source "${_SRC_VERB}"');
        const pfPos = HP_CMDS.indexOf('kubectl port-forward "pod/');
        assert.ok(resolvePos !== -1, 'must call the shared resolver');
        assert.ok(resolvePos < pfPos, 'resolution (and its failures) must precede any cluster connection');
        assert.ok(/WEIGHTS_URI="\$\{RESOLVED_URI\}"/.test(HP_CMDS), 'RESOLVED_URI feeds the existing hot-load');
    });

    it('kind-guards via the contract table (a full_model is refused)', () => {
        assert.ok(/_guard_artifact_kind "\$\{RESOLVED_KIND\}" "\$\(_additive_accepts_kind adapter\)"/.test(HP_CMDS),
            'the gate must read the accepted kind from the contract table');
    });
});

describe('Feature: v18-w4-01-bl112 — legacy-flag deprecation (Req 8.1, 8.2)', () => {
    it('--load-lora warns and rewrites to add', () => {
        const arm = HP.slice(HP.indexOf('--load-lora)'), HP.indexOf('--unload-lora)'));
        assert.ok(/⚠️.*--load-lora is deprecated/.test(arm), 'must warn on --load-lora');
        assert.ok(/use: do\/adapter add <name> --from-weights s3:\/\//.test(arm), 'must name the add replacement');
        assert.ok(/CMD="add"/.test(arm), 'must rewrite to add');
        assert.ok(/>&2/.test(arm), 'deprecation warning must go to stderr');
    });

    it('--unload-lora warns and rewrites to remove', () => {
        const loadPos = HP.indexOf('--load-lora)');
        const arm = HP.slice(HP.indexOf('--unload-lora)', loadPos), HP.indexOf('Parse unified verbs into an internal'));
        assert.ok(/⚠️.*--unload-lora is deprecated/.test(arm), 'must warn on --unload-lora');
        assert.ok(/use: do\/adapter remove <name>/.test(arm), 'must name the remove replacement');
        assert.ok(/CMD="remove"/.test(arm), 'must rewrite to remove');
        assert.ok(/>&2/.test(arm), 'deprecation warning must go to stderr');
    });

    it('legacy shims run before the unified router (converge on ACTION)', () => {
        const shimPos = HP.indexOf('# ── Legacy-flag deprecation shims');
        const routerPos = HP.indexOf('Parse unified verbs into an internal');
        assert.ok(shimPos !== -1 && routerPos !== -1 && shimPos < routerPos,
            'deprecation shims must precede the unified verb parser');
    });
});

describe('do/adapter — plain eks target support (Wave 6 follow-up, ADR-007)', () => {
    // eks is a first-class (untested) target: vLLM on plain EKS without the
    // HyperPod Inference Operator. LoRA hot-load works identically to hyperpod-eks,
    // so adapters must be ALLOWED on eks (routed to the same vLLM path), not rejected.
    const commands = commandLines(RENDERED);

    // Wave 6 (ADR-013): the target allow-list and the k8s routing are DERIVED
    // from the additive-deploy contract table, not hand-listed. Per-target
    // accept/refuse is asserted behaviorally in additive-deploy-contract.test.js.
    it('gates targets through the derived contract (eks included via its mechanism)', () => {
        assert.ok(
            /_additive_verb_supported_on adapter "\$\{DEPLOYMENT_TARGET:-\}"/.test(commands),
            'do/adapter must gate with the contract-derived _additive_verb_supported_on'
        );
        assert.ok(/eks\)\s+echo "vllm-hotload"/.test(CONTRACT), 'eks must expose the vllm-hotload mechanism');
        assert.ok(/hyperpod-eks\)\s+echo "vllm-hotload[ a-z-]*"/.test(CONTRACT), 'hyperpod-eks must expose vllm-hotload');
    });

    it('routes eks through the same vLLM k8s path as hyperpod-eks (by mechanism)', () => {
        assert.ok(
            /_ADAPTER_MECHANISMS="\$\(_additive_mechanism_for adapter "\$\{DEPLOYMENT_TARGET:-\}"\)"/.test(commands),
            'the mechanism set must be derived for the current target'
        );
        assert.ok(/\*" vllm-hotload "\*\) _ADAPTER_USE_VLLM_HOTLOAD="true"/.test(commands),
            'the vLLM hot-load branch must fire on the vllm-hotload mechanism');
    });

    it('declares eks in its @mlcc-script targets', () => {
        assert.ok(
            /# targets:.*\beks\b/.test(ADAPTER_SRC),
            'the contract targets field must list eks'
        );
    });

    it('does not statically reject eks anywhere', () => {
        // No target-restriction should name eks as unsupported.
        assert.ok(
            !/is not supported on.*\beks\b/.test(commands),
            'eks must not be rejected by any adapter target guard'
        );
    });
});

describe('Feature: v18-w4-01-bl112 — realtime-inference unchanged (Req 9.1)', () => {
    it('the hyperpod branch exits before the SMAI dispatch is reachable', () => {
        const branchPos = RENDERED.indexOf('if [ -n "${_ADAPTER_USE_VLLM_HOTLOAD}" ]; then');
        const callPos = RENDERED.indexOf('_adapter_hyperpod "$@"');
        const exitPos = RENDERED.indexOf('exit $?', callPos);
        assert.ok(branchPos !== -1 && callPos > branchPos, 'hyperpod branch must call the router');
        assert.ok(exitPos !== -1 && exitPos > callPos, 'router call must be followed by exit $?');
    });

    it('SMAI verb handlers and from-* sourcing remain defined for realtime-inference', () => {
        const rendered = renderAdapter();
        // SMAI handlers untouched.
        ['_adapter_add', '_adapter_remove', '_adapter_list', '_adapter_update', '_adapter_search']
            .forEach((fn) => assert.ok(rendered.includes(fn), `SMAI handler ${fn} must remain`));
        // SMAI sourcing verbs remain available (below the hyperpod early-exit).
        const smai = rendered.slice(rendered.indexOf('_adapter_hyperpod "$@"'));
        ['--from-hub', '--from-tune', '--from-train', '--from-registry']
            .forEach((f) => assert.ok(smai.includes(f), `SMAI sourcing flag ${f} must remain available`));
    });

    it('does not reference _adapter_hyperpod anywhere in the SMAI path', () => {
        const smai = RENDERED.slice(RENDERED.indexOf('_adapter_hyperpod "$@"') + 'adapter_hyperpod "$@"'.length);
        assert.ok(!smai.includes('_adapter_hyperpod'), 'SMAI path must not invoke the hyperpod router');
    });
});

describe('Feature: v18-w4-01-bl112 — unified verb usage text', () => {
    it('help documents add/remove/list/update and marks legacy flags deprecated', () => {
        const help = HP.slice(HP.indexOf('--help|-h|""'), HP.indexOf('exit 0'));
        assert.ok(/add <name> --from-weights s3:\/\//.test(help), 'help lists add');
        assert.ok(/add <name> --from-tune/.test(help), 'help lists the k8s --from-tune capability');
        assert.ok(/remove <name>/.test(help), 'help lists remove');
        assert.ok(/\blist\b/.test(help), 'help lists list');
        assert.ok(/update <name> --from-weights s3:\/\//.test(help), 'help lists update');
        assert.ok(/Deprecated/.test(help), 'help marks the legacy flags as deprecated');
    });
});
