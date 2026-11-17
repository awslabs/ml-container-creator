#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""adapter_delivery.py — get a LoRA adapter where a k8s pod can load it by path.

Wave 6.1 R1 (BL189) + bucket consolidation R3 (Option D). vLLM loads LoRA
adapters from a LOCAL path; the serving container has no AWS credentials. On
hyperpod-eks / eks the only S3-backed path the pod sees is the model mount, so
the target descriptor declares (targets.d/<t>/manifest.json `adapter_delivery`,
read via target_manifest.py):

    {strategy: model-prefix, mount_path: /opt/ml/model, subdir: <s3_layout.ADAPTER_SUBDIR>}

The CANONICAL adapter is composed by s3_layout.py (the single layout module):
the content-addressed version <base prefix>/.mlcc-adapters/<project>/<name>/v<hash12>/
in the core bucket (BL199), keyed by the base the adapter was trained on. For a
deployment of that base the canonical adapter is already on the mount, so
delivery is "load by path" (the vLLM lora_name stays <name>):

  s3://<core>/models/<org>/<base>/.mlcc-adapters/<project>/<name>/v<hash12>/   (in S3)
  /opt/ml/model/.mlcc-adapters/<project>/<name>/v<hash12>                      (in the pod)

An unversioned home written before BL199 (or a hand copy) is still a canonical
adapter and loads by its own path.

Plan (R1.3), decided from config / the live IEC BEFORE any copy:
  - not yet canonical (tune/train raw output, --from-weights, --from-hub, registry)
      → promote into the canonical home of the ADAPTER's base (s3_layout.promote
        picks the version directory from the content hash);
  - canonical under THIS deployment's model prefix → load by path, no copy;
  - canonical under a DIFFERENT prefix → copy into this deployment's
      .mlcc-adapters/<project>/<name>/v<hash12>/ (a serving copy, marked
      `serving_copy_of` in its manifest; versioned like its source) ONLY when the
      base id (+ revision, when both are known) matches; otherwise refuse as an
      incompatible base.
When a promotion or copy is planned, the version (so the pod path) is decided by
that step: the plan's "path" is "" and "path_home" names the home; deliver()
returns the final path.
`do/adapter remove` deletes only serving copies it made (remove-copy, every
version of them); the canonical adapter is never deleted here (that is
`do/clean adapters`).

CLI (stdlib + boto3 for the S3 subcommands):
    adapter_delivery.py model-base --target T [--iec-json FILE]
    adapter_delivery.py local-path --target T --uri U --project P --name N
                        --source-type S --bucket B --prefix X --prefetch true|false
    adapter_delivery.py deliver   (local-path flags) --core-bucket C --adapter-base ID
                        [--deployment-model ID] [--source-job J] [--technique T]
                        [--created-by C] [--region R] [--dry-run]
        -> JSON {"path", "path_home", "canonical", "promote_to", "copy_to", "actions": [...]} (exit 0)
           refusal + fix (exit 3), unmapped base / layout error (exit 2), S3 error (exit 1)
    adapter_delivery.py remove-copy --bucket B --prefix X --project P --name N [--region R]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import s3_layout  # noqa: E402
import target_manifest  # noqa: E402


class DeliveryRefused(Exception):
    """The adapter cannot be delivered to this deployment; .fix says how."""

    def __init__(self, message: str, fix: str = ""):
        super().__init__(message)
        self.fix = fix


def model_base_from_iec(iec: dict | None) -> dict:
    """{source_type, bucket, prefix, prefetch} from a live InferenceEndpointConfig."""
    msc = ((iec or {}).get("spec") or {}).get("modelSourceConfig") or {}
    prefetch = msc.get("prefetchEnabled")
    return {
        "source_type": msc.get("modelSourceType") or "",
        "bucket": (msc.get("s3Storage") or {}).get("bucketName") or "",
        "prefix": str(msc.get("modelLocation") or "").strip("/"),
        "prefetch": "" if prefetch is None else ("true" if prefetch else "false"),
    }


