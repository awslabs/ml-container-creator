# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Agent configuration loader.

Reads config/agent.json, applies MCC_* environment variable overrides,
validates values, and returns a resolved AgentConfig dataclass.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class AgentConfig:
    """Resolved agent configuration (immutable after creation)."""

    model_id: str
    provider: str
    mcp_servers: list[str]
    input_cost_per_1k: float
    output_cost_per_1k: float
    exit_commands: list[str]
    reload_commands: list[str]
    mcp_server_timeout: int


_DEFAULTS = AgentConfig(
    model_id="us.anthropic.claude-sonnet-4-20250514",
    provider="bedrock",
    mcp_servers=[
        "instance-sizer",
        "base-image-picker",
        "model-picker",
        "workload-picker",
        "e2e-status",
        "agent-knowledge",
    ],
    input_cost_per_1k=0.003,
    output_cost_per_1k=0.015,
    exit_commands=["exit", "quit", "bye", "q"],
    reload_commands=["reload"],
    mcp_server_timeout=30,
)


def _warn(msg: str) -> None:
    """Emit a config warning to stderr."""
    print(f"[config] warning: {msg}", file=sys.stderr)


def _resolve_field(
    field_name: str,
    env_var: str | None,
    file_value: Any | None,
    default_value: Any,
    parser: Callable[[str], Any],
    validator: Callable[[Any], bool],
) -> Any:
    """Resolve a single config field using the precedence chain.

    1. Try env var → parse → validate
    2. Try file value → validate
    3. Return default
    """
    # 1. Environment override
    if env_var:
        raw = os.environ.get(env_var)
        if raw is not None:
            try:
                parsed = parser(raw)
                if validator(parsed):
                    return parsed
                else:
                    _warn(f"{env_var}={raw!r} failed validation, skipping")
            except (ValueError, TypeError) as e:
                _warn(f"{env_var}={raw!r} cannot be parsed: {e}")

    # 2. Config file value
    if file_value is not None:
        if validator(file_value):
            return file_value
        else:
            _warn(
                f"config field '{field_name}' has invalid value {file_value!r}, using default"
            )

    # 3. Hardcoded default
    return default_value


def load_agent_config(config_path: Path | None = None) -> AgentConfig:
    """Load, validate, and resolve agent configuration.

    Resolution order per parameter (highest to lowest):
      1. MCC_* environment variable (if set and valid)
      2. Value from config/agent.json (if file exists and value is valid)
      3. Hardcoded default

    Args:
        config_path: Override path to the JSON config file.
                     Defaults to <package_root>/config/agent.json.

    Returns:
        Fully-resolved AgentConfig instance.
    """
    if config_path is None:
        package_root = Path(__file__).resolve().parent.parent.parent
        config_path = package_root / "config" / "agent.json"

    # Read and parse config file
    file_data: dict[str, Any] = {}
    if config_path.exists():
        try:
            file_data = json.loads(config_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError) as e:
            _warn(f"config file '{config_path}' contains invalid JSON: {e}")
    else:
        _warn(f"config file '{config_path}' not found, using defaults")

    # Parsers
    _parse_str: Callable[[str], str] = lambda x: x
    _parse_list: Callable[[str], list[str]] = lambda raw: [
        s.strip() for s in raw.split(",")
    ]
    _parse_float: Callable[[str], float] = float
    _parse_int: Callable[[str], int] = int

    # Validators
    _valid_str: Callable[[Any], bool] = lambda v: isinstance(v, str)
    _valid_list_str: Callable[[Any], bool] = lambda v: isinstance(v, list) and all(
        isinstance(s, str) for s in v
    )
    _valid_float_nn: Callable[[Any], bool] = (
        lambda v: isinstance(v, (int, float)) and v >= 0
    )
    _valid_int_nn: Callable[[Any], bool] = lambda v: isinstance(v, int) and v >= 0

    # Resolve each field
    model_id = _resolve_field(
        "modelId",
        "MCC_MODEL_ID",
        file_data.get("modelId"),
        _DEFAULTS.model_id,
        _parse_str,
        _valid_str,
    )

    mcp_servers = _resolve_field(
        "mcpServers",
        "MCC_MCP_SERVERS",
        file_data.get("mcpServers"),
        _DEFAULTS.mcp_servers,
        _parse_list,
        _valid_list_str,
    )

    input_cost_per_1k = _resolve_field(
        "inputCostPer1k",
        "MCC_INPUT_COST_PER_1K",
        file_data.get("inputCostPer1k"),
        _DEFAULTS.input_cost_per_1k,
        _parse_float,
        _valid_float_nn,
    )

    output_cost_per_1k = _resolve_field(
        "outputCostPer1k",
        "MCC_OUTPUT_COST_PER_1K",
        file_data.get("outputCostPer1k"),
        _DEFAULTS.output_cost_per_1k,
        _parse_float,
        _valid_float_nn,
    )

    exit_commands = _resolve_field(
        "exitCommands",
        "MCC_EXIT_COMMANDS",
        file_data.get("exitCommands"),
        _DEFAULTS.exit_commands,
        _parse_list,
        _valid_list_str,
    )

    reload_commands = _resolve_field(
        "reloadCommands",
        "MCC_RELOAD_COMMANDS",
        file_data.get("reloadCommands"),
        _DEFAULTS.reload_commands,
        _parse_list,
        _valid_list_str,
    )

    mcp_server_timeout = _resolve_field(
        "mcpServerTimeout",
        "MCC_MCP_SERVER_TIMEOUT",
        file_data.get("mcpServerTimeout"),
        _DEFAULTS.mcp_server_timeout,
        _parse_int,
        _valid_int_nn,
    )

    provider = _resolve_field(
        "provider",
        "MCC_PROVIDER",
        file_data.get("provider"),
        _DEFAULTS.provider,
        str,
        lambda v: v in ("bedrock", "claude-direct"),
    )

    return AgentConfig(
        model_id=model_id,
        provider=provider,
        mcp_servers=mcp_servers,
        input_cost_per_1k=input_cost_per_1k,
        output_cost_per_1k=output_cost_per_1k,
        exit_commands=exit_commands,
        reload_commands=reload_commands,
        mcp_server_timeout=mcp_server_timeout,
    )
