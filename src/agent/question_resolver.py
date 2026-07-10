# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Question resolver — resolves questions from context or user interaction.

Uses a priority ladder to find answers in project context before
falling back to interactive prompting.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any


@dataclass
class ResolvedAnswer:
    """A resolved answer to a planning question."""

    question: str
    answer: str
    source: str


class QuestionResolver:
    """Resolves planning questions from context or user prompts.

    Priority ladder:
      1. goal_text — infer from the goal itself
      2. project_context — do/config, IC confs, adapters, profile
      3. capability_matrix — supported features/engines
      4. instance_sizer_defaults — default instance types (NOT for infra_identifier)

    Args:
        agent: A Strands Agent instance for LLM-assisted resolution.
        context: Project context dict.
        auto_mode: When True, resolve silently without user prompts.
    """

    def __init__(self, agent: Any, context: dict, auto_mode: bool = False) -> None:
        self._agent = agent
        self._context = context
        self._auto_mode = auto_mode

    def resolve(self, question: str, question_type: str = 'general') -> ResolvedAnswer:
        """Resolve a single question using the priority ladder.

        Args:
            question: The question to resolve.
            question_type: Classification — "general" or "infra_identifier".
                           infra_identifier questions NEVER resolve from instance_sizer.

        Returns:
            ResolvedAnswer with the answer and source attribution.
        """
        # Priority 1: goal text (embedded in context under 'goal_text' key)
        goal_text = self._context.get('goal_text', '')
        if goal_text:
            answer = self._search_in_text(question, goal_text)
            if answer:
                return ResolvedAnswer(question=question, answer=answer, source='goal_text')

        # Priority 2: project_context
        project_keys = [
            'model', 'instance_type', 'engine', 'deployment_target',
            'region', 'project_name', 'framework', 'base_image',
        ]
        for key in project_keys:
            val = self._context.get(key)
            if val and self._is_relevant(question, key):
                return ResolvedAnswer(question=question, answer=str(val), source=f'project_context.{key}')

        # Priority 3: capability_matrix
        cap_matrix = self._context.get('capability_matrix', {})
        if isinstance(cap_matrix, dict):
            for key, val in cap_matrix.items():
                if self._is_relevant(question, key) and val:
                    return ResolvedAnswer(question=question, answer=str(val), source=f'capability_matrix.{key}')

        # Priority 4: instance_sizer_defaults (skip for infra_identifier)
        if question_type != 'infra_identifier':
            instance_defaults = self._context.get('instance_sizer_defaults', {})
            if isinstance(instance_defaults, dict):
                for key, val in instance_defaults.items():
                    if self._is_relevant(question, key) and val:
                        return ResolvedAnswer(
                            question=question, answer=str(val), source=f'instance_sizer_defaults.{key}'
                        )

        # Fallback: interactive prompt or silent log
        if self._auto_mode:
            # Under auto_mode, log and return empty
            print(
                f'\033[33m⚠️  Could not auto-resolve: "{question}" '
                f'(type={question_type})\033[0m',
                file=sys.stderr,
            )
            return ResolvedAnswer(question=question, answer='', source='unresolved')
        else:
            # Interactive: ask the user
            try:
                answer = input(f'🤔 {question}: ').strip()
                return ResolvedAnswer(question=question, answer=answer, source='user_input')
            except (EOFError, KeyboardInterrupt):
                print()
                return ResolvedAnswer(question=question, answer='', source='user_interrupted')

    def resolve_batch(self, questions: list[tuple[str, str]]) -> list[ResolvedAnswer]:
        """Resolve multiple questions.

        Under auto_mode, if any infra_identifier question is unresolvable,
        issues a single targeted prompt (AC-2.4).

        Args:
            questions: List of (question, question_type) tuples.

        Returns:
            List of ResolvedAnswer instances.
        """
        answers: list[ResolvedAnswer] = []
        unresolved_infra: list[tuple[int, str]] = []

        for i, (question, question_type) in enumerate(questions):
            resolved = self.resolve(question, question_type)
            answers.append(resolved)
            if resolved.source == 'unresolved' and question_type == 'infra_identifier':
                unresolved_infra.append((i, question))

        # AC-2.4: single targeted prompt for unresolved infra_identifier questions
        if self._auto_mode and unresolved_infra:
            prompt_lines = [
                'The following infrastructure identifiers could not be resolved from context.',
                'Please provide values:',
            ]
            for _, q in unresolved_infra:
                prompt_lines.append(f'  - {q}')

            combined_prompt = '\n'.join(prompt_lines)
            try:
                user_input = input(f'\n{combined_prompt}\n> ').strip()
                if user_input:
                    # Simple heuristic: if single unresolved, use full input
                    if len(unresolved_infra) == 1:
                        idx, q = unresolved_infra[0]
                        answers[idx] = ResolvedAnswer(question=q, answer=user_input, source='targeted_prompt')
                    else:
                        # Attempt comma-separated split
                        parts = [p.strip() for p in user_input.split(',')]
                        for j, (idx, q) in enumerate(unresolved_infra):
                            if j < len(parts) and parts[j]:
                                answers[idx] = ResolvedAnswer(question=q, answer=parts[j], source='targeted_prompt')
            except (EOFError, KeyboardInterrupt):
                print()

        return answers

    def _search_in_text(self, question: str, text: str) -> str | None:
        """Simple keyword search in text to find potential answers.

        Args:
            question: The question being asked.
            text: Text to search within.

        Returns:
            Extracted answer string or None.
        """
        # Simple heuristic: if the question keyword appears in text, return the text
        # This is a placeholder for more sophisticated NLP extraction
        q_lower = question.lower()
        t_lower = text.lower()
        keywords = [w for w in q_lower.split() if len(w) > 3]
        matches = sum(1 for k in keywords if k in t_lower)
        if matches >= len(keywords) * 0.5 and keywords:
            return text.strip()
        return None

    def _is_relevant(self, question: str, key: str) -> bool:
        """Check if a context key is relevant to the question.

        Args:
            question: The question being asked.
            key: The context key to check.

        Returns:
            True if the key seems relevant to the question.
        """
        # Normalize both to lowercase, check if key terms appear in question
        q_lower = question.lower().replace('_', ' ').replace('-', ' ')
        k_lower = key.lower().replace('_', ' ').replace('-', ' ')
        key_words = k_lower.split()
        return any(w in q_lower for w in key_words if len(w) > 2)
