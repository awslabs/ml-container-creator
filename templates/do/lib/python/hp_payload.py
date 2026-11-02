#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""hp_payload.py — render + patch AWS's HP-EKS payload template (Wave 11 R10, R11).

`do/tune --backend hp-eks` runs AWS's own Hub payload (`HpEksPayloadTemplateS3Uri`:
a ConfigMap + a HyperPodPyTorchJob with {{mustache}} placeholders). MLCC renders it
itself (any unfilled placeholder is fatal), then applies a DECLARATIVE site list
(hp_payload_sites.json, per template family). Every site asserts its original value
first; a mismatch is fatal and names the site ("template drift at <id>").

  always (R10.1, OQ-11.1 non-shape fixes): delete the reserved JOB_NAME env, fix
    SCRIPT_PATH, add the .yaml config suffix, group nodeSelector, serviceAccountName,
    runPolicy, per-job log path, the shared scratch / fetch / egress pod additions
    (hp_job.py) and the mlcc labels.
  shape (R11, only with --adapt-shape, EXPERIMENTAL): rewrite the 8-GPU / EFA recipe
    shape to the group's allocatable G, drop EFA when the group has fewer, set the
    per-GPU token budget and PYTORCH_CUDA_ALLOC_CONF. A post-scan then refuses any
    leftover GPU-count / EFA literal or p4d/p5 instance literal (R11.3).

Requires PyYAML (the only non-stdlib import; missing → exit 3 naming it).

Subcommands:
  render --template F --override-params F --values-json JSON --group G --group-gpus N
         [--group-efa N] [--adapt-shape] [--set k=v ...] --project P --job J --namespace N
         --artifacts-bucket B --region R --max-runtime S --dataset-uri URI [--model-uri URI]
         [--gpu-vram-gib X --model-bytes N] --technique T --out F
  shape --template F            prints {"gpus": T, "efa": E, "kind": K, "family": F}
  prepare-data --technique sft|dpo --in F --out F
Exit codes: 0 ok; 2 usage; 3 refusal (unfilled placeholder, template drift, unknown
family, VRAM, leftover literal, unsupported dataset format); 4 shape does not fit the
group and --adapt-shape was not given.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hp_job  # noqa: E402

SITES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hp_payload_sites.json")
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
GPU = "nvidia.com/gpu"
EFA = "vpc.amazonaws.com/efa"
VRAM_HEADROOM = 0.9


class PayloadError(Exception):
    """A refusal (exit 3)."""


class ShapeError(Exception):
    """The template shape exceeds the group and --adapt-shape was not given (exit 4)."""


def _yaml():
    try:
        import yaml  # noqa: PLC0415
    except ImportError:
        raise PayloadError("PyYAML is required to render the HP-EKS payload: pip install pyyaml") from None
    return yaml


def load_sites() -> dict:
    with open(SITES_FILE, encoding="utf-8") as fh:
        return json.load(fh)["families"]


# ── fill (R10.1) ───────────────────────────────────────────────────────────────


def fill(template: str, override_params: dict, values: dict) -> str:
    """Mustache-fill every {{name}}: MLCC values > resolved knobs > override-param
    defaults. A placeholder with no value at all (None) is fatal."""
    defaults = {k: (v or {}).get("default") for k, v in (override_params or {}).items() if isinstance(v, dict)}
    missing = []

    def sub(m):
        name = m.group(1)
        if name in values and values[name] is not None:
            val = values[name]
        elif defaults.get(name) is not None:
            val = defaults[name]
        else:
            missing.append(name)
            return m.group(0)
        if isinstance(val, bool):
            return "true" if val else "false"
        return str(val)

    out = PLACEHOLDER_RE.sub(sub, template)
    if missing:
        raise PayloadError(f"unfilled template placeholder(s): {', '.join(sorted(set(missing)))}")
    return out


# ── document helpers ───────────────────────────────────────────────────────────


def _doc(docs: list, kind: str) -> dict:
    hits = [d for d in docs if isinstance(d, dict) and d.get("kind") == kind]
    if len(hits) != 1:
        raise PayloadError(f"template drift: expected one {kind} document, found {len(hits)}")
    return hits[0]


