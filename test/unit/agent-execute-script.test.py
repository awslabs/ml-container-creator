# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for src/agent/tools/execute_script.py — the execute_script tool.

Tests cover:
- Permitted script → confirmation → approved → subprocess runs → success
- Permitted script → declined → skipped
- Non-permitted script → refused immediately
- Script not found on disk → refused with available list
- Script not executable → refused
- Invalid flag format → refused
- Script fails (exit 1) → failure status with output tail
- Cost warning display for do/submit
- Config override: custom permitted list from .mlcc/agent-config.json
- Timeout: script exceeds max timeout → SIGTERM sent, status "timeout"
- Session execution log tracking
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.agent.execution_config import ExecutionConfig, load_execution_config
from src.agent.tools.execute_script import (
    clear_execution_log,
    create_execute_script_tool,
    get_execution_log,
)


@pytest.fixture
def project_dir(tmp_path):
    """Create a minimal project with do/ scripts."""
    do_dir = tmp_path / "do"
    do_dir.mkdir()

    # Create permitted scripts
    for script_name in ("stage", "build", "push", "submit"):
        script = do_dir / script_name
        script.write_text("#!/bin/bash\necho 'running'\n")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)

    return tmp_path


@pytest.fixture
def config():
    """Default execution config."""
    return ExecutionConfig()


@pytest.fixture(autouse=True)
def reset_log():
    """Clear execution log between tests."""
    clear_execution_log()
    yield
    clear_execution_log()


class TestPermissionChecks:
    """Tests for the permission and validation gates."""

    def test_non_permitted_script_refused(self, project_dir, config):
        """Script not in permitted list is refused immediately."""
        tool = create_execute_script_tool(project_dir, config)
        result = tool(script="do/deploy", flags=[])
        assert result["status"] == "refused"
        assert "not in my permitted list" in result["reason"]

    def test_script_not_on_disk_refused(self, tmp_path, config):
        """Script in permitted list but missing from disk is refused."""
        # No do/ directory at all
        tool = create_execute_script_tool(tmp_path, config)
        result = tool(script="do/stage", flags=[])
        assert result["status"] == "refused"
        assert "not found" in result["reason"]

    def test_script_not_executable_refused(self, project_dir, config):
        """Script exists but is not executable → refused."""
        script = project_dir / "do" / "stage"
        script.chmod(stat.S_IRUSR | stat.S_IWUSR)  # Remove execute bit

        tool = create_execute_script_tool(project_dir, config)
        result = tool(script="do/stage", flags=[])
        assert result["status"] == "refused"
        assert "not executable" in result["reason"]

    def test_invalid_flag_format_refused(self, project_dir, config):
        """Flags not matching --flag-name pattern are refused."""
        tool = create_execute_script_tool(project_dir, config)
        result = tool(script="do/build", flags=["-rf"])
        assert result["status"] == "refused"
        assert "invalid flag format" in result["reason"].lower()

    def test_invalid_flag_with_semicolon_refused(self, project_dir, config):
        """Flags containing shell metacharacters are refused."""
        tool = create_execute_script_tool(project_dir, config)
        result = tool(script="do/build", flags=["; rm -rf /"])
        assert result["status"] == "refused"

    def test_valid_flag_formats_accepted(self, project_dir, config):
        """Valid --flag and --flag=value formats pass validation."""
        tool = create_execute_script_tool(project_dir, config)
        # We'll mock input to decline, just checking flags pass validation
        with patch("builtins.input", return_value="n"):
            result = tool(
                script="do/build",
                flags=["--force", "--instance-type=ml.g5.xlarge"],
            )
        assert result["status"] == "skipped"  # Declined, but flags were valid