def model_base_from_env(env: dict) -> dict:
    """eks: the S3 model mount (EKS_MODEL_MOUNT=s3) of STAGED_MODEL_PATH."""
    staged = (env.get("STAGED_MODEL_PATH") or "").strip()
    if env.get("EKS_MODEL_MOUNT") != "s3" or not staged.startswith("s3://"):
        return {"source_type": "", "bucket": "", "prefix": "", "prefetch": ""}
    bucket, _, prefix = staged[len("s3://"):].partition("/")
    return {"source_type": "s3", "bucket": bucket, "prefix": prefix.strip("/"), "prefetch": "false"}


def deployment_adapter_uri(base: dict, project: str, name: str) -> str:
    """This deployment's adapter HOME (canonical when the deployment serves the adapter's base)."""
    return s3_layout.s3_uri(base["bucket"], s3_layout.adapter_prefix(base.get("prefix", ""), project, name))


def _check_deliverable(target: str, base: dict, delivery: dict) -> None:
    """The R1.4 refusals — decided from config / the live IEC before any S3 or engine call."""
    if delivery.get("strategy") != "model-prefix":
        raise DeliveryRefused(
            f"{target} declares no adapter delivery strategy; an s3:// adapter cannot be loaded by path.",
            "Load adapters on this target with its own mechanism.")
    if delivery.get("subdir") != s3_layout.ADAPTER_SUBDIR:
        raise DeliveryRefused(
            f"{target} descriptor adapter_delivery.subdir '{delivery.get('subdir')}' disagrees with "
            f"s3_layout.ADAPTER_SUBDIR '{s3_layout.ADAPTER_SUBDIR}'.", "Fix the target descriptor.")
    if base.get("source_type") != "s3" or not base.get("bucket"):
        if target in ("hyperpod-eks", "hyperpod"):
            raise DeliveryRefused(
                "this deployment's model is not served from S3 (Hugging Face / model-package source), so "
                "the pod has no S3 mount to read adapters from.",
                "Stage the model to S3 and redeploy: ./do/stage && ./do/deploy --target hyperpod-eks --force")
        raise DeliveryRefused(
            "this eks deployment has no S3 model mount, so the pod cannot read adapters from S3.",
            "Enable the S3 model mount (export EKS_MODEL_MOUNT=s3 with a staged model, ./do/stage) "
            "and redeploy: ./do/deploy --target eks --force")
    if base.get("prefetch") == "true":
        raise DeliveryRefused(
            "the running InferenceEndpointConfig still has prefetchEnabled: true — the worker reads a RAM "
            "copy of the model taken at start, so adapters added under the model prefix are not visible.",
            "Redeploy with LoRA on (MLCC sets prefetchEnabled: false for LoRA + S3): "
            "./do/deploy --target hyperpod-eks --force (add --surge-node on a single-node instance group)")


def _pod_path_if_mounted(uri: str, base: dict, delivery: dict) -> str:
    try:
        bucket, key = s3_layout.split_uri(uri)
    except s3_layout.LayoutError:
        return ""
    if bucket != base.get("bucket"):
        return ""
    root = s3_layout.adapters_root(base.get("prefix", ""))
    norm = key.rstrip("/") + "/"
    if not norm.startswith(root) or len(norm) <= len(root):
        return ""
    return s3_layout.pod_path(delivery.get("mount_path", ""), base.get("prefix", ""), norm)


def local_path(target: str, uri: str, project: str, name: str, base: dict,
               delivery: dict | None = None) -> str:
    """The in-pod path of an adapter ALREADY under this deployment's prefix, else DeliveryRefused."""
    delivery = delivery if delivery is not None else target_manifest.adapter_delivery(target)
    if not uri.startswith("s3://"):
        return uri.rstrip("/")  # already a path inside the container
    _check_deliverable(target, base, delivery)
    path = _pod_path_if_mounted(uri, base, delivery)
    if path:
        return path
    raise DeliveryRefused(
        f"{uri} is outside this deployment's model prefix "
        f"(s3://{base['bucket']}/{base.get('prefix', '')}/{s3_layout.ADAPTER_SUBDIR}/)",
        f"./do/adapter add {name} promotes it into the canonical prefix "
        f"({deployment_adapter_uri(base, project, name)}) automatically.")


