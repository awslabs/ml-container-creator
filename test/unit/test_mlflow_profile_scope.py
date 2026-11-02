# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Guard tests for the MLflow shared-catalog correctness contract.

The MLflow store is profile-shared (one serverless App per bootstrap profile).
These tests pin the invariants that keep that store correct and prevent a
regression to a local/per-project tracking store or an experiment-"0"-only
write:

1. No code path emits a local-file tracking URI (sqlite:// / mlflow.db /
   ./mlruns / file://) — MLflow's silent CWD default must never be relied on.
2. Write paths target a PER-PROJECT experiment (sanitized project name), not the
   literal "Default".
3. Read scope resolves to the active project's experiment id + "0" (read-both)
   by default, and to every experiment when all_projects=True.
4. The tune path receives its tracking ref from the profile: do/lib/profile.sh
   maps mlflowAppArn -> MLFLOW_APP_ARN.

The behavioral assertions use fake MLflow client objects (no network, no
./mlruns written); the write-path and profile.sh assertions are source-level so
they do not require a configured MLflow server.
"""

from __future__ import annotations

import os
import re
import sys

import pytest

_LIB = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python")
)
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import mlcc_mlflow  # noqa: E402

_TEMPLATES_DO = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do")
)


# ── Fake MLflow client ──────────────────────────────────────────────────────


class _FakeExperiment:
    def __init__(self, experiment_id, name):
        self.experiment_id = experiment_id
        self.name = name


class _FakeClient:
    """Minimal client exposing the surface _resolve_experiment_ids uses."""

    def __init__(self, experiments):
        # experiments: list of (experiment_id, name)
        self._by_name = {name: _FakeExperiment(eid, name) for eid, name in experiments}
        self._all = [_FakeExperiment(eid, name) for eid, name in experiments]

    def get_experiment_by_name(self, name):
        return self._by_name.get(name)

    def search_experiments(self):
        return list(self._all)


# ── 2. Per-project experiment name (write-side derivation) ───────────────────


def test_project_experiment_name_sanitizes_explicit_name():
    # Explicit project name wins and is sanitized (slashes/spaces removed).
    assert mlcc_mlflow._project_experiment_name("my/proj name") == "my--projname"


def test_project_experiment_name_falls_back_to_env(monkeypatch):
    monkeypatch.setenv("PROJECT_NAME", "env-project")
    assert mlcc_mlflow._project_experiment_name() == "env-project"


def test_project_experiment_name_defaults_when_nameless(monkeypatch):
    monkeypatch.delenv("PROJECT_NAME", raising=False)
    # Nameless context preserves today's behavior (the Default experiment).
    assert mlcc_mlflow._project_experiment_name("") == "Default"


# ── 3. Read-scope resolution (active + "0" read-both; --all) ─────────────────


def test_resolve_experiment_ids_reads_active_project_and_zero():
    client = _FakeClient([("0", "Default"), ("7", "my-project")])
    ids = mlcc_mlflow._resolve_experiment_ids(client=client, project_name="my-project")
    # Read-both: the active project's id PLUS the legacy "0" experiment.
    assert ids == ["7", "0"]


def test_resolve_experiment_ids_missing_experiment_falls_back_to_zero():
    # Project experiment not created yet → just ["0"], never an error.
    client = _FakeClient([("0", "Default")])
    ids = mlcc_mlflow._resolve_experiment_ids(client=client, project_name="not-created-yet")
    assert ids == ["0"]


def test_resolve_experiment_ids_nameless_is_zero_only(monkeypatch):
    monkeypatch.delenv("PROJECT_NAME", raising=False)
    client = _FakeClient([("0", "Default"), ("7", "my-project")])
    ids = mlcc_mlflow._resolve_experiment_ids(client=client, project_name="")
    assert ids == ["0"]


def test_resolve_experiment_ids_all_projects_returns_every_id():
    client = _FakeClient([("0", "Default"), ("7", "a"), ("8", "b")])
    ids = mlcc_mlflow._resolve_experiment_ids(client=client, all_projects=True)
    assert set(ids) == {"0", "7", "8"}


def test_resolve_experiment_ids_no_client_degrades_to_zero():
    # No client and mlflow absent/unconfigured → the safe pre-BL163 default.
    ids = mlcc_mlflow._resolve_experiment_ids(client=None, project_name="whatever")
    assert ids == ["0"]


# ── resolve_dataset_by_name: newest registration wins ────────────────────────
#
# Re-registering a dataset whose CONTENT changed (the BL179 `.json` →
# `.from_array.jsonl` fix) logs a NEW (name, digest) input WITHOUT overwriting the
# old one, so MLflow holds several inputs for one name. list_dataset_inputs returns
# them newest-first; resolve_dataset_by_name must keep the FIRST match. Taking the
# last resolved the STALE URI and do/tune then failed with "S3 training dataset path
# does not exist". This pins the newest-wins contract.


class _FakeDataset:
    def __init__(self, name, digest, uri):
        self.name = name
        self.digest = digest
        # _source_uri_and_meta reads source.to_dict() → {"uri", "meta"}.
        self.source = {"uri": uri, "meta": {"s3_uri": uri, "format": "jsonl"}}


class _FakeDatasetInput:
    def __init__(self, dataset):
        self.dataset = dataset


class _FakeRunInputs:
    def __init__(self, dataset_inputs):
        self.dataset_inputs = dataset_inputs


class _FakeRunInfo:
    def __init__(self, run_id):
        self.run_id = run_id


class _FakeRun:
    def __init__(self, run_id, dataset):
        self.info = _FakeRunInfo(run_id)
        self.inputs = _FakeRunInputs([_FakeDatasetInput(dataset)])


class _FakeRunsClient:
    """Returns runs in the ALREADY newest-first order (as the real path sorts)."""

    def __init__(self, runs):
        self._runs = runs

    def search_runs(self, experiment_ids=None, page_token=None):
        return list(self._runs)  # single page, no token


def test_resolve_dataset_by_name_returns_newest_registration():
    name = "openllm-sft-alpaca"
    new_uri = "s3://b/datasets/openllm-sft-alpaca/ro_sft_alpaca.from_array.jsonl"
    old_uri = "s3://b/datasets/openllm-sft-alpaca/ro_sft_alpaca.json"
    # Newest-first: the fixed .jsonl registration precedes the stale .json one.
    client = _FakeRunsClient([
        _FakeRun("r-new", _FakeDataset(name, "digest-new", new_uri)),
        _FakeRun("r-old", _FakeDataset(name, "digest-old", old_uri)),
    ])
    entry = mlcc_mlflow.resolve_dataset_by_name(
        name, client=client, experiment_ids=["0"],
    )
    assert entry is not None
    # The NEWEST URI wins — not the stale .json that 404s the trainer.
    assert entry["s3_uri"] == new_uri
    assert entry["digest"] == "digest-new"


# ── 1. No local-file tracking anywhere in the runtime python ─────────────────

# A LOCAL tracking TARGET is the harm (it bypasses the shared serverless store).
# The harm is a local *URI value*, not any particular API call: ``set_tracking_uri``
# is the ONLY way to point the client AT the serverless App, so it is permitted —
# what is banned is setting tracking to a LOCAL store (sqlite / file / mlruns).
_LOCAL_TRACKING_PATTERNS = [
    re.compile(r"sqlite://"),
    re.compile(r"\./mlruns"),
    re.compile(r"\bfile://"),
    re.compile(r"""set_tracking_uri\(\s*['"][^'"]*(?:sqlite:|file:|mlruns|\.db)"""),
]


def _runtime_python_files():
    for root, _dirs, files in os.walk(os.path.join(_TEMPLATES_DO, "lib", "python")):
        for f in files:
            if f.endswith(".py"):
                yield os.path.join(root, f)


def _strip_comments(text):
    """Drop ``#`` comment tails and docstring-only mentions so a literal like
    ``mlflow.db`` in an explanatory comment is not mistaken for a local target.
    Keeps code lines intact (best-effort: splits on the first unquoted ``#``)."""
    out = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        # Drop an inline comment tail (approximate; runtime files use plain # tails).
        if "#" in line:
            line = line.split("#", 1)[0]
        out.append(line)
    return "\n".join(out)


def test_no_local_file_tracking_uri_in_runtime_python():
    offenders = []
    for path in _runtime_python_files():
        with open(path, encoding="utf-8") as fh:
            code = _strip_comments(fh.read())
        for pat in _LOCAL_TRACKING_PATTERNS:
            if pat.search(code):
                offenders.append((os.path.basename(path), pat.pattern))
    assert offenders == [], (
        "local-file MLflow tracking introduced (the shared serverless store must "
        f"not be bypassed): {offenders}"
    )


# ── 2. Write paths use the per-project experiment, not "Default" ─────────────


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def test_register_dataset_sets_per_project_experiment():
    text = _read(os.path.join(_TEMPLATES_DO, "lib", "python", "register_dataset.py"))
    assert "_project_experiment_name(" in text
    # The hardcoded Default-experiment write is gone.
    assert 'set_experiment("Default")' not in text


def test_register_model_sets_per_project_experiment():
    text = _read(os.path.join(_TEMPLATES_DO, "lib", "python", "register_model.py"))
    assert "_project_experiment_name(" in text
    assert 'set_experiment("Default")' not in text


# ── 4. Tune path ref comes from the profile (profile.sh mapping) ─────────────


def test_profile_sh_maps_mlflow_app_arn_from_profile():
    text = _read(os.path.join(_TEMPLATES_DO, "lib", "profile.sh"))
    # profile.sh maps the profile key mlflowAppArn to the env var tune_submit.py
    # consumes, and exports it so the Python process sees it.
    assert "_PROFILE_mlflowAppArn" in text
    assert "MLFLOW_APP_ARN" in text
    assert re.search(r"export\s+MLFLOW_APP_ARN", text), (
        "profile.sh must export MLFLOW_APP_ARN so tune_submit.py reads it from os.environ"
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


# ── BL166: ensure_project_experiment + mlflow_env_for_job (job-env parity) ────


def test_mlflow_env_for_job_empty_when_unconfigured(monkeypatch, tmp_path):
    """Unconfigured profile → empty env dict (the job submits as today, no MLflow)."""
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("MLFLOW_TRACKING_SERVER_ARN", raising=False)
    # Point config resolution at a nonexistent file so nothing resolves.
    env = mlcc_mlflow.mlflow_env_for_job("myproj", config_path=str(tmp_path / "nope.json"))
    assert env == {}


def test_mlflow_env_for_job_arn_ref_and_experiment(monkeypatch):
    """An ARN tracking ref in the env → MLFLOW_TRACKING_SERVER_ARN + experiment name."""
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.setenv("MLFLOW_TRACKING_SERVER_ARN", "arn:aws:sagemaker:us-west-2:1:mlflow-app/app-X")
    monkeypatch.setenv("PROJECT_NAME", "my/proj")
    env = mlcc_mlflow.mlflow_env_for_job()
    assert env["MLFLOW_TRACKING_SERVER_ARN"] == "arn:aws:sagemaker:us-west-2:1:mlflow-app/app-X"
    # Experiment name is the sanitized project name (slashes → --), BL163 single source.
    assert env["MLFLOW_EXPERIMENT_NAME"] == "my--proj"


def test_mlflow_env_for_job_https_ref_uses_tracking_uri(monkeypatch):
    """An HTTPS tracking ref → MLFLOW_TRACKING_URI (the non-ARN branch)."""
    monkeypatch.delenv("MLFLOW_TRACKING_SERVER_ARN", raising=False)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "https://mlflow.example.com")
    monkeypatch.setenv("PROJECT_NAME", "proj")
    env = mlcc_mlflow.mlflow_env_for_job()
    assert env["MLFLOW_TRACKING_URI"] == "https://mlflow.example.com"
    assert env["MLFLOW_EXPERIMENT_NAME"] == "proj"


def test_ensure_project_experiment_noop_when_unconfigured(monkeypatch):
    """Unconfigured → returns None, never creates a local ./mlruns."""
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("MLFLOW_TRACKING_SERVER_ARN", raising=False)
    monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: False)
    assert mlcc_mlflow.ensure_project_experiment("myproj") is None


