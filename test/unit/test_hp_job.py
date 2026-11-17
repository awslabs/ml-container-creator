# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 11 R4–R6 — the shared HyperPodPyTorchJob substrate (templates/do/lib/python/hp_job.py).

classify() is pure, so every HPPJ quirk the F0 probe saw live is a table row here:
a CrashLoop that never reaches `Failed`, a silent hang that stays `Running`, a
`Failed` HPPJ whose Deployment re-creates the pod, and success ONLY through
_MLCC_RESULT.json. Cluster / S3 calls go through hp_job._run (scripted fake).
"""
import json
import os
import subprocess
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "templates", "do", "lib", "python"))
import hp_job as hj  # noqa: E402

LIMITS = {"main": "mlcc-train", "startup": 1200, "stall": 1800, "deadline": 7200}


def _pod(phase="Running", main_state=None, restarts=0, init_restarts=0, name="j-pod", reason=None):
    st = {"phase": phase,
          "containerStatuses": [{"name": "mlcc-train", "restartCount": restarts,
                                 "state": main_state or ({"running": {}} if phase == "Running" else {"waiting": {}})},
                                {"name": "mlcc-egress", "restartCount": 0, "state": {"running": {}}}],
          "initContainerStatuses": [{"name": "mlcc-fetch", "restartCount": init_restarts, "state": {"terminated": {"exitCode": 0}}}]}
    if reason:
        st["reason"] = reason
    return {"metadata": {"name": name}, "status": st}


def _hppj(*conds):
    return {"status": {"conditions": [{"type": t, "status": "True", "reason": r} for t, r in conds]}}


# ── classify table (R6.1 / R6.2) ─────────────────────────────────────────────

@pytest.mark.parametrize("hppj,pods,result,elapsed,log_age,state,needle", [
    # success only via the result file, never a condition name
    (_hppj(("Running", "")), [_pod()], {"exit_code": 0, "files": 3}, 100, 0, "Succeeded", "exit 0"),
    (_hppj(("Completed", "")), [_pod()], None, 100, 0, "Running", "running"),
    (_hppj(), [_pod()], {"exit_code": 0, "files": 0}, 100, 0, "Failed", "no output"),
    (_hppj(), [_pod()], {"exit_code": 1, "files": 2}, 100, 0, "Failed", "exit 1"),
    (_hppj(), [_pod()], {"exit_code": 3, "files": 0}, 30, 0, "Failed", "precondition"),
    # CrashLoop before hyperpodrun: the HPPJ never goes Failed; restarts catch it
    (_hppj(("PodsRunning", "")), [_pod(phase="Pending", restarts=2)], None, 200, None, "Failed", "crash loop"),
    (_hppj(), [_pod(phase="Pending", init_restarts=3)], None, 200, None, "Failed", "mlcc-fetch"),
    # a silent rank hang stays Running: only the stall timeout ends it
    (_hppj(("Running", "")), [_pod()], None, 4000, 1900, "Failed", "stalled"),
    (_hppj(("Running", "")), [_pod()], None, 4000, 60, "Running", "running"),
    # Failed, then the Deployment re-creates the pod: the condition wins
    (_hppj(("Running", ""), ("Failed", "FailedRetryCount")), [_pod(phase="Pending", name="recreated")], None, 500, None,
     "Failed", "FailedRetryCount"),
    # evicted pod / non-zero main exit
    (_hppj(), [_pod(phase="Failed", reason="Evicted")], None, 500, None, "Failed", "Evicted"),
    (_hppj(), [_pod(main_state={"terminated": {"exitCode": 137}})], None, 500, None, "Failed", "exited 137"),
    # startup timeout / deadline / still pending
    (_hppj(), [_pod(phase="Pending")], None, 1300, None, "Failed", "startup"),
    (_hppj(), [], None, 60, None, "Pending", "waiting"),
    (_hppj(("Running", "")), [_pod()], None, 7300, 10, "Failed", "deadline"),
])
def test_classify(hppj, pods, result, elapsed, log_age, state, needle):
    got_state, reason = hj.classify(hppj, pods, result, 1000.0 + elapsed, 1000.0, log_age, LIMITS)
    assert got_state == state, reason
    assert needle.lower() in reason.lower()


def test_stall_timeout_zero_disables_the_stall_check():
    state, _ = hj.classify(_hppj(), [_pod()], None, 5000.0, 0.0, 99999, dict(LIMITS, stall=0, deadline=0))
    assert state == "Running"


# ── inputs ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value,ok", [("120Gi", True), ("2000Gi", True), ("2001Gi", False), ("0Gi", False),
                                      ("50G", False), ("abc", False), ("", False)])
def test_scratch_size_validation(value, ok):
    if ok:
        assert hj.validate_scratch_size(value) == int(value[:-2])
    else:
        with pytest.raises(hj.UsageError):
            hj.validate_scratch_size(value)


@pytest.mark.parametrize("value,ok", [("0", True), ("1200", True), ("86400", True), ("86401", False), ("-1", False), ("x", False)])
def test_timeout_validation(value, ok):
    if ok:
        assert hj.validate_timeout("--stall-timeout", value) == int(value)
    else:
        with pytest.raises(hj.UsageError):
            hj.validate_timeout("--stall-timeout", value)


def test_scratch_size_from_a_stub_listing(monkeypatch):
    gib = 1024 ** 3
    monkeypatch.setattr(hj, "_run", lambda cmd, timeout=120, stdin=None: (0, json.dumps([8 * gib, 8 * gib]), ""))
    # 16 GiB of weights → ceil(2.5 × 16) = 40 → floored at 50
    assert hj.scratch_gib(hj.s3_prefix_bytes("s3://core/models/org/m/")) == 50
    monkeypatch.setattr(hj, "_run", lambda cmd, timeout=120, stdin=None: (0, json.dumps([30 * gib]), ""))
    assert hj.scratch_gib(hj.s3_prefix_bytes("s3://core/models/org/m/")) == 75
    assert hj.scratch_gib(None, "300Gi") == 300
    with pytest.raises(hj.RenderError):
        hj.scratch_gib(None)


# ── render-train (R4.1–R4.4, R5) ─────────────────────────────────────────────

def _plugin(tmp_path, big=False):
    d = tmp_path / ("sft-big" if big else "sft")
    d.mkdir(parents=True, exist_ok=True)
    (d / "train.py").write_text("print('train')\n")
    (d / "accelerate_config.yaml").write_text("num_processes: 1\n")
    if big:
        (d / "blob.txt").write_text("x" * (hj.CONFIGMAP_MAX_BYTES + 1))
    return str(d)


def _args(tmp_path, **over):
    a = {"project": "proj", "job": "proj-train-1", "namespace": "default", "image": "acct.dkr.ecr/x:tag",
         "group": "grp-a", "gpus": 4, "technique": "sft", "plugin_dir": _plugin(tmp_path),
         "dataset": "s3://core/datasets/d/v1/", "model_uri": "s3://core/models/org/m/", "hf_model_id": "org/m",
         "artifacts_bucket": "art", "region": "us-west-2", "max_runtime": 3600, "scratch": "fsx",
         "storage_class": "", "scratch_size": "", "model_bytes": None, "env": {"FOO": "bar"},
         "hparams": {"learning_rate": 1e-4}, "launcher": "accelerate"}
    a.update(over)
    return a


def test_render_train_manifest_shape(tmp_path):
    cm, hppj = hj.render_train(_args(tmp_path))
    assert cm["kind"] == "ConfigMap" and {"train.py", "accelerate_config.yaml", "launch.py"} <= set(cm["data"])
    assert hppj["apiVersion"] == hj.HPPJ_API and hppj["kind"] == hj.HPPJ_KIND
    for doc in (cm, hppj):
        assert doc["metadata"]["labels"][hj.LABEL_PROJECT] == "proj"
        assert doc["metadata"]["labels"][hj.LABEL_KIND] == "train"
        assert doc["metadata"]["labels"][hj.LABEL_TECHNIQUE] == "sft"
    rp = hppj["spec"]["runPolicy"]
    assert rp["jobMaxRetryCount"] == 0 and rp["activeDeadlineSeconds"] == 3600
    spec = hppj["spec"]["replicaSpecs"][0]
    assert spec["replicas"] == 1
    pod = spec["template"]["spec"]
    assert spec["template"]["metadata"]["labels"][hj.LABEL_JOB] == "proj-train-1"
    assert pod["serviceAccountName"] == hj.SERVICE_ACCOUNT
    assert pod["nodeSelector"] == {hj.GROUP_LABEL: "grp-a"}
    main = next(c for c in pod["containers"] if c["name"] == "mlcc-train")
    assert main["resources"]["limits"] == {"nvidia.com/gpu": 4}
    assert not any("efa" in k for c in pod["containers"] for sec in (c.get("resources") or {}).values() for k in sec)
    env = {e["name"]: e.get("value") for e in main["env"]}
    assert env["NUM_GPUS"] == "4" and env["DATA_DIR"] == "/scratch/data" and env["OUTPUT_DIR"] == "/scratch/output"
    assert env["HF_MODEL_ID"] == "/scratch/model" and env["FOO"] == "bar"
    assert json.loads(env["SM_HPS"]) == {"learning_rate": 1e-4}
    assert "hyperpodrun --nnodes=1 --nproc-per-node=1" in main["command"][2]
    assert "MLCC_PRECONDITION hyperpodrun-missing" in main["command"][2]
    scratch = next(m for m in main["volumeMounts"] if m["name"] == "mlcc-scratch")
    assert scratch == {"name": "mlcc-scratch", "mountPath": "/scratch", "subPath": "mlcc/proj/proj-train-1"}
    names = [c["name"] for c in pod["containers"]] + [c["name"] for c in pod["initContainers"]]
    assert names == ["mlcc-train", "mlcc-egress", "mlcc-fetch"]
    for c in (pod["containers"][1], pod["initContainers"][0]):
        assert c["image"] == hj.AWS_CLI_IMAGE and not c["image"].endswith(":latest")
    egress = pod["containers"][1]["command"][2]
    assert "s3://art/proj/train/proj-train-1/output/" in egress and hj.RESULT_FILE in egress
    assert egress.index("output/") < egress.index(hj.RESULT_FILE), "the result file is written last"


def test_every_rendered_shell_script_parses(tmp_path):
    _, hppj = hj.render_train(_args(tmp_path))
    pod = hppj["spec"]["replicaSpecs"][0]["template"]["spec"]
    for c in pod["containers"] + pod["initContainers"]:
        script = tmp_path / f"{c['name']}.sh"
        script.write_text(c["command"][2])
        assert subprocess.run(["/bin/sh", "-n", str(script)]).returncode == 0, c["name"]


def test_ephemeral_scratch_is_sized_and_never_the_overlay(tmp_path):
    gib = 1024 ** 3
    _, hppj = hj.render_train(_args(tmp_path, scratch="ephemeral", storage_class="gp3", model_bytes=40 * gib))
    vol = next(v for v in hppj["spec"]["replicaSpecs"][0]["template"]["spec"]["volumes"] if v["name"] == "mlcc-scratch")
    req = vol["ephemeral"]["volumeClaimTemplate"]["spec"]
    assert req["storageClassName"] == "gp3" and req["resources"]["requests"]["storage"] == "100Gi"
    with pytest.raises(hj.RenderError):
        hj.render_train(_args(tmp_path / "x", scratch="ephemeral", storage_class="gp3", model_uri=""))


def test_fsx_dataset_mounts_read_only_and_refuses_dotdot(tmp_path):
    _, hppj = hj.render_train(_args(tmp_path, dataset="fsx://shared/sft-v1"))
    main = hppj["spec"]["replicaSpecs"][0]["template"]["spec"]["containers"][0]
    m = next(x for x in main["volumeMounts"] if x["name"] == "mlcc-dataset")
    assert m["readOnly"] is True and m["subPath"] == "shared/sft-v1"
    assert {e["name"]: e.get("value") for e in main["env"]}["DATA_DIR"] == "/mlcc-data"
    with pytest.raises(hj.UsageError):
        hj.render_train(_args(tmp_path / "y", dataset="fsx://a/../b"))


def test_configmap_over_one_mib_is_refused(tmp_path):
    with pytest.raises(hj.RenderError, match="1 MiB"):
        hj.render_train(_args(tmp_path, plugin_dir=_plugin(tmp_path, big=True)))


def test_launcher_clears_the_torchrun_env_and_runs_accelerate(tmp_path):
    (tmp_path / "bin").mkdir()
    rec = tmp_path / "argv.txt"
    stub = tmp_path / "bin" / "accelerate"
    stub.write_text(f"#!/bin/sh\nenv | sort > {tmp_path}/env.txt\necho \"$@\" > {rec}\nexit 7\n")
    stub.chmod(0o755)
    launch = hj.LAUNCH_PY.replace(hj.PLUGIN_MOUNT, str(tmp_path))
    (tmp_path / "launch.py").write_text(launch)
    (tmp_path / "accelerate_config.yaml").write_text("x: 1\n")
    env = dict(os.environ, PATH=f"{tmp_path}/bin:{os.environ['PATH']}", RANK="0", LOCAL_RANK="0",
               WORLD_SIZE="1", MASTER_ADDR="x", MASTER_PORT="1", TORCHELASTIC_RUN_ID="r", NUM_GPUS="4")
    r = subprocess.run([sys.executable, str(tmp_path / "launch.py")], env=env, capture_output=True, text=True)
    assert r.returncode == 7, r.stderr
    argv = rec.read_text().split()
    assert argv[:3] == ["launch", "--num_processes", "4"] and argv[-1].endswith("train.py")
    seen = (tmp_path / "env.txt").read_text()
    for k in ("RANK=", "LOCAL_RANK=", "WORLD_SIZE=", "MASTER_ADDR=", "MASTER_PORT=", "TORCHELASTIC_RUN_ID="):
        assert f"\n{k}" not in "\n" + seen, k


# ── delete / watch actions (R6.3) ────────────────────────────────────────────

class Fake:
    def __init__(self, delete_rc=0, pods_after=None, result=None, hppj=None):
        self.calls = []
        self.delete_rc = delete_rc
        self.pods_after = pods_after if pods_after is not None else []
        self.result = result
        self.hppj = hppj

    def __call__(self, cmd, timeout=120, stdin=None):
        self.calls.append(list(cmd))
        if cmd[:3] == ["kubectl", "delete", "hyperpodpytorchjob"]:
            return (self.delete_rc, "", "" if self.delete_rc == 0 else "Error from server (Forbidden)")
        if cmd[:2] == ["kubectl", "delete"]:
            return 0, "", ""
        if cmd[:3] == ["kubectl", "get", "pods"]:
            return 0, json.dumps({"items": self.pods_after}), ""
        if cmd[:3] == ["kubectl", "get", "hyperpodpytorchjob"]:
            return (0, json.dumps(self.hppj), "") if self.hppj is not None else (1, "", "NotFound")
        if cmd[:3] == ["aws", "s3", "cp"]:
            return (0, json.dumps(self.result), "") if self.result is not None else (1, "", "404")
        if cmd[:2] == ["kubectl", "logs"]:
            return 0, "MLCC_PRECONDITION hyperpodrun-missing: x\nline\n", ""
        return 0, "", ""


def test_delete_failure_exits_2_with_the_manual_command(monkeypatch):
    monkeypatch.setattr(hj, "_run", Fake(delete_rc=1))
    rc, msg = hj.delete_job("j", "default", wait=0)
    assert rc == 2 and "kubectl delete hyperpodpytorchjob j -n default" in msg


def _watch_args(**over):
    a = {"job": "j", "namespace": "default", "artifacts_bucket": "art", "project": "proj", "kind": "train",
         "main": "mlcc-train", "startup": 1200, "stall": 1800, "deadline": 0, "poll": 1}
    a.update(over)
    return a


def test_status_on_success_deletes_the_hppj_and_returns_the_prefix(monkeypatch):
    fake = Fake(result={"exit_code": 0, "files": 4}, hppj=_hppj(("Running", "")))
    monkeypatch.setattr(hj, "_run", fake)
    rc, out = hj.watch(_watch_args(), once=True)
    assert rc == 0 and out["state"] == "Succeeded"
    assert out["artifact_prefix"] == "s3://art/proj/train/j/output"
    assert any(c[:3] == ["kubectl", "delete", "hyperpodpytorchjob"] for c in fake.calls)


def test_status_on_a_failed_hppj_tails_logs_surfaces_preconditions_and_deletes(monkeypatch, capsys):
    fake = Fake(result=None, hppj=_hppj(("Failed", "FailedRetryCount")))
    monkeypatch.setattr(hj, "_run", fake)
    rc, out = hj.watch(_watch_args(), once=True)
    assert rc == 2 and out["state"] == "Failed" and out["precondition"].startswith("MLCC_PRECONDITION")
    assert any(c[:2] == ["kubectl", "logs"] and "--tail=200" in c for c in fake.calls)
    assert any(c[:3] == ["kubectl", "delete", "hyperpodpytorchjob"] for c in fake.calls)
    assert "last 200 log lines" in capsys.readouterr().err


def test_status_is_idempotent_after_the_hppj_is_gone(monkeypatch):
    monkeypatch.setattr(hj, "_run", Fake(result={"exit_code": 0, "files": 1}, hppj=None))
    rc, out = hj.watch(_watch_args(), once=True)
    assert rc == 0 and out["state"] == "Succeeded"


def test_running_job_is_not_deleted_by_status(monkeypatch):
    fake = Fake(result=None, hppj=_hppj(("Running", "")), pods_after=[_pod()])
    monkeypatch.setattr(hj, "_run", fake)
    rc, out = hj.watch(_watch_args(), once=True)
    assert rc == 0 and out["state"] == "Running"
    assert not any(c[:2] == ["kubectl", "delete"] for c in fake.calls)


def test_cli_rejects_bad_timeouts_with_exit_2(monkeypatch):
    monkeypatch.setattr(hj, "_run", Fake())
    assert hj._cli(["status", "--job", "j", "--namespace", "n", "--artifacts-bucket", "b", "--project", "p",
                    "--stall-timeout", "-5"]) == 2
