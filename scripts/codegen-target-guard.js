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
    }
];

/**
 * Render the full text (BEGIN … case … END inclusive) for one region.
 * @returns {string}
 */
export function renderRegion(region, descriptors) {
    return [region.begin, renderStatusVarCase(descriptors, region.opts), region.end].join('\n');
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
    const src = fs.readFileSync(region.file, 'utf8');
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

// Run only when invoked directly (not when imported by the parity check).
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