def plan_delivery(target: str, uri: str, project: str, name: str, base: dict, *,
                  core_bucket: str = "", adapter_base: str = "", deployment_model: str = "",
                  canonical_manifest: dict | None = None, delivery: dict | None = None) -> dict:
    """Decide promote / load / copy / refuse without touching S3 (see the module doc).

    adapter_base       — HF id of the base the adapter was trained on (non-canonical sources)
    deployment_model   — HF id this deployment serves (fallback when its prefix isn't models/<id>)
    canonical_manifest — manifest of the canonical adapter when `uri` is canonical
    Returns {"promote_to", "canonical", "copy_to", "path", "path_home"} (unused steps are "").
    promote_to / copy_to are adapter HOMES: the promotion picks the content-addressed
    version, so "path" is "" until deliver() runs and "path_home" is the pod path of
    the home the version will sit under.
    """
    delivery = delivery if delivery is not None else target_manifest.adapter_delivery(target)
    plan = {"promote_to": "", "canonical": "", "copy_to": "", "path": "", "path_home": ""}
    if not uri.startswith("s3://"):
        plan["path"] = uri.rstrip("/")
        return plan
    _check_deliverable(target, base, delivery)
    path = _pod_path_if_mounted(uri, base, delivery)
    if path:  # already on this deployment's mount (canonical, or a copy made earlier)
        plan.update(canonical=uri.rstrip("/") + "/", path=path)
        return plan
    parsed = s3_layout.parse_adapter_uri(uri)
    if parsed is None:
        if not core_bucket:
            raise DeliveryRefused(
                "promoting this adapter needs the core bucket, but the active profile has no coreS3Bucket.",
                "Refresh the profile: ml-container-creator bootstrap update --module core")
        try:
            hf = s3_layout.resolve_base_id(adapter_base)
        except s3_layout.LayoutError as exc:
            raise DeliveryRefused(f"cannot place the adapter under its base model: {exc}",
                                  "Set TUNE_MODEL_ID / MODEL_NAME to a catalogued or <org>/<name> id.") from exc
        canonical = s3_layout.adapter_uri(core_bucket, hf, project, name)
        plan["promote_to"] = canonical
        plan["canonical"] = canonical
        src_base = hf
        path = _pod_path_if_mounted(canonical, base, delivery)
        if path:
            plan["path_home"] = path
            return plan
    else:
        plan["canonical"] = uri.rstrip("/") + "/"
        src_base = (canonical_manifest or {}).get("base_model") or parsed["base_model"]
    # Base-prefix mismatch: a serving copy only for the SAME base (+ revision).
    dep_base = s3_layout.model_id_from_base_prefix(base.get("prefix", "")) or (deployment_model or "")
    src_rev = (canonical_manifest or {}).get("base_revision")
    if not src_base or not dep_base or src_base != dep_base:
        raise DeliveryRefused(
            f"adapter '{name}' was trained on '{src_base or 'unknown'}' but this deployment serves "
            f"'{dep_base or 'unknown'}' (prefix {base.get('prefix', '')}); refusing an incompatible base.",
            "Deploy the adapter's base model, or tune an adapter on this deployment's base.")
    if src_rev and base.get("revision") and src_rev != base.get("revision"):
        raise DeliveryRefused(
            f"adapter '{name}' was trained on revision {src_rev} of {src_base}; this deployment serves "
            f"revision {base.get('revision')}.", "Deploy the matching revision of the base model.")
    plan["copy_to"] = deployment_adapter_uri(base, project, name)
    plan["path_home"] = s3_layout.pod_path(delivery.get("mount_path", ""), base.get("prefix", ""),
                                           s3_layout.adapter_prefix(base.get("prefix", ""), project, name))
    return plan


