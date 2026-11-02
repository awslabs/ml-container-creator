# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""InferenceAmiVersion resolver for deploy-time shell callers (BL209).

Purpose: decide which SageMaker InferenceAmiVersion an endpoint variant may use,
from the AWS compatibility table copied into fleet-drivers.json
(ami_versions[*].default_families / override_families, sourced from
https://docs.aws.amazon.com/sagemaker/latest/dg/inference-gpu-drivers.html).

This is the Python twin of resolveInferenceAmi() in servers/lib/image-filter.js
(the deploy-config builder uses that one). The two implementations read the same
catalog and are kept in agreement by test/unit/deploy-config-builder-ami.test.js,
which runs both over every family / AMI combination.

Precedence (single instance or pool):
  1. user AMI (INFERENCE_AMI_VERSION): kept, warned about when AWS does not
     list it for a family;
  2. image default AMI, when every family allows it;
  3. each family's inference_ami_version, in pool order, when every family
     allows it;
  4. none: the field is omitted and SageMaker applies the family default.
A pool needs one AMI every family allows; an empty intersection, or a GPU
family mixed with a non-GPU family (Trainium / Inferentia), is an error.

CLI (bash callers, e.g. do/lib/endpoint-config.sh):
    python3 do/lib/python/inference_ami.py resolve --instance-types a[,b...]
        [--ami <INFERENCE_AMI_VERSION>] [--image-ami <ami>] [--pool]
        [--catalog <fleet-drivers.json>] [--json]
  Prints human-readable messages, then a final line ``__AMI__=<ami>`` (empty
  when the field should be omitted). ``--json`` prints the result object only.
  Exit codes: 0 resolved; 1 incompatible pool; 2 usage; 3 catalog not found.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

AWS_DOC = "https://docs.aws.amazon.com/sagemaker/latest/dg/inference-gpu-drivers.html"
_FAMILY_RE = re.compile(r"^ml\.([a-z0-9][a-z0-9-]*)\.", re.I)
_HERE = os.path.dirname(os.path.abspath(__file__))


def catalog_candidates() -> list[str]:
    """fleet-drivers.json locations, in resolution order.

    <do>/lib/python -> ../../.. is the generated project (which carries a copy
    in .mlcc/) or, in the source tree, templates/ (whose parent is the repo).
    """
    root = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
    return [
        os.path.join(root, ".mlcc", "fleet-drivers.json"),
        os.path.join(root, "..", "servers", "lib", "catalogs", "fleet-drivers.json"),
        os.path.join(os.getcwd(), "servers", "lib", "catalogs", "fleet-drivers.json"),
    ]


def load_catalog(path: str | None = None) -> dict | None:
    for candidate in [path] if path else catalog_candidates():
        try:
            with open(candidate, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            continue
    return None


def parse_instance_family(instance_type: str | None) -> str | None:
    match = _FAMILY_RE.match(instance_type or "")
    return match.group(1) if match else None


def _normalize(ami: str | None) -> str:
    return (ami or "").strip().lower().replace("_", "-")


def allow_list(catalog: dict, family: str | None) -> dict:
    """Mirror of inferenceAmiAllowList() in servers/lib/image-filter.js."""
    families = catalog.get("instance_families") or {}
    amis = []
    for name, entry in (catalog.get("ami_versions") or {}).items():
        if name.startswith("_") or not isinstance(entry, dict):
            continue
        listed = list(entry.get("default_families") or []) + list(entry.get("override_families") or [])
        if family in listed:
            amis.append(name)
    present = bool(family) and family in families
    family_entry = families.get(family) if present else None
    if present and family_entry is None:
        kind = "non-gpu"
    elif family_entry or amis:
        kind = "gpu"
    else:
        kind = "unknown"
    default_ami = family_entry.get("inference_ami_version") if isinstance(family_entry, dict) else None
    return {"family": family or None, "kind": kind, "amis": amis, "defaultAmi": default_ami or None}


def resolve(catalog: dict, instance_types: list[str], user_ami: str | None = None,
            image_ami: str | None = None) -> dict:
    """Mirror of resolveInferenceAmi() in servers/lib/image-filter.js."""
    types = [t.strip() for t in instance_types if t and t.strip()]
    fams = [{"type": t, **allow_list(catalog, parse_instance_family(t))} for t in types]
    gpu = [f for f in fams if f["kind"] == "gpu"]
    non_gpu = [f for f in fams if f["kind"] == "non-gpu"]
    user = _normalize(user_ami)
    result = {"ami": None, "source": "none", "warnings": [], "error": None,
              "allowed": [], "families": fams}

    if gpu and non_gpu:
        result["error"] = (f"Cannot mix {gpu[0]['type']} (NVIDIA GPU) and {non_gpu[0]['type']} "
                           "(no NVIDIA driver) in same pool — different CUDA/AMI requirements")
        return result
    if not gpu:
        if user:
            result.update(ami=user, source="user")
        return result

    allowed = list(gpu[0]["amis"])
    for fam in gpu[1:]:
        nxt = [a for a in allowed if a in fam["amis"]]
        if not nxt:
            result["error"] = (f"Cannot mix {gpu[0]['type']} and {fam['type']} in same pool — different "
                               "CUDA/AMI requirements: AWS lists no InferenceAmiVersion that every pool "
                               "family supports")
            return result
        allowed = nxt
    result["allowed"] = allowed

    candidates = [c for c in [_normalize(image_ami)] + [f["defaultAmi"] for f in gpu] if c]
    pick = next((c for c in candidates if c in allowed), None)

    if user:
        result.update(ami=user, source="user")
        unlisted = [f for f in gpu if user not in f["amis"]]
        if unlisted:
            names = ", ".join(dict.fromkeys(f["family"] for f in unlisted))
            fix = (f'set INFERENCE_AMI_VERSION="{pick}"' if pick
                   else "clear INFERENCE_AMI_VERSION (SageMaker then applies the family default)")
            result["warnings"].append(
                f"INFERENCE_AMI_VERSION={user} is not listed by AWS for {names} "
                f"(AWS lists: {', '.join(allowed) or 'none'}). The endpoint will likely fail to start. "
                f"Fix: {fix} in do/config, or run ./do/deploy --reconfigure. See {AWS_DOC}")
        return result

    if pick:
        result["ami"] = pick
        result["source"] = "image" if pick == _normalize(image_ami) else "family"
    return result


def _cmd_resolve(args: argparse.Namespace) -> int:
    catalog = load_catalog(args.catalog)
    types = [t for t in (args.instance_types or "").split(",") if t.strip()]
    if catalog is None:
        if args.json:
            print(json.dumps({"error": "fleet-drivers.json not found"}))
        else:
            print("   ⚠️  fleet-drivers.json not found — InferenceAmiVersion compatibility not checked")
            print(f"__AMI__={_normalize(args.ami)}")
        return 3
    res = resolve(catalog, types, args.ami, args.image_ami)
    if args.json:
        print(json.dumps(res))
        return 1 if res["error"] else 0
    if args.pool:
        for fam in res["families"]:
            if fam["kind"] == "unknown":
                print(f"   ⚠️  Unknown instance type in pool: {fam['type']} — skipping validation for this type")
    if res["error"]:
        print(f"❌ {res['error']}")
        print("   All instance types in a pool must share the same InferenceAmiVersion.")
        print(f"   AWS AMI / instance-family table: {AWS_DOC}")
        print("   Fix: use instance types that AWS lists for a common AMI in your pool.")
        return 1
    for warning in res["warnings"]:
        print(f"⚠️  WARNING: {warning}")
    print(f"__AMI__={res['ami'] or ''}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="inference_ami.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd")
    p_res = sub.add_parser("resolve", help="resolve / validate InferenceAmiVersion")
    p_res.add_argument("--instance-types", required=True, help="comma-separated ml.* instance types")
    p_res.add_argument("--ami", default="", help="INFERENCE_AMI_VERSION already configured")
    p_res.add_argument("--image-ami", default="", help="model-server image default AMI")
    p_res.add_argument("--pool", action="store_true", help="instance types form one pool")
    p_res.add_argument("--catalog", default=None, help="explicit fleet-drivers.json path")
    p_res.add_argument("--json", action="store_true", help="print the result object as JSON")
    args = parser.parse_args(argv)
    if args.cmd != "resolve":
        parser.print_usage(sys.stderr)
        return 2
    return _cmd_resolve(args)


if __name__ == "__main__":
    sys.exit(main())