def _pod(hppj: dict) -> dict:
    specs = (hppj.get("spec") or {}).get("replicaSpecs") or []
    if len(specs) != 1:
        raise PayloadError(f"template drift: expected one replicaSpec, found {len(specs)}")
    return specs[0].setdefault("template", {}).setdefault("spec", {})


def _container(hppj: dict, name: str) -> dict:
    hits = [c for c in _pod(hppj).get("containers") or [] if c.get("name") == name]
    if len(hits) != 1:
        raise PayloadError(f"template drift: expected one container '{name}', found {len(hits)}")
    return hits[0]


def _env(container: dict, name: str) -> dict | None:
    hits = [e for e in container.get("env") or [] if e.get("name") == name]
    if len(hits) > 1:
        raise PayloadError(f"template drift: env {name} appears {len(hits)} times")
    return hits[0] if hits else None


def _dig(obj: dict, path: str):
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None, False
        cur = cur[part]
    return cur, True


def _put(obj: dict, path: str, value) -> None:
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        cur = cur[part]
    cur[parts[-1]] = value


def template_shape(docs: list) -> tuple[int, int]:
    """(T, E): the template's GPU and EFA limit on the main container."""
    hppj = _doc(docs, "HyperPodPyTorchJob")
    lim = {}
    for c in _pod(hppj).get("containers") or []:
        lim = (c.get("resources") or {}).get("limits") or {}
        if GPU in lim:
            break
    if GPU not in lim:
        raise PayloadError("template drift: no nvidia.com/gpu limit on any container")
    return int(lim[GPU]), int(lim.get(EFA, 0) or 0)


def family_for(docs: list, families: dict) -> tuple[str, dict]:
    hppj = [d for d in docs if isinstance(d, dict) and d.get("kind") not in (None, "ConfigMap")]
    kind = hppj[0].get("kind") if hppj else None
    images = []
    if kind == "HyperPodPyTorchJob":
        images = [c.get("image", "") for c in _pod(hppj[0]).get("containers") or []]
    for name, fam in families.items():
        m = fam.get("match") or {}
        if m.get("workload_kind") and m["workload_kind"] != kind:
            continue
        if any(re.search(m.get("image_regex", "$^"), img) for img in images):
            return name, fam
    raise PayloadError(f"no verified site list for this template (workload {kind}, image "
                       f"{', '.join(images) or '<none>'}); MLCC only patches families captured and "
                       "asserted live (hp_payload_sites.json)")


# ── sites ──────────────────────────────────────────────────────────────────────


def _resolve(token, ctx: dict):
    """Symbolic site values: T / G (ints), T_STR / G_STR, DEVICES_T / DEVICES_G, TOKENS."""
    if not isinstance(token, str):
        return token
    table = {"T": ctx["T"], "G": ctx["G"], "T_STR": str(ctx["T"]), "G_STR": str(ctx["G"]),
             "DEVICES_T": ",".join(str(i) for i in range(ctx["T"])),
             "DEVICES_G": ",".join(str(i) for i in range(ctx["G"])), "TOKENS": ctx.get("tokens")}
    return table.get(token, token)


def _expect(site: dict, actual, ctx: dict) -> None:
    sid = site["id"]
    if "expect_regex" in site:
        if not isinstance(actual, str) or "{{" in actual or not re.search(site["expect_regex"], actual):
            raise PayloadError(f"template drift at {sid}: {actual!r} does not match {site['expect_regex']}")
        return
    want = site.get("expect")
    if want is None:
        return
    if want == "ANY_INT":
        if not isinstance(actual, int) or isinstance(actual, bool):
            raise PayloadError(f"template drift at {sid}: expected an integer, found {actual!r}")
        return
    want = _resolve(want, ctx)
    if str(actual) != str(want):
        raise PayloadError(f"template drift at {sid}: expected {want!r}, found {actual!r}")


