// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 9 (R11.2, R11.3, IAM): CDK assertion tests for the benchmark Glue table and
 * the CI CodeBuild role. Runs infra/bootstrap-modules/test/benchmark-w9.assertions.ts
 * through ts-node (offline synth) and checks:
 *   - the SYNTHESIZED BenchmarkResultsTable columns equal the writer's
 *     PARQUET_COLUMNS (names + types, order-independent) — the template-level twin
 *     of the source-level drift test test/unit/test_benchmark_schema_drift.py;
 *   - the table keeps its logical ID and create-only properties (in-place Modify);
 *   - the CI CodeBuild role carries pricing:GetProducts + the Glue partition actions.
 */
import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBootstrapModulesDeps } from '../helpers/bootstrap-modules-deps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const MODULES_ROOT = resolve(REPO, 'infra/bootstrap-modules');

/** Parse PARQUET_COLUMNS out of the writer source (no Python needed). */
function writerColumns() {
    const src = readFileSync(resolve(REPO, 'templates/do/.benchmark_writer.py'), 'utf8');
    const start = src.indexOf('PARQUET_COLUMNS = [');
    const end = src.indexOf('\n]\n', start);
    assert.ok(start >= 0 && end > start, 'PARQUET_COLUMNS block not found in the writer');
    const block = src.slice(start, end);
    const out = {};
    for (const m of block.matchAll(/\('([a-z0-9_]+)',\s*'(string|double|int|boolean)'\)/g)) {
        out[m[1]] = m[2];
    }
    return out;
}

describe('bootstrap benchmark + ci stacks — Wave 9 CDK assertions', function () {
    this.timeout(180000);
    const tsNodeRegister = resolve(MODULES_ROOT, 'node_modules/ts-node/register/index.js');
    let result;
    before(function () {
        requireBootstrapModulesDeps(this); // skip locally without deps; fail in CI (BL238)
        const out = execFileSync(process.execPath, ['-r', tsNodeRegister, 'test/benchmark-w9.assertions.ts'], {
            cwd: MODULES_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' }
        });
        const line = out.trim().split('\n').reverse().find(l => l.startsWith('{"ok"'));
        assert.ok(line, `assertion script printed no summary:\n${out}`);
        result = JSON.parse(line);
    });

    it('stack-level assertions pass (create-only props unchanged, CI IAM present)', () => {
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.tableLogicalId, 'BenchmarkResultsTable');
    });

    it('synthesized Glue columns == writer PARQUET_COLUMNS (names + types)', () => {
        const glue = {};
        for (const c of result.columns) glue[c.name] = c.type;
        assert.deepStrictEqual(glue, writerColumns());
    });
});
