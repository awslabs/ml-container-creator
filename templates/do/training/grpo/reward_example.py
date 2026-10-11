# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""GRPO reward functions — WORKED EXAMPLE. Replace this with your own logic.

This is the file you edit. GRPO is a super-user, self-managed RL technique: the
reward is computed HERE, in-process, inside the training job — there is no
managed SageMaker evaluator, no Lambda, no registered evaluator asset in the
loop. (If you want a managed, registered reward instead, that is the `do/tune`
RFT path — a different surface. See docs/fine-tuning.md.)

────────────────────────────────────────────────────────────────────────────────
REWARD FUNCTION CONTRACT (TRL GRPOTrainer)
────────────────────────────────────────────────────────────────────────────────
A reward function is a plain Python callable with this signature:

    def my_reward(completions, prompts=None, **kwargs) -> list[float]:
        ...

- `completions`  : the sampled completions to score. For a plain prompt dataset
                   (a `prompt` column of strings) each element is a STRING. For a
                   conversational dataset each element is a list of one message
                   dict `[{"role": "assistant", "content": "..."}]` — use
                   `_as_text()` below to normalize either shape.
- `prompts`      : the prompts the completions were sampled from (same length /
                   shape as `completions`). Optional — accept it so you can score
                   relative to the prompt.
- `**kwargs`     : every OTHER column of your dataset arrives here by name
                   (e.g. a `solution` or `answer` column → `kwargs["solution"]`),
                   one entry per sampled completion. `**kwargs` is REQUIRED in the
                   signature even if unused — GRPOTrainer passes extra columns and
                   the call fails without it.
- RETURN         : a `list[float]`, ONE scalar reward per completion, in the same
                   order as `completions`. Higher = better. `None` is allowed for
                   an individual element to mean "no opinion" (TRL skips it).

You can define MULTIPLE reward functions and GRPO sums them (optionally weighted
via GRPOConfig.reward_weights). `train.py` imports `REWARD_FUNCS` from this file,
so add or remove entries in that list to change which rewards are active.
────────────────────────────────────────────────────────────────────────────────
"""

import re


def _as_text(completion):
    """Normalize a completion to a plain string.

    Handles both dataset shapes: a plain string (standard prompt dataset) or a
    conversational list-of-messages `[{"role": ..., "content": ...}]`.
    """
    if isinstance(completion, str):
        return completion
    if isinstance(completion, list) and completion and isinstance(completion[-1], dict):
        return completion[-1].get("content", "")
    return str(completion)


# ── Example reward 1: prefer a target length ───────────────────────────────────
# A deliberately simple, domain-agnostic reward: score highest when the
# completion is close to a target character length, falling off linearly. This
# exists only to show the contract end-to-end — DELETE IT and write a reward that
# reflects what "good" means for your task (correctness, format, safety, etc.).
_TARGET_LEN = 400
_MAX_LEN_PENALTY = 400.0


def length_reward(completions, prompts=None, **kwargs):
    """Reward completions whose length is near _TARGET_LEN characters."""
    rewards = []
    for completion in completions:
        text = _as_text(completion)
        distance = abs(len(text) - _TARGET_LEN)
        # 1.0 at exactly the target, decaying to 0.0 at _MAX_LEN_PENALTY away.
        rewards.append(max(0.0, 1.0 - distance / _MAX_LEN_PENALTY))
    return rewards


# ── Example reward 2: reward a required answer format ──────────────────────────
# Many GRPO tasks reward STRUCTURE as well as content — e.g. the model must put
# its final answer inside <answer>…</answer>. This is the canonical "format
# reward" pattern. Replace the regex / logic with your task's structure.
_ANSWER_RE = re.compile(r"<answer>.*?</answer>", re.DOTALL)


def format_reward(completions, prompts=None, **kwargs):
    """Reward 1.0 when the completion contains an <answer>…</answer> block, else 0.0."""
    return [1.0 if _ANSWER_RE.search(_as_text(c)) else 0.0 for c in completions]


# ── The active reward set ───────────────────────────────────────────────────────
# train.py imports this list. GRPO sums the rewards from every function here
# (optionally weighted via GRPOConfig.reward_weights). Edit this list — add your
# own reward functions, remove the examples — to control the training signal.
REWARD_FUNCS = [length_reward, format_reward]
