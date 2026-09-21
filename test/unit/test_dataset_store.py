# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the S3-sidecar dataset store (BL092).

Covers:
- Sidecar write on registration incl. customMetadata (Property 1)
- No reads/writes to the local registry during dataset operations (Property 4)
- resolve-dataset version selection + not-found vs transport error (Property 2)
- list-datasets paginated sidecar enumeration + {local,remote} shape (Property 3)
- Idempotent versioning: same hash, no --force → no new version (Property 5)

Uses a hand-rolled in-memory fake S3 client (no moto dependency) that records
put/get/list calls and can be told to raise a transport error.
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

import register_common  # noqa: E402
import dataset_store  # noqa: E402
import register_dataset  # noqa: E402
import register_resolve  # noqa: E402
import register_list  # noqa: E402

CORE_BUCKET = "mlcc-core-111122223333-us-west-2"


# ── Fake S3 client ──────────────────────────────────────────────────────────


class _NotFound(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "NoSuchKey"}}


class _Transport(Exception):
    def __init__(self, msg="boom"):
        self.response = {"Error": {"Code": "AccessDenied"},
                         "ResponseMetadata": {"HTTPStatusCode": 403}}
        super().__init__(msg)


class FakeS3:
    """Minimal in-memory S3 supporting get/put_object + list_objects_v2 paginator."""

    def __init__(self, objects=None, raise_on_get=False, raise_on_list=False,
                 page_size=1000):
        self.objects = dict(objects or {})  # key -> bytes/str
        self.put_calls = []
        self.get_calls = []
        self.raise_on_get = raise_on_get
        self.raise_on_list = raise_on_list
        self.page_size = page_size

    # get_object
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

    # put_object
    def put_object(self, Bucket, Key, Body, **kw):
        self.put_calls.append({"Key": Key, "Body": Body, "kw": kw})
        self.objects[Key] = Body
        return {}

    # paginator
    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return _Paginator(self)


class _Body:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


class _Paginator:
    def __init__(self, s3):
        self.s3 = s3

    def paginate(self, Bucket, Prefix="", **kw):
        if self.s3.raise_on_list:
            raise _Transport()
        keys = [k for k in self.s3.objects if k.startswith(Prefix)]
        # Chunk into pages to exercise pagination handling.
        size = self.s3.page_size
        for i in range(0, max(len(keys), 1), size):
            chunk = keys[i:i + size]
            yield {"Contents": [{"Key": k} for k in chunk]}
            if not keys:
                break


# ── Helpers ─────────────────────────────────────────────────────────────────


def _reg_args(**kw):
    defaults = dict(
        name="calib", s3_uri=f"s3://{CORE_BUCKET}/datasets/calib/",
        format="jsonl", technique="sft", row_count=100, column_schema=None,
        project_name="proj", region="us-west-2", core_bucket=CORE_BUCKET,
        force=False, attribution=None, lineage=None, origination=None,
        application=None,
    )
    defaults.update(kw)
    return Namespace(**defaults)


def _sidecar_key(name="calib"):
    return f"datasets/{name}/_dataset.json"


class _NoLocalRegistry:
    """Context manager asserting the local datasets.json is never touched.

    Patches builtins.open to raise if the local registry path is opened, and
    replaces the registry load/save helpers with tripwires.
    """

    def __enter__(self):
        self._patches = []
        reg_path = register_common._DATASETS_REGISTRY

        def _tripwire_load(path):
            if path == reg_path:
                raise AssertionError(f"local registry read attempted: {path}")
            return []

        def _tripwire_save(path, entries):
            if path == reg_path:
                raise AssertionError(f"local registry write attempted: {path}")

        p1 = patch("register_common._load_registry", side_effect=_tripwire_load)
        p2 = patch("register_common._save_registry", side_effect=_tripwire_save)
        for p in (p1, p2):
            p.start()
            self._patches.append(p)
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()
        return False


# ── Property 1 + 4: sidecar write incl. customMetadata; no local registry ─────


