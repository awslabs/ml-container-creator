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
