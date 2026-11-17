#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""right_sizing.py — centralized serving right-sizing checks (Wave 6.1 R3.1, Wave 8 R1/R2/R2b).

Purpose: ONE home for "does this serving configuration fit" decisions, so
         do/deploy (preflight), do/validate, do/adapter and do/tune ask the same
         question the same way. Adding a check = one function + one @register
         entry + tests + a row in docs/architecture/right-sizing.md (drift-tested);
         no caller changes.

Registered checks (the catalogue, with status and inputs, is
docs/architecture/right-sizing.md):
  Wave 6.1  lora-rank-fit, lora-buffer-memory
  Wave 8    context-memory (KV cache + weights + LoRA buffer + draft vs usable GPU
            memory), context-limit, tp-divisibility, dtype-arch, quant-engine,
            arch-engine-version, spec-draft-memory, vision-weights, ic-packing,
            concurrency-kv, disk-model-size, quota
  A check whose inputs are missing reports severity `skip` with the reason; it
  never guesses (no fabricated data).

It also owns the shared `effective_lora_rank` derivation both k8s deploy
drivers call (R2.3): techniques DRIVE max_lora_rank —
    effective = snap_up(max(recorded adapter ranks, TUNE_LORA_RANK_*,
                            manifest default), allowed)
and an explicit <engine>_MAX_LORA_RANK wins (with a warning when it is below
what recorded adapters need).

Shapes:
  Finding        one check result: check, severity (info|warn|block|skip),
                 message, fix ("; "-joined when several), data (the numbers used)
  SizingContext  the pure inputs every check reads (no I/O inside a check);
                 built ONCE by context_from_env()
  CHECKS         the check registry (name -> callable(ctx) -> [Finding])

Where knowledge comes from (derive, don't hardcode — ADR-008):
  - engine env-var names: serve.d/<engine>/manifest.json env_var_prefix +
    dimension_map (max_model_len, kv_cache_dtype, quantization, TP) + sizing_map
    (gpu_memory_utilization, max_num_seqs, dtype, TP default) + capability_map
    (LoRA rank / max-loras), via serve_manifest.py
  - which env-var form a target reads (IC_ENV_<var> vs <var>), the GPU count
    the model is served on, the quota usage kind: targets.d/<target>/manifest.json
    (serving_config_source, verbs.add-ic, service_quota_usage), via target_manifest.py
  - per-GPU memory, GPU count, GPU architecture: the instance catalog
    (.mlcc/instances.json gpuMemoryGb / gpus / gpuArchitecture)
  - model dims + dtype: the staged model's config.json (else Hugging Face)
  - weights (OQ-8.9): the staged *.safetensors sizes (measured); else
    params x dtype bytes with instance_sizer's constants (estimate). The finding
    data records which source was used.
  - architecture support floor: model-arch-support.json

KV cache (R2.2, OQ-8.8):
    bytes/token = sum over layers that own a KV cache of 2 x kv_heads x head_dim x kv_bytes
  (num_kv_shared_layers own none; full-attention layers use global_head_dim /
  num_global_key_value_heads when declared; MLA caches kv_lora_rank +
  qk_rope_head_dim once). Sliding-window / hybrid models get two bounds:
  upper = every layer holds max_model_len; lower = sliding layers hold only the
  window. Lower over usable -> block; only the upper over -> warn.

LoRA memory formula (vLLM 0.31 create_lora_weights, non-fully-sharded; see the
W6 follow-up investigation Q5):
    bytes/GPU = max_loras x rank x dtype_bytes x sum_layers sum_modules (in_local + out_local)
      ColumnParallel (q, k, v, gate, up): in_local = in,      out_local = out / TP
      RowParallel    (o, down):           in_local = in / TP, out_local = out
It is a slight upper bound (KV-shared layers are counted with k/v).

CLI (stdlib only; for bash callers):
    right_sizing.py check [--checks a,b] [--json] [--network]
    right_sizing.py effective-lora-rank [--rank-only] [--exclude-technique T] [--json] [--quiet]
    right_sizing.py adapter-rank <s3-uri|local dir|adapter_config.json|.tar.gz>
    right_sizing.py rank-fit --name N --rank R --limit L [--limit-kind live|effective] [--target T]
    right_sizing.py live-limit [--pods-json F] [--iec-json F] [--env-json F]   (R3.2 live limit)
  Exit codes: 0 = fits (info/skip only), 1 = warnings, 2 = blocked (or usage error).
  Context comes from the environment (do/config is sourced by the caller).
  `--network` enables the slow network-only checks (quota); do/validate passes it,
  the do/deploy preflight does not.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
from dataclasses import dataclass, field
from typing import Callable

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import instance_sizer  # noqa: E402  (sibling; weights-estimate constants, OQ-8.9)
import serve_manifest  # noqa: E402  (sibling module; same directory)
import target_manifest  # noqa: E402  (sibling; targets.d descriptor reader)

SEVERITIES = ("info", "warn", "block", "skip")
GIB = float(1 << 30)
# Owner decision D3 (2026-10-23): the LoRA buffer may use at most 10% of the GPU
# memory left after weights. A sizing policy, not engine knowledge.
LORA_BUFFER_BUDGET_FRACTION = 0.10
# vLLM's own gpu_memory_utilization default; overridden by <prefix>GPU_MEMORY_UTILIZATION.
DEFAULT_GPU_MEMORY_UTILIZATION = 0.9
_DTYPE_BYTES = {"bfloat16": 2, "float16": 2, "half": 2, "float32": 4, "float": 4}

# ── Thresholds (R1.4) — named constants, each overridable by an env var ───────
# Severity bands for memory checks, as a fraction of USABLE memory
# (per-GPU memory x GPUs x gpu_memory_utilization):
#   need >  usable x BLOCK_OVER  -> block
#   need >= usable x WARN_FROM   -> warn (margin band)
BLOCK_OVER = 1.00
WARN_FROM = 0.90
# Seconds to wait for a config.json / HF API fetch before the check skips.
FETCH_TIMEOUT_S = 10.0
# Computed MAX_MODEL_LEN fixes round down to a multiple of this.
FIX_ROUND_TOKENS = 1024
# ── Usable GPU memory (W8 calibration) ────────────────────────────────────────
# Every memory check goes through usable_bytes():
#   per-GPU usable = catalog GiB x GPU_VISIBLE_MEMORY_FRACTION x gpu_memory_utilization
#                    - GPU_RUNTIME_RESERVE_GIB
# Calibrated against a live vLLM v0.31 pod (gemma-4-E4B-it, ml.g7.12xlarge,
# TP 2, max_model_len 131072, LoRA 4 x r64, utilization 0.92); see
# docs/architecture/right-sizing.md "Calibration".
#
# GPU_VISIBLE_MEMORY_FRACTION: the catalog's gpuMemoryGb is the marketed size;
# the driver exposes less (ECC / reserved pages). vLLM logged 31.38 GiB total
# per device for a catalogued 32 -> 0.9806; 0.98 rounds that down.
GPU_VISIBLE_MEMORY_FRACTION = 0.98
# GPU_RUNTIME_RESERVE_GIB: per-GPU memory the engine needs at run time that is
# neither weights, LoRA buffer nor KV cache. Measured (vLLM v0.31 "Actual
# usage" line): peak activation 1.23 GiB + CUDA-graph pool 0.36 GiB + non-torch
# 0.33 GiB (the gap between "Model loading took 9.0 GiB" and "9.33 GiB for
# consumed memory (weights + non-torch)": NCCL / cuBLAS workspaces, which do
# not scale with the model) = 1.92 GiB -> 1.9. Activation peak grows with
# max_num_batched_tokens, so a larger scheduler batch may need a larger reserve
# (override it below).
GPU_RUNTIME_RESERVE_GIB = 1.9
THRESHOLD_ENV = {
    "BLOCK_OVER": "MLCC_SIZING_BLOCK_OVER",
    "WARN_FROM": "MLCC_SIZING_WARN_FROM",
    "DEFAULT_GPU_MEMORY_UTILIZATION": "MLCC_SIZING_DEFAULT_GPU_MEMORY_UTILIZATION",
    "LORA_BUFFER_BUDGET_FRACTION": "MLCC_SIZING_LORA_BUDGET_FRACTION",
    "FETCH_TIMEOUT_S": "MLCC_SIZING_FETCH_TIMEOUT",
    "GPU_VISIBLE_MEMORY_FRACTION": "MLCC_SIZING_GPU_VISIBLE_FRACTION",
    "GPU_RUNTIME_RESERVE_GIB": "MLCC_SIZING_GPU_RUNTIME_RESERVE_GIB",
}


def threshold(name: str, env: dict | None = None) -> float:
    """A threshold constant, overridden by its MLCC_SIZING_* env var when set."""
    env = os.environ if env is None else env
    default = float(globals()[name])
    raw = env.get(THRESHOLD_ENV[name], "")
    try:
        return float(raw) if str(raw).strip() else default
    except ValueError:
        return default


# NVIDIA architecture (instances.json gpuArchitecture) -> CUDA compute
# capability. bf16 needs >= 8.0 (Ampere); native FP8 needs >= 8.9 (Ada/Hopper/
# Blackwell). Hardware facts, not engine knowledge. An architecture not listed
# here makes dtype-arch skip (never guess).
GPU_ARCH_COMPUTE_CAPABILITY = {
    "pascal": 6.0, "volta": 7.0, "turing": 7.5, "ampere": 8.0,
    "ada lovelace": 8.9, "hopper": 9.0, "blackwell": 10.0, "blackwell ultra": 10.3,
}
BF16_MIN_CC = 8.0
FP8_MIN_CC = 8.9
# The serving_config_source family whose engine settings are IC_ENV_-prefixed
# (SageMaker inference-component / container Environment; resolve-serving-config.sh).
SAGEMAKER_IC_SOURCE = "sagemaker-ic"
IC_ENV_PREFIX = "IC_ENV_"
# The LoRA on/off switch each serving_config_source family reads (do/deploy's
# LoRA advisory reads the same pair).
LORA_SWITCH_VAR = {"kubernetes": "HP_LORA_ENABLED", SAGEMAKER_IC_SOURCE: "ENABLE_LORA"}


# ── Shapes ─────────────────────────────────────────────────────────────────────


@dataclass
class Finding:
    """One check result. severity: info (FYI) | warn (proceed) | block (refuse)."""

    check: str
    severity: str
    message: str
    fix: str = ""
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "check": self.check,
            "severity": self.severity,
            "message": self.message,
            "fix": self.fix,
            "data": self.data,
        }


@dataclass
class AdapterRank:
    """A rank requirement and where it came from (adapter name / config var)."""

    name: str
    rank: int
    source: str = ""


@dataclass
class SizingContext:
    """Pure inputs for every check. Built from the environment by
    context_from_env(); tests construct it directly."""

    engine: str = "vllm"
    rank_env_var: str = ""
    rank_default: int | None = None
    rank_allowed: list[int] = field(default_factory=list)
    explicit_rank: int | None = None
    # Ranks recorded adapters need (adapter_config.json r / rank_pattern).
    adapters: list[AdapterRank] = field(default_factory=list)
    # Ranks recorded at tune submit (TUNE_LORA_RANK_<TECH>).
    tune_ranks: list[AdapterRank] = field(default_factory=list)
    # The limit lora-rank-fit / lora-buffer-memory evaluate. kind:
    #   "live"      the running deployment's limit (do/adapter pre-check)
    #   "effective" the limit the next deploy will apply
    serving_rank_limit: int | None = None
    limit_kind: str = "effective"
    # True when serving_rank_limit was auto-raised above the manifest default
    # (only an auto-raise is blocked by the memory cap; an explicit choice warns).
    rank_auto_raised: bool = False
    target: str = ""
    max_loras: int | None = None
    tp: int = 1
    model_config: dict | None = None
    dtype_bytes: int | None = None
    gpu_memory_gib: float | None = None
    gpu_memory_utilization: float = DEFAULT_GPU_MEMORY_UTILIZATION
    weights_bytes: int | None = None
    budget_fraction: float = LORA_BUFFER_BUDGET_FRACTION
    # ── Wave 8 inputs (all optional; a check whose inputs are None skips) ──
    # Where weights_bytes came from: "measured" (staged *.safetensors) or
    # "estimate" (params x dtype bytes, instance_sizer constants). OQ-8.9.
    weights_source: str = ""
    family: str = ""                    # targets.d family
    serving_config_source: str = ""     # targets.d serving_config_source
    uses_inference_components: bool = False   # targets.d verbs.add-ic
    quota_usage: str = ""               # targets.d service_quota_usage
    instance_type: str = ""
    instance: dict | None = None        # this instance's catalog entry
    catalog: dict = field(default_factory=dict)   # the whole instance catalog
    serving_gpus: int | None = None     # GPUs the model is placed on (pod / IC / instance)
    tp_source: str = ""
    lora_enabled: bool | None = None    # None = unknown (no target)
    max_model_len: int | None = None
    max_model_len_source: str = ""      # the env var, or "model default"
    max_model_len_var: str = ""         # the var a fix should set
    kv_cache_dtype: str = "auto"
    quantization: str = ""              # engine setting or config quantization_config
    dtype: str = "auto"                 # engine dtype setting
    gpu_memory_utilization_source: str = "module default"
    max_num_seqs: int | None = None
    max_num_seqs_var: str = ""
    # Scheduler batch (tokens) and its sizing_map entry (default,
    # default_by_gpu_memory_gib, in_flight_batches); see inflight_tokens().
    # Empty / None = the engine declares nothing: sliding layers hold only the window.
    max_num_batched_tokens: int | None = None
    batched_tokens_spec: dict = field(default_factory=dict)
    typical_context: int | None = None
    typical_context_source: str = ""
    engine_version: str | None = None
    arch_support: dict | None = None    # model-arch-support.json[engine]
    quantization_methods: list[str] | None = None
    draft: dict | None = None           # {model, algorithm, config, weights_bytes, source}
    ic_confs: list[dict] = field(default_factory=list)   # do/ic/*.conf exports
    instance_count: int = 1
    volume_gb: float | None = None
    volume_source: str = ""
    quota: dict | None = None           # {value, name} when looked up
    network: bool = False               # network-only checks enabled (quota)
    model_id: str = ""
    missing: dict = field(default_factory=dict)   # input -> why it is unavailable


