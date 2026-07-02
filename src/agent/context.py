# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Project context reader for the Strands agent.

Parses all project configuration files into a structured dict for prompt injection.
Pure file I/O and regex/YAML parsing — no subprocess calls.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import yaml


# Regex patterns for shell export parsing
# Matches: export KEY="VALUE"  or  export KEY='VALUE'  or  export KEY=VALUE
_EXPORT_QUOTED_RE = re.compile(
    r"""^export\s+([A-Za-z_][A-Za-z0-9_]*)=["'](.*)["']\s*$"""
)
# Matches: export KEY=${KEY:-DEFAULT}
_EXPORT_DEFAULT_RE = re.compile(
    r"""^export\s+([A-Za-z_][A-Za-z0-9_]*)=\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}\s*$"""
)
# Matches: export KEY=VALUE (unquoted, no spaces in value)
_EXPORT_BARE_RE = re.compile(
    r"""^export\s+([A-Za-z_][A-Za-z0-9_]*)=([^\s"'$][^\s]*)\s*$"""
)
# Matches: export KEY="" (empty quoted value)
_EXPORT_EMPTY_RE = re.compile(
    r"""^export\s+([A-Za-z_][A-Za-z0-9_]*)=["']["']\s*$"""
)

# Dockerfile patterns
_FROM_RE = re.compile(r"^FROM\s+(.+?)(?:\s+AS\s+\S+)?\s*$", re.IGNORECASE)
_ENTRYPOINT_RE = re.compile(r"^ENTRYPOINT\s+(.+)\s*$", re.IGNORECASE)


