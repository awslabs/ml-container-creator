# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for BL080 — `hey --from-plan` plan loading and validation.

Covers the pure logic that reconstructs and validates PlanStep instances from a
saved plan.json (`_load_plan_steps`). The end-to-end CLI paths (dry-run, mutual
exclusion, missing/malformed file exit codes) are exercised by the Node CLI test
`test/unit/hey-from-plan.test.js`.
"""

from __future__ import annotations

import pytest

# _load_plan_steps lives in agent.py, which imports `strands` at module load.
strands = pytest.importorskip("strands", reason="strands-agents not installed")

from src.agent.agent import _load_plan_steps
from src.agent.execution_config import ExecutionConfig
from src.agent.goal_planner import PlanStep


@pytest.fixture
def exec_config():
    return ExecutionConfig(
        permitted_scripts=['do/stage', 'do/deploy', 'do/test'],
        script_classes={'do/stage': 'confirm', 'do/deploy': 'confirm', 'do/test': 'auto'},
        mode='default',
    )


class TestLoadPlanStepsValid:
    """Req 5.1: a valid plan reconstructs all steps."""

    def test_all_steps_loaded(self, exec_config):
        steps_raw = [
            {'script': 'do/stage', 'flags': [], 'klass': 'confirm', 'rationale': 'stage weights'},
            {'script': 'do/deploy', 'flags': ['--force'], 'klass': 'confirm', 'rationale': 'deploy'},
        ]
        steps = _load_plan_steps(steps_raw, exec_config)
        assert len(steps) == 2
        assert all(isinstance(s, PlanStep) for s in steps)
        assert steps[0].script == 'do/stage'
        assert steps[1].script == 'do/deploy'
        assert steps[1].flags == ['--force']

    def test_klass_recomputed_from_policy(self, exec_config):
        """klass is derived from exec_config, not trusted from the file."""
        steps_raw = [
            # File claims 'auto' but policy says do/deploy is 'confirm'.
            {'script': 'do/deploy', 'flags': [], 'klass': 'auto', 'rationale': ''},
        ]
        steps = _load_plan_steps(steps_raw, exec_config)
        assert steps[0].klass == 'confirm'


class TestLoadPlanStepsUnpermitted:
    """Req 5.2: unpermitted steps are skipped with a warning."""

    def test_unpermitted_step_skipped(self, exec_config, capsys):
        steps_raw = [
            {'script': 'do/stage', 'flags': [], 'klass': 'confirm', 'rationale': ''},
            {'script': 'do/hack', 'flags': [], 'klass': 'confirm', 'rationale': ''},
        ]
        steps = _load_plan_steps(steps_raw, exec_config)
        assert len(steps) == 1
        assert steps[0].script == 'do/stage'

        captured = capsys.readouterr()
        assert 'not in permitted scripts' in captured.err
        assert 'do/hack' in captured.err


class TestLoadPlanStepsValidation:
    """Req 1.3 / 5.5: malformed / missing-field steps raise ValueError."""

    def test_steps_not_a_list(self, exec_config):
        with pytest.raises(ValueError, match='must be an array'):
            _load_plan_steps({'not': 'a list'}, exec_config)

    def test_missing_script_field(self, exec_config):
        with pytest.raises(ValueError, match='missing required field "script"'):
            _load_plan_steps([{'flags': []}], exec_config)

    def test_missing_flags_field(self, exec_config):
        with pytest.raises(ValueError, match='missing required field "flags"'):
            _load_plan_steps([{'script': 'do/stage'}], exec_config)

    def test_flags_not_a_list(self, exec_config):
        with pytest.raises(ValueError, match='"flags" must be an array'):
            _load_plan_steps([{'script': 'do/stage', 'flags': 'nope'}], exec_config)

    def test_step_not_an_object(self, exec_config):
        with pytest.raises(ValueError, match='is not an object'):
            _load_plan_steps(['just a string'], exec_config)


class TestRunFromPlan:
    """Tests for _run_from_plan — the full load → dispatch path."""

    def _write_plan(self, tmp_path, obj):
        import json as _json
        plan_file = tmp_path / 'plan.json'
        plan_file.write_text(_json.dumps(obj), encoding='utf-8')
        return plan_file

    def test_valid_plan_executes_via_chain_runner(self, exec_config, tmp_path):
        """Req 5.1: all steps are passed to ChainRunner and executed."""
        from src.agent.tools.execute_script import clear_execution_log, _execution_log
        from src.agent import agent as agent_mod

        clear_execution_log()
        plan_file = self._write_plan(tmp_path, {
            'goal': 'stage and deploy',
            'steps': [
                {'script': 'do/stage', 'flags': [], 'klass': 'confirm', 'rationale': ''},
                {'script': 'do/deploy', 'flags': [], 'klass': 'confirm', 'rationale': ''},
            ],
        })

        executed = []

        def mock_execute_script(script, flags=None, confirm_message='', auto_confirm=False):
            executed.append(script)
            _execution_log.append({
                'script': script, 'flags': flags or [], 'status': 'success',
                'exit_code': 0, 'timestamp': '2026-01-01T00:00:00Z',
            })
            return {'status': 'success', 'exit_code': 0, 'output_tail': []}

        exit_code = agent_mod._run_from_plan(
            str(plan_file), exec_config, mock_execute_script, tmp_path, dry_run=False
        )
        clear_execution_log()

        assert exit_code == 0
        assert executed == ['do/stage', 'do/deploy']

    def test_unpermitted_step_skipped_in_execution(self, exec_config, tmp_path, capsys):
        """Req 5.2: unpermitted step is skipped; only permitted steps run."""
        from src.agent.tools.execute_script import clear_execution_log, _execution_log
        from src.agent import agent as agent_mod

        clear_execution_log()
        plan_file = self._write_plan(tmp_path, {
            'goal': 'g',
            'steps': [
                {'script': 'do/stage', 'flags': [], 'klass': 'confirm', 'rationale': ''},
                {'script': 'do/hack', 'flags': [], 'klass': 'confirm', 'rationale': ''},
            ],
        })

        executed = []

        def mock_execute_script(script, flags=None, confirm_message='', auto_confirm=False):
            executed.append(script)
            _execution_log.append({
                'script': script, 'flags': flags or [], 'status': 'success',
                'exit_code': 0, 'timestamp': '2026-01-01T00:00:00Z',
            })
            return {'status': 'success', 'exit_code': 0, 'output_tail': []}

        agent_mod._run_from_plan(
            str(plan_file), exec_config, mock_execute_script, tmp_path, dry_run=False
        )
        clear_execution_log()

        assert executed == ['do/stage']
        assert 'not in permitted scripts' in capsys.readouterr().err

    def test_dry_run_prints_table_no_execution(self, exec_config, tmp_path):
        """Req 5.3: dry-run prints the plan and does not call execute_script."""
        from src.agent import agent as agent_mod

        plan_file = self._write_plan(tmp_path, {
            'goal': 'g',
            'steps': [{'script': 'do/stage', 'flags': [], 'klass': 'confirm', 'rationale': 'r'}],
        })

        calls = []

        def mock_execute_script(*a, **k):
            calls.append(a)
            return {'status': 'success', 'exit_code': 0}

        exit_code = agent_mod._run_from_plan(
            str(plan_file), exec_config, mock_execute_script, tmp_path, dry_run=True
        )

        assert exit_code == 0
        assert calls == []  # ChainRunner never invoked
        # plan.json is (re)written by the DryRunReporter.
        assert (tmp_path / 'plan.json').exists()

    def test_missing_file_exits_1(self, exec_config, tmp_path, capsys):
        """Req 5.5: missing plan file returns exit code 1 with an error."""
        from src.agent import agent as agent_mod

        exit_code = agent_mod._run_from_plan(
            str(tmp_path / 'nope.json'), exec_config, lambda *a, **k: None, tmp_path, dry_run=False
        )
        assert exit_code == 1
        assert 'not found' in capsys.readouterr().err

    def test_malformed_json_exits_1(self, exec_config, tmp_path, capsys):
        """Req 5.5: malformed JSON returns exit code 1 with an error."""
        from src.agent import agent as agent_mod

        plan_file = tmp_path / 'plan.json'
        plan_file.write_text('{ not valid json ', encoding='utf-8')

        exit_code = agent_mod._run_from_plan(
            str(plan_file), exec_config, lambda *a, **k: None, tmp_path, dry_run=False
        )
        assert exit_code == 1
        assert 'Invalid plan.json' in capsys.readouterr().err

    def test_missing_steps_key_exits_1(self, exec_config, tmp_path, capsys):
        """A plan.json without a steps array is rejected with exit code 1."""
        from src.agent import agent as agent_mod

        plan_file = self._write_plan(tmp_path, {'goal': 'no steps here'})

        exit_code = agent_mod._run_from_plan(
            str(plan_file), exec_config, lambda *a, **k: None, tmp_path, dry_run=False
        )
        assert exit_code == 1
