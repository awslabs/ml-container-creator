# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Guard (BL212): secret VALUES must never reach a SageMaker container Environment.

Before BL212, do/deploy.d/{realtime-inference,async-inference,batch-transform}
and do/lib/secrets.sh resolved HF_TOKEN_ARN / NGC_API_KEY_ARN with
``aws secretsmanager get-secret-value`` on the user's machine and wrote the
plaintext into CONTAINER_ENV_JSON. That JSON is the ``Environment`` of
CreateModel / CreateInferenceComponent payloads, which SageMaker returns from
Describe* calls and CloudTrail records as request parameters. A plaintext
HF_TOKEN / NGC_API_KEY (no ARN) was also written straight in.

Now the deploy passes only the ARN and the container (code/serve) resolves it
at startup with the execution role.

Layers:
  1. Static taint scan of every shell script under templates/: a variable
     assigned from ``get-secret-value`` (directly or through other variables)
     must not appear in CONTAINER_ENV_JSON / IC env / container-spec variables,
     a line mentioning ``Environment``, or an ``aws sagemaker create-*`` /
     ``update-*`` command.
  2. Plaintext HF_TOKEN / NGC_API_KEY may reach the container env only through
     do/lib/secrets.sh, behind the --allow-plaintext-secret gate.
  3. Drift checks: the secret-name prefixes secrets.sh warns about match the
     CDK SecretsManagerRead grant; the container-side resolution block is
     identical in code/serve and diffusors/serve.
  4. Behavioural: the container block resolves an ARN without printing the
     value; a sandbox runs the real generated ``do/deploy`` (realtime-inference
     and async-inference) against a stub ``aws`` that records argv, and asserts
     the recorded create-* payloads carry HF_TOKEN_ARN and never the value.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

_REPO = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
_TEMPLATES = os.path.join(_REPO, "templates")
_SECRETS_SH = os.path.join(_TEMPLATES, "do", "lib", "secrets.sh")
_CORE_STACK = os.path.join(_REPO, "infra", "bootstrap-modules", "core", "stack.ts")
_SERVE_FILES = [
    os.path.join(_TEMPLATES, "code", "serve"),
    os.path.join(_TEMPLATES, "diffusors", "serve"),
]

SENTINEL = "mlcc-sentinel-secret-value-7f3a9c"
SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:mlcc/hf-token/guard-AbCdEf"

# ── static scan ──────────────────────────────────────────────────────────────

_EJS_RE = re.compile(r"<%.*?%>", re.S)
_FETCH_RE = re.compile(r"\baws\s+secretsmanager\s+get-secret-value\b")
_ASSIGN_RE = re.compile(r"^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$", re.S)
# Variables that carry container environment / container-spec JSON.
_SINK_VAR_RE = re.compile(r"(CONTAINER|ENV_JSON|IC_ENV|ENVIRONMENT|SPEC)", re.I)
_SINK_CMD_RE = re.compile(r"\baws\s+sagemaker\s+(create|update)-[a-z-]+")
_SINK_FN_RE = re.compile(r"\b_mlcc_append_container_env\b")
_PLAINTEXT_VARS = ("HF_TOKEN", "NGC_API_KEY")
_MAX_JOIN = 40


def _ref_re(var):
    return re.compile(r"\$\{?" + re.escape(var) + r"(?![A-Za-z0-9_])")


def _unescaped_dquotes(line):
    return len(re.findall(r'(?<!\\)"', line))


def logical_lines(text):
    """Yield (lineno, line): EJS stripped, continuations and open quotes joined."""
    text = _EJS_RE.sub("", text)
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        start = i
        cur = lines[i]
        i += 1
        joined = 0
        while i < len(lines) and joined < _MAX_JOIN and (
                cur.endswith("\\") or _unescaped_dquotes(cur) % 2 == 1):
            cur = (cur[:-1] if cur.endswith("\\") else cur) + "\n" + lines[i]
            i += 1
            joined += 1
        if cur.lstrip().startswith("#"):
            continue
        yield start + 1, cur


def _is_sink(line):
    m = _ASSIGN_RE.match(line)
    if m and _SINK_VAR_RE.search(m.group(1)):
        return True
    return bool("Environment" in line or _SINK_CMD_RE.search(line) or _SINK_FN_RE.search(line))


