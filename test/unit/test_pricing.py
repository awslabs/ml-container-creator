# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 9 price resolver (R7), cost math + labels (R8) and Bedrock comparison (R9).

Every Pricing / SageMaker / Bedrock client here is a stub: no network in the
default gate. Prices are synthetic (never a real SKU price) — tests assert the
behavior (exactly-one rule, unit normalization, cache TTL, fallback order,
descriptor-derived filters, formula, labels), not a frozen number. The one live
check at the bottom is opt-in (MLCC_LIVE_PRICING=1) and skips with a reason.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_LIB = os.path.join(_REPO, 'templates', 'do', 'lib', 'python')
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import pricing  # noqa: E402
import target_manifest  # noqa: E402

CATALOGS = os.path.join(_REPO, 'servers', 'lib', 'catalogs')
NOW = datetime(2026, 10, 26, 12, 0, 0, tzinfo=timezone.utc)


def _product(usd, unit='Hrs', reserved=None, attrs=None):
    """An API-shaped GetProducts PriceList item (as a JSON string, like boto3)."""
    terms = {'OnDemand': {'T1': {'priceDimensions': {'D1': {'unit': unit, 'pricePerUnit': {'USD': str(usd)}}}}}}
    if reserved is not None:
        terms['Reserved'] = {'R1': {'priceDimensions': {'D2': {'unit': unit, 'pricePerUnit': {'USD': str(reserved)}}}}}
    return json.dumps({'product': {'attributes': attrs or {}}, 'terms': terms})


class StubPricing:
    def __init__(self, price_lists=None, error=None, pages=None):
        self.price_lists = price_lists or []
        self.error = error
        self.pages = pages
        self.calls = []

    def get_products(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        if self.pages is not None:
            idx = int(kwargs.get('NextToken') or 0)
            page = self.pages[idx]
            resp = {'PriceList': page}
            if idx + 1 < len(self.pages):
                resp['NextToken'] = str(idx + 1)
            return resp
        return {'PriceList': list(self.price_lists)}


@pytest.fixture(autouse=True)
def _online(monkeypatch):
    monkeypatch.delenv(pricing.OFFLINE_ENV, raising=False)


# ── parse_single_price: the exactly-one rule ──────────────────────────────────

class TestParseSinglePrice:
    def test_exactly_one_price(self):
        assert pricing.parse_single_price([_product(2.5)], {'Hrs': 1.0}) == (2.5, 'Hrs')

    def test_zero_products_is_not_found(self):
        with pytest.raises(pricing.PriceMiss, match='not-found'):
            pricing.parse_single_price([], {'Hrs': 1.0})

    def test_two_distinct_prices_is_ambiguous_never_a_pick(self):
        with pytest.raises(pricing.PriceMiss, match='ambiguous'):
            pricing.parse_single_price([_product(1.0), _product(2.0)], {'Hrs': 1.0})

    def test_duplicate_identical_price_is_still_one(self):
        assert pricing.parse_single_price([_product(3.0), _product(3.0)], {'Hrs': 1.0})[0] == 3.0

    def test_reserved_terms_are_ignored(self):
        assert pricing.parse_single_price([_product(4.0, reserved=1.0)], {'Hrs': 1.0})[0] == 4.0

    def test_unsupported_unit_is_a_miss(self):
        with pytest.raises(pricing.PriceMiss, match='unsupported unit'):
            pricing.parse_single_price([_product(1.0, unit='Quantity')], {'Hrs': 1.0})

    def test_non_positive_is_a_miss(self):
        with pytest.raises(pricing.PriceMiss, match='non-positive'):
            pricing.parse_single_price([_product(0)], {'Hrs': 1.0})

    @pytest.mark.parametrize('unit,factor', [('1K tokens', 1000.0), ('1M tokens', 1.0)])
    def test_token_units_normalize_to_per_1m(self, unit, factor):
        got, _unit = pricing.parse_single_price([_product(0.002, unit=unit)], pricing._TOKEN_UNITS_PER_1M)
        assert got == pytest.approx(0.002 * factor)


# ── Descriptor-derived service / component ────────────────────────────────────

class TestDescriptorDerivation:
    def test_every_target_declares_a_pricing_block(self):
        for t in target_manifest.list_targets():
            spec = pricing.pricing_spec(t)
            assert spec['service'] in pricing._SERVICE_RULES
            assert spec.get('instance_count', {}).get('basis')

    def test_filters_follow_the_descriptor(self):
        for t in target_manifest.list_targets():
            spec = target_manifest.pricing(t)
            service, filters = pricing.build_instance_filters('ml.g5.xlarge', 'us-west-2', spec)
            fields = {f['Field']: f['Value'] for f in filters}
            assert service == spec['service']
            assert fields['regionCode'] == 'us-west-2'
            if service == 'AmazonSageMaker':
                assert fields['instanceName'] == 'ml.g5.xlarge'
                assert fields['component'] == spec['component']
            else:
                assert fields['instanceType'] == 'g5.xlarge'  # EC2 has no ml. prefix
                assert 'component' not in fields
                assert fields['operatingSystem'] == 'Linux' and fields['tenancy'] == 'Shared'

    def test_hyperpod_and_realtime_use_different_components(self):
        # The "Hosting rate on a HyperPod run" trap (investigation §4.3).
        assert target_manifest.pricing('hyperpod-eks')['component'] != \
            target_manifest.pricing('realtime-inference')['component']

    def test_unknown_target_is_a_miss_with_reason(self):
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'no-such-target',
                                           client=StubPricing([_product(1.0)]))
        assert r['usd_per_hour'] is None and 'no-such-target' in r['reason']


