# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""BL100 — shared dataset-name → S3-URI resolution (resolve_dataset_uri).

Covers the reusable resolution core extracted from cmd_resolve_dataset that the
do/benchmark BYOD dataset-picker path (and the resolve-dataset CLI) both use:

- name → s3_uri + format resolution from the S3 sidecar (latest + version-pinned)
- not-found vs transport error are distinct, raised (not sys.exit)
- MLflow is bypassed here (S3-sidecar path) via patching _mlflow_configured

Uses a hand-rolled in-memory fake S3 client (no moto dependency), mirroring
test_dataset_store.py.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

_LIB = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python")
)
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import dataset_store  # noqa: E402
import register_resolve  # noqa: E402

CORE_BUCKET = "mlcc-core-111122223333-us-west-2"


def _sidecar_key(name="med-voice"):
    return f"datasets/{name}/_dataset.json"


class _NotFound(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "NoSuchKey"}}


class FakeS3:
    """Minimal in-memory S3 supporting get_object with not-found/transport modes."""

    def __init__(self, objects=None, raise_on_get=False):
        self.objects = dict(objects or {})
        self.raise_on_get = raise_on_get

    def get_object(self, Bucket, Key, **kw):
        if self.raise_on_get:
            raise RuntimeError("boom: access denied")
        if Key not in self.objects:
            raise _NotFound()
        body = self.objects[Key]
        if isinstance(body, str):
            body = body.encode("utf-8")

        class _Body:
            def __init__(self, b):
                self._b = b

            def read(self):
                return self._b

        return {"Body": _Body(body)}


@pytest.fixture(autouse=True)
def _no_mlflow(monkeypatch):
    """Force the S3-sidecar resolution path (MLflow not configured)."""
    import mlcc_mlflow
    monkeypatch.setattr(mlcc_mlflow, "_mlflow_configured", lambda *a, **k: False)


def _sidecar(name="med-voice", versions=None):
    versions = versions or [
        {"version": "1.0.0", "ordinal": 1, "s3_uri": f"s3://b/{name}/v1/train.jsonl",
         "hash": "h1", "format": "jsonl"},
        {"version": "1.1.0", "ordinal": 2, "s3_uri": f"s3://b/{name}/v2/train.jsonl",
         "hash": "h2", "format": "jsonl"},
    ]
    return {_sidecar_key(name): json.dumps({"name": name, "versions": versions})}


class TestResolveDatasetUri:
    def test_resolves_name_to_latest_s3_uri_and_format(self):
        fake = FakeS3(objects=_sidecar())
        result = register_resolve.resolve_dataset_uri(
            "med-voice", core_bucket=CORE_BUCKET, s3_client=fake
        )
        assert result["s3_uri"] == "s3://b/med-voice/v2/train.jsonl"
        assert result["version"] == "1.1.0"
        assert result["ordinal"] == 2
        assert result["format"] == "jsonl"

    def test_resolves_version_pin_by_ordinal(self):
        fake = FakeS3(objects=_sidecar())
        result = register_resolve.resolve_dataset_uri(
            "med-voice", version="1", core_bucket=CORE_BUCKET, s3_client=fake
        )
        assert result["s3_uri"] == "s3://b/med-voice/v1/train.jsonl"
        assert result["version"] == "1.0.0"

    def test_resolves_version_pin_by_semver(self):
        fake = FakeS3(objects=_sidecar())
        result = register_resolve.resolve_dataset_uri(
            "med-voice", version="1.1.0", core_bucket=CORE_BUCKET, s3_client=fake
        )
        assert result["ordinal"] == 2

    def test_format_defaults_to_jsonl_when_absent(self):
        fake = FakeS3(objects=_sidecar(versions=[
            {"version": "1.0.0", "ordinal": 1, "s3_uri": "s3://b/x/", "hash": "h"},
        ]))
        result = register_resolve.resolve_dataset_uri(
            "med-voice", core_bucket=CORE_BUCKET, s3_client=fake
        )
        assert result["format"] == "jsonl"

    def test_not_found_raises_dataset_not_found(self):
        fake = FakeS3(objects={})
        with pytest.raises(register_resolve.DatasetNotFoundError):
            register_resolve.resolve_dataset_uri(
                "missing", core_bucket=CORE_BUCKET, s3_client=fake
            )

    def test_pinned_version_missing_raises_version_not_found(self):
        fake = FakeS3(objects=_sidecar())
        with pytest.raises(register_resolve.DatasetVersionNotFoundError):
            register_resolve.resolve_dataset_uri(
                "med-voice", version="9", core_bucket=CORE_BUCKET, s3_client=fake
            )

    def test_transport_error_raises_resolve_error_distinct_from_not_found(self):
        fake = FakeS3(objects={}, raise_on_get=True)
        with pytest.raises(register_resolve.DatasetResolveError):
            register_resolve.resolve_dataset_uri(
                "med-voice", core_bucket=CORE_BUCKET, s3_client=fake
            )

    def test_missing_core_bucket_raises_resolve_error(self):
        with pytest.raises(register_resolve.DatasetResolveError):
            register_resolve.resolve_dataset_uri("med-voice", core_bucket=None)

    def test_dataset_not_found_is_not_a_resolve_error(self):
        # The two failure classes are distinct so callers (bash) can tell
        # "no such dataset" apart from "couldn't reach the registry".
        assert not issubclass(register_resolve.DatasetNotFoundError,
                              register_resolve.DatasetResolveError)
