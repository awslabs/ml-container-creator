// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * PATTERN: Manifest reader (single source of truth) — the generation-time Node
 *   counterpart of templates/do/lib/python/deploy_answers.py. Both read the same
 *   per-target answer_params arrays in targets.d/<target>/manifest.json, so the
 *   deploy answer-key contract (CLI flag -> answer key -> config var) has ONE
 *   source of truth instead of the four hand-maintained tables it used to live
 *   in (CLI_FLAG_TO_VARS, flag_to_answer_key, _ANSWER_KEY_TO_VAR, the do/deploy
 *   KEY_MAP). See ADR-008 and .kiro/steering/derive-dont-hardcode.md.
 * COLLABORATORS: reads templates/do/targets.d/(all)/manifest.json via
 *   target-manifest-reader.js; consumed at generation time by
 *   deploy-config-builder.js (CLI_FLAG_TO_VARS) and by scripts/codegen-deploy-flags.js
 *   (do/deploy arg-parse arms + both forwarding blocks).
 * DATA-FLOW ROLE: turns the per-target answer_params into the six projections the
 *   scattered consumers need, so they can no longer silently disagree.
 *
 * The role model (per answer_params entry `roles`):
 *   flag-input     — has a CLI flag; feeds the builder/helper flag tables, the
 *                    do/deploy arg-parse arms and both forwarding blocks.
 *   prompt-core    — the core target/instance_type params handled specially by
 *                    the builder (NOT in its per-target flag table) but still
 *                    answer keys on the Python side.
 *   internal       — no flag; produced by prompts/builder; part of the
 *                    DEPLOY_ANSWERS input surface (_ANSWER_KEY_TO_VAR).
 *   builder-output — emitted ONLY in the Node builder's JSON output (has no flag
 *                    and no prompt input): the pure-output KEY_MAP entries such as
 *                    the target-scoped *_instance_type / *_endpoint_name vars and
 *                    inference_ami_version.
 *   input-only     — the rare params the builder does NOT re-emit, so they are in
 *                    the input surface but MUST be excluded from the output KEY_MAP
 *                    (endpoint_name, whose value is re-emitted target-scoped as
 *                    smai_/async_endpoint_name; and hp_instance_group_name).
 *
 * Surfaces:
 *   input  (_ANSWER_KEY_TO_VAR) = everything a caller/prompt can supply =
 *          flag-input ∪ prompt-core ∪ internal (i.e. every param that is not a
 *          pure builder-output key).
 *   output (do/deploy KEY_MAP)  = everything the builder emits = every param
 *          EXCEPT those tagged input-only.
 */

import { allDescriptors } from './target-manifest-reader.js';

/**
 * Every answer_params entry across all target descriptors, in a stable order:
 * target order (canonical-name sorted, from allDescriptors) then declaration
 * order within each target.
 * @param {string} [targetsDir] - Optional override for the targets.d root (tests).
 * @returns {Array<{answerKey:string, configVar:string, flag?:string, roles:string[], target:string}>}
 */
export function allAnswerParams(targetsDir) {
    const out = [];
    for (const d of allDescriptors(targetsDir)) {
        for (const p of d.answer_params || []) {
            out.push({ ...p, target: d.target });
        }
    }
    return out;
}

/**
 * Deduplicate params by answerKey while asserting cross-target consistency:
 * two targets may declare the same answerKey (Option B), but they MUST agree on
 * configVar / flag / roles-membership. Throws on conflict so a divergent
 * descriptor fails loudly rather than silently picking one.
 * @param {string} [targetsDir]
 * @returns {Map<string, {answerKey:string, configVar:string, flag?:string, roles:string[]}>}
 */
export function answerParamsByKey(targetsDir) {
    const map = new Map();
    for (const p of allAnswerParams(targetsDir)) {
        const existing = map.get(p.answerKey);
        if (!existing) {
            map.set(p.answerKey, {
                answerKey: p.answerKey,
                configVar: p.configVar,
                flag: p.flag,
                roles: [...p.roles]
            });
            continue;
        }
        if (existing.configVar !== p.configVar) {
            throw new Error(
                `answer_params conflict: answerKey '${p.answerKey}' maps to ` +
                `'${existing.configVar}' and '${p.configVar}' in different targets`
            );
        }
        if ((existing.flag || '') !== (p.flag || '')) {
            throw new Error(
                `answer_params conflict: answerKey '${p.answerKey}' has flag ` +
                `'${existing.flag || ''}' and '${p.flag || ''}' in different targets`
            );
        }
        // Union roles so a key that is flag-input in one target and, say,
        // builder-output nowhere stays coherent; roles that differ are unioned.
        for (const r of p.roles) {
            if (!existing.roles.includes(r)) existing.roles.push(r);
        }
    }
    return map;
}