# ── Lookup chain: cache -> API -> snapshot -> NULL ────────────────────────────

class TestResolveChain:
    def _key(self, target='realtime-inference', inst='ml.g5.xlarge', region='us-west-2'):
        spec = target_manifest.pricing(target)
        return pricing.instance_cache_key(spec['service'], spec.get('component'), inst, region)

    def test_api_hit_writes_cache_atomically(self, tmp_path):
        cache = tmp_path / 'pricing-cache.json'
        stub = StubPricing([_product(1.25)])
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference',
                                           client=stub, cache_path=str(cache), now=NOW)
        assert r['usd_per_hour'] == 1.25 and r['source'] == pricing.SOURCE_API
        assert r['as_of'].startswith('2026-10-26')
        assert r['component'] == target_manifest.pricing('realtime-inference')['component']
        saved = json.loads(cache.read_text())
        assert saved[self._key()]['usd'] == 1.25 and saved[self._key()]['as_of']
        assert [p.name for p in tmp_path.iterdir()] == ['pricing-cache.json']  # no temp left behind

    def test_fresh_cache_skips_the_api(self, tmp_path):
        cache = tmp_path / 'c.json'
        cache.write_text(json.dumps({self._key(): {'usd': 2.0, 'unit': 'Hrs',
                                                   'as_of': (NOW - timedelta(hours=23)).isoformat()}}))
        stub = StubPricing(error=AssertionError('API must not be called'))
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference',
                                           client=stub, cache_path=str(cache), now=NOW)
        assert r['usd_per_hour'] == 2.0 and r['source'] == pricing.SOURCE_CACHE and not stub.calls

    def test_stale_cache_goes_back_to_the_api(self, tmp_path):
        cache = tmp_path / 'c.json'
        cache.write_text(json.dumps({self._key(): {'usd': 2.0, 'unit': 'Hrs',
                                                   'as_of': (NOW - timedelta(hours=25)).isoformat()}}))
        stub = StubPricing([_product(3.0)])
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference',
                                           client=stub, cache_path=str(cache), now=NOW)
        assert r['usd_per_hour'] == 3.0 and r['source'] == pricing.SOURCE_API and stub.calls

    def test_unparseable_cache_is_ignored(self, tmp_path):
        cache = tmp_path / 'c.json'
        cache.write_text('{not json')
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference',
                                           client=StubPricing([_product(1.0)]), cache_path=str(cache), now=NOW)
        assert r['usd_per_hour'] == 1.0

    def test_api_failure_falls_back_to_snapshot_with_its_date(self, tmp_path):
        snap = tmp_path / 's.json'
        snap.write_text(json.dumps({'entries': {self._key(): {
            'usd': 1.5, 'unit': 'Hrs', 'as_of': '2026-10-01T00:00:00Z', 'source': 'pricing-api'}}}))
        r = pricing.resolve_instance_price(
            'ml.g5.xlarge', 'us-west-2', 'realtime-inference',
            client=StubPricing(error=RuntimeError('AccessDeniedException: not authorized')),
            snapshot_path=str(snap), now=NOW)
        assert r['usd_per_hour'] == 1.5 and r['source'] == pricing.SOURCE_SNAPSHOT
        assert r['as_of'] == '2026-10-01T00:00:00Z'
        assert 'pricing:GetProducts' in r['fallback_reason']  # warning names the IAM action

    def test_everything_missing_is_null_with_both_reasons(self, tmp_path):
        r = pricing.resolve_instance_price(
            'ml.g5.xlarge', 'us-west-2', 'realtime-inference',
            client=StubPricing(error=RuntimeError('AccessDeniedException: not authorized')),
            snapshot_path=str(tmp_path / 'absent.json'), now=NOW)
        assert r['usd_per_hour'] is None and r['source'] is None
        assert 'pricing:GetProducts' in r['reason'] and 'snapshot' in r['reason']

    def test_ambiguous_api_result_is_never_picked(self):
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference',
                                           client=StubPricing([_product(1.0), _product(9.0)]), now=NOW)
        assert r['usd_per_hour'] is None and 'ambiguous' in r['reason']

    def test_offline_env_skips_the_api(self, monkeypatch):
        monkeypatch.setenv(pricing.OFFLINE_ENV, '1')
        stub = StubPricing(error=AssertionError('API must not be called'))
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference', client=stub)
        assert r['usd_per_hour'] is None and 'offline' in r['reason'] and not stub.calls

    def test_paginates(self):
        stub = StubPricing(pages=[[], [_product(1.0)]])
        r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference', client=stub)
        assert r['usd_per_hour'] == 1.0 and len(stub.calls) == 2

    @pytest.mark.parametrize('inst,region', [('g5.xlarge', 'us-west-2'), ('ml.g5.xlarge', 'mars-1'), ('', '')])
    def test_invalid_inputs_are_rejected(self, inst, region):
        r = pricing.resolve_instance_price(inst, region, 'realtime-inference', client=StubPricing([_product(1.0)]))
        assert r['usd_per_hour'] is None and r['reason']


