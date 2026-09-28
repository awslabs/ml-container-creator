# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL108 Phase 2 metrics poller — unit tests (pytest).

Feature: v18-w3-02-bl108

Example-based coverage for:
  * aggregate() peak/avg over a fixed buffer (Req 3.1)
  * partial-sample handling + sample_count/partial flags (Req 5)
  * empty-buffer → no output (Error Handling)
  * output key alignment with benchmark_gpu_metrics.extract_metrics (Req 6)
  * should_spawn() spawn/skip predicate (Req 1.1, 4.1)
  * run_poller() end-to-end file production with a mocked scrape (Req 2, 3)
  * spec_decode aggregation (Req 2.2)
  * .benchmark_writer.py byte-unchanged guard (Req 6.1)

The universally-quantified aggregation laws live in
test/property/test_bl108_phase2_poller_properties.py (Hypothesis).
"""

import hashlib
import importlib.util
import json
import os
import threading

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_LIB = os.path.join(_REPO_ROOT, "templates", "do", "lib", "python")
_POLLER_PATH = os.path.join(_LIB, "phase2_poller.py")
_BM_GPU_PATH = os.path.join(_LIB, "benchmark_gpu_metrics.py")
_WRITER_PATH = os.path.join(_REPO_ROOT, "templates", "do", ".benchmark_writer.py")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


phase2_poller = _load("phase2_poller", _POLLER_PATH)
benchmark_gpu_metrics = _load("benchmark_gpu_metrics_bl108", _BM_GPU_PATH)


def _run_bounded(fn, *args, timeout=5, **kwargs):
    """Run ``fn`` in a worker thread and fail fast if it does not return.

    ``run_poller`` executes its sample loop synchronously in the calling thread,
    so a loop that never observes its stop condition would hang the test suite
    forever. We run it in a daemon thread and join with an explicit timeout; if
    the thread is still alive after the timeout the loop did not terminate and we
    fail with a clear message instead of hanging. The thread is a daemon so a
    genuinely stuck loop cannot block interpreter exit.
    """
    result_box: dict = {}

    def _target():
        try:
            result_box["value"] = fn(*args, **kwargs)
        except BaseException as exc:  # surface loop-body errors to the caller
            result_box["error"] = exc

    worker = threading.Thread(target=_target, daemon=True)
    worker.start()
    worker.join(timeout=timeout)
    if worker.is_alive():
        pytest.fail(
            f"run_poller did not terminate within {timeout}s — the sample loop "
            f"never observed its stop condition (BL108 poller hang)."
        )
    if "error" in result_box:
        raise result_box["error"]
    return result_box.get("value", {})


# ── aggregate() examples (Req 3.1, 5) ─────────────────────────────────────────


class TestAggregateExamples:
    def _five_samples(self):
        return [
            {"kv_cache_util_avg": 0.2, "queue_depth_waiting_avg": 1.0,
             "prefix_cache_hit_rate": 0.5, "spec_decode_acceptance_rate": 0.6},
            {"kv_cache_util_avg": 0.4, "queue_depth_waiting_avg": 2.0,
             "prefix_cache_hit_rate": 0.6, "spec_decode_acceptance_rate": 0.7},
            {"kv_cache_util_avg": 0.6, "queue_depth_waiting_avg": 3.0,
             "prefix_cache_hit_rate": 0.7, "spec_decode_acceptance_rate": 0.8},
            {"kv_cache_util_avg": 0.8, "queue_depth_waiting_avg": 4.0,
             "prefix_cache_hit_rate": 0.8, "spec_decode_acceptance_rate": 0.9},
            {"kv_cache_util_avg": 1.0, "queue_depth_waiting_avg": 5.0,
             "prefix_cache_hit_rate": 0.9, "spec_decode_acceptance_rate": 1.0},
        ]

    def test_five_samples_peak_and_avg(self):
        out = phase2_poller.aggregate(self._five_samples())
        # avg of [0.2..1.0] = 0.6 ; peak (derived) = 1.0
        assert out["kv_cache_util_avg"] == pytest.approx(0.6)
        assert out["kv_cache_util_max"] == pytest.approx(1.0)
        # avg of [1..5] = 3.0 ; derived max = 5.0
        assert out["queue_depth_waiting_avg"] == pytest.approx(3.0)
        assert out["queue_depth_waiting_max"] == pytest.approx(5.0)
        # counter-pair ratios → mean of sampled ratios
        assert out["prefix_cache_hit_rate"] == pytest.approx(0.7)
        assert out["spec_decode_acceptance_rate"] == pytest.approx(0.8)
        assert out["sample_count"] == 5
        assert out["partial"] is False
        assert out["metrics_source"] == "engine_metrics_only"

    def test_three_samples_partial(self):
        out = phase2_poller.aggregate(self._five_samples()[:3])
        assert out["sample_count"] == 3
        assert out["partial"] is True
        assert out["kv_cache_util_avg"] == pytest.approx(0.4)  # mean 0.2,0.4,0.6
        assert out["kv_cache_util_max"] == pytest.approx(0.6)

    def test_explicit_max_key_wins_over_derived(self):
        samples = [
            {"kv_cache_util_avg": 0.3, "kv_cache_util_max": 0.9},
            {"kv_cache_util_avg": 0.5, "kv_cache_util_max": 0.95},
        ]
        out = phase2_poller.aggregate(samples)
        assert out["kv_cache_util_avg"] == pytest.approx(0.4)
        # explicit max column present → peak = max of sampled max values
        assert out["kv_cache_util_max"] == pytest.approx(0.95)

    def test_metric_present_in_only_some_samples(self):
        samples = [
            {"kv_cache_util_avg": 0.2},
            {"prefix_cache_hit_rate": 0.8},
            {"kv_cache_util_avg": 0.6},
        ]
        out = phase2_poller.aggregate(samples)
        # kv averaged over the 2 samples that carry it (not 3, no zero-fill)
        assert out["kv_cache_util_avg"] == pytest.approx(0.4)
        assert out["prefix_cache_hit_rate"] == pytest.approx(0.8)
        assert out["sample_count"] == 3

    def test_empty_buffer_yields_empty_dict(self):
        assert phase2_poller.aggregate([]) == {}
        assert phase2_poller.aggregate([{}, {}]) == {}

    def test_non_numeric_and_bool_values_ignored(self):
        samples = [
            {"kv_cache_util_avg": 0.5},
            {"kv_cache_util_avg": True},   # bool excluded
            {"kv_cache_util_avg": "x"},    # non-numeric excluded
        ]
        out = phase2_poller.aggregate(samples)
        assert out["kv_cache_util_avg"] == pytest.approx(0.5)


# ── Output key alignment with the consumer (Req 6) ────────────────────────────


class TestOutputKeyAlignment:
    def test_written_keys_are_read_by_extract_metrics(self, tmp_path):
        samples = [
            {"kv_cache_util_avg": 0.5, "queue_depth_waiting_avg": 2.0,
             "prefix_cache_hit_rate": 0.7, "spec_decode_acceptance_rate": 0.8}
            for _ in range(5)
        ]
        out = phase2_poller.aggregate(samples)
        gm_file = tmp_path / ".last_gpu_metrics.json"
        gm_file.write_text(json.dumps(out))

        # A minimal jsonl results file so extract_metrics has a base path.
        jsonl = tmp_path / "profile_export.jsonl"
        jsonl.write_text("{}\n")

        metrics = benchmark_gpu_metrics.extract_metrics(
            str(jsonl), gpu_metrics_override=str(gm_file)
        )
        # The consumer picks up the poller's engine keys (its _GPU_FIELDS subset).
        assert metrics.get("kv_cache_util_avg") == pytest.approx(0.5)
        assert metrics.get("kv_cache_util_max") == pytest.approx(0.5)
        assert metrics.get("prefix_cache_hit_rate") == pytest.approx(0.7)
        assert benchmark_gpu_metrics._metrics_source(metrics) == "engine_metrics_only"


# ── should_spawn predicate (Req 1.1, 4.1) ─────────────────────────────────────


class TestShouldSpawn:
    def test_spawns_when_endpoint_declared_and_opted_in(self):
        me = {"path": "/metrics", "port": 8080, "format": "prometheus"}
        assert phase2_poller.should_spawn(me, opted_in=True) is True

    def test_skips_when_endpoint_absent(self):
        assert phase2_poller.should_spawn(None, opted_in=True) is False
        assert phase2_poller.should_spawn({}, opted_in=True) is False

    def test_skips_when_not_opted_in(self):
        me = {"path": "/metrics", "port": 8080, "format": "prometheus"}
        assert phase2_poller.should_spawn(me, opted_in=False) is False


# ── run_poller end-to-end (Req 2, 3, 5) ───────────────────────────────────────


class TestRunPoller:
    def test_writes_file_from_mocked_samples(self, tmp_path, monkeypatch):
        seq = [
            {"kv_cache_util_avg": 0.1, "prefix_cache_hit_rate": 0.5},
            {"kv_cache_util_avg": 0.3, "prefix_cache_hit_rate": 0.6},
            {"kv_cache_util_avg": 0.5, "prefix_cache_hit_rate": 0.7},
            {"kv_cache_util_avg": 0.7, "prefix_cache_hit_rate": 0.8},
            {"kv_cache_util_avg": 0.9, "prefix_cache_hit_rate": 0.9},
        ]
        calls = {"n": 0}

        def _fake_sample(base_url, engine):
            i = calls["n"]
            calls["n"] += 1
            return seq[i] if i < len(seq) else {}

        monkeypatch.setattr(phase2_poller, "sample_once", _fake_sample)

        out_file = tmp_path / ".last_gpu_metrics.json"
        result = _run_bounded(
            phase2_poller.run_poller,
            "http://localhost:18080", "vllm", str(out_file),
            interval=0, min_samples=5, max_samples=5, timeout=5,
        )
        assert out_file.exists()
        written = json.loads(out_file.read_text())
        assert written["sample_count"] == 5
        assert written["partial"] is False
        assert written["kv_cache_util_avg"] == pytest.approx(0.5)
        assert written["kv_cache_util_max"] == pytest.approx(0.9)
        assert result == written

    def test_empty_samples_write_no_file(self, tmp_path, monkeypatch):
        # An all-empty run must terminate via its stop signal. sample_once
        # returns {} on every tick, so the buffer never fills and max_samples
        # (which counts non-empty samples only) can never be reached — the loop
        # would spin forever without a stop_event. We arm one after a few empty
        # ticks, matching how do/benchmark ends an idle poller in production.
        stop = threading.Event()
        ticks = {"n": 0}

        def _fake_sample(*a):
            ticks["n"] += 1
            if ticks["n"] >= 3:
                stop.set()
            return {}

        monkeypatch.setattr(phase2_poller, "sample_once", _fake_sample)
        out_file = tmp_path / ".last_gpu_metrics.json"
        result = _run_bounded(
            phase2_poller.run_poller,
            "http://localhost:18080", "vllm", str(out_file),
            interval=0, min_samples=5, max_samples=3, stop_event=stop, timeout=5,
        )
        # Buffer never fills (samples empty); the loop ends via stop_event and
        # an empty buffer writes no file.
        assert not out_file.exists()
        assert result == {}

    def test_stop_event_ends_loop_and_writes_partial(self, tmp_path, monkeypatch):
        seq = [{"kv_cache_util_avg": 0.4}, {"kv_cache_util_avg": 0.6}]
        calls = {"n": 0}
        stop = threading.Event()

        def _fake_sample(base_url, engine):
            i = calls["n"]
            calls["n"] += 1
            if i >= len(seq):
                stop.set()
                return {}
            return seq[i]

        monkeypatch.setattr(phase2_poller, "sample_once", _fake_sample)
        out_file = tmp_path / ".last_gpu_metrics.json"
        result = _run_bounded(
            phase2_poller.run_poller,
            "http://localhost:18080", "vllm", str(out_file),
            interval=0, min_samples=5, stop_event=stop, timeout=5,
        )
        assert out_file.exists()
        assert result["sample_count"] == 2
        assert result["partial"] is True


# ── run_poller must not fill max_samples on empty samples ─────────────────────


class TestEmptySamplesTermination:
    def test_all_empty_with_stop_event(self, tmp_path, monkeypatch):
        stop = threading.Event()
        ticks = {"n": 0}

        def _fake_sample(base_url, engine):
            ticks["n"] += 1
            if ticks["n"] >= 3:
                stop.set()
            return {}

        monkeypatch.setattr(phase2_poller, "sample_once", _fake_sample)
        out_file = tmp_path / ".last_gpu_metrics.json"
        result = _run_bounded(
            phase2_poller.run_poller,
            "http://localhost:18080", "vllm", str(out_file),
            interval=0, min_samples=5, stop_event=stop, timeout=5,
        )
        assert result == {}
        assert not out_file.exists()


# ── Guard: .benchmark_writer.py byte-unchanged (Req 6.1) ──────────────────────


class TestBenchmarkWriterUnchanged:
    # Pinned SHA-256 of templates/do/.benchmark_writer.py as of BL108. If this
    # test fails, BL108 (or a later change) has modified the writer — a BL082
    # constraint violation. Update this hash ONLY when an intentional, separately
    # reviewed change to the writer lands.
    _EXPECTED_SHA256 = "26aae22ff23de7539867d09a58156a1e9c497519c49143633b4f0c69a251ec1a"

    def test_writer_hash_unchanged(self):
        with open(_WRITER_PATH, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        assert digest == self._EXPECTED_SHA256, (
            ".benchmark_writer.py changed — BL082/BL108 Req 6 forbids modifying it."
        )