def test_ensure_project_experiment_resolves_existing(monkeypatch):
    """When the project experiment already exists, resolve it (idempotent) — no re-create."""
    monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: True)

    class _FakeMlflow:
        class _Exp:
            experiment_id = "7"
        def get_experiment_by_name(self, name):
            assert name == "myproj"
            return self._Exp()
        def create_experiment(self, name):  # pragma: no cover - must NOT be called
            raise AssertionError("create_experiment called though the experiment exists")

    monkeypatch.setitem(sys.modules, "mlflow", _FakeMlflow())
    assert mlcc_mlflow.ensure_project_experiment("myproj") == "7"


def test_ensure_project_experiment_creates_when_absent(monkeypatch):
    """When the project experiment does not exist, create it and return the new id."""
    monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: True)

    class _FakeMlflow:
        def get_experiment_by_name(self, name):
            return None
        def create_experiment(self, name):
            assert name == "newproj"
            return "42"

    monkeypatch.setitem(sys.modules, "mlflow", _FakeMlflow())
    assert mlcc_mlflow.ensure_project_experiment("newproj") == "42"


def test_ensure_project_experiment_nameless_is_noop(monkeypatch):
    """A nameless context (no project) → None (the shared Default/0 needs no create)."""
    monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: True)
    monkeypatch.delenv("PROJECT_NAME", raising=False)
    assert mlcc_mlflow.ensure_project_experiment("") is None