class TestBedrockPrices:
    def test_both_prices_per_1m_in_region_only(self):
        class S(StubPricing):
            def get_products(self, **kw):
                self.calls.append(kw)
                kind = {f['Field']: f['Value'] for f in kw['Filters']}['inferenceType']
                return {'PriceList': [_product(0.001 if kind == 'Input tokens' else 0.003, unit='1K tokens')]}
        stub = S()
        r = pricing.resolve_bedrock_prices('Some Model', 'us-west-2', client=stub, now=NOW)
        assert r['input_usd_per_1m'] == pytest.approx(1.0) and r['output_usd_per_1m'] == pytest.approx(3.0)
        for call in stub.calls:
            f = {x['Field']: x['Value'] for x in call['Filters']}
            assert f['regionCode'] == 'us-west-2' and f['feature'] == pricing.BEDROCK_FEATURE

    def test_missing_output_price_nulls_both(self):
        r = pricing.resolve_bedrock_prices('Some Model', 'us-west-2', client=StubPricing([]), now=NOW)
        assert r['input_usd_per_1m'] is None and r['output_usd_per_1m'] is None and r['reason']


# ── Cost + instance count (R8.1 / R8.2) ───────────────────────────────────────

class TestCost:
    def test_formula(self):
        # usd/h x count x 1e6 / (3600 x tps)
        assert pricing.compute_cost(3.6, 2, 100.0) == pytest.approx(3.6 * 2 * 1e6 / (3600 * 100.0))

    def test_cost_scales_with_count_and_inverse_throughput(self):
        base = pricing.compute_cost(5.0, 1, 200.0)
        # compute_cost rounds to 4 dp, so compare within that resolution.
        assert pricing.compute_cost(5.0, 2, 200.0) == pytest.approx(2 * base, abs=2e-4)
        assert pricing.compute_cost(5.0, 1, 400.0) == pytest.approx(base / 2, abs=2e-4)

    @pytest.mark.parametrize('usd,count,tps', [(None, 1, 10), (1, None, 10), (1, 1, 0), (1, 1, None), (-1, 1, 10)])
    def test_missing_inputs_are_null(self, usd, count, tps):
        assert pricing.compute_cost(usd, count, tps) is None


