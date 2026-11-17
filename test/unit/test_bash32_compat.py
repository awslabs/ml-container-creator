# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Bash 3.2 compatibility guard for the shell scripts under templates/.

Generated do/ scripts are ``#!/bin/bash`` and must run on macOS, whose
/bin/bash is 3.2. Bash-4+ constructs either fail to parse or fail at runtime
there. The runtime failures are the dangerous kind: ``${ARG_TECHNIQUE^^}``
is a "bad substitution" on 3.2, which aborted the RLVR/RLAIF guard ``echo``s
in do/tune's ``_preflight_rft_inputs`` before they printed anything. Under
do/tune's ``set -e`` the user saw only a bare "bad substitution" with none of
the register/--evaluator-name guidance; without ``set -e`` the function
returned and execution carried on past the guard.

Two layers:
  1. Static scan: every shell file under templates/ (identified by shebang,
     a ``.sh`` suffix, or the serve.d shell partials) is grepped for bash-4+
     constructs. Comment lines and quoted-delimiter heredoc bodies (which bash
     never expands) are skipped. Findings are reported as file:line.
  2. Behavioural: the real ``_preflight_rft_inputs`` from templates/do/tune is
     run under /bin/bash (3.2 on macOS, 5.x on Linux CI) and must print its
     guidance and exit 1.
