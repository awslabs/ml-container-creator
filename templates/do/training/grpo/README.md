# GRPO recipe (`do/train --technique grpo`)

Group Relative Policy Optimization — a **self-managed** reinforcement-learning
technique on the `do/train` super-user surface. GRPO samples several completions
per prompt, scores each with **your own in-process reward function(s)**, and
updates the policy from the group-relative advantage (the sampled group is its
own baseline — no separate value/critic model).

## When to use GRPO

Use GRPO when you want reinforcement learning and you want to **own and edit the
reward logic in Python**. The reward runs inside the training job; there is no
managed evaluator service in the loop.

- **Self-managed RL → `do/train --technique grpo`** (this recipe): reward is an
  in-process Python callable you write in `reward_example.py`.
- **Managed RL (RLVR/RLAIF/MTRL) → `do/tune`**: reward is a separately-registered
  SageMaker evaluator asset (an ARN), and SageMaker runs the customization. You
  do not write the training loop.

Both say "reward function," but they are different things: GRPO's is a Python
callable in this directory; the managed path's is a registered Lambda evaluator
asset. See `docs/fine-tuning.md` for the full comparison.

## Files

| File | Purpose |
|---|---|
| `train.py` | The GRPO training loop (TRL `GRPOTrainer` + PEFT LoRA). Imports `REWARD_FUNCS` from `reward_example.py`. |
| `reward_example.py` | **The file you edit.** Worked example reward functions + the reward-function contract. |
| `defaults.yaml` | Default hyperparameters (group size, KL/beta, lengths, LoRA, …). |
| `accelerate_config.yaml` | FSDP-ready accelerate config (single- and multi-GPU). |

## The reward-function contract

A reward function is a plain Python callable:

```python
def my_reward(completions, prompts=None, **kwargs) -> list[float]:
    # one float per completion, higher = better
    ...
```

- `completions` — the sampled completions (strings for a plain prompt dataset, or
  `[{"role": ..., "content": ...}]` lists for a conversational one).
- `prompts` — the prompts they were sampled from (optional; accept it to score
  relative to the prompt).
- `**kwargs` — every other dataset column, by name (e.g. a `solution` column →
  `kwargs["solution"]`). **Required** in the signature even if unused.
- returns a `list[float]` — one reward per completion, same order.

Define as many reward functions as you like and list them in `REWARD_FUNCS`;
GRPO sums them. **Editing `reward_example.py` is the intended workflow** — the
shipped functions (a length reward and an `<answer>…</answer>` format reward) are
placeholders to show the contract end-to-end; replace them with rewards that
reflect what "good" means for your task.

## Dataset

GRPO needs a **prompt dataset** — a `prompt` column of strings (GRPO generates
its own completions, so no completion/chosen/rejected columns). Any extra columns
are forwarded to your reward functions as keyword arguments.

```jsonl
{"prompt": "Explain why the sky is blue.", "solution": "Rayleigh scattering"}
```

Resolve it through the shared `do/train` dataset path — `--dataset s3://…`,
`--dataset hf://org/name`, or a registered name/`@v<N>` — and rename a differently
named prompt column with `--column-map prompt=question`.

## Hyperparameters

Set via `defaults.yaml` → `training/config.yaml` → CLI flags (highest priority).
The shared flags work as for the other recipes: `--learning-rate`, `--epochs`,
`--batch-size`, `--beta` (the KL coefficient), `--lora-r`. GRPO-specific knobs
(`num_generations`, `max_completion_length`, `max_prompt_length`, `prompt_field`)
live in `defaults.yaml` / `config.yaml`.

## GPU requirement

GRPO runs on-policy generation **and** training in the same job and holds a
reference policy for the KL term, so it is more demanding than SFT. **Do not run
it on CPU or an under-provisioned instance.** A single `ml.g5.xlarge` (1× A10G,
24 GB) is the floor for a small (≤3B) policy with LoRA and short completions;
larger policies, longer completions, or a bigger `num_generations` group want a
multi-GPU instance such as `ml.g5.12xlarge` (4× A10G). Set the instance in
`training/config.yaml`.

## Dry run

```bash
./do/train --technique grpo --dry-run
```

validates inputs and prints the resolved training-job request without submitting.
