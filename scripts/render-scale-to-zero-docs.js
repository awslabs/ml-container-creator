// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * render-scale-to-zero-docs.js — regenerates the two descriptor-driven regions
 * of docs/scale-to-zero.md (Wave 10, ADR-014 R7.1):
 *
 *   1. the per-target capability matrix, from each targets.d/(target)/manifest.json
 *      "scale_to_zero" block (read through target-manifest-reader.js);
 *   2. the reference cold-start figures, from
 *      templates/do/lib/python/scale_to_zero_reference.json (the one data file the
 *      warning reads).
 *
 * The regions sit between marker comments so the prose around them stays hand
 * written. test/unit/scale-to-zero-docs.test.js fails when a checked-in region
 * differs from what this renders (run `node scripts/render-scale-to-zero-docs.js`).
 * Re-running is a no-op (idempotent).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { allDescriptors, scaleToZero } from '../src/lib/target-manifest-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const DOC = path.join(ROOT, 'docs', 'scale-to-zero.md');
export const REFERENCE = path.join(ROOT, 'templates', 'do', 'lib', 'python', 'scale_to_zero_reference.json');

const code = (v) => (v === null || v === undefined || v === '' ? '—' : `\`${v}\``);

/** Markdown table of every target's declared scale_to_zero capability. */
export function renderMatrix(descriptors = allDescriptors()) {
    const lines = [
        '| Target | Support | Mechanism | Wake signal | Requests at zero | Idle billing | v2 | Reason when refused |',
        '|---|---|---|---|---|---|---|---|'
    ];
    for (const d of descriptors) {
        const s = scaleToZero(d.target);
        lines.push(`| \`${d.target}\` | ${code(s.support)} | ${code(s.mechanism)} | ${code(s.wake_signal)} | `
            + `${code(s.requests_at_zero)} | ${code(s.idle_billing)} | ${s.enabled ? 'enabled' : 'refused'} | `
            + `${s.enabled ? '—' : s.reason} |`);
    }
    return lines.join('\n');
}

/** The reference recovery, with its provenance, as a short markdown list. */
export function renderReference(ref = JSON.parse(fs.readFileSync(REFERENCE, 'utf8'))) {
    const n = (v) => Number(v).toFixed(1);
    const runs = (ref.runs_minutes || []).map(n).join(' / ');
    return [
        `- Recovery from zero: **${n(ref.recovery_mean_minutes)} min mean**${
            runs ? ` over ${ref.runs_minutes.length} runs (${runs} min).` : '.'}`,
        `- Breakdown (min): ${ref.breakdown_minutes.map((p) => `${n(p.minutes)} ${p.phase}`).join(' · ')}.`,
        `- Measured on: ${ref.model}, ${ref.instance}, ${ref.engine}, ${ref.region}.`,
        `- Source: ${ref.source}, ${ref.date}.`
    ].join('\n');
}

export const REGIONS = [
    {
        name: 'matrix',
        begin: '<!-- >>> GENERATED: scale-to-zero matrix (scripts/render-scale-to-zero-docs.js) — DO NOT EDIT -->',
        end: '<!-- <<< END GENERATED scale-to-zero matrix -->',
        render: () => renderMatrix()
    },
    {
        name: 'reference',
        begin: '<!-- >>> GENERATED: scale-to-zero reference (scripts/render-scale-to-zero-docs.js) — DO NOT EDIT -->',
        end: '<!-- <<< END GENERATED scale-to-zero reference -->',
        render: () => renderReference()
    }
];

/** Full text of one region (begin marker, body, end marker). */
export function renderRegion(region) {
    return [region.begin, region.render(), region.end].join('\n');
}

function main() {
    let src = fs.readFileSync(DOC, 'utf8');
    const before = src;
    for (const region of REGIONS) {
        const b = src.indexOf(region.begin);
        const e = src.indexOf(region.end);
        if (b === -1 || e === -1) {
            console.error(`render-scale-to-zero-docs: markers for "${region.name}" not found in docs/scale-to-zero.md`);
            process.exit(1);
        }
        src = src.slice(0, b) + renderRegion(region) + src.slice(e + region.end.length);
    }
    if (src !== before) {
        fs.writeFileSync(DOC, src);
        console.log('render-scale-to-zero-docs: regenerated docs/scale-to-zero.md');
    } else {
        console.log('render-scale-to-zero-docs: no change');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