# ── Check registry ─────────────────────────────────────────────────────────────

CHECKS: dict[str, Callable[[SizingContext], list[Finding]]] = {}


def register(name: str):
    """Decorator: register a check under `name` (Wave 8 adds more)."""

    def _wrap(fn):
        CHECKS[name] = fn
        return fn

    return _wrap


def run_checks(ctx: SizingContext, names: list[str] | None = None) -> list[Finding]:
    """Run the named checks (all when None), in registry order."""
    out: list[Finding] = []
    for name, fn in CHECKS.items():
        if names is None or name in names:
            out.extend(fn(ctx))
    return out


def exit_code(findings: list[Finding]) -> int:
    """0 = fits, 1 = warnings, 2 = blocked."""
    sev = {f.severity for f in findings}
    if "block" in sev:
        return 2
    if "warn" in sev:
        return 1
    return 0


# ── Rank helpers ───────────────────────────────────────────────────────────────


def adapter_config_rank(cfg: dict | None) -> int | None:
    """The largest rank a PEFT adapter_config.json needs: max(r, *rank_pattern).
    vLLM's PEFTHelper.validate_legal rejects max(r, *rank_pattern.values()) >
    max_lora_rank, so the pattern counts too. None when unreadable."""
    if not isinstance(cfg, dict):
        return None
    ranks = []
    r = cfg.get("r")
    if isinstance(r, int) and r > 0:
        ranks.append(r)
    pattern = cfg.get("rank_pattern")
    if isinstance(pattern, dict):
        ranks.extend(v for v in pattern.values() if isinstance(v, int) and v > 0)
    return max(ranks) if ranks else None


def snap_up(value: int, allowed: list[int]) -> int | None:
    """The smallest allowed value >= value; `value` itself when the engine accepts
    any integer (allowed == []); None when value exceeds every allowed value."""
    if not allowed:
        return value
    for a in sorted(allowed):
        if a >= value:
            return a
    return None


def _fmt_gib(nbytes: float) -> str:
    return f"{nbytes / GIB:.2f} GiB"


# ── Memory model ───────────────────────────────────────────────────────────────


def _text_config(cfg: dict) -> dict:
    tc = cfg.get("text_config")
    return tc if isinstance(tc, dict) and tc.get("hidden_size") else cfg


def model_dtype_bytes(cfg: dict | None) -> int:
    """LoRA weights use the model dtype (vLLM lora_dtype=auto). Default bf16."""
    if not isinstance(cfg, dict):
        return 2
    t = _text_config(cfg)
    for src in (t, cfg):
        for key in ("dtype", "torch_dtype"):
            val = src.get(key)
            if isinstance(val, str) and val.lower() in _DTYPE_BYTES:
                return _DTYPE_BYTES[val.lower()]
    return 2


