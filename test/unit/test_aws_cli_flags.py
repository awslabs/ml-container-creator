"""Guard: every ``aws sagemaker|secretsmanager <op> --flag`` MLCC emits must exist in the API.

Regression guard for the v1.7.0 bug where ``templates/do/lib/endpoint-config.sh``
passed ``--container-metrics-config`` to ``aws sagemaker create-endpoint-config``.
CreateEndpointConfig has no such member, so the AWS CLI rejected the call
client-side ("Unknown options", rc 252) and every IC-based realtime-inference
deploy failed at the endpoint-config step. No unit test noticed, because none
of them compared CLI flags with the real API.

How it works
------------
1. Statically extract every SageMaker CLI invocation from ``templates/**`` and
   ``src/**``:
     * direct commands: ``aws sagemaker <op> --a x \\`` with line continuations,
       multi-line quoted JSON, ``$(...)`` and ``${...}`` values;
     * command arrays: ``local -a cmd_args=( aws sagemaker <op> ... )`` plus every
       ``cmd_args+=( --flag ... )`` append in the same file;
     * argument arrays: ``ARGS=( --flag ... )`` fed to
       ``aws sagemaker <op> "${ARGS[@]}"``;
     * user-facing hints inside quoted strings (``echo "aws sagemaker ..."``);
     * Python ``["aws", "sagemaker", "<op>", "--flag", ...]`` lists;
     * JS template literals ```sagemaker <op> --flag ${x}``` in ``src/``.
2. Map each kebab-case op and flag onto botocore's bundled SageMaker service
   model, the same way the AWS CLI derives them (``botocore.xform_name``), and
   allow the CLI's global options, per-operation options and pagination options.
   ``aws sagemaker wait <waiter>`` is checked against the waiter model.

   Abbreviated flags are rejected on purpose. The CLI's argparse accepts a
   unique prefix (``--endpoint-name`` for ``--endpoint-name-equals``), but that
   breaks silently as soon as the API gains a second member with that prefix.

The same checks run for ``aws secretsmanager <op>`` (BL212: the deploy and the
serving container both call Secrets Manager), against botocore's bundled
Secrets Manager model.
botocore is pinned in ``.github/workflows/ci.yml``. If MLCC adopts a SageMaker
API newer than the pinned model, this test fails with "unknown operation" or
"unknown flag"; bump the pin rather than allow-listing the flag.
"""
import os
import re
from pathlib import Path

import pytest

try:
    import botocore
    import botocore.exceptions
    import botocore.session
    from botocore import xform_name
except ImportError:  # pragma: no cover - depends on the environment
    if os.environ.get("CI"):
        raise  # CI installs a pinned botocore (ci.yml); never skip there
    pytest.skip("botocore not installed (CI installs a pinned version; see ci.yml)",
                allow_module_level=True)

REPO = Path(__file__).resolve().parents[2]
SCAN_ROOTS = [REPO / "templates", REPO / "src"]
SKIP_DIRS = {"node_modules", "__pycache__", ".git"}
TEXT_SUFFIXES = {"", ".sh", ".py", ".js", ".cjs", ".mjs", ".ejs", ".md", ".txt", ".yaml", ".yml"}

# Operations the guard must see, so a broken extractor cannot pass vacuously.
REQUIRED_OPERATIONS = {
    "create-endpoint-config",
    "create-inference-component",
    "update-inference-component",
    "create-endpoint",
    "create-model",
    "create-transform-job",
}
REQUIRED_SECRETSMANAGER_OPERATIONS = {
    "get-secret-value",
    "describe-secret",
}
SERVICES = ("sagemaker", "secretsmanager")

