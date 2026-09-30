// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ADR-008 deployment-target descriptor reader — Node unit tests (Wave 8 T2).
 *
 * Exercises src/lib/target-manifest-reader.js, the generation-time counterpart
 * of target_manifest.py. Both read the same targets.d descriptors.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import {
    listTargets,
    getDescriptor,
    allDescriptors,
    resolveTarget,
    statusVar,
    successStatus,
    answerKey,
    verbs,
    statusVarToAnswerKey,
    runtimeOwnedVarsUnion
} from '../../src/lib/target-manifest-reader.js';

const TARGETS = ['async-inference', 'batch-transform', 'eks', 'hyperpod-eks', 'realtime-inference'];

describe('target-manifest-reader (ADR-008)', () => {
    it('lists all five targets sorted', () => {
        assert.deepStrictEqual(listTargets(), TARGETS);
    });

    it('reads each descriptor with its canonical target key', () => {
        for (const t of TARGETS) {
            const d = getDescriptor(t);
            assert.ok(d, `descriptor for ${t}`);
            assert.strictEqual(d.target, t);
        }
    });

    it('typed accessors return today\'s values', () => {
        assert.strictEqual(statusVar('realtime-inference'), 'DEPLOYMENT_TARGET_SMAI_STATUS');
        assert.strictEqual(successStatus('realtime-inference'), 'InService');
        assert.strictEqual(answerKey('realtime-inference'), 'deploymentTargetSmaiStatus');

        assert.strictEqual(statusVar('batch-transform'), 'DEPLOYMENT_TARGET_BATCH_STATUS');
        assert.strictEqual(successStatus('batch-transform'), 'Completed');

        assert.strictEqual(statusVar('eks'), 'DEPLOYMENT_TARGET_EKS_STATUS');
        assert.strictEqual(successStatus('eks'), 'Running');
    });

    it('resolves aliases to canonical names', () => {
        assert.strictEqual(resolveTarget('managed-inference'), 'realtime-inference');
        assert.strictEqual(resolveTarget('hyperpod'), 'hyperpod-eks');
        assert.strictEqual(resolveTarget('async'), 'async-inference');
        assert.strictEqual(resolveTarget('batch'), 'batch-transform');
        assert.strictEqual(resolveTarget('eks'), 'eks');
    });

    it('getDescriptor works by alias', () => {
        assert.strictEqual(getDescriptor('managed-inference').target, 'realtime-inference');
    });

    it('returns null / empty for unknown targets', () => {
        assert.strictEqual(getDescriptor('nope'), null);
        assert.strictEqual(statusVar('nope'), '');
        assert.strictEqual(resolveTarget('nope'), 'nope');
    });

    it('verbs map reflects Wave 6 applicability', () => {
        assert.strictEqual(verbs('realtime-inference')['add-ic'], true);
        assert.strictEqual(verbs('eks')['add-ic'], false);
        assert.strictEqual(verbs('eks').adapter, true);
        assert.strictEqual(verbs('async-inference').optimize, false);
        assert.strictEqual(verbs('hyperpod-eks').draft, true);
    });

    it('statusVarToAnswerKey covers all five status vars', () => {
        const map = statusVarToAnswerKey();
        assert.strictEqual(map.DEPLOYMENT_TARGET_SMAI_STATUS, 'deploymentTargetSmaiStatus');
        assert.strictEqual(map.DEPLOYMENT_TARGET_EKS_STATUS, 'deploymentTargetEksStatus');
        assert.strictEqual(Object.keys(map).length, 5);
    });

    it('runtimeOwnedVarsUnion includes every status var + HP_* set', () => {
        const union = runtimeOwnedVarsUnion();
        for (const t of TARGETS) {
            assert.ok(union.includes(statusVar(t)), `${statusVar(t)} in union`);
        }
        assert.ok(union.includes('HP_CLUSTER_NAME'));
        assert.ok(union.includes('KUBECONFIG'));
    });

    it('every descriptor has status_var in its own runtime_owned_vars', () => {
        for (const d of allDescriptors()) {
            assert.ok((d.runtime_owned_vars || []).includes(d.status_var),
                `${d.target} runtime_owned_vars must include its status_var`);
        }
    });
});