def apply_site(site: dict, docs: list, configs: dict, ctx: dict, fam: dict) -> None:
    op, sid = site["op"], site["id"]
    if op.startswith("config_"):
        cfg = configs.get(site["config"])
        if cfg is None:
            raise PayloadError(f"template drift at {sid}: ConfigMap key {site['config']} missing")
        cur, ok = _dig(cfg, site["path"])
        if not ok:
            raise PayloadError(f"template drift at {sid}: {site['config']}:{site['path']} missing")
        _expect(site, cur, ctx)
        _put(cfg, site["path"], _resolve(site["value"], ctx))
        return
    hppj = _doc(docs, site["doc"])
    main = _container(hppj, fam["main_container"])
    if op == "assert_image":
        if not re.search(fam["match"]["image_regex"], main.get("image", "")):
            raise PayloadError(f"template drift at {sid}: image {main.get('image')!r}")
    elif op == "env_delete":
        e = _env(main, site["env"])
        if e is None:
            raise PayloadError(f"template drift at {sid}: env {site['env']} missing")
        _expect(site, e.get("value"), ctx)
        main["env"].remove(e)
    elif op == "env_set":
        e = _env(main, site["env"])
        if e is None:
            raise PayloadError(f"template drift at {sid}: env {site['env']} missing")
        _expect(site, e.get("value"), ctx)
        e["value"] = str(_resolve(site["value"], ctx))
    elif op == "env_suffix":
        e = _env(main, site["env"])
        if e is None:
            raise PayloadError(f"template drift at {sid}: env {site['env']} missing")
        _expect(site, e.get("value"), ctx)
        if not e["value"].endswith(site["suffix"]):
            e["value"] += site["suffix"]
    elif op == "env_add":
        if _env(main, site["env"]) is not None:
            raise PayloadError(f"template drift at {sid}: env {site['env']} already set by the template")
        main.setdefault("env", []).append({"name": site["env"], "value": str(site["value"])})
    elif op == "spec_set":
        cur, ok = _dig(hppj, site["path"])
        if not ok:
            raise PayloadError(f"template drift at {sid}: {site['path']} missing")
        _expect(site, cur, ctx)
        _put(hppj, site["path"], _resolve(site["value"], ctx))
    elif op == "resource_set":
        sec = (main.get("resources") or {}).get(site["section"]) or {}
        if site["resource"] not in sec:
            raise PayloadError(f"template drift at {sid}: {site['section']}.{site['resource']} missing")
        _expect(site, sec[site["resource"]], ctx)
        sec[site["resource"]] = _resolve(site["value"], ctx)
    elif op == "efa":
        sec = (main.get("resources") or {}).get(site["section"]) or {}
        if EFA not in sec:
            raise PayloadError(f"template drift at {sid}: {site['section']}.{EFA} missing")
        if str(sec[EFA]) != str(ctx["E"]):
            raise PayloadError(f"template drift at {sid}: expected EFA {ctx['E']}, found {sec[EFA]!r}")
        if ctx["group_efa"] < ctx["E"]:
            del sec[EFA]
    elif op == "node_selector":
        pod = _pod(hppj)
        sel = pod.get("nodeSelector") or {}
        if list(sel) != [site["expect_key"]]:
            raise PayloadError(f"template drift at {sid}: nodeSelector {sel!r}")
        pod["nodeSelector"] = {hp_job.GROUP_LABEL: ctx["group"]}
    elif op == "command_wrap":
        cmd = main.get("command") or []
        if len(cmd) != 3 or cmd[2] != site["expect"]:
            raise PayloadError(f"template drift at {sid}: command {cmd!r}")
        main["command"] = hp_job.wrap_main_command(site["workload"])
    else:
        raise PayloadError(f"unknown site op '{op}' ({sid})")


