# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Package marker for agent unit tests.

Intentionally does NOT add ``src/agent/`` to ``sys.path``. Doing so changes
module identity for the sibling-import fallback modules (``chain_runner`` imports
``tools.execute_script`` under the bare name, while tests use
``src.agent.tools.execute_script``), which breaks the shared ``_execution_log``
singleton and MCP config monkeypatching.

Instead, ``src/agent/agent.py`` uses a ``try/except ModuleNotFoundError`` import
fallback so it is importable both as ``src.agent.agent`` (tests, via the
project-root ``pythonpath``) and as a bare script (production).
"""
