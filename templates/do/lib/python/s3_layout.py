#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""s3_layout.py — the ONE module that composes MLCC S3 keys (bucket consolidation R3).

Owner decision D9 (Option D). Every producer and consumer of a servable artifact
builds its S3 location here, so no script can drift to its own scheme (the way
the two old stage_adapter.py adapter schemes did):

  core bucket (profile key coreS3Bucket → CORE_S3_BUCKET)
    models/<org>/<base>/                                    staged base weights (do/stage)
    models/<org>/<base>/.mlcc-adapters/<project>/<name>/    adapter HOME (one per name)
        v<hash12>/                                          CANONICAL LoRA adapter VERSION + mlcc-adapter.json
    models/mlcc-<project>/<name>/                           full fine-tune + mlcc-model.json
    evaluators/<name>/                                      reward-function code backups
    staging-jobs/<job>/                                     Processing Job entrypoints
  artifacts bucket (profile key artifactsS3Bucket → ARTIFACTS_S3_BUCKET)
    <project>/{tune,train,optimize}/...                     raw job output (never servable as-is)

Bucket NAMES never appear here: callers pass the bucket they read from the
profile (do/lib/profile.sh). `<org>/<base>` is the model's Hugging Face id; a
JumpStart/hub id maps through the tune catalog (.tune_catalog.json) and an
unmapped id fails fast (it is never guessed).

Promotion copies a job's servable output (S3 → S3, server-side, the caller's
credentials) into the canonical prefix with a manifest, idempotent on the
source content hash. A LoRA adapter is CONTENT-ADDRESSED (BL199): it lands in
<home>/v<hash12>/ where hash12 is the first 12 hex digits of that content hash,
so identical content is the same version ("unchanged") and different content is
a NEW version directory. A version directory is never rewritten in place and old
versions are never deleted automatically (an inference component may still
reference one); `do/clean adapters` removes every version of its own project.
Unversioned homes written before BL199 (and hand copies) stay valid canonical
adapters for parse / load / remove and as --from-weights sources. test/unit/s3-layout-path-drift.test.js enforces that no
other file assembles these paths; test/unit/test_s3_layout.py covers the module.

CLI (JSON on stdout; exit 0 ok, 2 usage/unmapped, 3 refused, 1 AWS error):
    s3_layout.py resolve-base --model ID [--catalog FILE]
    s3_layout.py base-uri --bucket B --model ID [--catalog FILE]
    s3_layout.py adapter-uri --bucket B --model ID --project P --name N [--catalog FILE]   (the HOME)
    s3_layout.py finetune-uri --bucket B --project P --name N
    s3_layout.py artifacts-uri --bucket B --project P --kind tune|train|optimize
    s3_layout.py evaluator-key --name N
    s3_layout.py parse --uri U                       (adapter: versioned or unversioned home)
    s3_layout.py promote --source U --dest U --kind lora_adapter|full_model --project P --name N
                         --base-model ID [--source-job J] [--technique T] [--created-by C] [--region R]
        → {"action", "dest", "version", "manifest"}; an adapter's dest is <home>/v<hash12>/
    s3_layout.py promote-plan --source U --dest U --kind K [--region R]   (read-only dry run)
    s3_layout.py publish-local --dir D --dest U --kind K --project P --name N --base-model ID --source S
    s3_layout.py manifest --uri U [--region R]
    s3_layout.py clean-plan --bucket B --project P [--region R]
    s3_layout.py clean --bucket B --project P [--region R]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import time

# ── Layout constants (the single source; consumers import or conformance-check) ──
MODELS_ROOT = "models"
ADAPTER_SUBDIR = ".mlcc-adapters"
FINETUNE_NAMESPACE_PREFIX = "mlcc-"
EVALUATORS_ROOT = "evaluators"
STAGING_JOBS_ROOT = "staging-jobs"
ARTIFACT_KINDS = ("tune", "train", "optimize")
ADAPTER_MANIFEST = "mlcc-adapter.json"
MODEL_MANIFEST = "mlcc-model.json"
MANIFEST_FILES = (ADAPTER_MANIFEST, MODEL_MANIFEST)
MANIFEST_SCHEMA = "mlcc-artifact/v1"
# The realtime container's serve-time `aws s3 sync` of a base prefix must skip the
# adapter subtree (R3.5). templates/code/serve carries this glob literally (it runs
# inside the image, without do/lib); a conformance test asserts they agree.
SERVE_SYNC_EXCLUDE = f"{ADAPTER_SUBDIR}/*"
# BL199 content-addressed adapter versions: <home>/v<first 12 hex of the content hash>/.
# The version segment is composed ONLY here (adapter_version / adapter_version_uri);
# test/unit/s3-layout-path-drift.test.js enforces it.
VERSION_PREFIX = "v"
VERSION_HEX_LEN = 12
_VERSION_SEGMENT = re.compile(rf"^{VERSION_PREFIX}[0-9a-f]{{{VERSION_HEX_LEN}}}$")

_HF_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_HERE = os.path.dirname(os.path.abspath(__file__))


class LayoutError(ValueError):
    """An input cannot be mapped to the canonical layout (never guessed)."""


