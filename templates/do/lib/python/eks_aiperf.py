#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Local AIPerf driver for the plain-``eks`` benchmark path (BL157).

The ``eks`` deployment target has no SageMaker endpoint, so it cannot drive the
SageMaker AI Benchmarking service (``create-ai-workload-config`` /
``create-ai-benchmark-job``). Instead, ``do/benchmark`` runs the SAME tool that
service runs — NVIDIA **AIPerf** — locally against the port-forwarded pod, so it
emits the byte-compatible ``profile_export.jsonl`` the existing sweep,
aggregator, ``.benchmark_writer.py``, analytics, and Athena pipeline already
consume unchanged (findings §5; design.md "local AIPerf").

Responsibility split (design.md "control flow restructure"):
  * ``do/benchmark`` bash owns the eks branch: flag parsing, the workload
    catalog / dataset resolution, the multi-level sweep, the ``kubectl
    port-forward`` + fail-fast (BL103 edge 6.1/6.2), the ``aiperf`` availability
    check, running the command, and the writer call.
  * This module owns the DERIVATIONS that must not be hardcoded (ADR-008, R4):
    the served-model name, the serving port (from ``serve.d/<engine>/
    manifest.json`` via ``serve_manifest.py``), the ``aiperf profile`` argv
    (mirroring the SageMaker workload-spec → flag map, design.md "CLI mapping"),
    and relocating AIPerf's artifact to the path the sweep/aggregator expect.

Subcommands (invoked by do/benchmark as a one-shot):

    eks_aiperf.py served-model     — print the derived --model name
    eks_aiperf.py serving-port     — print the derived serving port (manifest)
    eks_aiperf.py build-command    — print the aiperf profile argv (one per line)
    eks_aiperf.py relocate <art> <dst>  — move profile_export.jsonl → <dst>

All inputs come from environment variables (the resolved do/config values) so
the bash caller stays a thin wrapper and the derivations are unit-testable.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

# ── Import serve_manifest (single source of truth for the engine manifest) ─────
# The driver lives alongside serve_manifest.py in do/lib/python/. Import by
# adding our own directory to sys.path so this works whether invoked as a script
# or imported as a module in tests.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import serve_manifest  # noqa: E402


# AIPerf drives the OpenAI chat API; this matches the SageMaker workload spec's
# tooling.api_standard: openai (findings §4). The endpoint path is fixed by the
# API standard, NOT hardcoded per engine — the PORT is what we derive from the
# manifest (R4).
CHAT_ENDPOINT = "/v1/chat/completions"
DEFAULT_SERVING_PORT = 8080


def _env(name: str, default: str = "") -> str:
    """Return a stripped environment value, or ``default`` when unset/blank."""
    val = os.environ.get(name)
    if val is None:
        return default
    val = val.strip()
    return val if val else default


def _truthy(name: str) -> bool:
    """True iff the env var is the string ``true`` (do/config boolean shape)."""
    return _env(name).lower() == "true"


def derive_served_model() -> str:
    """Derive the ``--model`` name AIPerf sends in each request.

    Mirrors the stub's ``_EKS_MODEL`` logic (design.md "--model derivation"):
    s3/registry-sourced models are served under ``/opt/ml/model`` (the staged
    in-container path, e.g. SGLang's observed ``served_model_name``); a HuggingFace
    source serves under its ``MODEL_NAME``. The served-model name is the routing
    key the pod matches, so it must equal what the serving container registered.
    """
    # Wave 6.1 R7c: do/benchmark --adapter <name> exports BENCHMARK_SERVED_MODEL so
    # every request names the LoRA adapter (vLLM routes by model name).
    adapter = _env("BENCHMARK_SERVED_MODEL")
    if adapter:
        return adapter
    model_name = _env("MODEL_NAME")
    if model_name.startswith("s3://") or model_name.startswith("/opt/ml/"):
        return "/opt/ml/model"
    return model_name


def derive_serving_port(engine: str) -> int:
    """Derive the pod's serving port from the engine manifest (R4, ADR-008).

    Reads ``serve.d/<engine>/manifest.json``'s ``metrics_endpoint.port`` rather
    than hardcoding ``8080`` (the drift the stub had, findings §8). Falls back to
    the historical default only when the manifest declares no port, so a probe
    still works for an engine that omits the field.
    """
    try:
        me = serve_manifest.metrics_endpoint(engine)
    except (NameError, AttributeError):
        raise  # R9.2/BL172: a programming error must never be swallowed as best-effort
    except Exception:
        me = None
    if isinstance(me, dict):
        port = me.get("port")
        if isinstance(port, int) and port > 0:
            return port
        if isinstance(port, str) and port.isdigit():
            return int(port)
    return DEFAULT_SERVING_PORT