class TestConfirmation:
    """Tests for the user confirmation gate."""

    def test_user_declines_returns_skipped(self, project_dir, config):
        """User typing 'n' results in skipped status."""
        tool = create_execute_script_tool(project_dir, config)
        with patch("builtins.input", return_value="n"):
            result = tool(script="do/build", flags=[])
        assert result["status"] == "skipped"
        assert result["reason"] == "user declined"

    def test_empty_input_treated_as_decline(self, project_dir, config):
        """Empty input (just Enter) is treated as decline."""
        tool = create_execute_script_tool(project_dir, config)
        with patch("builtins.input", return_value=""):
            result = tool(script="do/build", flags=[])
        assert result["status"] == "skipped"

    def test_eof_during_confirmation_returns_skipped(self, project_dir, config):
        """EOFError during input returns skipped."""
        tool = create_execute_script_tool(project_dir, config)
        with patch("builtins.input", side_effect=EOFError):
            result = tool(script="do/build", flags=[])
        assert result["status"] == "skipped"


class TestExecution:
    """Tests for actual subprocess execution."""

    def test_successful_execution(self, project_dir, config):
        """Approved script that exits 0 returns success."""
        tool = create_execute_script_tool(project_dir, config)

        mock_proc = MagicMock()
        output_lines = iter([b"output line 1\n", b"output line 2\n"])
        mock_proc.stdout.readline.side_effect = lambda: next(output_lines, b"")
        mock_proc.poll.side_effect = [None, None, None, 0]
        mock_proc.returncode = 0

        with patch("builtins.input", return_value="y"), patch(
            "src.agent.tools.execute_script.subprocess.Popen", return_value=mock_proc
        ):
            result = tool(script="do/build", flags=[])

        assert result["status"] == "success"
        assert result["exit_code"] == 0
        assert "output line 1" in result["output_tail"]

    def test_failed_execution(self, project_dir, config):
        """Script exiting non-zero returns failed status."""
        tool = create_execute_script_tool(project_dir, config)

        mock_proc = MagicMock()
        output_lines = iter([b"error: something broke\n"])
        mock_proc.stdout.readline.side_effect = lambda: next(output_lines, b"")
        mock_proc.poll.side_effect = [None, None, 1]
        mock_proc.returncode = 1

        with patch("builtins.input", return_value="yes"), patch(
            "src.agent.tools.execute_script.subprocess.Popen", return_value=mock_proc
        ):
            result = tool(script="do/stage", flags=[])

        assert result["status"] == "failed"
        assert result["exit_code"] == 1
        assert "error: something broke" in result["output_tail"]

    def test_timeout_kills_process(self, project_dir):
        """Script exceeding max timeout gets terminated."""
        # Use a very short timeout for testing
        short_config = ExecutionConfig(max_script_timeout=0)  # Immediate timeout
        tool = create_execute_script_tool(project_dir, short_config)

        mock_proc = MagicMock()
        mock_proc.stdout.readline.return_value = b""
        mock_proc.poll.return_value = None  # Never finishes
        mock_proc.returncode = -15
        mock_proc.wait.return_value = None

        with patch("builtins.input", return_value="y"), patch(
            "src.agent.tools.execute_script.subprocess.Popen", return_value=mock_proc
        ):
            result = tool(script="do/build", flags=[])

        assert result["status"] == "timeout"
        mock_proc.terminate.assert_called_once()

    def test_spawn_failure_returns_failed(self, project_dir, config):
        """OSError during Popen returns failed status."""
        tool = create_execute_script_tool(project_dir, config)

        with patch("builtins.input", return_value="y"), patch(
            "src.agent.tools.execute_script.subprocess.Popen", side_effect=OSError("Permission denied")
        ):
            result = tool(script="do/build", flags=[])

        assert result["status"] == "failed"
        assert result["exit_code"] == -1
        assert "Permission denied" in result["reason"]


