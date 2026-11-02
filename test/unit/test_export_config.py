# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 8 R6 / R10.4 — templates/do/lib/python/export_config.py (do/export data work).

Uses the REAL generated export map (templates/do/lib/python/export_map.json, from
config/parameter-schema-v2.json) so the tests track the schema instead of a copy.
Entries are looked up by do/config var / type, and assertions are behavioral.
"""
import io
import json
import os
import shlex
import sys
from contextlib import redirect_stderr, redirect_stdout

import pytest

_PY = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "templates", "do", "lib", "python"))
if _PY not in sys.path:
    sys.path.insert(0, _PY)

import export_config as ec  # noqa: E402

MAP = ec.load_map()
BY_VAR = {e["doConfigVar"]: e for e in MAP}


def _write_config(tmp_path, lines):
    path = tmp_path / "config"
    path.write_text("#!/bin/bash\n" + "\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


def _run(tmp_path, monkeypatch, lines, env=None, fmt="json", target=None):
    """Run main() with a clean env (only the given vars) and return (stdout, stderr)."""
    cfg = _write_config(tmp_path, lines)
    for key in list(os.environ):
        # FRAMEWORK is derived (not in BY_VAR) but export_config reads it for the
        # architecture filter, so an ambient value (e.g. a sourced do/config) must not leak in.
        if key in BY_VAR or key.startswith(("IC_ENV_", "VLLM_", "MLCC_")) or key in ("DEPLOYMENT_TARGET", "FRAMEWORK"):
            monkeypatch.delenv(key, raising=False)
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    argv = ["--format", fmt, "--config", cfg]
    if target:
        argv += ["--target", target]
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = ec.main(argv)
    assert rc == 0, err.getvalue()
    return out.getvalue(), err.getvalue()


def _json(tmp_path, monkeypatch, lines, env=None, target=None):
    out, _ = _run(tmp_path, monkeypatch, lines, env=env, target=target)
    return json.loads(out)


def _cli_tokens(tmp_path, monkeypatch, lines, env=None, target=None):
    out, _ = _run(tmp_path, monkeypatch, lines, env=env, fmt="cli", target=target)
    cmd = next(line for line in out.splitlines() if "ml-container-creator" in line and not line.startswith("#"))
    return shlex.split(cmd)


def test_map_is_generated_from_schema_and_nonempty():
    assert MAP, "export_map.json has no parameters"
    keys = [e["key"] for e in MAP]
    assert len(keys) == len(set(keys)), "a schema key appears twice"
    assert len(BY_VAR) == len(MAP), "a do/config var is claimed twice"


def test_runtime_values_win_over_file_text(tmp_path, monkeypatch):
    # do/config declares the var; the sourced (runtime) value is what gets exported.
    data = _json(
        tmp_path, monkeypatch,
        ['export PROJECT_NAME="from-file"', 'export AWS_REGION=${AWS_REGION:-us-east-2}'],
        env={"PROJECT_NAME": "edited-later", "AWS_REGION": "eu-west-1"},
    )
    assert data[BY_VAR["PROJECT_NAME"]["key"]] == "edited-later"
    assert data[BY_VAR["AWS_REGION"]["key"]] == "eu-west-1"


def test_shell_only_values_are_not_exported(tmp_path, monkeypatch):
    # A mapped var that only exists in the shell (e.g. resolved by profile.sh or
    # left in the user's environment) is not part of do/config, so it is not exported.
    data = _json(tmp_path, monkeypatch, ['export DEPLOYMENT_CONFIG="transformers-vllm"'],
                 env={"PROJECT_NAME": "from-the-shell-only"})
    assert BY_VAR["PROJECT_NAME"]["key"] not in data
    assert data[BY_VAR["DEPLOYMENT_CONFIG"]["key"]] == "transformers-vllm"


def test_values_are_typed_per_schema(tmp_path, monkeypatch):
    entry = next(e for e in MAP if e["type"] == "integer" and e["default"] != 7
                 and "hyperpod-eks" in e["deploymentTargets"])
    lines = ['export DEPLOYMENT_TARGET="hyperpod-eks"', f'export {entry["doConfigVar"]}="7"',
             'export ENABLE_LORA=false']
    data = _json(tmp_path, monkeypatch, lines, target="hyperpod-eks")
    assert data[entry["key"]] == 7 and isinstance(data[entry["key"]], int)
    assert data[BY_VAR["ENABLE_LORA"]["key"]] is False


def test_number_type_keeps_fractions(tmp_path, monkeypatch):
    entry = next(e for e in MAP if e["type"] == "number")
    target = next(t for t in entry["deploymentTargets"] if t != "*")
    data = _json(tmp_path, monkeypatch, [f'export {entry["doConfigVar"]}="0.25"'], target=target)
    assert data[entry["key"]] == 0.25


def test_defaults_are_suppressed(tmp_path, monkeypatch):
    lines = []
    expected_absent = []
    for e in MAP:
        if e["shape"] != "scalar" or e["sensitive"] or e["default"] in (None, "", []):
            continue
        if "*" not in e["deploymentTargets"]:
            continue
        val = e["default"]
        raw = "true" if val is True else "false" if val is False else str(val)
        lines.append(f'export {e["doConfigVar"]}="{raw}"')
        expected_absent.append(e["key"])
    assert expected_absent, "no defaulted '*' parameters to check"
    data = _json(tmp_path, monkeypatch, lines)
    for key in expected_absent:
        assert key not in data, f"{key} equals its default and must not be exported"


def test_target_filtering_and_aliases(tmp_path, monkeypatch):
    k8s_only = [e for e in MAP if e["deploymentTargets"] == ["hyperpod-eks", "eks"] and e["shape"] == "scalar"]
    assert k8s_only, "expected kubernetes-only parameters in the map"
    entry = k8s_only[0]
    lines = [f'export {entry["doConfigVar"]}="non-default-value-1"']
    assert entry["key"] in _json(tmp_path, monkeypatch, lines, target="hyperpod-eks")
    assert entry["key"] in _json(tmp_path, monkeypatch, lines, target="hyperpod")  # alias from targets.d
    assert entry["key"] not in _json(tmp_path, monkeypatch, lines, target="realtime-inference")
    # appliesTo uses the deprecated managed-inference alias; it must match realtime-inference.
    realtime = next(e for e in MAP if e["deploymentTargets"] == ["managed-inference"] and e["type"] == "integer")
    lines = [f'export {realtime["doConfigVar"]}="42"']
    assert _json(tmp_path, monkeypatch, lines, target="realtime-inference")[realtime["key"]] == 42
    assert realtime["key"] not in _json(tmp_path, monkeypatch, lines, target="eks")


def test_effective_target_is_exported(tmp_path, monkeypatch):
    data = _json(tmp_path, monkeypatch, ['export DEPLOYMENT_TARGET="realtime-inference"'], target="batch")
    assert data[BY_VAR["DEPLOYMENT_TARGET"]["key"]] == "batch-transform"


def test_secrets_are_references_never_values(tmp_path, monkeypatch):
    secrets = [e for e in MAP if e["sensitive"]]
    assert secrets, "expected at least one sensitive parameter"
    lines = [f'export {e["doConfigVar"]}="s3cr3t-{i}"' for i, e in enumerate(secrets)]
    out, _ = _run(tmp_path, monkeypatch, lines)
    cli, _ = _run(tmp_path, monkeypatch, lines, fmt="cli")
    data = json.loads(out)
    for i, e in enumerate(secrets):
        assert data[e["key"]] == f'${e["doConfigVar"]}'
        assert f"s3cr3t-{i}" not in out and f"s3cr3t-{i}" not in cli
        assert f'"${e["doConfigVar"]}"' in cli  # shell expands the reference at run time


@pytest.mark.parametrize("value", ['say "hi"', "back\\slash", "it's a $HOME `x`", "multi word  spaced"])
def test_quotes_and_backslashes_survive_both_renderers(tmp_path, monkeypatch, value):
    entry = BY_VAR["MODEL_NAME"]
    data = _json(tmp_path, monkeypatch, ['export MODEL_NAME="placeholder"'], env={"MODEL_NAME": value})
    assert data[entry["key"]] == value
    tokens = _cli_tokens(tmp_path, monkeypatch, ['export MODEL_NAME="placeholder"'], env={"MODEL_NAME": value})
    assert f'{entry["cliFlag"]}={value}' in tokens


def test_env_map_families_read_runtime_values(tmp_path, monkeypatch):
    fam = next(e for e in MAP if e["shape"] == "env-map" and "*" in e["deploymentTargets"])
    lines = [f'export {fam["doConfigVar"]}="A_KEY=A_VAR B_KEY=B_VAR GONE=NOT_SET"',
             'export A_VAR=${A_VAR:-x}', 'export B_VAR="two words"']
    data = _json(tmp_path, monkeypatch, lines, env={"A_VAR": "edited", "B_VAR": 'q"uote'})
    assert data[fam["key"]] == {"A_KEY": "edited", "B_KEY": 'q"uote'}
    tokens = _cli_tokens(tmp_path, monkeypatch, lines, env={"A_VAR": "edited", "B_VAR": 'q"uote'})
    assert f'{fam["cliFlag"]}=A_KEY=edited' in tokens
    assert f'{fam["cliFlag"]}=B_KEY=q"uote' in tokens


def test_boolean_false_uses_env_var_on_the_cli(tmp_path, monkeypatch):
    entry = BY_VAR["ENABLE_LORA"]
    assert entry["envVar"], "enableLora must declare an envVar for the CLI false form"
    tokens = _cli_tokens(tmp_path, monkeypatch, ["export ENABLE_LORA=false"])
    assert tokens[0] == f'{entry["envVar"]}=false'
    assert entry["cliFlag"] not in tokens


def test_invalid_typed_value_warns_and_keeps_the_string(tmp_path, monkeypatch):
    entry = next(e for e in MAP if e["type"] == "integer" and "*" not in e["deploymentTargets"]
                 and "hyperpod-eks" in e["deploymentTargets"])
    out, err = _run(tmp_path, monkeypatch, [f'export {entry["doConfigVar"]}="lots"'], target="hyperpod-eks")
    assert json.loads(out)[entry["key"]] == "lots"
    assert entry["doConfigVar"] in err and "not a valid integer" in err


def test_architecture_filter_uses_do_config_framework(tmp_path, monkeypatch):
    entry = next(e for e in MAP if "*" not in e["architectures"] and e["shape"] == "scalar"
                 and not e["sensitive"] and "*" in e["deploymentTargets"] and e["type"] == "string")
    other = "an-architecture-not-in-the-list"
    lines = [f'export {entry["doConfigVar"]}="x-value"']
    assert entry["key"] in _json(tmp_path, monkeypatch, lines + [f'export FRAMEWORK="{entry["architectures"][0]}"'])
    assert entry["key"] not in _json(tmp_path, monkeypatch, lines + [f'export FRAMEWORK="{other}"'])


def test_unset_literal_is_not_exported(tmp_path, monkeypatch):
    entry = next(e for e in MAP if e["unsetValue"] is not None)
    target = next((t for t in entry["deploymentTargets"] if t != "*"), "realtime-inference")
    var = entry["doConfigVar"]
    unset = [f'export {var}="${{{var}:-{entry["unsetValue"]}}}"']
    assert entry["key"] not in _json(tmp_path, monkeypatch, unset, target=target)
    assert entry["key"] in _json(tmp_path, monkeypatch, unset, env={var: "3"}, target=target)


def test_missing_config_is_exit_2(tmp_path, capsys):
    assert ec.main(["--config", str(tmp_path / "nope")]) == 2
    assert "do/config not found" in capsys.readouterr().err