# ── _mlflow_configured must ROUTE the active client, not just set env ────────
# Regression for the BL164 live bug: setting MLFLOW_TRACKING_SERVER_ARN in the
# environment does NOT move mlflow's already-resolved (local sqlite) client, so
# register_via_bridge wrote to a LOCAL registry and the bridge never fired
# ("MPG registration returned incomplete data"). _mlflow_configured must call
# mlflow.set_tracking_uri(uri) so the client actually points at the App.


class _RoutableMlflow:
    """Minimal mlflow stub that records set_tracking_uri like the real client:
    get_tracking_uri() returns whatever was last set (default a local store)."""

    def __init__(self):
        self._uri = "sqlite:///mlflow.db"
        self.set_calls = []

    def get_tracking_uri(self):
        return self._uri

    def set_tracking_uri(self, uri):
        self.set_calls.append(uri)
        self._uri = uri


def test_mlflow_configured_routes_client_to_config_arn(monkeypatch):
    """Config-resolved ARN (the do/register path) → client pointed at the App."""
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("MLFLOW_TRACKING_SERVER_ARN", raising=False)
    arn = "arn:aws:sagemaker:us-west-2:1:mlflow-app/app-X"
    monkeypatch.setattr(mlcc_mlflow, "_config_tracking_uri", lambda *a, **k: arn)
    fake = _RoutableMlflow()
    monkeypatch.setitem(sys.modules, "mlflow", fake)

    assert mlcc_mlflow._mlflow_configured() is True
    # The active client was moved OFF the local default and ONTO the App ARN.
    assert fake.get_tracking_uri() == arn
    assert fake.set_calls == [arn]
    # Env is also mirrored for remote tooling / the plugin.
    assert os.environ.get("MLFLOW_TRACKING_SERVER_ARN") == arn