def scan_secret_value_flows(text):
    """Return [(lineno, line)] where a get-secret-value result reaches a sink."""
    lines = list(logical_lines(text))
    tainted = set()
    changed = True
    while changed:
        changed = False
        for _, line in lines:
            m = _ASSIGN_RE.match(line)
            if not m or m.group(1) in tainted or _SINK_VAR_RE.search(m.group(1)):
                continue
            rhs = m.group(2)
            if _FETCH_RE.search(rhs) or any(_ref_re(v).search(rhs) for v in tainted):
                tainted.add(m.group(1))
                changed = True
    findings = []
    for ln, line in lines:
        if not _is_sink(line):
            continue
        if _FETCH_RE.search(line) or any(_ref_re(v).search(line) for v in tainted):
            findings.append((ln, line.strip().splitlines()[0]))
    return findings


def scan_plaintext_sinks(text):
    """Return [(lineno, line)] where a plaintext HF_TOKEN / NGC_API_KEY reaches a sink."""
    refs = [_ref_re(v) for v in _PLAINTEXT_VARS]
    return [(ln, line.strip().splitlines()[0]) for ln, line in logical_lines(text)
            if _is_sink(line) and any(r.search(line) for r in refs)]


def _shell_files():
    for dirpath, dirnames, filenames in os.walk(_TEMPLATES):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", "__pycache__")]
        for fn in filenames:
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, _TEMPLATES)
            if rel.endswith(".sh") or "/deploy.d/" in "/" + rel or "/serve.d/" in "/" + rel:
                yield path, rel
                continue
            try:
                with open(path, encoding="utf-8") as fh:
                    first = fh.readline()
            except (UnicodeDecodeError, OSError):
                continue
            if re.match(r"^#!.*\b(ba)?sh\b", first):
                yield path, rel


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


_VULNERABLE = r'''
if [ -n "${HF_TOKEN_ARN:-}" ]; then
    RESOLVED_HF_TOKEN=$(aws secretsmanager get-secret-value --secret-id "${HF_TOKEN_ARN}" \
        --query SecretString --output text --region "${AWS_REGION}") || exit 3
    CONTAINER_ENV_JSON="\"HF_TOKEN\":\"${RESOLVED_HF_TOKEN}\""
elif [ -n "${HF_TOKEN:-}" ]; then
    CONTAINER_ENV_JSON="\"HF_TOKEN\":\"${HF_TOKEN}\""
fi
KEY=$(aws secretsmanager get-secret-value --secret-id x --query SecretString --output text)
ALIAS="${KEY}"
aws sagemaker create-model --model-name m \
    --primary-container "{\"Image\":\"i\",\"Environment\":{\"K\":\"${ALIAS}\"}}"
'''

_SAFE_K8S = r'''
RESOLVED_HF_TOKEN=$(aws secretsmanager get-secret-value --secret-id "${HF_TOKEN_ARN}" --query SecretString --output text)
kubectl create secret generic hf-token-secret --from-literal=token="${RESOLVED_HF_TOKEN}" --dry-run=client -o yaml
CONTAINER_ENV_JSON="\"HF_TOKEN_ARN\":\"${HF_TOKEN_ARN}\""
'''


def test_scanner_detects_the_pre_bl212_pattern():
    """The guard must not pass vacuously: the shipped bug pattern is flagged."""
    flows = scan_secret_value_flows(_VULNERABLE)
    assert len(flows) == 2, flows
    assert any("RESOLVED_HF_TOKEN" in line for _, line in flows)
    assert any("create-model" in line for _, line in flows)
    plain = scan_plaintext_sinks(_VULNERABLE)
    assert len(plain) == 1 and "${HF_TOKEN}" in plain[0][1], plain


def test_scanner_allows_kubernetes_secret_and_arn_reference():
    assert scan_secret_value_flows(_SAFE_K8S) == []
    assert scan_plaintext_sinks(_SAFE_K8S) == []


def test_no_secret_value_reaches_a_container_environment():
    scanned = 0
    problems = []
    for path, rel in _shell_files():
        text = _read(path)
        scanned += 1
        for ln, line in scan_secret_value_flows(text):
            problems.append("{}:{}: {}".format(rel, ln, line))
    assert scanned > 20, "scanner found too few shell files ({})".format(scanned)
    assert not problems, (
        "A Secrets Manager value flows into a SageMaker container Environment / "
        "create-* / update-* payload (visible in Describe* and CloudTrail). Pass "
        "the *_ARN instead and let the container resolve it (BL212):\n  "
        + "\n  ".join(problems))


