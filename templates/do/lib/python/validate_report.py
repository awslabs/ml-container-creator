#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""validate_report.py — the do/validate dispatcher (Wave 8 R5, C1).

Purpose: run every check that applies to the configured deployment target and
         print ONE merged report (text or JSON). Which sections apply is DERIVED
         from targets.d/<target>/manifest.json (ADR-008), not from a target list:

  section            runs when                                   source of the checks
  right-sizing       always                                      right_sizing.py check_all (same as the do/deploy preflight)
  config             always                                      deploy_schema.validate_config (descriptor required_vars;
                                                                 an empty one warns: do/deploy prompts for it)
                                                                 + do/ic/*.conf sanity when verbs.add-ic
  cluster-contract   descriptor declares cluster_contract        the BL156 / Wave 6.1 read-only helper it names
  service-model      serving_config_source == sagemaker-ic       the Node validate-runner (SageMaker API payload shapes),
                     AND the schema registry exists              else "skipped — run bootstrap sync-schemas"

Severity in the report: error | warning | info | skip (a right-sizing block is
an error; a skip names why it did not run). Every check is read-only.

Exit codes (R5.5): 0 = no errors; 1 = errors (incl. a right-sizing block or a
cluster-contract miss); 2 = could not run at all (no do/config target / no
descriptor for it).

CLI (called by do/validate after it sources do/config):
    validate_report.py --do-dir DIR [--format text|json] [--runner PATH] [--smart] [--offline]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Callable

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import deploy_schema  # noqa: E402
import right_sizing  # noqa: E402
import target_manifest  # noqa: E402

SEVERITY_MAP = {"block": "error", "warn": "warning", "info": "info", "skip": "skip",
                "error": "error", "warning": "warning"}
ICON = {"error": "❌", "warning": "⚠️ ", "info": "ℹ️ ", "skip": "⏭️ "}
SYNC_HINT = "run `ml-container-creator bootstrap sync-schemas`"


def _finding(severity: str, check: str, message: str, fix: str = "", data: dict | None = None) -> dict:
    return {"severity": SEVERITY_MAP.get(severity, severity), "check": check, "message": message,
            "fix": fix or "", "data": data or {}}


def _section(name: str, title: str, status: str = "ran", reason: str = "", findings: list | None = None) -> dict:
    return {"name": name, "title": title, "status": status, "reason": reason, "findings": findings or []}


def _run(cmd: list[str], env: dict, timeout: int = 120) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return 127, "", f"{exc.__class__.__name__}: {exc}"
    return proc.returncode, proc.stdout or "", proc.stderr or ""


# ── Sections ──────────────────────────────────────────────────────────────────


def right_sizing_section(env: dict, network: bool, ctx_builder: Callable | None = None) -> dict:
    build = ctx_builder or right_sizing.context_from_env
    try:
        ctx = build(env, network=network)
        findings = right_sizing.check_all(ctx)
    except Exception as exc:  # noqa: BLE001 — a crash in one section must not hide the others
        return _section("right-sizing", "Right-sizing (KV cache, weights, GPU fit)", "skipped",
                        f"right_sizing.py could not run: {exc.__class__.__name__}: {exc}")
    return _section("right-sizing", "Right-sizing (KV cache, weights, GPU fit)", "ran", "",
                    [_finding(f.severity, f.check, f.message, f.fix, f.data) for f in findings])


def config_section(target: str, desc: dict, env: dict, do_dir: str) -> dict:
    findings = []
    try:
        missing = deploy_schema.validate_config(target, env)
    except ValueError as exc:
        missing = []
        findings.append(_finding("error", "config-target", str(exc)))
    # A required setting that is still empty is what do/deploy prompts for on the
    # first deploy, so it warns here instead of failing a fresh project.
    for var in missing:
        findings.append(_finding("warning", "config-required", f"{var} is required for {target} but is empty "
                                 "(do/deploy will prompt for it)",
                                 fix=f"set {var} in do/config, or run ./do/deploy --target {target} to be prompted"))
    if (desc.get("verbs") or {}).get("add-ic"):
        for conf in right_sizing.ic_confs(do_dir):
            for var in ("IC_GPU_COUNT", "IC_COPY_COUNT"):
                val = conf.get(var)
                if val not in (None, "") and not str(val).isdigit():
                    findings.append(_finding("error", "config-ic", f"do/ic/{conf['_name']}.conf {var}='{val}' is not "
                                                                    "a positive integer"))
    if not findings:
        findings.append(_finding("info", "config-required", f"every required {target} setting is present"))
    return _section("config", "Config consistency (do/config, do/ic/*.conf)", "ran", "", findings)


def cluster_contract_section(desc: dict, env: dict, do_dir: str, run: Callable = _run) -> dict:
    title = "Cluster contract (read-only)"
    contract = desc.get("cluster_contract") or {}
    if not contract:
        return _section("cluster-contract", title, "skipped", "target capacity is SageMaker-managed (no cluster contract)")
    rc, _, err = run(["kubectl", "cluster-info", "--request-timeout=10s"], env, 30)
    if rc != 0:
        why = (err.strip().splitlines() or ["kubectl unavailable"])[-1][:200]
        return _section("cluster-contract", title, "skipped",
                        f"cluster not reachable from the current kubectl context ({why}); point kubectl at "
                        f"{env.get('HP_CLUSTER_NAME') or 'the cluster'} (aws eks update-kubeconfig) and re-run")
    script = os.path.join(do_dir, contract["script"])
    entry = contract["entry"]
    if script.endswith(".sh"):
        rc, out, err = run(["/bin/bash", "-c", 'source "$1" && "$2"', "contract", script, entry], env, 180)
        lines = [ln for ln in (out + err).splitlines() if ln.strip()]
        if rc == 0:
            return _section("cluster-contract", title, "ran", "",
                            [_finding("info", "cluster-contract", ln.strip()) for ln in lines]
                            or [_finding("info", "cluster-contract", "cluster contract satisfied")])
        return _section("cluster-contract", title, "ran", "",
                        [_finding("error", "cluster-contract", f"contract not satisfied (exit {rc}): "
                                  + " | ".join(ln.strip() for ln in lines[-12:]))])
    rc, out, err = run([sys.executable, script, entry], env, 180)
    try:
        data = json.loads(out or "{}")
    except ValueError:
        data = None
    if rc != 0 or not isinstance(data, dict):
        return _section("cluster-contract", title, "skipped",
                        f"{contract['script']} {entry} did not return findings (exit {rc}): {err.strip()[:200]}")
    return _section("cluster-contract", title, "ran", "",
                    [_finding(f.get("severity", "info"), f.get("check", "cluster-contract"), f.get("message", ""),
                              f.get("fix", "")) for f in data.get("findings", [])])


def _node_findings(report: dict) -> list[dict]:
    out = []
    for key, sev in (("schemaErrors", "error"), ("crossCuttingErrors", "error"), ("warnings", "warning"),
                     ("advisoryFindings", "info")):
        for f in report.get(key) or []:
            where = " ".join(str(x) for x in (f.get("operation"), f.get("fieldPath")) if x)
            hint = f.get("remediationHint") or f.get("message") or json.dumps(f.get("constraint"))
            out.append(_finding(sev, "service-model", f"{where}: {hint}" if where else str(hint)))
    return out


def service_model_section(desc: dict, do_dir: str, runner: str, smart: bool, env: dict,
                          registry: str | None = None, run: Callable = _run) -> dict:
    title = "SageMaker service-model payloads (Node validate-runner)"
    if desc.get("serving_config_source") != right_sizing.SAGEMAKER_IC_SOURCE:
        return _section("service-model", title, "skipped",
                        f"{desc.get('target')} serves on {desc.get('serving_config_source') or 'another'} "
                        "(no SageMaker endpoint payloads are sent)")
    registry = registry or os.path.join(os.path.expanduser("~"), ".ml-container-creator", "schemas")
    if not os.path.isfile(os.path.join(registry, "manifest.json")):
        return _section("service-model", title, "skipped", f"schema registry not found — {SYNC_HINT}")
    if not runner or not os.path.isfile(runner):
        return _section("service-model", title, "skipped",
                        "validate-runner not found — install @aws/ml-container-creator (npm install -g)")
    code = ("import { run } from %s; run({ configDir: %s, format: 'json', smart: %s });"
            % (json.dumps(runner), json.dumps(do_dir), "true" if smart else "false"))
    rc, out, err = run(["node", "--input-type=module", "-e", code], env, 300)
    start = out.find("{")
    try:
        report = json.loads(out[start:]) if start >= 0 else None
    except ValueError:
        report = None
    if not isinstance(report, dict):
        return _section("service-model", title, "skipped",
                        f"validate-runner produced no report (exit {rc}): {(err or out).strip()[:200]}")
    notes = [_finding("info", "service-model", ln.strip()) for ln in out[:start].splitlines() if ln.strip()]
    findings = _node_findings(report) or [_finding("info", "service-model", "payloads match the AWS service models "
                                                   f"({(report.get('summary') or {}).get('fieldsValidated', 0)} fields)")]
    return _section("service-model", title, "ran", "", notes + findings)


# ── Report ────────────────────────────────────────────────────────────────────


def build_report(env: dict, do_dir: str, runner: str = "", smart: bool = False, network: bool = True,
                 registry: str | None = None, run: Callable = _run, ctx_builder: Callable | None = None) -> dict:
    raw = (env.get("DEPLOYMENT_TARGET") or "").strip()
    if not raw:
        return {"target": "", "exit_code": 2, "sections": [],
                "error": "no DEPLOYMENT_TARGET in do/config — run ./do/deploy --target <target> first"}
    try:
        target = target_manifest.resolve_target(raw)
        desc = target_manifest.read_manifest(target)
    except target_manifest.ManifestError as exc:
        return {"target": raw, "exit_code": 2, "sections": [], "error": f"no targets.d descriptor: {exc}"}
    sections = [
        right_sizing_section(env, network, ctx_builder),
        config_section(target, desc, env, do_dir),
        cluster_contract_section(desc, env, do_dir, run),
        service_model_section(desc, do_dir, runner, smart, env, registry, run),
    ]
    counts = {"error": 0, "warning": 0, "info": 0, "skip": 0}
    for sec in sections:
        for f in sec["findings"]:
            counts[f["severity"]] = counts.get(f["severity"], 0) + 1
    return {"target": target, "family": desc.get("family", ""),
            "serving_config_source": desc.get("serving_config_source", ""),
            "sections": sections, "summary": {**counts, "sections_skipped": sum(s["status"] != "ran" for s in sections)},
            "exit_code": 1 if counts["error"] else 0}


def render_text(report: dict) -> str:
    if report.get("error"):
        return f"❌ do/validate could not run: {report['error']}"
    lines = [f"🔍 Validating {report['target']} ({report['family']})"]
    for sec in report["sections"]:
        status = "ran" if sec["status"] == "ran" else f"skipped — {sec['reason']}"
        lines.append("")
        lines.append(f"── {sec['title']}: {status}")
        for f in sec["findings"]:
            lines.append(f"   {ICON.get(f['severity'], '•')} [{f['check']}] {f['message']}")
            if f.get("fix"):
                lines.append(f"      Fix: {f['fix']}")
    s = report["summary"]
    lines.append("")
    lines.append(f"Summary: {s['error']} error(s), {s['warning']} warning(s), {s['skip']} skipped check(s), "
                 f"{s['sections_skipped']} skipped section(s)")
    lines.append("✅ Validation passed" if report["exit_code"] == 0 else "❌ Validation failed")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="validate_report.py")
    p.add_argument("--do-dir", required=True)
    p.add_argument("--format", default="text", choices=["text", "json"])
    p.add_argument("--runner", default="")
    p.add_argument("--smart", action="store_true")
    p.add_argument("--offline", action="store_true", help="skip network-only checks (quota)")
    args = p.parse_args(argv)
    report = build_report(dict(os.environ), args.do_dir, args.runner, args.smart, not args.offline)
    if args.format == "json":
        print(json.dumps(report, indent=2, default=str))
    else:
        print(render_text(report))
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