# AWS CLI v2 global options (``aws help``, GLOBAL OPTIONS).
GLOBAL_OPTIONS = {
    "--debug", "--endpoint-url", "--no-verify-ssl", "--no-paginate", "--output",
    "--query", "--profile", "--region", "--version", "--color", "--no-sign-request",
    "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format",
    "--no-cli-pager", "--cli-auto-prompt", "--no-cli-auto-prompt",
}
# Options the CLI adds to every operation.
OPERATION_OPTIONS = {"--cli-input-json", "--cli-input-yaml", "--generate-cli-skeleton"}
# Options the CLI adds to paginated operations.
PAGINATION_OPTIONS = {"--starting-token", "--page-size", "--max-items"}

FLAG_RE = re.compile(r"^--[a-z0-9][a-z0-9-]*$")
AWS_SM_RE = re.compile(r"\baws[ \t]+(sagemaker|secretsmanager)[ \t]+")
ARRAY_RE = re.compile(
    r"^[ \t]*(?:local[ \t]+(?:-a[ \t]+)?)?([A-Za-z_][A-Za-z0-9_]*)(\+?)=\(", re.M
)
ARRAY_REF_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}$")
PY_LIST_RE = re.compile(
    r"""\[\s*["']aws["']\s*,\s*["']sagemaker["']\s*,\s*["']([a-z][a-z0-9-]*)["']([^\]]*)\]"""
)
PY_STR_RE = re.compile(r"""["'](--[a-z0-9][a-z0-9-]*)["']""")
JS_TEMPLATE_RE = re.compile(r"`(?:aws[ \t]+)?(sagemaker|secretsmanager)[ \t]+([a-z][a-z0-9-]*)([^`]*)`")
JS_FLAG_RE = re.compile(r"(?:^|\s)(--[a-z0-9][a-z0-9-]*)")
EJS_OUTPUT_RE = re.compile(r"<%[=-].*?%>", re.S)
EJS_CONTROL_RE = re.compile(r"<%.*?%>", re.S)


# ── shell-ish lexer ──────────────────────────────────────────────────────────

def _skip_dquote(text, i):
    """``text[i]`` is an opening double quote. Return the index after its close."""
    n = len(text)
    i += 1
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == '"':
            return i + 1
        if c == "$" and i + 1 < n and text[i + 1] == "(":
            i = _skip_balanced(text, i + 1)
            continue
        if c == "`":
            j = text.find("`", i + 1)
            i = n if j < 0 else j + 1
            continue
        i += 1
    return n


