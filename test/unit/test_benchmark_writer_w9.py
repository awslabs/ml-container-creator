# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 9 writer behavior (9B): BL128 aggregates (R10), cost columns (R8.3),
Bedrock columns (R9.4), partition reconcile (R11.4), dry-run output.

All AWS clients are stubs and prices are synthetic. The AIPerf fixture is a
trimmed real 0.13.0 export (metric objects only).
"""
import copy
import json
import os
import subprocess
import sys
import importlib.util

import pytest

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_WRITER = os.path.join(_REPO, 'templates', 'do', '.benchmark_writer.py')
_FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'aiperf', 'profile_export_aiperf_0_13.json')

_spec = importlib.util.spec_from_file_location('benchmark_writer_w9', _WRITER)
bw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bw)

AIPERF_COLS = [n for n, _k in bw.PARQUET_COLUMNS
               if n.startswith(('effective_', 'active_', 'tokens_in_flight_'))]


def _fixture():
    with open(_FIXTURE) as f:
        return json.load(f)


# ── BL128 extraction (R10.1 / R10.2 / R10.3) ──────────────────────────────────

class TestAiperfAggregates:
    def test_all_sixteen_columns_and_version_from_a_real_export(self):
        cols = bw.aiperf_aggregate_columns(_fixture())
        assert len(AIPERF_COLS) == 16
        for name in AIPERF_COLS:
            assert isinstance(cols[name], float), name
        assert cols['aiperf_version'] == _fixture()['aiperf_version']

    def test_values_are_avg_and_p90_of_the_source_key(self):
        data = _fixture()
        cols = bw.aiperf_aggregate_columns(data)
        assert cols['effective_concurrency_avg'] == data['effective_concurrency']['avg']
        assert cols['tokens_in_flight_p90'] == data['tokens_in_flight']['p90']
        assert cols['effective_latency_p90_ms'] == data['effective_latency']['p90']  # unit ms

    def test_missing_key_is_null(self):
        data = _fixture()
        del data['active_prefill_throughput']
        cols = bw.aiperf_aggregate_columns(data)
        assert cols['active_prefill_tps_avg'] is None and cols['active_prefill_tps_p90'] is None
        assert cols['active_decode_tps_avg'] is not None

    def test_latency_in_seconds_is_converted_to_ms(self):
        data = _fixture()
        data['effective_latency'] = {'unit': 'sec', 'avg': 1.5, 'p90': 2.0}
        cols = bw.aiperf_aggregate_columns(data)
        assert cols['effective_latency_avg_ms'] == pytest.approx(1500.0)

    def test_unknown_unit_is_null_not_guessed(self):
        data = _fixture()
        data['effective_total_throughput'] = {'unit': 'furlongs', 'avg': 1.0, 'p90': 2.0}
        cols = bw.aiperf_aggregate_columns(data)
        assert cols['effective_total_tps_avg'] is None

    def test_empty_or_garbage_input_is_all_null(self):
        for data in ({}, None, [], 'x'):
            cols = bw.aiperf_aggregate_columns(data)
            assert all(cols[n] is None for n in AIPERF_COLS) and cols['aiperf_version'] is None

    def test_single_level_reads_the_sibling_export(self, tmp_path):
        (tmp_path / 'profile_export_aiperf.json').write_text(json.dumps(_fixture()))
        jsonl = tmp_path / 'profile_export.jsonl'
        jsonl.write_text('')
        found = bw.find_aiperf_aggregates(str(jsonl), None, [2])
        assert set(found) == {'*'} and found['*']['aiperf_version']

    def test_sweep_reads_one_file_per_level(self, tmp_path):
        a, b = _fixture(), _fixture()
        b['effective_concurrency'] = dict(b['effective_concurrency'], avg=7.5)
        (tmp_path / 'results-concurrency-2.json').write_text(json.dumps(a))
        (tmp_path / 'results-concurrency-8.json').write_text(json.dumps(b))
        found = bw.find_aiperf_aggregates(str(tmp_path / 'results.json'), None, [2, 4, 8])
        assert set(found) == {2, 8}
        assert found[8]['effective_concurrency_avg'] == 7.5

    def test_missing_file_is_empty(self, tmp_path):
        assert bw.find_aiperf_aggregates(str(tmp_path / 'profile_export.jsonl'), None, [1]) == {}


# ── enrich_records: cost + Bedrock + aggregates per level ─────────────────────

CONFIG = {'project_name': 'p', 'model_name': 'org/model-a', 'instance_type': 'ml.g5.xlarge',
          'deployment_config': 'transformers-vllm', 'region': 'us-west-2',
          'deployment_target': 'realtime-inference'}


def _metric(conc, out_tps, isl=200.0, osl=100.0):
    return {'concurrency': conc, 'output_token_throughput': out_tps, 'request_throughput': 1.0,
            'total_requests': 10, 'input_sequence_length': isl, 'output_sequence_length': osl}


def _ctx(usd=3.6, count=2):
    return {
        'price': {'usd_per_hour': usd, 'source': 'pricing-api', 'as_of': '2026-10-26T00:00:00Z',
                  'component': 'Hosting', 'reason': None if usd else 'not-found'},
        'instance_count': count, 'instance_count_reason': None if count else 'no endpoint',
        'bedrock_catalog': {'org/model-a': {'bedrockModelId': 'v.model-a', 'priceListModel': 'A',
                                            'verifiedRegions': ['us-west-2']}},
        'bedrock_price_resolver': lambda m, r: {'input_usd_per_1m': 0.1, 'output_usd_per_1m': 0.4,
                                                'source': 'pricing-api', 'as_of': '2026-10-26T00:00:00Z'},
    }


class TestEnrichCost:
    def test_cost_formula_and_persisted_inputs(self):
        recs = bw.enrich_records(CONFIG, {'metrics': [_metric(2, 100.0)]}, instance_catalog={},
                                 cost_context=_ctx(3.6, 2))
        r = recs[0]
        assert r['cost_per_1m_tokens'] == pytest.approx(3.6 * 2 * 1e6 / (3600 * 100.0), abs=1e-4)
        assert (r['price_usd_per_hour'], r['price_source'], r['price_component'], r['instance_count']) == \
            (3.6, 'pricing-api', 'Hosting', 2)
        assert r['price_as_of'].startswith('2026-10-26')

    def test_each_level_uses_its_own_throughput(self):
        recs = bw.enrich_records(CONFIG, {'metrics': [_metric(1, 50.0), _metric(8, 400.0)]},
                                 instance_catalog={}, cost_context=_ctx())
        assert recs[0]['cost_per_1m_tokens'] > recs[1]['cost_per_1m_tokens']

    def test_no_context_means_null_cost_and_price_columns(self):
        r = bw.enrich_records(CONFIG, {'metrics': [_metric(2, 100.0)]}, instance_catalog={})[0]
        for col in ('cost_per_1m_tokens', 'price_usd_per_hour', 'price_source', 'instance_count',
                    'bedrock_model_id', 'bedrock_cost_per_1m_tokens'):
            assert r[col] is None, col

    @pytest.mark.parametrize('usd,count,needle', [(None, 1, 'no price'), (1.0, None, 'no instance count')])
    def test_missing_price_or_count_is_null_with_reason(self, usd, count, needle):
        r = bw.enrich_records(CONFIG, {'metrics': [_metric(2, 100.0)]}, instance_catalog={},
                              cost_context=_ctx(usd, count))[0]
        assert r['cost_per_1m_tokens'] is None and needle in r['_cost_reason']

    def test_bedrock_columns_at_measured_ratio(self):
        r = bw.enrich_records(CONFIG, {'metrics': [_metric(2, 100.0, isl=300.0, osl=100.0)]},
                              instance_catalog={}, cost_context=_ctx())[0]
        assert r['bedrock_model_id'] == 'v.model-a'
        assert r['bedrock_cost_per_1m_tokens'] == pytest.approx(0.4 + 0.1 * 3.0)

    def test_adapter_run_gets_no_bedrock_equivalent(self):
        cfg = dict(CONFIG, adapter_name='sft-1')
        r = bw.enrich_records(cfg, {'metrics': [_metric(2, 100.0)]}, instance_catalog={},
                              cost_context=_ctx())[0]
        assert r['bedrock_cost_per_1m_tokens'] is None and r['_bedrock']['reason'] == 'adapter run'

    def test_aggregates_matched_by_concurrency(self):
        cols2 = bw.aiperf_aggregate_columns(_fixture())
        cols8 = dict(cols2, effective_concurrency_avg=7.5)
        recs = bw.enrich_records(CONFIG, {'metrics': [_metric(2, 1.0), _metric(8, 1.0), _metric(4, 1.0)]},
                                 instance_catalog={}, aiperf_aggregates={2: cols2, 8: cols8})
        assert recs[0]['effective_concurrency_avg'] == cols2['effective_concurrency_avg']
        assert recs[1]['effective_concurrency_avg'] == 7.5
        assert recs[2]['effective_concurrency_avg'] is None  # no file for level 4 -> NULL

    def test_spec_decode_acceptance_rate_is_persisted(self):
        r = bw.enrich_records(CONFIG, {'metrics': [_metric(2, 1.0)]}, instance_catalog={},
                              gpu_metrics={'spec_decode_acceptance_rate': 0.62})[0]
        assert r['spec_decode_acceptance_rate'] == 0.62

    def test_every_record_key_is_a_column_or_private(self):
        r = bw.enrich_records(CONFIG, {'metrics': [_metric(2, 1.0)]}, instance_catalog={},
                              cost_context=_ctx())[0]
        cols = {n for n, _k in bw.PARQUET_COLUMNS}
        assert {k for k in r if not k.startswith('_')} <= cols
        assert cols <= set(r)  # every column is populated (value or None)


# ── Partition reconcile (R11.4) ───────────────────────────────────────────────

class StubGlue:
    def __init__(self, table_cols, partition_cols):
        self.table_cols, self.partition_cols = table_cols, partition_cols
        self.updated = []

    def get_table(self, **_kw):
        return {'Table': {'StorageDescriptor': {'Columns': self.table_cols, 'Location': 's3://b/results/'}}}

    def batch_create_partition(self, **_kw):
        return {'Errors': [{'ErrorDetail': {'ErrorCode': 'AlreadyExistsException'}}]}

    def get_partition(self, **_kw):
        return {'Partition': {'Values': ['m', 'i', 't'], 'DatabaseName': 'db', 'TableName': 'tb',
                              'CreationTime': 'x', 'Parameters': {'classification': 'parquet'},
                              'StorageDescriptor': {'Columns': self.partition_cols, 'Location': 's3://b/p/'}}}

    def update_partition(self, **kw):
        self.updated.append(kw)


OLD = [{'Name': 'a', 'Type': 'string'}]
NEW = [{'Name': 'a', 'Type': 'string'}, {'Name': 'price_source', 'Type': 'string'}]


class TestPartitionReconcile:
    def test_existing_partition_with_old_columns_is_updated(self):
        glue = StubGlue(NEW, OLD)
        res = bw.register_partition('b', 'm', 'i', 't', glue_client=glue)
        assert res['already_exists'] and res['reconciled'] and res['error'] is None
        (call,) = glue.updated
        assert call['PartitionValueList'] == ['m', 'i', 't']
        assert call['PartitionInput']['StorageDescriptor']['Columns'] == NEW
        assert call['PartitionInput']['StorageDescriptor']['Location'] == 's3://b/p/'  # location kept
        assert set(call['PartitionInput']) <= {'Values', 'StorageDescriptor', 'Parameters'}

    def test_matching_partition_is_left_alone(self):
        glue = StubGlue(NEW, copy.deepcopy(NEW))
        res = bw.register_partition('b', 'm', 'i', 't', glue_client=glue)
        assert res['already_exists'] and not res['reconciled'] and glue.updated == []

    def test_update_failure_is_non_fatal(self):
        glue = StubGlue(NEW, OLD)

        def boom(**_kw):
            raise RuntimeError('AccessDenied glue:UpdatePartition')
        glue.update_partition = boom
        res = bw.register_partition('b', 'm', 'i', 't', glue_client=glue)
        assert res['already_exists'] and not res['reconciled'] and 'UpdatePartition' in res['error']


# ── CLI dry-run: no live pricing call, new columns + summary in the output ────

def test_dry_run_outputs_wave9_columns_and_cost_summary(tmp_path):
    results = tmp_path / 'results.json'
    results.write_text(json.dumps({'metrics': [_metric(2, 100.0), _metric(4, 180.0)]}))
    (tmp_path / 'results-concurrency-2.json').write_text(json.dumps(_fixture()))
    cfg = tmp_path / 'config'
    cfg.write_text('\n'.join(f'export {k}="{v}"' for k, v in {
        'PROJECT_NAME': 'p', 'MODEL_NAME': 'org/model-a', 'INSTANCE_TYPE': 'ml.g5.xlarge',
        'DEPLOYMENT_CONFIG': 'transformers-vllm', 'DEPLOYMENT_TARGET': 'realtime-inference',
        'AWS_REGION': 'us-west-2'}.items()))
    env = dict(os.environ, AWS_EC2_METADATA_DISABLED='true')
    out = subprocess.run([sys.executable, _WRITER, 'write', '--results-file', str(results),
                          '--config-file', str(cfg), '--dry-run'],
                         capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0, out.stdout + out.stderr
    doc = json.loads(out.stdout)
    recs = doc['records']
    assert all(not k.startswith('_') for r in recs for k in r)
    assert recs[0]['aiperf_version'] and recs[1]['aiperf_version'] is None
    for col in ('price_source', 'instance_count', 'bedrock_cost_per_1m_tokens'):
        assert col in recs[0]
    summary = doc['cost_summary']
    assert any('@ concurrency 2 (measured)' in line for line in summary)
    assert any('peak sustained' in line and '@ concurrency 4' in line for line in summary)
    assert summary[-1].startswith('Assumes sustained utilization')