class StubSageMaker:
    def __init__(self, count=None, error=None):
        self.count, self.error = count, error

    def describe_endpoint(self, EndpointName):
        if self.error:
            raise self.error
        return {'ProductionVariants': [{'CurrentInstanceCount': self.count}]}


class TestInstanceCount:
    def test_realtime_uses_current_instance_count(self):
        assert pricing.compute_instance_count('realtime-inference', endpoint_name='ep',
                                              sm_client=StubSageMaker(3)) == (3, None)

    def test_realtime_describe_failure_is_null(self):
        count, reason = pricing.compute_instance_count('realtime-inference', endpoint_name='ep',
                                                       sm_client=StubSageMaker(error=RuntimeError('x')))
        assert count is None and 'DescribeEndpoint' in reason

    def test_realtime_without_endpoint_name_is_null(self):
        assert pricing.compute_instance_count('realtime-inference', endpoint_name=None)[0] is None

    @pytest.mark.parametrize('target', ['hyperpod-eks', 'eks'])
    def test_k8s_nodes_occupied(self, target):
        spec = target_manifest.pricing(target)['instance_count']
        env = {spec['replicas_var']: '3', spec['gpus_per_replica_var']: '2'}
        # 3 replicas x 2 GPUs on 4-GPU nodes -> 2 nodes
        assert pricing.compute_instance_count(target, gpus_per_instance=4, env=env) == (2, None)

    def test_k8s_auto_gpus_means_one_instance_per_replica(self):
        spec = target_manifest.pricing('hyperpod-eks')['instance_count']
        env = {spec['replicas_var']: '2', spec['gpus_per_replica_var']: 'auto'}
        assert pricing.compute_instance_count('hyperpod-eks', env=env) == (2, None)

    def test_k8s_unknown_gpus_per_instance_is_null(self):
        spec = target_manifest.pricing('hyperpod-eks')['instance_count']
        env = {spec['replicas_var']: '2', spec['gpus_per_replica_var']: '1'}
        assert pricing.compute_instance_count('hyperpod-eks', gpus_per_instance=None, env=env)[0] is None

    def test_not_benchmarked_target_has_no_count(self):
        count, reason = pricing.compute_instance_count('batch-transform')
        assert count is None and reason


# ── Labels + caveat (R8.4 / R8.5) ─────────────────────────────────────────────

def _rec(conc, tps, cost):
    return {'concurrency': conc, 'output_token_throughput_tps': tps, 'cost_per_1m_tokens': cost,
            'instance_type': 'ml.g5.xlarge', 'instance_count': 1, 'price_component': 'Hosting',
            'price_usd_per_hour': 1.0, 'price_source': 'pricing-api', 'price_as_of': '2026-10-26T00:00:00Z'}


