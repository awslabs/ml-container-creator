# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL236 — HyperPod capacity counts pod slots, not just free GPUs.

Reproduces the owner's 2026-10-28 deploy of neat-transformer-classifier: one
node, allocatable pods=29 (the kubelet's ENI-based max-pods), 28 non-terminal
system pods (21 DaemonSet + 7 controller pods). A GPU was free, so the model pod
scheduled as pod 29, and the per-node Mountpoint-for-S3 pod (pinned to the node,
preemptionPolicy Never) was refused 'Too many pods' — the model pod hung in
ContainerCreating with FailedMount.

Pod slots come from the node's allocatable `pods`, never from a per-instance
table: the tests vary that number and assert the verdict follows it. No kubectl
or AWS call is made (cluster_view / _kubectl_json / describe_group / _run are
replaced).
"""
import json
import os
import sys

_PY = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python"))
if _PY not in sys.path:
    sys.path.insert(0, _PY)
import hyperpod_ops as hp  # noqa: E402

NODE = "hyperpod-i-0b7347514f606d30d"
GROUP = "g5-16x-worker"
ITYPE = "ml.g5.16xlarge"
PV = "inference-s3-pv-neat-transformer-classifier-inf"
PVC = "inference-s3-pvc-neat-transformer-classifier-inf"


def _node(name=NODE, gpus=1, max_pods=29, group=GROUP, itype=ITYPE):
    alloc = {hp.GPU_RESOURCE: str(gpus)}
    if max_pods is not None:
        alloc["pods"] = str(max_pods)
    return {"metadata": {"name": name, "labels": {hp.GROUP_LABEL: group, hp.INSTANCE_TYPE_LABEL: itype}},
            "spec": {"providerID": f"aws:///us-west-2b/sagemaker/cluster/hyperpod-x-{name.split('-', 1)[1]}"},
            "status": {"allocatable": alloc, "conditions": [{"type": "Ready", "status": "True"}]}}


def _pod(name, node=NODE, ns="kube-system", gpus=0, phase="Running", labels=None, annotations=None,
         claim=None, affinity_node=None):
    md = {"name": name, "namespace": ns, "labels": labels or {}}
    if annotations:
        md["annotations"] = annotations
    spec = {"containers": [{"resources": {"requests": {hp.GPU_RESOURCE: str(gpus)}} if gpus else {}}]}
    if node:
        spec["nodeName"] = node
    if claim:
        spec["volumes"] = [{"name": "model-weights", "persistentVolumeClaim": {"claimName": claim}}]
    if affinity_node:
        spec["affinity"] = {"nodeAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": {"nodeSelectorTerms": [
            {"matchFields": [{"key": "metadata.name", "operator": "In", "values": [affinity_node]}]}]}}}
    return {"metadata": md, "spec": spec,
            "status": {"phase": phase, "conditions": [{"type": "Ready", "status": "True" if phase == "Running" else "False"}]}}


def system_pods(n=28, node=NODE):
    """n non-terminal system pods + one Completed validator (must not count)."""
    pods = [_pod(f"ds-{i}", node) for i in range(21)] + [_pod(f"ctl-{i}", node) for i in range(n - 21)]
    return pods + [_pod("nvidia-cuda-validator-x", node, phase="Succeeded")]


def _mp_pod(name="mp-r5w6b", node=NODE, phase="Running", volume=PV):
    return _pod(name, node if phase == "Running" else None, ns="mount-s3", phase=phase,
                annotations={hp.S3_CSI_VOLUME_ANNOTATION: volume, "s3.csi.aws.com/volume-id": "s3://zz-core"},
                affinity_node=node)


def _serving(node=NODE, gpus=1):
    return _pod("neat-transformer-classifier-abc", node, ns="default", gpus=gpus,
                labels={"app": "neat-transformer-classifier"}, claim=PVC)


def _kubectl_objects(monkeypatch, pvc_to_pv=None, pv_driver=hp.S3_CSI_DRIVER, events=None, pods_by_selector=None,
                     all_pods=None):
    pvc_to_pv = {PVC: PV} if pvc_to_pv is None else pvc_to_pv

    def fake(args):
        if args[:2] == ["get", "pvc"]:
            pv = pvc_to_pv.get(args[2])
            return {"spec": {"volumeName": pv}} if pv else None
        if args[:2] == ["get", "pv"]:
            return {"spec": {"csi": {"driver": pv_driver}}}
        if args[:2] == ["get", "events"]:
            name = args[-1].split("=", 1)[1]
            return {"items": (events or {}).get(name, [])}
        if args[:2] == ["get", "pods"] and "--all-namespaces" in args:
            return {"items": all_pods or []}
        if args[:2] == ["get", "pods"]:
            return {"items": (pods_by_selector or [])}
        return None
    monkeypatch.setattr(hp, "_kubectl_json", fake)


def _view(monkeypatch, nodes, pods, count=1):
    monkeypatch.setattr(hp, "cluster_view", lambda **kw: (nodes, pods))
    monkeypatch.setattr(hp, "describe_group", lambda c, g: ({"CurrentCount": count, "TargetCount": count}, ""))


# ── free_gpus reports pod slots ───────────────────────────────────────────────

def test_free_gpus_reports_pod_slots_from_allocatable_pods():
    row = hp.free_gpus([_node()], system_pods())[0]
    assert row["pods_allocatable"] == 29 and row["pods_used"] == 28 and row["pod_slots_free"] == 1
    assert row["free"] == 1, "a GPU is free"


def test_node_without_allocatable_pods_is_not_enforced():
    row = hp.annotate_fit(hp.free_gpus([_node(max_pods=None)], system_pods()), 1, [], True, set())[0]
    assert row["pod_slots_free"] is None and row["slot_fit"] is True


# ── the exact 29/29 case ──────────────────────────────────────────────────────

def test_29_of_29_with_a_free_gpu_is_refused(monkeypatch):
    pods = system_pods(28) + [_pod("other-0", ns="default")]   # 29/29, GPU still free
    _view(monkeypatch, [_node()], pods)
    _kubectl_objects(monkeypatch)
    for source in ("s3", "huggingface"):
        rc, out = hp.rollout_capacity("c", "default", "neat-transformer-classifier", ITYPE, 1, source, "new")
        assert rc == 3 and out["schedulable"] is False and out["limit"] == "pod-slots"
        n = out["nodes"][0]
        assert n["free"] == 1 and n["pod_slots_free"] == 0
        assert "pod slot" in out["reason"] and "prefix delegation" in out["fix"]


def test_owner_case_28_of_29_s3_needs_the_mountpoint_slot(monkeypatch):
    """28 system pods: one slot left. The model pod alone fits, its Mountpoint-S3
    pod does not -> refuse, naming the ContainerCreating / FailedMount outcome."""
    _view(monkeypatch, [_node()], system_pods(28))
    _kubectl_objects(monkeypatch)
    rc, out = hp.rollout_capacity("c", "default", "neat-transformer-classifier", ITYPE, 1, "s3", "new")
    assert rc == 3 and out["limit"] == "pod-slots"
    assert out["nodes"][0]["pod_slots_needed"] == 2
    assert "Mountpoint-S3" in out["reason"] and "ContainerCreating" in out["reason"]
    assert all(k in out["fix"] for k in ("instance group", "free a pod slot", "max-pods"))


def test_s3_vs_non_s3_differ_by_the_mountpoint_slot(monkeypatch):
    _view(monkeypatch, [_node()], system_pods(28))
    _kubectl_objects(monkeypatch)
    rc_hf, out_hf = hp.rollout_capacity("c", "default", "p", ITYPE, 1, "huggingface", "new")
    rc_s3, _ = hp.rollout_capacity("c", "default", "p", ITYPE, 1, "s3", "new")
    assert rc_hf == 0 and out_hf["schedulable"] is True and out_hf["nodes"][0]["pod_slots_needed"] == 1
    assert rc_s3 == 3


def test_max_pods_is_read_from_the_node_not_a_table(monkeypatch):
    """Same instance type, a node reporting a higher max-pods (e.g. prefix
    delegation): the verdict follows allocatable.pods."""
    _view(monkeypatch, [_node(max_pods=49)], system_pods(28))
    _kubectl_objects(monkeypatch)
    rc, out = hp.rollout_capacity("c", "default", "p", ITYPE, 1, "s3", "new")
    assert rc == 0 and out["nodes"][0]["pod_slots_free"] == 21


def test_gpu_shortage_still_reports_gpus_as_the_limit(monkeypatch):
    _view(monkeypatch, [_node()], system_pods(20) + [_pod("busy", ns="default", gpus=1)])
    _kubectl_objects(monkeypatch)
    rc, out = hp.rollout_capacity("c", "default", "p", ITYPE, 1, "s3", "new")
    assert rc == 3 and out["limit"] == "gpus" and "free GPU" in out["reason"]


# ── an existing Mountpoint pod for the volume is reused ───────────────────────

def test_rollout_surge_reuses_the_running_mountpoint_pod(monkeypatch):
    """Rollout: the serving pod and its Running mp pod are on the node; the surge
    pod mounts the same PV, so it needs ONE slot, not two."""
    pods = system_pods(26) + [_serving(), _mp_pod()]                 # 28/29 used
    _view(monkeypatch, [_node(gpus=4)], pods)
    _kubectl_objects(monkeypatch)
    rc, out = hp.rollout_capacity("c", "default", "neat-transformer-classifier", ITYPE, 1, "s3")
    assert out["s3_volumes"] == [PV]
    assert rc == 0 and out["nodes"][0]["pod_slots_needed"] == 1


def test_mountpoint_pod_for_another_volume_does_not_count(monkeypatch):
    pods = system_pods(26) + [_serving(), _mp_pod(volume="inference-s3-pv-someone-else-inf")]
    _view(monkeypatch, [_node(gpus=4)], pods)
    _kubectl_objects(monkeypatch)
    rc, out = hp.rollout_capacity("c", "default", "neat-transformer-classifier", ITYPE, 1, "s3")
    assert rc == 3 and out["nodes"][0]["pod_slots_needed"] == 2 and out["limit"] == "pod-slots"


def test_pending_mountpoint_pod_does_not_count_as_existing(monkeypatch):
    pods = system_pods(27) + [_serving(), _mp_pod(phase="Pending")]
    _view(monkeypatch, [_node(gpus=4)], pods)
    _kubectl_objects(monkeypatch)
    rc, out = hp.rollout_capacity("c", "default", "neat-transformer-classifier", ITYPE, 1, "s3")
    assert rc == 3 and out["nodes"][0]["pod_slots_needed"] == 2


def test_schedulable_with_a_risky_gpu_node_is_flagged(monkeypatch):
    nodes = [_node(), _node("hyperpod-i-0b7347514f606d999")]
    pods = system_pods(28) + system_pods(10, "hyperpod-i-0b7347514f606d999")
    _view(monkeypatch, nodes, pods)
    _kubectl_objects(monkeypatch)
    rc, out = hp.rollout_capacity("c", "default", "p", ITYPE, 1, "s3", "new")
    assert rc == 0 and out["at_risk_nodes"] == [NODE]


# ── the other schedulability callers ──────────────────────────────────────────

class _Fake:
    def __init__(self, nodes, pods):
        self.nodes, self.pods = nodes, pods

    def __call__(self, cmd, timeout=120):
        if cmd[:3] == ["kubectl", "get", "nodes"]:
            return 0, json.dumps({"items": self.nodes}), ""
        if cmd[:3] == ["kubectl", "get", "pods"]:
            return 0, json.dumps({"items": self.pods}), ""
        return 1, "", "NotFound"


ENV = {"HP_CLUSTER_NAME": "zz-hp", "HP_NAMESPACE": "default", "PROJECT_NAME": "neat-transformer-classifier",
       "AWS_REGION": "us-west-2"}


def test_add_pod_contract_blocks_on_pod_slots_and_warns_with_surge(monkeypatch):
    monkeypatch.setattr(hp, "_run", _Fake([_node()], system_pods(28)))
    out = hp.contract("add-pod", {"gpus": 1}, dict(ENV))
    f = [x for x in out["findings"] if x["check"] == "pod-slots"]
    assert out["blocked"] and f and f[0]["severity"] == "block" and "Mountpoint-S3" in f[0]["message"]
    assert out["resolved"]["nodes"][0]["pod_slots_free"] == 1
    monkeypatch.setattr(hp, "_run", _Fake([_node()], system_pods(28)))
    out = hp.contract("add-pod", {"gpus": 1, "allow_surge": True}, dict(ENV))
    assert [x for x in out["findings"] if x["check"] == "pod-slots"][0]["severity"] == "warn"


def test_add_pod_contract_passes_with_two_slots(monkeypatch):
    monkeypatch.setattr(hp, "_run", _Fake([_node()], system_pods(27)))
    out = hp.contract("add-pod", {"gpus": 1}, dict(ENV))
    free = [x for x in out["findings"] if x["check"] == "free-gpus"]
    assert free and free[0]["severity"] == "info" and "pod slot" in free[0]["message"]


def test_train_pick_group_refuses_a_full_node(monkeypatch):
    rows = hp._node_rows([_node(gpus=4)], system_pods(28) + [_pod("other", ns="default")])
    choice, reason = hp.pick_group(rows, gpus=1)
    assert choice is None and reason.startswith(hp.PICK_SLOT_FULL)


def test_validate_preflight_reports_pod_slots_capped_at_warn(monkeypatch):
    monkeypatch.setattr(hp, "_run", _Fake([_node()], system_pods(28)))
    _view(monkeypatch, [_node()], system_pods(28))
    env = dict(ENV, HP_INSTANCE_TYPE=ITYPE, HP_GPU_COUNT="1", STAGED_MODEL_PATH="s3://zz-core/models/m/")
    out = hp.preflight_from_env(env)
    f = [x for x in out["findings"] if x["check"] == "pod-slots"]
    assert f and f[0]["severity"] == "warn"
    assert all(x["severity"] != "block" for x in out["findings"])


def test_cli_prints_pod_slots_per_node(monkeypatch, capsys):
    _view(monkeypatch, [_node()], system_pods(28))
    _kubectl_objects(monkeypatch)
    rc = hp._cli(["rollout-capacity", "--cluster", "c", "--namespace", "default", "--project", "p",
                  "--instance-type", ITYPE, "--gpus", "1", "--model-source", "s3", "--purpose", "new"])
    cap = capsys.readouterr()
    assert rc == 3 and json.loads(cap.out)["nodes"][0]["pod_slots_free"] == 1
    assert "pod slots 1/29 free (needs 2)" in cap.err


# ── do/status / do/logs diagnosis ─────────────────────────────────────────────

def test_mount_diagnose_surfaces_the_mountpoint_failed_scheduling(monkeypatch):
    model = _serving()
    model["status"] = {"phase": "Pending", "containerStatuses": [
        {"name": "vllm", "state": {"waiting": {"reason": "ContainerCreating"}}}]}
    mp = _mp_pod(phase="Pending")
    events = {
        model["metadata"]["name"]: [{"reason": "FailedMount", "message":
                                     "MountVolume.SetUp failed for volume \"inference-s3-pv\" : rpc error: "
                                     "Failed to wait for Mountpoint Pod mp-r5w6b to be ready (s3.csi.aws.com)"}],
        "mp-r5w6b": [{"reason": "FailedScheduling", "message":
                      "0/5 nodes are available: 1 Too many pods, 4 node(s) didn't match Pod's node affinity."}],
    }
    _kubectl_objects(monkeypatch, events=events, pods_by_selector=[model], all_pods=system_pods() + [mp])
    rep = hp.mount_diagnose("default", "app=neat-transformer-classifier")
    assert len(rep["stuck"]) == 1
    s = rep["stuck"][0]
    assert s["node"] == NODE and s["mountpoint_pods"][0]["name"] == "mp-r5w6b"
    assert "Too many pods" in s["mountpoint_pods"][0]["failed_scheduling"][0]
    notes = "\n".join(hp.mount_diagnose_notes(rep))
    assert "Too many pods" in notes and "prefix delegation" in notes


def test_mount_diagnose_ignores_running_pods(monkeypatch):
    _kubectl_objects(monkeypatch, pods_by_selector=[_serving()])
    assert hp.mount_diagnose("default", "app=x") == {"stuck": []}