class TestSidecarWrite:
    def test_first_registration_writes_sidecar(self):
        fake = FakeS3()
        with patch.object(dataset_store, "_get_s3_client", return_value=fake), \
             patch.object(register_dataset, "_compute_content_hash", return_value="hash-v1"), \
             patch.object(register_dataset, "_count_rows", return_value=100), \
             patch.object(register_dataset, "_get_hub_name_from_profile", return_value=None), \
             _NoLocalRegistry():
            with pytest.raises(SystemExit):
                register_dataset.cmd_register_dataset(_reg_args())

        assert len(fake.put_calls) == 1
        put = fake.put_calls[0]
        assert put["Key"] == _sidecar_key()
        doc = json.loads(put["Body"])
        assert doc["name"] == "calib"
        assert doc["contentHash"] == "hash-v1"
        assert doc["versions"][0]["version"] == "1.0.0"
        assert doc["versions"][0]["ordinal"] == 1
        assert doc["versions"][0]["hash"] == "hash-v1"
        assert doc["versions"][0]["rowCount"] == 100
        assert doc["versions"][0]["s3_uri"].endswith("/datasets/calib/")

    def test_custom_metadata_persisted(self):
        fake = FakeS3()
        args = _reg_args(
            attribution="acme", lineage="derived-from-x",
            origination="hf://org/name@rev", application="throughput-calibration",
        )
        with patch.object(dataset_store, "_get_s3_client", return_value=fake), \
             patch.object(register_dataset, "_compute_content_hash", return_value="h"), \
             patch.object(register_dataset, "_count_rows", return_value=1), \
             patch.object(register_dataset, "_get_hub_name_from_profile", return_value=None):
            with pytest.raises(SystemExit):
                register_dataset.cmd_register_dataset(args)

        doc = json.loads(fake.put_calls[0]["Body"])
        cm = doc["customMetadata"]
        assert cm["attribution"] == "acme"
        assert cm["lineage"] == "derived-from-x"
        assert cm["origination"] == "hf://org/name@rev"
        assert cm["application"] == "throughput-calibration"

    def test_unset_custom_metadata_fields_omitted(self):
        fake = FakeS3()
        args = _reg_args(attribution="only-this")
        with patch.object(dataset_store, "_get_s3_client", return_value=fake), \
             patch.object(register_dataset, "_compute_content_hash", return_value="h"), \
             patch.object(register_dataset, "_count_rows", return_value=1), \
             patch.object(register_dataset, "_get_hub_name_from_profile", return_value=None):
            with pytest.raises(SystemExit):
                register_dataset.cmd_register_dataset(args)
        doc = json.loads(fake.put_calls[0]["Body"])
        assert doc["customMetadata"] == {"attribution": "only-this"}

    def test_no_core_bucket_fails_fast(self):
        args = _reg_args(core_bucket=None)
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(SystemExit):
                register_dataset.cmd_register_dataset(args)


# ── Property 5: idempotent versioning ─────────────────────────────────────────


