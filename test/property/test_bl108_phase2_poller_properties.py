# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL108 Phase 2 metrics poller — property-based tests (Hypothesis).

Feature: v18-w3-02-bl108

Universally-quantified laws for the pure aggregation function and the spawn
predicate. Orchestration/sequencing and the writer-unchanged constraint are
covered by example/integration/guard tests in
test/unit/test_bl108_phase2_poller.py.

Each property runs >= 100 iterations (Hypothesis default profile) and is tagged
with the design property it validates.
"""

import importlib.util
import math
import os

from hypothesis import given, settings
from hypothesis import strategies as st

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_POLLER_PATH = os.path.join(
    _REPO_ROOT, "templates", "do", "lib", "python", "phase2_poller.py"
)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


phase2_poller = _load("phase2_poller", _POLLER_PATH)

# Metric keys the aggregator recognizes, split by aggregation kind.
_AVG_KEYS = (
    "kv_cache_util_avg",
    "queue_depth_running_avg",
    "queue_depth_waiting_avg",
    "prefix_cache_hit_rate",
    "spec_decode_acceptance_rate",
)
_MAX_KEYS = (
    "kv_cache_util_max",
    "queue_depth_waiting_max",
)
_ALL_KEYS = _AVG_KEYS + _MAX_KEYS

_finite = st.floats(
    min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False
)


@st.composite
def _sample(draw):
    """A single sample: a dict with a random non-empty subset of metric keys."""
    keys = draw(st.lists(st.sampled_from(_ALL_KEYS), min_size=1, max_size=len(_ALL_KEYS), unique=True))
    return {k: draw(_finite) for k in keys}


@st.composite
def _sample_list(draw, min_size=1, max_size=12):
    return draw(st.lists(_sample(), min_size=min_size, max_size=max_size))


def _present_values(samples, key):
    return [
        float(s[key])
        for s in samples
        if isinstance(s.get(key), (int, float)) and not isinstance(s.get(key), bool)
    ]


# Feature: v18-w3-02-bl108, Property 2: Peak equals the maximum sample
@settings(max_examples=150)
@given(samples=_sample_list())
def test_property_2_peak_equals_max(samples):
    out = phase2_poller.aggregate(samples)
    for max_key in _MAX_KEYS:
        vals = _present_values(samples, max_key)
        if vals:
            assert out[max_key] == max(vals)


# Feature: v18-w3-02-bl108, Property 3: Average equals the mean of the samples
@settings(max_examples=150)
@given(samples=_sample_list())
def test_property_3_avg_equals_mean(samples):
    out = phase2_poller.aggregate(samples)
    for avg_key in _AVG_KEYS:
        vals = _present_values(samples, avg_key)
        if vals:
            assert math.isclose(out[avg_key], sum(vals) / len(vals), rel_tol=1e-9, abs_tol=1e-9)


# Feature: v18-w3-02-bl108, Property 4: sample_count/partial reflect the buffer,
# and partial runs still aggregate.
@settings(max_examples=150)
@given(samples=st.lists(_sample(), min_size=0, max_size=12))
def test_property_4_sample_count_and_partial(samples):
    non_empty = [s for s in samples if s]
    out = phase2_poller.aggregate(samples, min_samples=5)
    if not non_empty:
        assert out == {}
        return
    assert out["sample_count"] == len(non_empty)
    assert out["partial"] == (len(non_empty) < 5)
    # A partial run (<5) still produces a non-empty aggregate over what it has.
    if len(non_empty) < 5:
        assert out["partial"] is True
        assert out["sample_count"] == len(non_empty)
        # At least one aggregated metric key beyond the bookkeeping fields.
        metric_keys = set(out) - {"sample_count", "partial", "metrics_source"}
        assert metric_keys, "partial aggregate must still carry metric values"


# Feature: v18-w3-02-bl108, Property 5: Aggregated values stay within the sampled range
@settings(max_examples=150)
@given(samples=_sample_list())
def test_property_5_avg_within_range(samples):
    out = phase2_poller.aggregate(samples)
    for avg_key in _AVG_KEYS:
        vals = _present_values(samples, avg_key)
        if vals:
            lo, hi = min(vals), max(vals)
            assert lo - 1e-9 <= out[avg_key] <= hi + 1e-9
    # avg <= corresponding max for the derived/explicit gauge pairs.
    for avg_key, max_key in phase2_poller._DERIVE_MAX_FROM_AVG.items():
        if avg_key in out and max_key in out:
            assert out[avg_key] <= out[max_key] + 1e-9


# Feature: v18-w3-02-bl108, Property 1: Poller spawned iff a metrics endpoint is declared
@settings(max_examples=150)
@given(
    has_endpoint=st.booleans(),
    opted_in=st.booleans(),
    endpoint=st.dictionaries(
        keys=st.sampled_from(["path", "port", "format"]),
        values=st.one_of(st.text(min_size=1, max_size=10), st.integers(1, 65535)),
        min_size=1,
        max_size=3,
    ),
)
def test_property_1_spawn_iff_endpoint(has_endpoint, opted_in, endpoint):
    me = endpoint if has_endpoint else None
    result = phase2_poller.should_spawn(me, opted_in=opted_in)
    expected = opted_in and has_endpoint and bool(endpoint)
    assert result == expected
    # Absent endpoint never spawns and never raises.
    if not has_endpoint:
        assert result is False
