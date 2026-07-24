# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for ChainRunner — plan execution with confirmation policy."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

strands = pytest.importorskip("strands", reason="strands-agents not installed")

from src.agent.chain_runner import ChainRunner, ChainResult
from src.agent.execution_config import ExecutionConfig
from src.agent.goal_planner import PlanStep
from src.agent.tools.execute_script import clear_execution_log, _execution_log


@pytest.fixture(autouse=True)
def reset_log():
    """Clear execution log before each test."""
    clear_execution_log()
    yield
    clear_execution_log()


@pytest.fixture
def exec_config():
    """Execution config with do/test as auto and do/build as confirm."""
    return ExecutionConfig(
        permitted_scripts=['do/test', 'do/build', 'do/deploy'],
        script_classes={
            'do/test': 'auto',
            'do/build': 'confirm',
            'do/deploy': 'confirm',
        },
        mode='default',
    )


class TestAutoClassNoPrompt:
    """Test that auto-class steps execute without confirmation prompt."""

    def test_auto_class_no_prompt(self, exec_config, tmp_path):
        """Auto-class step is executed without confirmation prompt (auto_confirm=True)."""
        calls = []

        def mock_execute_script(script, flags=None, confirm_message='', auto_confirm=False):
            calls.append({'script': script, 'auto_confirm': auto_confirm})
            # Simulate successful execution and log it
            _execution_log.append({
                'script': script,
                'flags': flags or [],
                'status': 'success',
                'exit_code': 0,
                'timestamp': '2026-01-01T00:00:00Z',
            })
            return {'status': 'success', 'exit_code': 0, 'output_tail': []}

        runner = ChainRunner(mock_execute_script, exec_config, tmp_path)
        plan = [
            PlanStep(script='do/test', flags=[], klass='auto', rationale='run tests'),
        ]

        result = runner.run(plan)
        assert result.steps_run == 1
        assert len(calls) == 1
        assert calls[0]['auto_confirm'] is True

    def test_confirm_class_prompts(self, exec_config, tmp_path):
        """Confirm-class step is executed with auto_confirm=False."""
        calls = []

        def mock_execute_script(script, flags=None, confirm_message='', auto_confirm=False):
            calls.append({'script': script, 'auto_confirm': auto_confirm})
            _execution_log.append({
                'script': script,
                'flags': flags or [],
                'status': 'success',
                'exit_code': 0,
                'timestamp': '2026-01-01T00:00:00Z',
            })
            return {'status': 'success', 'exit_code': 0, 'output_tail': []}

        runner = ChainRunner(mock_execute_script, exec_config, tmp_path)
        plan = [
            PlanStep(script='do/build', flags=[], klass='confirm', rationale='build image'),
        ]

        result = runner.run(plan)
        assert result.steps_run == 1
        assert len(calls) == 1
        assert calls[0]['auto_confirm'] is False


class TestFailedStepStopsChain:
    """Test that step failure stops chain execution."""

    def test_failed_step_stops_chain(self, exec_config, tmp_path):
        """Step failure stops execution when user chooses abort."""
        call_count = []

        def mock_execute_script(script, flags=None, confirm_message='', auto_confirm=False):
            call_count.append(script)
            return {'status': 'failed', 'exit_code': 1, 'output_tail': ['error output']}

        runner = ChainRunner(mock_execute_script, exec_config, tmp_path)
        plan = [
            PlanStep(script='do/test', flags=[], klass='auto', rationale='run tests'),
            PlanStep(script='do/build', flags=[], klass='confirm', rationale='build'),
        ]

        # Mock troubleshoot to return 'abort'
        with patch.object(runner, 'troubleshoot', return_value='abort'):
            result = runner.run(plan)

        assert result.steps_failed == 1
        assert result.steps_run == 0
        # Only one script was attempted (chain stopped at first failure)
        assert len(call_count) == 1


class TestSkipCompletedSteps:
    """Test that already-executed steps are skipped."""

    def test_skip_completed_steps(self, exec_config, tmp_path):
        """Steps already in execution_log are skipped."""
        # Pre-populate execution log with a successful do/test run
        _execution_log.append({
            'script': 'do/test',
            'flags': [],
            'status': 'success',
            'exit_code': 0,
            'timestamp': '2026-01-01T00:00:00Z',
        })

        calls = []

        def mock_execute_script(script, flags=None, confirm_message='', auto_confirm=False):
            calls.append(script)
            _execution_log.append({
                'script': script,
                'flags': flags or [],
                'status': 'success',
                'exit_code': 0,
                'timestamp': '2026-01-01T00:01:00Z',
            })
            return {'status': 'success', 'exit_code': 0, 'output_tail': []}

        runner = ChainRunner(mock_execute_script, exec_config, tmp_path)
        plan = [
            PlanStep(script='do/test', flags=[], klass='auto', rationale='run tests'),
            PlanStep(script='do/build', flags=[], klass='confirm', rationale='build'),
        ]

        result = runner.run(plan)
        # do/test should be skipped, do/build should run
        assert result.steps_skipped == 1
        assert result.steps_run == 1
        assert 'do/test' not in calls
        assert 'do/build' in calls