def deliver(s3, target: str, uri: str, project: str, name: str, base: dict, *,
            core_bucket: str = "", adapter_base: str = "", deployment_model: str = "",
            source_job: str = "", technique: str = "", created_by: str = "do/adapter",
            delivery: dict | None = None, dry_run: bool = False) -> dict:
    """plan_delivery + execute (promote, then copy on a base-prefix mismatch).

    Both steps write a content-addressed version directory; the returned "canonical"
    is the promoted version and "path" the in-pod path of the version that is loaded.
    """
    delivery = delivery if delivery is not None else target_manifest.adapter_delivery(target)
    manifest = None
    if uri.startswith("s3://") and s3_layout.parse_adapter_uri(uri) is not None and not dry_run:
        manifest = s3_layout.read_manifest(s3, uri)
    plan = plan_delivery(target, uri, project, name, base, core_bucket=core_bucket,
                         adapter_base=adapter_base, deployment_model=deployment_model,
                         canonical_manifest=manifest, delivery=delivery)
    actions: list[str] = []
    if dry_run:
        return {**plan, "actions": ["dry-run"]}
    hf = ""
    if plan["promote_to"]:
        hf = s3_layout.resolve_base_id(adapter_base)
        res = s3_layout.promote(s3, source=uri, dest=plan["promote_to"], kind="lora_adapter",
                                project=project, name=name, base_model=hf, source_job=source_job,
                                technique=technique, created_by=created_by)
        actions.append(f"promote:{res['action']}")
        manifest = res["manifest"]
        plan["canonical"] = res["dest"]
        if not plan["copy_to"]:
            plan["path"] = _pod_path_if_mounted(res["dest"], base, delivery)
    if plan["copy_to"]:
        existing = s3_layout.read_manifest(s3, plan["copy_to"])
        if existing and not existing.get("serving_copy_of") and \
                existing.get("content_hash") != (manifest or {}).get("content_hash"):
            raise DeliveryRefused(
                f"{plan['copy_to']} already holds a different canonical adapter named '{name}'.",
                f"Add it under another name: ./do/adapter add <other-name> --from-weights {plan['canonical']}")
        res = s3_layout.promote(s3, source=plan["canonical"], dest=plan["copy_to"], kind="lora_adapter",
                                project=project, name=name,
                                base_model=(manifest or {}).get("base_model") or hf or deployment_model,
                                source_job=(manifest or {}).get("source_job") or source_job,
                                technique=(manifest or {}).get("technique") or technique,
                                created_by=created_by, serving_copy_of=plan["canonical"])
        actions.append(f"copy:{res['action']}")
        plan["path"] = _pod_path_if_mounted(res["dest"], base, delivery)
    if not plan["path"]:
        raise s3_layout.LayoutError(f"adapter '{name}' was delivered but its pod path could not be derived")
    return {**plan, "actions": actions or ["load"]}


def remove_copy(s3, base: dict, project: str, name: str) -> dict:
    """Delete this deployment's serving copies of <name> (every version) if do/adapter made them.

    Each version directory under the home (and an unversioned pre-BL199 copy at the
    home itself) is judged by its own manifest: only one marked `serving_copy_of`
    is deleted; a canonical adapter (no such mark, or no manifest) is never touched.
    """
    uri = deployment_adapter_uri(base, project, name)
    bucket, key = s3_layout.split_uri(uri)
    groups: dict[str, list[str]] = {}
    for o in s3_layout.list_objects(s3, bucket, key):
        rel = o["Key"][len(key):]
        head = rel.split("/", 1)[0]
        groups.setdefault(head if "/" in rel and s3_layout.is_version_segment(head) else "", []).append(o["Key"])
    deleted, copy_of, kept = 0, "", []
    for version, keys in sorted(groups.items()):
        m = s3_layout.read_manifest(s3, s3_layout.s3_uri(bucket, key + (version + "/" if version else "")))
        if m and m.get("serving_copy_of"):
            deleted += s3_layout._delete_keys(s3, bucket, keys)  # noqa: SLF001 — same layout family
            copy_of = copy_of or m["serving_copy_of"]
        else:
            kept.append(version or "unversioned")
    out = {"deleted": deleted, "uri": uri}
    if copy_of:
        out["copy_of"] = copy_of
    if not deleted:
        out["kept"] = "canonical" if kept else "absent"
    return out


