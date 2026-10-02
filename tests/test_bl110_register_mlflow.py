"""Unit / example / integration tests for BL110: MLflow-backed do/register dataset.

**Validates: Requirements 1.1, 2.1, 3.1, 3.2, 4.1, 5.1, 6.1, 6.6**

Covers the configured/not branch wiring across the three dataset flows (register,
--list, resolve), the log_dataset delegation and signature/location contract, the
MLflow read paths (list run inputs, resolve-by-name), and the S3 sidecar fallback.
MLflow is exercised through an injected fake client / patched module so no real
server or S3 is contacted.
"""
import os
import sys
import types
from unittest import mock
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Path setup — import helpers from templates/do/lib/python
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

import mlcc_mlflow  # noqa: E402
import register_dataset  # noqa: E402
import register_list  # noqa: E402
import register_resolve  # noqa: E402
from mlcc_mlflow import sanitize_name  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _args(**kw):
    """Build a simple attribute-bag args object."""
    return types.SimpleNamespace(**kw)


class _Exit(Exception):
    """Stand-in for sys.exit so we can capture terminal output in tests."""

    def __init__(self, code=0):
        self.code = code


def _capture_output(monkeypatch):
    """Patch common._output/_error_exit (as imported into each module) to capture.

    Returns a dict that will hold {'output': ...} or {'error': ..., 'code': ...}.
    """
    captured = {}

    def fake_output(data):
        captured["output"] = data
        raise _Exit(0)

    def fake_error(message, code=None, exit_code=1):
        captured["error"] = message
        captured["code"] = code
        raise _Exit(exit_code)

    for mod in (register_dataset, register_list, register_resolve):
        if hasattr(mod, "_output"):
            monkeypatch.setattr(mod, "_output", fake_output)
        if hasattr(mod, "_error_exit"):
            monkeypatch.setattr(mod, "_error_exit", fake_error)
    return captured


# ---------------------------------------------------------------------------
# Signature / location (Req 6.1, 6.6) — example + smoke
# ---------------------------------------------------------------------------

class TestLogDatasetContract:
    """**Validates: Requirements 6.1, 6.6**"""

    def test_import_from_mlcc_mlflow(self):
        from mlcc_mlflow import log_dataset  # noqa: F401
        assert callable(log_dataset)

    def test_signature_source_name_context_meta(self):
        import inspect
        sig = inspect.signature(mlcc_mlflow.log_dataset)
        params = list(sig.parameters)
        # Req 6.1: (source, name, context, meta) — client is the injectable seam.
        assert params[:4] == ["source", "name", "context", "meta"]

    def test_resides_in_mlcc_mlflow_module(self):
        assert mlcc_mlflow.log_dataset.__module__ == "mlcc_mlflow"


# ---------------------------------------------------------------------------
# log_dataset delegation (Req 5.1) — spy
# ---------------------------------------------------------------------------

class TestRegisterDelegatesToLogDataset:
    """**Validates: Requirements 5.1, 1.1**"""

    def test_register_calls_log_dataset_once_with_expected_args(self, monkeypatch):
        spy = MagicMock(return_value=("my--set", "hash123"))
        monkeypatch.setattr(mlcc_mlflow, "log_dataset", spy)
        # Make MLflow "configured" and provide a stub active run so the helper
        # takes the log_dataset path without a real server.
        monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: True)
        fake_mlflow = MagicMock()
        fake_mlflow.active_run.return_value = MagicMock()  # active run exists
        monkeypatch.setitem(sys.modules, "mlflow", fake_mlflow)

        handle = register_dataset._log_dataset_to_mlflow(
            s3_uri="s3://core/datasets/my/set.jsonl",
            name="my/set",
            content_hash="hash123",
            row_count=10,
            data_format="jsonl",
            technique="sft",
        )

        assert handle == ("my--set", "hash123")
        spy.assert_called_once()
        _, kwargs = spy.call_args
        assert kwargs["source"] == "s3://core/datasets/my/set.jsonl"
        assert kwargs["name"] == "my/set"
        assert isinstance(kwargs["context"], str) and kwargs["context"]
        assert kwargs["meta"]["digest"] == "hash123"
        assert kwargs["meta"]["row_count"] == 10

    def test_mlflow_failure_is_non_fatal(self, monkeypatch):
        # log_dataset raising must NOT propagate — sidecar is the durable record.
        monkeypatch.setattr(
            mlcc_mlflow, "log_dataset",
            MagicMock(side_effect=RuntimeError("boom")),
        )
        fake_mlflow = MagicMock()
        fake_mlflow.active_run.return_value = MagicMock()
        monkeypatch.setitem(sys.modules, "mlflow", fake_mlflow)

        handle = register_dataset._log_dataset_to_mlflow(
            s3_uri="s3://x/y", name="n", content_hash="h",
            row_count=None, data_format="jsonl", technique="sft",
        )
        assert handle is None


