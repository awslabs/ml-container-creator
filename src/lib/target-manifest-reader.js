// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * PATTERN: Manifest reader (single source of truth) — the generation-time Node
 *   counterpart of templates/do/lib/python/target_manifest.py. Both read the
 *   same targets.d/<target>/manifest.json descriptors, so a deployment target's
 *   contract has ONE source of truth (ADR-008).
 * COLLABORATORS: reads templates/do/targets.d/*; consumed at generation time by
 *   do-config.js (SHELL_VAR_TO_ANSWER), regenerate-command-handler.js
 *   (RUNTIME_OWNED_VARS), app.js (per-target asset handling), and the do/config
 *   status-var block — each DERIVES its per-target knowledge from here instead of
 *   hardcoding it.
 * DATA-FLOW ROLE: turns the per-target descriptors into the values the scattered
 *   JS/template authorities need, so they can no longer silently disagree.
 * See: docs/adr/ADR-008-deployment-target-descriptor.md,
 *   docs/architecture/deployment-target-authoring.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');
const TARGETS_D = path.join(GENERATOR_ROOT, 'templates', 'do', 'targets.d');

/**
 * List the canonical target names (descriptor directory names), sorted.
 * @param {string} [targetsDir] - Optional override for the targets.d root (tests).
 * @returns {string[]}
 */
export function listTargets(targetsDir = TARGETS_D) {
    let entries;
    try {
        entries = fs.readdirSync(targetsDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => fs.existsSync(path.join(targetsDir, name, 'manifest.json')))
        .sort();
}

/**
 * Read a single target descriptor. Accepts a canonical name or an alias.
 * @param {string} target
 * @param {string} [targetsDir]
 * @returns {Object|null} the descriptor, or null when not found / unreadable.
 */
export function getDescriptor(target, targetsDir = TARGETS_D) {
    if (!target) return null;
    const direct = path.join(targetsDir, target, 'manifest.json');
    if (fs.existsSync(direct)) {
        try {
            return JSON.parse(fs.readFileSync(direct, 'utf8'));
        } catch {
            return null;
        }
    }
    // Alias resolution: scan descriptors for one whose aliases include `target`.
    for (const name of listTargets(targetsDir)) {
        const d = getDescriptor(name, targetsDir);
        if (d && Array.isArray(d.aliases) && d.aliases.includes(target)) {
            return d;
        }
    }
    return null;
}

/**
 * Return all descriptors in canonical-name order.
 * @param {string} [targetsDir]
 * @returns {Object[]}
 */
export function allDescriptors(targetsDir = TARGETS_D) {
    return listTargets(targetsDir)
        .map(name => getDescriptor(name, targetsDir))
        .filter(Boolean);
}

/** Resolve an alias (or canonical name) to the canonical target name. */
export function resolveTarget(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d ? d.target : target;
}

/** The target's DEPLOYMENT_TARGET_<T>_STATUS var name (or '' if unknown). */
export function statusVar(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d ? d.status_var : '';
}

/** The target's active status value (InService|Running|Completed). */
export function successStatus(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d ? d.success_status : '';
}

/** The target's camelCase generator-answer key for its status var. */
export function answerKey(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d ? d.answer_key : '';
}

/**
 * The target's training compute backends (Wave 11 R1.1), in preference order;
 * the first entry is the default. Node twin of target_manifest.compute_backends().
 * A descriptor that predates the field reads as ['smtj'].
 * @returns {string[]}
 */
export function computeBackends(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d && Array.isArray(d.compute_backends) && d.compute_backends.length > 0
        ? d.compute_backends.slice()
        : ['smtj'];
}

/** The target's verb-applicability map (verb -> boolean). */
export function verbs(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d && d.verbs ? d.verbs : {};
}

/**
 * The target's adapter_delivery declaration (Wave 6.1 R1.1): how LoRA adapters
 * reach the serving pod ({strategy, mount_path, subdir}), or {} when none.
 * @returns {{strategy?: string, mount_path?: string, subdir?: string}}
 */
export function adapterDelivery(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d && d.adapter_delivery ? d.adapter_delivery : {};
}
/**
 * The target's pricing declaration (Wave 9 R7.1/R8.2): the Price List service,
 * the AmazonSageMaker component, and the billed instance-count basis, or {}.
 * Node twin of target_manifest.pricing(), used by the conformance test.
 * @returns {{service?: string, component?: string, instance_count?: Object}}
 */
export function pricing(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d && d.pricing ? d.pricing : {};
}

/**
 * The target's observability declaration (Wave 9 R1/R6/R12): where its serving
 * metrics live ({store, histogram_form, selector, gpu_selector, fallback,
 * dashboard, amp_discovery, copy_concurrency}). Node twin of
 * target_manifest.observability(); a target without the block reads as
 * {store: 'none'}.
 * @returns {{store: string, histogram_form?: string, selector?: Object<string,string>, dashboard?: string}}
 */
export function observability(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    const obs = d && d.observability ? { ...d.observability } : {};
    if (!obs.store) obs.store = 'none';
    return obs;
}
/**
 * The target's scale_to_zero declaration (Wave 10, ADR-014 R1): whether the
 * platform can scale it to zero ({support, mechanism, wake_signal,
 * requests_at_zero, idle_billing}) and whether MLCC wires it ({enabled, reason}).
 * Node twin of target_manifest.scale_to_zero(); a target without the block reads
 * as not-applicable and disabled.
 * @returns {{support: string, mechanism: ?string, wake_signal: ?string, requests_at_zero: string, idle_billing: string, enabled: boolean, reason?: string}}
 */
export function scaleToZero(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    if (d && d.scale_to_zero) return { ...d.scale_to_zero };
    return {
        support: 'not-applicable',
        mechanism: null,
        wake_signal: null,
        requests_at_zero: 'n/a',
        idle_billing: 'n/a',
        enabled: false,
        reason: 'this target declares no scale_to_zero capability'
    };
}

/**
 * The status_var -> answer_key map across all targets, for building
 * SHELL_VAR_TO_ANSWER's per-target status entries.
 * @returns {Object<string,string>}
 */
export function statusVarToAnswerKey(targetsDir = TARGETS_D) {
    const map = {};
    for (const d of allDescriptors(targetsDir)) {
        map[d.status_var] = d.answer_key;
    }
    return map;
}

/**
 * The union of every target's runtime_owned_vars (the per-target vars that
 * `mcc regenerate` must preserve). Combine with the shared/global runtime vars
 * to reproduce regenerate's RUNTIME_OWNED_VARS.
 * @returns {string[]} sorted, de-duplicated.
 */
export function runtimeOwnedVarsUnion(targetsDir = TARGETS_D) {
    const set = new Set();
    for (const d of allDescriptors(targetsDir)) {
        for (const v of d.runtime_owned_vars || []) set.add(v);
    }
    return [...set].sort();
}
