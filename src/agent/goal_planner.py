# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Goal planner — converts a high-level objective into a plan of do/ script steps.

Uses the Strands agent to emit a structured JSON plan constrained to
permitted scripts only.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any


@dataclass
class PlanStep:
    """A single step in a goal execution plan."""

    script: str
    flags: list[str]
    klass: str
    rationale: str


class GoalPlanningError(Exception):
    """Raised when the planner cannot produce a valid plan."""


_SCRIPT_GUIDANCE = """\
- do/submit: PREFERRED build+push path. Submits a CodeBuild job that builds the Docker image on cloud infrastructure (correct architecture) and pushes to ECR. Use this instead of do/build + do/push for any "build", "push", "build and push", or "submit" goal.
- do/build: LOCAL build only. Builds the Docker image locally on the user's machine. ONLY use when the user explicitly asks to build locally. Causes architecture mismatches if the user's machine differs from SageMaker instances (e.g., Apple Silicon vs x86).
- do/push: LOCAL push only. Pushes a locally-built image to ECR. Only meaningful after do/build. ONLY use when the user explicitly asks for local build+push workflow.
- do/stage: Downloads model weights from HuggingFace to S3 via a SageMaker Processing Job. Use before do/deploy when model weights need to be staged.
- do/deploy: Deploys the container as a SageMaker endpoint (Inference Component). Use after build/push/submit.
- do/test: Validates the deployed endpoint with /ping and /invocations. Use after deploy.
- do/validate: Validates do/config against AWS service models. Safe to run any time — no cost.
- do/tune: Fine-tunes the deployed model using SageMaker Managed Model Customization. Requires a running endpoint.
- do/benchmark: Runs latency/throughput benchmarks on the endpoint. Use after deploy+test.
- do/clean: Tears down AWS resources (endpoint, ECR image, etc.). Use when explicitly asked to clean up or tear down.
- do/register: Registers the deployment to the SageMaker Model Package Group registry."""

_PLANNING_PROMPT_TEMPLATE = """You are a goal planner for ml-container-creator projects.

Given the user's objective and the project context, produce a plan as a JSON array.
Each element must be an object with these keys:
- "script": one of the permitted scripts listed below (exactly as shown)
- "flags": array of CLI flags (e.g., ["--force", "--instance-type=ml.g5.xlarge"]), may be empty []
- "rationale": brief explanation of why this step is needed

IMPORTANT CONSTRAINTS:
- You may ONLY use scripts from the permitted list below. Do NOT invent scripts.
- Output ONLY the JSON array. No markdown fences, no prose before or after.
- If no scripts are needed for the objective, output an empty array: []

PERMITTED SCRIPTS:
{permitted_scripts}

SCRIPT GUIDANCE (IMPORTANT — read before planning):
{script_guidance}

PROJECT CONTEXT:
{context_json}

USER OBJECTIVE:
{objective}

Output your plan as a JSON array now:"""


class GoalPlanner:
    """Plans a sequence of do/ script executions to achieve an objective.

    Args:
        agent: A Strands Agent instance used for LLM inference.
        permitted_scripts: List of scripts the agent is allowed to execute.
        execution_config: ExecutionConfig for determining confirmation class.
    """

    def __init__(self, agent: Any, permitted_scripts: list[str], execution_config: Any) -> None:
        self._agent = agent
        self._permitted_scripts = permitted_scripts
        self._execution_config = execution_config

    def plan(self, objective: str, context: dict) -> list[PlanStep]:
        """Generate an execution plan for the given objective.

        Calls the LLM with a structured planning prompt, parses the JSON
        response, validates scripts, and stamps confirmation classes.

        Args:
            objective: High-level goal text from the user (e.g., "build and deploy").
            context: Project context dict for grounding the plan.

        Returns:
            Ordered list of PlanStep instances.

        Raises:
            GoalPlanningError: If the plan is empty or the LLM output is unparseable.
        """
        permitted_str = '\n'.join(f'  - {s}' for s in self._permitted_scripts)
        context_json = json.dumps(context, indent=2, default=str)

        prompt = _PLANNING_PROMPT_TEMPLATE.format(
            permitted_scripts=permitted_str,
            script_guidance=_SCRIPT_GUIDANCE,
            context_json=context_json,
            objective=objective,
        )

        # Call the agent (same pattern as _run_repl in agent.py)
        try:
            response = self._agent(prompt)
            raw_text = str(response)
        except Exception as e:
            raise GoalPlanningError(
                f'❌ Goal planning failed — LLM call error: {e}. '
                f'Attempted objective: "{objective}"'
            ) from e

        # Parse JSON from response
        steps_raw = self._parse_json(raw_text)
        if steps_raw is None:
            raise GoalPlanningError(
                f'❌ Goal planning failed — could not parse LLM output as JSON.\n'
                f'Raw output (first 500 chars): {raw_text[:500]}\n'
                f'Attempted objective: "{objective}"'
            )

        if not isinstance(steps_raw, list):
            raise GoalPlanningError(
                f'❌ Goal planning failed — LLM output is not a JSON array.\n'
                f'Attempted objective: "{objective}"'
            )

        # Validate and build PlanStep list
        steps: list[PlanStep] = []
        permitted_set = set(self._permitted_scripts)

        for i, entry in enumerate(steps_raw):
            if not isinstance(entry, dict):
                continue

            script = entry.get('script', '')
            if script not in permitted_set:
                print(
                    f'\033[33m⚠️  Plan step {i}: skipping "{script}" '
                    f'— not in permitted scripts\033[0m',
                    file=sys.stderr,
                )
                continue

            flags = entry.get('flags', [])
            if not isinstance(flags, list):
                flags = []
            flags = [str(f) for f in flags]

            rationale = str(entry.get('rationale', ''))
            klass = self._execution_config.decide(script)

            steps.append(PlanStep(
                script=script,
                flags=flags,
                klass=klass,
                rationale=rationale,
            ))

        if not steps:
            raise GoalPlanningError(
                f'❌ Goal planning failed — plan is empty after validation.\n'
                f'Permitted scripts: {self._permitted_scripts}\n'
                f'Attempted objective: "{objective}"'
            )

        return steps

    def _parse_json(self, text: str) -> Any | None:
        """Attempt to extract a JSON array from LLM output.

        Handles cases where the LLM wraps JSON in markdown code fences.

        Args:
            text: Raw LLM output string.

        Returns:
            Parsed JSON value or None if parsing fails.
        """
        # Try direct parse
        try:
            return json.loads(text.strip())
        except json.JSONDecodeError:
            pass

        # Try stripping markdown fences
        stripped = text.strip()
        if stripped.startswith('```'):
            lines = stripped.split('\n')
            # Remove first line (```json or ```) and last line (```)
            inner_lines = []
            started = False
            for line in lines:
                if not started and line.strip().startswith('```'):
                    started = True
                    continue
                if started and line.strip() == '```':
                    break
                if started:
                    inner_lines.append(line)
            if inner_lines:
                try:
                    return json.loads('\n'.join(inner_lines))
                except json.JSONDecodeError:
                    pass

        # Try finding first [ ... ] bracket pair
        start = text.find('[')
        end = text.rfind(']')
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass

        return None
