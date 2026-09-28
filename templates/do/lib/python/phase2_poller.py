#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Phase 2 background metrics poller (BL108).

Upgrades the BL086 point-in-time engine ``/metrics`` scrape into a background
poller that samples engine metrics every 5 seconds for the whole benchmark run,
aggregates peak/avg, and writes ``benchmarks/.last_gpu_metrics.json`` at the
end. Spawned by ``do/benchmark`` only when the active engine's manifest declares
a ``metrics_endpoint`` (BL105); silently skipped otherwise.

Responsibility split (design.md § "Where the poller lives"):
  * ``do/benchmark`` bash owns the opt-in gate, kubeconfig/ARN/pod discovery, the
    ``kubectl port-forward`` and its PID lifecycle, and the spawn decision.
  * This module owns the 5s sample loop, per-sample scrape (delegated to
    ``gpu_metrics.collect_engine_metrics``), buffering, peak/avg aggregation, the
    minimum-sample reporting rule, and writing ``.last_gpu_metrics.json``.

Non-fatal contract (inherited from gpu_metrics / BL086): metrics collection
NEVER fails the benchmark. Any scrape error yields an empty sample that is
skipped; an empty buffer writes no file. The poller exits 0 in all cases.

For vLLM the poller collects (via METRIC_REGISTRY): kv_cache_util, queue_depth
(running/waiting), prefix_cache_hit_rate, and spec_decode (acceptance rate).

CLI (invoked by do/benchmark as a background process):

    python3 phase2_poller.py <base_url> <engine> <output_file> \
        [--interval 5] [--min-samples 5] [--stop-file PATH] [--max-samples N]

The poller stops when ``--stop-file`` appears on disk (bash ``touch``es it at
benchmark end), when ``--max-samples`` is reached, or on SIGTERM/SIGINT.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time

# ── Import gpu_metrics (single source of truth for the per-sample scrape) ──────
# The poller lives alongside gpu_metrics.py in do/lib/python/. Import by adding
# our own directory to sys.path so this works whether invoked as a script or
# imported as a module in tests.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import gpu_metrics  # noqa: E402


# Default poller parameters (Req 2.1 interval, Req 5.1 minimum samples).
DEFAULT_INTERVAL = 5
DEFAULT_MIN_SAMPLES = 5

# Metric keys the poller aggregates into ``*_avg`` / ``*_max`` peak/avg pairs.
# These are exactly the keys ``collect_engine_metrics`` may emit; each is a
# per-sample numeric value the poller treats as a gauge over the run. Keys not
# present in a given sample are ignored (never coerced to 0).
_AGGREGATE_KEYS = (
    'kv_cache_util_avg',
    'kv_cache_util_max',
    'queue_depth_running_avg',
    'queue_depth_waiting_avg',
    'queue_depth_waiting_max',
    'prefix_cache_hit_rate',
    'spec_decode_acceptance_rate',
)

# Base metric names whose peak (``*_max``) is derived when only the ``*_avg``
# form is sampled — so the written file always carries both peak and avg for the
# gauges the consumer (benchmark_gpu_metrics.py) reads.
_DERIVE_MAX_FROM_AVG = {
    'kv_cache_util_avg': 'kv_cache_util_max',
    'queue_depth_waiting_avg': 'queue_depth_waiting_max',
}


def sample_once(base_url: str, engine: str) -> dict:
    """Take one engine-metrics scrape.

    Delegates to ``gpu_metrics.collect_engine_metrics(base_url, engine)`` — the
    single source of truth for the vLLM/SGLang Prometheus name mapping. Returns
    ``{}`` on any error (non-fatal contract inherited from gpu_metrics), which
    the caller treats as "skip this tick".
    """
    try:
        result = gpu_metrics.collect_engine_metrics(base_url, engine)
        return result if isinstance(result, dict) else {}
    except Exception:
        # Belt-and-suspenders: collect_engine_metrics already swallows errors,
        # but never let a scrape crash the poller.
        return {}


def aggregate(samples: list[dict], min_samples: int = DEFAULT_MIN_SAMPLES) -> dict:
    """Aggregate a buffer of per-sample metric dicts into peak/avg values.

    Pure function (no I/O). For each metric present in at least one sample,
    computes:
      * ``*_avg`` keys → arithmetic mean over the samples that carry that key.
      * ``*_max`` keys → maximum over the samples that carry that key.
      * counter-pair ratios (``prefix_cache_hit_rate``,
        ``spec_decode_acceptance_rate``) → mean over the sampled ratios.

    Missing entries are ignored (never treated as 0), so a metric present in
    only some samples aggregates over exactly those samples.

    Minimum-sample rule (Req 5): the number of non-empty samples is recorded as
    ``sample_count`` and ``partial`` is set true when it is below ``min_samples``.
    Partial buffers still aggregate (Req 5.2) — the rule governs the confidence
    flag, not whether a result is produced.

    Returns ``{}`` for an empty buffer (nothing to aggregate).
    """
    non_empty = [s for s in samples if isinstance(s, dict) and s]
    count = len(non_empty)
    if count == 0:
        return {}

    out: dict = {}
    for key in _AGGREGATE_KEYS:
        values = []
        for sample in non_empty:
            val = sample.get(key)
            if isinstance(val, bool):  # bool is an int subclass; exclude it
                continue
            if isinstance(val, (int, float)):
                values.append(float(val))
        if not values:
            continue
        if key.endswith('_max'):
            out[key] = max(values)
        else:
            # ``*_avg`` and counter-pair ratios → mean over the sampled values.
            out[key] = sum(values) / len(values)

    # Derive a peak (``*_max``) for gauges sampled only in ``*_avg`` form, so the
    # output carries both peak and avg for the keys the consumer reads.
    for avg_key, max_key in _DERIVE_MAX_FROM_AVG.items():
        if max_key in out:
            continue
        peak_vals = [
            float(s[avg_key])
            for s in non_empty
            if isinstance(s.get(avg_key), (int, float)) and not isinstance(s.get(avg_key), bool)
        ]
        if peak_vals:
            out[max_key] = max(peak_vals)

    out['sample_count'] = count
    out['partial'] = count < min_samples
    # Classify the file so benchmark_gpu_metrics._metrics_source() treats it as
    # engine-only (it already infers this from engine keys, but be explicit).
    out['metrics_source'] = 'engine_metrics_only'
    return out


