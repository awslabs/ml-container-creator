# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Execute script tool — runs permitted do/ scripts with user confirmation.

Implements confirmation-gated execution: the agent proposes a command,
displays it, and waits for explicit y/N before running. Streams output
in real-time, handles timeouts, and maintains a session execution log.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from strands import tool

try:
    from execution_config import ExecutionConfig
except ModuleNotFoundError:
    from src.agent.execution_config import ExecutionConfig


# ─── Session Execution Log ────────────────────────────────────────────────────

_execution_log: list[dict[str, Any]] = []

_FLAG_PATTERN = re.compile(r"^--[a-z][a-z0-9-]*(=.*)?$")


def get_execution_log() -> list[dict[str, Any]]:
    """Return the session execution log.

    Used by the agent to inject history into the system prompt,
    preventing re-proposals of already-executed steps (AC-3.3).

    Returns:
        List of execution records with script, flags, status, exit_code, timestamp.
    """
    return list(_execution_log)


def clear_execution_log() -> None:
    """Clear the execution log. Used for testing."""
    _execution_log.clear()


# ─── Tool Factory ─────────────────────────────────────────────────────────────


def create_execute_script_tool(project_dir: Path, config: ExecutionConfig):
    """Create the execute_script tool bound to a project directory and config.

    Args:
        project_dir: Resolved absolute path to the project root.
        config: ExecutionConfig with permitted scripts and cost warnings.

    Returns:
        A Strands @tool-decorated function.
    """

    @tool
    def execute_script(script: str, flags: list[str] = [], confirm_message: str = "") -> dict[str, Any]:
        """Execute a do/ script in the project directory with user confirmation.

        Runs an approved script after displaying the exact command and waiting
        for explicit user approval. Streams output in real-time.

        Args:
            script: Script path relative to project root (e.g., "do/stage").
            flags: List of command-line flags (e.g., ["--force", "--instance-type=ml.g5.xlarge"]).
            confirm_message: Optional message to display explaining why this script should be run.

        Returns:
            Dict with status ("success", "failed", "skipped", "timeout", "refused"),
            exit_code (if executed), and output_tail (last 20 lines).
        """
        # ── Step 1: Validate flags (AC-2.6) ──
        invalid_flags = [f for f in flags if not _FLAG_PATTERN.match(f)]
        if invalid_flags:
            msg = (
                f"Refused: invalid flag format {invalid_flags}. "
                f"Flags must match --flag-name or --flag-name=value pattern."
            )
            print(f"\033[31m{msg}\033[0m")
            return {"status": "refused", "reason": msg}

        # ── Step 2: Check permitted list (AC-2.4) ──
        if not config.is_permitted(script):
            msg = (
                f"I can't run {script} \u2014 it's not in my permitted list. "
                f"Add it to .mlcc/agent-config.json if you'd like me to. "
                f"Permitted: {config.permitted_scripts}"
            )
            print(f"\033[31m{msg}\033[0m")
            return {"status": "refused", "reason": msg}

        # ── Step 3: Verify script exists and is executable (AC-2.7) ──
        script_path = project_dir / script
        if not script_path.is_file():
            available = [
                s for s in config.permitted_scripts
                if (project_dir / s).is_file()
            ]
            msg = (
                f"Script '{script}' not found at {script_path}. "
                f"Available permitted scripts: {available or 'none found on disk'}"
            )
            print(f"\033[31m{msg}\033[0m")
            return {"status": "refused", "reason": msg}

        if not os.access(script_path, os.X_OK):
            msg = f"Script '{script}' exists but is not executable. Run: chmod +x {script}"
            print(f"\033[33m{msg}\033[0m")
            return {"status": "refused", "reason": msg}

        # ── Step 4: Display cost warning (AC-4.1, AC-4.2) ──
        cost_warning = config.get_cost_warning(script)
        if cost_warning:
            print(f"\033[33m\u26a0\ufe0f  Cost warning: {cost_warning}\033[0m")

        # ── Step 5: Display proposed command ──
        cmd_display = f"./{script}" + (" " + " ".join(flags) if flags else "")
        print()
        print("\033[1m\u250c\u2500 Proposed command \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\033[0m")
        print(f"\033[1m\u2502\033[0m  $ {cmd_display}")
        print(f"\033[1m\u2502\033[0m  cwd: {project_dir}")
        if confirm_message:
            print(f"\033[1m\u2502\033[0m  {confirm_message}")
        print("\033[1m\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\033[0m")
        print()

        # ── Step 6: Confirmation prompt (AC-1.2) ──
        try:
            answer = input("Execute? [y/N]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return {"status": "skipped", "reason": "user interrupted"}

        if answer not in ("y", "yes"):
            return {"status": "skipped", "reason": "user declined"}

        # ── Step 7: Spawn subprocess (AC-1.7, AC-1.8) ──
        cmd = [str(script_path)] + flags
        output_lines: list[str] = []
        start_time = time.monotonic()
        last_output_time = start_time

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(project_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=os.environ.copy(),
                # No shell=True — direct exec only (security)
            )
        except OSError as e:
            msg = f"Failed to spawn subprocess: {e}"
            print(f"\033[31m{msg}\033[0m")
            return {"status": "failed", "exit_code": -1, "reason": msg, "output_tail": []}

        # ── Step 8: Forward SIGINT to child (AC-1.9) ──
        original_sigint = signal.getsignal(signal.SIGINT)

        def _forward_sigint(signum, frame):
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)

        signal.signal(signal.SIGINT, _forward_sigint)

        # ── Step 9: Stream output with heartbeat and timeout (NFR-6) ──
        timed_out = False

        try:
            print(f"\033[2m\u2500\u2500\u2500 output \u2500\u2500\u2500\033[0m")
            while True:
                # Check timeout
                elapsed = time.monotonic() - start_time
                if elapsed > config.max_script_timeout:
                    timed_out = True
                    proc.terminate()
                    # Grace period
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                    break

                # Non-blocking read with short timeout for heartbeat checking
                line = proc.stdout.readline()
                if line:
                    decoded = line.decode("utf-8", errors="replace").rstrip("\n")
                    print(decoded)
                    output_lines.append(decoded)
                    last_output_time = time.monotonic()
                elif proc.poll() is not None:
                    # Process finished
                    break
                else:
                    # No output — check heartbeat
                    time.sleep(0.1)
                    silent_duration = time.monotonic() - last_output_time
                    if silent_duration > 60:
                        print("\033[2m\u23f3 still running\u2026\033[0m")
                        last_output_time = time.monotonic()

            print(f"\033[2m\u2500\u2500\u2500 end \u2500\u2500\u2500\033[0m")
        finally:
            signal.signal(signal.SIGINT, original_sigint)

        # ── Step 10: Record result ──
        exit_code = proc.returncode if not timed_out else -1
        output_tail = output_lines[-20:] if output_lines else []

        if timed_out:
            status = "timeout"
            print(
                f"\033[31mScript timed out after {config.max_script_timeout}s. "
                f"Process was terminated.\033[0m"
            )
        elif exit_code == 0:
            status = "success"
            print(f"\033[32m\u2713 Script completed successfully (exit 0)\033[0m")
        else:
            status = "failed"
            print(f"\033[31m\u2717 Script failed (exit {exit_code})\033[0m")

        # ── Step 11: Update session execution log (NFR-7) ──
        _execution_log.append({
            "script": script,
            "flags": flags,
            "status": status,
            "exit_code": exit_code,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

        return {
            "status": status,
            "exit_code": exit_code,
            "output_tail": output_tail,
        }

    return execute_script