def test_mlflow_configured_routes_client_when_env_arn_preset(monkeypatch):
    """A preset env ARN must STILL route the client (the pre-fix early-return bug:
    env set but client left on the local store)."""
    arn = "arn:aws:sagemaker:us-west-2:1:mlflow-app/app-Y"
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.setenv("MLFLOW_TRACKING_SERVER_ARN", arn)
    fake = _RoutableMlflow()
    monkeypatch.setitem(sys.modules, "mlflow", fake)

    assert mlcc_mlflow._mlflow_configured() is True
    assert fake.get_tracking_uri() == arn
    assert fake.set_calls == [arn]


def test_mlflow_configured_https_uri_routes_to_tracking_uri(monkeypatch):
    """A non-ARN HTTPS ref routes the client and mirrors to MLFLOW_TRACKING_URI."""
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("MLFLOW_TRACKING_SERVER_ARN", raising=False)
    uri = "https://mlflow.example.internal"
    monkeypatch.setattr(mlcc_mlflow, "_config_tracking_uri", lambda *a, **k: uri)
    fake = _RoutableMlflow()
    monkeypatch.setitem(sys.modules, "mlflow", fake)

    assert mlcc_mlflow._mlflow_configured() is True
    assert fake.get_tracking_uri() == uri
    assert os.environ.get("MLFLOW_TRACKING_URI") == uri


