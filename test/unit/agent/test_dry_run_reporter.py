# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for DryRunReporter — plan output without execution."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from src.agent.dry_run_reporter import DryRunReporter
from src.agent.goal_planner import PlanStep
from src.agent.question_resolver import ResolvedAnswer


@pytest.fixture
def sample_plan():
    """A sample execution plan."""
    return [
        PlanStep(script='do/test', flags=[], klass='auto', rationale='Run unit tests'),
        PlanStep(
            script='do/build',
            flags=['--force'],
            klass='confirm',
            rationale='Build the container image',
        ),
        PlanStep(script='do/push', flags=[], klass='confirm', rationale='Push to ECR'),
    ]


@pytest.fixture
def sample_answers():
    """Sample resolved answers."""
    return [
        ResolvedAnswer(question='instance type?', answer='ml.g5.xlarge', source='project_context.instance_type'),
    ]


class TestReportWritesPlanJson:
    """Tests for plan.json output."""

    def test_report_writes_plan_json(self, tmp_path, sample_plan, sample_answers):
        """Verifies plan.json is written with stable content."""
        reporter = DryRunReporter(tmp_path)
        result = reporter.report(sample_plan, sample_answers)

        plan_path = tmp_path / 'plan.json'
        assert plan_path.exists()

        content = json.loads(plan_path.read_text(encoding='utf-8'))

        # Verify structure
        assert 'steps' in content
        assert 'resolved_answers' in content
        assert len(content['steps']) == 3
        assert len(content['resolved_answers']) == 1

        # Verify stable ordering (keys are sorted)
        raw_text = plan_path.read_text(encoding='utf-8')
        # Re-serialize with sort_keys to compare
        expected = json.dumps(content, indent=2, ensure_ascii=False, sort_keys=True) + '\n'
        assert raw_text == expected

        # Verify step content
        assert content['steps'][0]['script'] == 'do/test'
        assert content['steps'][0]['klass'] == 'auto'
        assert content['steps'][1]['flags'] == ['--force']
        assert content['steps'][2]['script'] == 'do/push'

        # Verify answer content
        assert content['resolved_answers'][0]['answer'] == 'ml.g5.xlarge'
        assert content['resolved_answers'][0]['source'] == 'project_context.instance_type'

    def test_report_returns_plan_dict(self, tmp_path, sample_plan, sample_answers):
        """report() returns the plan dict for test assertions."""
        reporter = DryRunReporter(tmp_path)
        result = reporter.report(sample_plan, sample_answers)

        assert isinstance(result, dict)
        assert 'steps' in result
        assert len(result['steps']) == 3


class TestReportNoScriptExecution:
    """Tests that dry-run mode does not execute any scripts."""

    def test_report_no_script_execution(self, tmp_path, sample_plan, sample_answers):
        """Verifies no do/ scripts are called during report."""
        import subprocess

        with patch.object(subprocess, 'Popen') as mock_popen:
            reporter = DryRunReporter(tmp_path)
            reporter.report(sample_plan, sample_answers)

            # subprocess.Popen should never be called
            mock_popen.assert_not_called()

    def test_report_no_aws_calls(self, tmp_path, sample_plan, sample_answers):
        """Verifies no AWS/boto3 calls during report."""
        # DryRunReporter should not import or use boto3
        import importlib
        import sys

        # Remove boto3 from available modules temporarily to ensure it's not used
        boto3_backup = sys.modules.get('boto3')
        sys.modules['boto3'] = None  # type: ignore

        try:
            reporter = DryRunReporter(tmp_path)
            result = reporter.report(sample_plan, sample_answers)
            assert result is not None
        finally:
            if boto3_backup is not None:
                sys.modules['boto3'] = boto3_backup
            elif 'boto3' in sys.modules:
                del sys.modules['boto3']

    def test_report_empty_plan(self, tmp_path):
        """report() handles empty plan gracefully."""
        reporter = DryRunReporter(tmp_path)
        result = reporter.report([], [])

        plan_path = tmp_path / 'plan.json'
        assert plan_path.exists()
        content = json.loads(plan_path.read_text(encoding='utf-8'))
        assert content['steps'] == []
        assert content['resolved_answers'] == []
