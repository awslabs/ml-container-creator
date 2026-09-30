// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * codegen-deploy-flags.js — regenerates the mechanical per-target deploy-flag
 * bash in templates/do/deploy FROM the per-target answer_params descriptors
 * (templates/do/targets.d/(all)/manifest.json), so the flag plumbing has a single
 * source of truth (ADR-008 / .kiro/steering/derive-dont-hardcode.md).
 *
 * Three regions are generated, each delimited by marker comments so the
 * surrounding hand-authored logic is untouched:
 *   1. arg-parse case arms   — one `--flag) ... FLAG_X="$1" ...` arm per flag.
 *   2. helper forwarding      — the `${FLAG_X:+--flag "$FLAG_X"}` lines passed to
 *                               .deploy_helper.py prompt.
 *   3. builder forwarding     — the identical lines passed to deploy-config-builder.js.
 *
 * The flag set + order come from deploy-answers-reader.flagParams() (the union of
 * every target's flag-input answer_params, excluding the core --target/--instance-type
 * which do/deploy handles explicitly). Run via `npm run codegen`; the conformance
 * test (deploy-flag-forwarding.test.js) fails if a checked-in region drifts from
 * what this would produce. Re-running is a no-op (idempotent).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { flagParams } from '../src/lib/deploy-answers-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEPLOY = path.join(ROOT, 'templates', 'do', 'deploy');

// ── Renderers (one per region) ────────────────────────────────────────────────

/**
 * arg-parse case arms. Each flag gets a `--flag)` arm that shifts, checks for a
 * value, assigns FLAG_X, and shifts again. Indented to match the surrounding
 * `case "$1" in` (8 spaces for the arm label, inside the while/case).
 */
function renderArgParse(params) {
    const lines = [];
    for (const { flag, shellVar } of params) {
        lines.push(`        ${flag})`);
        lines.push('            shift');
        lines.push(`            if [ $# -eq 0 ]; then echo "❌ ${flag} requires a value"; exit 1; fi`);
        lines.push(`            ${shellVar}="$1"`);
        lines.push('            shift');
        lines.push('            ;;');
    }
    return lines.join('\n');
}

/**
 * The `_DEPLOY_FLAG_ARGS` bash array build. Each caller-supplied per-target flag
 * appends `--flag "$FLAG_X"` to the array (via ${FLAG_X:+...}) so a single
 * `"${_DEPLOY_FLAG_ARGS[@]}"` expansion forwards exactly the provided flags to
 * BOTH the Python helper and the Node builder. Building an array (rather than
 * inlining `${FLAG_X:+...}` mid-command) keeps the generated region a sequence of
 * ordinary statements, so the marker comments are valid bash — a bare comment
 * cannot sit between backslash-continued command lines.
 */
function renderFlagArgsArray(params) {
    const lines = ['    _DEPLOY_FLAG_ARGS=()'];
    for (const { flag, shellVar } of params) {
        lines.push(`    ${shellVar}="\${${shellVar}:-}"; [ -n "$${shellVar}" ] && _DEPLOY_FLAG_ARGS+=("${flag}" "$${shellVar}")`);
    }
    return lines.join('\n');
}

// ── Region table (exported for the conformance test) ───────────────────────────

export const REGIONS = [
    {
        name: 'arg-parse flag arms',
        file: DEPLOY,
        begin: '        # >>> GENERATED: deploy-flag arg-parse (scripts/codegen-deploy-flags.js; ADR-008) — DO NOT EDIT',
        end: '        # <<< END GENERATED deploy-flag arg-parse',
        render: (params) => renderArgParse(params)
    },
    {
        name: 'flag-args array',
        file: DEPLOY,
        begin: '    # >>> GENERATED: deploy-flag args-array (scripts/codegen-deploy-flags.js; ADR-008) — DO NOT EDIT',
        end: '    # <<< END GENERATED deploy-flag args-array',
        render: (params) => renderFlagArgsArray(params)
    }
];

/**
 * Render one region's full text (BEGIN … body … END inclusive).
 * @returns {string}
 */
export function renderRegion(region, params) {
    return [region.begin, region.render(params), region.end].join('\n');
}

/** Rewrite one region in its file. Returns true if the file changed. */
function rewriteRegion(region, params) {
    const block = renderRegion(region, params);
    const src = fs.readFileSync(region.file, 'utf8');
    const beginIdx = src.indexOf(region.begin);
    const endIdx = src.indexOf(region.end);
    if (beginIdx === -1 || endIdx === -1) {
        console.error(`codegen-deploy-flags: marker comments not found for "${region.name}" in ${path.relative(ROOT, region.file)}`);
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
    const params = flagParams();
    let changed = false;
    for (const region of REGIONS) {
        if (rewriteRegion(region, params)) {
            console.log(`codegen-deploy-flags: regenerated ${region.name}`);
            changed = true;
        }
    }
    if (!changed) {
        console.log('codegen-deploy-flags: no change');
    }
}

// Run only when invoked directly (not when imported by the conformance test).
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
