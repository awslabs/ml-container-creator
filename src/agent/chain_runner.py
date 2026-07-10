# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Chain runner — executes a plan of do/ script steps sequentially.

Consults the confirmation policy for each step, handles failures with
retry/skip/abort, and tracks timing and cost.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

try:
    from execution_config import ExecutionConfig
    from goal_planner import PlanStep
    from tools.execute_script import get_execution_log
except ModuleNotFoundError:
    from src.agent.execution_config import ExecutionConfig
    from src.agent.goal_planner import PlanStep
    from src.agent.tools.execute_script import get_execution_log


@dataclass
class ChainResult:
    """Summary of a chain execution run."""

    steps_run: int
    steps_skipped: int
    steps_failed: int
    wall_clock_seconds: float
    estimated_cost_usd: float


class ChainRunner:
    """Executes a sequence of PlanSteps, respecting confirmation policy.

    For each step:
      - "auto" class → calls execute_script with auto_confirm=True
      - "confirm" class → calls execute_script with auto_confirm=False (user prompt)
      - On failure: offers Retry / Skip / Abort
      - Skips steps already in the execution log

    Args:
        execute_script_fn: The execute_script callable (from create_execute_script_tool).
        execution_config: ExecutionConfig with policy and cost warnings.
        project_dir: Resolved project root path.
        dry_run: If True, skip actual execution (used for testing).
    """

    def __init__(
        self,
        execute_script_fn: Callable,
        execution_config: ExecutionConfig,
        project_dir: Path,
        dry_run: bool = False,
    ) -> None:
        self._execute_script_fn = execute_script_fn
        self._execution_config = execution_config
        self._project_dir = project_dir
        self._dry_run = dry_run

    def run(self, plan: list[PlanStep]) -> ChainResult:
        """Execute the plan steps in order.

        Args:
            plan: Ordered list of PlanStep instances from GoalPlanner.

        Returns:
            ChainResult summary with counts and timing.
        """
        steps_run = 0
        steps_skipped = 0
        steps_failed = 0
        estimated_cost = 0.0
        start_time = time.monotonic()

        for i, step in enumerate(plan):
            # Skip steps already completed in this session
            if self._already_executed(step):
                print(f'\033[2m  ⏭ Step {i + 1}/{len(plan)}: {step.script} — already executed, skipping\033[0m')
                steps_skipped += 1
                continue

            print(f'\n\033[1m▶ Step {i + 1}/{len(plan)}: {step.script}\033[0m')
            if step.rationale:
                print(f'  📋 {step.rationale}')

            if self._dry_run:
                print(f'  \033[2m[dry-run] would execute {step.script} {" ".join(step.flags)}\033[0m')
                steps_skipped += 1
                continue

            # Determine auto_confirm from confirmation policy
            auto_confirm = (step.klass == 'auto')

            # Execute with retry loop
            while True:
                result = self._execute_step(step, auto_confirm)
                status = result.get('status', 'failed')

                if status == 'success':
                    steps_run += 1
                    # Accumulate cost estimate
                    cost_warning = self._execution_config.get_cost_warning(step.script)
                    if cost_warning:
                        estimated_cost += 0.50  # Conservative estimate per cost-warning step
                    break
                elif status == 'skipped':
                    steps_skipped += 1
                    break
                elif status in ('failed', 'timeout'):
                    action = self.troubleshoot(step, result)
                    if action == 'retry':
                        continue
                    elif action == 'skip':
                        steps_skipped += 1
                        break
                    else:  # abort
                        steps_failed += 1
                        wall_clock = time.monotonic() - start_time
                        self._print_summary(steps_run, steps_skipped, steps_failed, wall_clock, estimated_cost)
                        return ChainResult(
                            steps_run=steps_run,
                            steps_skipped=steps_skipped,
                            steps_failed=steps_failed,
                            wall_clock_seconds=wall_clock,
                            estimated_cost_usd=estimated_cost,
                        )
                else:
                    # refused or other — treat as skip
                    steps_skipped += 1
                    break

        wall_clock = time.monotonic() - start_time
        self._print_summary(steps_run, steps_skipped, steps_failed, wall_clock, estimated_cost)
        return ChainResult(
            steps_run=steps_run,
            steps_skipped=steps_skipped,
            steps_failed=steps_failed,
            wall_clock_seconds=wall_clock,
            estimated_cost_usd=estimated_cost,
        )

    def troubleshoot(self, step: PlanStep, result: dict[str, Any]) -> str:
        """Handle a failed step — prompt user for retry/skip/abort.

        Args:
            step: The PlanStep that failed.
            result: The execution result dict.

        Returns:
            One of "retry", "skip", "abort".
        """
        exit_code = result.get('exit_code', '?')
        print(f'\n\033[31m❌ Step failed: {step.script} exited {exit_code}\033[0m')

        while True:
            try:
                choice = input('[R]etry / [S]kip / [A]bort? ').strip().lower()
            except (EOFError, KeyboardInterrupt):
                print()
                return 'abort'

            if choice in ('r', 'retry'):
                return 'retry'
            elif choice in ('s', 'skip'):
                return 'skip'
            elif choice in ('a', 'abort'):
                return 'abort'
            else:
                print('  Please enter R, S, or A.')

    def _execute_step(self, step: PlanStep, auto_confirm: bool) -> dict[str, Any]:
        """Call the execute_script function for a plan step.

        Args:
            step: The PlanStep to execute.
            auto_confirm: Whether to skip the confirmation prompt.

        Returns:
            Execution result dict.
        """
        try:
            result = self._execute_script_fn(
                script=step.script,
                flags=step.flags,
                confirm_message=step.rationale,
                auto_confirm=auto_confirm,
            )
            return result if isinstance(result, dict) else {'status': 'failed', 'exit_code': -1}
        except Exception as e:
            print(f'\033[31m❌ Exception executing {step.script}: {e}\033[0m')
            return {'status': 'failed', 'exit_code': -1, 'reason': str(e)}

    def _already_executed(self, step: PlanStep) -> bool:
        """Check if a step has already been executed in this session.

        Args:
            step: The PlanStep to check.

        Returns:
            True if the step's script+flags match a successful entry in the log.
        """
        for entry in get_execution_log():
            if (
                entry.get('script') == step.script
                and entry.get('flags') == step.flags
                and entry.get('status') == 'success'
            ):
                return True
        return False

    def _print_summary(
        self,
        steps_run: int,
        steps_skipped: int,
        steps_failed: int,
        wall_clock: float,
        estimated_cost: float,
    ) -> None:
        """Print a formatted chain execution summary.

        Args:
            steps_run: Number of steps executed successfully.
            steps_skipped: Number of steps skipped.
            steps_failed: Number of steps that failed.
            wall_clock: Total elapsed time in seconds.
            estimated_cost: Estimated cost in USD.
        """
        print('\n\033[1m─── Chain Summary ───\033[0m')
        print(f'  ✅ Executed: {steps_run}')
        print(f'  ⏭  Skipped:  {steps_skipped}')
        print(f'  ❌ Failed:   {steps_failed}')
        print(f'  ⏱  Time:     {wall_clock:.1f}s')
        if estimated_cost > 0:
            print(f'  💰 Est. cost: ~${estimated_cost:.2f}')
        print()