# ── Pure path composition ─────────────────────────────────────────────────────
def _segment(value: str, what: str) -> str:
    v = (value or "").strip()
    if not _SEGMENT.match(v) or v in (".", ".."):
        raise LayoutError(f"invalid {what} '{value}' (letters, digits, '.', '_', '-'; no '/')")
    return v


def _model_id_path(model_id: str) -> str:
    """A Hugging Face id as a key path (org/name, or a bare legacy name)."""
    mid = (model_id or "").strip().strip("/")
    parts = mid.split("/")
    if not mid or len(parts) > 2:
        raise LayoutError(f"invalid model id '{model_id}' (expected <org>/<name>)")
    return "/".join(_segment(p, "model id segment") for p in parts)


def s3_uri(bucket: str, key: str) -> str:
    if not bucket:
        raise LayoutError("no bucket given (read it from the active profile, do/lib/profile.sh)")
    return f"s3://{bucket}/{key}"


def base_prefix(hf_id: str) -> str:
    """models/<org>/<base>/ — where do/stage stages a model's weights."""
    return f"{MODELS_ROOT}/{_model_id_path(hf_id)}/"


def adapters_root(base_key_prefix: str) -> str:
    """<base prefix>/.mlcc-adapters/ — the adapter subtree of one base prefix."""
    root = base_key_prefix.strip("/")
    return f"{root + '/' if root else ''}{ADAPTER_SUBDIR}/"


def adapter_project_prefix(base_key_prefix: str, project: str) -> str:
    """<base prefix>/.mlcc-adapters/<project>/ — every adapter of one project on one base."""
    return f"{adapters_root(base_key_prefix)}{_segment(project, 'project')}/"


def adapter_prefix(base_key_prefix: str, project: str, name: str) -> str:
    """<base prefix>/.mlcc-adapters/<project>/<name>/ — the adapter HOME (its versions live under it)."""
    return f"{adapter_project_prefix(base_key_prefix, project)}{_segment(name, 'adapter name')}/"


def is_version_segment(segment: str) -> bool:
    """True for a content-addressed version directory name (v<hash12>)."""
    return bool(_VERSION_SEGMENT.match(segment or ""))


def adapter_version(content_hash_value: str) -> str:
    """'sha256:<hex>' → 'v<first 12 hex>' — the content-addressed version segment."""
    digest = (content_hash_value or "").split(":", 1)[-1].strip().lower()
    if not re.fullmatch(rf"[0-9a-f]{{{VERSION_HEX_LEN},}}", digest):
        raise LayoutError(f"cannot derive an adapter version from content hash '{content_hash_value}'")
    return f"{VERSION_PREFIX}{digest[:VERSION_HEX_LEN]}"


def adapter_version_uri(home_uri: str, content_hash_value: str) -> str:
    """<home>/v<hash12>/ — the canonical, immutable location of one adapter version."""
    parsed = parse_adapter_uri(home_uri)
    if parsed is None:
        raise LayoutError(f"not a canonical adapter prefix: {home_uri}")
    return s3_uri(parsed["bucket"], f"{parsed['home']}{adapter_version(content_hash_value)}/")


def finetune_prefix(project: str, name: str) -> str:
    """models/mlcc-<project>/<name>/ — a full fine-tune is a model in its own right."""
    return f"{MODELS_ROOT}/{FINETUNE_NAMESPACE_PREFIX}{_segment(project, 'project')}/{_segment(name, 'model name')}/"


def finetune_project_prefix(project: str) -> str:
    return f"{MODELS_ROOT}/{FINETUNE_NAMESPACE_PREFIX}{_segment(project, 'project')}/"


def artifacts_prefix(project: str, kind: str) -> str:
    """<project>/<kind>/ in the artifacts bucket (raw job output)."""
    if kind not in ARTIFACT_KINDS:
        raise LayoutError(f"unknown artifacts kind '{kind}' (one of {', '.join(ARTIFACT_KINDS)})")
    return f"{_segment(project, 'project')}/{kind}/"


def evaluator_key(name: str, filename: str = "lambda_function.py") -> str:
    return f"{EVALUATORS_ROOT}/{_segment(name, 'evaluator name')}/{filename}"


def staging_job_key(job_name: str, filename: str) -> str:
    return f"{STAGING_JOBS_ROOT}/{_segment(job_name, 'job name')}/{filename}"


def base_uri(bucket: str, hf_id: str) -> str:
    return s3_uri(bucket, base_prefix(hf_id))


def adapter_uri(bucket: str, hf_id: str, project: str, name: str) -> str:
    return s3_uri(bucket, adapter_prefix(base_prefix(hf_id), project, name))


def finetune_uri(bucket: str, project: str, name: str) -> str:
    return s3_uri(bucket, finetune_prefix(project, name))


def artifacts_uri(bucket: str, project: str, kind: str) -> str:
    return s3_uri(bucket, artifacts_prefix(project, kind))


def manifest_name(kind: str) -> str:
    return MODEL_MANIFEST if kind == "full_model" else ADAPTER_MANIFEST


