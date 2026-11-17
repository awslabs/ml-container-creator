# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 11 R2 / R3.3 — the verb-scoped HyperPod cluster contract (hyperpod_ops.contract).

Every `kubectl` / `aws` call goes through hyperpod_ops._run, which these tests
replace with a scripted fake (no cluster, no AWS). Each element is exercised for
pass / block / transport error (fail CLOSED), plus the exact association command,
a wrong role ARN, a simulate denial, the HP_QUEUE-only queue check and the
validate cap at `warn`. Node / GPU shapes are synthetic: the assertions are about
the contract's decisions, never a frozen SKU or group name.
"""
import json
import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "templates", "do", "lib", "python"))
import hyperpod_ops as hp  # noqa: E402

ROLE = "arn:aws:iam::111111111111:role/mlcc-hp-train-role-us-west-2"
EKS = "zz-eks"


def _node(name, group, gpus=4, efa=1, ready=True, itype="ml.zz.12xlarge"):
    return {"metadata": {"name": name, "labels": {hp.GROUP_LABEL: group, hp.INSTANCE_TYPE_LABEL: itype}},
            "spec": {},
            "status": {"allocatable": {hp.GPU_RESOURCE: str(gpus), hp.EFA_RESOURCE: str(efa)},
                       "conditions": [{"type": "Ready", "status": "True" if ready else "False"}]}}


def _pod(node, gpus, name="busy", ns="default"):
    return {"metadata": {"name": name, "namespace": ns}, "spec": {"nodeName": node, "containers": [
        {"resources": {"requests": {hp.GPU_RESOURCE: str(gpus)}}}]}, "status": {"phase": "Running"}}


class Fake:
    """Scripted kubectl/aws. `rules` maps an argv prefix tuple to (rc, out, err)."""

    def __init__(self, **over):
        self.calls = []
        self.nodes = over.pop("nodes", [_node("n-a", "grp-a"), _node("n-b", "grp-b")])
        self.pods = over.pop("pods", [])
        self.rules = {
            ("kubectl", "get", "crd"): (0, f"customresourcedefinition.apiextensions.k8s.io/{hp.HPPJ_CRD}\n", ""),
            ("kubectl", "get", "deployments"): (0, json.dumps({"items": [{"metadata": {"name": "hp-training-operator-hp-training-controller-manager"},
                                                                          "status": {"conditions": [{"type": "Available", "status": "True"}]}}]}), ""),
            ("kubectl", "get", "pvc"): (0, json.dumps({"status": {"phase": "Bound"}}), ""),
            ("kubectl", "get", "storageclass"): (0, json.dumps({"items": []}), ""),
            ("kubectl", "get", "localqueues.kueue.x-k8s.io"): (0, "localqueue.kueue.x-k8s.io/q\n", ""),
            ("aws", "sagemaker", "describe-cluster"): (0, f"arn:aws:eks:us-west-2:111111111111:cluster/{EKS}\n", ""),
            ("aws", "eks", "list-pod-identity-associations"): (0, json.dumps({"associations": [{"associationId": "a-1"}]}), ""),
            ("aws", "eks", "describe-pod-identity-association"): (0, json.dumps({"association": {"roleArn": ROLE}}), ""),
            ("aws", "iam", "simulate-principal-policy"): (0, json.dumps({"EvaluationResults": [{"EvalDecision": "allowed"}]}), ""),
        }
        self.rules.update(over.pop("rules", {}))

    def __call__(self, cmd, timeout=120):
        self.calls.append(list(cmd))
        if cmd[:3] == ["kubectl", "get", "nodes"]:
            return 0, json.dumps({"items": self.nodes}), ""
        if cmd[:3] == ["kubectl", "get", "pods"]:
            return 0, json.dumps({"items": self.pods}), ""
        best = None
        for k, v in self.rules.items():
            if tuple(cmd[:len(k)]) == k and (best is None or len(k) > len(best[0])):
                best = (k, v)
        return best[1] if best else (1, "", "unexpected call")

    def ran(self, *prefix):
        return [c for c in self.calls if tuple(c[:len(prefix)]) == prefix]


ENV = {"HP_CLUSTER_NAME": "zz-hp", "HP_NAMESPACE": "default", "PROJECT_NAME": "proj",
       "AWS_REGION": "us-west-2", "MLCC_HP_TRAIN_ROLE_ARN": ROLE, "ARTIFACTS_S3_BUCKET": "zz-artifacts"}


def run(monkeypatch, verb="train", fake=None, env=None, **args):
    fake = fake or Fake()
    monkeypatch.setattr(hp, "_run", fake)
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    monkeypatch.delenv("_PROFILE_awsProfile", raising=False)
    out = hp.contract(verb, args, dict(ENV, **(env or {})))
    return out, fake


def by(out, check):
    return [f for f in out["findings"] if f["check"] == check]


# ── happy path + element scoping ─────────────────────────────────────────────

def test_train_all_elements_pass_and_resolve_the_group(monkeypatch):
    out, fake = run(monkeypatch, dataset="s3://core/datasets/d/v1/", job="j1")
    assert not out["blocked"], out["findings"]
    assert {f["check"] for f in out["findings"]} == {"training-operator", "pod-identity", "scratch-volume", "free-gpus"}
    r = out["resolved"]
    assert r["eks_cluster"] == EKS and r["scratch"] == "fsx"
    # Name-sorted first group with a whole free node; GPUs = that node's allocatable.
    assert r["group"] == "grp-a" and r["gpus"] == 4
    assert not fake.ran("kubectl", "get", "localqueues.kueue.x-k8s.io"), "no HP_QUEUE -> no queue check"


def test_tune_adds_shape_fit_and_add_pod_skips_training_elements(monkeypatch):
    out, _ = run(monkeypatch, verb="tune", template_gpus=4, template_efa=1)
    assert by(out, "gpu-shape-fit")[0]["severity"] == "info"
    out, fake = run(monkeypatch, verb="add-pod", gpus=1, model_bucket="core")
    checks = {f["check"] for f in out["findings"]}
    assert "pod-identity" not in checks and "training-operator" not in checks
    assert not fake.ran("aws", "eks", "list-pod-identity-associations")


# ── training-operator ────────────────────────────────────────────────────────

def test_missing_crd_blocks_naming_the_addon(monkeypatch):
    fake = Fake(rules={("kubectl", "get", "crd"): (1, "", 'Error from server (NotFound): crd "x" not found')})
    out, _ = run(monkeypatch, fake=fake)
    f = by(out, "training-operator")[0]
    assert f["severity"] == "block" and hp.TRAINING_OPERATOR_ADDON in f["fix"]


def test_operator_transport_error_fails_closed(monkeypatch):
    fake = Fake(rules={("kubectl", "get", "crd"): (1, "", "Unable to connect to the server: dial tcp: i/o timeout")})
    out, _ = run(monkeypatch, fake=fake)
    assert by(out, "training-operator")[0]["severity"] == "block" and out["blocked"]


def test_operator_not_available_blocks(monkeypatch):
    fake = Fake(rules={("kubectl", "get", "deployments"): (0, json.dumps({"items": [
        {"metadata": {"name": "hp-training-operator-x"}, "status": {"conditions": [{"type": "Available", "status": "False"}]}}]}), "")})
    out, _ = run(monkeypatch, fake=fake)
    assert by(out, "training-operator")[0]["severity"] == "block"


# ── pod-identity (R3.3) ──────────────────────────────────────────────────────

def test_missing_association_blocks_with_the_exact_create_command(monkeypatch):
    fake = Fake(rules={("aws", "eks", "list-pod-identity-associations"): (0, json.dumps({"associations": []}), "")})
    out, _ = run(monkeypatch, fake=fake)
    f = by(out, "pod-identity")[0]
    assert f["severity"] == "block"
    assert f["fix"] == (f"aws eks create-pod-identity-association --cluster-name {EKS} --namespace default "
                        f"--service-account mlcc-train-sa --role-arn {ROLE} --region us-west-2")


def test_wrong_role_arn_blocks(monkeypatch):
    fake = Fake(rules={("aws", "eks", "describe-pod-identity-association"): (
        0, json.dumps({"association": {"roleArn": "arn:aws:iam::111111111111:role/other"}}), "")})
    out, _ = run(monkeypatch, fake=fake)
    f = by(out, "pod-identity")[0]
    assert f["severity"] == "block" and "role/other" in f["message"]
    assert "create-pod-identity-association" in f["fix"] and "delete-pod-identity-association" in f["fix"]


def test_simulate_denial_blocks_naming_the_action(monkeypatch):
    fake = Fake(rules={("aws", "iam", "simulate-principal-policy"): (
        0, json.dumps({"EvaluationResults": [{"EvalDecision": "implicitDeny"}]}), "")})
    out, fake = run(monkeypatch, fake=fake, dataset="s3://core/datasets/d/v1/train.jsonl", job="j1")
    f = by(out, "pod-identity")[0]
    assert f["severity"] == "block" and "s3:GetObject" in f["message"] and "s3:PutObject" in f["message"]
    sims = fake.ran("aws", "iam", "simulate-principal-policy")
    resources = [c[c.index("--resource-arns") + 1] for c in sims]
    assert "arn:aws:s3:::core/datasets/d/v1/train.jsonl" in resources
    assert "arn:aws:s3:::zz-artifacts/proj/train/j1/probe" in resources


def test_tune_simulates_the_tune_subtree(monkeypatch):
    _, fake = run(monkeypatch, verb="tune", job="j9", template_gpus=4)
    resources = [c[c.index("--resource-arns") + 1] for c in fake.ran("aws", "iam", "simulate-principal-policy")]
    assert "arn:aws:s3:::zz-artifacts/proj/tune/j9/probe" in resources


def test_no_role_in_profile_blocks_with_the_bootstrap_command(monkeypatch):
    out, fake = run(monkeypatch, env={"MLCC_HP_TRAIN_ROLE_ARN": ""})
    f = by(out, "pod-identity")[0]
    assert f["severity"] == "block" and "bootstrap update --module training" in f["fix"]
    assert not fake.ran("aws", "eks"), "no association lookup without a role to compare"


def test_association_transport_error_fails_closed(monkeypatch):
    fake = Fake(rules={("aws", "eks", "list-pod-identity-associations"): (255, "", "Could not connect to the endpoint URL")})
    out, _ = run(monkeypatch, fake=fake)
    assert by(out, "pod-identity")[0]["severity"] == "block"


# ── scratch-volume ───────────────────────────────────────────────────────────

def test_no_fsx_claim_falls_back_to_the_default_storage_class_for_train(monkeypatch):
    fake = Fake(rules={
        ("kubectl", "get", "pvc"): (1, "", 'Error from server (NotFound): persistentvolumeclaims "fsx-claim" not found'),
        ("kubectl", "get", "storageclass"): (0, json.dumps({"items": [
            {"metadata": {"name": "gp3", "annotations": {hp.DEFAULT_SC_ANNOTATION: "true"}}}]}), "")})
    out, _ = run(monkeypatch, fake=fake)
    assert by(out, "scratch-volume")[0]["severity"] == "info"
    assert out["resolved"]["scratch"] == "ephemeral" and out["resolved"]["storage_class"] == "gp3"


def test_no_fsx_claim_and_no_storage_class_blocks(monkeypatch):
    fake = Fake(rules={("kubectl", "get", "pvc"): (1, "", "NotFound")})
    out, _ = run(monkeypatch, fake=fake)
    assert by(out, "scratch-volume")[0]["severity"] == "block"


def test_tune_requires_fsx_claim(monkeypatch):
    fake = Fake(rules={("kubectl", "get", "pvc"): (1, "", "NotFound")})
    out, fake = run(monkeypatch, verb="tune", fake=fake, template_gpus=4)
    assert by(out, "scratch-volume")[0]["severity"] == "block"
    assert not fake.ran("kubectl", "get", "storageclass")


def test_pvc_transport_error_fails_closed(monkeypatch):
    fake = Fake(rules={("kubectl", "get", "pvc"): (1, "", "Unable to connect to the server")})
    out, _ = run(monkeypatch, fake=fake)
    assert by(out, "scratch-volume")[0]["severity"] == "block"


# ── free-gpus / group pick (R4.2) ────────────────────────────────────────────

def test_busy_groups_block_and_name_the_pods(monkeypatch):
    fake = Fake(pods=[_pod("n-a", 4, "serve-a"), _pod("n-b", 2, "serve-b")])
    out, _ = run(monkeypatch, fake=fake)
    f = by(out, "free-gpus")[0]
    assert f["severity"] == "block" and "default/serve-a" in f["message"] and "default/serve-b" in f["message"]


def test_partially_free_node_is_used_when_gpus_is_given(monkeypatch):
    fake = Fake(pods=[_pod("n-a", 4)], nodes=[_node("n-a", "grp-a"), _node("n-b", "grp-b")])
    fake.pods.append(_pod("n-b", 2, "half"))
    out, _ = run(monkeypatch, fake=fake, gpus=2)
    assert out["resolved"]["group"] == "grp-b" and out["resolved"]["gpus"] == 2


def test_named_group_and_instance_type_filter(monkeypatch):
    fake = Fake(nodes=[_node("n-a", "grp-a", itype="ml.zz.a"), _node("n-b", "grp-b", itype="ml.zz.b")])
    out, _ = run(monkeypatch, fake=fake, instance_type="ml.zz.b")
    assert out["resolved"]["group"] == "grp-b"
    out, _ = run(monkeypatch, fake=Fake(nodes=[_node("n-a", "grp-a")]), group="nope")
    assert by(out, "free-gpus")[0]["severity"] == "block"


def test_gpus_above_allocatable_blocks(monkeypatch):
    out, _ = run(monkeypatch, gpus=99)
    f = by(out, "free-gpus")[0]
    assert f["severity"] == "block" and "exceeds" in f["message"]


def test_not_ready_nodes_are_never_picked(monkeypatch):
    out, _ = run(monkeypatch, fake=Fake(nodes=[_node("n-a", "grp-a", ready=False)]))
    assert by(out, "free-gpus")[0]["severity"] == "block"


def test_add_pod_without_room_blocks_unless_surge_is_allowed(monkeypatch):
    fake = Fake(nodes=[_node("n-a", "grp-a")], pods=[_pod("n-a", 4)])
    out, _ = run(monkeypatch, verb="add-pod", fake=fake, gpus=1)
    assert by(out, "free-gpus")[0]["severity"] == "block"
    out, _ = run(monkeypatch, verb="add-pod", fake=Fake(nodes=[_node("n-a", "grp-a")], pods=[_pod("n-a", 4)]),
                 gpus=1, allow_surge=True)
    assert by(out, "free-gpus")[0]["severity"] == "warn"


# ── gpu-shape-fit (R11.1) ────────────────────────────────────────────────────

def test_shape_bigger_than_the_group_blocks_naming_p4d_p5_and_the_flag(monkeypatch):
    out, _ = run(monkeypatch, verb="tune", template_gpus=8, template_efa=32)
    f = by(out, "gpu-shape-fit")[0]
    assert f["severity"] == "block" and "p4d/p5" in f["fix"] and "--adapt-shape" in f["fix"]


def test_adapt_shape_turns_the_block_into_an_experimental_warning(monkeypatch):
    out, _ = run(monkeypatch, verb="tune", template_gpus=8, template_efa=32, adapt_shape=True)
    f = by(out, "gpu-shape-fit")[0]
    assert f["severity"] == "warn" and "EXPERIMENTAL" in f["message"]


# ── local-queue ──────────────────────────────────────────────────────────────

def test_missing_local_queue_blocks_only_when_hp_queue_is_set(monkeypatch):
    fake = Fake(rules={("kubectl", "get", "localqueues.kueue.x-k8s.io"): (1, "", "NotFound")})
    out, _ = run(monkeypatch, fake=fake, env={"HP_QUEUE": "q"})
    f = by(out, "local-queue")[0]
    assert f["severity"] == "block" and "unset HP_QUEUE" in f["fix"]
    out, _ = run(monkeypatch, env={"HP_QUEUE": "q"})
    assert by(out, "local-queue")[0]["severity"] == "info"


# ── s3-csi-role (add-pod) ────────────────────────────────────────────────────

def test_add_pod_s3_csi_denial_blocks(monkeypatch):
    fake = Fake(rules={
        ("kubectl", "get", "csidriver"): (0, f"csidriver.storage.k8s.io/{hp.S3_CSI_DRIVER}\n", ""),
        ("kubectl", "get", "sa"): (0, json.dumps({"metadata": {"annotations": {"eks.amazonaws.com/role-arn": "arn:aws:iam::1:role/csi"}}}), ""),
        ("aws", "iam", "simulate-principal-policy"): (0, json.dumps({"EvaluationResults": [
            {"EvalActionName": "s3:GetObject", "EvalResourceName": "arn:aws:s3:::core/*", "EvalDecision": "implicitDeny"},
            {"EvalActionName": "s3:ListBucket", "EvalResourceName": "arn:aws:s3:::core", "EvalDecision": "allowed"}]}), "")})
    out, _ = run(monkeypatch, verb="add-pod", fake=fake, gpus=1, model_bucket="core")
    assert by(out, "s3-csi-role")[0]["severity"] == "block"


# ── validate cap (R2.3) + CLI exit codes ─────────────────────────────────────

def test_preflight_env_reports_training_elements_capped_at_warn(monkeypatch):
    fake = Fake(rules={("aws", "eks", "list-pod-identity-associations"): (0, json.dumps({"associations": []}), ""),
                       ("kubectl", "get", "crd"): (1, "", "NotFound")})
    monkeypatch.setattr(hp, "_run", fake)
    out = hp.preflight_from_env(dict(ENV))
    sev = {f["check"]: f["severity"] for f in out["findings"]}
    assert sev["pod-identity"] == "warn" and sev["training-operator"] == "warn"
    assert all(f["severity"] != "block" for f in out["findings"])


def test_cli_exits_4_on_block_and_0_when_clear(monkeypatch, capsys):
    monkeypatch.setattr(hp, "_run", Fake(rules={("kubectl", "get", "crd"): (1, "", "NotFound")}))
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    assert hp._cli(["contract", "--verb", "train", "--json"]) == 4
    assert json.loads(capsys.readouterr().out)["blocked"] is True
    monkeypatch.setattr(hp, "_run", Fake())
    assert hp._cli(["contract", "--verb", "train", "--json"]) == 0


# ── recorded argv for the flag guards ────────────────────────────────────────

def recorded_contract_argv():
    """Every aws / kubectl argv the contract emits (used by test_aws_cli_flags.py
    and the kubectl --help check below), from one run through every element."""
    fake = Fake(rules={("kubectl", "get", "csidriver"): (0, f"csidriver.storage.k8s.io/{hp.S3_CSI_DRIVER}\n", ""),
                       ("kubectl", "get", "pvc"): (1, "", "NotFound"),
                       ("kubectl", "get", "storageclass"): (0, json.dumps({"items": [
                           {"metadata": {"name": "gp3", "annotations": {hp.DEFAULT_SC_ANNOTATION: "true"}}}]}), "")})
    saved = hp._run
    hp._run = fake
    try:
        env = dict(ENV, HP_QUEUE="q")
        hp.contract("train", {"dataset": "s3://core/datasets/d/", "job": "j"}, env)
        hp.contract("tune", {"job": "j", "template_gpus": 8, "template_efa": 32}, env)
        hp.contract("add-pod", {"gpus": 1, "model_bucket": "core"}, env)
    finally:
        hp._run = saved
    printed = hp.association_command(EKS, "default", ROLE, "us-west-2").split()
    return fake.calls + [printed]


def test_new_kubectl_argv_is_accepted_by_kubectl_help():
    import shutil
    import subprocess
    if not shutil.which("kubectl"):
        pytest.skip("kubectl not installed: the argv is still recorded, only the --help comparison is skipped")
    for argv in recorded_contract_argv():
        if argv[0] != "kubectl":
            continue
        verb = argv[1]
        help_text = subprocess.run(["kubectl", verb, "--help"], capture_output=True, text=True, timeout=30).stdout
        help_text += subprocess.run(["kubectl", "options"], capture_output=True, text=True, timeout=30).stdout
        for tok in argv[2:]:
            if tok.startswith("--"):
                flag = tok.split("=", 1)[0]
                assert f"{flag}=" in help_text or f"{flag} " in help_text or f"{flag}:" in help_text, \
                    f"kubectl {verb} has no {flag} ({' '.join(argv)})"
            elif tok.startswith("-") and len(tok) == 2:
                assert f"{tok}," in help_text or f"{tok} " in help_text, f"kubectl {verb} has no {tok}"