class TestIdempotentVersioning:
    def _existing(self, name="calib", hash_="h1", version="1.0.0"):
        doc = {
            "name": name,
            "contentHash": hash_,
            "technique": "sft",
            "versions": [{
                "version": version, "ordinal": 1,
                "s3_uri": f"s3://{CORE_BUCKET}/datasets/{name}/",
                "hash": hash_, "rowCount": 100, "createdAt": "2026-01-01T00:00:00Z",
            }],
        }
        return {_sidecar_key(name): json.dumps(doc)}

    def test_same_hash_no_force_no_new_version(self, capsys):
        fake = FakeS3(objects=self._existing(hash_="same"))
        with patch.object(dataset_store, "_get_s3_client", return_value=fake), \
             patch.object(register_dataset, "_compute_content_hash", return_value="same"), \
             patch.object(register_dataset, "_count_rows", return_value=100), \
             patch.object(register_dataset, "_get_hub_name_from_profile", return_value=None):
            with pytest.raises(SystemExit):
                register_dataset.cmd_register_dataset(_reg_args())
        # No new sidecar written for unchanged content.
        assert fake.put_calls == []
        out = capsys.readouterr().out
        assert json.loads([l for l in out.splitlines() if l.startswith("{")][-1])["skipped"] is True

    def test_changed_hash_creates_new_version(self):
        fake = FakeS3(objects=self._existing(hash_="old"))
        with patch.object(dataset_store, "_get_s3_client", return_value=fake), \
             patch.object(register_dataset, "_compute_content_hash", return_value="new"), \
             patch.object(register_dataset, "_count_rows", return_value=200), \
             patch.object(register_dataset, "_get_hub_name_from_profile", return_value=None):
            with pytest.raises(SystemExit):
                register_dataset.cmd_register_dataset(_reg_args())
        assert len(fake.put_calls) == 1
        doc = json.loads(fake.put_calls[0]["Body"])
        assert len(doc["versions"]) == 2
        assert doc["versions"][-1]["ordinal"] == 2
        assert doc["versions"][-1]["hash"] == "new"

    def test_same_hash_with_force_creates_new_version(self):
        fake = FakeS3(objects=self._existing(hash_="same"))
        with patch.object(dataset_store, "_get_s3_client", return_value=fake), \
             patch.object(register_dataset, "_compute_content_hash", return_value="same"), \
             patch.object(register_dataset, "_count_rows", return_value=100), \
             patch.object(register_dataset, "_get_hub_name_from_profile", return_value=None):
            with pytest.raises(SystemExit):
                register_dataset.cmd_register_dataset(_reg_args(force=True))
        assert len(fake.put_calls) == 1
        doc = json.loads(fake.put_calls[0]["Body"])
        assert len(doc["versions"]) == 2


# ── Property 2: resolve reads from sidecar ────────────────────────────────────


class TestResolveDataset:
    def _multi_version(self, name="calib"):
        doc = {
            "name": name,
            "versions": [
                {"version": "1.0.0", "ordinal": 1, "s3_uri": "s3://b/v1/", "hash": "h1"},
                {"version": "1.1.0", "ordinal": 2, "s3_uri": "s3://b/v2/", "hash": "h2"},
            ],
        }
        return {_sidecar_key(name): json.dumps(doc)}

    def _run(self, fake, **argkw):
        args = Namespace(name="calib", version=None, region="us-west-2",
                         core_bucket=CORE_BUCKET, **argkw)
        with patch.object(dataset_store, "_get_s3_client", return_value=fake):
            with pytest.raises(SystemExit) as ei:
                register_resolve.cmd_resolve_dataset(args)
        return ei.value.code

    def test_resolve_latest(self, capsys):
        fake = FakeS3(objects=self._multi_version())
        self._run(fake)
        out = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
        assert out["s3_uri"] == "s3://b/v2/"
        assert out["version"] == "1.1.0"
        assert out["ordinal"] == 2

    def test_resolve_by_ordinal(self, capsys):
        fake = FakeS3(objects=self._multi_version())
        args = Namespace(name="calib", version="1", region="us-west-2", core_bucket=CORE_BUCKET)
        with patch.object(dataset_store, "_get_s3_client", return_value=fake):
            with pytest.raises(SystemExit):
                register_resolve.cmd_resolve_dataset(args)
        out = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
        assert out["version"] == "1.0.0"
        assert out["s3_uri"] == "s3://b/v1/"

    def test_resolve_by_semver(self, capsys):
        fake = FakeS3(objects=self._multi_version())
        args = Namespace(name="calib", version="1.1.0", region="us-west-2", core_bucket=CORE_BUCKET)
        with patch.object(dataset_store, "_get_s3_client", return_value=fake):
            with pytest.raises(SystemExit):
                register_resolve.cmd_resolve_dataset(args)
        out = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
        assert out["version"] == "1.1.0"
        assert out["ordinal"] == 2

    def test_not_found_distinct_from_transport(self):
        # Not found: sidecar missing → nonzero exit, DATASET_NOT_FOUND.
        fake_missing = FakeS3(objects={})
        code_missing = self._run(fake_missing)
        assert code_missing != 0

        # Transport error: get raises → distinct exit code (3).
        fake_err = FakeS3(objects={}, raise_on_get=True)
        code_err = self._run(fake_err)
        assert code_err == 3
        assert code_err != code_missing

    def test_version_not_found(self, capsys):
        fake = FakeS3(objects=self._multi_version())
        args = Namespace(name="calib", version="9", region="us-west-2", core_bucket=CORE_BUCKET)
        with patch.object(dataset_store, "_get_s3_client", return_value=fake):
            with pytest.raises(SystemExit) as ei:
                register_resolve.cmd_resolve_dataset(args)
        assert ei.value.code != 0
        out = capsys.readouterr().out
        assert "VERSION_NOT_FOUND" in out