def pod_path(mount_path: str, deployment_prefix: str, adapter_key_prefix: str) -> str:
    """The in-pod path of an adapter under the deployment's model mount, or ''."""
    root = deployment_prefix.strip("/")
    key = adapter_key_prefix.strip("/")
    if root and not key.startswith(root + "/"):
        return ""
    rest = key[len(root) + 1:] if root else key
    return f"{mount_path.rstrip('/')}/{rest}"


# ── Parsing ───────────────────────────────────────────────────────────────────
def split_uri(uri: str) -> tuple[str, str]:
    if not (uri or "").startswith("s3://"):
        raise LayoutError(f"not an s3:// URI: '{uri}'")
    bucket, _, key = uri[len("s3://"):].partition("/")
    if not bucket:
        raise LayoutError(f"no bucket in '{uri}'")
    return bucket, key


def model_id_from_base_prefix(key_prefix: str) -> str:
    """'models/<org>/<base>[/]' → '<org>/<base>' ('' when not a staged-model prefix)."""
    parts = key_prefix.strip("/").split("/")
    if len(parts) in (2, 3) and parts[0] == MODELS_ROOT and ADAPTER_SUBDIR not in parts \
            and not parts[1].startswith(FINETUNE_NAMESPACE_PREFIX):
        return "/".join(parts[1:])
    return ""


def parse_adapter_uri(uri: str) -> dict | None:
    """{bucket, base_prefix, base_model, project, name, version, home, prefix} for a canonical adapter URI.

    Accepts both forms: a content-addressed version <home>/v<hash12>/ (BL199) and an
    unversioned home <...>/.mlcc-adapters/<project>/<name>/ (written before BL199, or
    a hand copy) — `version` is '' for the latter. `home` is the name-level prefix,
    `prefix` the exact prefix given (normalized to one trailing slash).
    """
    try:
        bucket, key = split_uri(uri)
    except LayoutError:
        return None
    parts = key.strip("/").split("/")
    if ADAPTER_SUBDIR not in parts:
        return None
    i = parts.index(ADAPTER_SUBDIR)
    if len(parts) == i + 4 and is_version_segment(parts[i + 3]):
        version = parts[i + 3]
    elif len(parts) == i + 3:
        version = ""
    else:
        return None
    base = "/".join(parts[:i])
    return {
        "bucket": bucket,
        "base_prefix": base,
        "base_model": model_id_from_base_prefix(base),
        "project": parts[i + 1],
        "name": parts[i + 2],
        "version": version,
        "home": "/".join(parts[:i + 3]) + "/",
        "prefix": "/".join(parts) + "/",
    }


def parse_finetune_uri(uri: str) -> dict | None:
    try:
        bucket, key = split_uri(uri)
    except LayoutError:
        return None
    parts = key.strip("/").split("/")
    if len(parts) == 3 and parts[0] == MODELS_ROOT and parts[1].startswith(FINETUNE_NAMESPACE_PREFIX):
        return {"bucket": bucket, "project": parts[1][len(FINETUNE_NAMESPACE_PREFIX):], "name": parts[2],
                "prefix": "/".join(parts) + "/"}
    return None


# ── Base model id (catalog-mapped, never guessed) ─────────────────────────────
def _default_catalog_paths() -> list[str]:
    return [
        os.path.normpath(os.path.join(_HERE, "..", "..", ".tune_catalog.json")),  # generated project
        os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "config", "tune-catalog.json")),  # repo
    ]


def load_catalog(path: str | None = None) -> dict:
    for p in ([path] if path else _default_catalog_paths()):
        try:
            with open(p, encoding="utf-8") as f:
                return (json.load(f) or {}).get("models") or {}
        except (OSError, ValueError):
            continue
    return {}


def resolve_base_id(model_id: str, catalog: dict | None = None) -> str:
    """A tune/hub/JumpStart id or HF id → the HF id that names the base prefix."""
    mid = (model_id or "").strip()
    if not mid:
        raise LayoutError("no base model id (set MODEL_NAME / TUNE_MODEL_ID in do/config)")
    if mid.startswith("s3://"):
        _, key = split_uri(mid)
        hf = model_id_from_base_prefix(key)
        if hf:
            return hf
        raise LayoutError(f"'{mid}' is not a staged base-model prefix (models/<org>/<base>/)")
    cat = load_catalog() if catalog is None else catalog
    entry = cat.get(mid)
    if isinstance(entry, dict):
        hf = (entry.get("huggingFaceId") or "").strip()
        if not hf:
            raise LayoutError(f"tune catalog entry '{mid}' has no huggingFaceId")
        return _model_id_path(hf)
    if _HF_ID.match(mid):
        return mid
    raise LayoutError(
        f"cannot map base model '{mid}' to a Hugging Face id: it is not in the tune catalog "
        "(.tune_catalog.json) and is not an <org>/<name> id. Pass the HF id explicitly.")


# ── S3 helpers (client injected; boto3 by default) ────────────────────────────
def _client(region: str | None = None):
    import boto3  # noqa: PLC0415 — only needed for the AWS-calling subcommands
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")


def list_objects(s3, bucket: str, prefix: str) -> list[dict]:
    out: list[dict] = []
    token = None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kw)
        for o in resp.get("Contents") or []:
            out.append({"Key": o["Key"], "Size": int(o.get("Size") or 0), "ETag": str(o.get("ETag") or "").strip('"')})
        if not resp.get("IsTruncated"):
            return out
        token = resp.get("NextContinuationToken")