def build_command(local_port: int, artifact_dir: str) -> list[str]:
    """Build the ``aiperf profile`` argv from the resolved benchmark config.

    Maps the SageMaker workload spec 1:1 onto AIPerf flags (design.md "CLI
    mapping"). Synthetic token-mean flags and BYOD ``--input-file`` are mutually
    exclusive (same rule as the service path, findings §3): a resolved dataset
    (``BENCHMARK_DATASET_LOCAL_FILE``) replaces the synthetic prompt generation.
    """
    served_model = derive_served_model()
    tokenizer = _env("HF_MODEL_ID") or _env("MODEL_NAME")
    concurrency = _env("BENCHMARK_CONCURRENCY", "1")
    request_count = _env("BENCHMARK_REQUEST_COUNT", "100")

    cmd = [
        "aiperf",
        "profile",
        "--url",
        f"localhost:{local_port}",
        "--endpoint-type",
        "chat",
        "--endpoint",
        CHAT_ENDPOINT,
        "--model",
        served_model,
        "--tokenizer",
        tokenizer,
    ]

    # Some tokenizers (e.g. Kimi-K3's) ship custom code AutoTokenizer refuses to
    # run without an explicit opt-in — forward the same flag the serving
    # container uses (design.md flag map; findings §4).
    if _truthy("VLLM_TRUST_REMOTE_CODE"):
        cmd.append("--tokenizer-trust-remote-code")

    if _truthy("BENCHMARK_STREAMING"):
        cmd.append("--streaming")

    dataset_file = _env("BENCHMARK_DATASET_LOCAL_FILE")
    if dataset_file:
        # BYOD: one request per JSONL line; synthetic means omitted (mutually
        # exclusive, matching the AWS workload-spec rule).
        cmd += ["--custom-dataset-type", "single_turn", "--input-file", dataset_file]
    else:
        input_mean = _env("BENCHMARK_INPUT_TOKENS_MEAN", "550")
        output_mean = _env("BENCHMARK_OUTPUT_TOKENS_MEAN", "150")
        cmd += [
            "--synthetic-input-tokens-mean",
            input_mean,
            "--output-tokens-mean",
            output_mean,
        ]

    cmd += [
        "--concurrency",
        concurrency,
        "--request-count",
        request_count,
        "--artifact-directory",
        artifact_dir,
    ]
    return cmd


def relocate_profile_export(artifact_dir: str, dest: str) -> str:
    """Move AIPerf's ``profile_export.jsonl`` to the aggregator's expected path.

    AIPerf writes ``<artifact_dir>/<run>/profile_export.jsonl`` (design.md "open
    design points"); the multi-level sweep copies each child's
    ``output/profile_export.jsonl``. Find the per-request jsonl anywhere under the
    artifact dir and move it to ``dest`` — NO change to the shared aggregator.

    Returns the destination path on success. Raises ``FileNotFoundError`` if
    AIPerf produced no per-request jsonl (caller fails loud).
    """
    found = None
    for root, _dirs, files in os.walk(artifact_dir):
        for name in files:
            if name == "profile_export.jsonl":
                found = os.path.join(root, name)
                break
        if found is not None:
            break
    if found is None:
        raise FileNotFoundError(
            f"aiperf produced no profile_export.jsonl under {artifact_dir}"
        )
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.abspath(found) != os.path.abspath(dest):
        shutil.copyfile(found, dest)
    # BL128 (Wave 9 R10.3): keep AIPerf's time-weighted aggregate export next to
    # the JSONL so the writer can persist the Effective/Active columns (and the
    # sweep copy step finds it under <job>/output/). Absent file -> NULL columns.
    aggregate = os.path.join(os.path.dirname(found), "profile_export_aiperf.json")
    aggregate_dest = os.path.join(os.path.dirname(dest), "profile_export_aiperf.json")
    if os.path.isfile(aggregate) and os.path.abspath(aggregate) != os.path.abspath(aggregate_dest):
        shutil.copyfile(aggregate, aggregate_dest)
    return dest


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="eks_aiperf.py")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("served-model")

    p_port = sub.add_parser("serving-port")
    p_port.add_argument("engine")

    p_build = sub.add_parser("build-command")
    p_build.add_argument("--local-port", type=int, required=True)
    p_build.add_argument("--artifact-dir", required=True)

    p_reloc = sub.add_parser("relocate")
    p_reloc.add_argument("artifact_dir")
    p_reloc.add_argument("dest")

    args = parser.parse_args(argv)

    if args.command == "served-model":
        print(derive_served_model())
        return 0

    if args.command == "serving-port":
        print(derive_serving_port(args.engine))
        return 0

    if args.command == "build-command":
        for token in build_command(args.local_port, args.artifact_dir):
            print(token)
        return 0

    if args.command == "relocate":
        try:
            print(relocate_profile_export(args.artifact_dir, args.dest))
        except FileNotFoundError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