def lora_module_dims(cfg: dict) -> list[tuple[int, int, str]]:
    """Every LoRA-wrapped linear in the language model as (in, out, parallel),
    parallel ∈ {"col", "row"}. Reads hidden/intermediate sizes, heads, KV heads,
    head_dim and (Gemma-style) layer_types + global_head_dim from config.json.
    MoE models count every expert's MLP (upper bound). Raises KeyError/TypeError
    when the config lacks the basic dims."""
    t = _text_config(cfg)
    hidden = int(t["hidden_size"])
    layers = int(t["num_hidden_layers"])
    heads = int(t["num_attention_heads"])
    kv_heads = int(t.get("num_key_value_heads") or heads)
    head_dim = int(t.get("head_dim") or hidden // heads)
    inter = int(t.get("intermediate_size") or 4 * hidden)
    layer_types = t.get("layer_types") if isinstance(t.get("layer_types"), list) else []
    global_head_dim = t.get("global_head_dim")
    global_kv = t.get("num_global_key_value_heads")
    experts = int(t.get("num_experts") or t.get("n_routed_experts") or 0)
    expert_inter = int(t.get("moe_intermediate_size") or t.get("expert_intermediate_size") or inter)

    dims: list[tuple[int, int, str]] = []
    for i in range(layers):
        full = i < len(layer_types) and layer_types[i] == "full_attention"
        d = int(global_head_dim) if (full and global_head_dim) else head_dim
        k = int(global_kv) if (full and global_kv) else kv_heads
        dims += [
            (hidden, heads * d, "col"),  # q_proj
            (hidden, k * d, "col"),      # k_proj
            (hidden, k * d, "col"),      # v_proj
            (heads * d, hidden, "row"),  # o_proj
        ]
        mlp_inter, copies = (expert_inter, experts) if experts > 0 else (inter, 1)
        for _ in range(copies):
            dims += [
                (hidden, mlp_inter, "col"),  # gate_proj
                (hidden, mlp_inter, "col"),  # up_proj
                (mlp_inter, hidden, "row"),  # down_proj
            ]
    return dims


def lora_buffer_bytes_per_gpu(cfg: dict, rank: int, max_loras: int, tp: int,
                              dtype_bytes: int | None = None) -> float:
    """Per-GPU bytes vLLM preallocates for the LoRA A/B stacks (formula above)."""
    tp = max(int(tp or 1), 1)
    dtype_bytes = dtype_bytes or model_dtype_bytes(cfg)
    per_rank = 0.0
    for n_in, n_out, par in lora_module_dims(cfg):
        if par == "col":
            per_rank += n_in + n_out / tp
        else:
            per_rank += n_in / tp + n_out
    return float(max_loras) * float(rank) * float(dtype_bytes) * per_rank


def lora_buffer_budget_bytes(gpu_memory_gib: float, utilization: float, weights_bytes: int,
                             tp: int, fraction: float = LORA_BUFFER_BUDGET_FRACTION) -> float:
    """fraction x (per-GPU usable memory - per-GPU weights); usable is
    usable_bytes() for one GPU (visible fraction, utilization, runtime reserve)."""
    tp = max(int(tp or 1), 1)
    left = usable_bytes(gpu_memory_gib, 1, utilization) - float(weights_bytes) / tp
    return max(left, 0.0) * fraction


def _memory_inputs_missing(ctx: SizingContext) -> list[str]:
    missing = []
    if not isinstance(ctx.model_config, dict):
        missing.append("model config.json")
    if not ctx.gpu_memory_gib:
        missing.append("per-GPU memory (instance catalog)")
    if ctx.weights_bytes is None:
        missing.append("model weight size")
    if not ctx.max_loras:
        missing.append("max_loras")
    return missing


def max_rank_within_budget(ctx: SizingContext) -> int | None:
    """The largest allowed rank whose buffer fits the budget (None if none fit or
    inputs are missing). Only meaningful for engines with an allowed set."""
    if _memory_inputs_missing(ctx) or not ctx.rank_allowed:
        return None
    budget = lora_buffer_budget_bytes(ctx.gpu_memory_gib, ctx.gpu_memory_utilization,
                                      ctx.weights_bytes, ctx.tp, ctx.budget_fraction)
    best = None
    for r in sorted(ctx.rank_allowed):
        if lora_buffer_bytes_per_gpu(ctx.model_config, r, ctx.max_loras, ctx.tp, ctx.dtype_bytes) <= budget:
            best = r
    return best


# ── Checks ─────────────────────────────────────────────────────────────────────


def _rank_fix(ctx: SizingContext, need: int) -> str:
    snapped = snap_up(need, ctx.rank_allowed) or need
    var = ctx.rank_env_var or "the engine's MAX_LORA_RANK"
    target = ctx.target or "<target>"
    if target in ("realtime-inference", "managed-inference", "realtime"):
        return (
            f"Raise the base inference component's limit to {snapped}: set IC_ENV_{var}={snapped} in "
            f"do/config and recreate it: ./do/deploy --target realtime-inference --force-ic. "
            f"vLLM fixes max_lora_rank at start."
        )
    surge = " (add --surge-node on a single-node HyperPod instance group)" if target in ("hyperpod-eks", "hyperpod") else ""
    return (
        f"Raise the serving limit to {snapped}, then redeploy: set {var}={snapped} in do/config "
        f"(or unset it so deploy derives it from the recorded tune adapters) and run "
        f"./do/deploy --target {target} --force{surge}. vLLM fixes max_lora_rank at start, "
        f"so the pod must restart."
    )


@register("lora-rank-fit")
def check_lora_rank_fit(ctx: SizingContext) -> list[Finding]:
    """Each adapter's rank must be <= the serving max_lora_rank. Against the LIVE
    limit (do/adapter pre-check) an excess blocks; against the effective limit
    (an explicit override below need) it warns — the explicit value wins."""
    if ctx.lora_enabled is False:
        return [Finding("lora-rank-fit", "skip", "skipped: LoRA is not enabled for this target")]
    limit = ctx.serving_rank_limit
    if limit is None:
        return [Finding("lora-rank-fit", "skip", "skipped: no serving max_lora_rank known; rank fit not checked")]
    out = []
    for a in ctx.adapters:
        if a.rank > limit:
            sev = "block" if ctx.limit_kind == "live" else "warn"
            where = "the running deployment's" if ctx.limit_kind == "live" else "the configured"
            out.append(Finding(
                "lora-rank-fit", sev,
                f"adapter '{a.name}' has LoRA rank {a.rank}, above {where} max_lora_rank {limit}; "
                f"vLLM rejects it (\"LoRA rank {a.rank} is greater than max_lora_rank {limit}\").",
                fix=_rank_fix(ctx, a.rank),
                data={"adapter": a.name, "rank": a.rank, "limit": limit, "source": a.source},
            ))
    return out


@register("lora-buffer-memory")
def check_lora_buffer_memory(ctx: SizingContext) -> list[Finding]:
    """The LoRA buffer at the serving rank must fit 10% of the post-weights GPU
    memory. Above the cap an AUTO-RAISED rank blocks (never silently capped);
    an explicit rank only warns (the user's choice wins)."""
    if ctx.lora_enabled is False:
        return [Finding("lora-buffer-memory", "skip", "skipped: LoRA is not enabled for this target")]
    rank = ctx.serving_rank_limit
    missing = _memory_inputs_missing(ctx)
    if rank is None or missing:
        why = ", ".join(missing) if missing else "no serving rank"
        return [Finding("lora-buffer-memory", "skip", f"skipped: LoRA buffer memory not checked (missing: {why})")]
    need = lora_buffer_bytes_per_gpu(ctx.model_config, rank, ctx.max_loras, ctx.tp, ctx.dtype_bytes)
    budget = lora_buffer_budget_bytes(ctx.gpu_memory_gib, ctx.gpu_memory_utilization,
                                      ctx.weights_bytes, ctx.tp, ctx.budget_fraction)
    per_gpu_usable = usable_bytes(ctx.gpu_memory_gib, 1, ctx.gpu_memory_utilization)
    data = {
        "rank": rank, "max_loras": ctx.max_loras, "tp": ctx.tp,
        "buffer_bytes_per_gpu": int(need), "budget_bytes_per_gpu": int(budget),
        "gpu_memory_gib": ctx.gpu_memory_gib, "utilization": ctx.gpu_memory_utilization,
        "usable_bytes_per_gpu": int(per_gpu_usable),
        "weights_bytes_per_gpu": int(ctx.weights_bytes / max(ctx.tp, 1)),
    }
    summary = (
        f"LoRA buffer at max_lora_rank {rank} (max_loras {ctx.max_loras}, TP {ctx.tp}) is "
        f"{_fmt_gib(need)} per GPU; the cap is {int(ctx.budget_fraction * 100)}% of "
        f"({_fmt_gib(per_gpu_usable)} usable per GPU - {_fmt_gib(data['weights_bytes_per_gpu'])} weights) "
        f"= {_fmt_gib(budget)}"
    )
    if need <= budget:
        return [Finding("lora-buffer-memory", "info", summary + " — fits.", data=data)]
    fits = max_rank_within_budget(ctx)
    drivers = [a for a in ctx.adapters + ctx.tune_ranks if fits is None or a.rank > fits]
    names = ", ".join(f"{a.name} (r{a.rank})" for a in drivers) or "the configured rank"
    data["max_rank_within_budget"] = fits
    data["adapters"] = [a.name for a in drivers]
    if ctx.rank_auto_raised:
        return [Finding(
            "lora-buffer-memory", "block",
            summary + f" — over the cap. Raising max_lora_rank to {rank} for {names} would take "
            f"KV-cache memory beyond the {int(ctx.budget_fraction * 100)}% budget, so deploy refuses rather than cap it.",
            fix=(f"Serve these adapters on a larger GPU instance, or lower max_loras ({ctx.max_loras}), "
                 f"or set {ctx.rank_env_var or 'MAX_LORA_RANK'} explicitly to accept the cost"
                 + (f" (largest rank that fits: {fits})" if fits else "") + "."),
            data=data,
        )]
    return [Finding("lora-buffer-memory", "warn", summary + f" — over the cap (explicit rank; proceeding). Driven by: {names}.",
                    data=data)]


# ── effective_lora_rank (R2.3) ────────────────────────────────────────────────


def effective_lora_rank(ctx: SizingContext) -> dict:
    """Derive the serving max_lora_rank. Returns
    {rank, required, derived, explicit, default, allowed, findings[]}.

    required = max(recorded adapter ranks, TUNE_LORA_RANK_*), 0 when none
    derived  = snap_up(max(required, default), allowed)
    rank     = explicit when set (wins, with a warning if below required), else derived
    The memory cap is evaluated at `rank` (an auto-raise above the cap blocks).
    """
    findings: list[Finding] = []
    all_needs = ctx.adapters + ctx.tune_ranks
    required = max((a.rank for a in all_needs), default=0)
    default = ctx.rank_default or 0
    floor = max(required, default)
    derived = snap_up(floor, ctx.rank_allowed) if floor else None
    if floor and derived is None:
        top = [a for a in all_needs if a.rank > max(ctx.rank_allowed)]
        findings.append(Finding(
            "lora-rank-fit", "block",
            f"required LoRA rank {floor} ({', '.join(f'{a.name} r{a.rank}' for a in top)}) exceeds the "
            f"largest rank {ctx.engine} supports ({max(ctx.rank_allowed)}).",
            fix="Retune that technique with a supported lora_rank.",
            data={"required": floor, "allowed": ctx.rank_allowed},
        ))
    rank = derived
    auto_raised = bool(derived and default and derived > default)
    if ctx.explicit_rank is not None:
        rank = ctx.explicit_rank
        auto_raised = False
        if ctx.rank_allowed and ctx.explicit_rank not in ctx.rank_allowed:
            findings.append(Finding(
                "lora-rank-fit", "block",
                f"{ctx.rank_env_var}={ctx.explicit_rank} is not a value {ctx.engine} accepts "
                f"({', '.join(str(a) for a in ctx.rank_allowed)}); the engine would fail to start.",
                fix=f"Set {ctx.rank_env_var} to {snap_up(ctx.explicit_rank, ctx.rank_allowed) or max(ctx.rank_allowed)} "
                    f"or unset it so deploy derives it.",
            ))
        if required and ctx.explicit_rank < required:
            need = [a for a in all_needs if a.rank > ctx.explicit_rank]
            findings.append(Finding(
                "lora-rank-fit", "warn",
                f"explicit {ctx.rank_env_var}={ctx.explicit_rank} is below what recorded adapters need "
                f"({', '.join(f'{a.name} r{a.rank}' for a in need)}); those adapters will be refused at load.",
                fix=f"Unset {ctx.rank_env_var} (deploy derives {derived}) or raise it to {derived}.",
                data={"explicit": ctx.explicit_rank, "required": required, "derived": derived},
            ))
    if rank is not None:
        mem_ctx = SizingContext(**{**ctx.__dict__, "serving_rank_limit": rank, "rank_auto_raised": auto_raised,
                                   "limit_kind": "effective"})
        findings.extend(check_lora_buffer_memory(mem_ctx))
    return {
        "rank": rank,
        "required": required,
        "derived": derived,
        "explicit": ctx.explicit_rank,
        "default": ctx.rank_default,
        "allowed": ctx.rank_allowed,
        "auto_raised": auto_raised,
        "findings": [f.to_dict() for f in findings],
    }


# ── Wave 8: model-config helpers (pure) ───────────────────────────────────────

# vLLM's _get_and_verify_max_len reads the smallest of these from the text config.
_MAX_LEN_KEYS = ("max_position_embeddings", "n_positions", "max_seq_len", "seq_length",
                 "max_sequence_length", "max_seq_length", "seq_len")
_NO_QUANT = ("", "none", "null", "false", "auto")


def _int(val) -> int | None:
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def derived_max_model_len(cfg: dict | None) -> tuple[int | None, dict]:
    """The context length the engine derives from config.json when MAX_MODEL_LEN
    is unset (and the ceiling it enforces when it is set): the smallest declared
    length key, times the rope-scaling factor for rope types vLLM scales (not
    su / longrope / llama3, not Gemma-3; yarn scales original_max_position_embeddings)."""
    if not isinstance(cfg, dict):
        return None, {}
    t = _text_config(cfg)
    found = {k: _int(t.get(k)) for k in _MAX_LEN_KEYS if _int(t.get(k))}
    if not found:
        return None, {}
    key = min(found, key=lambda k: found[k])
    base = found[key]
    info = {"key": key, "declared": base}
    rope = t.get("rope_scaling")
    model_type = str(t.get("model_type") or cfg.get("model_type") or "")
    if isinstance(rope, dict) and "gemma3" not in model_type:
        rtype = rope.get("rope_type") or rope.get("type") or ""
        factor = rope.get("factor")
        if rtype not in ("su", "longrope", "llama3") and isinstance(factor, (int, float)) and factor > 0:
            if rtype == "yarn" and _int(rope.get("original_max_position_embeddings")):
                base = _int(rope.get("original_max_position_embeddings"))
            base = int(base * factor)
            info.update({"rope_type": rtype, "rope_factor": factor})
    return base, info


def kv_layout(cfg: dict) -> dict:
    """Per-layer KV-cache layout from config.json (text sub-config for multimodal
    models). Returns {layers: [{kind, elems}], window, shared, uncertain} where
    `elems` is the per-token element count the layer caches (before TP and dtype)
    and kind ∈ full | sliding | other. Raises KeyError/TypeError when the config
    lacks the basic dims."""
    t = _text_config(cfg)
    n_layers = int(t["num_hidden_layers"])
    heads = int(t["num_attention_heads"])
    kv_heads = int(t.get("num_key_value_heads") or heads)
    head_dim = int(t.get("head_dim") or int(t["hidden_size"]) // heads)
    global_head_dim = _int(t.get("global_head_dim"))
    global_kv = _int(t.get("num_global_key_value_heads"))
    shared = _int(t.get("num_kv_shared_layers")) or 0
    window = _int(t.get("sliding_window"))
    pattern = _int(t.get("sliding_window_pattern"))
    layer_types = t.get("layer_types") if isinstance(t.get("layer_types"), list) else []
    use_sw = t.get("use_sliding_window")
    mla = _int(t.get("kv_lora_rank"))
    rope_dim = _int(t.get("qk_rope_head_dim")) or 0
    uncertain = []
    layers = []
    for i in range(max(n_layers - shared, 0)):
        if layer_types and i < len(layer_types):
            lt = str(layer_types[i])
            kind = "full" if lt == "full_attention" else "sliding" if lt == "sliding_attention" else "other"
        elif window and pattern and pattern > 0:
            kind = "full" if (i + 1) % pattern == 0 else "sliding"
        elif window and use_sw is not False:
            kind = "sliding"
        else:
            kind = "full"
        if mla:
            layers.append({"kind": kind, "elems": mla + rope_dim, "mla": True})
            continue
        d = global_head_dim if (kind == "full" and global_head_dim) else head_dim
        k = global_kv if (kind == "full" and global_kv) else kv_heads
        layers.append({"kind": kind, "elems": 2 * k * d, "kv_heads": k, "head_dim": d})
    if any(lay["kind"] == "other" for lay in layers):
        uncertain.append("non-attention layer types (counted as full attention in the upper bound)")
    if window and not layer_types and not pattern and use_sw is not False:
        uncertain.append("sliding window applied to every layer (config declares no layer pattern)")
    return {"layers": layers, "window": window, "shared": shared, "uncertain": uncertain,
            "sliding": any(lay["kind"] != "full" for lay in layers)}


def kv_cache_bytes(layout: dict, tokens: int, kv_bytes: int, tp: int = 1, window_aware: bool = False,
                   inflight_tokens: int = 0) -> float:
    """Total KV bytes (all GPUs) for one sequence of `tokens`. TP shards KV heads;
    when TP exceeds a layer's KV heads each GPU still holds one head (replicated),
    and an MLA latent cache is replicated on every GPU.

    Window-aware, a sliding layer holds window + `inflight_tokens` tokens: during
    chunked prefill the engine keeps the window plus every scheduled-but-unsettled
    token (vLLM v0.31 SlidingWindowSpec: window - 1 + max_in_flight_tokens, +1
    block). See inflight_tokens()."""
    tp = max(int(tp or 1), 1)
    window = layout.get("window") or 0
    total = 0.0
    for lay in layout["layers"]:
        n = tokens
        if window_aware:
            if lay["kind"] == "sliding" and window:
                n = min(tokens, window + max(int(inflight_tokens or 0), 0))
            elif lay["kind"] == "other":
                n = 0
        if lay.get("mla"):
            elems = lay["elems"] * tp
        else:
            elems = 2 * max(lay["kv_heads"], tp) * lay["head_dim"]
        total += float(elems) * kv_bytes * n
    return total


def kv_dtype_bytes(kv_cache_dtype: str, model_bytes: int) -> int | None:
    """Bytes per KV element: auto -> the model dtype; fp8 variants -> 1."""
    v = (kv_cache_dtype or "auto").lower()
    if v == "auto":
        return model_bytes
    if v.startswith("fp8") or v in ("int8", "uint8"):
        return 1
    return _DTYPE_BYTES.get(v)


def _tower_params(sub: dict) -> int:
    """Parameter count of a vision / audio encoder from its sub-config (attention
    4h^2 + MLP 2h*inter per layer). 0 when the dims are not declared."""
    h = _int(sub.get("hidden_size"))
    n = _int(sub.get("num_hidden_layers") or sub.get("depth") or sub.get("num_layers"))
    if not h or not n:
        return 0
    inter = _int(sub.get("intermediate_size")) or 4 * h
    return n * (4 * h * h + 2 * h * inter)


def estimate_params(cfg: dict) -> tuple[int | None, dict]:
    """Parameter count from config.json: num_parameters when declared, else the
    sum of the language model's linear layers (lora_module_dims) + embeddings
    (x2 when untied) + per-layer-input embeddings + any vision/audio tower.
    Returns (params, breakdown). (None, {}) when the dims are missing."""
    if _int(cfg.get("num_parameters")):
        return _int(cfg["num_parameters"]), {"source": "config num_parameters"}
    try:
        t = _text_config(cfg)
        linear = sum(i * o for i, o, _ in lora_module_dims(cfg))
        hidden = int(t["hidden_size"])
    except (KeyError, TypeError, ValueError):
        return None, {}
    vocab = _int(t.get("vocab_size") or cfg.get("vocab_size")) or 0
    tied = t.get("tie_word_embeddings", cfg.get("tie_word_embeddings", True))
    embed = vocab * hidden * (1 if tied else 2)
    ple = (_int(t.get("vocab_size_per_layer_input")) or 0) * (_int(t.get("hidden_size_per_layer_input")) or 0) \
        * (_int(t.get("num_hidden_layers")) or 0)
    towers = {k: _tower_params(cfg[k]) for k in ("vision_config", "audio_config") if isinstance(cfg.get(k), dict)}
    total = linear + embed + ple + sum(towers.values())
    return total, {"source": "config dims", "linear": linear, "embeddings": embed,
                   "per_layer_embeddings": ple, "towers": towers}


def _weights_dtype_name(cfg: dict | None, dtype_setting: str) -> str:
    v = (dtype_setting or "auto").lower()
    if v != "auto":
        return {"half": "float16", "float": "float32"}.get(v, v)
    for src in ((_text_config(cfg), cfg) if isinstance(cfg, dict) else ()):
        for key in ("dtype", "torch_dtype"):
            val = src.get(key)
            if isinstance(val, str) and val.lower() in instance_sizer.BYTES_PER_PARAM:
                return val.lower()
    return "bfloat16"


def estimate_weights_bytes(cfg: dict, dtype_name: str) -> tuple[int | None, dict]:
    """params x bytes/param with instance_sizer's BYTES_PER_PARAM (OQ-8.9)."""
    params, breakdown = estimate_params(cfg)
    if not params:
        return None, {}
    bpp = instance_sizer.BYTES_PER_PARAM.get(dtype_name, instance_sizer.BYTES_PER_PARAM["float16"])
    return int(params * bpp), {**breakdown, "params": params, "bytes_per_param": bpp, "dtype": dtype_name}


def _is_quantized(q: str) -> bool:
    return str(q or "").strip().lower() not in _NO_QUANT


def _gib(nbytes: float) -> str:
    return f"{nbytes / GIB:.1f} GiB"


def _skip(check: str, why: str, **data) -> list[Finding]:
    return [Finding(check, "skip", f"skipped: {why}", data=data)]


def _gpu_inputs_missing(ctx: SizingContext) -> str:
    if not ctx.instance_type:
        return "no instance type configured"
    if not ctx.instance:
        return f"instance {ctx.instance_type} is not in the instance catalog"
    if not _int(ctx.instance.get("gpus")) or not ctx.instance.get("gpuMemoryGb"):
        return f"{ctx.instance_type} is not a GPU instance"
    return ""


# ── Wave 8: memory model (pure) ───────────────────────────────────────────────


def _lora_total_bytes(ctx: SizingContext, tp: int) -> float:
    """LoRA buffer across TP GPUs (6.1 per-GPU term x TP) when LoRA is on."""
    if ctx.lora_enabled is False or not ctx.serving_rank_limit or not ctx.max_loras \
            or not isinstance(ctx.model_config, dict):
        return 0.0
    try:
        return lora_buffer_bytes_per_gpu(ctx.model_config, ctx.serving_rank_limit, ctx.max_loras, tp,
                                         ctx.dtype_bytes) * max(tp, 1)
    except (KeyError, TypeError, ValueError):
        return 0.0


def inflight_tokens(ctx: SizingContext, gpu_memory_gib: float | None = None) -> int:
    """Tokens a sliding-window layer holds beyond the window (scheduled, not yet
    settled): max_num_batched_tokens x in_flight_batches. The batch is the engine
    setting, else the engine manifest's sizing_map default for this GPU size
    (default_by_gpu_memory_gib: the largest floor <= the GPU's memory wins).
    0 when the engine declares nothing (sliding layers then hold only the window)."""
    spec = ctx.batched_tokens_spec or {}
    batches = _int(spec.get("in_flight_batches")) or 1
    per = ctx.max_num_batched_tokens
    if not per:
        per = _int(spec.get("default")) or 0
        mem = float(gpu_memory_gib if gpu_memory_gib is not None else (ctx.gpu_memory_gib or 0))
        tiers = spec.get("default_by_gpu_memory_gib") or {}
        for floor, val in sorted((float(k), v) for k, v in tiers.items()):
            if mem >= floor and _int(val):
                per = _int(val)
    return int(per) * batches


def memory_terms(ctx: SizingContext, tokens: int, tp: int | None = None,
                 gpu_memory_gib: float | None = None) -> dict:
    """Every term of the context-memory sum for `tokens` of context at TP `tp`
    (on GPUs of `gpu_memory_gib`, default this instance's). Bytes are totals
    across the TP GPUs.

    Weights vs what vLLM v0.31 reports (W8 calibration): "Model loading took
    9.0 GiB" is measured around load_model(), which also creates the LoRA A/B
    stacks (v1/worker/gpu/model_runner.py: load_lora_model runs inside the same
    DeviceMemoryProfiler) — so vLLM's figure is weights + LoRA buffer. Here the
    two stay separate terms, each counted once: weights x (1 + OVERHEAD_FACTOR)
    (7.45 GiB measured per GPU -> 8.19, covering TP-replicated tensors) + LoRA
    0.73 GiB = 8.92 GiB vs vLLM's 9.0. The rest of vLLM's 9.33 GiB "weights +
    non-torch" (0.33 GiB NCCL / cuBLAS workspaces) is per-GPU and size-
    independent, so it sits in GPU_RUNTIME_RESERVE_GIB, not here."""
    tp = max(int(tp or ctx.tp or 1), 1)
    layout = kv_layout(ctx.model_config)
    model_bytes = ctx.dtype_bytes or model_dtype_bytes(ctx.model_config)
    kvb = kv_dtype_bytes(ctx.kv_cache_dtype, model_bytes) or model_bytes
    overhead = instance_sizer.OVERHEAD_FACTOR
    weights = float(ctx.weights_bytes or 0) * (1 + overhead)
    draft = float((ctx.draft or {}).get("weights_bytes") or 0) * (1 + overhead)
    lora = _lora_total_bytes(ctx, tp)
    inflight = inflight_tokens(ctx, gpu_memory_gib)
    kv_upper = kv_cache_bytes(layout, tokens, kvb, tp, window_aware=False)
    kv_lower = kv_cache_bytes(layout, tokens, kvb, tp, window_aware=True, inflight_tokens=inflight)
    fixed = weights + draft + lora
    return {
        "tokens": tokens, "tp": tp, "kv_bytes_per_element": kvb,
        "weights_bytes": int(weights), "weights_overhead_factor": overhead,
        "draft_weights_bytes": int(draft), "lora_buffer_bytes": int(lora),
        "kv_upper_bytes": int(kv_upper), "kv_lower_bytes": int(kv_lower),
        "kv_upper_bytes_per_token": int(kv_upper / tokens) if tokens else 0,
        "need_upper_bytes": int(fixed + kv_upper), "need_lower_bytes": int(fixed + kv_lower),
        "sliding": layout["sliding"], "window": layout["window"], "kv_shared_layers": layout["shared"],
        "sliding_inflight_tokens": inflight if layout["sliding"] else 0,
        "uncertain": layout["uncertain"],
    }


def usable_bytes(gpu_memory_gib: float, gpus: int, utilization: float) -> float:
    """Usable GPU memory (bytes, all `gpus`) — the single figure every memory
    check compares against: per GPU, catalog GiB x GPU_VISIBLE_MEMORY_FRACTION x
    utilization - GPU_RUNTIME_RESERVE_GIB (both MLCC_SIZING_* overridable)."""
    visible = threshold("GPU_VISIBLE_MEMORY_FRACTION")
    reserve = threshold("GPU_RUNTIME_RESERVE_GIB")
    per_gpu = float(gpu_memory_gib) * visible * float(utilization) - reserve
    return max(per_gpu, 0.0) * GIB * max(int(gpus or 1), 1)


def kv_capacity(ctx: SizingContext) -> dict | None:
    """KV-cache capacity left after the fixed terms, in vLLM's own terms. Returns
    {free_bytes, full_attention_tokens, window_aware_tokens?, seq_len?} or None
    when nothing is left. Window-aware (sliding / hybrid models) follows vLLM's
    "GPU KV cache size: N tokens" = max concurrency x max_model_len, where one
    max_model_len request holds every full layer for all its tokens and every
    sliding layer for window + in-flight tokens."""
    one = memory_terms(ctx, 1)
    usable = usable_bytes(ctx.gpu_memory_gib, one["tp"], ctx.gpu_memory_utilization)
    free = usable - (one["need_lower_bytes"] - one["kv_lower_bytes"])
    per_tok = one["kv_upper_bytes"]
    if free <= 0 or not per_tok:
        return None
    out = {"free_bytes": free, "full_attention_tokens": int(free // per_tok)}
    seq_len = ctx.max_model_len or derived_max_model_len(ctx.model_config)[0]
    if one["sliding"] and one["window"] and seq_len:
        per_seq = memory_terms(ctx, seq_len)["kv_lower_bytes"]
        if per_seq > 0:
            out.update({"window_aware_tokens": int(free / per_seq * seq_len), "seq_len": seq_len})
    return out


def max_fitting_len(ctx: SizingContext, usable: float, window_aware: bool, ceiling: int) -> int | None:
    """Largest context (rounded down to FIX_ROUND_TOKENS when >= it) whose
    estimate fits `usable`. None when even 1 token does not fit."""
    key = "need_lower_bytes" if window_aware else "need_upper_bytes"
    if memory_terms(ctx, 1)[key] > usable:
        return None
    lo, hi = 1, max(int(ceiling), 1)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if memory_terms(ctx, mid)[key] <= usable:
            lo = mid
        else:
            hi = mid - 1
    return (lo // FIX_ROUND_TOKENS) * FIX_ROUND_TOKENS if lo >= FIX_ROUND_TOKENS else lo


def _divides_heads(cfg: dict, tp: int) -> bool:
    try:
        t = _text_config(cfg)
        heads = int(t["num_attention_heads"])
        kv = int(t.get("num_key_value_heads") or heads)
    except (KeyError, TypeError, ValueError):
        return True
    return heads % tp == 0 and (kv % tp == 0 or tp % kv == 0)


def smallest_fitting_instance(ctx: SizingContext, tokens: int, window_aware: bool = True) -> tuple[str, dict] | None:
    """The catalogued GPU instance with the least total GPU memory whose usable
    memory holds the estimate at `tokens` (window-aware, or the full-attention
    upper bound) when served with TP = its GPU count (TP must divide the heads)."""
    key = "need_lower_bytes" if window_aware else "need_upper_bytes"
    best = None
    util = ctx.gpu_memory_utilization
    blk = threshold("BLOCK_OVER")
    for name, entry in sorted((ctx.catalog or {}).items()):
        if not isinstance(entry, dict):
            continue
        gpus, mem = _int(entry.get("gpus")), entry.get("gpuMemoryGb")
        if not gpus or not mem or not _divides_heads(ctx.model_config, gpus):
            continue
        need = memory_terms(ctx, tokens, gpus, float(mem))[key]
        if need > usable_bytes(mem, gpus, util) * blk:
            continue
        total = float(mem) * gpus
        if best is None or (total, gpus, name) < (best[1]["total_gpu_memory_gib"], best[1]["gpus"], best[0]):
            best = (name, {"gpus": gpus, "gpu_memory_gib": float(mem), "total_gpu_memory_gib": total})
    return best


# ── Wave 8 checks ──────────────────────────────────────────────────────────────


@register("context-limit")
def check_context_limit(ctx: SizingContext) -> list[Finding]:
    """A configured max_model_len above the model's own context limit (incl.
    rope scaling the config declares): the engine refuses to start."""
    if not isinstance(ctx.model_config, dict):
        return _skip("context-limit", f"model config.json unavailable ({ctx.missing.get('model_config', 'not fetched')})")
    limit, info = derived_max_model_len(ctx.model_config)
    if not limit:
        return _skip("context-limit", "config.json declares no max_position_embeddings / sequence-length key")
    if ctx.max_model_len is None or ctx.max_model_len_source == "model default":
        return [Finding("context-limit", "info",
                        f"max_model_len not set: the engine uses the model's limit ({limit:,} tokens)",
                        data={"limit": limit, **info})]
    data = {"max_model_len": ctx.max_model_len, "limit": limit, "source": ctx.max_model_len_source, **info}
    if ctx.max_model_len > limit:
        return [Finding("context-limit", "block",
                        f"{ctx.max_model_len_source}={ctx.max_model_len:,} exceeds the model's context limit "
                        f"({limit:,} tokens from config.json {info.get('key')}); the engine refuses to start.",
                        fix=f"set {ctx.max_model_len_var or ctx.max_model_len_source}={limit} or lower", data=data)]
    return [Finding("context-limit", "info", f"max_model_len {ctx.max_model_len:,} is within the model's limit ({limit:,})",
                    data=data)]


@register("tp-divisibility")
def check_tp_divisibility(ctx: SizingContext) -> list[Finding]:
    """TP degree must not exceed the GPUs the model gets, and must divide the
    attention heads (KV heads: divide, or be a multiple of, the TP degree)."""
    why = _gpu_inputs_missing(ctx)
    if why:
        return _skip("tp-divisibility", why)
    tp = max(ctx.tp or 1, 1)
    inst_gpus = _int(ctx.instance.get("gpus")) or 0
    # The model can use no more GPUs than it is given (pod / IC) nor than the instance has.
    gpus = min(ctx.serving_gpus or inst_gpus, inst_gpus)
    data = {"tp": tp, "tp_source": ctx.tp_source, "serving_gpus": gpus,
            "instance_gpus": _int(ctx.instance.get("gpus"))}
    out = []
    if tp > (gpus or 0):
        out.append(Finding("tp-divisibility", "block",
                           f"tensor-parallel degree {tp} ({ctx.tp_source}) exceeds the {gpus} GPU(s) the model is "
                           f"placed on ({ctx.instance_type}); the engine fails to start.",
                           fix=f"set the TP degree to {gpus} or fewer, or use an instance with >= {tp} GPUs", data=data))
    if not isinstance(ctx.model_config, dict):
        out.extend(_skip("tp-divisibility", "head divisibility not checked: model config.json unavailable", **data))
        return out
    t = _text_config(ctx.model_config)
    heads = _int(t.get("num_attention_heads"))
    kv = _int(t.get("num_key_value_heads")) or heads
    data.update({"num_attention_heads": heads, "num_key_value_heads": kv})
    if heads and heads % tp:
        out.append(Finding("tp-divisibility", "block",
                           f"TP {tp} does not divide num_attention_heads {heads}; vLLM refuses the config.",
                           fix="use a TP degree that divides " + str(heads), data=data))
    elif kv and kv % tp and tp % kv:
        out.append(Finding("tp-divisibility", "block",
                           f"TP {tp} neither divides nor is a multiple of num_key_value_heads {kv}.",
                           fix=f"use a TP degree that divides {kv} or is a multiple of it", data=data))
    if not out:
        out.append(Finding("tp-divisibility", "info", f"TP {tp} fits {gpus} GPU(s) and divides the attention heads",
                           data=data))
    return out


@register("dtype-arch")
def check_dtype_arch(ctx: SizingContext) -> list[Finding]:
    """bf16 needs Ampere+; FP8 weights / KV cache need Ada/Hopper/Blackwell for
    native FP8 (vLLM runs FP8 weights weight-only on Ampere; older GPUs refuse)."""
    why = _gpu_inputs_missing(ctx)
    if why:
        return _skip("dtype-arch", why)
    arch = str(ctx.instance.get("gpuArchitecture") or "")
    cc = GPU_ARCH_COMPUTE_CAPABILITY.get(arch.lower())
    if cc is None:
        return _skip("dtype-arch", f"GPU architecture '{arch or 'unrecorded'}' of {ctx.instance_type} is not mapped "
                                   "to a compute capability")
    dtype = _weights_dtype_name(ctx.model_config, ctx.dtype) if (ctx.model_config or ctx.dtype != "auto") else ""
    data = {"gpu_architecture": arch, "compute_capability": cc, "dtype": dtype,
            "quantization": ctx.quantization, "kv_cache_dtype": ctx.kv_cache_dtype}
    out = []
    if dtype == "bfloat16" and cc < BF16_MIN_CC:
        out.append(Finding("dtype-arch", "block",
                           f"bfloat16 weights on {arch} ({ctx.instance_type}, compute {cc}) — bf16 needs Ampere or newer.",
                           fix="set the engine dtype to float16, or use an Ampere-or-newer instance", data=data))
    fp8 = [what for what, val in (("quantization", ctx.quantization), ("kv_cache_dtype", ctx.kv_cache_dtype))
           if str(val or "").lower().startswith("fp8")]
    if fp8 and cc < FP8_MIN_CC:
        sev = "warn" if cc >= BF16_MIN_CC else "block"
        msg = (f"FP8 {', '.join(fp8)} on {arch} (compute {cc}): no native FP8 on this GPU; "
               + ("vLLM falls back to weight-only FP8 (slower, no FP8 KV savings)." if sev == "warn"
                  else "the engine has no FP8 kernels for it."))
        out.append(Finding("dtype-arch", sev, msg, fix="use an Ada / Hopper / Blackwell instance, or drop FP8", data=data))
    if not out:
        out.append(Finding("dtype-arch", "info", f"{dtype or 'model dtype'} supported on {arch}", data=data))
    return out


@register("quant-engine")
def check_quant_engine(ctx: SizingContext) -> list[Finding]:
    """The configured quantization method must be one the engine declares."""
    if not _is_quantized(ctx.quantization):
        return [Finding("quant-engine", "info", "no quantization configured")]
    if ctx.quantization_methods is None:
        return _skip("quant-engine", f"serve.d/{ctx.engine}/manifest.json declares no quantization_methods; "
                                     f"'{ctx.quantization}' not checked", quantization=ctx.quantization)
    if ctx.quantization.lower() not in [m.lower() for m in ctx.quantization_methods]:
        return [Finding("quant-engine", "warn",
                        f"quantization '{ctx.quantization}' is not among {ctx.engine}'s declared methods",
                        fix="use one of: " + ", ".join(ctx.quantization_methods),
                        data={"quantization": ctx.quantization, "methods": ctx.quantization_methods})]
    return [Finding("quant-engine", "info", f"quantization '{ctx.quantization}' is supported by {ctx.engine}")]


@register("arch-engine-version")
def check_arch_engine_version(ctx: SizingContext) -> list[Finding]:
    """The model architecture's minimum engine version (model-arch-support.json)
    vs the engine version of BASE_IMAGE."""
    if not isinstance(ctx.model_config, dict):
        return _skip("arch-engine-version", "model config.json unavailable")
    archs = [a for a in (ctx.model_config.get("architectures") or []) if isinstance(a, str)]
    if not archs:
        return _skip("arch-engine-version", "config.json declares no architectures")
    if not ctx.arch_support:
        return _skip("arch-engine-version", f"model-arch-support.json has no {ctx.engine} table")
    if not ctx.engine_version:
        return _skip("arch-engine-version", "engine version unknown (BASE_IMAGE tag not parseable)")
    known = [(a, ctx.arch_support[a]) for a in archs if a in ctx.arch_support]
    if not known:
        return _skip("arch-engine-version", f"{', '.join(archs)} not listed in model-arch-support.json[{ctx.engine}]",
                     architectures=archs)
    arch, floor = known[0]
    data = {"architecture": arch, "min_version": floor, "engine_version": ctx.engine_version}
    if not serve_manifest._semver_ge(ctx.engine_version, str(floor).lstrip("v")):
        return [Finding("arch-engine-version", "block",
                        f"{arch} needs {ctx.engine} >= {floor}; BASE_IMAGE is {ctx.engine} {ctx.engine_version}.",
                        fix=f"use a {ctx.engine} image >= {floor}", data=data)]
    return [Finding("arch-engine-version", "info", f"{arch} supported by {ctx.engine} {ctx.engine_version} (>= {floor})",
                    data=data)]


@register("vision-weights")
def check_vision_weights(ctx: SizingContext) -> list[Finding]:
    """Multimodal models: the vision / audio tower is part of the weights term."""
    if not isinstance(ctx.model_config, dict):
        return _skip("vision-weights", "model config.json unavailable")
    towers = {k: _tower_params(ctx.model_config[k]) for k in ("vision_config", "audio_config")
              if isinstance(ctx.model_config.get(k), dict)}
    if not towers:
        return [Finding("vision-weights", "info", "text-only model (no vision / audio tower)")]
    how = ("included in the measured staged weights" if ctx.weights_source == "measured"
           else "added to the weights estimate")
    parts = ", ".join(f"{k.split('_')[0]} ~{v / 1e6:.0f}M params" for k, v in towers.items())
    return [Finding("vision-weights", "info", f"multimodal model: {parts}; {how}",
                    data={"towers": towers, "weights_source": ctx.weights_source})]


@register("spec-draft-memory")
def check_spec_draft_memory(ctx: SizingContext) -> list[Finding]:
    """Speculative decoding with a draft model: its weights join context-memory."""
    if not ctx.draft:
        return [Finding("spec-draft-memory", "info", "no draft model configured")]
    if not ctx.draft.get("weights_bytes"):
        return _skip("spec-draft-memory", f"draft model {ctx.draft.get('model')} size unknown "
                                          f"({ctx.draft.get('missing', 'config.json unavailable')}); not counted")
    return [Finding("spec-draft-memory", "info",
                    f"draft model {ctx.draft['model']} ({ctx.draft.get('algorithm')}) adds "
                    f"{_gib(ctx.draft['weights_bytes'])} of weights ({ctx.draft.get('source')}) to context-memory",
                    data={k: v for k, v in ctx.draft.items() if k != "config"})]


@register("context-memory")
def check_context_memory(ctx: SizingContext) -> list[Finding]:
    """weights + KV(max_model_len) (+ LoRA buffer, + draft weights) vs usable GPU
    memory. Two bounds for sliding-window models (OQ-8.8); quantized models and
    uncertain layouts are capped at warn."""
    why = _gpu_inputs_missing(ctx)
    if why:
        return _skip("context-memory", why)
    if not isinstance(ctx.model_config, dict):
        return _skip("context-memory", f"model config.json unavailable ({ctx.missing.get('model_config', 'not fetched')})")
    if not ctx.weights_bytes:
        return _skip("context-memory", f"model weight size unknown ({ctx.missing.get('weights', 'not resolvable')})")
    tokens = ctx.max_model_len
    if not tokens:
        tokens, _ = derived_max_model_len(ctx.model_config)
    if not tokens:
        return _skip("context-memory", "max_model_len not set and config.json declares no context length")
    try:
        terms = memory_terms(ctx, tokens)
    except (KeyError, TypeError, ValueError) as exc:
        return _skip("context-memory", f"config.json lacks the attention dims ({exc})")
    tp = terms["tp"]
    usable = usable_bytes(ctx.gpu_memory_gib, tp, ctx.gpu_memory_utilization)
    blk, warn_from = threshold("BLOCK_OVER"), threshold("WARN_FROM")
    lower, upper = terms["need_lower_bytes"], terms["need_upper_bytes"]
    visible, reserve = threshold("GPU_VISIBLE_MEMORY_FRACTION"), threshold("GPU_RUNTIME_RESERVE_GIB")
    cap = kv_capacity(ctx)
    data = {**terms, "usable_bytes": int(usable), "gpu_memory_gib": ctx.gpu_memory_gib,
            "gpu_visible_memory_fraction": visible, "gpu_runtime_reserve_gib": reserve,
            "kv_capacity_tokens": (cap.get("window_aware_tokens") or cap["full_attention_tokens"]) if cap else 0,
            "gpu_memory_utilization": ctx.gpu_memory_utilization,
            "gpu_memory_utilization_source": ctx.gpu_memory_utilization_source,
            "weights_source": ctx.weights_source, "max_model_len_source": ctx.max_model_len_source or "model default",
            "ratio_lower": round(lower / usable, 3), "ratio_upper": round(upper / usable, 3),
            "block_over": blk, "warn_from": warn_from}
    conservative = []
    if _is_quantized(ctx.quantization):
        conservative.append(f"quantization '{ctx.quantization}'")
    conservative.extend(terms["uncertain"])
    data["conservative"] = conservative
    lora = f" + LoRA {_gib(terms['lora_buffer_bytes'])}" if terms["lora_buffer_bytes"] else ""
    draft = f" + draft {_gib(terms['draft_weights_bytes'])}" if terms["draft_weights_bytes"] else ""
    kv = (f"KV {_gib(terms['kv_lower_bytes'])} window-aware / {_gib(terms['kv_upper_bytes'])} full-attention"
          if terms["sliding"] else f"KV {_gib(terms['kv_upper_bytes'])}")
    head = (f"max_model_len {tokens:,} needs ~{_gib(lower)}"
            + (f" (up to {_gib(upper)})" if terms["sliding"] else "")
            + f" = weights {_gib(terms['weights_bytes'])} ({ctx.weights_source}){lora}{draft} + {kv}; usable "
            f"{_gib(usable)} = {tp} GPU x ({ctx.gpu_memory_gib:g} GiB x {visible:g} visible x "
            f"{ctx.gpu_memory_utilization:g} - {reserve:g} GiB runtime reserve)")
    if lower > usable * blk:
        sev = "block"
    elif upper > usable * blk or lower >= usable * warn_from:
        sev = "warn"
    else:
        sev = "info"
    if sev == "block" and conservative:
        sev = "warn"
        head += f" — estimate is conservative ({'; '.join(conservative)}), capped at warn"
    if sev == "info":
        return [Finding("context-memory", "info", head + " — fits.", data=data)]
    fixes = []
    var = ctx.max_model_len_var or f"the {ctx.engine} max_model_len setting"
    fit_lower = max_fitting_len(ctx, usable * blk, True, tokens)
    fit_upper = max_fitting_len(ctx, usable * blk, False, tokens)
    data.update({"max_fit_len_window_aware": fit_lower, "max_fit_len_full_attention": fit_upper})
    if fit_lower and fit_lower < tokens:
        if terms["sliding"] and fit_upper and fit_upper < fit_lower:
            fixes.append(f"set {var}={fit_lower} or lower (window-aware; {fit_upper} fits even with full "
                         f"attention on every layer)")
        else:
            fixes.append(f"set {var}={fit_lower} or lower")
    elif fit_lower and fit_upper and fit_upper < tokens:
        # Only the full-attention upper bound (or the margin band) is over: the
        # window-aware estimate fits, so this is the conservative option.
        fixes.append(f"to fit even with full attention on every layer, set {var}={fit_upper} or lower")
    elif not fit_lower:
        fixes.append("the weights alone exceed usable memory on this instance")
    # Block: an instance that holds the window-aware estimate; warn: one that also
    # holds the full-attention bound. Only suggest one with more GPU memory.
    inst = smallest_fitting_instance(ctx, tokens, window_aware=(sev == "block"))
    here = float(ctx.gpu_memory_gib) * tp
    if inst and inst[1]["total_gpu_memory_gib"] > here:
        data["smallest_fitting_instance"] = inst[0]
        fixes.append(f"use {inst[0]} ({inst[1]['gpus']} x {inst[1]['gpu_memory_gib']:g} GiB, TP {inst[1]['gpus']}) "
                     f"for {tokens:,} tokens")
    return [Finding("context-memory", sev, head + (" — over usable memory." if sev == "block" else " — near or over the limit."),
                    fix="; ".join(fixes), data=data)]


@register("concurrency-kv")
def check_concurrency_kv(ctx: SizingContext) -> list[Finding]:
    """KV capacity left after weights, in tokens, vs max_num_seqs x a typical
    context (throughput signal, never a failure)."""
    why = _gpu_inputs_missing(ctx)
    if why or not isinstance(ctx.model_config, dict) or not ctx.weights_bytes:
        return _skip("concurrency-kv", why or "model config.json / weight size unavailable")
    try:
        cap = kv_capacity(ctx)
    except (KeyError, TypeError, ValueError) as exc:
        return _skip("concurrency-kv", f"config.json lacks the attention dims ({exc})")
    if not cap:
        return _skip("concurrency-kv", "no KV memory left after weights (see context-memory)")
    capacity = cap["full_attention_tokens"]
    data = {"kv_capacity_tokens_full_attention": capacity, "kv_free_bytes": int(cap["free_bytes"])}
    msg = f"KV capacity ~{capacity:,} tokens (full-attention estimate)"
    if cap.get("window_aware_tokens"):
        # Hybrid allocator: the figure vLLM's "GPU KV cache size: N tokens" line
        # reports (max concurrency at max_model_len x max_model_len).
        hybrid = cap["window_aware_tokens"]
        data["kv_capacity_tokens_window_aware"] = hybrid
        msg = f"KV capacity ~{hybrid:,} tokens window-aware (~{capacity:,} full-attention)"
    ctx_len = ctx.typical_context or ctx.max_model_len
    if ctx_len:
        data["concurrent_at_context"] = round(capacity / ctx_len, 2)
        msg += f" ≈ {capacity / ctx_len:.1f} concurrent requests of {ctx_len:,} tokens ({ctx.typical_context_source or 'max_model_len'})"
    if ctx.max_num_seqs and ctx_len and ctx.max_num_seqs * ctx_len > capacity:
        msg += f"; {ctx.max_num_seqs_var}={ctx.max_num_seqs} sequences of that size would queue (throughput, not failure)"
    elif not ctx.max_num_seqs:
        msg += f"; max_num_seqs not set ({ctx.engine} picks it by release / GPU), so queueing not assessed"
    return [Finding("concurrency-kv", "info", msg, data=data)]


@register("ic-packing")
def check_ic_packing(ctx: SizingContext) -> list[Finding]:
    """Realtime inference components: each copy needs IC_GPU_COUNT GPUs on ONE
    instance; all copies must fit the endpoint's instances."""
    if not ctx.uses_inference_components:
        return _skip("ic-packing", "target does not place inference components")
    why = _gpu_inputs_missing(ctx)
    if why:
        return _skip("ic-packing", why)
    if not ctx.ic_confs:
        return _skip("ic-packing", "no do/ic/*.conf found")
    inst_gpus = _int(ctx.instance.get("gpus")) or 0
    total, out, rows = 0, [], []
    for conf in ctx.ic_confs:
        g = _int(conf.get("IC_GPU_COUNT")) or 1
        c = _int(conf.get("IC_COPY_COUNT")) or 1
        rows.append({"ic": conf.get("_name"), "gpus": g, "copies": c})
        total += g * c
        if g > inst_gpus:
            out.append(Finding("ic-packing", "block",
                               f"IC '{conf.get('_name')}' asks for {g} GPUs per copy; {ctx.instance_type} has {inst_gpus}.",
                               fix=f"set IC_GPU_COUNT <= {inst_gpus} in do/ic/{conf.get('_name')}.conf or use a larger instance",
                               data={"ic": conf.get("_name"), "gpus": g, "instance_gpus": inst_gpus}))
    capacity = inst_gpus * max(ctx.instance_count, 1)
    data = {"ics": rows, "gpus_requested": total, "gpus_available": capacity, "instance_count": ctx.instance_count}
    if total > capacity:
        out.append(Finding("ic-packing", "block",
                           f"inference components need {total} GPUs (copies x IC_GPU_COUNT) but the endpoint has "
                           f"{capacity} ({ctx.instance_count} x {ctx.instance_type}).",
                           fix="lower IC_COPY_COUNT / IC_GPU_COUNT, or raise ENDPOINT_INITIAL_INSTANCE_COUNT", data=data))
    if not out:
        out.append(Finding("ic-packing", "info", f"inference components use {total} of {capacity} GPUs", data=data))
    return out


@register("disk-model-size")
def check_disk_model_size(ctx: SizingContext) -> list[Finding]:
    """Weights vs the configured model volume. Instance local disk is not
    catalogued, and the eks emptyDir node capacity is checked live by the BL155
    preflight in deploy.d/eks, so those cases skip."""
    if not ctx.weights_bytes:
        return _skip("disk-model-size", "model weight size unknown")
    if not ctx.volume_gb:
        return _skip("disk-model-size", "no model volume size configured (instance local disk is not catalogued; "
                                        "eks node capacity is checked live by deploy.d/eks)")
    vol = ctx.volume_gb * 1e9 if ctx.volume_source.startswith("ENDPOINT") else ctx.volume_gb * GIB
    data = {"weights_bytes": ctx.weights_bytes, "weights_source": ctx.weights_source,
            "volume_bytes": int(vol), "volume_source": ctx.volume_source}
    if ctx.weights_bytes > vol:
        return [Finding("disk-model-size", "block",
                        f"model weights ({_gib(ctx.weights_bytes)}) exceed {ctx.volume_source}={ctx.volume_gb:g}",
                        fix=f"raise {ctx.volume_source} above {ctx.weights_bytes / GIB * 1.2:.0f}", data=data)]
    return [Finding("disk-model-size", "info", f"weights {_gib(ctx.weights_bytes)} fit {ctx.volume_source}={ctx.volume_gb:g}",
                    data=data)]


@register("quota")
def check_quota(ctx: SizingContext) -> list[Finding]:
    """A SageMaker Service Quota for the instance type and usage kind."""
    if not ctx.quota_usage:
        return _skip("quota", "target capacity is cluster-provided (no SageMaker instance quota)")
    if not ctx.network:
        return _skip("quota", "network check not run (the do/deploy preflight and do/validate --offline skip it; "
                              "SageMaker refuses a no-quota create immediately)")
    if not ctx.instance_type:
        return _skip("quota", "no instance type configured")
    if not ctx.quota:
        return _skip("quota", f"could not read the '{ctx.instance_type} for {ctx.quota_usage}' quota "
                              f"({ctx.missing.get('quota', 'lookup failed')})")
    value = ctx.quota.get("value")
    data = {**ctx.quota, "needed": max(ctx.instance_count, 1)}
    if value is not None and value < max(ctx.instance_count, 1):
        return [Finding("quota", "warn",
                        f"Service Quota '{ctx.quota.get('name')}' is {value:g}; this deploy needs {max(ctx.instance_count, 1)}.",
                        fix="request an increase in the Service Quotas console (SageMaker)", data=data)]
    return [Finding("quota", "info", f"Service Quota '{ctx.quota.get('name')}' = {value:g}", data=data)]


# ── Environment / fetch layer (the only I/O) ──────────────────────────────────


def _aws_region_args(env: dict) -> list[str]:
    region = env.get("AWS_REGION") or ""
    return ["--region", region] if region else []


def fetch_bytes(uri: str, env: dict | None = None) -> bytes | None:
    """Read an S3 object (aws s3 cp <uri> -) or a local file. None on failure."""
    env = env if env is not None else dict(os.environ)
    if not uri:
        return None
    if not uri.startswith("s3://"):
        try:
            with open(uri, "rb") as f:
                return f.read()
        except OSError:
            return None
    try:
        proc = subprocess.run(["aws", "s3", "cp", uri, "-", *_aws_region_args(env)],
                              capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout if proc.returncode == 0 and proc.stdout else None


def read_adapter_config(uri: str, env: dict | None = None,
                        fetch: Callable[[str, dict | None], bytes | None] = fetch_bytes) -> dict | None:
    """adapter_config.json for an adapter at an S3 prefix / local dir / the json
    itself / a .tar.gz (SMAI adapters). None when unreadable."""
    if not uri:
        return None
    if uri.endswith(".tar.gz") or uri.endswith(".tgz"):
        blob = fetch(uri, env)
        if not blob:
            return None
        try:
            with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
                for member in tf.getmembers():
                    if os.path.basename(member.name) == "adapter_config.json":
                        fh = tf.extractfile(member)
                        return json.loads(fh.read()) if fh else None
        except (tarfile.TarError, ValueError, OSError):
            return None
        return None
    target = uri if uri.endswith(".json") else uri.rstrip("/") + "/adapter_config.json"
    blob = fetch(target, env)
    if not blob:
        return None
    try:
        data = json.loads(blob)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def fetch_weights_bytes(model_uri: str, env: dict | None = None) -> int | None:
    """Total *.safetensors bytes directly under the model prefix (S3 or local)."""
    env = env if env is not None else dict(os.environ)
    if not model_uri:
        return None
    if not model_uri.startswith("s3://"):
        try:
            return sum(os.path.getsize(os.path.join(model_uri, n)) for n in os.listdir(model_uri)
                       if n.endswith(".safetensors")) or None
        except OSError:
            return None
    no_scheme = model_uri[len("s3://"):]
    bucket, _, prefix = no_scheme.partition("/")
    prefix = prefix.rstrip("/") + "/" if prefix else ""
    try:
        proc = subprocess.run(
            ["aws", "s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix,
             "--delimiter", "/", "--output", "json", *_aws_region_args(env)],
            capture_output=True, timeout=60, check=False, text=True)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    try:
        contents = json.loads(proc.stdout or "{}").get("Contents") or []
    except ValueError:
        return None
    total = sum(int(o.get("Size", 0)) for o in contents if str(o.get("Key", "")).endswith(".safetensors"))
    return total or None


def _instance_catalog_candidates() -> list[str]:
    project_root = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
    repo_root = os.path.abspath(os.path.join(project_root, ".."))
    return [
        os.path.join(project_root, ".mlcc", "instances.json"),
        os.path.join(repo_root, "servers", "lib", "catalogs", "instances.json"),
        os.path.join(os.getcwd(), "servers", "lib", "catalogs", "instances.json"),
    ]


def gpu_memory_gib_for(instance_type: str, catalog_paths: list[str] | None = None) -> float | None:
    """Per-GPU memory from the instance catalog (gpuMemoryGb), or None."""
    if not instance_type:
        return None
    for path in catalog_paths or _instance_catalog_candidates():
        try:
            with open(path, encoding="utf-8") as f:
                cat = json.load(f)
        except (OSError, ValueError):
            continue
        entry = (cat.get("catalog") or cat).get(instance_type) if isinstance(cat, dict) else None
        if isinstance(entry, dict) and entry.get("gpuMemoryGb"):
            return float(entry["gpuMemoryGb"])
    return None


def _int_or_none(val) -> int | None:
    try:
        return int(str(val).strip())
    except (TypeError, ValueError):
        return None


def _float_or(val, default: float) -> float:
    try:
        return float(str(val).strip())
    except (TypeError, ValueError):
        return default


def recorded_adapter_ranks(env: dict, fetch: Callable = fetch_bytes) -> list[AdapterRank]:
    """Ranks of every recorded tune adapter (TUNE_ADAPTER_PATH_<TECH>[_<SLUG>]),
    read from each adapter_config.json (r + rank_pattern). De-duplicated by URI;
    an unreadable config is skipped (the TUNE_LORA_RANK_* record still counts)."""
    seen: dict[str, AdapterRank] = {}
    for key in sorted(env):
        if not key.startswith("TUNE_ADAPTER_PATH_"):
            continue
        uri = (env.get(key) or "").strip()
        if not uri or uri in seen:
            continue
        rank = adapter_config_rank(read_adapter_config(uri, env, fetch))
        if rank:
            seen[uri] = AdapterRank(name=key[len("TUNE_ADAPTER_PATH_"):].lower(), rank=rank, source=key)
    return list(seen.values())


def recorded_tune_ranks(env: dict) -> list[AdapterRank]:
    """TUNE_LORA_RANK_<TECH> values recorded by do/tune at submit (R2.2)."""
    out = []
    for key in sorted(env):
        if key.startswith("TUNE_LORA_RANK_"):
            r = _int_or_none(env.get(key))
            if r and r > 0:
                out.append(AdapterRank(name=key[len("TUNE_LORA_RANK_"):].lower(), rank=r, source=key))
    return out


def fetch_url(url: str, headers: dict | None = None, timeout: float = FETCH_TIMEOUT_S) -> bytes | None:
    """GET a URL (stdlib urllib). None on any failure — callers skip, never guess."""
    import urllib.error
    import urllib.request
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (https HF only)
            return resp.read()
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _project_root() -> str:
    return os.path.abspath(os.path.join(_HERE, "..", "..", ".."))


def _cache_path(name: str) -> str:
    return os.path.join(_project_root(), ".mlcc", "sizing-cache", name)


def _hf_model_id(env: dict) -> str:
    for key in ("HF_MODEL_ID", "MODEL_NAME"):
        val = (env.get(key) or "").strip()
        if val and "://" not in val and not val.startswith("/") and val.count("/") == 1:
            return val
    return ""


def fetch_hf_config(model_id: str, env: dict, fetch_http: Callable = fetch_url) -> tuple[dict | None, str]:
    """config.json from Hugging Face (HF_TOKEN when set), cached under
    .mlcc/sizing-cache/. Returns (config, reason-if-missing)."""
    if not model_id:
        return None, "no staged model and no Hugging Face model id"
    cache = _cache_path("hf-" + model_id.replace("/", "--") + "-config.json")
    try:
        with open(cache, encoding="utf-8") as f:
            return json.load(f), ""
    except (OSError, ValueError):
        pass
    token = env.get("HF_TOKEN") or env.get("RESOLVED_HF_TOKEN") or ""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    blob = fetch_http(f"https://huggingface.co/{model_id}/resolve/main/config.json", headers,
                      threshold("FETCH_TIMEOUT_S", env))
    try:
        cfg = json.loads(blob) if blob else None
    except ValueError:
        cfg = None
    if not isinstance(cfg, dict):
        return None, f"could not fetch {model_id} config.json from Hugging Face (offline, gated, or not found)"
    try:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    except OSError:
        pass
    return cfg, ""


def _load_first_json(paths: list[str]):
    for path in paths:
        data = _load_json_file(path)
        if data is not None:
            return data
    return None


def load_instance_catalog(paths: list[str] | None = None) -> dict:
    cat = _load_first_json(paths or _instance_catalog_candidates())
    if not isinstance(cat, dict):
        return {}
    inner = cat.get("catalog") if isinstance(cat.get("catalog"), dict) else cat
    return {k: v for k, v in inner.items() if isinstance(v, dict)}


def load_arch_support(engine: str, paths: list[str] | None = None) -> dict | None:
    root = _project_root()
    data = _load_first_json(paths or [
        os.path.join(root, ".mlcc", "model-arch-support.json"),
        os.path.join(root, "..", "servers", "lib", "catalogs", "model-arch-support.json"),
        os.path.join(os.getcwd(), "servers", "lib", "catalogs", "model-arch-support.json"),
    ])
    table = data.get(engine) if isinstance(data, dict) else None
    return dict(table) if isinstance(table, dict) else None


_EXPORT_RE = None


def read_conf_exports(path: str) -> dict:
    """`export K=V` assignments from a do/ic/*.conf (literal values only)."""
    import re
    global _EXPORT_RE
    _EXPORT_RE = _EXPORT_RE or re.compile(r'^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = _EXPORT_RE.match(line)
                if m:
                    val = m.group(2).split(" #", 1)[0].strip().strip('"').strip("'")
                    out[m.group(1)] = val
    except OSError:
        return {}
    return out


def ic_confs(do_dir: str | None = None) -> list[dict]:
    do_dir = do_dir or os.path.abspath(os.path.join(_HERE, "..", ".."))
    ic_dir = os.path.join(do_dir, "ic")
    try:
        names = sorted(n for n in os.listdir(ic_dir) if n.endswith(".conf"))
    except OSError:
        return []
    return [{**read_conf_exports(os.path.join(ic_dir, n)), "_name": n[:-len(".conf")]} for n in names]


def lookup_quota(instance_type: str, usage: str, env: dict, run: Callable | None = None) -> tuple[dict | None, str]:
    """The SageMaker Service Quota '<instance> for <usage>' (read-only list call)."""
    name = f"{instance_type} for {usage}"
    cmd = ["aws", "service-quotas", "list-service-quotas", "--service-code", "sagemaker",
           "--query", f"Quotas[?QuotaName=='{name}'].[QuotaName,Value,QuotaCode]", "--output", "json",
           *_aws_region_args(env)]
    try:
        if run is not None:
            rc, out = run(cmd)
        else:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
            rc, out = proc.returncode, proc.stdout
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"aws CLI unavailable ({exc.__class__.__name__})"
    if rc != 0:
        return None, "service-quotas call failed (credentials / permissions / offline)"
    try:
        rows = json.loads(out or "[]")
    except ValueError:
        return None, "unparseable service-quotas output"
    if not rows:
        return None, f"no quota named '{name}' in this region"
    return {"name": rows[0][0], "value": float(rows[0][1]), "code": rows[0][2]}, ""


def _first_set(env: dict, names: list[str]) -> tuple[str, str]:
    for n in names:
        val = (env.get(n) or "").strip()
        if val:
            return val, n
    return "", ""


def _engine_var_names(prefix: str, suffix: str, source: str) -> list[str]:
    """The env var(s) a target reads an engine setting from, in precedence order:
    sagemaker-ic targets pass IC_ENV_<var> to the container (bare <var> is the
    image's baked default); kubernetes targets pass <var> to the pod."""
    if not prefix or not suffix:
        return []
    bare = f"{prefix}{suffix}"
    return [IC_ENV_PREFIX + bare, bare] if source == SAGEMAKER_IC_SOURCE else [bare]


def _describe_target(target: str) -> dict:
    if not target:
        return {}
    try:
        return target_manifest.read_manifest(target)
    except target_manifest.ManifestError:
        return {}


def _draft_info(env: dict, fetch: Callable, fetch_http: Callable, dtype_setting: str) -> dict | None:
    algo = (env.get("HP_SPECULATIVE_ALGORITHM") or "").strip()
    model = (env.get("HP_SPECULATIVE_MODEL") or "").strip()
    if not algo or not model:
        return None
    info = {"algorithm": algo, "model": model}
    if os.path.isdir(model):
        blob = fetch(os.path.join(model, "config.json"), env)
        try:
            cfg = json.loads(blob) if blob else None
        except ValueError:
            cfg = None
        measured = fetch_weights_bytes(model, env)
        if measured:
            info.update({"weights_bytes": measured, "source": "measured"})
            return info
        why = "local draft has no config.json"
    else:
        cfg, why = fetch_hf_config(model, env, fetch_http)
    if not isinstance(cfg, dict):
        info["missing"] = why
        return info
    est, breakdown = estimate_weights_bytes(cfg, _weights_dtype_name(cfg, dtype_setting))
    if est:
        info.update({"weights_bytes": est, "source": "estimate", "params": breakdown.get("params")})
    else:
        info["missing"] = "draft config.json lacks the dims"
    return info


def context_from_env(env: dict | None = None, *, rank_only: bool = False,
                     fetch: Callable = fetch_bytes,
                     fetch_weights: Callable = fetch_weights_bytes,
                     fetch_http: Callable = fetch_url,
                     network: bool = False,
                     run: Callable | None = None) -> SizingContext:
    """Build a SizingContext from do/config-style environment variables (built
    ONCE; checks never fetch). Missing inputs are recorded in ctx.missing."""
    env = dict(os.environ) if env is None else env
    engine = env.get("MODEL_SERVER") or "vllm"
    try:
        caps = serve_manifest.capability_map(engine)
        defaults = serve_manifest.capability_defaults(engine)
        allowed = serve_manifest.lora_rank_allowed(engine)
        prefix = serve_manifest.env_var_prefix(engine)
        dims = serve_manifest.dimension_map(engine)
        sizing = serve_manifest.sizing_map(engine)
        quant_methods = serve_manifest.quantization_methods(engine)
    except serve_manifest.ManifestError:
        caps, defaults, allowed, prefix, dims, sizing, quant_methods = {}, {}, [], "", {}, {}, None
    target = env.get("DEPLOYMENT_TARGET", "")
    try:
        target = target_manifest.resolve_target(target) if target else ""
    except target_manifest.ManifestError:
        pass
    desc = _describe_target(target)
    source = desc.get("serving_config_source", "")

    def setting(name: str, mapping: dict) -> tuple[str, str, list[str]]:
        entry = mapping.get(name)
        suffix = entry.get("suffix", "") if isinstance(entry, dict) else (entry or "")
        names = _engine_var_names(prefix, suffix, source)
        val, var = _first_set(env, names)
        return val, var, names

    rank_var = (caps.get("lora_max_rank") or {}).get("envVar", "")
    max_var = (caps.get("lora_max") or {}).get("envVar", "")
    explicit = _int_or_none(env.get(rank_var)) if rank_var else None
    max_loras = (_int_or_none(env.get(max_var)) if max_var else None) or _int_or_none(defaults.get("lora_max"))

    # The instance and the GPUs the model is placed on (targets.d decides which vars).
    if source == "kubernetes" or not source:
        instance_type = env.get("HP_INSTANCE_TYPE") or env.get("INSTANCE_TYPE") or ""
    else:
        instance_type = env.get("INSTANCE_TYPE") or ""
    catalog = {} if rank_only else load_instance_catalog()
    instance = catalog.get(instance_type) if instance_type else None
    inst_gpus = _int((instance or {}).get("gpus"))
    uses_ics = bool((desc.get("verbs") or {}).get("add-ic"))
    if source == "kubernetes" or not source:
        serving_gpus = _int_or_none(env.get("HP_GPU_COUNT")) or inst_gpus
    elif uses_ics:
        serving_gpus = _int_or_none(env.get("IC_GPU_COUNT")) or 1
    else:
        serving_gpus = inst_gpus

    tp_val, tp_var, tp_names = setting("tensor_parallel_degree", dims)
    tp, tp_source = _int_or_none(tp_val), tp_var
    if not tp and (source == "kubernetes" or not source) and _int_or_none(env.get("HP_GPU_COUNT")):
        tp, tp_source = _int_or_none(env.get("HP_GPU_COUNT")), "HP_GPU_COUNT (k8s driver default)"
    if not tp and source == "kubernetes" and serving_gpus:
        tp, tp_source = serving_gpus, "instance GPU count (k8s driver default)"
    if not tp and _int((sizing.get("tensor_parallel_degree") or {}).get("default")):
        tp, tp_source = _int(sizing["tensor_parallel_degree"]["default"]), f"{engine} default"
    if not tp:
        tp, tp_source = (serving_gpus or 1), "serving GPU count (engine declares no TP default)"

    util_val, util_var, _ = setting("gpu_memory_utilization", sizing)
    util_default = (sizing.get("gpu_memory_utilization") or {}).get("default")
    if util_val and _float_or(util_val, -1.0) > 0:
        util, util_src = _float_or(util_val, 0.0), util_var
    elif isinstance(util_default, (int, float)):
        util, util_src = float(util_default), f"serve.d/{engine} sizing_map default"
    else:
        util, util_src = threshold("DEFAULT_GPU_MEMORY_UTILIZATION", env), "module default"

    lora_switch = LORA_SWITCH_VAR.get(source)
    lora_enabled = ((env.get(lora_switch) or "").strip().lower() == "true") if lora_switch else None

    ctx = SizingContext(
        engine=engine,
        rank_env_var=rank_var,
        rank_default=_int_or_none(defaults.get("lora_max_rank")),
        rank_allowed=allowed,
        explicit_rank=explicit,
        tune_ranks=recorded_tune_ranks(env),
        target=target or env.get("DEPLOYMENT_TARGET", ""),
        max_loras=max_loras,
        tp=tp,
        tp_source=tp_source,
        gpu_memory_utilization=util,
        gpu_memory_utilization_source=util_src,
        budget_fraction=threshold("LORA_BUFFER_BUDGET_FRACTION", env),
        family=desc.get("family", ""),
        serving_config_source=source,
        uses_inference_components=uses_ics,
        quota_usage=desc.get("service_quota_usage", ""),
        instance_type=instance_type,
        instance=instance,
        catalog=catalog,
        serving_gpus=serving_gpus,
        lora_enabled=lora_enabled,
        quantization_methods=quant_methods,
        network=network,
    )
    ctx.adapters = recorded_adapter_ranks(env, fetch)
    if rank_only:
        return ctx

    # Engine settings (dimension_map / sizing_map, IC_ENV_ form on sagemaker-ic).
    mml, mml_var, mml_names = setting("max_model_len", dims)
    ctx.max_model_len = _int_or_none(mml)
    ctx.max_model_len_source = mml_var if ctx.max_model_len else "model default"
    ctx.max_model_len_var = mml_names[0] if mml_names else ""
    kv, _, _ = setting("kv_cache_dtype", dims)
    ctx.kv_cache_dtype = kv or "auto"
    q, _, _ = setting("quantization", dims)
    ctx.quantization = "" if not _is_quantized(q) else q
    dt, _, _ = setting("dtype", sizing)
    ctx.dtype = dt or str((sizing.get("dtype") or {}).get("default") or "auto")
    seqs, seqs_var, seqs_names = setting("max_num_seqs", sizing)
    ctx.max_num_seqs = _int_or_none(seqs)
    ctx.max_num_seqs_var = seqs_var or (seqs_names[0] if seqs_names else "max_num_seqs")
    batched, _, _ = setting("max_num_batched_tokens", sizing)
    ctx.max_num_batched_tokens = _int_or_none(batched)
    ctx.batched_tokens_spec = dict(sizing.get("max_num_batched_tokens") or {})
    tin, tout = _int_or_none(env.get("BENCHMARK_INPUT_TOKENS_MEAN")), _int_or_none(env.get("BENCHMARK_OUTPUT_TOKENS_MEAN"))
    if tin and tout:
        ctx.typical_context, ctx.typical_context_source = tin + tout, "benchmark profile mean input + output"

    # Model config.json + weights (OQ-8.9: measured staged bytes, else estimate).
    model_uri = (env.get("STAGED_MODEL_PATH") or "").strip()
    ctx.model_id = _hf_model_id(env) or model_uri
    if model_uri:
        blob = fetch(model_uri.rstrip("/") + "/config.json", env)
        try:
            ctx.model_config = json.loads(blob) if blob else None
        except ValueError:
            ctx.model_config = None
        if not isinstance(ctx.model_config, dict):
            ctx.model_config = None
            ctx.missing["model_config"] = f"could not read {model_uri.rstrip('/')}/config.json"
        ctx.weights_bytes = fetch_weights(model_uri, env)
        if ctx.weights_bytes:
            ctx.weights_source = "measured"
    if ctx.model_config is None:
        cfg, why = fetch_hf_config(_hf_model_id(env), env, fetch_http)
        if cfg:
            ctx.model_config = cfg
            ctx.missing.pop("model_config", None)
        else:
            ctx.missing.setdefault("model_config", why)
    if ctx.model_config:
        ctx.dtype_bytes = model_dtype_bytes(ctx.model_config)
        qc = ctx.model_config.get("quantization_config") or _text_config(ctx.model_config).get("quantization_config")
        if not ctx.quantization and isinstance(qc, dict) and qc.get("quant_method"):
            ctx.quantization = str(qc["quant_method"])
        if not ctx.weights_bytes:
            est, _ = estimate_weights_bytes(ctx.model_config, _weights_dtype_name(ctx.model_config, ctx.dtype))
            if est:
                ctx.weights_bytes, ctx.weights_source = est, "estimate"
    if not ctx.weights_bytes:
        ctx.missing["weights"] = "no staged *.safetensors and no config.json dims to estimate from"
    ctx.gpu_memory_gib = float(instance["gpuMemoryGb"]) if instance and instance.get("gpuMemoryGb") else None

    # Engine version + architecture floor, speculative draft, ICs, volume, quota.
    try:
        ctx.engine_version = serve_manifest.engine_version_from_base_image(engine, env.get("BASE_IMAGE") or "")
    except (OSError, ValueError):
        ctx.engine_version = None
    ctx.arch_support = load_arch_support(engine)
    ctx.draft = _draft_info(env, fetch, fetch_http, ctx.dtype)
    if uses_ics:
        ctx.ic_confs = ic_confs()
    ctx.instance_count = _int_or_none(env.get("ENDPOINT_INITIAL_INSTANCE_COUNT")) or 1
    if source == SAGEMAKER_IC_SOURCE and _float_or(env.get("ENDPOINT_VOLUME_SIZE"), 0.0) > 0:
        ctx.volume_gb, ctx.volume_source = _float_or(env.get("ENDPOINT_VOLUME_SIZE"), 0.0), "ENDPOINT_VOLUME_SIZE"
    elif source == "kubernetes" and not env.get("HP_MODEL_HOSTPATH") and not env.get("EKS_MODEL_MOUNT"):
        eph = str(env.get("HP_EPHEMERAL_STORAGE") or "").strip()
        if eph.endswith("Gi") and _float_or(eph[:-2], 0.0) > 0:
            ctx.volume_gb, ctx.volume_source = _float_or(eph[:-2], 0.0), "HP_EPHEMERAL_STORAGE"
    if network and ctx.quota_usage and instance_type:
        ctx.quota, why = lookup_quota(instance_type, ctx.quota_usage, env, run)
        if why:
            ctx.missing["quota"] = why
    return ctx


def live_rank_limit(engine: str, pods: dict | None = None, iec: dict | None = None,
                    env_map: dict | None = None) -> tuple[int | None, str]:
    """The RUNNING deployment's max_lora_rank (R3.2 pre-check), from — in order —
    the serving pods' container env, the InferenceEndpointConfig worker env, or a
    SageMaker IC's container Environment map; else the engine manifest default
    (what the engine runs with when nothing overrides it). Returns (limit, source)."""
    try:
        var = (serve_manifest.capability_map(engine).get("lora_max_rank") or {}).get("envVar", "")
        default = serve_manifest.lora_rank_default(engine)
    except serve_manifest.ManifestError:
        var, default = "", None
    if var:
        for pod in (pods or {}).get("items") or []:
            for c in (pod.get("spec") or {}).get("containers") or []:
                for e in c.get("env") or []:
                    if e.get("name") == var and _int_or_none(e.get("value")):
                        return _int_or_none(e.get("value")), "pod env"
        for e in (((iec or {}).get("spec") or {}).get("worker") or {}).get("environmentVariables") or []:
            if e.get("name") == var and _int_or_none(e.get("value")):
                return _int_or_none(e.get("value")), "InferenceEndpointConfig env"
        if isinstance(env_map, dict) and _int_or_none(env_map.get(var)):
            return _int_or_none(env_map.get(var)), "inference component env"
    return default, "engine default (no override in the deployment)"


def _load_json_file(path: str):
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def check_all(ctx: SizingContext, names: list[str] | None = None) -> list[Finding]:
    """Every registered check (or `names`), plus the effective-rank derivation's
    own lora-rank-fit findings (rank above the engine's allowed set, an explicit
    rank the engine rejects or that recorded adapters exceed) — so the do/deploy
    preflight reports everything once and the k8s drivers stay quiet (Wave 8)."""
    extra: list[Finding] = []
    if ctx.lora_enabled is not False:
        eff = effective_lora_rank(ctx)
        ctx.serving_rank_limit = eff["rank"]
        ctx.rank_auto_raised = eff["auto_raised"]
        if names is None or "lora-rank-fit" in names:
            extra = [Finding(**f) for f in eff["findings"] if f["check"] == "lora-rank-fit"]
    findings = run_checks(ctx, names)
    seen = {(f.check, f.message) for f in findings}
    return findings + [f for f in extra if (f.check, f.message) not in seen]


# ── CLI ────────────────────────────────────────────────────────────────────────


def _print_findings(findings: list[dict], stream) -> None:
    icon = {"info": "ℹ️ ", "warn": "⚠️ ", "block": "❌", "skip": "⏭️ "}
    for f in findings:
        print(f"   {icon.get(f['severity'], '')} [{f['check']}] {f['message']}", file=stream)
        if f.get("fix"):
            print(f"      Fix: {f['fix']}", file=stream)


def _cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="right_sizing.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_check = sub.add_parser("check")
    p_check.add_argument("--checks", default="")
    p_check.add_argument("--json", action="store_true")
    p_check.add_argument("--network", action="store_true",
                         help="also run network-only checks (quota); do/validate passes it")
    p_eff = sub.add_parser("effective-lora-rank")
    p_eff.add_argument("--rank-only", action="store_true",
                       help="skip the memory inputs (no model config/weights reads)")
    p_eff.add_argument("--json", action="store_true")
    p_eff.add_argument("--quiet", action="store_true",
                       help="do not print findings (the do/deploy preflight already printed them)")
    p_eff.add_argument("--exclude-technique", default="",
                       help="ignore TUNE_LORA_RANK_<T> / TUNE_ADAPTER_PATH_<T>* (the limit BEFORE this tune)")
    p_ar = sub.add_parser("adapter-rank")
    p_ar.add_argument("uri")
    p_live = sub.add_parser("live-limit")
    p_live.add_argument("--pods-json", default="")
    p_live.add_argument("--iec-json", default="")
    p_live.add_argument("--env-json", default="")
    p_fit = sub.add_parser("rank-fit")
    p_fit.add_argument("--name", required=True)
    p_fit.add_argument("--rank", type=int, required=True)
    p_fit.add_argument("--limit", type=int, required=True)
    p_fit.add_argument("--limit-kind", default="live", choices=["live", "effective"])
    p_fit.add_argument("--target", default="")
    args = parser.parse_args(argv)

    if args.cmd == "adapter-rank":
        rank = adapter_config_rank(read_adapter_config(args.uri))
        print("" if rank is None else rank)
        return 0

    if args.cmd == "live-limit":
        limit, source = live_rank_limit(os.environ.get("MODEL_SERVER") or "vllm",
                                        _load_json_file(args.pods_json), _load_json_file(args.iec_json),
                                        _load_json_file(args.env_json))
        print(json.dumps({"limit": limit, "source": source}))
        return 0

    if args.cmd == "rank-fit":
        ctx = context_from_env(rank_only=True, fetch=lambda _u, _e=None: None)
        ctx.lora_enabled = None  # an explicit adapter pre-check: the LoRA switch does not apply
        ctx.adapters = [AdapterRank(args.name, args.rank, "adapter_config.json")]
        ctx.serving_rank_limit = args.limit
        ctx.limit_kind = args.limit_kind
        ctx.target = args.target or ctx.target
        findings = [f.to_dict() for f in check_lora_rank_fit(ctx)]
        _print_findings([f for f in findings if f["severity"] != "info"], sys.stdout)
        return exit_code([Finding(**f) for f in findings])

    if args.cmd == "effective-lora-rank":
        env = dict(os.environ)
        if args.exclude_technique:
            tech = args.exclude_technique.upper()
            env = {k: v for k, v in env.items()
                   if k != f"TUNE_LORA_RANK_{tech}" and k != f"TUNE_ADAPTER_PATH_{tech}"
                   and not k.startswith(f"TUNE_ADAPTER_PATH_{tech}_")}
        ctx = context_from_env(env, rank_only=args.rank_only)
        ctx.lora_enabled = None  # callers invoke this only when LoRA is on for the target
        result = effective_lora_rank(ctx)
        if not args.quiet:
            _print_findings([f for f in result["findings"] if f["severity"] not in ("info", "skip")
                             or os.environ.get("MLCC_SIZING_VERBOSE")], sys.stderr)
        print(json.dumps(result))
        return exit_code([Finding(**f) for f in result["findings"]])

    # check
    ctx = context_from_env(network=args.network)
    names = [n.strip() for n in args.checks.split(",") if n.strip()] or None
    findings = check_all(ctx, names)
    if args.json:
        print(json.dumps([f.to_dict() for f in findings]))
    else:
        _print_findings([f.to_dict() for f in findings], sys.stdout)
    return exit_code(findings)


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