def content_hash(objects: list[dict], prefix: str) -> str:
    """sha256 over (relative key, size, ETag) of the payload files (manifests excluded)."""
    h = hashlib.sha256()
    rows = []
    for o in objects:
        rel = o["Key"][len(prefix):]
        if rel and rel.split("/")[-1] not in MANIFEST_FILES:
            rows.append(f"{rel}\t{o['Size']}\t{o['ETag']}")
    for r in sorted(rows):
        h.update(r.encode("utf-8") + b"\n")
    return "sha256:" + h.hexdigest()


def read_json(s3, bucket: str, key: str) -> dict | None:
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except Exception:  # noqa: BLE001 — absent / unreadable object == no document
        return None
    try:
        d = json.loads(body)
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def read_manifest(s3, uri: str) -> dict | None:
    bucket, key = split_uri(uri)
    root = key.rstrip("/") + "/"
    for name in MANIFEST_FILES:
        d = read_json(s3, bucket, root + name)
        if d is not None:
            return d
    return None


def _adapter_config_facts(cfg: dict | None) -> dict:
    if not cfg:
        return {"rank": None, "target_modules": None}
    ranks = [cfg.get("r")] + list((cfg.get("rank_pattern") or {}).values())
    ranks = [int(r) for r in ranks if isinstance(r, (int, float)) and not isinstance(r, bool)]
    tm = cfg.get("target_modules")
    return {"rank": max(ranks) if ranks else None, "target_modules": tm}