def test_mlflow_configured_unconfigured_is_false(monkeypatch):
    """No env, no config ref → False and the client is left untouched (no local write)."""
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("MLFLOW_TRACKING_SERVER_ARN", raising=False)
    monkeypatch.setattr(mlcc_mlflow, "_config_tracking_uri", lambda *a, **k: None)
    fake = _RoutableMlflow()
    monkeypatch.setitem(sys.modules, "mlflow", fake)

    assert mlcc_mlflow._mlflow_configured() is False
    assert fake.set_calls == []


# ── BL167: hybrid-write core + error classifier + helpers ─────────────────────


def test_transient_classifier_timeout_is_transient():
    assert mlcc_mlflow._is_transient_mlflow_error(Exception("Connection timed out")) is True
    assert mlcc_mlflow._is_transient_mlflow_error(Exception("ServiceUnavailable 503")) is True


def test_transient_classifier_validation_is_real():
    assert mlcc_mlflow._is_transient_mlflow_error(Exception("ValidationException: bad param")) is False
    assert mlcc_mlflow._is_transient_mlflow_error(Exception("AccessDenied")) is False


def test_transient_classifier_ambiguous_defaults_to_real():
    # Conservative: an unrecognized error is treated as REAL (fatal), never hidden.
    assert mlcc_mlflow._is_transient_mlflow_error(Exception("something weird happened")) is False


def test_hybrid_record_local_first_then_mlflow_success():
    calls = []
    res = mlcc_mlflow.hybrid_record(
        local_write=lambda: calls.append("local") or "L",
        mlflow_write=lambda: calls.append("mlflow"),
        name="ds1", kind="dataset",
    )
    assert calls == ["local", "mlflow"]  # local ALWAYS first
    assert res == {"local": "L", "mlflow_degraded": False}


def test_hybrid_record_transient_mlflow_warns_and_succeeds(capsys):
    def _boom():
        raise Exception("Connection timed out reaching the App")
    res = mlcc_mlflow.hybrid_record(
        local_write=lambda: "L", mlflow_write=_boom, name="ds2", kind="dataset",
    )
    assert res["mlflow_degraded"] is True  # degraded, NOT fatal
    assert res["local"] == "L"
    err = capsys.readouterr().err
    assert "re-run" in err.lower() and "reconcile" in err.lower()


def test_hybrid_record_real_mlflow_error_is_fatal():
    def _boom():
        raise Exception("ValidationException: invalid prompt template")
    with pytest.raises(Exception, match="ValidationException"):
        mlcc_mlflow.hybrid_record(
            local_write=lambda: "L", mlflow_write=_boom, name="p1", kind="prompt",
        )


def test_hybrid_record_local_failure_is_fatal():
    # The local record MUST persist (it's what a re-run reconciles from).
    def _local_boom():
        raise RuntimeError("sidecar write failed")
    with pytest.raises(RuntimeError, match="sidecar write failed"):
        mlcc_mlflow.hybrid_record(
            local_write=_local_boom, mlflow_write=lambda: None, name="ds3", kind="dataset",
        )


def test_mlflow_check_present_dataset_unknown_on_error(monkeypatch):
    # Best-effort: a failure in the underlying resolve → None (unknown), never raises.
    def _boom(*a, **k):
        raise Exception("boom")
    monkeypatch.setattr(mlcc_mlflow, "resolve_dataset_by_name", _boom)
    assert mlcc_mlflow.mlflow_check_present("ds", "dataset") is None


def test_mlflow_check_present_dataset_found(monkeypatch):
    monkeypatch.setattr(mlcc_mlflow, "resolve_dataset_by_name",
                        lambda name, **k: {"name": "ds", "s3_uri": "s3://x"})
    assert mlcc_mlflow.mlflow_check_present("ds", "dataset") is True


def test_mlflow_check_present_unknown_kind_returns_none():
    assert mlcc_mlflow.mlflow_check_present("x", "evaluator") is None
