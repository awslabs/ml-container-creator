# SPDX-License-Identifier: Apache-2.0

"""Unit tests for gpu_metrics.py (BL086).

Covers:
  * collect_cloudwatch() with mocked boto3 → correct dict structure (Req 6.1)
  * collect_cloudwatch() on AWS error → {} (Req 6.2)
  * collect_engine_metrics() parses vLLM Prometheus text (counter-pair hit rate) (Req 6.3)
  * collect_engine_metrics() parses SGLang Prometheus text (computed ratio gauge)
  * collect_engine_metrics() on timeout/error → {} (Req 6.4)
"""

import importlib.util
import os
import sys
from datetime import datetime, timezone
from unittest import mock

import pytest

# ── Import the module under test ──────────────────────────────────────────────
_GM_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", "lib", "python", "gpu_metrics.py",
)
_GM_PATH = os.path.normpath(_GM_PATH)
_spec = importlib.util.spec_from_file_location("gpu_metrics", _GM_PATH)
gpu_metrics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gpu_metrics)


# ── METRIC_REGISTRY sanity ─────────────────────────────────────────────────────


class TestMetricRegistry:
    def test_vllm_kv_cache_uses_canonical_name(self):
        # BL086: must be vllm:kv_cache_usage_perc, NOT gpu_cache_usage_perc.
        assert gpu_metrics.METRIC_REGISTRY['vllm']['kv_cache_util'] == 'vllm:kv_cache_usage_perc'

    def test_vllm_prefix_cache_is_counter_pair(self):
        vllm = gpu_metrics.METRIC_REGISTRY['vllm']
        assert vllm['prefix_cache_queries'] == 'vllm:prefix_cache_queries'
        assert vllm['prefix_cache_hits'] == 'vllm:prefix_cache_hits'
        # No single hit-rate gauge for vLLM.
        assert 'prefix_cache_hit_rate' not in vllm

    def test_sglang_cache_hit_rate_is_gauge_ratio(self):
        sglang = gpu_metrics.METRIC_REGISTRY['sglang']
        assert sglang['prefix_cache_hit_rate'] == 'sglang:cache_hit_rate'


# ── collect_cloudwatch ─────────────────────────────────────────────────────────


class TestCollectCloudwatch:
    def _window(self):
        start = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 1, 1, 0, 10, 0, tzinfo=timezone.utc)
        return start, end

    def test_returns_dict_structure_with_mocked_boto3(self):
        """Req 6.1: mocked CloudWatch → correct dict structure."""
        start, end = self._window()

        fake_client = mock.MagicMock()
        fake_client.get_metric_data.return_value = {
            'MetricDataResults': [
                {'Id': 'gpu_util_avg', 'Values': [50.0, 70.0]},
                {'Id': 'gpu_util_max', 'Values': [90.0]},
                {'Id': 'gpu_mem_util_avg', 'Values': [40.0, 60.0]},
            ]
        }

        fake_boto3 = mock.MagicMock()
        fake_boto3.client.return_value = fake_client
        # boto3 is imported inside the function; patch the import target.
        with mock.patch.dict(sys.modules, {'boto3': fake_boto3}):
            out = gpu_metrics.collect_cloudwatch(
                'ep', 'AllTraffic', 'ic-1', start, end, 'us-east-1'
            )

        assert out['gpu_utilization_avg'] == pytest.approx(60.0)
        assert out['gpu_utilization_max'] == pytest.approx(90.0)
        assert out['gpu_memory_util_avg'] == pytest.approx(50.0)

    def test_returns_empty_dict_on_aws_error(self):
        """Req 6.2: any AWS error → {} (non-fatal)."""
        start, end = self._window()

        fake_client = mock.MagicMock()
        fake_client.get_metric_data.side_effect = RuntimeError("AccessDenied")

        fake_boto3 = mock.MagicMock()
        fake_boto3.client.return_value = fake_client
        with mock.patch.dict(sys.modules, {'boto3': fake_boto3}):
            out = gpu_metrics.collect_cloudwatch(
                'ep', 'AllTraffic', '', start, end, 'us-east-1'
            )
        assert out == {}

    def test_returns_empty_dict_when_boto3_unavailable(self):
        start, end = self._window()
        # Simulate boto3 import failure.
        with mock.patch.dict(sys.modules, {'boto3': None}):
            out = gpu_metrics.collect_cloudwatch(
                'ep', 'AllTraffic', '', start, end, 'us-east-1'
            )
        assert out == {}