def build_manifest(*, kind: str, project: str, name: str, base_model: str, source: str,
                   content_hash_value: str, source_job: str = "", technique: str = "",
                   created_by: str = "", adapter_config: dict | None = None,
                   base_revision: str | None = None, previous: dict | None = None,
                   serving_copy_of: str = "", version: str = "") -> dict:
    m = {
        "schema": MANIFEST_SCHEMA,
        "artifact_kind": kind,
        "project": project,
        "name": name,
        "base_model": base_model,
        "base_revision": base_revision,
        "source": source,
        "source_job": source_job or None,
        "technique": technique or None,
        "content_hash": content_hash_value,
        "created_by": created_by or None,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if version:
        m["version"] = version  # BL199: the content-addressed directory this manifest sits in
    if kind == "lora_adapter":
        m.update(_adapter_config_facts(adapter_config))
    if previous and previous.get("content_hash") and previous.get("content_hash") != content_hash_value:
        m["previous_content_hash"] = previous["content_hash"]
    if serving_copy_of:
        m["serving_copy_of"] = serving_copy_of
    return m


def _safe_members(tf: tarfile.TarFile, dest: str):
    root = os.path.realpath(dest)
    for m in tf.getmembers():
        if not (m.isfile() or m.isdir()):
            continue  # no links / devices
        target = os.path.realpath(os.path.join(dest, m.name))
        if target != root and not target.startswith(root + os.sep):
            raise LayoutError(f"unsafe path in archive: {m.name}")
        yield m


ADAPTER_CONFIG = "adapter_config.json"


def _require_servable_adapter(kind: str, rels, source: str) -> None:
    """A LoRA adapter must have adapter_config.json at the TOP of its prefix.

    Both loaders read it there: the SMAI adapter sidecar (ArtifactResolver uses
    the downloaded directory only when adapter_config.json is directly in it) and
    vLLM's load-by-path on Kubernetes. A nested layout (a tarball with a top-level
    directory, or a job-output root above checkpoints/hf/) would publish a prefix
    that no loader can use, so it is refused before anything is written.
    """
    if kind != "lora_adapter":
        return
    rels = list(rels)
    if ADAPTER_CONFIG in rels:
        return
    nested = sorted(r for r in rels if r.split("/")[-1] == ADAPTER_CONFIG)
    hint = (f" It is nested at '{nested[0]}': point the source at that directory "
            "(or re-pack the archive without the top-level folder).") if nested else ""
    raise LayoutError(f"{source} is not a servable LoRA adapter: no {ADAPTER_CONFIG} at its top level.{hint}")


def _invalidate_manifest(s3, bucket: str, root: str, previous: dict | None) -> None:
    """Drop dest's manifest BEFORE the payload is rewritten (full models only).

    The manifest marks a complete promotion and carries the content hash the
    idempotency check trusts. Without this, a promotion interrupted mid-copy would
    leave the PREVIOUS manifest next to a half-overwritten payload, and a later
    promote of the previous source would answer "unchanged" over mixed files.
    A LoRA adapter never reaches this with a previous manifest: it is written to a
    fresh content-addressed version directory (BL199).
    """
    if previous is not None:
        _delete_keys(s3, bucket, [root + m for m in MANIFEST_FILES])


def _tarball_hash(s_key: str, head: dict) -> str:
    return "sha256:" + hashlib.sha256(
        f"{s_key.split('/')[-1]}\t{head.get('ContentLength')}\t{str(head.get('ETag') or '').strip(chr(34))}"
        .encode("utf-8")).hexdigest()


def _source_rel_skipped(source: str):
    """A predicate for source-relative keys that are not payload.

    Manifests are never payload. An UNVERSIONED canonical home used as a source
    (pre-BL199 adapter or hand copy) may also hold content-addressed version
    directories promoted into it later; those belong to other versions, not to it.
    """
    parsed = parse_adapter_uri(source)
    nested_versions = parsed is not None and not parsed["version"]

    def skip(rel: str) -> bool:
        if not rel or rel.endswith("/") or rel.split("/")[-1] in MANIFEST_FILES:
            return True
        return nested_versions and "/" in rel and is_version_segment(rel.split("/", 1)[0])
    return skip


def _resolve_target(dest: str, kind: str, src_hash: str) -> tuple[str, str]:
    """(target URI, version) for a promotion of content `src_hash` into `dest`.

    full_model → dest itself (no version). lora_adapter → the content-addressed
    version directory under dest's HOME (BL199); dest may be the home or a version
    directory, but a version directory only ever receives the content it is named for.
    """
    if parse_adapter_uri(dest) is None and parse_finetune_uri(dest) is None:
        raise LayoutError(f"refusing to promote into a non-canonical prefix: {dest}")
    if kind != "lora_adapter":
        return dest, ""
    parsed = parse_adapter_uri(dest)
    if parsed is None:
        raise LayoutError(f"a LoRA adapter must be promoted into a canonical adapter prefix: {dest}")
    version = adapter_version(src_hash)
    if parsed["version"] and parsed["version"] != version:
        raise LayoutError(f"refusing to write content {version} into version directory {dest}: "
                          "a version directory is never rewritten (promote into the adapter home instead)")
    return adapter_version_uri(s3_uri(parsed["bucket"], parsed["home"]), src_hash), version


def _guard_version_dir(target: str, version: str, previous: dict | None, src_hash: str) -> None:
    if version and previous is not None and previous.get("content_hash") != src_hash:
        raise LayoutError(f"{target} already holds different content ({previous.get('content_hash')}); "
                          "a version directory is never rewritten in place")


def promote(s3, *, source: str, dest: str, kind: str, project: str, name: str, base_model: str,
            source_job: str = "", technique: str = "", created_by: str = "",
            serving_copy_of: str = "") -> dict:
    """Publish `source` (an S3 prefix or a .tar.gz) to its canonical prefix.

    full_model: into `dest` itself. lora_adapter (BL199): into the content-addressed
    version directory <home of dest>/v<hash12>/ — identical content is the SAME
    version ("unchanged", nothing copied); different content is a NEW directory and
    every existing version is left untouched. A version directory is never rewritten
    in place. Every payload object is copied server-side, stale objects of an
    interrupted run of the same version are removed, and the manifest is written
    last (its presence marks a complete promotion; an interrupted run leaves none).
    A lora_adapter source must have adapter_config.json at its top level.
    Returns {"action": "copied"|"unchanged", "dest": <target>, "version", "manifest": {...}}.
    """
    if kind not in ("lora_adapter", "full_model"):
        raise LayoutError(f"unknown artifact kind '{kind}'")
    if parse_adapter_uri(dest) is None and parse_finetune_uri(dest) is None:
        raise LayoutError(f"refusing to promote into a non-canonical prefix: {dest}")
    s_bucket, s_key = split_uri(source)
    tarball = s_key.endswith((".tar.gz", ".tgz"))
    skip = _source_rel_skipped(source)
    if tarball:
        src_hash = _tarball_hash(s_key, s3.head_object(Bucket=s_bucket, Key=s_key))
        src_objects: list[dict] = []
        src_manifest = None
    else:
        s_root = s_key.rstrip("/") + "/"
        payload = [o for o in list_objects(s3, s_bucket, s_root) if not skip(o["Key"][len(s_root):])]
        if not payload:
            raise LayoutError(f"nothing to promote: {source} is empty or does not exist")
        src_manifest = read_manifest(s3, source)
        src_hash = (src_manifest or {}).get("content_hash") or content_hash(payload, s_root)
        src_objects = payload
    target, version = _resolve_target(dest, kind, src_hash)
    d_bucket, d_key = split_uri(target)
    d_root = d_key.rstrip("/") + "/"
    previous = read_manifest(s3, target)
    if previous and previous.get("content_hash") == src_hash:
        return {"action": "unchanged", "dest": target, "version": version, "manifest": previous}
    _guard_version_dir(target, version, previous, src_hash)

    written: set[str] = set()
    adapter_cfg = None
    if tarball:
        tmp = tempfile.mkdtemp(prefix="mlcc-promote-")
        try:
            arc = os.path.join(tmp, "a.tar.gz")
            s3.download_file(s_bucket, s_key, arc)
            out = os.path.join(tmp, "x")
            os.makedirs(out)
            with tarfile.open(arc, "r:gz") as tf:
                members = list(_safe_members(tf, out))
                try:
                    tf.extractall(out, members=members, filter="data")  # noqa: S202 — members vetted
                except TypeError:  # Python without tarfile extraction filters
                    tf.extractall(out, members=members)  # noqa: S202 — members vetted
            files = []
            for dirpath, _, fnames in os.walk(out):
                for fn in fnames:
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, out).replace(os.sep, "/")
                    if rel.split("/")[-1] not in MANIFEST_FILES:
                        files.append((full, rel))
            if not files:
                raise LayoutError(f"nothing to promote: {source} contained no files")
            _require_servable_adapter(kind, (rel for _, rel in files), source)
            _invalidate_manifest(s3, d_bucket, d_root, previous)
            for full, rel in sorted(files, key=lambda f: f[1]):
                s3.upload_file(full, d_bucket, d_root + rel)
                written.add(d_root + rel)
                if rel == ADAPTER_CONFIG:
                    with open(full, encoding="utf-8") as f:
                        try:
                            adapter_cfg = json.load(f)
                        except ValueError:
                            adapter_cfg = None
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        s_root = s_key.rstrip("/") + "/"
        _require_servable_adapter(kind, (o["Key"][len(s_root):] for o in src_objects), source)
        _invalidate_manifest(s3, d_bucket, d_root, previous)
        for o in src_objects:
            rel = o["Key"][len(s_root):]
            s3.copy({"Bucket": s_bucket, "Key": o["Key"]}, d_bucket, d_root + rel)
            written.add(d_root + rel)
        adapter_cfg = read_json(s3, s_bucket, s_root + ADAPTER_CONFIG)
    if not written:
        raise LayoutError(f"nothing to promote: {source} contained no files")
    stale = [o["Key"] for o in list_objects(s3, d_bucket, d_root)
             if o["Key"] not in written and o["Key"][len(d_root):] not in MANIFEST_FILES]
    _delete_keys(s3, d_bucket, stale)
    manifest = build_manifest(
        kind=kind, project=project, name=name, base_model=base_model, source=source,
        content_hash_value=src_hash, source_job=source_job, technique=technique,
        created_by=created_by, adapter_config=adapter_cfg,
        base_revision=(src_manifest or {}).get("base_revision"), previous=previous,
        serving_copy_of=serving_copy_of, version=version)
    s3.put_object(Bucket=d_bucket, Key=d_root + manifest_name(kind),
                  Body=json.dumps(manifest, indent=2).encode("utf-8"), ContentType="application/json")
    return {"action": "copied", "dest": target, "version": version, "manifest": manifest}