def post_scan(docs: list, configs: dict, ctx: dict, fam: dict) -> None:
    """R11.3: after an adapted render no GPU-count / EFA literal equal to the
    template's original survives in a shape-bearing key, and no p4d/p5 instance
    literal survives outside the display-only allowlist."""
    rules = fam["post_scan"]
    key_re = re.compile(rules["key_regex"])
    inst_re = re.compile(rules["instance_literal_regex"])
    allowed = set(rules.get("allow_instance_literal_in") or [])
    banned = {str(ctx["T"])} | ({str(ctx["E"])} if ctx["E"] and ctx["group_efa"] < ctx["E"] else set())
    if ctx["T"] == ctx["G"]:
        banned.discard(str(ctx["T"]))
    devices_t = ",".join(str(i) for i in range(ctx["T"]))
    problems = []

    def walk(node, where, key=""):
        if isinstance(node, dict):
            if "name" in node and "value" in node and isinstance(node.get("name"), str):
                walk(node["value"], f"{where}env:{node['name']}", node["name"])
            for k, v in node.items():
                if k in ("name", "value") and "name" in node and "value" in node:
                    continue
                walk(v, f"{where}.{k}", str(k))
            return
        if isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{where}[{i}]", key)
            return
        text = str(node)
        if key_re.search(key) and (text in banned or (ctx["T"] != ctx["G"] and text == devices_t)):
            problems.append(f"{where} = {text}")
        if inst_re.search(text) and not any(where.startswith(a.split(":")[0]) and a.split(":")[1] in where
                                            for a in allowed):
            problems.append(f"{where} = {text} (instance literal)")

    for d in docs:
        if isinstance(d, dict) and d.get("kind") != "ConfigMap":
            walk(d, d.get("kind", "doc"))
    for name, cfg in configs.items():
        walk(cfg, name + ":")
    if problems:
        raise PayloadError("leftover recipe shape after --adapt-shape (template drift): " + "; ".join(problems[:8]))


# ── data (R10.2) ───────────────────────────────────────────────────────────────


def convert_rows(technique: str, rows: list[dict]) -> list[dict]:
    """sft: prompt/completion → messages (rows already in `messages` pass);
    dpo: prompt/chosen/rejected is the recipe's own format (verified in the DPO
    template's chosen_key / rejected_key / prompt_key). Anything else is refused."""
    out = []
    for i, r in enumerate(rows):
        if technique == "sft":
            if isinstance(r.get("messages"), list):
                out.append({"messages": r["messages"]})
            elif isinstance(r.get("prompt"), str) and isinstance(r.get("completion"), str):
                out.append({"messages": [{"role": "user", "content": r["prompt"]},
                                         {"role": "assistant", "content": r["completion"]}]})
            else:
                raise PayloadError(f"row {i + 1}: the SFT recipe needs `messages` or prompt/completion; got {sorted(r)}")
        elif technique == "dpo":
            if all(isinstance(r.get(k), str) for k in ("prompt", "chosen", "rejected")):
                out.append({k: r[k] for k in ("prompt", "chosen", "rejected")})
            else:
                raise PayloadError(f"row {i + 1}: the DPO recipe needs prompt/chosen/rejected; got {sorted(r)}")
        else:
            raise PayloadError(f"no verified dataset format for technique '{technique}' on hp-eks")
    if not out:
        raise PayloadError("the dataset is empty")
    return out