class TestLabels:
    def test_line_has_measured_concurrency_source_and_date(self):
        line = pricing.format_cost_line(1.23, 4, instance_type='ml.g5.xlarge', instance_count=2,
                                        component='Hosting', usd_per_hour=1.0, price_source='snapshot',
                                        price_as_of='2026-10-01T00:00:00Z')
        assert '@ concurrency 4 (measured)' in line
        assert 'snapshot 2026-10-01' in line and '×2' in line and 'Hosting' in line

    def test_null_cost_still_labeled_with_reason(self):
        line = pricing.format_cost_line(None, 2, reason='no price: x')
        assert '@ concurrency 2 (measured)' in line and 'no price' in line

    def test_caveat_names_sustained_utilization_and_idle(self):
        c = pricing.COST_CAVEAT.lower()
        assert 'sustained utilization' in c and 'idle' in c and 'scale-to-zero' in c

    def test_single_level_has_no_peak_line_and_ends_with_caveat(self):
        lines = pricing.cost_summary_lines([_rec(2, 100.0, 5.0)])
        assert not any('peak sustained' in line for line in lines)
        assert lines[-1] == pricing.COST_CAVEAT

    def test_sweep_adds_peak_at_highest_output_tps(self):
        recs = [_rec(1, 50.0, 9.0), _rec(8, 400.0, 1.0), _rec(4, 300.0, 2.0)]
        peak_lines = [line for line in pricing.cost_summary_lines(recs) if 'peak sustained' in line]
        assert len(peak_lines) == 1 and '@ concurrency 8 (measured)' in peak_lines[0]


# ── Bedrock comparison (R9) ───────────────────────────────────────────────────

CATALOG = {'org/model-a': {'bedrockModelId': 'vendor.model-a', 'priceListModel': 'Model A',
                           'verifiedAt': '2026-10-26T00:00:00Z', 'verifiedRegions': ['us-west-2']}}


def _prices(inp, out):
    return lambda m, r: {'input_usd_per_1m': inp, 'output_usd_per_1m': out, 'source': 'pricing-api',
                         'as_of': '2026-10-26T00:00:00Z'}


class TestBedrock:
    def test_formula_at_measured_ratio(self):
        r = pricing.bedrock_comparison('org/model-a', adapter_name='', region='us-west-2',
                                       input_seq_len_avg=300, output_seq_len_avg=100,
                                       catalog=CATALOG, price_resolver=_prices(0.1, 0.4))
        assert r['bedrock_model_id'] == 'vendor.model-a'
        assert r['bedrock_cost_per_1m_tokens'] == pytest.approx(0.4 + 0.1 * 3.0)

    @pytest.mark.parametrize('name', ['org/Model-A', 'org/model-a-instruct', 'model-a', 'org/model'])
    def test_exact_key_only_no_name_similarity(self, name):
        r = pricing.bedrock_comparison(name, adapter_name='', region='us-west-2', input_seq_len_avg=1,
                                       output_seq_len_avg=1, catalog=CATALOG, price_resolver=_prices(1, 1))
        assert r['bedrock_cost_per_1m_tokens'] is None and r['reason'] == 'no verified mapping'

    def test_adapter_run_has_no_equivalent(self):
        r = pricing.bedrock_comparison('org/model-a', adapter_name='sft-1', region='us-west-2',
                                       input_seq_len_avg=1, output_seq_len_avg=1, catalog=CATALOG,
                                       price_resolver=_prices(1, 1))
        assert r['reason'] == 'adapter run'
        assert 'no Bedrock equivalent (adapter run)' in pricing.format_bedrock_line(r, 2)

    def test_unverified_region_is_not_substituted(self):
        r = pricing.bedrock_comparison('org/model-a', adapter_name='', region='eu-west-1',
                                       input_seq_len_avg=1, output_seq_len_avg=1, catalog=CATALOG,
                                       price_resolver=_prices(1, 1))
        assert r['bedrock_cost_per_1m_tokens'] is None and 'eu-west-1' in r['reason']

    def test_no_price_in_region(self):
        r = pricing.bedrock_comparison('org/model-a', adapter_name='', region='us-west-2',
                                       input_seq_len_avg=1, output_seq_len_avg=1, catalog=CATALOG,
                                       price_resolver=_prices(None, None))
        assert r['bedrock_cost_per_1m_tokens'] is None and 'no on-demand price' in r['reason']

    def test_empty_catalog(self):
        r = pricing.bedrock_comparison('org/model-a', adapter_name='', region='us-west-2',
                                       input_seq_len_avg=1, output_seq_len_avg=1, catalog={})
        assert 'no Bedrock equivalent (no verified mapping)' in pricing.format_bedrock_line(r, 1)

    def test_line_carries_concurrency_and_source(self):
        r = pricing.bedrock_comparison('org/model-a', adapter_name='', region='us-west-2',
                                       input_seq_len_avg=100, output_seq_len_avg=100, catalog=CATALOG,
                                       price_resolver=_prices(0.1, 0.2))
        line = pricing.format_bedrock_line(r, 3)
        assert '@ concurrency 3 (measured)' in line and 'pricing-api 2026-10-26' in line