def plan_promote(s3, *, source: str, dest: str, kind: str) -> dict:
    """READ-ONLY dry run of promote(): which keys would be copied where.

    Lists the source (a tarball is downloaded to a temp dir and its member list
    read, never extracted), the target's current objects and manifest, and
    reports the action promote() would take ("unchanged" | "copy" | "refused"),
    the target (for an adapter: the content-addressed version directory it would
    create or reuse), every source → destination key, the stale target keys it
    would delete, and the manifest key it would write last. Makes no S3 write.
    """
    if kind not in ("lora_adapter", "full_model"):
        raise LayoutError(f"unknown artifact kind '{kind}'")
    if parse_adapter_uri(dest) is None and parse_finetune_uri(dest) is None:
        raise LayoutError(f"refusing to plan a promotion into a non-canonical prefix: {dest}")
    s_bucket, s_key = split_uri(source)
    if s_key.endswith((".tar.gz", ".tgz")):
        src_hash = _tarball_hash(s_key, s3.head_object(Bucket=s_bucket, Key=s_key))
        tmp = tempfile.mkdtemp(prefix="mlcc-plan-")
        try:
            arc = os.path.join(tmp, "a.tar.gz")
            s3.download_file(s_bucket, s_key, arc)
            with tarfile.open(arc, "r:gz") as tf:
                rels = sorted(os.path.normpath(m.name).replace(os.sep, "/")
                              for m in _safe_members(tf, os.path.join(tmp, "x")) if m.isfile())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        rels = [r for r in rels if r.split("/")[-1] not in MANIFEST_FILES]
        pairs = [(f"{source}#{r}", r) for r in rels]
    else:
        s_root = s_key.rstrip("/") + "/"
        skip = _source_rel_skipped(source)
        payload = [o for o in list_objects(s3, s_bucket, s_root) if not skip(o["Key"][len(s_root):])]
        src_manifest = read_manifest(s3, source)
        src_hash = (src_manifest or {}).get("content_hash") or content_hash(payload, s_root)
        pairs = [(s3_uri(s_bucket, o["Key"]), o["Key"][len(s_root):]) for o in payload]
    refused = ""
    if not pairs:
        refused = f"nothing to promote: {source} is empty or does not exist"
    else:
        try:
            _require_servable_adapter(kind, (r for _, r in pairs), source)
        except LayoutError as exc:
            refused = str(exc)
    target, version = _resolve_target(dest, kind, src_hash)
    d_bucket, d_key = split_uri(target)
    d_root = d_key.rstrip("/") + "/"
    previous = read_manifest(s3, target)
    if not refused:
        try:
            _guard_version_dir(target, version, None if (previous or {}).get("content_hash") == src_hash
                               else previous, src_hash)
        except LayoutError as exc:
            refused = str(exc)
    targets = {d_root + r for _, r in pairs}
    stale = sorted(o["Key"] for o in list_objects(s3, d_bucket, d_root)
                   if o["Key"] not in targets and o["Key"][len(d_root):] not in MANIFEST_FILES)
    unchanged = bool(previous and previous.get("content_hash") == src_hash)
    return {
        "action": "unchanged" if unchanged else ("refused" if refused else "copy"),
        "refused": refused,
        "source": source,
        "dest": s3_uri(d_bucket, d_root),
        "version": version,
        "content_hash": src_hash,
        "dest_content_hash": (previous or {}).get("content_hash"),
        "copies": [] if unchanged or refused else [{"from": f, "to": s3_uri(d_bucket, d_root + r)} for f, r in pairs],
        "stale_deletes": [] if unchanged or refused else [s3_uri(d_bucket, k) for k in stale],
        "manifest": "" if unchanged or refused else s3_uri(d_bucket, d_root + manifest_name(kind)),
    }


