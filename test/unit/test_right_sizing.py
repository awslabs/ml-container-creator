# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 6.1 (R3.1 / R2.3 / R2.4 / R8.2) — templates/do/lib/python/right_sizing.py.

The memory-formula tests reproduce the W6 follow-up investigation's worked
numbers for fresh-ai-ml (google/gemma-4-E4B-it, ml.g7.12xlarge, max_loras 4):
TP=2 per GPU r16 0.18 / r32 0.36 / r64 0.73 / r128 1.45 GiB; TP=1 0.27 / 0.55 /
1.09 / 2.19 GiB. The fixture is the model's real staged config.json.
"""
import io
import json
import os
import subprocess
import sys
import tarfile

import pytest

_PY = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python"))
if _PY not in sys.path:
    sys.path.insert(0, _PY)

import right_sizing as rs  # noqa: E402
import serve_manifest  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "fixtures", "right-sizing", "gemma-4-e4b-it-config.json")
with open(FIXTURE, encoding="utf-8") as _f:
    GEMMA = json.load(_f)
GIB = float(1 << 30)


def gib(nbytes):
    return round(nbytes / GIB, 2)


# ── Memory formula vs the investigation's worked numbers ──────────────────────

@pytest.mark.parametrize("rank,expected", [(16, 0.18), (32, 0.36), (64, 0.73), (128, 1.45)])
def test_buffer_tp2_matches_investigation(rank, expected):
    assert gib(rs.lora_buffer_bytes_per_gpu(GEMMA, rank, 4, 2)) == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize("rank,expected", [(16, 0.27), (32, 0.55), (64, 1.09), (128, 2.19)])
def test_buffer_tp1_matches_investigation(rank, expected):
    assert gib(rs.lora_buffer_bytes_per_gpu(GEMMA, rank, 4, 1)) == pytest.approx(expected, abs=0.01)


def test_buffer_is_linear_in_rank_and_max_loras():
    base = rs.lora_buffer_bytes_per_gpu(GEMMA, 16, 4, 2)
    assert rs.lora_buffer_bytes_per_gpu(GEMMA, 32, 4, 2) == pytest.approx(2 * base)
    assert rs.lora_buffer_bytes_per_gpu(GEMMA, 16, 2, 2) == pytest.approx(base / 2)


def test_gemma_uses_global_head_dim_for_full_attention_layers():
    dims = rs.lora_module_dims(GEMMA)
    # 42 layers x (4 attention + 3 mlp) modules
    assert len(dims) == 42 * 7
    q_outs = {d[1] for d in dims[0::7]}
    assert q_outs == {8 * 256, 8 * 512}  # sliding head_dim 256, full global_head_dim 512


def test_dtype_bytes_from_config():
    assert rs.model_dtype_bytes(GEMMA) == 2
    assert rs.model_dtype_bytes({"hidden_size": 1, "torch_dtype": "float32"}) == 4
    assert rs.model_dtype_bytes(None) == 2


def test_budget_is_ten_percent_of_post_weights_memory():
    # 10% of (usable per GPU - 8 GiB weights/GPU); usable = usable_bytes() for one
    # GPU (visible fraction, utilization, runtime reserve — W8 calibration).
    b = rs.lora_buffer_budget_bytes(32, 0.9, int(16 * GIB), 2)
    assert b == pytest.approx(0.10 * (rs.usable_bytes(32, 1, 0.9) - 8 * GIB))
    assert b < 0.10 * (32 * 0.9 - 8) * GIB  # the reserve / visible fraction tighten the raw figure
    assert rs.lora_buffer_budget_bytes(32, 0.9, int(16 * GIB), 2, fraction=0.2) == pytest.approx(2 * b)


# ── Rank helpers ──────────────────────────────────────────────────────────────

def test_adapter_config_rank_uses_r_and_rank_pattern():
    assert rs.adapter_config_rank({"r": 32}) == 32
    assert rs.adapter_config_rank({"r": 16, "rank_pattern": {"q_proj": 64}}) == 64
    assert rs.adapter_config_rank({"r": 64, "rank_pattern": {}}) == 64
    assert rs.adapter_config_rank({}) is None
    assert rs.adapter_config_rank(None) is None


VLLM_ALLOWED = serve_manifest.lora_rank_allowed("vllm")


def test_snap_up_to_allowed_set():
    assert rs.snap_up(24, VLLM_ALLOWED) == 32
    assert rs.snap_up(64, VLLM_ALLOWED) == 64
    assert rs.snap_up(300, VLLM_ALLOWED) == 320
    assert rs.snap_up(1000, VLLM_ALLOWED) is None
    assert rs.snap_up(24, []) == 24  # engine accepts any integer


# ── effective_lora_rank (R2.3) ────────────────────────────────────────────────

def _ctx(**kw):
    base = dict(engine="vllm", rank_env_var="VLLM_MAX_LORA_RANK",
                rank_default=serve_manifest.lora_rank_default("vllm"),
                rank_allowed=VLLM_ALLOWED, max_loras=4, tp=2,
                model_config=GEMMA, gpu_memory_gib=32.0, weights_bytes=int(16 * GIB),
                target="hyperpod-eks")
    base.update(kw)
    return rs.SizingContext(**base)


def test_effective_rank_defaults_to_manifest_default_without_adapters():
    out = rs.effective_lora_rank(_ctx())
    assert out["rank"] == serve_manifest.lora_rank_default("vllm")
    assert out["auto_raised"] is False
    assert rs.exit_code([rs.Finding(**f) for f in out["findings"]]) == 0


def test_effective_rank_raises_to_recorded_adapters_fresh_ai_ml():
    # fresh-ai-ml: sft r32, dpo r64, rlaif r32, rlvr r32 → 64
    adapters = [rs.AdapterRank("sft", 32), rs.AdapterRank("dpo", 64), rs.AdapterRank("rlaif", 32),
                rs.AdapterRank("rlvr", 32)]
    out = rs.effective_lora_rank(_ctx(adapters=adapters))
    assert out["rank"] == 64 and out["required"] == 64 and out["auto_raised"] is True
    assert rs.exit_code([rs.Finding(**f) for f in out["findings"]]) == 0  # 0.73 GiB fits 2.08 GiB


def test_effective_rank_snaps_up_and_counts_tune_ranks():
    out = rs.effective_lora_rank(_ctx(adapters=[rs.AdapterRank("a", 24)], tune_ranks=[rs.AdapterRank("sft", 20)]))
    assert out["rank"] == 32


def test_tune_rank_alone_drives_the_rank():
    out = rs.effective_lora_rank(_ctx(tune_ranks=[rs.AdapterRank("dpo", 64)]))
    assert out["rank"] == 64


def test_explicit_rank_wins_with_warning_when_below_need():
    out = rs.effective_lora_rank(_ctx(explicit_rank=16, adapters=[rs.AdapterRank("dpo", 64)]))
    assert out["rank"] == 16
    warns = [f for f in out["findings"] if f["severity"] == "warn"]
    assert warns and "dpo r64" in warns[0]["message"]
    assert rs.exit_code([rs.Finding(**f) for f in out["findings"]]) == 1


def test_explicit_rank_outside_allowed_set_blocks():
    out = rs.effective_lora_rank(_ctx(explicit_rank=24))
    assert rs.exit_code([rs.Finding(**f) for f in out["findings"]]) == 2


def test_required_rank_above_engine_max_blocks():
    out = rs.effective_lora_rank(_ctx(adapters=[rs.AdapterRank("huge", 1024)]))
    assert rs.exit_code([rs.Finding(**f) for f in out["findings"]]) == 2


# ── lora-buffer-memory cap (R2.4, D3) ─────────────────────────────────────────

def _gpu_gib_with_cap_between(lo_rank, hi_rank, weights_per_gpu_gib=8.0):
    """A per-GPU memory size whose LoRA cap holds r`lo_rank` but not r`hi_rank`
    (derived from the module's own budget formula, so it tracks the constants)."""
    lo = rs.lora_buffer_bytes_per_gpu(GEMMA, lo_rank, 4, 2)
    hi = rs.lora_buffer_bytes_per_gpu(GEMMA, hi_rank, 4, 2)
    for tenth in range(80, 400):
        g = tenth / 10
        cap = rs.lora_buffer_budget_bytes(g, 0.9, int(2 * weights_per_gpu_gib * GIB), 2)
        if lo <= cap < hi:
            return g, cap
    raise AssertionError("no GPU size puts the cap between the two ranks")


def test_auto_raise_over_cap_blocks_naming_adapter_and_numbers():
    # A small GPU whose cap holds r16 but not r32: r64 needs 0.73 GiB → refuse,
    # naming the adapter and the numbers.
    g, cap = _gpu_gib_with_cap_between(16, 32)
    out = rs.effective_lora_rank(_ctx(gpu_memory_gib=g, gpu_memory_utilization=0.9,
                                      adapters=[rs.AdapterRank("dpo-w6", 64)]))
    blocks = [f for f in out["findings"] if f["severity"] == "block"]
    assert blocks, out
    msg = blocks[0]["message"]
    assert "dpo-w6 (r64)" in msg and "0.73 GiB" in msg and f"{cap / GIB:.2f} GiB" in msg
    assert blocks[0]["data"]["max_rank_within_budget"] == 16
    assert rs.exit_code([rs.Finding(**f) for f in out["findings"]]) == 2


def test_explicit_rank_over_cap_only_warns():
    out = rs.effective_lora_rank(_ctx(gpu_memory_gib=12.0, explicit_rank=64))
    sev = {f["severity"] for f in out["findings"]}
    assert "block" not in sev and "warn" in sev


def test_memory_check_skips_without_inputs():
    findings = rs.check_lora_buffer_memory(_ctx(model_config=None, serving_rank_limit=64))
    # Wave 8: missing inputs report the dedicated `skip` severity (6.1 used info).
    assert [f.severity for f in findings] == ["skip"]
    assert "model config.json" in findings[0].message


# ── lora-rank-fit (R3.2 pre-check semantics) ──────────────────────────────────

def test_rank_fit_live_limit_blocks_with_exact_fix():
    ctx = _ctx(adapters=[rs.AdapterRank("dpo-w6", 64)], serving_rank_limit=16, limit_kind="live")
    f = rs.check_lora_rank_fit(ctx)
    assert f[0].severity == "block"
    assert "VLLM_MAX_LORA_RANK=64" in f[0].fix and "./do/deploy --target hyperpod-eks --force" in f[0].fix
    assert "--surge-node" in f[0].fix


def test_rank_fit_within_limit_is_clean():
    ctx = _ctx(adapters=[rs.AdapterRank("sft", 32)], serving_rank_limit=64, limit_kind="live")
    assert rs.check_lora_rank_fit(ctx) == []


def test_registry_has_both_wave61_checks_and_exit_codes():
    assert {"lora-rank-fit", "lora-buffer-memory"} <= set(rs.CHECKS)
    assert rs.exit_code([]) == 0
    assert rs.exit_code([rs.Finding("x", "warn", "m")]) == 1
    assert rs.exit_code([rs.Finding("x", "warn", "m"), rs.Finding("y", "block", "m")]) == 2


# ── Environment layer ─────────────────────────────────────────────────────────

def _fake_fetch(store):
    def fetch(uri, env=None):
        return store.get(uri)
    return fetch


def test_context_from_env_reads_recorded_adapters_and_tune_ranks():
    store = {
        "s3://t/dpo/hf/adapter_config.json": json.dumps({"r": 64}).encode(),
        "s3://t/sft/hf/adapter_config.json": json.dumps({"r": 32}).encode(),
        "s3://core/models/g/config.json": json.dumps(GEMMA).encode(),
    }
    env = {
        "MODEL_SERVER": "vllm", "HP_GPU_COUNT": "2", "HP_INSTANCE_TYPE": "ml.g7.12xlarge",
        "TUNE_ADAPTER_PATH_DPO": "s3://t/dpo/hf/", "TUNE_ADAPTER_PATH_DPO_ORCA": "s3://t/dpo/hf/",
        "TUNE_ADAPTER_PATH_SFT": "s3://t/sft/hf/", "TUNE_LORA_RANK_RLVR": "32",
        "STAGED_MODEL_PATH": "s3://core/models/g/",
    }
    ctx = rs.context_from_env(env, fetch=_fake_fetch(store), fetch_weights=lambda u, e=None: 15992595884)
    assert sorted(a.rank for a in ctx.adapters) == [32, 64]  # de-duplicated by URI
    assert [t.rank for t in ctx.tune_ranks] == [32]
    assert ctx.rank_env_var == "VLLM_MAX_LORA_RANK" and ctx.tp == 2 and ctx.max_loras == 4
    assert ctx.gpu_memory_gib and ctx.model_config
    out = rs.effective_lora_rank(ctx)
    assert out["rank"] == 64
    assert rs.exit_code([rs.Finding(**f) for f in out["findings"]]) == 0


def test_explicit_env_var_is_the_engine_capability_var():
    ctx = rs.context_from_env({"MODEL_SERVER": "vllm", "VLLM_MAX_LORA_RANK": "32"}, rank_only=True,
                              fetch=_fake_fetch({}))
    assert ctx.explicit_rank == 32


def test_read_adapter_config_from_tarball():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        data = json.dumps({"r": 8, "rank_pattern": {"o_proj": 16}}).encode()
        info = tarfile.TarInfo("adapter_config.json")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    store = {"s3://b/a.tar.gz": buf.getvalue()}
    cfg = rs.read_adapter_config("s3://b/a.tar.gz", fetch=_fake_fetch(store))
    assert rs.adapter_config_rank(cfg) == 16


def test_cli_rank_fit_exit_codes(tmp_path):
    script = os.path.join(_PY, "right_sizing.py")
    env = {**os.environ, "MODEL_SERVER": "vllm", "DEPLOYMENT_TARGET": "eks"}
    ok = subprocess.run([sys.executable, script, "rank-fit", "--name", "a", "--rank", "32", "--limit", "64"],
                        capture_output=True, text=True, env=env)
    assert ok.returncode == 0
    bad = subprocess.run([sys.executable, script, "rank-fit", "--name", "dpo", "--rank", "64", "--limit", "16"],
                         capture_output=True, text=True, env=env)
    assert bad.returncode == 2
    assert "dpo" in bad.stdout and "VLLM_MAX_LORA_RANK=64" in bad.stdout


def test_cli_adapter_rank_local_dir(tmp_path):
    (tmp_path / "adapter_config.json").write_text(json.dumps({"r": 32}))
    script = os.path.join(_PY, "right_sizing.py")
    out = subprocess.run([sys.executable, script, "adapter-rank", str(tmp_path)], capture_output=True, text=True)
    assert out.returncode == 0 and out.stdout.strip() == "32"


def test_cli_effective_rank_json_rank_only():
    script = os.path.join(_PY, "right_sizing.py")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TUNE_", "VLLM_"))}
    env.update({"MODEL_SERVER": "vllm", "TUNE_LORA_RANK_DPO": "64"})
    out = subprocess.run([sys.executable, script, "effective-lora-rank", "--rank-only"],
                         capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout)["rank"] == 64
