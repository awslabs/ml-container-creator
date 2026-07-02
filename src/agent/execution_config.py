# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Execution configuration for the agent's script execution capability.

Loads permitted scripts, cost warnings, and timeout settings from
`.mlcc/agent-config.json` or falls back to sensible defaults.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_DEFAULT_PERMITTED_SCRIPTS: list[str] = [
    "do/stage",
    "do/build",
    "do/push",
    "do/submit",
]

_DEFAULT_COST_WARNINGS: dict[str, str] = {
    "do/stage": "Submits a SageMaker Processing Job (~$0.10-0.50 depending on instance)",
    "do/submit": "Submits a SageMaker Training Job (cost depends on instance \u00d7 duration)",
}

_DEFAULT_MAX_SCRIPT_TIMEOUT: int = 1800  # 30 minutes


@dataclass(frozen=True)
class ExecutionConfig:
    """Resolved execution configuration (immutable after creation)."""

    permitted_scripts: list[str] = field(default_factory=lambda: list(_DEFAULT_PERMITTED_SCRIPTS))
    cost_warnings: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_COST_WARNINGS))
    max_script_timeout: int = _DEFAULT_MAX_SCRIPT_TIMEOUT

    def is_permitted(self, script: str) -> bool:
        """Check if a script is in the permitted execution list.

        Args:
            script: Script path relative to project root (e.g., "do/stage").

        Returns:
            True if the script is allowed to be executed.
        """
        return script in self.permitted_scripts

    def get_cost_warning(self, script: str) -> str | None:
        """Get the cost warning message for a script, if any.

        Args:
            script: Script path relative to project root.

        Returns:
            Warning string if the script has cost implications, None otherwise.
        """
        return self.cost_warnings.get(script)


def load_execution_config(project_dir: Path) -> ExecutionConfig:
    """Load execution config from .mlcc/agent-config.json or use defaults.

    Args:
        project_dir: Resolved absolute path to the project root.

    Returns:
        ExecutionConfig instance with merged settings.
    """
    config_path = project_dir / ".mlcc" / "agent-config.json"

    if not config_path.is_file():
        return ExecutionConfig()

    try:
        data: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ExecutionConfig()

    permitted = data.get("permitted_scripts")
    if not isinstance(permitted, list) or not all(isinstance(s, str) for s in permitted):
        permitted = list(_DEFAULT_PERMITTED_SCRIPTS)

    cost_warnings = data.get("cost_warnings")
    if not isinstance(cost_warnings, dict):
        cost_warnings = dict(_DEFAULT_COST_WARNINGS)

    timeout = data.get("max_script_timeout")
    if not isinstance(timeout, int) or timeout <= 0:
        timeout = _DEFAULT_MAX_SCRIPT_TIMEOUT

    return ExecutionConfig(
        permitted_scripts=permitted,
        cost_warnings=cost_warnings,
        max_script_timeout=timeout,
    )
