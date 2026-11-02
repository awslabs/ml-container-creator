# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 11 R10 / R11 — the HP-EKS payload patcher (templates/do/lib/python/hp_payload.py).

Conformance against the CAPTURED live templates only (test/fixtures/hp-eks/, see
SOURCES.json; no fabricated templates): every declared site is found and asserted,
a removed site or a changed original fails loudly naming the site, an injected
GPU-count literal is caught by the post-scan, and the fit / VRAM gates refuse
honestly. Group shapes are parameters, never a frozen SKU.
"""
import copy
import json
import os
import re
import sys

import pytest

yaml = pytest.importorskip("yaml", reason="hp_payload.py needs PyYAML (CI installs requirements.txt)")

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "templates", "do", "lib", "python"))
import hp_job  # noqa: E402
import hp_payload as hpp  # noqa: E402

FIX = os.path.join(_REPO, "test", "fixtures", "hp-eks")
SOURCES = json.load(open(os.path.join(FIX, "SOURCES.json")))
TEMPLATES = sorted(f for f in SOURCES["files"] if f.endswith(".yaml"))


def _load(name):
    tmpl = open(os.path.join(FIX, name)).read()
    op = json.load(open(os.path.join(FIX, name.replace("_payload_template_", "_override_params_").replace(".yaml", ".json"))))
    return tmpl, op


def _args(**over):
    a = {"knobs": {"dataset_max_len": 1024}, "group": "grp-a", "group_gpus": 4, "group_efa": 1,
         "adapt_shape": True, "project": "proj", "job": "proj-tune-1", "namespace": "default",
         "artifacts_bucket": "art", "region": "us-west-2", "dataset_uri": "s3://art/proj/tune/proj-tune-1/input/",
         "model_uri": "s3://core/models/org/m/", "technique": "sft", "max_runtime": 3600}
    a.update(over)
    return a


def _main(out, fam="pytorch"):
    hppj = next(d for d in out["docs"] if d["kind"] == "HyperPodPyTorchJob")
    pod = hppj["spec"]["replicaSpecs"][0]["template"]["spec"]
    return hppj, pod, next(c for c in pod["containers"] if c["name"] == fam)


def _configs(out):
    cm = next(d for d in out["docs"] if d["kind"] == "ConfigMap")
    return {k: yaml.safe_load(v) for k, v in cm["data"].items() if k in ("config.yaml", "verl_config.yaml")}


@pytest.mark.parametrize("name", TEMPLATES)
def test_every_declared_site_is_found_in_the_captured_template(name):
    tmpl, op = _load(name)
    out = hpp.render(tmpl, op, _args(technique=SOURCES["files"][name]["technique"]))
    assert out["family"] == "verl" and out["adapted"] is True
    hppj, pod, main = _main(out)
    env = {e["name"]: e.get("value") for e in main["env"]}
    # always
    assert "JOB_NAME" not in env
    assert env["SCRIPT_PATH"] == "/opt/ml/code/verl_trainer_script.py"
    assert env["SCRIPT_ARGS"].endswith("--config-name=verl_config.yaml")
    assert pod["nodeSelector"] == {hp_job.GROUP_LABEL: "grp-a"}
    assert pod["serviceAccountName"] == hp_job.SERVICE_ACCOUNT
    assert hppj["spec"]["runPolicy"]["jobMaxRetryCount"] == 0
    assert hppj["spec"]["runPolicy"]["activeDeadlineSeconds"] == 3600
    assert "tee /data/training.log" not in main["command"][2] and "/scratch/logs/train.log" in main["command"][2]
    assert [c["name"] for c in pod["containers"]] == ["pytorch", "mlcc-egress"]
    assert [c["name"] for c in pod["initContainers"]] == ["mlcc-fetch"]
    for d in out["docs"]:
        assert d["metadata"]["labels"][hp_job.LABEL_PROJECT] == "proj"
    # shape → the group's allocatable, derived (never a literal)
    assert hppj["spec"]["nprocPerNode"] == "4"
    assert env["CUDA_VISIBLE_DEVICES"] == "0,1,2,3"
    assert env["NTASKS_PER_NODE"] == "4" and env["SLURM_NTASKS_PER_NODE"] == "4"
    assert main["resources"]["limits"] == {"nvidia.com/gpu": 4}
    assert env["PYTORCH_CUDA_ALLOC_CONF"] == "expandable_segments:True"
    cfg = _configs(out)
    assert cfg["verl_config.yaml"]["trainer"]["n_gpus_per_node"] == 4
    assert cfg["config.yaml"]["trainer"]["devices"] == 4
    assert cfg["config.yaml"]["training_config"]["trainer"]["n_gpus_per_node"] == 4
    assert cfg["verl_config.yaml"]["data"]["max_token_len_per_gpu"] == 1024
    assert cfg["verl_config.yaml"]["trainer"]["default_local_dir"] == "/scratch/output"
    assert "{{" not in json.dumps(out["docs"])


@pytest.mark.parametrize("gpus,efa", [(4, 1), (2, 0), (8, 0)])
def test_shape_follows_the_group_and_efa_is_dropped_only_when_short(gpus, efa):
    tmpl, op = _load(TEMPLATES[-1])
    out = hpp.render(tmpl, op, _args(group_gpus=gpus, group_efa=efa))
    _, _, main = _main(out)
    expected = min(gpus, out["shape"]["template_gpus"]) if out["adapted"] else out["shape"]["template_gpus"]
    assert main["resources"]["limits"]["nvidia.com/gpu"] == (gpus if out["adapted"] else expected)
    assert hpp.EFA not in main["resources"]["limits"]


def test_without_adapt_shape_a_smaller_group_is_refused_naming_p4d_p5_and_the_flag():
    tmpl, op = _load(TEMPLATES[0])
    with pytest.raises(hpp.ShapeError, match=r"p4d/p5.*--adapt-shape"):
        hpp.render(tmpl, op, _args(adapt_shape=False))


def test_a_group_that_fits_keeps_the_recipe_shape_but_still_gets_the_always_fixes():
    tmpl, op = _load(TEMPLATES[0])
    t, e = hpp.template_shape([d for d in yaml.safe_load_all(hpp.PLACEHOLDER_RE.sub("x", tmpl)) if d])
    out = hpp.render(tmpl, op, _args(adapt_shape=False, group_gpus=t, group_efa=e))
    _, _, main = _main(out)
    assert out["adapted"] is False and main["resources"]["limits"]["nvidia.com/gpu"] == t
    assert "JOB_NAME" not in {x["name"] for x in main["env"]}


@pytest.mark.parametrize("site,mutate", [
    ("script-path", lambda s: s.replace('"/app/src/train_hp.py"', '"/app/src/other.py"')),
    ("job-name-env", lambda s: re.sub(r'\n[ ]+- name: JOB_NAME\n[ ]+value: "[^"]+"', "", s)),
    ("config-name-suffix", lambda s: s.replace("--config-name=verl_config\"", "--config-name=other\"")),
    ("log-path", lambda s: s.replace("tee /data/training.log", "tee /data/x.log")),
    ("ntasks-per-node", lambda s: re.sub(r'(- name: NTASKS_PER_NODE\n\s+value: )"8"', r'\1"6"', s)),
])
def test_a_moved_or_removed_site_fails_loudly_naming_it(site, mutate):
    tmpl, op = _load(TEMPLATES[0])
    changed = mutate(tmpl)
    assert changed != tmpl, f"the mutation for {site} did not apply (fixture moved?)"
    with pytest.raises(hpp.PayloadError, match=f"template drift at {site}"):
        hpp.render(changed, op, _args())


def test_an_injected_gpu_count_literal_is_caught_by_the_post_scan():
    tmpl, op = _load(TEMPLATES[0])
    t, _ = hpp.template_shape([d for d in yaml.safe_load_all(hpp.PLACEHOLDER_RE.sub("x", tmpl)) if d])
    injected = tmpl.replace('              - name: USE_HYPERPODRUN\n',
                            f'              - name: EXTRA_NPROC\n                value: "{t}"\n'
                            '              - name: USE_HYPERPODRUN\n', 1)
    assert injected != tmpl
    with pytest.raises(hpp.PayloadError, match="leftover recipe shape"):
        hpp.render(injected, op, _args())


def test_an_unfilled_placeholder_is_fatal():
    tmpl, op = _load(TEMPLATES[0])
    op = copy.deepcopy(op)
    tmpl = tmpl.replace("{{lora_rank}}", "{{brand_new_knob}}", 1)
    with pytest.raises(hpp.PayloadError, match="unfilled template placeholder.*brand_new_knob"):
        hpp.render(tmpl, op, _args())


def test_an_unknown_family_is_refused():
    tmpl, op = _load(TEMPLATES[0])
    other = re.sub(r"image: \S+", "image: 111111111111.dkr.ecr.us-west-2.amazonaws.com/other:v1", tmpl, count=1)
    with pytest.raises(hpp.PayloadError, match="no verified site list"):
        hpp.render(other, op, _args())


def test_weights_too_big_for_the_group_are_refused():
    tmpl, op = _load(TEMPLATES[0])
    with pytest.raises(hpp.PayloadError, match="per-GPU memory"):
        hpp.render(tmpl, op, _args(gpu_vram_gib=24, model_bytes=200 * 1024 ** 3))


def test_set_overrides_the_token_budget():
    tmpl, op = _load(TEMPLATES[0])
    out = hpp.render(tmpl, op, _args(knobs={"dataset_max_len": 1024, "max_token_len_per_gpu": 2048}))
    assert _configs(out)["verl_config.yaml"]["data"]["max_token_len_per_gpu"] == 2048


# ── dataset format (R10.2) ───────────────────────────────────────────────────

def test_prompt_completion_rows_become_messages():
    rows = hpp.convert_rows("sft", [{"prompt": "hi", "completion": "there"}, {"messages": [{"role": "user", "content": "x"}]}])
    assert rows[0] == {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "there"}]}
    assert rows[1]["messages"][0]["content"] == "x"


def test_dpo_rows_keep_the_recipe_columns_and_unsupported_formats_are_refused():
    assert hpp.convert_rows("dpo", [{"prompt": "p", "chosen": "a", "rejected": "b", "x": 1}]) == [
        {"prompt": "p", "chosen": "a", "rejected": "b"}]
    with pytest.raises(hpp.PayloadError):
        hpp.convert_rows("sft", [{"text": "raw"}])
    with pytest.raises(hpp.PayloadError):
        hpp.convert_rows("dpo", [{"prompt": "p"}])
    with pytest.raises(hpp.PayloadError):
        hpp.convert_rows("rlvr", [{"prompt": "p"}])


def test_dpo_template_reads_the_columns_mlcc_writes():
    # Task 1 verify: the captured DPO template's keys are prompt/chosen/rejected.
    tmpl = open(os.path.join(FIX, next(f for f in TEMPLATES if "-dpo-" in f))).read()
    for key in ("prompt_key: prompt", "chosen_key: chosen", "rejected_key: rejected"):
        assert key in tmpl


def test_cli_exit_codes(tmp_path):
    name = TEMPLATES[0]
    base = ["render", "--template", os.path.join(FIX, name),
            "--override-params", os.path.join(FIX, name.replace("_payload_template_", "_override_params_").replace(".yaml", ".json")),
            "--group", "grp-a", "--group-gpus", "4", "--group-efa", "1", "--project", "proj", "--job", "j",
            "--namespace", "default", "--artifacts-bucket", "art", "--region", "us-west-2",
            "--dataset-uri", "s3://art/proj/tune/j/input/", "--technique", "sft", "--max-runtime", "600",
            "--set", "dataset_max_len=1024", "--out", str(tmp_path / "m.json")]
    assert hpp._cli(base) == 4
    assert hpp._cli(base + ["--adapt-shape"]) == 0
    assert json.load(open(tmp_path / "m.json"))["kind"] == "List"