def test_plaintext_secret_only_through_gated_helper():
    problems = []
    for path, rel in _shell_files():
        if path == _SECRETS_SH:
            continue
        for ln, line in scan_plaintext_sinks(_read(path)):
            problems.append("{}:{}: {}".format(rel, ln, line))
    assert not problems, (
        "Plaintext HF_TOKEN / NGC_API_KEY written into a container env outside "
        "do/lib/secrets.sh (which gates it behind --allow-plaintext-secret):\n  "
        + "\n  ".join(problems))
    # Inside secrets.sh every plaintext append sits behind the opt-in check.
    lines = _read(_SECRETS_SH).split("\n")
    gated = 0
    for i, line in enumerate(lines):
        if _SINK_FN_RE.search(line) and any(_ref_re(v).search(line) for v in _PLAINTEXT_VARS) \
                and not line.lstrip().startswith(("#", "_mlcc_append_container_env()")):
            window = "\n".join(lines[max(0, i - 8):i])
            assert "_mlcc_plaintext_secrets_allowed" in window, (
                "secrets.sh:{} appends a plaintext secret without the opt-in gate".format(i + 1))
            gated += 1
    assert gated == len(_PLAINTEXT_VARS), "expected one gated append per plaintext secret"


# ── drift checks ─────────────────────────────────────────────────────────────

def test_secret_read_prefixes_match_cdk_grant():
    m = re.search(r'^_MLCC_SECRET_READ_PREFIXES="([^"]*)"', _read(_SECRETS_SH), re.M)
    assert m, "secrets.sh must define _MLCC_SECRET_READ_PREFIXES"
    shell = set(m.group(1).split())
    stack = _read(_CORE_STACK)
    block = re.search(r"const mlccSecretArns = \[(.*?)\];", stack, re.S)
    assert block, "core/stack.ts must define mlccSecretArns"
    cdk = set(re.findall(r":secret:([^`'\"]*?)\*", block.group(1)))
    assert cdk, "no secret ARNs parsed from core/stack.ts"
    assert shell == cdk, "secrets.sh prefixes {} != CDK SecretsManagerRead {}".format(
        sorted(shell), sorted(cdk))
    read = re.search(r"sid: 'SecretsManagerRead'.*?resources: (\w+)", stack, re.S)
    assert read and read.group(1) == "mlccSecretArns"


_BLOCK_RE = re.compile(r"# >>> MLCC secret-ARN resolution.*?# <<< MLCC secret-ARN resolution\n", re.S)


def _serve_block(path):
    m = _BLOCK_RE.search(_read(path))
    assert m, "{} lacks the MLCC secret-ARN resolution block".format(path)
    return m.group(0)


def test_container_resolution_block_present_and_identical():
    blocks = [_serve_block(p) for p in _SERVE_FILES]
    assert blocks[0] == blocks[1], "code/serve and diffusors/serve resolution blocks differ"
    for var in _PLAINTEXT_VARS:
        assert "_mlcc_resolve_secret_arn {}\n".format(var) in blocks[0]
    # Resolution happens before the engine starts (first executable section).
    text = _read(_SERVE_FILES[0])
    assert text.index("# >>> MLCC secret-ARN resolution") < text.index("Starting <%= modelServer %> server")


# ── behavioural: container block ─────────────────────────────────────────────

_STUB_AWS = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
with open(os.environ["AWS_STUB_LOG"], "a") as f:
    f.write(json.dumps(a) + "\n")
def opt(name):
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else None
key = " ".join(a[:2])
if os.environ.get("STUB_FAIL_SECRETS") and a[:1] == ["secretsmanager"]:
    sys.stderr.write("AccessDeniedException\n")
    sys.exit(255)
if key == "sts get-caller-identity":
    print("123456789012" if opt("--query") else json.dumps({"Account": "123456789012"}))
elif key == "secretsmanager get-secret-value":
    print(os.environ.get("STUB_SECRET_VALUE", ""))
elif key == "secretsmanager describe-secret":
    print(opt("--secret-id"))
elif key == "sagemaker describe-inference-component" and opt("--query"):
    print("InService")
else:
    print("")