"""
import os
import re
import subprocess
import tempfile

import pytest

_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
_TEMPLATES = os.path.join(_REPO_ROOT, "templates")
_TUNE = os.path.join(_TEMPLATES, "do", "tune")

# Files that run only inside Linux container images (bash 4+/5), never on the
# user's host. They are still scanned, and must stay in this list on purpose.
# Paths are relative to templates/.
_CONTAINER_ONLY = {
    "code/serve",
    "code/start_server.sh",
    "code/cuda_compat.sh",
    "code/serve.d/llama-cpp/llama-cpp.ejs",
    "code/serve.d/lmi/lmi.ejs",
    "code/serve.d/sglang/sglang.ejs",
    "code/serve.d/tensorrt-llm/tensorrt-llm.ejs",
    "code/serve.d/vllm-omni/vllm-omni.ejs",
    "code/serve.d/vllm/vllm.ejs",
    "diffusors/serve",
}

_IDENT = r"[A-Za-z_][A-Za-z0-9_]*"
_BASH4_PATTERNS = [
    ("case-modification expansion (${v^^} ${v,,} ${v^} ${v,})",
     re.compile(r"\$\{[#!]?" + _IDENT + r"(\[[^]]*\])?(\^\^?|,,?)[^}]*\}")),
    ("parameter transformation (${v@Q} etc.)",
     re.compile(r"\$\{" + _IDENT + r"(\[[^]]*\])?@[QEPAKaUuLk]\}")),
    ("associative array / nameref (declare|local|typeset -A / -n)",
     re.compile(r"\b(declare|local|typeset)\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[An]")),
    ("mapfile / readarray", re.compile(r"(^|[\s;&|(`])(mapfile|readarray)\b")),
    ("|& pipe", re.compile(r"\|&")),
    ("&>> append redirect", re.compile(r"&>>")),
    ("coproc", re.compile(r"(^|[\s;&|(])coproc\b")),
    ("negative array index ${a[-1]}",
     re.compile(r"\$\{" + _IDENT + r"\[\s*-\s*[0-9]")),
]

_SHEBANG = re.compile(r"^#!.*\b(ba)?sh\b")
# Only QUOTED-delimiter heredocs are skipped: their bodies are never expanded
# by bash (typically embedded Python). Unquoted heredoc bodies ARE expanded,
# so a bash-4 expansion there is a real bug and must stay in the scan.
_QUOTED_HEREDOC = re.compile(r"(?<!<)<<(-?)\s*(['\"])(" + _IDENT + r")\2")


def _is_shell_file(path, rel):
    if rel.endswith(".sh"):
        return True
    if re.match(r"code/serve\.d/[^/]+/[^/]+\.ejs$", rel):
        return True
    try:
        with open(path, "r", encoding="utf-8") as fh:
            first = fh.readline()
    except (UnicodeDecodeError, OSError):
        return False
    return bool(_SHEBANG.match(first))


def _shell_files():
    out = []
    for root, dirs, files in os.walk(_TEMPLATES):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", "node_modules", ".venv")]
        for name in files:
            path = os.path.join(root, name)
            rel = os.path.relpath(path, _TEMPLATES).replace(os.sep, "/")
            if _is_shell_file(path, rel):
                out.append((path, rel))
    return sorted(out, key=lambda t: t[1])


def scan_text(text):
    """Return [(lineno, label, line)] bash-4+ findings in shell source text."""
    findings = []
    heredoc_end = None
    heredoc_strip = False
    for lineno, line in enumerate(text.splitlines(), 1):
        if heredoc_end is not None:
            cand = line.lstrip("\t") if heredoc_strip else line
            if cand == heredoc_end:
                heredoc_end = None
            continue
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        for label, rx in _BASH4_PATTERNS:
            if rx.search(line):
                findings.append((lineno, label, stripped))
        m = _QUOTED_HEREDOC.search(line)
        if m:
            heredoc_strip = m.group(1) == "-"
            heredoc_end = m.group(3)
    return findings


def test_scan_discovers_do_scripts_and_libs():
    rels = {rel for _, rel in _shell_files()}
    for expected in ("do/tune", "do/deploy", "do/lib/script-contract.sh",
                     "code/serve.d/vllm/vllm.ejs"):
        assert expected in rels, f"{expected} not identified as a shell file"
    missing = sorted(_CONTAINER_ONLY - rels)
    assert not missing, f"stale _CONTAINER_ONLY entries: {missing}"


@pytest.mark.parametrize("snippet", [
    'echo "${ARG_TECHNIQUE^^}"', 'x=${y,,}', 'x=${y^}', 'x=${arr[0],}',
    'echo "${v@Q}"', 'declare -A m', 'local -n ref=x', 'typeset -gA m',
    'mapfile -t a < f', 'readarray a', 'cmd |& tee', 'cmd &>> log',
    'coproc foo', 'echo "${a[-1]}"',
])
def test_scanner_flags_bash4_constructs(snippet):
    assert scan_text(snippet), f"scanner missed: {snippet}"


@pytest.mark.parametrize("snippet", [
    '# ${x^^} in a comment', 'echo "${x:-y}"', 'echo "${#arr[@]}"',
    'local a b', 'declare -a arr', 'x=${y%%,*}', 'cmd || other',
    "cat <<< \"${x}\"",
])
def test_scanner_ignores_bash32_safe_code(snippet):
    assert not scan_text(snippet), f"false positive: {snippet}"


def test_scanner_skips_quoted_heredoc_but_not_unquoted():
    quoted = "python3 - <<'PY'\nprint(f'${x^^}')\nPY\necho ok\n"
    assert not scan_text(quoted)
    unquoted = "cat <<EOF\n${x^^}\nEOF\n"
    assert scan_text(unquoted)
    after = "python3 - <<'PY'\nx=1\nPY\necho ${y,,}\n"
    assert [f[0] for f in scan_text(after)] == [4]


def test_host_shell_templates_are_bash32_compatible():
    problems = []
    for path, rel in _shell_files():
        if rel in _CONTAINER_ONLY:
            continue
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        for lineno, label, line in scan_text(text):
            problems.append(f"templates/{rel}:{lineno}: {label}: {line}")
    assert not problems, (
        "bash-4+ constructs in host-run shell templates (must run on macOS "
        "/bin/bash 3.2):\n  " + "\n  ".join(problems)
    )


# ── Behavioural: do/tune _preflight_rft_inputs under /bin/bash ───────────────

def _extract_function(text, name):
    m = re.search(r"^" + re.escape(name) + r"\(\) \{\n.*?^\}\n", text, re.S | re.M)
    assert m, f"{name} not found in templates/do/tune"
    return m.group(0)


def _run_preflight(env_lines):
    with open(_TUNE, "r", encoding="utf-8") as fh:
        fn = _extract_function(fh.read(), "_preflight_rft_inputs")
    script = "\n".join(env_lines) + "\n" + fn + "\n_preflight_rft_inputs\necho REACHED_END\n"
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as tf:
        tf.write(script)
        tmp = tf.name
    try:
        return subprocess.run(["/bin/bash", tmp], capture_output=True, text=True, timeout=30)
    finally:
        os.unlink(tmp)


_RFT_BASE = [
    'ARG_REWARD_FUNCTION=""', 'ARG_REWARD_PROMPT=""', 'ARG_EVALUATOR_NAME=""',
    'ARG_AGENT_ENV=""', 'SCRIPT_DIR=/nonexistent', 'AWS_REGION=us-west-2',
]


@pytest.mark.skipif(not os.path.exists("/bin/bash"), reason="/bin/bash not available")
@pytest.mark.parametrize("technique,needle", [
    ("rlvr", "RLVR requires a reward function evaluator, but none was provided."),
    ("rlaif", "RLAIF requires a reward prompt evaluator, but none was provided."),
])
def test_preflight_missing_evaluator_exits_with_guidance(technique, needle):
    r = _run_preflight(_RFT_BASE + [f"ARG_TECHNIQUE={technique}",
                                    "RESOLVED_DATASET_S3_URI=s3://bucket/ds/"])
    assert r.returncode == 1, (r.returncode, r.stdout, r.stderr)
    assert needle in r.stdout, r.stdout
    assert "--evaluator-name" in r.stdout
    assert "bad substitution" not in r.stderr, r.stderr
    assert "REACHED_END" not in r.stdout


@pytest.mark.skipif(not os.path.exists("/bin/bash"), reason="/bin/bash not available")
def test_preflight_missing_dataset_exits_with_guidance():
    r = _run_preflight(_RFT_BASE + ["ARG_TECHNIQUE=rlvr", 'RESOLVED_DATASET_S3_URI=""'])
    assert r.returncode == 1, (r.returncode, r.stdout, r.stderr)
    assert "RLVR requires a prompt dataset, but none could be resolved." in r.stdout
    assert "bad substitution" not in r.stderr, r.stderr
