"""Conftest for unit tests — ensures decomposed helper sub-modules are importable.

After helper decomposition, tests that patch module-level constants need the
sub-modules to be in sys.modules so patch("module_name.attr") works.
"""
import json
import os
import sys
from typing import Any

import pytest

# Add the decomposed modules to sys.path
_LIB_PYTHON = os.path.join(
    os.path.dirname(__file__), '..', '..', 'templates', 'do', 'lib', 'python'
)
_LIB_PYTHON = os.path.normpath(_LIB_PYTHON)
if _LIB_PYTHON not in sys.path:
    sys.path.insert(0, _LIB_PYTHON)

# Pre-import sub-modules so patch("register_dataset._DATASETS_REGISTRY") works
try:
    import register_common  # noqa: E402, F401
    import register_dataset  # noqa: E402, F401
    import register_resolve  # noqa: E402, F401
    import register_model  # noqa: E402, F401
    import register_list  # noqa: E402, F401
except (ImportError, SyntaxError):
    pass  # Non-deploy tests can still run


# ---------------------------------------------------------------------------
# MCP mock fixture (NFR-3.2)
# ---------------------------------------------------------------------------


@pytest.fixture
def mcp_mock_responses(monkeypatch: pytest.MonkeyPatch):
    """Fixture that sets $MCP_MOCK_RESPONSES for MCP-dependent tests.

    Provides a callable that accepts a dict of mock responses keyed by
    tool name (e.g. "instance-sizer/recommend") and sets the env var.
    Automatically cleans up after the test.

    Usage in tests:
        def test_example(mcp_mock_responses):
            mcp_mock_responses({
                "instance-sizer/recommend": {"instance_type": "ml.g5.xlarge"},
                "endpoint-picker/list": {"endpoints": [...]},
                "cluster-picker/list": {"clusters": [...]},
            })
            # Now discover_mcp() returns a mock client
            # and call_tool() returns the pre-configured responses

    Returns:
        A callable that takes a dict[str, Any] of mock responses.
    """

    def _set_mock(responses: dict[str, Any]) -> None:
        monkeypatch.setenv("MCP_MOCK_RESPONSES", json.dumps(responses))

    # Ensure MCP_SOCKET doesn't interfere
    monkeypatch.delenv("MCP_SOCKET", raising=False)

    return _set_mock


# ---------------------------------------------------------------------------
# Wave 10 (ADR-014): scale-to-zero shell sandbox with a stubbed `aws` CLI
# ---------------------------------------------------------------------------

_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_DO_SRC = os.path.join(_REPO_ROOT, 'templates', 'do')

# The stub logs every argv as one JSON line and answers from rules.json:
# [{"match": [substr, ...], "rc": 0, "stdout": "", "stderr": "", "times": N}, ...]
# The first rule whose substrings all occur in the joined argv wins; a rule
# with "times" is used that many times. Unmatched calls succeed silently.
_STUB_AWS = r'''#!/usr/bin/env python3
import json, os, sys
root = os.environ["STZ_SANDBOX"]
argv = sys.argv[1:]
with open(os.path.join(root, "aws.log"), "a") as f:
    f.write(json.dumps(argv) + "\n")
path = os.path.join(root, "rules.json")
rules = json.load(open(path)) if os.path.exists(path) else []
joined = " ".join(argv)
for rule in rules:
    if all(m in joined for m in rule.get("match", [])):
        if "times" in rule:
            if rule["times"] <= 0:
                continue
            rule["times"] -= 1
            json.dump(rules, open(path, "w"))
        sys.stdout.write(rule.get("stdout", ""))
        sys.stderr.write(rule.get("stderr", ""))
        sys.exit(rule.get("rc", 0))
sys.exit(0)
'''


class StzSandbox:
    """A throwaway project: do/lib (the REAL scale-to-zero.sh and friends),
    do/targets.d, a do/manifest stub and a stub `aws` on PATH."""

    LIBS = ('scale-to-zero.sh', 'endpoint-config.sh', 'wait.sh', 'aws-preflight.sh')
    PYS = ('scale_to_zero.py', 'target_manifest.py')
    DATA = ('scale_to_zero_reference.json',)

    def __init__(self, root):
        import shutil
        self.root = str(root)
        self.do = os.path.join(self.root, 'do')
        os.makedirs(os.path.join(self.do, 'lib', 'python'))
        os.makedirs(os.path.join(self.root, 'bin'))
        for lib in self.LIBS:
            shutil.copy(os.path.join(_DO_SRC, 'lib', lib), os.path.join(self.do, 'lib', lib))
        for py in self.PYS + self.DATA:
            src = os.path.join(_DO_SRC, 'lib', 'python', py)
            if os.path.exists(src):
                shutil.copy(src, os.path.join(self.do, 'lib', 'python', py))
        shutil.copytree(os.path.join(_DO_SRC, 'targets.d'), os.path.join(self.do, 'targets.d'))
        self.write('do/config', 'export PROJECT_NAME="stz"\n')
        self.write('do/manifest', '#!/bin/bash\necho "$*" >> "%s/manifest.log"\n' % self.root, 0o755)
        self.write('bin/aws', _STUB_AWS, 0o755)

    def write(self, rel, text, mode=0o644):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(text)
        os.chmod(path, mode)
        return path

    def rules(self, rules):
        self.write('rules.json', json.dumps(rules))

    def calls(self):
        path = os.path.join(self.root, 'aws.log')
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()]

    def manifest_calls(self):
        path = os.path.join(self.root, 'manifest.log')
        return open(path).read().splitlines() if os.path.exists(path) else []

    def config(self):
        return open(os.path.join(self.do, 'config')).read()

    def reset_logs(self):
        for name in ('aws.log', 'manifest.log', 'rules.json'):
            p = os.path.join(self.root, name)
            if os.path.exists(p):
                os.remove(p)

    def run(self, body, env=None):
        """Run ``body`` in /bin/bash (3.2 on macOS) with the lib sourced."""
        import subprocess
        script = self.write('do/_snippet', '\n'.join([
            '#!/bin/bash',
            'set -e', 'set -u', 'set -o pipefail',
            'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
            'source "${SCRIPT_DIR}/config"',
            'source "${SCRIPT_DIR}/lib/wait.sh"',
            'source "${SCRIPT_DIR}/lib/scale-to-zero.sh"',
            body, '']), 0o755)
        full_env = dict(os.environ)
        full_env.pop('VIRTUAL_ENV', None)
        full_env.pop('AWS_PROFILE', None)
        full_env.update({
            'PATH': os.path.join(self.root, 'bin') + os.pathsep + full_env.get('PATH', ''),
            'STZ_SANDBOX': self.root,
            'AWS_REGION': 'us-east-1',
            'TMPDIR': self.root,
        })
        full_env.update(env or {})
        bash = '/bin/bash' if os.path.exists('/bin/bash') else 'bash'
        r = subprocess.run([bash, script], env=full_env, capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout, r.stderr


@pytest.fixture
def stz_sandbox(tmp_path):
    """A scale-to-zero shell sandbox (see StzSandbox)."""
    return StzSandbox(tmp_path)
