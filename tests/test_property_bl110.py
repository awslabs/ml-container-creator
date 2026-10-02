"""Property-based tests for BL110: MLflow-backed do/register dataset.

**Validates: Requirements 1.1, 2.1, 3.1, 4.1, 6.2, 6.3, 6.4, 6.5**

One Hypothesis test per Correctness Property (Properties 1-6) from the design.
The MLflow client / module is stubbed via a fake active run and injected client
so runs stay cheap and deterministic; the S3 sidecar key-shape properties are
pure assertions.
"""
import os
import sys
from contextlib import contextmanager, ExitStack
from unittest import mock
from unittest.mock import MagicMock

from hypothesis import given, settings
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

import mlcc_mlflow  # noqa: E402
from mlcc_mlflow import sanitize_name, log_dataset  # noqa: E402
import register_common  # noqa: E402


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

st_name = st.text(max_size=48)
st_source = st.text(max_size=48)
st_context = st.text(max_size=16)
st_digest = st.text(alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")), min_size=1, max_size=16)
# Dataset names for sidecar-key shape: no slashes (single path segment), no
# empty (a key needs a name); mirrors how a registered name maps to a key.
st_key_name = st.text(alphabet=st.characters(blacklist_characters="/"), min_size=1, max_size=32)
st_bucket = st.text(alphabet=st.characters(whitelist_categories=("Ll", "Nd"), whitelist_characters="-"), min_size=1, max_size=32)


@contextmanager
def _all(patches):
    """Enter a list of context managers together (ExitStack helper)."""
    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        yield


# ---------------------------------------------------------------------------
# Fake MLflow for log_dataset (mirrors the Wave 1 test double, with source meta)
# ---------------------------------------------------------------------------

class _FakeSource:
    def __init__(self, uri, meta):
        self._d = {"uri": uri}
        if meta:
            self._d["meta"] = meta

    def to_dict(self):
        return dict(self._d)


class _FakeDataset:
    def __init__(self, source, name, digest):
        self.source = source
        self.name = name
        self.digest = digest


class _FakeDatasetInput:
    def __init__(self, dataset):
        self.dataset = dataset


class _FakeInputs:
    def __init__(self, dataset_inputs):
        self.dataset_inputs = dataset_inputs


class _FakeRun:
    def __init__(self):
        self.info = MagicMock()
        self.info.run_id = "run-1"
        self.inputs = _FakeInputs([])


@contextmanager
def _fake_mlflow(run):
    """Install a fake mlflow + MetaDataset + DatasetSource so log_dataset runs
    offline against the given fake run, and expose an injected client that reads
    the run's inputs back for the idempotence/resolution checks."""
    logged = run.inputs.dataset_inputs

    class _FakeMetaDataset:
        def __init__(self, source, name, digest, schema=None):
            self.source = source
            self.name = name
            self.digest = digest

    def _log_input(dataset, context=None, tags=None, model=None):
        logged.append(_FakeDatasetInput(
            _FakeDataset(dataset.source, dataset.name, dataset.digest)))

    fake_mlflow = MagicMock()
    fake_mlflow.active_run.return_value = run
    fake_mlflow.log_input.side_effect = _log_input

    fake_meta_module = MagicMock()
    fake_meta_module.MetaDataset = _FakeMetaDataset

    class _FakeDatasetSource:
        pass

    fake_source_module = MagicMock()
    fake_source_module.DatasetSource = _FakeDatasetSource

    # _make_uri_source subclasses DatasetSource; with the stub base its to_dict
    # produces the {"uri","meta"} dict the read helpers expect.
    patched = {
        "mlflow": fake_mlflow,
        "mlflow.data": MagicMock(),
        "mlflow.data.meta_dataset": fake_meta_module,
        "mlflow.data.dataset_source": fake_source_module,
    }
    with mock.patch.dict(sys.modules, patched):
        client = MagicMock()
        client.get_run.return_value = run

        class _FakePage(list):
            def __init__(self, items, token=None):
                super().__init__(items)
                self.token = token

        _runs_holder = [run]
        client.search_runs.side_effect = lambda **k: _FakePage(list(_runs_holder), token=None)
        yield client


# ---------------------------------------------------------------------------
# Property 1: log_dataset logs a MetaDataset with name, digest, and source
# ---------------------------------------------------------------------------

# Feature: v18-w2-03-bl110, Property 1: log_dataset logs a MetaDataset with name, digest, and source
@given(source=st_source, name=st_name, context=st_context, digest=st_digest)
@settings(max_examples=100)
def test_property_1_log_dataset_records_meta_dataset(source, name, context, digest):
    run = _FakeRun()
    with _fake_mlflow(run):
        log_dataset(source, name, context, meta={"digest": digest})

    inputs = run.inputs.dataset_inputs
    assert len(inputs) == 1
    ds = inputs[0].dataset
    assert ds.name == sanitize_name(name)
    assert ds.digest == digest
    assert ds.source.to_dict()["uri"] == ("" if source is None else str(source))


# ---------------------------------------------------------------------------
# Property 2: log_dataset applies sanitize_name to the recorded name
# ---------------------------------------------------------------------------

# Feature: v18-w2-03-bl110, Property 2: log_dataset applies sanitize_name to the recorded name
@given(source=st_source, name=st_name, context=st_context)
@settings(max_examples=100)
def test_property_2_log_dataset_sanitizes_name(source, name, context):
    run = _FakeRun()
    with _fake_mlflow(run):
        recorded_name, _digest = log_dataset(source, name, context)

    assert recorded_name == sanitize_name(name)
    assert "/" not in recorded_name
    assert " " not in recorded_name
    assert run.inputs.dataset_inputs[0].dataset.name == sanitize_name(name)


# ---------------------------------------------------------------------------
# Property 3: log_dataset is idempotent by (name, digest)
# ---------------------------------------------------------------------------

# Feature: v18-w2-03-bl110, Property 3: log_dataset is idempotent by (name, digest)
@given(source=st_source, name=st_name, context=st_context, digest=st_digest)
@settings(max_examples=100)
def test_property_3_log_dataset_idempotent(source, name, context, digest):
    run = _FakeRun()
    with _fake_mlflow(run) as client:
        log_dataset(source, name, context, meta={"digest": digest}, client=client)
        after_first = list(run.inputs.dataset_inputs)
        log_dataset(source, name, context, meta={"digest": digest}, client=client)
        after_second = list(run.inputs.dataset_inputs)

    assert len(after_second) == len(after_first) == 1


# ---------------------------------------------------------------------------
# Property 4: log_dataset returns a locating handle that resolves by name
# ---------------------------------------------------------------------------

# Feature: v18-w2-03-bl110, Property 4: log_dataset returns a locating handle that resolves by name
@given(source=st_source, name=st_name, context=st_context, digest=st_digest)
@settings(max_examples=100)
def test_property_4_handle_resolves_by_name(source, name, context, digest):
    run = _FakeRun()
    with _fake_mlflow(run) as client:
        recorded_name, recorded_digest = log_dataset(
            source, name, context, meta={"digest": digest}, client=client)
        # The handle exposes sanitize_name(name) + digest ...
        assert recorded_name == sanitize_name(name)
        assert recorded_digest == digest
        # ... and a name resolution against the same store returns the source.
        resolved = mlcc_mlflow.resolve_dataset_by_name(name, client=client)

    assert resolved is not None
    assert resolved["name"] == sanitize_name(name)
    assert resolved["s3_uri"] == ("" if source is None else str(source))


# ---------------------------------------------------------------------------
# Property 5: MLflow is consulted iff configured, sidecar otherwise
# ---------------------------------------------------------------------------

# Feature: v18-w2-03-bl110, Property 5: MLflow is consulted iff configured, sidecar otherwise
@given(configured=st.booleans(), flow=st.sampled_from(["list", "resolve"]))
@settings(max_examples=100)
def test_property_5_branch_selects_mlflow_iff_configured(configured, flow):
    import types
    import register_list
    import register_resolve
    import dataset_store

    mlflow_called = {"v": False}
    sidecar_called = {"v": False}

    def _args(**kw):
        return types.SimpleNamespace(**kw)

    class _Exit(Exception):
        pass

    def _stop(*a, **k):
        raise _Exit()

    with mock.patch.object(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: configured):
        if flow == "list":
            patches = [
                mock.patch.object(register_list, "_output", _stop),
                mock.patch.object(register_list, "_error_exit", _stop),
                mock.patch.object(mlcc_mlflow, "list_dataset_inputs",
                                  lambda **k: mlflow_called.__setitem__("v", True) or []),
                mock.patch.object(dataset_store, "_get_s3_client", lambda region=None: MagicMock()),
                mock.patch.object(dataset_store, "list_sidecars",
                                  lambda *a, **k: sidecar_called.__setitem__("v", True) or []),
                mock.patch.object(register_list, "_resolve_core_bucket", lambda args: "core-bucket"),
            ]
            with _all(patches):
                try:
                    register_list.cmd_list_datasets(_args(source="local", region=None))
                except _Exit:
                    pass
        else:
            patches = [
                mock.patch.object(register_resolve, "_output", _stop),
                mock.patch.object(register_resolve, "_error_exit", _stop),
                mock.patch.object(mlcc_mlflow, "resolve_dataset_by_name",
                                  lambda name, **k: mlflow_called.__setitem__("v", True) or {
                                      "name": name, "digest": "d", "s3_uri": "s3://a/b", "meta": {}}),
                mock.patch.object(dataset_store, "_get_s3_client", lambda region=None: MagicMock()),
                mock.patch.object(dataset_store, "read_sidecar",
                                  lambda *a, **k: sidecar_called.__setitem__("v", True) or {
                                      "name": "n", "versions": [{"version": "1.0.0", "s3_uri": "s3://a/b"}]}),
                mock.patch.object(register_resolve, "_resolve_core_bucket", lambda args: "core-bucket"),
            ]
            with _all(patches):
                try:
                    register_resolve.cmd_resolve_dataset(_args(name="n", version=None, region=None))
                except _Exit:
                    pass

    if configured:
        assert mlflow_called["v"] and not sidecar_called["v"]
    else:
        assert sidecar_called["v"] and not mlflow_called["v"]


# ---------------------------------------------------------------------------
# Property 6: the S3 sidecar layout is unchanged
# ---------------------------------------------------------------------------

# Feature: v18-w2-03-bl110, Property 6: the S3 sidecar layout is unchanged
@given(name=st_key_name, core_bucket=st_bucket)
@settings(max_examples=100)
def test_property_6_sidecar_key_layout_unchanged(name, core_bucket):
    assert register_common._sidecar_key(name) == f"datasets/{name}/_dataset.json"
    assert register_common._sidecar_uri(core_bucket, name) == \
        f"s3://{core_bucket}/datasets/{name}/_dataset.json"
