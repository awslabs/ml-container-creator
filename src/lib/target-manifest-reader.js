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

/** The target's verb-applicability map (verb -> boolean). */
export function verbs(target, targetsDir = TARGETS_D) {
    const d = getDescriptor(target, targetsDir);
    return d && d.verbs ? d.verbs : {};
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
