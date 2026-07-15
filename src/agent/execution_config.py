# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Execution configuration for the agent's script execution capability.

Loads permitted scripts, cost warnings, timeout settings, and confirmation
policy from `.mlcc/agent-config.json` or falls back to sensible defaults.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_DEFAULT_PERMITTED_SCRIPTS: list[str] = [
    'do/stage',
    'do/build',
    'do/push',
    'do/submit',
    'do/validate'
]

_DEFAULT_COST_WARNINGS: dict[str, str] = {
    'do/stage': 'Submits a SageMaker Processing Job (~$0.10-0.50 depending on instance)',
    'do/submit': 'Submits a CodeBuild job to build and push the Docker image to ECR (~$0.10-0.30, ~5-15 min)',
}

_DEFAULT_MAX_SCRIPT_TIMEOUT: int = 1800  # 30 minutes

_DEFAULT_SCRIPT_CLASSES: dict[str, str] = {
    # auto — safe, read-only or idempotent
    'do/test': 'auto',
    'do/status': 'auto',
    'do/logs': 'auto',
    'do/validate': 'auto',
    'do/export': 'auto',
    'do/ci': 'auto',
    # confirm — mutating, costly, or destructive
    'do/stage': 'confirm',
    'do/build': 'confirm',
    'do/push': 'confirm',
    'do/submit': 'confirm',
    'do/deploy': 'confirm',
    'do/tune': 'confirm',
    'do/train': 'confirm',
    'do/adapter': 'confirm',
    'do/clean': 'confirm',
    'do/register': 'confirm',
    'do/optimize': 'confirm',
    'do/benchmark': 'confirm',
}


@dataclass(frozen=True)
class ExecutionConfig:
    """Resolved execution configuration (immutable after creation)."""

    permitted_scripts: list[str] = field(default_factory=lambda: list(_DEFAULT_PERMITTED_SCRIPTS))
    cost_warnings: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_COST_WARNINGS))
    max_script_timeout: int = _DEFAULT_MAX_SCRIPT_TIMEOUT
    script_classes: dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_SCRIPT_CLASSES))
    mode: str = 'default'

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

    def decide(self, script: str) -> str:
        """Determine confirmation policy for a script.

        Args:
            script: Script path relative to project root (e.g., "do/test").

        Returns:
            "auto" (skip confirmation) or "confirm" (require user approval).
        """
        if self.mode == 'all':
            return 'confirm'
        if self.mode == 'none':
            return 'auto'
        # mode == "default": consult script_classes, default to "confirm"
        return self.script_classes.get(script, 'confirm')


def load_execution_config(project_dir: Path) -> ExecutionConfig:
    """Load execution config from .mlcc/agent-config.json or use defaults.

    Args:
        project_dir: Resolved absolute path to the project root.

    Returns:
        ExecutionConfig instance with merged settings.
    """
    config_path = project_dir / '.mlcc' / 'agent-config.json'

    if not config_path.is_file():
        return ExecutionConfig()

    try:
        data: dict[str, Any] = json.loads(config_path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return ExecutionConfig()

    permitted = data.get('permitted_scripts')
    if not isinstance(permitted, list) or not all(isinstance(s, str) for s in permitted):
        permitted = list(_DEFAULT_PERMITTED_SCRIPTS)

    cost_warnings = data.get('cost_warnings')
    if not isinstance(cost_warnings, dict):
        cost_warnings = dict(_DEFAULT_COST_WARNINGS)

    timeout = data.get('max_script_timeout')
    if not isinstance(timeout, int) or timeout <= 0:
        timeout = _DEFAULT_MAX_SCRIPT_TIMEOUT

    # Confirmation policy fields
    confirmation = data.get('confirmation', {})
    if not isinstance(confirmation, dict):
        confirmation = {}

    mode = confirmation.get('mode', 'default')
    if mode not in ('default', 'all', 'none'):
        mode = 'default'

    script_classes_raw = confirmation.get('scriptClasses')
    if isinstance(script_classes_raw, dict) and all(
        isinstance(k, str) and v in ('auto', 'confirm')
        for k, v in script_classes_raw.items()
    ):
        # Merge: start with defaults, overlay with config-file values
        script_classes = dict(_DEFAULT_SCRIPT_CLASSES)
        script_classes.update(script_classes_raw)
    else:
        script_classes = dict(_DEFAULT_SCRIPT_CLASSES)

    return ExecutionConfig(
        permitted_scripts=permitted,
        cost_warnings=cost_warnings,
        max_script_timeout=timeout,
        script_classes=script_classes,
        mode=mode,
    )