def _s3(region: str):
    import boto3  # noqa: PLC0415
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")


def _cli(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="adapter_delivery.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    mb = sub.add_parser("model-base")
    mb.add_argument("--target", required=True)
    mb.add_argument("--iec-json", default="")
    for cmd in ("local-path", "deliver"):
        lp = sub.add_parser(cmd)
        for flag in ("--target", "--uri", "--project", "--name"):
            lp.add_argument(flag, required=True)
        for flag in ("--source-type", "--bucket", "--prefix", "--prefetch", "--core-bucket", "--adapter-base",
                     "--deployment-model", "--source-job", "--technique", "--created-by", "--region"):
            lp.add_argument(flag, default="")
        lp.add_argument("--dry-run", action="store_true")
    rc = sub.add_parser("remove-copy")
    for flag in ("--bucket", "--prefix", "--project", "--name"):
        rc.add_argument(flag, required=True)
    rc.add_argument("--region", default="")
    args = p.parse_args(argv)

    if args.cmd == "model-base":
        if target_manifest.resolve_target(args.target) == "hyperpod-eks":
            iec = None
            if args.iec_json:
                try:
                    with open(args.iec_json, encoding="utf-8") as f:
                        iec = json.load(f)
                except (OSError, ValueError):
                    iec = None
            print(json.dumps(model_base_from_iec(iec)))
        else:
            print(json.dumps(model_base_from_env(dict(os.environ))))
        return 0

    if args.cmd == "remove-copy":
        try:
            print(json.dumps(remove_copy(_s3(args.region), {"bucket": args.bucket, "prefix": args.prefix.strip("/")},
                                         args.project, args.name)))
        except s3_layout.LayoutError as exc:
            print(f"❌ {exc}", file=sys.stderr)
            return 2
        except Exception as exc:  # noqa: BLE001 — surface the AWS error verbatim
            if exc.__class__.__name__ in ("NameError", "AttributeError", "TypeError"):
                raise
            print(f"❌ S3 error: {exc}", file=sys.stderr)
            return 1
        return 0

    base = {"source_type": args.source_type, "bucket": args.bucket, "prefix": args.prefix.strip("/"),
            "prefetch": args.prefetch}
    try:
        if args.cmd == "local-path":
            print(local_path(args.target, args.uri, args.project, args.name, base))
        else:
            needs_s3 = not args.dry_run and args.uri.startswith("s3://")
            res = deliver(_s3(args.region) if needs_s3 else None, args.target, args.uri, args.project,
                          args.name, base, core_bucket=args.core_bucket, adapter_base=args.adapter_base,
                          deployment_model=args.deployment_model, source_job=args.source_job,
                          technique=args.technique, created_by=args.created_by or "do/adapter",
                          dry_run=args.dry_run)
            print(json.dumps(res))
    except DeliveryRefused as exc:
        print(f"❌ Cannot deliver adapter '{args.name}' to this {args.target} deployment: {exc}")
        if exc.fix:
            print(f"   Fix: {exc.fix}")
        return 3
    except s3_layout.LayoutError as exc:
        print(f"❌ {exc}")
        return 2
    except Exception as exc:  # noqa: BLE001
        if exc.__class__.__name__ in ("NameError", "AttributeError", "TypeError"):
            raise
        print(f"❌ S3 error while delivering '{args.name}': {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
