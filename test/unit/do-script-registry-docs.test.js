// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * docs/do-script-contract.md "Current script registry" table vs the shipped
 * scripts' @mlcc-script headers (ADR-007; derive-don't-hardcode rule 4).
 *
 * The headers in templates/do/<script> are the source of truth (validated by
 * do-contract-conformance.test.js). The docs table is a readable copy; this test
 * fails when a script is added, removed or re-classified without updating it.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DO_DIR = path.join(ROOT, 'templates', 'do');

/** Parse every top-level do/ script that carries an @mlcc-script header. */
function scriptHeaders() {
    const out = {};
    for (const entry of fs.readdirSync(DO_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const text = fs.readFileSync(path.join(DO_DIR, entry.name), 'utf8');
        if (!text.includes('@mlcc-script')) continue;
        const field = name => (text.match(new RegExp(`^# ${name}:\\s*(.+)$`, 'm')) || [])[1]?.trim();
        out[entry.name] = {
            type: field('type'),
            guard: field('guard'),
            lifecycle: field('lifecycle'),
            targets: field('targets')
        };
    }
    return out;
}

/** Parse the registry table rows in docs/do-script-contract.md. */
function docRows() {
    const text = fs.readFileSync(path.join(ROOT, 'docs', 'do-script-contract.md'), 'utf8');
    const start = text.indexOf('## Current script registry');
    assert.ok(start >= 0, 'missing "## Current script registry" section');
    const rows = {};
    for (const m of text.slice(start).matchAll(/^\| `do\/([a-z-]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)) {
        rows[m[1]] = {
            type: m[2].trim(),
            // The guard cell may carry a short explanation after the value.
            guard: m[3].trim().split(/\s/)[0],
            lifecycle: m[4].trim(),
            targets: m[5].trim()
        };
    }
    return rows;
}

describe('do-script-contract.md registry table', () => {
    const headers = scriptHeaders();
    const rows = docRows();

    it('lists exactly the scripts that ship an @mlcc-script header', () => {
        assert.deepStrictEqual(Object.keys(rows).sort(), Object.keys(headers).sort());
    });

    it('matches each script header (type, guard, lifecycle, targets)', () => {
        for (const [name, header] of Object.entries(headers)) {
            assert.deepStrictEqual(rows[name], header, `do/${name} row drifts from its header`);
        }
    });
});