/** True if the param carries the given role. */
const hasRole = (p, role) => p.roles.includes(role);

/**
 * Builder CLI_FLAG_TO_VARS projection: per-target flags only (flag-input and
 * NOT prompt-core), keyed by flag. { '--flag': { configVar, answerKey } }.
 * @param {string} [targetsDir]
 * @returns {Object<string,{configVar:string, answerKey:string}>}
 */
export function flagToVars(targetsDir) {
    const out = {};
    for (const p of answerParamsByKey(targetsDir).values()) {
        if (hasRole(p, 'flag-input') && !hasRole(p, 'prompt-core') && p.flag) {
            out[p.flag] = { configVar: p.configVar, answerKey: p.answerKey };
        }
    }
    return out;
}

/**
 * Helper flag_to_answer_key projection: every param with a flag, keyed by its
 * argparse attribute (== answerKey). Identity map { answerKey: answerKey }.
 * @param {string} [targetsDir]
 * @returns {Object<string,string>}
 */
export function flagToAnswerKey(targetsDir) {
    const out = {};
    for (const p of answerParamsByKey(targetsDir).values()) {
        if (p.flag) out[p.answerKey] = p.answerKey;
    }
    return out;
}

/**
 * answerKey -> configVar projection for a given surface.
 *   'input'  — the DEPLOY_ANSWERS input surface (deploy_prompts _ANSWER_KEY_TO_VAR):
 *              everything a caller/prompt can supply = flag-input ∪ prompt-core ∪
 *              internal (i.e. every param that is not a pure builder-output key).
 *   'output' — the builder-output surface (do/deploy KEY_MAP): everything the
 *              builder emits = every param EXCEPT those tagged input-only
 *              (endpoint_name, hp_instance_group_name), which the builder does not
 *              re-emit.
 * @param {'input'|'output'} surface
 * @param {string} [targetsDir]
 * @returns {Object<string,string>}
 */
export function answerKeyToVar(surface, targetsDir) {
    if (surface !== 'input' && surface !== 'output') {
        throw new Error(`answerKeyToVar: surface must be 'input' or 'output', got '${surface}'`);
    }
    const out = {};
    for (const p of answerParamsByKey(targetsDir).values()) {
        const include = surface === 'input'
            ? !isPureBuilderOutput(p)
            : !hasRole(p, 'input-only');
        if (include) out[p.answerKey] = p.configVar;
    }
    return out;
}

/** A pure builder-output key: emitted by the builder, never a flag/prompt/internal input. */
function isPureBuilderOutput(p) {
    return hasRole(p, 'builder-output') &&
        !hasRole(p, 'flag-input') &&
        !hasRole(p, 'prompt-core') &&
        !hasRole(p, 'internal');
}

/** The kebab CLI flag (e.g. --async-max-concurrent) -> FLAG_* shell var name. */
export function flagToShellVar(flag) {
    return `FLAG_${flag.replace(/^--/, '').replace(/-/g, '_').toUpperCase()}`;
}

/**
 * The ordered list of flag params for codegen (arg-parse arms + forwarding).
 * Preserves declaration order across targets, deduped by flag. Excludes the two
 * core flags (--target, --instance-type) which do/deploy handles explicitly, so
 * codegen only owns the per-target optional flags — matching today's blocks.
 * @param {string} [targetsDir]
 * @returns {Array<{flag:string, answerKey:string, configVar:string, shellVar:string}>}
 */
export function flagParams(targetsDir) {
    const seen = new Set();
    const out = [];
    for (const p of allAnswerParams(targetsDir)) {
        if (!p.flag) continue;
        if (hasRole(p, 'prompt-core')) continue; // --target / --instance-type handled explicitly
        if (seen.has(p.flag)) continue;
        seen.add(p.flag);
        out.push({
            flag: p.flag,
            answerKey: p.answerKey,
            configVar: p.configVar,
            shellVar: flagToShellVar(p.flag)
        });
    }
    return out;
}