def _skip_balanced(text, i):
    """``text[i]`` is ``(``. Return the index after the matching ``)``."""
    n = len(text)
    depth = 0
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = text.find("'", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == '"':
            i = _skip_dquote(text, i)
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def _skip_brace(text, i):
    """``text[i]`` is ``{`` (of ``${``). Return the index after the matching ``}``."""
    n = len(text)
    depth = 0
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def lex_words(text, i, multiline=False):
    """Lex shell words from ``text[i:]`` until the command (or array) ends.

    ``multiline=False``: a simple command; it ends at an unquoted newline (line
    continuations are joined), ``;``, ``|``, ``&``, a redirection, ``)`` or a
    backtick. ``multiline=True``: an array body; newlines separate words and the
    body ends at the unquoted closing ``)``. Quotes are removed from word values;
    ``$(...)`` and ``${...}`` are kept verbatim as part of the word.
    """
    words = []
    cur = None
    n = len(text)

    def flush():
        nonlocal cur
        if cur is not None:
            words.append(cur)
        cur = None

    while i < n:
        c = text[i]
        if c == "\\" and i + 1 < n and text[i + 1] == "\n":
            i += 2
            continue
        if c in " \t\r":
            flush()
            i += 1
            continue
        if c == "\n":
            if not multiline:
                break
            flush()
            i += 1
            continue
        if c == "#" and cur is None:
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c in ";|&<>)`" or (c == "(" and cur is None):
            break
        if c == "'":
            j = text.find("'", i + 1)
            j = n if j < 0 else j
            cur = (cur or "") + text[i + 1:j]
            i = j + 1
            continue
        if c == '"':
            j = _skip_dquote(text, i)
            cur = (cur or "") + text[i + 1:j - 1]
            i = j
            continue
        if c == "$" and i + 1 < n and text[i + 1] in "({":
            j = _skip_balanced(text, i + 1) if text[i + 1] == "(" else _skip_brace(text, i + 1)
            cur = (cur or "") + text[i:j]
            i = j
            continue
        if c == "\\" and i + 1 < n:
            cur = (cur or "") + text[i + 1]
            i += 2
            continue
        cur = (cur or "") + c
        i += 1
    flush()
    return words


def _line_context(line_prefix):
    """Classify the position at the end of ``line_prefix``.

    Returns ``'comment'``, ``'"'`` / ``"'"`` (inside a string literal, i.e. a
    user-facing hint) or ``'code'``. Tracked from the start of the physical line;
    ``$(`` inside double quotes switches back to code.
    """
    stack = ["code"]
    i = 0
    n = len(line_prefix)
    while i < n:
        c = line_prefix[i]
        top = stack[-1]
        if top == "'":
            if c == "'":
                stack.pop()
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if top == '"':
            if c == '"':
                stack.pop()
            elif c == "$" and i + 1 < n and line_prefix[i + 1] == "(":
                stack.append("$(")
                i += 2
                continue
            i += 1
            continue
        # code or $(
        if c == "#" and (i == 0 or line_prefix[i - 1] in " \t;("):
            return "comment"
        if c == "'":
            stack.append("'")
        elif c == '"':
            stack.append('"')
        elif c == "$" and i + 1 < n and line_prefix[i + 1] == "(":
            stack.append("$(")
            i += 2
            continue
        elif c == ")" and top == "$(":
            stack.pop()
        i += 1
    top = stack[-1]
    return top if top in ("'", '"') else "code"


def _string_body(text, i, quote):
    """Return the rest of the string literal that encloses position ``i``."""
    if quote == "'":
        j = text.find("'", i)
        return text[i:] if j < 0 else text[i:j]
    j = i
    n = len(text)
    while j < n:
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == '"':
            break
        if text[j] == "$" and j + 1 < n and text[j + 1] == "(":
            j = _skip_balanced(text, j + 1)
            continue
        j += 1
    return text[i:j]


def _strip_ejs(text):
    text = EJS_OUTPUT_RE.sub("EJS", text)
    return EJS_CONTROL_RE.sub("", text)


def _invocation(path, line, words, kind, service="sagemaker"):
    """Build an invocation from words that start right after ``aws <service>``."""
    if not words:
        return None
    op = words[0]
    rest = words[1:]
    waiter = None
    if op == "wait" and rest:
        waiter, rest = rest[0], rest[1:]
    flags = []
    array_refs = []
    for w in rest:
        flag = w.split("=", 1)[0]
        if FLAG_RE.match(flag):
            flags.append(flag)
            continue
        m = ARRAY_REF_RE.match(w)
        if m:
            array_refs.append(m.group(1))
    return {
        "file": path, "line": line, "op": op, "waiter": waiter,
        "flags": flags, "array_refs": array_refs, "kind": kind, "service": service,
    }


def extract_invocations(text, path="<text>"):
    """Return every SageMaker CLI invocation found in ``text``."""
    text = _strip_ejs(text)
    found = []
    arrays = {}  # name -> {"op": (op, waiter, line, service) | None, "flags": [(flag, line)]}

    def lineno(pos):
        return text.count("\n", 0, pos) + 1

    # 1. Arrays: NAME=( ... ) / NAME+=( ... )
    for m in ARRAY_RE.finditer(text):
        name, append = m.group(1), m.group(2)
        words = lex_words(text, m.end(), multiline=True)
        entry = arrays.setdefault(name, {"op": None, "flags": []})
        ln = lineno(m.start())
        if not append and len(words) >= 3 and words[0] == "aws" and words[1] in SERVICES:
            inv = _invocation(path, ln, words[2:], "array", words[1])
            entry["op"] = (inv["op"], inv["waiter"], ln, words[1])
            entry["flags"].extend((f, ln) for f in inv["flags"])
            continue
        entry["flags"].extend((w.split("=", 1)[0], ln) for w in words
                              if FLAG_RE.match(w.split("=", 1)[0]))

    # 2. Direct commands and quoted hints.
    for m in AWS_SM_RE.finditer(text):
        line_start = text.rfind("\n", 0, m.start()) + 1
        ctx = _line_context(text[line_start:m.start()])
        if ctx == "comment":
            continue
        ln = lineno(m.start())
        if ctx == "code":
            words = lex_words(text, m.end())
            kind = "command"
        else:
            words = lex_words(_string_body(text, m.end(), ctx), 0)
            kind = "hint"
        inv = _invocation(path, ln, words, kind, m.group(1))
        if inv is None:
            continue
        for ref in inv["array_refs"]:
            entry = arrays.get(ref)
            if entry is None:
                continue
            inv["flags"].extend(f for f, _ in entry["flags"])
            entry["bound"] = True
        found.append(inv)

    # Command arrays (``aws sagemaker <op>`` as the first elements).
    for name, entry in arrays.items():
        if entry["op"] is None:
            continue
        op, waiter, ln, service = entry["op"]
        found.append({
            "file": path, "line": ln, "op": op, "waiter": waiter,
            "flags": [f for f, _ in entry["flags"]], "array_refs": [],
            "flag_lines": [fl for _, fl in entry["flags"]],
            "kind": "array:" + name, "service": service,
        })

    # 3. Python argv lists.
    for m in PY_LIST_RE.finditer(text):
        found.append({
            "file": path, "line": lineno(m.start()), "op": m.group(1), "waiter": None,
            "flags": PY_STR_RE.findall(m.group(2)), "array_refs": [], "kind": "py-list",
            "service": "sagemaker",
        })
    return found


def extract_js_invocations(text, path="<text>"):
    found = []
    for m in JS_TEMPLATE_RE.finditer(text):
        if "aws " + m.group(1) in m.group(0):
            continue  # already covered by the shell extractor
        found.append({
            "file": path, "line": text.count("\n", 0, m.start()) + 1,
            "op": m.group(2), "waiter": None,
            "flags": JS_FLAG_RE.findall(m.group(3)), "array_refs": [], "kind": "js",
            "service": m.group(1),
        })
    return found


def _iter_files():
    for root in SCAN_ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                p = Path(dirpath) / fn
                if p.suffix in TEXT_SUFFIXES:
                    yield p


def collect_repo_invocations():
    out = []
    for p in _iter_files():
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if not any(svc in text for svc in SERVICES):
            continue
        rel = str(p.relative_to(REPO))
        out.extend(extract_invocations(text, rel))
        if p.suffix in (".js", ".cjs", ".mjs"):
            out.extend(extract_js_invocations(text, rel))
    return out


# ── service model ────────────────────────────────────────────────────────────

class ServiceCli:
    def __init__(self, service="sagemaker"):
        session = botocore.session.get_session()
        self.service = service
        self.model = session.get_service_model(service)
        self.ops = {xform_name(name, "-"): name for name in self.model.operation_names}
        try:
            waiter_model = session.get_waiter_model(service)
            self.waiters = {
                xform_name(w, "-"): waiter_model.get_waiter(w).operation
                for w in waiter_model.waiter_names
            }
        except (botocore.exceptions.DataNotFoundError, botocore.exceptions.UnknownServiceError):
            self.waiters = {}  # secretsmanager has no waiters
        try:
            self.paginated = set(session.get_paginator_model(service)._paginator_config)
        except (botocore.exceptions.DataNotFoundError, botocore.exceptions.UnknownServiceError):
            self.paginated = set()

    def allowed_flags(self, op_name):
        shape = self.model.operation_model(op_name).input_shape
        allowed = set(GLOBAL_OPTIONS) | OPERATION_OPTIONS
        if op_name in self.paginated:
            allowed |= PAGINATION_OPTIONS
        if shape is not None:
            for member, member_shape in shape.members.items():
                kebab = xform_name(member, "-")
                allowed.add("--" + kebab)
                if member_shape.type_name == "boolean":
                    allowed.add("--no-" + kebab)
        return allowed

    def problems(self, inv):
        """Return a list of human-readable problems for one invocation."""
        op = inv["op"]
        where = "{}:{} ({})".format(inv["file"], inv["line"], inv["kind"])
        if "$" in op or op == "EJS":
            return []  # dynamically built op name; nothing static to check
        if op == "wait":
            waiter = inv["waiter"] or ""
            if "$" in waiter:
                return []
            if waiter not in self.waiters:
                return ["{}: unknown waiter 'aws {} wait {}'".format(where, self.service, waiter)]
            op_name = self.waiters[waiter]
        else:
            if op not in self.ops:
                return ["{}: unknown operation 'aws {} {}'".format(where, self.service, op)]
            op_name = self.ops[op]
        allowed = self.allowed_flags(op_name)
        flag_lines = inv.get("flag_lines") or [inv["line"]] * len(inv["flags"])
        shown_op = op if op != "wait" else "wait " + inv["waiter"]
        return [
            "{}:{} ({}): 'aws {} {}' has no option {} ({} input shape)".format(
                inv["file"], fl, inv["kind"], self.service, shown_op, flag, op_name)
            for flag, fl in zip(inv["flags"], flag_lines) if flag not in allowed
        ]


# Backward-compatible name for the SageMaker-only checker.
SageMakerCli = ServiceCli


@pytest.fixture(scope="module")
def clis():
    return {svc: ServiceCli(svc) for svc in SERVICES}


@pytest.fixture(scope="module")
def cli(clis):
    return clis["sagemaker"]


@pytest.fixture(scope="module")
def repo_invocations():
    return collect_repo_invocations()


# ── extractor self-tests ─────────────────────────────────────────────────────

def _flags_for(invs, op):
    return sorted(f for inv in invs if inv["op"] == op for f in inv["flags"])


def test_extractor_direct_command_with_continuations_and_multiline_json():
    text = '''
    if ! aws sagemaker create-inference-component \\
        --inference-component-name "${ic_name}" \\
        --specification "{
            \\"Container\\": ${container_spec},
            \\"X\\": $(echo "a) b")
        }" \\
        --runtime-config "{\\"CopyCount\\": 1}" \\
        --region "${AWS_REGION}"; then
        echo fail --not-a-flag
    fi
    '''
    invs = extract_invocations(text)
    assert _flags_for(invs, "create-inference-component") == sorted([
        "--inference-component-name", "--specification", "--runtime-config", "--region"])


def test_extractor_command_array_with_appends():
    text = '''
    local -a cmd_args=(
        aws sagemaker create-endpoint-config
        --endpoint-config-name "${ENDPOINT_CONFIG_NAME}"   # trailing comment --nope
    )
    if [ -n "${ROLE_ARN:-}" ]; then
        cmd_args+=(--execution-role-arn "${ROLE_ARN}")
    fi
    cmd_args+=(--container-metrics-config '{"MetricsEndpoints":[{"Port":8080}]}')
    if ! "${cmd_args[@]}"; then exit 4; fi
    '''
    invs = extract_invocations(text)
    assert _flags_for(invs, "create-endpoint-config") == sorted([
        "--endpoint-config-name", "--execution-role-arn", "--container-metrics-config"])


def test_extractor_argument_array_fed_to_command():
    text = '''
    _ARGS=(
        --ai-workload-config-name "${N}"
    )
    _ARGS+=(--region "${AWS_REGION}")
    if ! aws sagemaker create-ai-workload-config "${_ARGS[@]}"; then exit 1; fi
    '''
    invs = extract_invocations(text)
    assert _flags_for(invs, "create-ai-workload-config") == [
        "--ai-workload-config-name", "--region"]


def test_extractor_substitution_hint_comment_python_and_js():
    text = '''
    # aws sagemaker create-endpoint --bogus-in-comment
    S=$(aws sagemaker describe-endpoint --endpoint-name "$E" --query 'X' --output text 2>/dev/null)
    echo "   aws sagemaker delete-model --model-name ${M} --region ${R}"
    subprocess.run(["aws", "sagemaker", "list-inference-components",
                    "--endpoint-name-equals", ep, "--region", region])
    aws sagemaker wait endpoint-in-service --endpoint-name x
    '''
    invs = extract_invocations(text)
    assert "create-endpoint" not in {i["op"] for i in invs}
    assert _flags_for(invs, "describe-endpoint") == ["--endpoint-name", "--output", "--query"]
    assert _flags_for(invs, "delete-model") == ["--model-name", "--region"]
    assert _flags_for(invs, "list-inference-components") == ["--endpoint-name-equals", "--region"]
    assert _flags_for(invs, "wait") == ["--endpoint-name"]
    js = extract_js_invocations("return `sagemaker describe-model --model-name ${name}`;")
    assert _flags_for(js, "describe-model") == ["--model-name"]


def test_validator_rejects_the_v170_container_metrics_flag(cli):
    """The exact construct shipped in v1.7.0-v1.9.0 must be flagged."""
    text = '''
    local -a cmd_args=(
        aws sagemaker create-endpoint-config
        --endpoint-config-name "${ENDPOINT_CONFIG_NAME}"
    )
    cmd_args+=(--production-variants "${variant_json}")
    cmd_args+=(--container-metrics-config '{"MetricsEndpoints":[{"MetricsEndpointPath":"/metrics","Port":8080}]}')
    cmd_args+=(--region "${AWS_REGION}")
    '''
    problems = [p for inv in extract_invocations(text) for p in cli.problems(inv)]
    assert len(problems) == 1
    assert "--container-metrics-config" in problems[0]
    # The real optional endpoint-config metrics option is accepted.
    ok = extract_invocations("aws sagemaker create-endpoint-config --metrics-config '{}'\n")
    assert [p for inv in ok for p in cli.problems(inv)] == []


# ── the repo guard ───────────────────────────────────────────────────────────

def test_extractor_covers_required_operations(repo_invocations):
    ops = {inv["op"] for inv in repo_invocations if inv["service"] == "sagemaker"}
    missing = REQUIRED_OPERATIONS - ops
    assert not missing, "extractor found no invocation of: {}".format(sorted(missing))
    sm_ops = {inv["op"] for inv in repo_invocations if inv["service"] == "secretsmanager"}
    missing = REQUIRED_SECRETSMANAGER_OPERATIONS - sm_ops
    assert not missing, "extractor found no secretsmanager invocation of: {}".format(sorted(missing))


def test_validator_rejects_unknown_secretsmanager_flag(clis):
    text = 'v=$(aws secretsmanager get-secret-value --secret-id "$A" --secret-string x --query SecretString --output text)\n'
    problems = [p for inv in extract_invocations(text) for p in clis[inv["service"]].problems(inv)]
    assert len(problems) == 1 and "--secret-string" in problems[0]


def test_every_sagemaker_cli_flag_exists_in_service_model(clis, repo_invocations):
    problems = []
    for inv in repo_invocations:
        problems.extend(clis[inv["service"]].problems(inv))
    assert not problems, (
        "AWS CLI would reject these SageMaker options (botocore {}):\n  ".format(
            botocore.__version__) + "\n  ".join(sorted(set(problems))))