def prepare_data(technique: str, src: str, dst: str) -> int:
    rows = []
    with open(src, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    raise PayloadError(f"line {n} of {src} is not JSON") from None
    conv = convert_rows(technique, rows)
    with open(dst, "w", encoding="utf-8") as fh:
        for r in conv:
            fh.write(json.dumps(r) + "\n")
    return len(conv)


# ── render ─────────────────────────────────────────────────────────────────────


def render(template: str, override_params: dict, a: dict) -> dict:
    """Returns {"docs": [...], "shape": {...}, "adapted": bool, "family": name}."""
    yaml = _yaml()
    families = load_sites()
    values = dict(a.get("knobs") or {})
    values.update({
        "name": a["job"], "namespace": a["namespace"], "instance_type": a.get("instance_type") or "",
        "data_path": f"{hp_job.SCRATCH}/data/train.jsonl",
        "validation_data_path": f"{hp_job.SCRATCH}/data/{'val' if a.get('has_validation') else 'train'}.jsonl",
        "model_name_or_path": f"{hp_job.SCRATCH}/model", "output_path": f"{hp_job.SCRATCH}/output",
        "results_directory": f"{hp_job.SCRATCH}/results", "resume_from_path": "",
        "mlflow_tracking_uri": a.get("mlflow_tracking_uri") or "", "mlflow_run_id": a.get("mlflow_run_id") or "",
    })
    docs = list(yaml.safe_load_all(fill(template, override_params, values)))
    docs = [d for d in docs if d]
    fam_name, fam = family_for(docs, families)
    t_gpus, t_efa = template_shape(docs)
    g, g_efa = int(a["group_gpus"]), int(a.get("group_efa") or 0)
    fits = t_gpus <= g and t_efa <= g_efa
    adapt = bool(a.get("adapt_shape"))
    if not fits and not adapt:
        raise ShapeError(f"the AWS recipe requests {t_gpus} GPU / {t_efa} EFA per node; group {a['group']} has "
                         f"{g} GPU / {g_efa} EFA. Use a p4d/p5 instance group, or pass --adapt-shape "
                         "(EXPERIMENTAL, AWS-unsupported) to rewrite the shape to the group.")
    target_g = g if adapt else t_gpus
    vram = a.get("gpu_vram_gib")
    model_bytes = a.get("model_bytes")
    if vram and model_bytes and model_bytes / target_g > VRAM_HEADROOM * float(vram) * (1024 ** 3):
        raise PayloadError(f"the bf16 weights ({model_bytes / 1024 ** 3:.1f} GiB) over {target_g} GPU(s) exceed "
                           f"{int(VRAM_HEADROOM * 100)}% of the {vram} GiB per-GPU memory; pick a larger group")
    cm = _doc(docs, "ConfigMap")
    configs = {}
    for key in fam["config_keys"]:
        raw = (cm.get("data") or {}).get(key)
        if raw is None:
            raise PayloadError(f"template drift: ConfigMap key {key} missing")
        configs[key] = yaml.safe_load(raw) or {}
    tokens = (a.get("knobs") or {}).get("max_token_len_per_gpu") or values.get("dataset_max_len") \
        or (override_params.get("dataset_max_len") or {}).get("default")
    ctx = {"T": t_gpus, "E": t_efa, "G": target_g, "group_efa": g_efa, "group": a["group"],
           "tokens": int(tokens) if tokens is not None else None}
    for site in fam["always"]:
        apply_site(site, docs, configs, ctx, fam)
    if adapt and not fits:
        for site in fam["shape"]:
            apply_site(site, docs, configs, ctx, fam)
        post_scan(docs, configs, ctx, fam)
    for key, cfg in configs.items():
        cm["data"][key] = yaml.safe_dump(cfg, sort_keys=False)
    _add_mlcc(docs, cm, a, fam)
    return {"docs": docs, "family": fam_name, "adapted": adapt and not fits,
            "shape": {"template_gpus": t_gpus, "template_efa": t_efa, "gpus": target_g,
                      "group_gpus": g, "group_efa": g_efa}}


def _add_mlcc(docs: list, cm: dict, a: dict, fam: dict) -> None:
    """The shared pod additions + labels + runPolicy + identity (always sites that
    ADD rather than rewrite, so they need no original to assert)."""
    lbl = hp_job.labels(a["project"], "tune", a.get("technique") or "", a["job"])
    hppj = _doc(docs, "HyperPodPyTorchJob")
    for d in (cm, hppj):
        d.setdefault("metadata", {}).setdefault("labels", {}).update(lbl)
    spec = hppj.setdefault("spec", {})
    if "runPolicy" in spec:
        raise PayloadError("template drift at run-policy: the template now sets runPolicy")
    spec["runPolicy"] = hp_job.run_policy(a["max_runtime"])
    tmpl = spec["replicaSpecs"][0]["template"]
    tmpl.setdefault("metadata", {}).setdefault("labels", {}).update(lbl)
    pod = tmpl["spec"]
    if pod.get("serviceAccountName"):
        raise PayloadError("template drift at service-account: the template now sets serviceAccountName")
    pod["serviceAccountName"] = hp_job.SERVICE_ACCOUNT
    vol, mount = hp_job.scratch_volume("fsx", a["project"], a["job"], None, "", lbl)
    pod.setdefault("volumes", []).append(vol)
    main = _container(hppj, fam["main_container"])
    main.setdefault("volumeMounts", []).append(dict(mount))
    pod.setdefault("initContainers", []).append(
        hp_job.fetch_container(a["dataset_uri"], a.get("model_uri") or "", a["region"], mount))
    dest = hp_job.output_prefix(a["artifacts_bucket"], a["project"], "tune", a["job"])
    pod["containers"].append(hp_job.egress_container(dest, a["job"], a["region"], mount, True))


def _cli(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="hp_payload.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    for flag in ("--template", "--override-params", "--group", "--project", "--job", "--namespace",
                 "--artifacts-bucket", "--region", "--dataset-uri", "--technique", "--out"):
        r.add_argument(flag, required=True)
    r.add_argument("--group-gpus", type=int, required=True)
    r.add_argument("--group-efa", type=int, default=0)
    r.add_argument("--max-runtime", type=int, required=True)
    r.add_argument("--adapt-shape", action="store_true")
    r.add_argument("--set", action="append", default=[])
    r.add_argument("--values-json", default="{}")
    r.add_argument("--model-uri", default="")
    r.add_argument("--gpu-vram-gib", type=float, default=None)
    r.add_argument("--model-bytes", type=int, default=None)
    r.add_argument("--has-validation", action="store_true")
    s = sub.add_parser("shape")
    s.add_argument("--template", required=True)
    s.add_argument("--override-params", default="")
    d = sub.add_parser("prepare-data")
    d.add_argument("--technique", required=True)
    d.add_argument("--in", dest="src", required=True)
    d.add_argument("--out", required=True)
    args = p.parse_args(argv)
    try:
        if args.cmd == "prepare-data":
            print(json.dumps({"rows": prepare_data(args.technique, args.src, args.out), "out": args.out}))
            return 0
        with open(args.template, encoding="utf-8") as fh:
            template = fh.read()
        op = {}
        if getattr(args, "override_params", ""):
            with open(args.override_params, encoding="utf-8") as fh:
                op = json.load(fh)
        if args.cmd == "shape":
            yaml = _yaml()
            docs = [x for x in yaml.safe_load_all(PLACEHOLDER_RE.sub("x", template)) if x]
            t, e = template_shape(docs)
            fam, _ = family_for(docs, load_sites())
            kind = next((x.get("kind") for x in docs if x.get("kind") != "ConfigMap"), None)
            print(json.dumps({"gpus": t, "efa": e, "kind": kind, "family": fam}))
            return 0
        knobs = json.loads(args.values_json or "{}")
        for kv in args.set:
            if "=" not in kv:
                raise PayloadError(f"--set expects KNOB=VALUE, got '{kv}'")
            k, v = kv.split("=", 1)
            knobs[k] = v
        if args.adapt_shape:
            print("⚠️  EXPERIMENTAL --adapt-shape: rewriting AWS's recipe shape to the instance group "
                  "(not supported by AWS; validate the run).", file=sys.stderr)
        out = render(template, op, {
            "knobs": knobs, "group": args.group, "group_gpus": args.group_gpus, "group_efa": args.group_efa,
            "adapt_shape": args.adapt_shape, "project": args.project, "job": args.job,
            "namespace": args.namespace, "artifacts_bucket": args.artifacts_bucket, "region": args.region,
            "dataset_uri": args.dataset_uri, "model_uri": args.model_uri, "technique": args.technique,
            "max_runtime": args.max_runtime, "gpu_vram_gib": args.gpu_vram_gib,
            "model_bytes": args.model_bytes, "has_validation": args.has_validation})
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"apiVersion": "v1", "kind": "List", "items": out["docs"]}, fh, indent=2)
        print(json.dumps({"manifest": args.out, "family": out["family"], "adapted": out["adapted"], **out["shape"]}))
        return 0
    except ShapeError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 4
    except PayloadError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