def publish_local(s3, *, local_dir: str, dest: str, kind: str, project: str, name: str,
                  base_model: str, source: str, created_by: str = "") -> dict:
    """Upload a local adapter/model directory (e.g. a --from-hub download) to its canonical prefix.

    A lora_adapter lands in the content-addressed version directory under dest's
    home, exactly like promote() (BL199).
    """
    if parse_adapter_uri(dest) is None and parse_finetune_uri(dest) is None:
        raise LayoutError(f"refusing to publish into a non-canonical prefix: {dest}")
    rows, files = [], []
    for dirpath, _, fnames in os.walk(local_dir):
        for fn in fnames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, local_dir).replace(os.sep, "/")
            if rel.split("/")[-1] in MANIFEST_FILES:
                continue
            with open(full, "rb") as f:
                rows.append(f"{rel}\t{os.path.getsize(full)}\t{hashlib.md5(f.read()).hexdigest()}")  # noqa: S324
            files.append((full, rel))
    if not files:
        raise LayoutError(f"nothing to publish: {local_dir} is empty")
    _require_servable_adapter(kind, (rel for _, rel in files), source)
    src_hash = "sha256:" + hashlib.sha256("\n".join(sorted(rows)).encode("utf-8")).hexdigest()
    target, version = _resolve_target(dest, kind, src_hash)
    d_bucket, d_key = split_uri(target)
    d_root = d_key.rstrip("/") + "/"
    previous = read_manifest(s3, target)
    if previous and previous.get("content_hash") == src_hash:
        return {"action": "unchanged", "dest": target, "version": version, "manifest": previous}
    _guard_version_dir(target, version, previous, src_hash)
    _invalidate_manifest(s3, d_bucket, d_root, previous)
    written = set()
    for full, rel in files:
        s3.upload_file(full, d_bucket, d_root + rel)
        written.add(d_root + rel)
    stale = [o["Key"] for o in list_objects(s3, d_bucket, d_root)
             if o["Key"] not in written and o["Key"][len(d_root):] not in MANIFEST_FILES]
    _delete_keys(s3, d_bucket, stale)
    cfg = None
    cfg_path = os.path.join(local_dir, "adapter_config.json")
    if os.path.isfile(cfg_path):
        with open(cfg_path, encoding="utf-8") as f:
            try:
                cfg = json.load(f)
            except ValueError:
                cfg = None
    manifest = build_manifest(kind=kind, project=project, name=name, base_model=base_model, source=source,
                              content_hash_value=src_hash, created_by=created_by, adapter_config=cfg,
                              previous=previous, version=version)
    s3.put_object(Bucket=d_bucket, Key=d_root + manifest_name(kind),
                  Body=json.dumps(manifest, indent=2).encode("utf-8"), ContentType="application/json")
    return {"action": "copied", "dest": target, "version": version, "manifest": manifest}


def _delete_keys(s3, bucket: str, keys: list[str]) -> int:
    n = 0
    for i in range(0, len(keys), 1000):
        chunk = keys[i:i + 1000]
        if chunk:
            s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True})
            n += len(chunk)
    return n


def delete_prefix(s3, uri: str) -> int:
    """Delete one canonical artifact prefix (adapter or fine-tune). Refuses anything else."""
    if parse_adapter_uri(uri) is None and parse_finetune_uri(uri) is None:
        raise LayoutError(f"refusing to delete a non-canonical prefix: {uri}")
    bucket, key = split_uri(uri)
    root = key.rstrip("/") + "/"
    return _delete_keys(s3, bucket, [o["Key"] for o in list_objects(s3, bucket, root)])


def is_project_owned_key(key: str, project: str) -> bool:
    """True ONLY for this project's adapters (any base) and its full fine-tunes."""
    parts = key.split("/")
    if not parts or parts[0] != MODELS_ROOT:
        return False
    if len(parts) >= 3 and parts[1] == FINETUNE_NAMESPACE_PREFIX + project:
        return True
    if ADAPTER_SUBDIR in parts:
        i = parts.index(ADAPTER_SUBDIR)
        # models/<org>/<base>/.mlcc-adapters/<project>/<name>/[v<hash12>/]<file...>
        # (every version of the project's adapters, and unversioned pre-BL199 homes)
        return i >= 2 and len(parts) >= i + 4 and parts[i + 1] == project
    return False


