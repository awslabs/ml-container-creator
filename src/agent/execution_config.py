# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Execution configuration for the agent's script execution capability.

Loads the unified script permission model, cost warnings, timeout settings,
and confirmation policy from `.mlcc/agent-config.json` or falls back to sensible
defaults.

Permissions use a single three-state `script_classes` model:

    'auto'    — execute without confirmation
    'confirm' — execute only after user approval
    'denied'  — never execute

Any script not present in `script_classes` inherits `default_class`
(default: 'confirm'). The system is opt-out, not opt-in: unknown scripts are
permitted (requiring confirmation) rather than blocked.
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
    'do/validate',
    'do/deploy',
    'do/test',
    'do/status',
    'do/logs',
    'do/benchmark',
    'do/register',
    'do/optimize',
    'do/clean',
]

_DEFAULT_COST_WARNINGS: dict[str, str] = {
    'do/stage': 'Submits a SageMaker Processing Job (~$0.10-0.50 depending on instance)',
    'do/submit': 'Submits a CodeBuild job to build and push the Docker image to ECR (~$0.10-0.30, ~5-15 min)',
}

_DEFAULT_MAX_SCRIPT_TIMEOUT: int = 1800  # 30 minutes

# Full ordered list of do/ scripts the system knows about. Used for
# backward-compat synthesis of 'denied' entries when a legacy allow-list
# (`permitted_scripts`) is present. Mirrors the ordering used by
# `mcc hey config permissions`.
_KNOWN_SCRIPTS: list[str] = [
    'do/stage',
    'do/submit',
    'do/deploy',
    'do/test',
    'do/status',
    'do/logs',
    'do/benchmark',
    'do/register',
    'do/optimize',
    'do/clean',
    'do/build',
    'do/push',
    'do/validate',
    'do/tune',
    'do/train',
    'do/adapter',
    'do/ci',
    'do/export',
    'do/evaluate',
    'do/add-ic',
]

# Valid permission classes for the unified three-state model.
_VALID_CLASSES: frozenset[str] = frozenset({'auto', 'confirm', 'denied'})

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
    default_class: str = 'confirm'
    mode: str = 'default'
    venv_path: str | None = None

    def is_permitted(self, script: str) -> bool:
        """Check whether a script is allowed to execute.

        Under the unified three-state model, a script is permitted unless its
        resolved class is 'denied'. Scripts absent from `script_classes` inherit
        `default_class` (opt-out: unknown scripts are permitted by default).

        Args:
            script: Script path relative to project root (e.g., "do/stage").

        Returns:
            True if the script is allowed to be executed (class != 'denied').
        """
        return self.script_classes.get(script, self.default_class) != 'denied'

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
            "auto" (skip confirmation), "confirm" (require user approval), or
            "denied" (must not execute).
        """
        if self.mode == 'all':
            return 'confirm'
        if self.mode == 'none':
            return 'auto'
        # mode == "default": consult script_classes, fall back to default_class.
        return self.script_classes.get(script, self.default_class)


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
    permitted_present = isinstance(permitted, list) and all(isinstance(s, str) for s in permitted)
    if not permitted_present:
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

    default_class = confirmation.get('default_class', 'confirm')
    if default_class not in _VALID_CLASSES:
        default_class = 'confirm'

    script_classes_raw = confirmation.get('script_classes')
    if script_classes_raw is None:
        # Legacy camelCase fallback (pre-BL079 config files). New schema uses
        # snake_case `script_classes`; `scriptClasses` is kept for backward compat.
        script_classes_raw = confirmation.get('scriptClasses')

    # Merge: start with defaults, overlay valid config-file values. The unified
    # model accepts three values: 'auto', 'confirm', 'denied'.
    script_classes = dict(_DEFAULT_SCRIPT_CLASSES)
    if isinstance(script_classes_raw, dict):
        for key, value in script_classes_raw.items():
            if isinstance(key, str) and value in _VALID_CLASSES:
                script_classes[key] = value

    # Backward compat: when a legacy `permitted_scripts` allow-list is present,
    # synthesize 'denied' entries for every known script not on the list. This
    # preserves the old opt-in semantics for pre-existing config files. Explicit
    # `script_classes` overrides above still win for any listed script.
    if permitted_present:
        allowed = set(permitted)
        explicit = set(script_classes_raw) if isinstance(script_classes_raw, dict) else set()
        for known in _KNOWN_SCRIPTS:
            if known not in allowed and known not in explicit:
                script_classes[known] = 'denied'

    # venv_path (BL079): location of the dedicated advisory-agent virtual env.
    venv_path = data.get('venv_path')
    if not isinstance(venv_path, str) or not venv_path:
        venv_path = None

    return ExecutionConfig(
        permitted_scripts=permitted,
        cost_warnings=cost_warnings,
        max_script_timeout=timeout,
        script_classes=script_classes,
        default_class=default_class,
        mode=mode,
        venv_path=venv_path,
    )