# ---------------------------------------------------------------------------
# --list branch (Req 2.1) — configured reads MLflow run inputs
# ---------------------------------------------------------------------------

class TestListBranch:
    """**Validates: Requirements 2.1, 4.1**"""

    def test_list_reads_mlflow_when_configured(self, monkeypatch):
        monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: True)
        monkeypatch.setattr(
            mlcc_mlflow, "list_dataset_inputs",
            lambda **k: [{
                "name": "my--set", "digest": "h1",
                "s3_uri": "s3://core/datasets/my-set/train.jsonl",
                "meta": {"row_count": 5, "format": "jsonl", "technique": "sft"},
            }],
        )
        # If the sidecar path were taken, this would explode — assert it is NOT.
        import dataset_store
        monkeypatch.setattr(
            dataset_store, "list_sidecars",
            MagicMock(side_effect=AssertionError("sidecar must not be read when configured")),
        )

        captured = _capture_output(monkeypatch)
        with pytest.raises(_Exit):
            register_list.cmd_list_datasets(_args(source="local", region=None))

        entries = captured["output"]["local"]
        assert len(entries) == 1
        assert entries[0]["name"] == "my--set"
        assert entries[0]["s3_uri"] == "s3://core/datasets/my-set/train.jsonl"
        assert entries[0]["technique"] == "sft"
        assert entries[0]["origin"] == "local"

    def test_list_reads_sidecar_when_not_configured(self, monkeypatch):
        monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: False)
        monkeypatch.setattr(mlcc_mlflow, "list_dataset_inputs",
                            MagicMock(side_effect=AssertionError("MLflow must not be read when not configured")))
        import dataset_store
        monkeypatch.setattr(dataset_store, "_get_s3_client", lambda region=None: MagicMock())
        monkeypatch.setattr(dataset_store, "list_sidecars", lambda s3, bucket: [
            {"name": "sc-set", "versions": [
                {"version": "1.0.0", "s3_uri": "s3://core/datasets/sc-set/d.jsonl",
                 "format": "jsonl", "technique": "dpo", "rowCount": 3}]},
        ])
        monkeypatch.setattr(register_list, "_resolve_core_bucket", lambda args: "core-bucket")

        captured = _capture_output(monkeypatch)
        with pytest.raises(_Exit):
            register_list.cmd_list_datasets(_args(source="local", region=None))

        entries = captured["output"]["local"]
        assert len(entries) == 1
        assert entries[0]["name"] == "sc-set"
        assert entries[0]["technique"] == "dpo"


# ---------------------------------------------------------------------------
# resolve branch (Req 3.1, 3.2) — configured queries MLflow by name
# ---------------------------------------------------------------------------

class TestResolveBranch:
    """**Validates: Requirements 3.1, 3.2, 4.1**"""

    def test_resolve_by_name_from_mlflow_when_configured(self, monkeypatch):
        monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: True)
        monkeypatch.setattr(mlcc_mlflow, "resolve_dataset_by_name", lambda name, **k: {
            "name": sanitize_name(name), "digest": "h9",
            "s3_uri": "s3://core/datasets/x/train.jsonl",
            "meta": {"format": "jsonl", "technique": "sft", "arn": "arn:aws:x"},
        })
        import dataset_store
        monkeypatch.setattr(dataset_store, "read_sidecar",
                            MagicMock(side_effect=AssertionError("sidecar must not be read when configured")))

        captured = _capture_output(monkeypatch)
        with pytest.raises(_Exit):
            register_resolve.cmd_resolve_dataset(_args(name="X", version=None, region=None))

        out = captured["output"]
        assert out["s3_uri"] == "s3://core/datasets/x/train.jsonl"
        assert out["arn"] == "arn:aws:x"
        assert out["hash"] == "h9"
        assert out["technique"] == "sft"

    def test_resolve_not_found_in_mlflow_returns_dataset_not_found(self, monkeypatch):
        monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: True)
        monkeypatch.setattr(mlcc_mlflow, "resolve_dataset_by_name", lambda name, **k: None)

        captured = _capture_output(monkeypatch)
        with pytest.raises(_Exit):
            register_resolve.cmd_resolve_dataset(_args(name="ghost", version=None, region=None))

        assert captured["code"] == "DATASET_NOT_FOUND"

    def test_resolve_reads_sidecar_when_not_configured(self, monkeypatch):
        monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: False)
        monkeypatch.setattr(mlcc_mlflow, "resolve_dataset_by_name",
                            MagicMock(side_effect=AssertionError("MLflow must not be read when not configured")))
        import dataset_store
        monkeypatch.setattr(dataset_store, "_get_s3_client", lambda region=None: MagicMock())
        monkeypatch.setattr(dataset_store, "read_sidecar", lambda s3, bucket, name: {
            "name": name, "versions": [
                {"version": "1.0.0", "s3_uri": "s3://core/datasets/sc/d.jsonl",
                 "format": "jsonl", "technique": "sft", "hash": "sh"}],
        })
        monkeypatch.setattr(register_resolve, "_resolve_core_bucket", lambda args: "core-bucket")

        captured = _capture_output(monkeypatch)
        with pytest.raises(_Exit):
            register_resolve.cmd_resolve_dataset(_args(name="sc", version=None, region=None))

        out = captured["output"]
        assert out["s3_uri"] == "s3://core/datasets/sc/d.jsonl"
        assert out["hash"] == "sh"

    def test_resolve_sidecar_missing_is_dataset_not_found(self, monkeypatch):
        monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: False)
        import dataset_store
        monkeypatch.setattr(dataset_store, "_get_s3_client", lambda region=None: MagicMock())
        monkeypatch.setattr(dataset_store, "read_sidecar", lambda s3, bucket, name: None)
        monkeypatch.setattr(register_resolve, "_resolve_core_bucket", lambda args: "core-bucket")

        captured = _capture_output(monkeypatch)
        with pytest.raises(_Exit):
            register_resolve.cmd_resolve_dataset(_args(name="missing", version=None, region=None))

        assert captured["code"] == "DATASET_NOT_FOUND"