def clean_plan(s3, bucket: str, project: str) -> dict:
    """The keys `do/clean adapters` may delete: own project's adapters + fine-tunes only."""
    _segment(project, "project")
    keys = [o["Key"] for o in list_objects(s3, bucket, f"{MODELS_ROOT}/")]
    own = [k for k in keys if is_project_owned_key(k, project)]
    prefixes = sorted({
        (k.split(f"/{ADAPTER_SUBDIR}/{project}/")[0] + f"/{ADAPTER_SUBDIR}/{project}/")
        if f"/{ADAPTER_SUBDIR}/{project}/" in k else finetune_project_prefix(project)
        for k in own
    })
    return {"bucket": bucket, "project": project, "prefixes": prefixes, "keys": own}


# ── CLI ───────────────────────────────────────────────────────────────────────
def _print(d) -> None:
    print(json.dumps(d))


def _cli(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="s3_layout.py")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, *flags, optional=()):
        sp = sub.add_parser(name)
        for f in flags:
            sp.add_argument(f, required=True)
        for f in optional:
            sp.add_argument(f, default="")
        return sp

    add("resolve-base", "--model", optional=("--catalog",))
    add("base-uri", "--bucket", "--model", optional=("--catalog",))
    add("adapter-uri", "--bucket", "--model", "--project", "--name", optional=("--catalog",))
    add("finetune-uri", "--bucket", "--project", "--name")
    add("artifacts-uri", "--bucket", "--project", "--kind")
    add("evaluator-key", "--name")
    add("parse", "--uri")
    add("promote", "--source", "--dest", "--kind", "--project", "--name", "--base-model",
        optional=("--source-job", "--technique", "--created-by", "--region", "--catalog"))
    add("promote-plan", "--source", "--dest", "--kind", optional=("--region",))
    add("publish-local", "--dir", "--dest", "--kind", "--project", "--name", "--base-model", "--source",
        optional=("--created-by", "--region", "--catalog"))
    add("manifest", "--uri", optional=("--region",))
    add("clean-plan", "--bucket", "--project", optional=("--region",))
    add("clean", "--bucket", "--project", optional=("--region",))
    a = p.parse_args(argv)

    def cat():
        return load_catalog(a.catalog or None)

    try:
        if a.cmd == "resolve-base":
            _print({"base_model": resolve_base_id(a.model, cat())})
        elif a.cmd == "base-uri":
            _print({"uri": base_uri(a.bucket, resolve_base_id(a.model, cat()))})
        elif a.cmd == "adapter-uri":
            _print({"uri": adapter_uri(a.bucket, resolve_base_id(a.model, cat()), a.project, a.name)})
        elif a.cmd == "finetune-uri":
            _print({"uri": finetune_uri(a.bucket, a.project, a.name)})
        elif a.cmd == "artifacts-uri":
            _print({"uri": artifacts_uri(a.bucket, a.project, a.kind)})
        elif a.cmd == "evaluator-key":
            _print({"key": evaluator_key(a.name)})
        elif a.cmd == "parse":
            pa, pf = parse_adapter_uri(a.uri), parse_finetune_uri(a.uri)
            canon = pa or pf
            # canonical_uri: the same prefix normalized to ONE trailing slash — what
            # an adapter IC ArtifactUrl must be (without it, an S3 prefix match also
            # takes sibling names like <name>-v2/; TROUBLESHOOTING "Failed to download").
            # version: the content-addressed version segment ('' for an unversioned,
            # pre-BL199 home); home_uri: the adapter's name-level home.
            _print({"adapter": pa, "finetune": pf,
                    "canonical_uri": s3_uri(canon["bucket"], canon["prefix"]) if canon else "",
                    "version": (pa or {}).get("version", ""),
                    "home_uri": s3_uri(pa["bucket"], pa["home"]) if pa else ""})
        elif a.cmd == "promote":
            res = promote(_client(a.region or None), source=a.source, dest=a.dest, kind=a.kind,
                          project=a.project, name=a.name, base_model=resolve_base_id(a.base_model, cat()),
                          source_job=a.source_job, technique=a.technique, created_by=a.created_by)
            _print(res)
        elif a.cmd == "promote-plan":
            _print(plan_promote(_client(a.region or None), source=a.source, dest=a.dest, kind=a.kind))
        elif a.cmd == "publish-local":
            _print(publish_local(_client(a.region or None), local_dir=a.dir, dest=a.dest, kind=a.kind,
                                 project=a.project, name=a.name,
                                 base_model=resolve_base_id(a.base_model, cat()), source=a.source,
                                 created_by=a.created_by))
        elif a.cmd == "manifest":
            _print({"manifest": read_manifest(_client(a.region or None), a.uri)})
        elif a.cmd in ("clean-plan", "clean"):
            s3 = _client(a.region or None)
            plan = clean_plan(s3, a.bucket, a.project)
            if a.cmd == "clean":
                plan["deleted"] = _delete_keys(s3, a.bucket, plan["keys"])
            _print(plan)
    except LayoutError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 — surface the AWS error text verbatim
        if exc.__class__.__name__ in ("NameError", "AttributeError", "TypeError"):
            raise
        print(f"❌ S3 error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