'''


def _write_stub(bindir):
    os.makedirs(bindir, exist_ok=True)
    stub = os.path.join(bindir, "aws")
    with open(stub, "w") as fh:
        fh.write(_STUB_AWS)
    os.chmod(stub, 0o755)


def _calls(log):
    if not os.path.exists(log):
        return []
    with open(log) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _run_block(tmp, extra_env, tail):
    bindir = os.path.join(tmp, "bin")
    _write_stub(bindir)
    log = os.path.join(tmp, "aws.log")
    script = os.path.join(tmp, "block.sh")
    with open(script, "w") as fh:
        fh.write(_serve_block(_SERVE_FILES[0]) + tail)
    env = {"PATH": bindir + ":/usr/bin:/bin", "AWS_STUB_LOG": log,
           "STUB_SECRET_VALUE": SENTINEL, "HOME": tmp}
    env.update(extra_env)
    proc = subprocess.run(["/bin/bash", script], env=env, capture_output=True, text=True, timeout=60)
    return proc, _calls(log)


def test_container_block_resolves_arn_with_region_from_arn_and_hides_value():
    with tempfile.TemporaryDirectory() as tmp:
        tail = '[ "${HF_TOKEN}" = "${STUB_SECRET_VALUE}" ] && echo HF_TOKEN_MATCH\n'
        proc, calls = _run_block(tmp, {"HF_TOKEN_ARN": SECRET_ARN}, tail)
    assert proc.returncode == 0, proc.stderr
    assert "HF_TOKEN_MATCH" in proc.stdout
    assert SENTINEL not in proc.stdout + proc.stderr
    gets = [c for c in calls if c[:2] == ["secretsmanager", "get-secret-value"]]
    assert len(gets) == 1
    assert gets[0][gets[0].index("--secret-id") + 1] == SECRET_ARN
    assert gets[0][gets[0].index("--region") + 1] == "us-west-2"


def test_container_block_keeps_preset_value_and_fails_closed():
    with tempfile.TemporaryDirectory() as tmp:
        proc, calls = _run_block(tmp, {"HF_TOKEN_ARN": SECRET_ARN, "HF_TOKEN": "preset"},
                                 '[ "${HF_TOKEN}" = preset ] && echo KEPT\n')
    assert proc.returncode == 0 and "KEPT" in proc.stdout
    assert calls == [], "a preset value (e.g. K8s secretKeyRef) must not trigger a lookup"
    with tempfile.TemporaryDirectory() as tmp:
        proc, _ = _run_block(tmp, {"NGC_API_KEY_ARN": SECRET_ARN, "STUB_FAIL_SECRETS": "1"},
                             "echo SHOULD_NOT_RUN\n")
    assert proc.returncode == 1
    assert "SHOULD_NOT_RUN" not in proc.stdout
    assert "NGC_API_KEY_ARN" in proc.stderr and "GetSecretValue" in proc.stderr


# ── behavioural: sandboxed do/deploy ─────────────────────────────────────────

_NODE = shutil.which("node")
needs_node = pytest.mark.skipif(
    _NODE is None or not os.path.isdir(os.path.join(_REPO, "node_modules")),
    reason="sandbox deploy needs node + npm install (CI runs npm install first)")

# Placeholder values for a target's manifest required_vars that generation
# does not set. Unknown required vars fail loudly so this list is kept honest.
_REQUIRED_VAR_VALUES = {
    "ENDPOINT_NAME": "sbx-ep",
    "ASYNC_S3_OUTPUT_PATH": "s3://sbx-bucket/async-out",
}


def _required_vars(target):
    path = os.path.join(_TEMPLATES, "do", "targets.d", target, "manifest.json")
    return json.loads(_read(path))["required_vars"]


@pytest.fixture(scope="module")
def generated_project(tmp_path_factory):
    root = tmp_path_factory.mktemp("bl212")
    home = root / "home"
    home.mkdir()
    env = dict(os.environ, HOME=str(home))
    proc = subprocess.run(
        [_NODE, os.path.join(_REPO, "bin", "cli.js"), "sbx",
         "--deployment-config=transformers-vllm", "--model-name=Qwen/Qwen3-0.6B",
         "--skip-prompts"],
        cwd=str(root), env=env, capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    project = root / "sbx"
    assert (project / "do" / "deploy").exists()
    return root, project


def _deploy(generated_project, target, extra_env, args=()):
    root, project = generated_project
    work = tempfile.mkdtemp(dir=str(root))
    proj = os.path.join(work, "sbx")
    shutil.copytree(str(project), proj)
    # _require_python_env: an (empty) project venv satisfies the guard.
    os.makedirs(os.path.join(proj, ".mlcc", "hey-venv", "bin"))
    open(os.path.join(proj, ".mlcc", "hey-venv", "bin", "activate"), "w").close()
    config = os.path.join(proj, "do", "config")
    text = _read(config)
    text = re.sub(r'^export DEPLOYMENT_TARGET="[^"]*"', 'export DEPLOYMENT_TARGET="{}"'.format(target),
                  text, count=1, flags=re.M)
    for var in _required_vars(target):
        if re.search(r'^export {}="?[^"\s]+'.format(var), text, re.M):
            continue
        assert var in _REQUIRED_VAR_VALUES, "add a sandbox value for required var " + var
        text += '\nexport {}="{}"\n'.format(var, _REQUIRED_VAR_VALUES[var])
    with open(config, "w") as fh:
        fh.write(text)
    bindir = os.path.join(work, "bin")
    _write_stub(bindir)
    log = os.path.join(work, "aws.log")
    env = {
        "PATH": os.pathsep.join([bindir, os.path.dirname(_NODE), "/usr/bin", "/bin", "/usr/sbin"]),
        "HOME": str(root / "home"),
        "AWS_STUB_LOG": log,
        "STUB_SECRET_VALUE": SENTINEL,
        "MLCC_SKIP_SECRET_DISCOVERY": "1",
        "ROLE_ARN": "arn:aws:iam::123456789012:role/sbx-role",
        "AWS_REGION": "us-west-2",
    }
    env.update(extra_env)
    proc = subprocess.run(["/bin/bash", "./do/deploy"] + list(args), cwd=proj, env=env,
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300)
    calls = _calls(log)
    shutil.rmtree(work, ignore_errors=True)
    return proc, calls


def _payload_calls(calls):
    return [c for c in calls if c[:1] == ["sagemaker"] and len(c) > 1
            and re.match(r"(create|update)-", c[1])]


_EXPECTED_CREATES = {
    "realtime-inference": {"create-endpoint-config", "create-endpoint", "create-inference-component"},
    "async-inference": {"create-model", "create-endpoint-config", "create-endpoint"},
}
_ENV_CARRIER = {"realtime-inference": "create-inference-component", "async-inference": "create-model"}


@needs_node
@pytest.mark.parametrize("target", sorted(_EXPECTED_CREATES))
def test_sandbox_deploy_passes_arn_never_value(generated_project, target):
    proc, calls = _deploy(generated_project, target, {"HF_TOKEN_ARN": SECRET_ARN})
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out[-4000:]
    payloads = _payload_calls(calls)
    ops = {c[1] for c in payloads}
    assert _EXPECTED_CREATES[target] <= ops, "missing create calls: {}".format(
        _EXPECTED_CREATES[target] - ops)
    for c in payloads:
        assert SENTINEL not in " ".join(c), "secret value in {} payload".format(c[1])
        assert '"HF_TOKEN":' not in " ".join(c), "plaintext HF_TOKEN key in {} payload".format(c[1])
    carrier = [c for c in payloads if c[1] == _ENV_CARRIER[target]]
    assert carrier and all('"HF_TOKEN_ARN":"{}"'.format(SECRET_ARN) in " ".join(c) for c in carrier)
    assert not any(c[:2] == ["secretsmanager", "get-secret-value"] for c in calls), \
        "deploy must not fetch the secret value at all"
    assert SENTINEL not in out


@needs_node
def test_sandbox_deploy_refuses_plaintext_secret_by_default(generated_project):
    proc, calls = _deploy(generated_project, "realtime-inference", {"HF_TOKEN": SENTINEL})
    out = proc.stdout + proc.stderr
    assert proc.returncode == 3, out[-4000:]
    assert "--allow-plaintext-secret" in out and "HF_TOKEN_ARN" in out
    assert _payload_calls(calls) == [], "nothing may be created when the secret is refused"
    assert SENTINEL not in out


@needs_node
def test_sandbox_deploy_refuses_plaintext_ic_env_secret(generated_project):
    proc, calls = _deploy(generated_project, "realtime-inference",
                          {"HF_TOKEN_ARN": SECRET_ARN, "IC_ENV_HF_TOKEN": SENTINEL})
    out = proc.stdout + proc.stderr
    assert proc.returncode == 3, out[-4000:]
    assert "IC_ENV_HF_TOKEN" in out
    assert _payload_calls(calls) == []
    assert SENTINEL not in out


@needs_node
def test_sandbox_deploy_allow_plaintext_secret_opt_in(generated_project):
    proc, calls = _deploy(generated_project, "realtime-inference", {"HF_TOKEN": SENTINEL},
                          args=["--allow-plaintext-secret"])
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out[-4000:]
    assert "--allow-plaintext-secret" in out and "CloudTrail" in out
    ic = [c for c in _payload_calls(calls) if c[1] == "create-inference-component"]
    assert ic and '"HF_TOKEN":"{}"'.format(SENTINEL) in " ".join(ic[0])