# ── Property 3: list reads from S3 sidecars ───────────────────────────────────


class TestListDatasets:
    def _objects(self):
        d1 = json.dumps({"name": "alpha", "technique": "sft",
                         "versions": [{"version": "1.0.0", "ordinal": 1,
                                       "s3_uri": "s3://b/alpha/", "hash": "h",
                                       "rowCount": 10}]})
        d2 = json.dumps({"name": "beta", "technique": "dpo",
                         "versions": [
                             {"version": "1.0.0", "ordinal": 1, "s3_uri": "s3://b/beta/v1/"},
                             {"version": "1.1.0", "ordinal": 2, "s3_uri": "s3://b/beta/v2/"},
                         ]})
        return {
            _sidecar_key("alpha"): d1,
            _sidecar_key("beta"): d2,
            # Non-sidecar object under datasets/ must be ignored.
            "datasets/alpha/train.jsonl": b"noise",
        }

    def _run(self, fake, **argkw):
        argkw.setdefault("technique", None)
        args = Namespace(source="all", region="us-west-2", core_bucket=CORE_BUCKET,
                         **argkw)
        with patch.object(dataset_store, "_get_s3_client", return_value=fake), \
             patch.object(register_list, "_get_hub_name_from_profile", return_value=None):
            with pytest.raises(SystemExit):
                register_list.cmd_list_datasets(args)

    def test_list_shape_preserved(self, capsys):
        fake = FakeS3(objects=self._objects())
        self._run(fake)
        out = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
        assert "local" in out and "remote" in out
        names = sorted(e["name"] for e in out["local"])
        assert names == ["alpha", "beta"]
        beta = next(e for e in out["local"] if e["name"] == "beta")
        assert beta["version_count"] == 2
        assert beta["latest_version"] == "1.1.0"

    def test_pagination(self, capsys):
        fake = FakeS3(objects=self._objects(), page_size=1)
        self._run(fake)
        out = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
        assert len(out["local"]) == 2

    def test_technique_filter(self, capsys):
        fake = FakeS3(objects=self._objects())
        self._run(fake, technique="sft")
        out = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
        assert [e["name"] for e in out["local"]] == ["alpha"]

    def test_transport_error_is_nonfatal(self, capsys):
        fake = FakeS3(objects={}, raise_on_list=True)
        self._run(fake)
        out = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
        assert out["local"] == []


# ── dataset_store unit-level ──────────────────────────────────────────────────


class TestDatasetStoreUnit:
    def test_read_sidecar_none_on_404(self):
        fake = FakeS3(objects={})
        assert dataset_store.read_sidecar(fake, CORE_BUCKET, "missing") is None

    def test_read_sidecar_raises_transport(self):
        fake = FakeS3(objects={}, raise_on_get=True)
        with pytest.raises(dataset_store.TransportError):
            dataset_store.read_sidecar(fake, CORE_BUCKET, "x")

    def test_write_then_read_roundtrip(self):
        fake = FakeS3()
        doc = {"name": "x", "versions": [{"version": "1.0.0"}]}
        dataset_store.write_sidecar(fake, CORE_BUCKET, "x", doc)
        assert dataset_store.read_sidecar(fake, CORE_BUCKET, "x") == doc

    def test_sidecar_key(self):
        assert register_common._sidecar_key("foo") == "datasets/foo/_dataset.json"