# ── collect_engine_metrics ─────────────────────────────────────────────────────

_VLLM_METRICS = """\
# HELP vllm:kv_cache_usage_perc GPU KV-cache usage.
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{model_name="m"} 0.42
# TYPE vllm:prefix_cache_queries counter
vllm:prefix_cache_queries{model_name="m"} 1000.0
# TYPE vllm:prefix_cache_hits counter
vllm:prefix_cache_hits{model_name="m"} 250.0
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="m"} 8.0
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{model_name="m"} 3.0
"""

_SGLANG_METRICS = """\
# TYPE sglang:token_usage gauge
sglang:token_usage{model_name="m"} 0.55
# TYPE sglang:cache_hit_rate gauge
sglang:cache_hit_rate{model_name="m"} 0.73
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{model_name="m"} 12.0
# TYPE sglang:num_queue_reqs gauge
sglang:num_queue_reqs{model_name="m"} 6.0
"""


class _FakeResp:
    def __init__(self, text):
        self._text = text.encode('utf-8')

    def read(self):
        return self._text

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestCollectEngineMetrics:
    def test_parses_vllm_prometheus_counter_pair(self):
        """Req 6.3: vLLM /metrics parsed; hit_rate = hits/queries."""
        with mock.patch('urllib.request.urlopen', return_value=_FakeResp(_VLLM_METRICS)):
            out = gpu_metrics.collect_engine_metrics('http://localhost:8080', 'vllm')

        assert out['kv_cache_util_avg'] == pytest.approx(0.42)
        assert out['kv_cache_util_max'] == pytest.approx(0.42)
        # 250 / 1000 = 0.25
        assert out['prefix_cache_hit_rate'] == pytest.approx(0.25)
        assert out['queue_depth_running_avg'] == pytest.approx(8.0)
        assert out['queue_depth_waiting_avg'] == pytest.approx(3.0)
        assert out['queue_depth_waiting_max'] == pytest.approx(3.0)

    def test_parses_sglang_prometheus_gauge_ratio(self):
        """SGLang /metrics: cache_hit_rate is already a ratio gauge."""
        with mock.patch('urllib.request.urlopen', return_value=_FakeResp(_SGLANG_METRICS)):
            out = gpu_metrics.collect_engine_metrics('http://localhost:8080', 'sglang')

        assert out['kv_cache_util_avg'] == pytest.approx(0.55)
        assert out['prefix_cache_hit_rate'] == pytest.approx(0.73)
        assert out['queue_depth_running_avg'] == pytest.approx(12.0)
        assert out['queue_depth_waiting_avg'] == pytest.approx(6.0)

    def test_returns_empty_dict_on_timeout(self):
        """Req 6.4: timeout/connection error → {}."""
        with mock.patch('urllib.request.urlopen', side_effect=TimeoutError("timed out")):
            out = gpu_metrics.collect_engine_metrics('http://localhost:8080', 'vllm')
        assert out == {}

    def test_returns_empty_dict_for_unknown_engine(self):
        out = gpu_metrics.collect_engine_metrics('http://localhost:8080', 'not-an-engine')
        assert out == {}

    def test_vllm_zero_queries_yields_no_hit_rate(self):
        text = _VLLM_METRICS.replace('vllm:prefix_cache_queries{model_name="m"} 1000.0',
                                     'vllm:prefix_cache_queries{model_name="m"} 0.0')
        with mock.patch('urllib.request.urlopen', return_value=_FakeResp(text)):
            out = gpu_metrics.collect_engine_metrics('http://localhost:8080', 'vllm')
        # Division by zero avoided → no hit rate key.
        assert 'prefix_cache_hit_rate' not in out


# ── CLI entrypoint ─────────────────────────────────────────────────────────────


class TestCliEntrypoint:
    def test_engine_metrics_subcommand_prints_json(self, capsys):
        with mock.patch('urllib.request.urlopen', return_value=_FakeResp(_VLLM_METRICS)):
            rc = gpu_metrics._main(['gpu_metrics.py', 'engine-metrics', 'http://localhost:8080', 'vllm'])
        assert rc == 0
        import json
        out = json.loads(capsys.readouterr().out)
        assert out['kv_cache_util_avg'] == pytest.approx(0.42)

    def test_bad_usage_returns_1(self, capsys):
        rc = gpu_metrics._main(['gpu_metrics.py'])
        assert rc == 1
