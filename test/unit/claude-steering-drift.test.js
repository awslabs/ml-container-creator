// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Claude Code steering drift test.
 *
 * Steering (CLAUDE.md + .claude/rules/*.md) is loaded into the AI maintainer's
 * context, so a stale fact there is a bug that gets copied into new code. The old
 * Kiro steering rotted exactly this way (wrong server counts, removed modules,
 * broken paths). This test keeps the Claude steering honest:
 *
 *   1. Every repo path cited in backticks exists (paths under .kiro/ are skipped —
 *      that archive is gitignored and absent in CI).
 *   2. Every `paths:` glob in a rule's frontmatter matches at least one file, so a
 *      path-scoped rule can never silently stop loading after a rename.
 *   3. No bare inventory counts ("13 servers", "~72 files") — steering points at
 *      sources of truth instead of restating them.
 *   4. CLAUDE.md stays under the recommended 200-line budget.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'tinyglobby';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RULES_DIR = join(ROOT, '.claude', 'rules');

// Judge paths against what git tracks, not the local disk: a file that exists only
// in one checkout (or only on CI) must not decide the result. A cited path counts
// if it is tracked (file, or directory prefix of tracked files) or is deliberately
// git-ignored (a runtime artifact such as config/mcp.json that `mcc mcp` writes).
const TRACKED = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const isTracked = (p) => {
    const q = p.replace(/\/$/, '');
    return TRACKED.some((f) => f === q || f.startsWith(`${q}/`));
};
const isIgnored = (p) => {
    try {
        execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

function steeringFiles() {
    const rules = readdirSync(RULES_DIR, { recursive: true })
        .filter((f) => f.endsWith('.md'))
        .map((f) => join('.claude', 'rules', f));
    return ['CLAUDE.md', ...rules];
}

/** Split YAML-ish frontmatter `paths:` list from the body. */
function parse(relPath) {
    const text = readFileSync(join(ROOT, relPath), 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    const globs = [];
    if (m) {
        for (const line of m[1].split('\n')) {
            const g = line.match(/^\s*-\s*"([^"]+)"\s*$/);
            if (g) globs.push(g[1]);
        }
    }
    // Strip HTML comments (maintainer notes, not shown to the model).
    const body = (m ? text.slice(m[0].length) : text).replace(/<!--[\s\S]*?-->/g, '');
    return { globs, body };
}

/** Backticked tokens that look like concrete repo paths. */
function citedPaths(body) {
    const out = new Set();
    for (const [, span] of body.matchAll(/`([^`\n]+)`/g)) {
        for (let tok of span.split(/\s+/)) {
            tok = tok.replace(/[),.;:]+$/, '').replace(/:\d+(-\d+)?$/, '');
            if (!tok.includes('/') || /[<>*{}$~|]/.test(tok) || tok.startsWith('.kiro/')) continue;
            if (/^[a-z]+:\/\//i.test(tok)) continue;
            const first = tok.split('/')[0];
            if (!first || !existsSync(join(ROOT, first))) continue; // not a repo-rooted path
            out.add(tok);
        }
    }
    return [...out];
}

const COUNT_RE = /(?:~|\b)\d+\s+(?:bundled\s+)?(?:MCP\s+)?(?:servers|modules|files|specs|stacks|engines|targets|scripts|validators|catalogs)\b/i;

describe('Claude steering drift', () => {
    const files = steeringFiles();

    it('finds the steering set', () => {
        assert.ok(files.length > 1, 'expected CLAUDE.md plus .claude/rules/*.md');
    });

    for (const f of files) {
        const { globs, body } = parse(f);

        it(`${f}: every cited repo path exists`, () => {
            const missing = citedPaths(body).filter((p) => !isTracked(p) && !isIgnored(p));
            assert.deepStrictEqual(missing, [], `stale paths in ${f}`);
        });

        if (globs.length) {
            it(`${f}: every paths: glob matches a file`, () => {
                const dead = globs.filter((g) => globSync(g, {
                    cwd: ROOT, dot: true, ignore: ['**/node_modules/**', '**/cdk.out/**']
                }).length === 0);
                assert.deepStrictEqual(dead, [], `globs that match nothing in ${f}`);
            });
        }

        it(`${f}: no bare inventory counts`, () => {
            const hit = body.split('\n').find((l) => COUNT_RE.test(l));
            assert.strictEqual(hit, undefined, `point at the source instead of counting: "${hit}"`);
        });
    }

    it('CLAUDE.md stays under 200 lines', () => {
        const lines = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').split('\n').length;
        assert.ok(lines < 200, `CLAUDE.md is ${lines} lines`);
    });
});