class TestVerifyBedrock:
    class _Client:
        def __init__(self, summaries):
            self.summaries = summaries

        def list_foundation_models(self):
            return {'modelSummaries': self.summaries}

    def test_records_only_on_demand_regions(self):
        listings = {
            'r-1': [{'modelId': 'v.m', 'inferenceTypesSupported': ['ON_DEMAND']}],
            'r-2': [{'modelId': 'v.m', 'inferenceTypesSupported': ['INFERENCE_PROFILE']}],
            'r-3': [{'modelId': 'v.other', 'inferenceTypesSupported': ['ON_DEMAND']}],
        }
        pricing._LISTING_CACHE.clear()
        entry = pricing.verify_bedrock('org/m', 'v.m', 'M', regions=list(listings),
                                       bedrock_client_factory=lambda r: self._Client(listings[r]),
                                       price_resolver=lambda m, r: {'input_usd_per_1m': 1.0}, now=NOW)
        pricing._LISTING_CACHE.clear()
        assert entry['verifiedRegions'] == ['r-1'] and entry['verifiedAt'].startswith('2026-10-26')

    def test_profile_only_model_is_rejected(self):
        pricing._LISTING_CACHE.clear()
        with pytest.raises(pricing.PriceMiss):
            pricing.verify_bedrock(
                'org/m', 'v.m', 'M', regions=['r-1'],
                bedrock_client_factory=lambda r: self._Client(
                    [{'modelId': 'v.m', 'inferenceTypesSupported': ['INFERENCE_PROFILE']}]),
                price_resolver=lambda m, r: {'input_usd_per_1m': 1.0})
        pricing._LISTING_CACHE.clear()

    def test_unpriced_mapping_is_rejected(self):
        pricing._LISTING_CACHE.clear()
        with pytest.raises(pricing.PriceMiss, match='no on-demand price'):
            pricing.verify_bedrock(
                'org/m', 'v.m', 'M', regions=['r-1'],
                bedrock_client_factory=lambda r: self._Client(
                    [{'modelId': 'v.m', 'inferenceTypesSupported': ['ON_DEMAND']}]),
                price_resolver=lambda m, r: {'input_usd_per_1m': None})
        pricing._LISTING_CACHE.clear()


class TestSnapshotBuilder:
    def test_entries_carry_source_and_date_and_skip_ambiguous(self):
        a = {'instanceName': 'ml.a.x'}
        b = {'instanceName': 'ml.b.x'}

        class S(StubPricing):
            def get_products(self, **kw):
                self.calls.append(kw)
                if kw['ServiceCode'] == 'AmazonSageMaker':
                    return {'PriceList': [_product(1.0, attrs=a), _product(2.0, attrs=b), _product(3.0, attrs=b)]}
                return {'PriceList': [_product(0.5)]}
        doc = pricing.build_snapshot(instances=['ml.a.x', 'ml.b.x'], regions=['us-west-2'],
                                     specs=[('AmazonSageMaker', 'Hosting'), ('AmazonEC2', None)],
                                     bedrock_catalog={}, client=S(), now=NOW)
        assert doc['source'] == pricing.SNAPSHOT_SOURCE_LABEL and doc['generatedAt'].startswith('2026-10-26')
        keys = set(doc['entries'])
        assert pricing.instance_cache_key('AmazonSageMaker', 'Hosting', 'ml.a.x', 'us-west-2') in keys
        assert pricing.instance_cache_key('AmazonSageMaker', 'Hosting', 'ml.b.x', 'us-west-2') not in keys
        assert doc['misses'] >= 1
        for e in doc['entries'].values():
            assert e['usd'] > 0 and e['source'] and e['as_of']