class TestCostWarnings:
    """Tests for cost warning display."""

    def test_submit_shows_cost_warning(self, project_dir, config, capsys):
        """do/submit displays cost warning before confirmation."""
        tool = create_execute_script_tool(project_dir, config)
        with patch("builtins.input", return_value="n"):
            tool(script="do/submit", flags=[])

        captured = capsys.readouterr()
        assert "Cost warning" in captured.out or "Training Job" in captured.out

    def test_build_no_cost_warning(self, project_dir, config, capsys):
        """do/build does not display any cost warning."""
        tool = create_execute_script_tool(project_dir, config)
        with patch("builtins.input", return_value="n"):
            tool(script="do/build", flags=[])

        captured = capsys.readouterr()
        assert "Cost warning" not in captured.out


class TestConfigOverride:
    """Tests for .mlcc/agent-config.json overrides."""

    def test_custom_permitted_list(self, tmp_path):
        """Custom config expands permitted scripts."""
        mlcc_dir = tmp_path / ".mlcc"
        mlcc_dir.mkdir()
        (mlcc_dir / "agent-config.json").write_text(
            json.dumps({"permitted_scripts": ["do/stage", "do/deploy"]})
        )

        # Create scripts
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        for name in ("stage", "deploy"):
            s = do_dir / name
            s.write_text("#!/bin/bash\necho ok\n")
            s.chmod(s.stat().st_mode | stat.S_IEXEC)

        config = load_execution_config(tmp_path)
        assert config.is_permitted("do/deploy")
        assert not config.is_permitted("do/build")  # Not in custom list

    def test_invalid_json_falls_back_to_defaults(self, tmp_path):
        """Malformed JSON results in default config."""
        mlcc_dir = tmp_path / ".mlcc"
        mlcc_dir.mkdir()
        (mlcc_dir / "agent-config.json").write_text("not valid json {{")

        config = load_execution_config(tmp_path)
        assert config.permitted_scripts == ["do/stage", "do/build", "do/push", "do/submit"]

    def test_missing_config_uses_defaults(self, tmp_path):
        """No .mlcc/agent-config.json → default config."""
        config = load_execution_config(tmp_path)
        assert config.is_permitted("do/stage")
        assert config.max_script_timeout == 1800


class TestExecutionLog:
    """Tests for the session execution log."""

    def test_successful_run_recorded(self, project_dir, config):
        """Successful execution is recorded in the log."""
        tool = create_execute_script_tool(project_dir, config)

        mock_proc = MagicMock()
        output_lines = iter([b"done\n"])
        mock_proc.stdout.readline.side_effect = lambda: next(output_lines, b"")
        mock_proc.poll.side_effect = [None, None, 0]
        mock_proc.returncode = 0

        with patch("builtins.input", return_value="y"), patch(
            "src.agent.tools.execute_script.subprocess.Popen", return_value=mock_proc
        ):
            tool(script="do/build", flags=["--force"])

        log = get_execution_log()
        assert len(log) == 1
        assert log[0]["script"] == "do/build"
        assert log[0]["flags"] == ["--force"]
        assert log[0]["status"] == "success"
        assert log[0]["exit_code"] == 0
        assert "timestamp" in log[0]

    def test_skipped_not_recorded(self, project_dir, config):
        """Declined executions are NOT recorded in the log."""
        tool = create_execute_script_tool(project_dir, config)
        with patch("builtins.input", return_value="n"):
            tool(script="do/build", flags=[])

        assert len(get_execution_log()) == 0

    def test_multiple_runs_accumulate(self, project_dir, config):
        """Multiple executions accumulate in the session log."""
        tool = create_execute_script_tool(project_dir, config)

        for script in ("do/build", "do/push"):
            mock_proc = MagicMock()
            output_lines = iter([b"ok\n"])
            mock_proc.stdout.readline.side_effect = lambda ol=output_lines: next(ol, b"")
            mock_proc.poll.side_effect = [None, None, 0]
            mock_proc.returncode = 0
            with patch("builtins.input", return_value="y"), patch(
                "src.agent.tools.execute_script.subprocess.Popen", return_value=mock_proc
            ):
                tool(script=script, flags=[])

        log = get_execution_log()
        assert len(log) == 2
        assert log[0]["script"] == "do/build"
        assert log[1]["script"] == "do/push"
