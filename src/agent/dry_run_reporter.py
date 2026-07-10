# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Dry-run reporter — outputs a plan without executing any scripts.

Writes plan.json and prints a formatted table to stdout.
Zero do/ script execution, zero AWS calls.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from goal_planner import PlanStep
    from question_resolver import ResolvedAnswer
except ModuleNotFoundError:
    from src.agent.goal_planner import PlanStep
    from src.agent.question_resolver import ResolvedAnswer


class DryRunReporter:
    """Reports a goal plan without executing anything.

    Args:
        project_dir: Resolved absolute path to the project root.
    """

    def __init__(self, project_dir: Path) -> None:
        self._project_dir = project_dir

    def report(self, plan: list[PlanStep], resolved_answers: list[ResolvedAnswer]) -> dict:
        """Write plan.json and print a formatted plan table.

        Args:
            plan: List of PlanStep instances from GoalPlanner.
            resolved_answers: List of resolved answers (for context).

        Returns:
            The plan dict (for test assertions).
        """
        plan_dict = self._build_plan_dict(plan, resolved_answers)

        # Write plan.json with stable ordering (no timestamps)
        plan_path = self._project_dir / 'plan.json'
        plan_path.write_text(
            json.dumps(plan_dict, indent=2, ensure_ascii=False, sort_keys=True) + '\n',
            encoding='utf-8',
        )

        # Print formatted table to stdout
        self._print_table(plan)

        print(f'\n\033[32m✅ Plan written to {plan_path}\033[0m')
        print(f'   {len(plan)} steps — no scripts executed (dry-run mode).')

        return plan_dict

    def _build_plan_dict(self, plan: list[PlanStep], resolved_answers: list[ResolvedAnswer]) -> dict:
        """Build a stable plan dictionary for serialization.

        Args:
            plan: List of PlanStep instances.
            resolved_answers: List of resolved answers.

        Returns:
            Dict suitable for JSON serialization.
        """
        steps_list = []
        for step in plan:
            steps_list.append({
                'flags': step.flags,
                'klass': step.klass,
                'rationale': step.rationale,
                'script': step.script,
            })

        answers_list = []
        for ans in resolved_answers:
            answers_list.append({
                'answer': ans.answer,
                'question': ans.question,
                'source': ans.source,
            })

        return {
            'resolved_answers': answers_list,
            'steps': steps_list,
        }

    def _print_table(self, plan: list[PlanStep]) -> None:
        """Print the plan as a formatted table to stdout.

        Args:
            plan: List of PlanStep instances.
        """
        if not plan:
            print('\n  (empty plan)')
            return

        # Calculate column widths
        script_w = max(len(s.script) for s in plan)
        klass_w = max(len(s.klass) for s in plan)

        header = f'  {"#":<3} {"Script":<{script_w}} {"Class":<{klass_w}}  Flags'
        separator = '  ' + '─' * (len(header) + 20)

        print(f'\n\033[1m  Execution Plan (dry-run)\033[0m')
        print(separator)
        print(header)
        print(separator)

        for i, step in enumerate(plan, 1):
            flags_str = ' '.join(step.flags) if step.flags else '—'
            klass_display = '🟢 auto' if step.klass == 'auto' else '🟡 confirm'
            print(f'  {i:<3} {step.script:<{script_w}} {klass_display:<{klass_w + 4}}  {flags_str}')
            if step.rationale:
                print(f'      \033[2m↳ {step.rationale}\033[0m')

        print(separator)
