# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 10 (ADR-014 R3, R4, R2.5, R8.3): the realtime scale-to-zero mechanism.

Runs the REAL templates/do/lib/scale-to-zero.sh (and endpoint-config.sh) under
/bin/bash (3.2 on macOS) against a stub ``aws`` that logs every argv (the
``stz_sandbox`` fixture in conftest.py). Nothing here talks to AWS.

The botocore model check of the same captured calls lives in
test_aws_cli_flags.py (R8.4).
"""
from __future__ import annotations

import json
import re

import pytest

IC = "stz-default-1700000000"
RID = f"inference-component/{IC}"
DIM = "sagemaker:inference-component:DesiredCopyCount"
STEP_ARN = "arn:aws:autoscaling:us-east-1:111122223333:scalingPolicy:x:resource/sagemaker/" + RID + ":policyName/" + IC + "-stz-wake"


def _op(call):
    return f"{call[0]} {call[1]}"


def _flag(call, name):
    return call[call.index(name) + 1]


def _setup_rules(sb, fail_at=None):
    """Stub responses for a successful setup; ``fail_at`` makes one op fail."""
    rules = []
    if fail_at:
        rules.append({"match": fail_at.split(), "rc": 254,
                      "stderr": "An error occurred (AccessDeniedException) when calling the X operation: denied\n"})
    rules.append({"match": ["put-scaling-policy", "StepScaling"], "stdout": STEP_ARN + "\n"})
    sb.rules(rules)


def test_setup_makes_exactly_the_documented_calls(stz_sandbox):
    sb = stz_sandbox
    _setup_rules(sb)
    rc, out, err = sb.run(f'SCALE_MAX_CAPACITY=2\nstz_setup realtime-inference "{IC}"')
    assert rc == 0, out + err
    calls = sb.calls()
    assert [_op(c) for c in calls] == [
        "application-autoscaling register-scalable-target",
        "application-autoscaling put-scaling-policy",
        "application-autoscaling put-scaling-policy",
        "cloudwatch put-metric-alarm",
    ]
    reg, tt, step, alarm = calls
    assert reg == ["application-autoscaling", "register-scalable-target",
                   "--service-namespace", "sagemaker", "--resource-id", RID,
                   "--scalable-dimension", DIM, "--min-capacity", "0", "--max-capacity", "2",
                   "--region", "us-east-1"]
    assert _flag(tt, "--policy-type") == "TargetTrackingScaling"
    assert json.loads(_flag(tt, "--target-tracking-scaling-policy-configuration")) == {
        "PredefinedMetricSpecification": {"PredefinedMetricType": "SageMakerInferenceComponentInvocationsPerCopy"},
        "TargetValue": 1, "ScaleInCooldown": 300, "ScaleOutCooldown": 300}
    assert _flag(step, "--policy-type") == "StepScaling"
    step_cfg = json.loads(_flag(step, "--step-scaling-policy-configuration"))
    assert step_cfg["AdjustmentType"] == "ExactCapacity", "ADR-014 §4: ExactCapacity, not ChangeInCapacity"
    assert step_cfg["StepAdjustments"] == [{"MetricIntervalLowerBound": 0, "ScalingAdjustment": 1}]
    for c in (tt, step):
        assert _flag(c, "--resource-id") == RID and _flag(c, "--scalable-dimension") == DIM
        assert _flag(c, "--service-namespace") == "sagemaker"
    assert _flag(alarm, "--metric-name") == "NoCapacityInvocationFailures", "wake signal from the descriptor"
    assert _flag(alarm, "--namespace") == "AWS/SageMaker"
    assert _flag(alarm, "--alarm-actions") == STEP_ARN, "the alarm fires the step policy"
    assert _flag(alarm, "--dimensions") == f"Name=InferenceComponentName,Value={IC}"
    assert _flag(alarm, "--comparison-operator") == "GreaterThanOrEqualToThreshold"
    assert _flag(alarm, "--threshold") == "1"
    assert 'SCALE_TO_ZERO_STATUS="ok"' in sb.config()
    # R4.2: every created resource is recorded
    adds = [m for m in sb.manifest_calls() if m.startswith("add ")]
    types = [re.search(r"--type (\S+)", m).group(1) for m in adds]
    assert types == ["application-autoscaling-scalable-target", "application-autoscaling-scaling-policy",
                     "application-autoscaling-scaling-policy", "cloudwatch-alarm"]


def test_setup_registers_every_ic_passed(stz_sandbox):
    sb = stz_sandbox
    _setup_rules(sb)
    rc, out, err = sb.run('stz_setup realtime-inference ic-one ic-two')
    assert rc == 0, out + err
    regs = [c for c in sb.calls() if c[1] == "register-scalable-target"]
    assert [_flag(c, "--resource-id") for c in regs] == ["inference-component/ic-one", "inference-component/ic-two"]
    assert [_flag(c, "--max-capacity") for c in regs] == ["1", "1"], "default SCALE_MAX_CAPACITY is 1"


@pytest.mark.parametrize("fail_at, created_before", [
    ("register-scalable-target", []),
    ("TargetTrackingScaling", ["target"]),
    ("StepScaling", ["tracking", "target"]),
    ("put-metric-alarm", ["step", "tracking", "target"]),
])
def test_failure_rolls_back_and_exits_5(stz_sandbox, fail_at, created_before):
    sb = stz_sandbox
    _setup_rules(sb, fail_at=fail_at)
    rc, out, err = sb.run(f'stz_setup realtime-inference "{IC}"')
    assert rc == 5, out + err
    assert "Scale-to-zero setup failed at: aws" in err
    assert "IAM: the deploying principal needs" in err
    assert re.search(r"application-autoscaling:|cloudwatch:PutMetricAlarm", err)
    assert 'SCALE_TO_ZERO_STATUS="failed"' in sb.config()
    calls = sb.calls()
    first_fail = next(i for i, c in enumerate(calls) if all(m in " ".join(c) for m in fail_at.split()))
    rollback = calls[first_fail + 1:]
    kinds = []
    for c in rollback:
        if c[1] == "delete-alarms":
            kinds.append("alarm")
        elif c[1] == "delete-scaling-policy":
            kinds.append("step" if _flag(c, "--policy-name").endswith("-stz-wake") else "tracking")
        elif c[1] == "deregister-scalable-target":
            kinds.append("target")
        else:
            pytest.fail(f"unexpected call after the failure: {c}")
    assert kinds == created_before, "rollback deletes exactly what was created, newest first"


def test_teardown_order_and_idempotence(stz_sandbox):
    sb = stz_sandbox
    rc, out, err = sb.run(f'stz_teardown realtime-inference "{IC}"')
    assert rc == 0, out + err
    ops = [(c[1], c[c.index("--policy-name") + 1] if "--policy-name" in c else "") for c in sb.calls()]
    assert ops == [("delete-alarms", ""), ("delete-scaling-policy", f"{IC}-stz-wake"),
                   ("delete-scaling-policy", f"{IC}-stz-tracking"), ("deregister-scalable-target", "")]
    # Second run: everything is already gone -> still success ("not found" = removed).
    sb.reset_logs()
    sb.rules([
        {"match": ["delete-alarms"], "rc": 254, "stderr": "An error occurred (ResourceNotFound) when calling the DeleteAlarms operation\n"},
        {"match": ["delete-scaling-policy"], "rc": 254, "stderr": "An error occurred (ObjectNotFoundException) when calling the DeleteScalingPolicy operation: No scaling policy found\n"},
        {"match": ["deregister-scalable-target"], "rc": 254, "stderr": "An error occurred (ObjectNotFoundException) when calling the DeregisterScalableTarget operation: No scalable target found\n"},
    ])
    rc, out, err = sb.run(f'stz_teardown realtime-inference "{IC}"')
    assert rc == 0, out + err
    assert len(sb.calls()) == 4
    assert "Could not delete" not in err


def test_teardown_reports_a_real_failure(stz_sandbox):
    sb = stz_sandbox
    sb.rules([{"match": ["deregister-scalable-target"], "rc": 254, "stderr": "AccessDeniedException\n"}])
    rc, out, err = sb.run(f'stz_teardown realtime-inference "{IC}"')
    assert rc == 1
    assert "Could not delete scale-to-zero target" in err


def test_teardown_if_owned_makes_no_call_when_never_enabled(stz_sandbox):
    sb = stz_sandbox
    rc, out, err = sb.run(f'stz_teardown_if_owned realtime-inference "{IC}"')
    assert rc == 0 and sb.calls() == [], "default-off projects make no extra AWS call on clean"
    rc, out, err = sb.run(f'SCALE_TO_ZERO_STATUS=failed\nstz_teardown_if_owned realtime-inference "{IC}"')
    assert rc == 0 and len(sb.calls()) == 4


def _variant(sb, prelude):
    """Run create_endpoint_config and return the --production-variants argument."""
    sb.reset_logs()
    rc, out, err = sb.run(prelude + '\nINSTANCE_TYPE=ml.g5.xlarge\nROLE_ARN=arn:aws:iam::111122223333:role/r\n'
                          'source "${SCRIPT_DIR}/lib/endpoint-config.sh"\ncreate_endpoint_config')
    assert rc == 0, out + err
    (call,) = [c for c in sb.calls() if c[1] == "create-endpoint-config"]
    return _flag(call, "--production-variants")


def test_default_off_variant_json_is_byte_identical(stz_sandbox):
    sb = stz_sandbox
    baseline = _variant(sb, 'unset -f stz_variant_scaling_json')  # as if the lib did not exist
    assert "ManagedInstanceScaling" not in baseline
    assert _variant(sb, ':') == baseline, "lib sourced, not opted in"
    assert _variant(sb, 'SCALE_TO_ZERO=false; STZ_ACTIVE=false') == baseline
    assert _variant(sb, 'SCALE_TO_ZERO=true') == baseline, "SCALE_TO_ZERO alone (no STZ_ACTIVE) changes nothing"
    on = _variant(sb, 'STZ_ACTIVE=true; SCALE_MAX_CAPACITY=3')
    variant = json.loads(on)[0]
    assert variant["ManagedInstanceScaling"] == {"Status": "ENABLED", "MinInstanceCount": 0, "MaxInstanceCount": 3}
    del variant["ManagedInstanceScaling"]
    assert variant == json.loads(baseline)[0], "the block is the only difference"


def test_plan_prints_the_calls_and_makes_none(stz_sandbox):
    sb = stz_sandbox
    rc, out, err = sb.run('SCALE_MAX_CAPACITY=2\nstz_plan realtime-inference')
    assert rc == 0, out + err
    assert sb.calls() == [], "--dry-run plan makes no AWS call"
    assert sb.manifest_calls() == []
    for needle in ("register-scalable-target", "TargetTrackingScaling", "StepScaling",
                   "ExactCapacity", "put-metric-alarm", "NoCapacityInvocationFailures",
                   '"MinInstanceCount":0', '"MaxInstanceCount":2'):
        assert needle in out, needle


# ── R2.5: in-place reconfigure on a live endpoint ─────────────────────────────

def _live_rules(min_instances, desired_copies="1"):
    return [
        {"match": ["sts", "get-caller-identity", "Account"], "stdout": "111122223333\n"},
        {"match": ["list-inference-components"], "stdout": IC + "\n"},
        {"match": ["describe-endpoint-config", "MinInstanceCount"], "stdout": f"{min_instances}\n"},
        {"match": ["describe-inference-component", "DesiredCopyCount"], "stdout": f"{desired_copies}\n"},
        {"match": ["describe-inference-component", "InferenceComponentStatus"], "stdout": "InService\n"},
        {"match": ["put-scaling-policy", "StepScaling"], "stdout": STEP_ARN + "\n"},
    ]


def _live_config(sb, on):
    sb.write("do/config", "\n".join([
        'export PROJECT_NAME="stz"',
        'export DEPLOYMENT_TARGET="realtime-inference"',
        'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
        'export SMAI_ENDPOINT_NAME="stz-endpoint-1"',
        'export SMAI_INSTANCE_TYPE="ml.g5.xlarge"',
        'export ENDPOINT_CONFIG_NAME="stz-epc-old"',
        f'export INFERENCE_COMPONENT_NAME="{IC}"',
        'export ROLE_ARN="arn:aws:iam::111122223333:role/r"',
        f'export SCALE_TO_ZERO="{"true" if on else "false"}"',
        'export SCALE_MAX_CAPACITY="2"',
        f'export SCALE_TO_ZERO_STATUS="{"" if on else "ok"}"',
        '']))


def test_reconfigure_on_updates_the_endpoint_then_registers(stz_sandbox):
    sb = stz_sandbox
    _live_config(sb, on=True)
    sb.rules(_live_rules(min_instances="None"))
    rc, out, err = sb.run('_update_config() { _update_config_var "$1" "$2"; }\nstz_reconfigure_live realtime-inference')
    assert rc == 0, out + err
    ops = [_op(c) for c in sb.calls() if c[0] != "sts"]
    assert ops == [
        "sagemaker list-inference-components",
        "sagemaker describe-endpoint-config",
        "sagemaker create-endpoint-config",
        "sagemaker update-endpoint",
        "sagemaker wait",
        "sagemaker delete-endpoint-config",
        "application-autoscaling register-scalable-target",
        "application-autoscaling put-scaling-policy",
        "application-autoscaling put-scaling-policy",
        "cloudwatch put-metric-alarm",
    ]
    create = next(c for c in sb.calls() if c[1] == "create-endpoint-config")
    assert json.loads(_flag(create, "--production-variants"))[0]["ManagedInstanceScaling"]["MinInstanceCount"] == 0
    delete = next(c for c in sb.calls() if c[1] == "delete-endpoint-config")
    assert _flag(delete, "--endpoint-config-name") == "stz-epc-old", "the replaced MLCC-owned config is removed"
    assert 'SCALE_TO_ZERO_STATUS="ok"' in sb.config()


def test_reconfigure_on_is_idempotent_on_the_endpoint_config(stz_sandbox):
    sb = stz_sandbox
    _live_config(sb, on=True)
    sb.rules(_live_rules(min_instances="0"))
    rc, out, err = sb.run('stz_reconfigure_live realtime-inference')
    assert rc == 0, out + err
    ops = [c[1] for c in sb.calls()]
    assert "update-endpoint" not in ops and "create-endpoint-config" not in ops


def test_reconfigure_off_removes_scaling_and_restores_the_floor(stz_sandbox):
    sb = stz_sandbox
    _live_config(sb, on=False)
    sb.rules(_live_rules(min_instances="0", desired_copies="0"))
    rc, out, err = sb.run('stz_reconfigure_live realtime-inference')
    assert rc == 0, out + err
    ops = [_op(c) for c in sb.calls() if c[0] != "sts"]
    assert ops[:5] == [
        "sagemaker list-inference-components",
        "cloudwatch delete-alarms",
        "application-autoscaling delete-scaling-policy",
        "application-autoscaling delete-scaling-policy",
        "application-autoscaling deregister-scalable-target",
    ], "scaling resources go first"
    restore = next(c for c in sb.calls() if c[1] == "update-inference-component-runtime-config")
    assert _flag(restore, "--desired-runtime-config") == "CopyCount=1"
    create = next(c for c in sb.calls() if c[1] == "create-endpoint-config")
    assert "ManagedInstanceScaling" not in _flag(create, "--production-variants")
    assert ops.index("sagemaker update-inference-component-runtime-config") < ops.index("sagemaker update-endpoint")
    assert 'SCALE_TO_ZERO_STATUS=""' in sb.config()
    assert "fixed floor of 1 copy on 1 instance" in out


def test_reconfigure_refuses_an_endpoint_without_ics(stz_sandbox):
    sb = stz_sandbox
    _live_config(sb, on=True)
    rules = [r for r in _live_rules("None") if "list-inference-components" not in r["match"]]
    sb.rules(rules)
    rc, out, err = sb.run('stz_reconfigure_live realtime-inference')
    assert rc == 3, out + err
    assert "does not use inference components" in out
    assert not [c for c in sb.calls() if c[0] in ("application-autoscaling", "cloudwatch")]
    assert not [c for c in sb.calls() if c[1] in ("create-endpoint-config", "update-endpoint")]


def test_reconfigure_on_update_failure_is_exit_5_and_endpoint_unchanged(stz_sandbox):
    sb = stz_sandbox
    _live_config(sb, on=True)
    sb.rules([{"match": ["update-endpoint"], "rc": 254, "stderr": "ValidationException\n"}] + _live_rules("None"))
    rc, out, err = sb.run('stz_reconfigure_live realtime-inference')
    assert rc == 5, out + err
    assert "NOT enabled" in err
    assert not [c for c in sb.calls() if c[0] == "application-autoscaling"], "no scaling resource without the variant"


# ── R4.2: do/clean (clean.d/realtime-inference, rendered) ─────────────────────

def _render(sb, rel, dest):
    """Render an EJS do/ template into the sandbox (as generation does)."""
    import os
    import shutil
    import subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available to render the EJS template")
    repo = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    js = ("const ejs=require('ejs'),fs=require('fs');"
          "process.stdout.write(ejs.render(fs.readFileSync(process.argv[1],'utf8'),"
          "{deploy_mode:'build',enableLora:false,includeBenchmark:false,serverEnvVars:{},existingEndpointName:''}));")
    out = subprocess.run([node, "-e", js, os.path.join(repo, "templates", "do", rel)],
                         cwd=repo, capture_output=True, text=True, check=True).stdout
    return sb.write(dest, out, 0o755)


def _clean_sandbox(sb, scale_to_zero):
    sb.write("do/lib/profile.sh", "# stub profile.sh\n")
    sb.write("bin/sleep", "#!/bin/bash\nexit 0\n", 0o755)  # skip the 15 s IC-deletion pause
    sb.write("do/config", "\n".join([
        'export PROJECT_NAME="stz"',
        'export ENDPOINT_NAME="stz-endpoint-1"',
        'export ENDPOINT_CONFIG_NAME="stz-epc-1"',
        f'export INFERENCE_COMPONENT_NAME="{IC}"',
        f'export SCALE_TO_ZERO="{scale_to_zero}"',
        'export SCALE_TO_ZERO_STATUS="ok"' if scale_to_zero == "true" else 'export SCALE_TO_ZERO_STATUS=""',
        '']))
    return _render(sb, "clean.d/realtime-inference", "do/clean.d/realtime-inference")


def _run_clean(sb, script):
    import os
    import subprocess
    env = dict(os.environ, PATH=os.path.join(sb.root, "bin") + os.pathsep + os.environ["PATH"],
               STZ_SANDBOX=sb.root, AWS_REGION="us-east-1", TMPDIR=sb.root)
    env.pop("AWS_PROFILE", None)
    r = subprocess.run(["/bin/bash", script, "endpoint", "--force"], cwd=sb.root, env=env,
                       capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout, r.stderr


def test_clean_removes_scaling_resources_before_the_ic_and_endpoint(stz_sandbox):
    sb = stz_sandbox
    script = _clean_sandbox(sb, "true")
    sb.rules([{"match": ["sts", "Account"], "stdout": "111122223333\n"}])
    rc, out, err = _run_clean(sb, script)
    assert rc == 0, out + err
    ops = [c[1] for c in sb.calls() if c[0] != "sts"]
    order = ["delete-alarms", "delete-scaling-policy", "deregister-scalable-target",
             "delete-inference-component", "delete-endpoint"]
    idx = [ops.index(o) for o in order]
    assert idx == sorted(idx), f"clean order: {ops}"
    assert ops.count("delete-scaling-policy") == 2
    assert 'SCALE_TO_ZERO_STATUS=""' in sb.config()
    assert any(m.startswith("delete --id cloudwatch:us-east-1:alarm/") for m in sb.manifest_calls())


def test_clean_is_idempotent_when_scaling_resources_are_already_gone(stz_sandbox):
    sb = stz_sandbox
    script = _clean_sandbox(sb, "true")
    sb.rules([
        {"match": ["sts", "Account"], "stdout": "111122223333\n"},
        {"match": ["delete-alarms"], "rc": 254, "stderr": "An error occurred (ResourceNotFound)\n"},
        {"match": ["delete-scaling-policy"], "rc": 254, "stderr": "An error occurred (ObjectNotFoundException)\n"},
        {"match": ["deregister-scalable-target"], "rc": 254, "stderr": "An error occurred (ObjectNotFoundException)\n"},
    ])
    rc, out, err = _run_clean(sb, script)
    assert rc == 0, out + err
    assert "could not be removed" not in out + err
    assert "delete-endpoint" in [c[1] for c in sb.calls()]


def test_clean_makes_no_scaling_call_when_never_enabled(stz_sandbox):
    sb = stz_sandbox
    script = _clean_sandbox(sb, "false")
    sb.rules([{"match": ["sts", "Account"], "stdout": "111122223333\n"}])
    rc, out, err = _run_clean(sb, script)
    assert rc == 0, out + err
    assert not [c for c in sb.calls() if c[0] in ("application-autoscaling", "cloudwatch")]


# ── R5 / R6: the warning, its single data file, do/status, the cost caveat ────

import os  # noqa: E402

import scale_to_zero  # noqa: E402
import target_manifest  # noqa: E402

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))


def test_warning_wording_is_driven_by_requests_at_zero():
    for target in target_manifest.list_targets():
        text = "\n".join(scale_to_zero.warning_lines(target))
        assert "not for interactive SLAs" in text
        assert "Your model and instance were not measured." in text
        at_zero = scale_to_zero.capability(target)["requests_at_zero"]
        if at_zero == "fail":
            assert "requests FAIL until a copy is ready" in text, target
        elif at_zero == "queued":
            assert "QUEUED" in text and "FAIL" not in text, target


def test_warning_numbers_come_only_from_the_reference_file(tmp_path):
    ref = scale_to_zero.reference()
    for key in ("source", "date", "model", "instance", "engine", "region",
                "recovery_mean_minutes", "breakdown_minutes"):
        assert ref.get(key) not in (None, "", []), f"reference.{key} (provenance) is required"
    fake = dict(ref, recovery_mean_minutes=42.4, runs_minutes=[40.0, 44.8],
                breakdown_minutes=[{"phase": "p1", "minutes": 40.0}, {"phase": "p2", "minutes": 2.4}],
                date="1999-01")
    path = tmp_path / "ref.json"
    path.write_text(json.dumps(fake))
    text = "\n".join(scale_to_zero.warning_lines("realtime-inference", scale_to_zero.reference(str(path))))
    assert "42.4 min mean" in text and "40.0 p1" in text and "1999-01" in text
    assert str(ref["recovery_mean_minutes"]) not in text, "no figure is hardcoded in the helper"


def test_no_script_repeats_the_reference_figures():
    """R5.2 grep guard: the mean recovery appears only in the data file."""
    mean = str(scale_to_zero.reference()["recovery_mean_minutes"])
    offenders = []
    for root in (os.path.join(_REPO, "templates"), os.path.join(_REPO, "src")):
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if name == "scale_to_zero_reference.json":
                    continue
                path = os.path.join(dirpath, name)
                try:
                    text = open(path, encoding="utf-8").read()
                except (UnicodeDecodeError, OSError):
                    continue
                if re.search(r"(?<![\d.])" + re.escape(mean) + r"(?![\d])", text):
                    offenders.append(os.path.relpath(path, _REPO))
    assert not offenders, f"{mean} repeated outside the data file: {offenders}"


def test_cost_caveat_extension_only_when_on_for_an_enabled_target():
    import pricing
    targets = target_manifest.list_targets()
    enabled = [t for t in targets if scale_to_zero.capability(t)["enabled"]]
    disabled = [t for t in targets if not scale_to_zero.capability(t)["enabled"]]
    assert enabled and disabled
    for t in enabled:
        line = pricing.scale_to_zero_caveat(t, "true")
        assert "idle stretches longer than the scale-in delay" in line
        assert "No idle-adjusted cost is computed." in line
        assert str(scale_to_zero.reference()["recovery_mean_minutes"]) in line
        assert pricing.scale_to_zero_caveat(t, "false") == ""
    for t in disabled:
        assert pricing.scale_to_zero_caveat(t, "true") == ""


def test_cost_summary_lines_appends_the_caveat_after_cost_caveat(monkeypatch):
    import pricing
    target = next(t for t in target_manifest.list_targets() if scale_to_zero.capability(t)["enabled"])
    monkeypatch.setenv("DEPLOYMENT_TARGET", target)
    monkeypatch.setenv("SCALE_TO_ZERO", "false")
    off = pricing.cost_summary_lines([])
    assert off[-1] == pricing.COST_CAVEAT
    monkeypatch.setenv("SCALE_TO_ZERO", "true")
    on = pricing.cost_summary_lines([])
    assert on[:-1] == off and "Scale-to-zero is on" in on[-1]


def _status_sandbox(sb, current_copies):
    import shutil
    shutil.copy(os.path.join(_REPO, "templates", "do", "lib", "script-contract.sh"),
                os.path.join(sb.do, "lib", "script-contract.sh"))
    sb.write("do/config", "\n".join([
        'export PROJECT_NAME="stz"',
        'export DEPLOYMENT_TARGET="realtime-inference"',
        'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
        'export ENDPOINT_NAME="stz-endpoint-1"',
        f'export INFERENCE_COMPONENT_NAME="{IC}"',
        'export SCALE_TO_ZERO="true"',
        'export SCALE_MAX_CAPACITY="2"',
        'export SCALE_TO_ZERO_STATUS="ok"',
        '']))
    sb.rules([
        {"match": ["sts", "Account"], "stdout": "111122223333\n"},
        {"match": ["describe-endpoint"], "stdout": json.dumps({
            "EndpointStatus": "InService",
            "ProductionVariants": [{"CurrentInstanceCount": current_copies, "InstanceType": "ml.g5.xlarge"}]}, indent=2)},
        {"match": ["describe-inference-component"], "stdout": json.dumps({
            "InferenceComponentStatus": "InService",
            "Specification": {"ComputeResourceRequirements": {"NumberOfAcceleratorDevicesRequired": 1}},
            "RuntimeConfig": {"CurrentCopyCount": current_copies, "DesiredCopyCount": current_copies}}, indent=2)},
        {"match": ["describe-scalable-targets"], "stdout": "0\t2\n"},
    ])
    return _render(sb, "status", "do/status")


def _run_status(sb, script):
    import subprocess
    env = dict(os.environ, PATH=os.path.join(sb.root, "bin") + os.pathsep + os.environ["PATH"],
               STZ_SANDBOX=sb.root, AWS_REGION="us-east-1", TMPDIR=sb.root)
    env.pop("AWS_PROFILE", None)
    env.pop("VIRTUAL_ENV", None)
    os.makedirs(os.path.join(sb.root, ".mlcc", "hey-venv", "bin"), exist_ok=True)
    sb.write(".mlcc/hey-venv/bin/activate", "# stub venv\n")
    r = subprocess.run(["/bin/bash", script], cwd=sb.root, env=env, capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout, r.stderr


def test_status_at_zero_shows_the_state_line_and_the_warning(stz_sandbox):
    sb = stz_sandbox
    script = _status_sandbox(sb, 0)
    rc, out, err = _run_status(sb, script)
    assert rc == 0, out + err
    assert "scale-to-zero: on (min 0, max 2); current copies: 0" in out
    assert "requests FAIL until a copy is ready" in out
    assert "0/0" in out, "the Current/Desired copy fields are reused"


def test_status_with_a_copy_shows_the_line_without_the_warning(stz_sandbox):
    sb = stz_sandbox
    script = _status_sandbox(sb, 1)
    rc, out, err = _run_status(sb, script)
    assert rc == 0, out + err
    assert "scale-to-zero: on (min 0, max 2); current copies: 1" in out
    assert "requests FAIL" not in out


def test_plan_lines_are_copy_pasteable_shell(stz_sandbox):
    """R9.1: each planned call round-trips through the shell to the real argv."""
    import shlex
    sb = stz_sandbox
    rc, out, err = sb.run('SCALE_MAX_CAPACITY=2\nstz_plan realtime-inference\n'
                          'exec 9>&1; _STZ_PLAN=1; _stz_aws cloudwatch put-metric-alarm --alarm-description "it\'s {x}"')
    assert rc == 0, out + err
    planned = [shlex.split(line.strip()) for line in out.splitlines() if line.strip().startswith("aws ")]
    assert len(planned) == 5
    step = next(p for p in planned if "StepScaling" in p)
    assert json.loads(step[step.index("--step-scaling-policy-configuration") + 1])["AdjustmentType"] == "ExactCapacity"
    assert planned[-1][-1] == "it's {x}"