# ── Shipped catalogs: conformance (R7.3 / R9.1 / R14.2) ───────────────────────

class TestShippedCatalogs:
    def test_snapshot_entries_all_carry_source_and_date(self):
        doc = json.load(open(os.path.join(CATALOGS, pricing.SNAPSHOT_FILENAME)))
        assert doc['source'] == pricing.SNAPSHOT_SOURCE_LABEL and doc['generatedAt']
        for key, e in doc['entries'].items():
            assert isinstance(e['usd'], (int, float)) and e['usd'] > 0, key
            assert e['source'] and e['as_of'] and e['unit'], key

    def test_snapshot_keys_use_descriptor_declared_service_components(self):
        declared = {(target_manifest.pricing(t)['service'], target_manifest.pricing(t).get('component') or '-')
                    for t in target_manifest.list_targets()}
        doc = json.load(open(os.path.join(CATALOGS, pricing.SNAPSHOT_FILENAME)))
        for key in doc['entries']:
            service, second = key.split('/')[:2]
            if service == pricing.BEDROCK_SERVICE:
                continue
            assert (service, second) in declared, key

    def test_bedrock_catalog_entries_are_live_verified(self):
        doc = json.load(open(os.path.join(CATALOGS, pricing.BEDROCK_CATALOG_FILENAME)))
        models = doc.get('models', {})
        if not models:
            pytest.skip('bedrock-equivalents.json is empty (no verified mapping yet; '
                        'add one with pricing.py verify-bedrock)')
        for hf_id, e in models.items():
            assert '/' in hf_id, hf_id  # exact HF repo id key
            assert e['bedrockModelId'] and e['priceListModel'] and e['verifiedAt'], hf_id
            assert e['verifiedRegions'], hf_id
            assert set(e.get('pricedRegions', [])) <= set(e['verifiedRegions']), hf_id

    def test_no_hardcoded_price_table_remains(self):
        offenders = []
        for root in ('templates', 'src', 'servers', 'scripts'):
            for dirpath, dirnames, files in os.walk(os.path.join(_REPO, root)):
                dirnames[:] = [d for d in dirnames if d not in ('node_modules', '__pycache__')]
                for name in files:
                    if not name.endswith(('.py', '.js', '.cjs', '.mjs', '.ts', '.sh')) and '.' in name:
                        continue
                    path = os.path.join(dirpath, name)
                    try:
                        text = open(path, encoding='utf-8').read()
                    except (UnicodeDecodeError, OSError):
                        continue
                    if 'INSTANCE_PRICING_USD_PER_HOUR' in text:
                        offenders.append(os.path.relpath(path, _REPO))
        assert offenders == []


# ── Opt-in live check (network; skipped in the default gate) ──────────────────

@pytest.mark.skipif(os.environ.get('MLCC_LIVE_PRICING') != '1',
                    reason='live Pricing API check is opt-in: set MLCC_LIVE_PRICING=1 with AWS credentials')
def test_live_pricing_api_resolves_a_catalog_gpu_instance(tmp_path):
    r = pricing.resolve_instance_price('ml.g5.xlarge', 'us-west-2', 'realtime-inference',
                                       cache_path=str(tmp_path / 'c.json'))
    assert r['source'] == pricing.SOURCE_API and r['usd_per_hour'] and r['usd_per_hour'] > 0
