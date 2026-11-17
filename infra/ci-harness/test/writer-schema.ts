// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Reads the benchmark_results schema from its source of truth, the writer
 * (templates/do/.benchmark_writer.py), so the Glue table tests derive their
 * expectations instead of pinning a column list that goes stale (BL219).
 *
 * - PARQUET_COLUMNS: the writer's ('name', 'kind') list. Kinds map 1:1 to Glue
 *   types (string | double | int | boolean).
 * - Partition keys: the writer's S3 key scheme, results/model=.../instance=.../target=...
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WRITER_PATH = join(__dirname, '..', '..', '..', 'templates', 'do', '.benchmark_writer.py');

function writerSource(): string {
    return readFileSync(WRITER_PATH, 'utf-8');
}

/** Writer columns as { Name, Type } in declaration order. */
export function writerColumns(): Array<{ Name: string; Type: string }> {
    const src = writerSource();
    const start = src.indexOf('\nPARQUET_COLUMNS = [');
    if (start < 0) throw new Error(`PARQUET_COLUMNS not found in ${WRITER_PATH}`);
    const end = src.indexOf('\n]', start);
    const body = src.slice(start, end);
    const cols = [...body.matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'(string|double|int|boolean)'\s*\)/g)]
        .map((m) => ({ Name: m[1], Type: m[2] }));
    if (cols.length === 0) throw new Error('PARQUET_COLUMNS parsed to an empty list');
    return cols;
}

/** Partition key names in S3-path order, from the writer's results/ key scheme. */
export function writerPartitionKeys(): string[] {
    const m = writerSource().match(/results\/((?:[a-z_]+=\{[^}]+\}\/)+)/);
    if (!m) throw new Error(`results/<key>=... S3 scheme not found in ${WRITER_PATH}`);
    return [...m[1].matchAll(/([a-z_]+)=\{/g)].map((k) => k[1]);
}
