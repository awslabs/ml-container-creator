# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 9 R11.3 drift test: writer column list == Glue stack == Athena DDL.

The writer declares its columns once (PARQUET_COLUMNS, pyarrow-free); the
CloudFormation-owned Glue table (infra/bootstrap-modules/benchmark/stack.ts
BenchmarkResultsTable) and docs/athena-benchmark-ddl.sql must carry exactly the
same names and types (order-independent). The deployed table missing a column
the writer emits is how `run_name` went NULL for every row (investigation §3.3).
No pyarrow needed; the pyarrow cross-check below skips when it is absent.
"""
import importlib.util
import os
import re

import pytest

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_WRITER = os.path.join(_REPO, 'templates', 'do', '.benchmark_writer.py')
_STACK = os.path.join(_REPO, 'infra', 'bootstrap-modules', 'benchmark', 'stack.ts')
# Legacy CI harness (BL219): creates the same mlcc_ci.benchmark_results table
# when CreateBenchmarkInfra=true and its CodeBuild role runs the same writer.
_CI_HARNESS_STACK = os.path.join(_REPO, 'infra', 'ci-harness', 'lib', 'ci-harness-stack.ts')
_DDL = os.path.join(_REPO, 'docs', 'athena-benchmark-ddl.sql')

_spec = importlib.util.spec_from_file_location('benchmark_writer_drift', _WRITER)
_writer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_writer)

# Writer kind -> Glue type -> DDL type
_KIND_TO_GLUE = {'string': 'string', 'double': 'double', 'int': 'int', 'boolean': 'boolean'}
PARTITION_KEYS = {'model', 'instance', 'target'}


def _writer_columns():
    names = [n for n, _k in _writer.PARQUET_COLUMNS]
    assert len(names) == len(set(names)), 'duplicate column in PARQUET_COLUMNS'
    return {n: _KIND_TO_GLUE[k] for n, k in _writer.PARQUET_COLUMNS}


def _stack_columns(path=_STACK):
    src = open(path, encoding='utf-8').read()
    start = src.index('columns: [', src.index("'BenchmarkResultsTable'"))
    end = src.index('partitionKeys:', start)
    pairs = re.findall(r"\{\s*name:\s*'([a-z0-9_]+)',\s*type:\s*'([a-z]+)'", src[start:end])
    names = [n for n, _t in pairs]
    assert len(names) == len(set(names)), 'duplicate column in stack.ts'
    return dict(pairs)


def _stack_partition_keys(path):
    src = open(path, encoding='utf-8').read()
    start = src.index('partitionKeys: [', src.index("'BenchmarkResultsTable'"))
    end = src.index(']', start)
    return re.findall(r"name:\s*'([a-z0-9_]+)'", src[start:end])


def _ddl_columns():
    src = open(_DDL, encoding='utf-8').read()
    start = src.index('CREATE EXTERNAL TABLE')
    end = src.index('PARTITIONED BY', start)
    pairs = re.findall(r'^\s+([a-z0-9_]+)\s+(STRING|DOUBLE|INT|BOOLEAN)\b', src[start:end], re.MULTILINE)
    names = [n for n, _t in pairs]
    assert len(names) == len(set(names)), 'duplicate column in the DDL'
    return {n: t.lower() for n, t in pairs}


def test_writer_equals_stack():
    assert _stack_columns() == _writer_columns()


def test_writer_equals_ci_harness_stack():
    assert _stack_columns(_CI_HARNESS_STACK) == _writer_columns()


def test_stacks_partition_by_the_writer_path_scheme():
    # The writer's S3 key is results/model=.../instance=.../target=... .
    src = open(_WRITER, encoding='utf-8').read()
    scheme = re.search(r"results/((?:[a-z_]+=\{[^}]+\}/)+)", src).group(1)
    path_keys = re.findall(r'([a-z_]+)=\{', scheme)
    assert set(path_keys) == PARTITION_KEYS
    for path in (_STACK, _CI_HARNESS_STACK):
        assert _stack_partition_keys(path) == path_keys, path


def test_writer_equals_ddl():
    assert _ddl_columns() == _writer_columns()


def test_partition_keys_are_not_data_columns():
    assert not PARTITION_KEYS & set(_writer_columns())


def test_wave9_columns_present():
    cols = _writer_columns()
    for name in ('run_name', 'aiperf_version', 'spec_decode_acceptance_rate', 'price_usd_per_hour',
                 'price_source', 'price_as_of', 'price_component', 'instance_count',
                 'bedrock_model_id', 'bedrock_cost_per_1m_tokens'):
        assert name in cols, name
    bl128 = [n for n in cols if n.startswith(('effective_', 'active_', 'tokens_in_flight_'))]
    assert len(bl128) == 16


def test_cost_comments_no_longer_say_estimated():
    for path in (_STACK, _CI_HARNESS_STACK, _DDL):
        text = open(path, encoding='utf-8').read()
        line = next(ln for ln in text.splitlines()
                    if 'cost_per_1m_tokens' in ln and 'comment' in ln.lower())
        assert 'Estimated' not in line, path


def test_parquet_schema_is_built_from_the_list():
    pa = pytest.importorskip('pyarrow', reason='pyarrow not installed (drift checks above still ran)')
    schema = _writer.get_parquet_schema()
    assert [f.name for f in schema] == [n for n, _k in _writer.PARQUET_COLUMNS]
    kind_of = {'string': pa.string(), 'double': pa.float64(), 'int': pa.int32(), 'boolean': pa.bool_()}
    for f, (_n, k) in zip(schema, _writer.PARQUET_COLUMNS):
        assert f.type == kind_of[k], f.name
