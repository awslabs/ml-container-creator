# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 6.1 Part A — adapter delivery mapping (R1), live rank limit (R3.2),
hyperpod rollout/surge selection logic (R4), the eks AIPerf adapter model name
(R7c) and the do/tune "before this technique" effective rank (R2.5)."""
import json
import os
import subprocess
import sys

import pytest

_PY = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python"))
if _PY not in sys.path:
    sys.path.insert(0, _PY)

import adapter_delivery as ad  # noqa: E402
import hyperpod_ops as hp  # noqa: E402
import right_sizing as rs  # noqa: E402
import serve_manifest  # noqa: E402
import target_manifest  # noqa: E402

DELIVERY = target_manifest.adapter_delivery("hyperpod-eks")
BASE = {"source_type": "s3", "bucket": "core", "prefix": "models/google/gemma-4-E4B-it", "prefetch": "false"}


# ── R1.1 descriptor + R1.3 mapping ────────────────────────────────────────────

def test_descriptor_declares_model_prefix_for_both_k8s_targets():
    for t in ("hyperpod-eks", "eks", "hyperpod"):
        d = target_manifest.adapter_delivery(t)
        assert d["strategy"] == "model-prefix" and d["mount_path"].startswith("/") and d["subdir"]
    assert target_manifest.adapter_delivery("realtime-inference") == {}


def test_model_prefix_uri_maps_to_the_in_pod_path():
    uri = f"s3://core/models/google/gemma-4-E4B-it/{DELIVERY['subdir']}/fresh-ai-ml/dpo-w6/"
    got = ad.local_path("hyperpod-eks", uri, "fresh-ai-ml", "dpo-w6", BASE)
    assert got == f"{DELIVERY['mount_path']}/{DELIVERY['subdir']}/fresh-ai-ml/dpo-w6"
    assert not got.startswith("s3://")


def test_outside_prefix_local_path_never_passes_s3():
    with pytest.raises(ad.DeliveryRefused) as exc:
        ad.local_path("hyperpod-eks", "s3://zz-art/fresh-ai-ml/tune/dpo/hf/", "fresh-ai-ml", "dpo-w6", BASE)
    assert ad.deployment_adapter_uri(BASE, "fresh-ai-ml", "dpo-w6") in exc.value.fix


# ── Part B: promote / load / copy-on-mismatch / refuse (R1.3, bucket R3) ─────

def test_plan_promotes_a_raw_source_into_the_canonical_prefix_then_loads_by_path():
    plan = ad.plan_delivery("hyperpod-eks", "s3://zz-art/fresh-ai-ml/tune/dpo/j/hf/", "fresh-ai-ml", "dpo-w6",
                            BASE, core_bucket="core", adapter_base="huggingface-vlm-gemma-4-e4b-it")
    assert plan["promote_to"] == "s3://core/models/google/gemma-4-E4B-it/.mlcc-adapters/fresh-ai-ml/dpo-w6/"
    assert plan["copy_to"] == ""
    # BL199: the promotion picks the content-addressed version, so the final path is
    # only known after delivery; the plan names the home it will sit under.
    assert plan["path"] == ""
    assert plan["path_home"] == f"{DELIVERY['mount_path']}/.mlcc-adapters/fresh-ai-ml/dpo-w6"


def test_plan_canonical_under_this_prefix_needs_no_copy():
    uri = "s3://core/models/google/gemma-4-E4B-it/.mlcc-adapters/fresh-ai-ml/tuned-sft/"
    plan = ad.plan_delivery("hyperpod-eks", uri, "fresh-ai-ml", "sft-w6", BASE)
    assert plan["promote_to"] == "" and plan["copy_to"] == ""
    assert plan["path"].endswith("/.mlcc-adapters/fresh-ai-ml/tuned-sft")


def test_plan_copies_only_on_a_base_prefix_mismatch_with_the_same_base():
    restaged = {**BASE, "prefix": "models/mlcc-fresh-ai-ml/gemma-restaged"}
    uri = "s3://core/models/google/gemma-4-E4B-it/.mlcc-adapters/fresh-ai-ml/tuned-sft/"
    plan = ad.plan_delivery("hyperpod-eks", uri, "fresh-ai-ml", "sft-w6", restaged,
                            deployment_model="google/gemma-4-E4B-it")
    assert plan["copy_to"] == "s3://core/models/mlcc-fresh-ai-ml/gemma-restaged/.mlcc-adapters/fresh-ai-ml/sft-w6/"
    assert plan["path"] == "" and plan["path_home"] == f"{DELIVERY['mount_path']}/.mlcc-adapters/fresh-ai-ml/sft-w6"


def test_plan_refuses_an_incompatible_base_before_any_copy():
    qwen = {**BASE, "prefix": "models/Qwen/Qwen3-8B"}
    uri = "s3://core/models/google/gemma-4-E4B-it/.mlcc-adapters/fresh-ai-ml/tuned-sft/"
    with pytest.raises(ad.DeliveryRefused) as exc:
        ad.plan_delivery("hyperpod-eks", uri, "fresh-ai-ml", "sft-w6", qwen)
    assert "incompatible base" in str(exc.value)


def test_plan_refuses_an_unmapped_tune_base_never_guesses():
    with pytest.raises(ad.DeliveryRefused):
        ad.plan_delivery("hyperpod-eks", "s3://zz-art/p/tune/x/", "p", "n", BASE, core_bucket="core",
                         adapter_base="huggingface-llm-not-in-catalog")


@pytest.mark.parametrize("base,needle", [
    ({"source_type": "huggingface", "bucket": "", "prefix": "", "prefetch": "true"}, "./do/stage"),
    ({**BASE, "prefetch": "true"}, "prefetchEnabled: true"),
])
def test_hyperpod_refusals_name_the_fix(base, needle):
    with pytest.raises(ad.DeliveryRefused) as exc:
        ad.local_path("hyperpod-eks", "s3://core/x/", "p", "n", base)
    assert needle in (str(exc.value) + exc.value.fix)


def test_eks_without_s3_mount_refuses_and_with_mount_maps():
    env_no = {"STAGED_MODEL_PATH": "s3://core/models/m/"}
    with pytest.raises(ad.DeliveryRefused) as exc:
        ad.local_path("eks", "s3://core/models/m/.mlcc-adapters/p/a/", "p", "a", ad.model_base_from_env(env_no))
    assert "EKS_MODEL_MOUNT=s3" in exc.value.fix
    env = {**env_no, "EKS_MODEL_MOUNT": "s3"}
    got = ad.local_path("eks", "s3://core/models/m/.mlcc-adapters/p/a/", "p", "a", ad.model_base_from_env(env))
    assert got.endswith("/.mlcc-adapters/p/a")


def test_model_base_from_live_iec():
    iec = {"spec": {"modelSourceConfig": {"modelSourceType": "s3", "s3Storage": {"bucketName": "core"},
                                          "modelLocation": "models/g/", "prefetchEnabled": False}}}
    assert ad.model_base_from_iec(iec) == {"source_type": "s3", "bucket": "core", "prefix": "models/g", "prefetch": "false"}
    assert ad.model_base_from_iec(None)["source_type"] == ""


def test_local_path_passthrough():
    assert ad.local_path("hyperpod-eks", "/opt/ml/model/x/", "p", "n", BASE) == "/opt/ml/model/x"


# ── R3.2 live limit ───────────────────────────────────────────────────────────

def test_live_limit_prefers_pod_env_then_iec_then_default():
    pods = {"items": [{"spec": {"containers": [{"env": [{"name": "VLLM_MAX_LORA_RANK", "value": "64"}]}]}}]}
    iec = {"spec": {"worker": {"environmentVariables": [{"name": "VLLM_MAX_LORA_RANK", "value": "32"}]}}}
    assert rs.live_rank_limit("vllm", pods, iec) == (64, "pod env")
    assert rs.live_rank_limit("vllm", {"items": []}, iec) == (32, "InferenceEndpointConfig env")
    assert rs.live_rank_limit("vllm", None, None, {"VLLM_MAX_LORA_RANK": "128"})[0] == 128
    limit, src = rs.live_rank_limit("vllm")
    assert limit == serve_manifest.lora_rank_default("vllm") and "default" in src


def test_rank_fit_fix_for_realtime_names_ic_env():
    ctx = rs.SizingContext(rank_env_var="VLLM_MAX_LORA_RANK", rank_allowed=serve_manifest.lora_rank_allowed("vllm"),
                           adapters=[rs.AdapterRank("a", 64)], serving_rank_limit=16, limit_kind="live",
                           target="realtime-inference")
    f = rs.check_lora_rank_fit(ctx)[0]
    assert f.severity == "block" and "IC_ENV_VLLM_MAX_LORA_RANK=64" in f.fix and "--force-ic" in f.fix


# ── R2.5 do/tune: limit BEFORE this technique ─────────────────────────────────

def test_effective_rank_exclude_technique():
    script = os.path.join(_PY, "right_sizing.py")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TUNE_", "VLLM_"))}
    env.update({"MODEL_SERVER": "vllm", "TUNE_LORA_RANK_DPO": "64", "TUNE_LORA_RANK_SFT": "32"})
    out = subprocess.run([sys.executable, script, "effective-lora-rank", "--rank-only", "--exclude-technique", "dpo"],
                         capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout)["rank"] == 32
    out = subprocess.run([sys.executable, script, "effective-lora-rank", "--rank-only"],
                         capture_output=True, text=True, env=env)
    assert json.loads(out.stdout)["rank"] == 64


# ── R4 rollout capacity / surge restore selection ─────────────────────────────

def _node(name, gpus=2, ready=True, group="g7"):
    return {"metadata": {"name": name, "labels": {hp.GROUP_LABEL: group}},
            "spec": {"providerID": f"aws:///az/sagemaker/cluster/hyperpod-x-{name.split('-', 1)[1]}"},
            "status": {"allocatable": {hp.GPU_RESOURCE: str(gpus)},
                       "conditions": [{"type": "Ready", "status": "True" if ready else "False"}]}}


def _pod(node, gpus=2, app="proj", ready=True, terminating=False):
    md = {"name": f"{app}-x", "namespace": "default", "labels": {"app": app}}
    if terminating:
        md["deletionTimestamp"] = "now"
    return {"metadata": md, "spec": {"nodeName": node, "containers": [{"resources": {"requests": {hp.GPU_RESOURCE: str(gpus)}}}]},
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True" if ready else "False"}]}}


def test_free_gpus_and_instance_ids():
    rep = hp.free_gpus([_node("hyperpod-i-aaaa1111")], [_pod("hyperpod-i-aaaa1111")])
    assert rep[0]["free"] == 0 and rep[0]["instance_id"] == "i-aaaa1111" and rep[0]["group"] == "g7"


def test_rollout_capacity_single_full_node_is_unschedulable(monkeypatch):
    monkeypatch.setattr(hp, "cluster_view", lambda **kw: ([_node("hyperpod-i-aaaa1111")], [_pod("hyperpod-i-aaaa1111")]))
    monkeypatch.setattr(hp, "describe_group", lambda c, g: ({"CurrentCount": 1, "TargetCount": 1}, ""))
    rc, out = hp.rollout_capacity("c", "default", "proj", "ml.g7.12xlarge", 2)
    assert rc == 3 and out["schedulable"] is False and out["group"] == "g7" and out["single_node"] is True


def test_rollout_capacity_spare_node_is_schedulable(monkeypatch):
    monkeypatch.setattr(hp, "cluster_view", lambda **kw: (
        [_node("hyperpod-i-aaaa1111"), _node("hyperpod-i-bbbb2222")], [_pod("hyperpod-i-aaaa1111")]))
    monkeypatch.setattr(hp, "describe_group", lambda c, g: ({"CurrentCount": 2, "TargetCount": 2}, ""))
    rc, out = hp.rollout_capacity("c", "default", "proj", "ml.g7.12xlarge", 2)
    assert rc == 0 and out["schedulable"] is True


def test_group_spec_copies_fields_and_never_goes_below_one(monkeypatch):
    g = {"InstanceGroupName": "g7", "InstanceType": "ml.g7.12xlarge", "ExecutionRole": "r", "TargetCount": 1,
         "CurrentCount": 1, "LifeCycleConfig": {"SourceS3Uri": "s3://x", "OnCreate": "a.sh"}, "Status": "InService",
         "DesiredImageId": "default", "OverrideVpcConfig": {"Subnets": ["s"], "SecurityGroupIds": ["g"]}}
    spec = hp._group_spec(g, 2)
    assert spec["InstanceCount"] == 2 and spec["ExecutionRole"] == "r" and spec["OverrideVpcConfig"]
    assert "Status" not in spec and "CurrentCount" not in spec and "ImageId" not in spec
    calls = []
    monkeypatch.setattr(hp, "_aws", lambda args, timeout=120: calls.append(args) or (0, "", ""))
    rc, msg = hp.update_group_count("c", g, 0)
    assert rc == 2 and "zero" in msg and calls == []


def test_surge_restore_removes_the_vacated_node_not_the_serving_one(monkeypatch):
    monkeypatch.setattr(hp, "describe_group", lambda c, g: ({"TargetCount": 2, "CurrentCount": 2}, ""))
    nodes = [_node("hyperpod-i-aaaa1111"), _node("hyperpod-i-bbbb2222")]
    monkeypatch.setattr(hp, "cluster_view", lambda **kw: (nodes, [_pod("hyperpod-i-bbbb2222")]))
    calls = []

    def fake_aws(args, timeout=120):
        calls.append(args)
        return 0, json.dumps({"Successful": ["i-aaaa1111"]}), ""
    monkeypatch.setattr(hp, "_aws", fake_aws)
    rc, out = hp.surge_restore("c", "g7", 1, "default", "proj")
    assert rc == 0 and out["node_ids"] == ["i-aaaa1111"]
    assert calls and calls[0][1] == "batch-delete-cluster-nodes" and "i-bbbb2222" not in calls[0]


def test_surge_restore_when_the_surge_node_never_joined_lowers_the_target(monkeypatch):
    g = {"TargetCount": 2, "CurrentCount": 1, "InstanceGroupName": "g7", "ExecutionRole": "r"}
    monkeypatch.setattr(hp, "describe_group", lambda c, grp: (g, ""))
    monkeypatch.setattr(hp, "cluster_view", lambda **kw: ([_node("hyperpod-i-aaaa1111")], [_pod("hyperpod-i-aaaa1111")]))
    sent = []
    monkeypatch.setattr(hp, "_aws", lambda args, timeout=120: sent.append(args) or (0, "{}", ""))
    rc, out = hp.surge_restore("c", "g7", 1, "default", "proj")
    assert rc == 0 and out["action"] == "update-cluster"
    payload = json.loads(sent[0][sent[0].index("--cli-input-json") + 1])
    assert payload["InstanceGroups"][0]["InstanceCount"] == 1


def test_surge_restore_never_removes_the_last_ready_serving_pod(monkeypatch):
    monkeypatch.setattr(hp, "describe_group", lambda c, g: ({"TargetCount": 2, "CurrentCount": 2}, ""))
    # One node hosts the only Ready serving pod; the other cannot be mapped to an
    # instance id → nothing is safely removable, so restore refuses (no AWS call).
    bad = _node("node-less")
    bad["spec"]["providerID"] = ""
    monkeypatch.setattr(hp, "cluster_view", lambda **kw: ([_node("hyperpod-i-aaaa1111"), bad], [_pod("hyperpod-i-aaaa1111")]))
    monkeypatch.setattr(hp, "_aws", lambda args, timeout=120: pytest.fail("must not call AWS"))
    rc, out = hp.surge_restore("c", "g7", 1, "default", "proj")
    assert rc == 1 and "restore manually" in out["error"]


def test_rollout_wait_requires_old_pod_gone(monkeypatch):
    seq = [{"items": [_pod("a"), _pod("b", ready=False)]}, {"items": [_pod("b")]}]
    monkeypatch.setattr(hp, "_kubectl_json", lambda args: seq.pop(0) if seq else {"items": []})
    monkeypatch.setattr(hp.time, "sleep", lambda s: None)
    rc, out = hp.rollout_wait("default", "proj", 1, timeout=60, interval=0)
    assert rc == 0 and out == {"pods": 1, "ready": 1}


# ── R7c eks AIPerf names the adapter ──────────────────────────────────────────

def test_eks_aiperf_served_model_override(monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location("eks_aiperf_w61", os.path.join(_PY, "eks_aiperf.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setenv("MODEL_NAME", "s3://core/models/m/")
    assert mod.derive_served_model() == "/opt/ml/model"
    monkeypatch.setenv("BENCHMARK_SERVED_MODEL", "dpo-w6")
    assert mod.derive_served_model() == "dpo-w6"
    cmd = mod.build_command(18080, "/tmp/a")
    assert cmd[cmd.index("--model") + 1] == "dpo-w6"
