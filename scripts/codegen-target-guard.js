// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * codegen-target-guard.js — regenerates the mechanical target→status_var case
 * blocks in the do-runtime shell FROM the deployment-target descriptors
 * (templates/do/targets.d/*), so every per-target status_var map has a single
 * source of truth (ADR-008, Wave 8 T5).
 *
 * Three blocks are generated today, each delimited by marker comments so the
 * surrounding hand-authored logic is untouched:
 *   1. templates/do/lib/script-contract.sh  — _guard_deployment_active
 *        assigns `status_var` against `$target`, with a `*) status_var=""` fallback.
 *   2. templates/do/deploy                   — reconfigure active-check
 *        assigns `_RECONFIG_STATUS_VAR` against `$_RECONFIG_TARGET`, NO fallback
 *        (the surrounding `if [ -n "$_RECONFIG_STATUS_VAR" ]` treats unset as none).
 *   3. templates/do/deploy                   — switch-or-deploy
 *        assigns `_STATUS_VAR` against `$FLAG_TARGET`, with a `*) _STATUS_VAR=""` fallback.
 *
 * Each descriptor contributes one case arm keyed by `target|<aliases...>` →
 * status_var, emitted in canonical-target order. Run via `npm run codegen`;
 * the descriptor-conformance test fails if a checked-in block drifts from what
 * this would produce. All three renderers share one core (`renderStatusVarCase`)
 * so they cannot diverge in shape.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { allDescriptors } from '../src/lib/target-manifest-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPT_CONTRACT = path.join(ROOT, 'templates', 'do', 'lib', 'script-contract.sh');
const DEPLOY = path.join(ROOT, 'templates', 'do', 'deploy');
// BL159: the other do/ scripts carrying hand-maintained target enumerations.
const CLEAN = path.join(ROOT, 'templates', 'do', 'clean');
const LOGS = path.join(ROOT, 'templates', 'do', 'logs');
const EXPORT = path.join(ROOT, 'templates', 'do', 'export');
const TEST = path.join(ROOT, 'templates', 'do', 'test');

// Canonical emit order — deterministic regardless of directory read order.
const ORDER = ['realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks', 'eks'];

function sortedDescriptors(descriptors) {
    return [...descriptors].sort((a, b) => ORDER.indexOf(a.target) - ORDER.indexOf(b.target));
}

/**
 * Core renderer: a `case "$<caseVar>" in ... esac` that assigns <assignVar> the
 * status_var for each target|alias arm. Shared by all generated blocks so their
 * shape can never diverge.
 *
 * @param {object[]} descriptors  the target descriptors
 * @param {object}   opts
 * @param {string}   opts.indent      leading indent for `case`/`esac` lines
 * @param {string}   opts.caseVar     the shell var switched on (e.g. 'target')
 * @param {string}   opts.assignVar   the shell var assigned (e.g. 'status_var')
 * @param {boolean}  opts.fallback    emit a `*) <assignVar>="" ;;` arm last
 * @returns {string} the case block (no marker comments)
 */
function renderStatusVarCase(descriptors, { indent, caseVar, assignVar, fallback }) {
    const arm = `${indent}    `;
    const lines = [`${indent}case "$${caseVar}" in`];
    for (const d of sortedDescriptors(descriptors)) {
        const keys = [d.target, ...(d.aliases || [])].join('|');
        lines.push(`${arm}${keys}) ${assignVar}="${d.status_var}" ;;`);
    }
    if (fallback) {
        lines.push(`${arm}*) ${assignVar}="" ;;`);
    }
    lines.push(`${indent}esac`);
    return lines.join('\n');
}

/**
 * Descriptor of each generated region: which file, its marker comments, and the
 * case-block parameters. Keeping this table declarative lets `main()` and the
 * conformance test iterate over the same source of truth.
 */
export const REGIONS = [
    {
        name: '_guard_deployment_active',
        file: SCRIPT_CONTRACT,
        begin: '    # >>> GENERATED: target->status_var (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '    # <<< END GENERATED',
        opts: { indent: '    ', caseVar: 'target', assignVar: 'status_var', fallback: true }
    },
    {
        name: 'deploy reconfigure active-check',
        file: DEPLOY,
        begin: '    # >>> GENERATED: reconfigure target->status_var (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '    # <<< END GENERATED reconfigure',
        opts: { indent: '    ', caseVar: '_RECONFIG_TARGET', assignVar: '_RECONFIG_STATUS_VAR', fallback: false }
    },
    {
        name: 'deploy switch-or-deploy',
        file: DEPLOY,
        begin: '    # >>> GENERATED: switch-or-deploy target->status_var (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '    # <<< END GENERATED switch-or-deploy',
        opts: { indent: '    ', caseVar: 'FLAG_TARGET', assignVar: '_STATUS_VAR', fallback: true }
    },
    // ── BL159: target enumeration strings, DERIVED from the descriptors ───────
    // Each wraps a whole literal line (error string / usage / header comment) in
    // which `{{list}}` is the canonical comma-joined target list. Canonical names
    // only (aliases stay hand-authored — OQ-1). All five enumeration scripts list
    // all targets (OQ-2 default (i): no per-script verb filtering).
    {
        name: 'deploy --target error',
        file: DEPLOY,
        kind: 'targetList',
        begin: '            # >>> GENERATED: target-list (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '            # <<< END GENERATED target-list',
        opts: { template: '                echo "❌ --target requires a value ({{list}})"' }
    },
    {
        name: 'clean --target error',
        file: CLEAN,
        kind: 'targetList',
        begin: '            # >>> GENERATED: target-list (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '            # <<< END GENERATED target-list',
        opts: { template: '                echo "❌ --target requires a value ({{list}})"' }
    },
    {
        name: 'clean usage Targets header',
        file: CLEAN,
        kind: 'targetList',
        begin: '            # >>> GENERATED: target-list-usage (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '            # <<< END GENERATED target-list-usage',
        opts: { template: '            echo "Targets: {{list}}"' }
    },
    {
        name: 'logs --target error',
        file: LOGS,
        kind: 'targetList',
        begin: '            # >>> GENERATED: target-list (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '            # <<< END GENERATED target-list',
        opts: { template: '                echo "❌ --target requires a value ({{list}})"' }
    },
    {
        name: 'export --target error',
        file: EXPORT,
        kind: 'targetList',
        begin: '            # >>> GENERATED: target-list (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '            # <<< END GENERATED target-list',
        opts: { template: '                echo "Error: --target requires a value ({{list}})" >&2' }
    },
    {
        name: 'test --target error',
        file: TEST,
        kind: 'targetList',
        begin: '            # >>> GENERATED: target-list (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '            # <<< END GENERATED target-list',
        opts: { template: '                echo "❌ --target requires a value ({{list}})"' }
    },
    // ── Target dispatch (DO-5): the deploy/clean driver `case`, DERIVED from each
    // descriptor's target + aliases + deploy_script/clean_script. A hand-written
    // dispatcher let the `realtime` alias pass the generated guard and then fail
    // with "Unknown DEPLOYMENT_TARGET". Aliases are normalized to the canonical
    // target before the driver is sourced, so only canonical names reach do/config.
    {
        name: 'deploy target dispatch',
        file: DEPLOY,
        kind: 'dispatch',
        begin: '# >>> GENERATED: target dispatch (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '# <<< END GENERATED target dispatch',
        opts: { scriptField: 'deploy_script', argsVar: 'DEPLOY_ARGS', listValid: true },
        // One-time migration: before DO-5 this dispatcher was hand-written. When the
        // markers are absent, codegen replaces that legacy block (from this line to
        // its closing `esac`) with the generated region.
        legacyStart: 'case "$DEPLOYMENT_TARGET" in\n    realtime-inference|managed-inference)\n        source "${SCRIPT_DIR}/deploy.d/realtime-inference"'
    },
    {
        name: 'clean target dispatch',
        file: CLEAN,
        kind: 'dispatch',
        begin: '# >>> GENERATED: target dispatch (scripts/codegen-target-guard.js; ADR-008) — DO NOT EDIT',
        end: '# <<< END GENERATED target dispatch',
        opts: { scriptField: 'clean_script', argsVar: 'CLEAN_ARGS', listValid: true }
    }
];

/**
 * Render a target-dispatch `case` (DO-5): one arm per descriptor, keyed by
 * `target|<aliases…>`, that normalizes an alias to the canonical target and
 * sources the descriptor's driver script with the forwarded args array.
 *
 * @param {object[]} descriptors
 * @param {object}   opts
 * @param {string}   opts.scriptField  descriptor field naming the driver ('deploy_script' | 'clean_script')
 * @param {string}   opts.argsVar      bash array of forwarded args (e.g. 'DEPLOY_ARGS')
 * @param {boolean}  opts.listValid    print the canonical target list in the unknown-target arm
 * @returns {string}
 */
function renderDispatchCase(descriptors, { scriptField, argsVar, listValid }) {
    const args = `"\${${  argsVar  }[@]+"\${${  argsVar  }[@]}"}"`;
    const lines = ['case "$DEPLOYMENT_TARGET" in'];
    for (const d of sortedDescriptors(descriptors)) {
        const script = d[scriptField];
        if (!script) {
            throw new Error(`codegen-target-guard: descriptor ${d.target} has no ${scriptField}`);
        }
        lines.push(`    ${[d.target, ...(d.aliases || [])].join('|')})`);
        if ((d.aliases || []).length) {
            lines.push(`        DEPLOYMENT_TARGET="${d.target}"`);
        }
        lines.push(`        source "\${SCRIPT_DIR}/${script}" ${args}`);
        lines.push('        ;;');
    }
    lines.push('    *)');
    lines.push('        echo "❌ Unknown DEPLOYMENT_TARGET: $DEPLOYMENT_TARGET"');
    if (listValid) {
        lines.push(`        echo "   Valid targets: ${renderTargetList(descriptors)}"`);
    }
    lines.push('        exit 1');
    lines.push('        ;;');
    lines.push('esac');
    return lines.join('\n');
}

/**
 * Render a comma-joined canonical target list, in canonical ORDER.
 * e.g. "realtime-inference, async-inference, batch-transform, hyperpod-eks, eks".
 * Canonical names only (aliases are a separate, hand-authored concern — BL159 OQ-1).
 *
 * @param {object[]} descriptors  the target descriptors
 * @returns {string}
 */
function renderTargetList(descriptors) {
    return sortedDescriptors(descriptors).map((d) => d.target).join(', ');
}

/**
 * Core renderer for a "target-list" region (BL159): one or more lines of literal
 * shell/comment text in which the canonical target list is substituted for the
 * `{{list}}` placeholder. Used for the hand-maintained `--target requires a value
 * (…)` error strings and the `<target> is one of:` usage/header lines, so they
 * derive from the descriptors and cannot drift.
 *
 * @param {object[]} descriptors
 * @param {object} opts
 * @param {string}  opts.template  the literal line(s), with `{{list}}` where the
 *   comma-joined canonical target list belongs. May contain `\n` for multi-line.
 * @returns {string}
 */
function renderTargetListLines(descriptors, { template }) {
    return template.split('{{list}}').join(renderTargetList(descriptors));
}

/**
 * Render the full text (BEGIN … body … END inclusive) for one region. Dispatches
 * on `region.kind`: 'statusVarCase' (default, the target→status_var case blocks)
 * or 'targetList' (BL159, a templated target-enumeration line).
 * @returns {string}
 */
export function renderRegion(region, descriptors) {
    let body;
    if (region.kind === 'targetList') {
        body = renderTargetListLines(descriptors, region.opts);
    } else if (region.kind === 'dispatch') {
        body = renderDispatchCase(descriptors, region.opts);
    } else {
        body = renderStatusVarCase(descriptors, region.opts);
    }
    return [region.begin, body, region.end].join('\n');
}

/**
 * Legacy export retained for callers/tests that render only the guard block.
 * @returns {string} the guard region text (BEGIN … END inclusive).
 */
export function renderGuardCaseBlock(descriptors) {
    return renderRegion(REGIONS[0], descriptors);
}

/**
 * Rewrite one region in its file. Returns true if the file changed.
 */
function rewriteRegion(region, descriptors) {
    const block = renderRegion(region, descriptors);
    let src = fs.readFileSync(region.file, 'utf8');
    if (src.indexOf(region.begin) === -1 && region.legacyStart && src.includes(region.legacyStart)) {
        const legacyIdx = src.indexOf(region.legacyStart);
        const legacyEnd = src.indexOf('\nesac', legacyIdx) + '\nesac'.length;
        src = `${src.slice(0, legacyIdx) + region.begin  }\n${  region.end  }${src.slice(legacyEnd)}`;
        console.log(`codegen-target-guard: migrated hand-written block to "${region.name}"`);
    }
    const beginIdx = src.indexOf(region.begin);
    const endIdx = src.indexOf(region.end);
    if (beginIdx === -1 || endIdx === -1) {
        console.error(`codegen-target-guard: marker comments not found for "${region.name}" in ${path.relative(ROOT, region.file)}`);
        process.exit(1);
    }
    const before = src.slice(0, beginIdx);
    const after = src.slice(endIdx + region.end.length);
    const next = before + block + after;
    if (next !== src) {
        fs.writeFileSync(region.file, next);
        return true;
    }
    return false;
}

function main() {
    const descriptors = allDescriptors();
    let changed = false;
    for (const region of REGIONS) {
        if (rewriteRegion(region, descriptors)) {
            console.log(`codegen-target-guard: regenerated ${region.name}`);
            changed = true;
        }
    }
    if (!changed) {
        console.log('codegen-target-guard: no change');
    }
}

// Run only when invoked directly (not when imported by the descriptor-conformance test).
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