# ---------------------------------------------------------------------------
# MLflow read helpers against an injected fake client (Req 1.1, 2.1, 3.1)
# ---------------------------------------------------------------------------

class _FakeSource:
    def __init__(self, uri, meta):
        self._d = {"uri": uri}
        if meta:
            self._d["meta"] = meta

    def to_dict(self):
        return dict(self._d)


class _FakeDataset:
    def __init__(self, name, digest, uri, meta=None):
        self.name = name
        self.digest = digest
        self.source = _FakeSource(uri, meta or {})


class _FakeDatasetInput:
    def __init__(self, dataset):
        self.dataset = dataset


class _FakeInputs:
    def __init__(self, dataset_inputs):
        self.dataset_inputs = dataset_inputs


class _FakeRun:
    def __init__(self, dataset_inputs):
        self.inputs = _FakeInputs(dataset_inputs)


class _FakePage(list):
    def __init__(self, items, token=None):
        super().__init__(items)
        self.token = token


class TestMlflowReadHelpers:
    """**Validates: Requirements 1.1, 2.1, 3.1**"""

    def _client_with_runs(self, runs):
        client = MagicMock()
        client.search_runs.return_value = _FakePage(runs, token=None)
        return client

    def test_list_dataset_inputs_projects_run_inputs(self):
        run = _FakeRun([
            _FakeDatasetInput(_FakeDataset(
                "org--set", "d1", "s3://core/datasets/set/t.jsonl",
                {"row_count": 7, "format": "jsonl", "technique": "sft"})),
        ])
        client = self._client_with_runs([run])

        out = mlcc_mlflow.list_dataset_inputs(client=client)

        assert len(out) == 1
        assert out[0]["name"] == "org--set"
        assert out[0]["s3_uri"] == "s3://core/datasets/set/t.jsonl"
        assert out[0]["meta"]["technique"] == "sft"

    def test_list_dedupes_by_name_digest(self):
        di = _FakeDatasetInput(_FakeDataset("n", "d", "s3://a/b"))
        runs = [_FakeRun([di]), _FakeRun([_FakeDatasetInput(_FakeDataset("n", "d", "s3://a/b"))])]
        client = self._client_with_runs(runs)

        out = mlcc_mlflow.list_dataset_inputs(client=client)
        assert len(out) == 1

    def test_resolve_by_name_matches_sanitized(self):
        run = _FakeRun([
            _FakeDatasetInput(_FakeDataset("org--My-Set", "d5", "s3://a/b", {"technique": "sft"})),
        ])
        client = self._client_with_runs([run])

        # Raw name resolves to the sanitized recorded name.
        entry = mlcc_mlflow.resolve_dataset_by_name("org/My-Set", client=client)
        assert entry is not None
        assert entry["s3_uri"] == "s3://a/b"

    def test_resolve_by_name_none_when_absent(self):
        client = self._client_with_runs([_FakeRun([])])
        assert mlcc_mlflow.resolve_dataset_by_name("nope", client=client) is None
