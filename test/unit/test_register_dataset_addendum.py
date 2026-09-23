# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for BL092 addendum (BL095 fold-in) — the three `do/register
dataset` management operations exposed via the helper.

Covers Task 9.6:
- Req A: list-dataset-versions delegation (existing subcommand) — sanity that
  the command projects sidecar versions and reports not-found non-zero.
- Req B: discover-dataset output shape + recommended register invocation, and
  non-fatal discovery failure (clear message, non-zero exit).
- Req C: delete-dataset with/without a version ref, including:
    * whole-sidecar delete removes ONLY the metadata object (no data bytes),
    * single-version delete rewrites the sidecar,
    * removing the last version removes the sidecar,
    * not-found (dataset + version) exits non-zero,
    * data bytes under datasets/<name>/ are never deleted.

Uses a hand-rolled in-memory fake S3 (no moto) mirroring test_dataset_store.py,
extended with delete_object + delete-call recording.
"""

from __future__ import annotations

import json
import os
import sys
from argparse import Namespace
from unittest.mock import patch

import pytest

_LIB = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python")
)
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import dataset_store  # noqa: E402
import dataset_qol  # noqa: E402
import register_dataset  # noqa: E402
import register_list  # noqa: E402
import register_common  # noqa: E402

CORE_BUCKET = "mlcc-core-111122223333-us-west-2"


# ── Fake S3 (adds delete_object + call recording) ─────────────────────────────


class _NotFound(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "NoSuchKey"}}


class _Transport(Exception):
    def __init__(self, msg="boom"):
        self.response = {"Error": {"Code": "AccessDenied"},
                         "ResponseMetadata": {"HTTPStatusCode": 403}}
        super().__init__(msg)


class _Body:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


class FakeS3:
    def __init__(self, objects=None, raise_on_get=False, raise_on_delete=False):
        self.objects = dict(objects or {})
        self.get_calls = []
        self.put_calls = []
        self.delete_calls = []
        self.raise_on_get = raise_on_get
        self.raise_on_delete = raise_on_delete

    def get_object(self, Bucket, Key, **kw):
        self.get_calls.append(Key)
        if self.raise_on_get:
            raise _Transport()
        if Key not in self.objects:
            raise _NotFound()
        body = self.objects[Key]
        if isinstance(body, str):
            body = body.encode("utf-8")
        return {"Body": _Body(body)}

    def put_object(self, Bucket, Key, Body, **kw):
        self.put_calls.append({"Key": Key, "Body": Body})
        self.objects[Key] = Body
        return {}

    def delete_object(self, Bucket, Key, **kw):
        self.delete_calls.append(Key)
        if self.raise_on_delete:
            raise _Transport()
        self.objects.pop(Key, None)
        return {}


def _sidecar_key(name):
    return f"datasets/{name}/_dataset.json"


def _last_json(capsys):
    out = capsys.readouterr().out
    return json.loads([l for l in out.splitlines() if l.startswith("{")][-1])


def _multi_version_objects(name="calib"):
    """Sidecar with two versions + sibling data bytes that must never be deleted."""
    doc = {
        "name": name,
        "contentHash": "h2",
        "technique": "sft",
        "format": "jsonl",
        "s3_uri": f"s3://{CORE_BUCKET}/datasets/{name}/",
        "latestVersion": "1.1.0",
        "versions": [
            {"version": "1.0.0", "ordinal": 1, "s3_uri": f"s3://{CORE_BUCKET}/datasets/{name}/",
             "hash": "h1", "technique": "sft", "format": "jsonl", "rowCount": 100,
             "createdAt": "2026-01-01T00:00:00Z"},
            {"version": "1.1.0", "ordinal": 2, "s3_uri": f"s3://{CORE_BUCKET}/datasets/{name}/",
             "hash": "h2", "technique": "sft", "format": "jsonl", "rowCount": 200,
             "createdAt": "2026-02-01T00:00:00Z"},
        ],
    }
    return {
        _sidecar_key(name): json.dumps(doc),
        # Data bytes — deletion must NEVER touch these.
        f"datasets/{name}/train.jsonl": b'{"prompt":"p","completion":"c"}\n',
        f"datasets/{name}/part-00000.jsonl": b'{"prompt":"p2","completion":"c2"}\n',
    }


# ── Req A: list-dataset-versions delegation ───────────────────────────────────


class TestListVersions:
    def _run(self, fake, name="calib"):
        args = Namespace(name=name, region="us-west-2", core_bucket=CORE_BUCKET)
        with patch.object(dataset_store, "_get_s3_client", return_value=fake):
            with pytest.raises(SystemExit) as ei:
                register_list.cmd_list_dataset_versions(args)
        return ei.value.code

    def test_lists_all_versions_from_sidecar(self, capsys):
        fake = FakeS3(objects=_multi_version_objects())
        self._run(fake)
        out = _last_json(capsys)
        assert out["name"] == "calib"
        assert [v["version"] for v in out["versions"]] == ["1.0.0", "1.1.0"]
        assert out["versions"][0]["rows"] == 100
        assert out["versions"][1]["s3_uri"].endswith("/datasets/calib/")

    def test_not_found_exits_nonzero(self, capsys):
        fake = FakeS3(objects={})
        code = self._run(fake, name="ghost")
        assert code != 0
        assert "DATASET_NOT_FOUND" in capsys.readouterr().out


# ── Req B: discover-dataset ───────────────────────────────────────────────────


class TestDiscover:
    def _args(self, **kw):
        defaults = dict(hf_id="org/name", hf_split=None, name=None,
                        hf_secret_name=None, region="us-west-2")
        defaults.update(kw)
        return Namespace(**defaults)

    def test_output_shape_and_recommendation(self, capsys):
        discovery = {
            "dataset_id": "org/name",
            "splits": ["train", "test"],
            "files_by_split": {"train": ["data/train.jsonl"], "test": ["data/test.jsonl"]},
            "row_counts": {"train": 1000, "test": 100},
            "schema": ["prompt", "completion"],
            "schema_source": "data/train.jsonl",
        }
        with patch.object(dataset_qol, "discover_hf_dataset", return_value=discovery), \
             patch("tune_stage_hf._resolve_hf_token", return_value=None):
            with pytest.raises(SystemExit) as ei:
                register_dataset.cmd_discover_dataset(self._args())
        assert ei.value.code == 0
        out = _last_json(capsys)
        assert out["dataset_id"] == "org/name"
        assert out["splits"] == ["train", "test"]
        assert out["row_counts"]["train"] == 1000
        assert out["schema"] == ["prompt", "completion"]
        # Recommendation prefers 'train' split and slugs the repo name.
        assert out["recommended_register"] == "./do/register dataset name --hf-id org/name --hf-split train"

    def test_recommendation_respects_explicit_name_and_split(self, capsys):
        discovery = {
            "dataset_id": "org/name", "splits": ["validation"],
            "files_by_split": {"validation": ["v.jsonl"]},
            "row_counts": {"validation": 5}, "schema": None, "schema_source": None,
        }
        with patch.object(dataset_qol, "discover_hf_dataset", return_value=discovery), \
             patch("tune_stage_hf._resolve_hf_token", return_value=None):
            with pytest.raises(SystemExit):
                register_dataset.cmd_discover_dataset(self._args(name="mine", hf_split="validation"))
        out = _last_json(capsys)
        assert out["recommended_register"] == "./do/register dataset mine --hf-id org/name --hf-split validation"

    def test_invalid_hf_id_exits_nonzero(self, capsys):
        with patch("tune_stage_hf._resolve_hf_token", return_value=None):
            with pytest.raises(SystemExit) as ei:
                register_dataset.cmd_discover_dataset(self._args(hf_id="justname"))
        assert ei.value.code != 0
        assert "INVALID_ARGUMENT" in capsys.readouterr().out

    def test_discovery_failure_is_nonfatal_clear_message(self, capsys):
        with patch.object(dataset_qol, "discover_hf_dataset",
                          side_effect=dataset_qol.DiscoveryError("Dataset not found: org/name.")), \
             patch("tune_stage_hf._resolve_hf_token", return_value=None):
            with pytest.raises(SystemExit) as ei:
                register_dataset.cmd_discover_dataset(self._args())
        assert ei.value.code != 0
        out = capsys.readouterr().out
        assert "DISCOVERY_FAILED" in out
        assert "Dataset not found" in out


class TestDiscoverQoLPrimitives:
    """Unit-level checks on the discovery helpers in dataset_qol (no network)."""

    def test_recommended_invocation_slugs_repo_name(self):
        rec = dataset_qol.recommended_register_invocation("Org/My_Cool.Set")
        assert rec.startswith("./do/register dataset my-cool-set --hf-id Org/My_Cool.Set")

    def test_split_from_filename(self):
        assert dataset_qol._split_from_filename("data/train.jsonl") == "train"
        assert dataset_qol._split_from_filename("test-00000-of-00002.parquet") == "test"

    def test_discover_raises_discoveryerror_on_not_found(self):
        class _Api:
            def __init__(self, *a, **k):
                pass

            def list_repo_files(self, *a, **k):
                raise Exception("404 Client Error: repositorynotfound")

        import types
        fake_hub = types.ModuleType("huggingface_hub")
        fake_hub.HfApi = _Api
        with patch.dict(sys.modules, {"huggingface_hub": fake_hub}):
            with pytest.raises(dataset_qol.DiscoveryError) as ei:
                dataset_qol.discover_hf_dataset("org/missing")
        assert "not found" in str(ei.value).lower()


# ── Req C: delete-dataset ─────────────────────────────────────────────────────


class TestDelete:
    def _run(self, fake, name="calib", version=None):
        args = Namespace(name=name, version=version, region="us-west-2", core_bucket=CORE_BUCKET)
        with patch.object(dataset_store, "_get_s3_client", return_value=fake):
            with pytest.raises(SystemExit) as ei:
                register_dataset.cmd_delete_dataset(args)
        return ei.value.code

    def _data_keys(self, fake, name="calib"):
        return [k for k in fake.objects if k.startswith(f"datasets/{name}/") and not k.endswith("_dataset.json")]

    def test_delete_whole_sidecar_removes_only_metadata(self, capsys):
        fake = FakeS3(objects=_multi_version_objects())
        self._run(fake)
        out = _last_json(capsys)
        assert out["deleted"] is True
        assert out["scope"] == "dataset"
        assert out["data_deleted"] is False
        # Only the sidecar object was deleted.
        assert fake.delete_calls == [_sidecar_key("calib")]
        assert _sidecar_key("calib") not in fake.objects
        # Data bytes remain.
        assert len(self._data_keys(fake)) == 2

    def test_delete_single_version_rewrites_sidecar(self, capsys):
        fake = FakeS3(objects=_multi_version_objects())
        self._run(fake, version="@v1")
        out = _last_json(capsys)
        assert out["scope"] == "version"
        assert out["version_ordinal"] == 1
        assert out["removed_last_version"] is False
        assert out["remaining_versions"] == 1
        # Sidecar rewritten (not deleted); one put, no delete.
        assert fake.delete_calls == []
        assert len(fake.put_calls) == 1
        doc = json.loads(fake.put_calls[0]["Body"])
        assert [v["ordinal"] for v in doc["versions"]] == [2]
        # Latest-* fields refreshed to the surviving version.
        assert doc["latestVersion"] == "1.1.0"
        assert doc["contentHash"] == "h2"
        # Data bytes untouched.
        assert len(self._data_keys(fake)) == 2

    def test_delete_last_remaining_version_removes_sidecar(self, capsys):
        # Single-version sidecar; deleting @v1 removes the whole sidecar.
        doc = {
            "name": "solo", "contentHash": "h1", "latestVersion": "1.0.0",
            "versions": [{"version": "1.0.0", "ordinal": 1, "hash": "h1",
                          "s3_uri": f"s3://{CORE_BUCKET}/datasets/solo/"}],
        }
        objects = {
            _sidecar_key("solo"): json.dumps(doc),
            "datasets/solo/train.jsonl": b"data\n",
        }
        fake = FakeS3(objects=objects)
        self._run(fake, name="solo", version="@v1")
        out = _last_json(capsys)
        assert out["removed_last_version"] is True
        assert fake.delete_calls == [_sidecar_key("solo")]
        assert self._data_keys(fake, "solo") == ["datasets/solo/train.jsonl"]

    def test_delete_dataset_not_found_exits_nonzero(self, capsys):
        fake = FakeS3(objects={})
        code = self._run(fake, name="ghost")
        assert code != 0
        assert "DATASET_NOT_FOUND" in capsys.readouterr().out
        assert fake.delete_calls == []

    def test_delete_version_not_found_exits_nonzero(self, capsys):
        fake = FakeS3(objects=_multi_version_objects())
        code = self._run(fake, version="@v9")
        assert code != 0
        assert "VERSION_NOT_FOUND" in capsys.readouterr().out
        # Nothing mutated.
        assert fake.delete_calls == []
        assert fake.put_calls == []

    def test_invalid_version_ref_exits_nonzero(self, capsys):
        fake = FakeS3(objects=_multi_version_objects())
        code = self._run(fake, version="@vfoo")
        assert code != 0
        assert "INVALID_ARGUMENT" in capsys.readouterr().out

    def test_missing_core_bucket_fails_fast(self):
        args = Namespace(name="calib", version=None, region="us-west-2", core_bucket=None)
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(SystemExit) as ei:
                register_dataset.cmd_delete_dataset(args)
        assert ei.value.code != 0

    def test_version_ref_parsing_forms(self):
        # @v2, v2, and 2 all parse to ordinal 2; bad forms → None.
        assert register_dataset._parse_version_ref("@v2") == 2
        assert register_dataset._parse_version_ref("v2") == 2
        assert register_dataset._parse_version_ref("2") == 2
        assert register_dataset._parse_version_ref(None) is None
        assert register_dataset._parse_version_ref("@vx") is None


# ── dataset_store.delete_sidecar unit-level ───────────────────────────────────


class TestDeleteSidecarUnit:
    def test_delete_sidecar_removes_key(self):
        fake = FakeS3(objects={_sidecar_key("x"): "{}"})
        dataset_store.delete_sidecar(fake, CORE_BUCKET, "x")
        assert _sidecar_key("x") not in fake.objects
        assert fake.delete_calls == [_sidecar_key("x")]

    def test_delete_sidecar_idempotent_on_missing(self):
        fake = FakeS3(objects={})
        # No raise; delete of missing key is a no-op.
        dataset_store.delete_sidecar(fake, CORE_BUCKET, "missing")

    def test_delete_sidecar_raises_transport(self):
        fake = FakeS3(objects={_sidecar_key("x"): "{}"}, raise_on_delete=True)
        with pytest.raises(dataset_store.TransportError):
            dataset_store.delete_sidecar(fake, CORE_BUCKET, "x")