def run_poller(
    base_url: str,
    engine: str,
    output_file: str,
    interval: int = DEFAULT_INTERVAL,
    min_samples: int = DEFAULT_MIN_SAMPLES,
    stop_event: threading.Event | None = None,
    stop_file: str | None = None,
    max_samples: int | None = None,
) -> dict:
    """Sample ``base_url`` every ``interval`` seconds until stopped, then write.

    Sampling loop (Req 2.1): each tick calls :func:`sample_once`; non-empty
    samples are appended to an in-memory buffer, empty ones are skipped. The loop
    ends when any of these becomes true:
      * ``stop_event`` is set (in-process stop, used by tests),
      * ``stop_file`` exists on disk (out-of-process stop, used by do/benchmark),
      * ``max_samples`` non-empty samples have been collected (bounds test runs).

    On stop, the buffer is aggregated (Req 3, Req 5) and, when non-empty, written
    to ``output_file`` as ``.last_gpu_metrics.json`` (Req 3.1). An empty buffer
    writes no file. Returns the aggregate dict (``{}`` when nothing was written).
    """
    buffer: list[dict] = []

    def _should_stop() -> bool:
        if stop_event is not None and stop_event.is_set():
            return True
        if stop_file and os.path.exists(stop_file):
            return True
        if max_samples is not None and len(buffer) >= max_samples:
            return True
        return False

    # Take the first sample immediately so very short runs still capture data.
    while not _should_stop():
        sample = sample_once(base_url, engine)
        if sample:
            buffer.append(sample)
        if max_samples is not None and len(buffer) >= max_samples:
            break
        # Interruptible sleep: wake early if the stop signal arrives so we do not
        # linger a full interval past benchmark end.
        _interruptible_sleep(interval, stop_event, stop_file)

    result = aggregate(buffer, min_samples=min_samples)
    if result:
        _write_output(output_file, result)
    return result


def _interruptible_sleep(
    interval: float,
    stop_event: threading.Event | None,
    stop_file: str | None,
) -> None:
    """Sleep up to ``interval`` seconds, waking early on the stop signal."""
    if stop_event is not None:
        # Event.wait returns as soon as the event is set.
        stop_event.wait(timeout=interval)
        return
    if stop_file:
        # Poll the sentinel file in short slices so we react within ~0.25s.
        deadline = time.monotonic() + interval
        while time.monotonic() < deadline:
            if os.path.exists(stop_file):
                return
            time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
        return
    time.sleep(interval)


def _write_output(output_file: str, payload: dict) -> None:
    """Write ``payload`` as JSON to ``output_file`` (best-effort, non-fatal)."""
    try:
        parent = os.path.dirname(os.path.abspath(output_file))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
    except OSError:
        # Non-fatal: inability to write the sidecar must not fail the benchmark.
        pass


def should_spawn(metrics_endpoint, opted_in: bool = True) -> bool:
    """Pure spawn predicate (Property 1 / Req 1.1, 4.1).

    The Phase 2 poller is spawned if and only if the engine manifest declares a
    ``metrics_endpoint`` (a non-empty dict) AND the operator opted in (the outer
    ``HP_BENCHMARK_METRICS_ENABLED`` / deployment-target guard, passed as
    ``opted_in``). An absent/``None``/empty endpoint yields ``False`` — silent
    skip, no error.
    """
    if not opted_in:
        return False
    return isinstance(metrics_endpoint, dict) and len(metrics_endpoint) > 0


# ── CLI entrypoint (background process launched by do/benchmark) ───────────────


def _install_signal_stop(stop_event: threading.Event) -> None:
    """Wire SIGTERM/SIGINT to set the stop event, so bash can end the poller."""

    def _handler(_signum, _frame):
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            # Signals can only be installed on the main thread; ignore otherwise.
            pass


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description='Phase 2 background engine-metrics poller (BL108).'
    )
    parser.add_argument('base_url', help='Engine base URL, e.g. http://localhost:18080')
    parser.add_argument('engine', help='Engine key (e.g. vllm, sglang)')
    parser.add_argument('output_file', help='Path to write .last_gpu_metrics.json')
    parser.add_argument('--interval', type=int, default=DEFAULT_INTERVAL,
                        help='Seconds between samples (default 5).')
    parser.add_argument('--min-samples', type=int, default=DEFAULT_MIN_SAMPLES,
                        help='Minimum samples for a full-confidence report (default 5).')
    parser.add_argument('--stop-file', default=None,
                        help='Poller stops once this sentinel file exists.')
    parser.add_argument('--max-samples', type=int, default=None,
                        help='Stop after this many non-empty samples (optional).')
    args = parser.parse_args(argv)

    stop_event = threading.Event()
    _install_signal_stop(stop_event)

    try:
        run_poller(
            args.base_url,
            args.engine,
            args.output_file,
            interval=args.interval,
            min_samples=args.min_samples,
            stop_event=stop_event,
            stop_file=args.stop_file,
            max_samples=args.max_samples,
        )
    except Exception:
        # Non-fatal contract: never fail the benchmark from the poller.
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