class ProjectContext:
    """Reads and structures all project configuration for the agent.

    Parses do/config, do/ic/*.conf, do/training/config.yaml, Dockerfile,
    do/adapters/*.conf, the bootstrap profile, and user context files into
    a unified dict suitable for LLM prompt injection.
    """

    def __init__(self, project_dir: str) -> None:
        """Initialize with the project root directory.

        Args:
            project_dir: Absolute or relative path to the project root
                         (the directory containing do/config).
        """
        self.project_dir = Path(project_dir).resolve()

    def load(self) -> dict[str, Any]:
        """Load all context. Returns structured dict for prompt injection.

        Gracefully handles missing files — partial context is returned with
        a ``_missing`` field listing files that could not be parsed.

        Returns:
            Dict with project configuration structured for prompt injection.
        """
        missing: list[str] = []

        do_config = self._parse_do_config(missing)
        ic_env_vars = self._parse_ic_confs(missing)
        training_config = self._parse_training_config(missing)
        dockerfile_info = self._parse_dockerfile(missing)
        adapters = self._parse_adapters(missing)
        profile = self._load_profile(missing)
        user_context = self._load_user_context(missing)

        context: dict[str, Any] = {
            "project_name": do_config.get("PROJECT_NAME"),
            "engine": do_config.get("MODEL_SERVER"),
            "deployment_target": do_config.get("DEPLOYMENT_TARGET"),
            "model": do_config.get("HF_MODEL_ID") or do_config.get("MODEL_NAME"),
            "instance_type": do_config.get("INSTANCE_TYPE"),
            "aws_region": do_config.get("AWS_REGION"),
            "lora_enabled": do_config.get("ENABLE_LORA", "").lower() == "true",
            "existing_endpoint": do_config.get("ENDPOINT_NAME")
            if do_config.get("ENDPOINT_EXTERNAL") == "true"
            else None,
            "do_config_vars": do_config,
            "ic_env_vars": ic_env_vars,
            "training_config": training_config,
            "base_image": dockerfile_info.get("base_image"),
            "entrypoint": dockerfile_info.get("entrypoint"),
            "adapters": adapters,
            "profile": profile,
            "user_context": user_context,
        }

        if missing:
            context["_missing"] = missing

        return context

    def _parse_do_config(self, missing: list[str]) -> dict[str, str]:
        """Parse do/config — regex for export KEY=VALUE lines.

        Handles:
          - export KEY="VALUE"
          - export KEY='VALUE'
          - export KEY=${KEY:-DEFAULT}
          - export KEY=VALUE (bare, no spaces)
          - Multi-line values via single-quoted heredoc-style (rare but possible)

        Args:
            missing: Accumulator list for files that could not be found/parsed.

        Returns:
            Dict of variable names to their values.
        """
        config_path = self.project_dir / "do" / "config"
        if not config_path.is_file():
            missing.append("do/config")
            return {}

        return self._parse_shell_exports(config_path)

    def _parse_ic_confs(self, missing: list[str]) -> dict[str, dict[str, str]]:
        """Parse do/ic/*.conf — IC_ENV_* variables grouped by filename.

        Args:
            missing: Accumulator list for files that could not be found/parsed.

        Returns:
            Dict mapping conf filename (without .conf) to a dict of variables.
        """
        ic_dir = self.project_dir / "do" / "ic"
        if not ic_dir.is_dir():
            missing.append("do/ic/")
            return {}

        result: dict[str, dict[str, str]] = {}
        conf_files = sorted(ic_dir.glob("*.conf"))

        if not conf_files:
            missing.append("do/ic/*.conf")
            return {}

        for conf_path in conf_files:
            name = conf_path.stem
            result[name] = self._parse_shell_exports(conf_path)

        return result

    def _parse_training_config(self, missing: list[str]) -> dict[str, Any] | None:
        """Parse do/training/config.yaml via yaml.safe_load().

        Extracts key fields: technique, instance_type, hyperparameters,
        dataset, image, and any other top-level keys.

        Args:
            missing: Accumulator list for files that could not be found/parsed.

        Returns:
            Parsed YAML dict, or None if file is missing/invalid.
        """
        yaml_path = self.project_dir / "do" / "training" / "config.yaml"
        if not yaml_path.is_file():
            missing.append("do/training/config.yaml")
            return None

        try:
            text = yaml_path.read_text(encoding="utf-8")
            data = yaml.safe_load(text)
            if not isinstance(data, dict):
                missing.append("do/training/config.yaml (invalid format)")
                return None
            return data
        except (yaml.YAMLError, OSError):
            missing.append("do/training/config.yaml (parse error)")
            return None

    def _parse_dockerfile(self, missing: list[str]) -> dict[str, str | None]:
        """Extract FROM image and ENTRYPOINT from Dockerfile.

        Args:
            missing: Accumulator list for files that could not be found/parsed.

        Returns:
            Dict with 'base_image' and 'entrypoint' keys.
        """
        dockerfile_path = self.project_dir / "Dockerfile"
        if not dockerfile_path.is_file():
            missing.append("Dockerfile")
            return {"base_image": None, "entrypoint": None}

        try:
            lines = dockerfile_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            missing.append("Dockerfile (read error)")
            return {"base_image": None, "entrypoint": None}

        base_image: str | None = None
        entrypoint: str | None = None

        for line in lines:
            stripped = line.strip()

            # Take the last FROM (multi-stage build — final stage is what runs)
            match = _FROM_RE.match(stripped)
            if match:
                base_image = match.group(1).strip()

            match = _ENTRYPOINT_RE.match(stripped)
            if match:
                entrypoint = match.group(1).strip()

        return {"base_image": base_image, "entrypoint": entrypoint}

    def _parse_adapters(self, missing: list[str]) -> list[dict[str, Any]]:
        """List do/adapters/*.conf with adapter names and key variables.

        Args:
            missing: Accumulator list for files that could not be found/parsed.

        Returns:
            List of dicts with 'name' and 'vars' for each adapter conf file.
        """
        adapters_dir = self.project_dir / "do" / "adapters"
        if not adapters_dir.is_dir():
            missing.append("do/adapters/")
            return []

        conf_files = sorted(adapters_dir.glob("*.conf"))
        if not conf_files:
            missing.append("do/adapters/*.conf")
            return []

        adapters: list[dict[str, Any]] = []
        for conf_path in conf_files:
            name = conf_path.stem
            variables = self._parse_shell_exports(conf_path)
            adapters.append({"name": name, "vars": variables})

        return adapters

    def _load_profile(self, missing: list[str]) -> dict[str, Any] | None:
        """Load bootstrap profile from ~/.ml-container-creator/config.json.

        Reads the config file, finds the active profile, and returns its
        config object.

        Args:
            missing: Accumulator list for files that could not be found/parsed.

        Returns:
            Active profile config dict, or None if unavailable.
        """
        config_path = Path.home() / ".ml-container-creator" / "config.json"
        if not config_path.is_file():
            missing.append("~/.ml-container-creator/config.json")
            return None

        try:
            text = config_path.read_text(encoding="utf-8")
            data = json.loads(text)
        except (json.JSONDecodeError, OSError):
            missing.append("~/.ml-container-creator/config.json (parse error)")
            return None

        if not isinstance(data, dict):
            missing.append("~/.ml-container-creator/config.json (invalid format)")
            return None

        active_name = data.get("activeProfile")
        profiles = data.get("profiles")

        if not active_name or not isinstance(profiles, dict):
            return {"_raw": data, "_note": "no active profile set"}

        profile_config = profiles.get(active_name)
        if profile_config is None:
            return {"_raw": data, "_note": f"active profile '{active_name}' not found in profiles"}

        return {"name": active_name, "config": profile_config}

    def _load_user_context(self, missing: list[str]) -> str | None:
        """Read .mlcc-agent-context.md if it exists in project root.

        This file allows teams to inject custom patterns, conventions,
        and project-specific guidance into the agent's system prompt.

        Args:
            missing: Accumulator list for files that could not be found/parsed.

        Returns:
            File contents as string, or None if file doesn't exist.
        """
        context_path = self.project_dir / ".mlcc-agent-context.md"
        if not context_path.is_file():
            # This is optional — do not add to missing
            return None

        try:
            return context_path.read_text(encoding="utf-8")
        except OSError:
            missing.append(".mlcc-agent-context.md (read error)")
            return None

    def _parse_shell_exports(self, file_path: Path) -> dict[str, str]:
        """Parse shell export statements from a file.

        Handles multiple patterns:
          - export KEY="VALUE"
          - export KEY='VALUE'
          - export KEY=${KEY:-DEFAULT}
          - export KEY=BARE_VALUE
          - Multi-line values with trailing backslash continuation

        Lines starting with # are treated as comments and skipped.
        Lines that are not export statements are skipped.

        Args:
            file_path: Path to the shell file to parse.

        Returns:
            Dict of variable names to their string values.
        """
        try:
            content = file_path.read_text(encoding="utf-8")
        except OSError:
            return {}

        variables: dict[str, str] = {}
        lines = content.splitlines()
        i = 0

        while i < len(lines):
            line = lines[i]
            stripped = line.strip()

            # Skip comments and empty lines
            if not stripped or stripped.startswith("#"):
                i += 1
                continue

            # Handle line continuation (trailing backslash)
            while stripped.endswith("\\") and i + 1 < len(lines):
                i += 1
                stripped = stripped[:-1] + lines[i].strip()

            # Try each pattern in order of specificity
            match = _EXPORT_EMPTY_RE.match(stripped)
            if match:
                variables[match.group(1)] = ""
                i += 1
                continue

            match = _EXPORT_QUOTED_RE.match(stripped)
            if match:
                variables[match.group(1)] = match.group(2)
                i += 1
                continue

            match = _EXPORT_DEFAULT_RE.match(stripped)
            if match:
                variables[match.group(1)] = match.group(2)
                i += 1
                continue

            match = _EXPORT_BARE_RE.match(stripped)
            if match:
                variables[match.group(1)] = match.group(2)
                i += 1
                continue

            i += 1

        return variables
