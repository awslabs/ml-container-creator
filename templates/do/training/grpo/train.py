#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Self-managed GRPO fine-tuning using TRL GRPOTrainer + PEFT LoRA.

Group Relative Policy Optimization (GRPO) is a reinforcement-learning technique
that samples several completions per prompt, scores each with one or more REWARD
FUNCTIONS, and updates the policy from the group-relative advantage — the sampled
group is its own baseline, so there is no separate value/critic model.

SUPER-USER SURFACE: the reward is computed by in-process Python callables you
author in reward_example.py (imported here as REWARD_FUNCS). There is NO managed
SageMaker evaluator, Lambda, or registered evaluator asset in this loop — editing
reward_example.py (and this script) is the intended workflow, exactly like the
`custom/` recipe. The managed-RL path (a registered evaluator asset / ARN) is a
different surface — `do/tune` — see docs/fine-tuning.md.

Portable env-var contract (works on SageMaker AI and HyperPod EKS):
    DATA_DIR / SM_CHANNEL_TRAINING   -> training data path
    OUTPUT_DIR / SM_MODEL_DIR        -> model artifact output
    CHECKPOINT_DIR / SM_CHECKPOINT_DIR -> checkpoint path for spot resume
    HF_MODEL_ID / SM_HP_MODEL_ID     -> base (policy) model HuggingFace ID
    SM_HPS                           -> JSON blob of all hyperparameters

Dataset format:
    A PROMPT dataset — JSONL with a `prompt` field (NOT prompt/completion pairs
    or chosen/rejected pairs; GRPO generates its own completions).
    Example: {"prompt": "Explain why the sky is blue."}
    Any OTHER columns (e.g. "solution", "answer") are passed through to the reward
    functions as keyword arguments (one value per sampled completion).

Output:
    LoRA adapter saved to OUTPUT_DIR (adapter_model.safetensors + adapter_config.json)
    Metrics logged to stdout in SageMaker-parseable format
"""

import glob
import importlib.util
import json
import logging
import os
import sys

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("grpo-trainer")

# ── Portable Path Resolution ─────────────────────────────────────────────────
# Fallback chain: generic env var -> SageMaker env var -> default path

DATA_DIR = (
    os.environ.get("DATA_DIR")
    or os.environ.get("SM_CHANNEL_TRAINING")
    or "/opt/ml/input/data/training"
)

OUTPUT_DIR = (
    os.environ.get("OUTPUT_DIR")
    or os.environ.get("SM_MODEL_DIR")
    or "/opt/ml/model"
)

CHECKPOINT_DIR = (
    os.environ.get("CHECKPOINT_DIR")
    or os.environ.get("SM_CHECKPOINT_DIR")
    or "/opt/ml/checkpoints"
)

MODEL_ID = (
    os.environ.get("HF_MODEL_ID")
    or os.environ.get("SM_HP_MODEL_ID")
    or ""
)


# ── Hyperparameter Loading ────────────────────────────────────────────────────

def load_hyperparameters():
    """Load hyperparameters from SageMaker SM_HPS env var or individual SM_HP_* vars.

    Keys mirror defaults.yaml. The shared keys (learning_rate, epochs, batch_size,
    beta, lora_r) are the ones `do/train`'s --flags override; the GRPO-specific
    keys (num_generations, max_completion_length, max_prompt_length, prompt_field)
    are set via defaults.yaml / config.yaml.

    Returns:
        dict with typed hyperparameter values.
    """
    defaults = {
        "model_id": MODEL_ID,
        # GRPO-specific
        "num_generations": 8,
        "max_completion_length": 256,
        "max_prompt_length": 512,
        "prompt_field": "prompt",
        # Shared (overridable via --flags)
        "beta": 0.04,
        "learning_rate": 1e-6,
        "epochs": 1,
        "batch_size": 1,
        "gradient_accumulation_steps": 8,
        "warmup_ratio": 0.03,
        # LoRA
        "lora_r": 16,
        "lora_alpha": 32,
        "lora_dropout": 0.05,
    }

    # Try SM_HPS (JSON blob of all hyperparameters)
    sm_hps = os.environ.get("SM_HPS")
    if sm_hps:
        try:
            raw = json.loads(sm_hps)
            for key, default_val in defaults.items():
                if key in raw:
                    defaults[key] = _cast(raw[key], type(default_val))
            return defaults
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("Failed to parse SM_HPS: %s", e)

    # Fallback: individual SM_HP_* env vars
    for key, default_val in defaults.items():
        env_key = f"SM_HP_{key.upper()}"
        env_val = os.environ.get(env_key)
        if env_val is not None:
            defaults[key] = _cast(env_val, type(default_val))

    return defaults


def _cast(value, target_type):
    """Cast a string value to the target type."""
    if target_type == bool:
        return str(value).lower() in ("true", "1", "yes")
    if target_type == int:
        return int(float(value))
    if target_type == float:
        return float(value)
    return str(value)


# ── Reward-function loading ────────────────────────────────────────────────────

def load_reward_funcs():
    """Import REWARD_FUNCS from the sibling reward_example.py.

    The reward functions execute IN-PROCESS inside this training job — this is the
    GRPO super-user contract. We import by file path (not package import) so the
    recipe works regardless of how SageMaker lays out /opt/ml/code.

    Returns:
        list of reward callables (see reward_example.py for the contract).
    """
    reward_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reward_example.py")
    if not os.path.isfile(reward_path):
        logger.error(
            "reward_example.py not found next to train.py (%s). GRPO needs at least "
            "one in-process reward function.", reward_path,
        )
        sys.exit(1)

    spec = importlib.util.spec_from_file_location("grpo_reward", reward_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    reward_funcs = getattr(module, "REWARD_FUNCS", None)
    if not reward_funcs:
        logger.error("reward_example.py must define a non-empty REWARD_FUNCS list.")
        sys.exit(1)

    logger.info("Loaded %d in-process reward function(s): %s",
                len(reward_funcs), [getattr(f, "__name__", repr(f)) for f in reward_funcs])
    return reward_funcs


# ── Dataset Loading ───────────────────────────────────────────────────────────

def load_prompt_dataset(data_dir, prompt_field):
    """Load the GRPO prompt dataset from the data directory.

    Expects JSONL/JSON/parquet/csv with at least a prompt column. GRPO generates
    its own completions, so no completion/chosen/rejected columns are required.
    Any extra columns are preserved and passed through to the reward functions.

    Args:
        data_dir: Path to directory containing training data files.
        prompt_field: Column name holding the prompt text.

    Returns:
        A Hugging Face Dataset object with the prompt column named 'prompt'
        (GRPOTrainer's expected column).
    """
    from datasets import load_dataset as hf_load_dataset

    extensions = ["jsonl", "json", "parquet", "csv"]
    data_files = []
    for ext in extensions:
        data_files.extend(glob.glob(os.path.join(data_dir, f"*.{ext}")))
        data_files.extend(glob.glob(os.path.join(data_dir, f"**/*.{ext}"), recursive=True))

    if not data_files:
        logger.error("No data files found in %s (searched: %s)", data_dir, extensions)
        sys.exit(1)

    data_files = sorted(set(data_files))
    logger.info("Found %d data file(s) in %s", len(data_files), data_dir)

    first_ext = data_files[0].rsplit(".", 1)[-1].lower()
    format_map = {"jsonl": "json", "json": "json", "parquet": "parquet", "csv": "csv"}
    file_format = format_map.get(first_ext, "json")

    dataset = hf_load_dataset(file_format, data_files=data_files, split="train")
    logger.info("Loaded dataset: %d rows, columns: %s", len(dataset), dataset.column_names)

    if prompt_field not in dataset.column_names:
        logger.error(
            "Prompt field '%s' not found in dataset. Available columns: %s. "
            "Use --column-map to rename (e.g. --column-map prompt=question).",
            prompt_field, dataset.column_names,
        )
        sys.exit(1)

    # GRPOTrainer expects the prompt column to be named 'prompt'. Rename if needed;
    # all other columns are left intact and forwarded to the reward functions.
    if prompt_field != "prompt":
        dataset = dataset.rename_column(prompt_field, "prompt")

    return dataset


# ── Main Training Function ────────────────────────────────────────────────────

def main():
    """Run GRPO training with TRL GRPOTrainer + PEFT LoRA."""
    from accelerate import Accelerator
    from peft import LoraConfig, TaskType
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import GRPOConfig, GRPOTrainer

    accelerator = Accelerator()

    hparams = load_hyperparameters()
    model_id = hparams["model_id"]

    if not model_id:
        logger.error("No model ID specified. Set HF_MODEL_ID env var or model_id hyperparameter.")
        sys.exit(1)

    if hparams["num_generations"] < 2:
        logger.error(
            "num_generations must be >= 2 (GRPO's group-relative baseline needs a "
            "group); got %s.", hparams["num_generations"],
        )
        sys.exit(1)

    if accelerator.is_main_process:
        logger.info("=" * 60)
        logger.info("GRPO Training Configuration")
        logger.info("=" * 60)
        logger.info("  Model (policy):     %s", model_id)
        logger.info("  Data dir:           %s", DATA_DIR)
        logger.info("  Output dir:         %s", OUTPUT_DIR)
        logger.info("  Checkpoint dir:     %s", CHECKPOINT_DIR)
        logger.info("  Generations/prompt: %d", hparams["num_generations"])
        logger.info("  Max completion len: %d", hparams["max_completion_length"])
        logger.info("  Max prompt len:     %d", hparams["max_prompt_length"])
        logger.info("  Beta (KL):          %s", hparams["beta"])
        logger.info("  LoRA r:             %d", hparams["lora_r"])
        logger.info("  Learning rate:      %s", hparams["learning_rate"])
        logger.info("  Epochs:             %d", hparams["epochs"])
        logger.info("  Batch size:         %d", hparams["batch_size"])
        logger.info("  Prompt field:       %s", hparams["prompt_field"])
        logger.info("=" * 60)

    # ── Load the in-process reward function(s) ────────────────────────────────
    reward_funcs = load_reward_funcs()

    # ── Load tokenizer and policy model ───────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Loading tokenizer and policy model: %s", model_id)

    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype="auto",
        trust_remote_code=True,
    )

    # ── Configure LoRA ────────────────────────────────────────────────────────
    lora_config = LoraConfig(
        r=hparams["lora_r"],
        lora_alpha=hparams["lora_alpha"],
        lora_dropout=hparams["lora_dropout"],
        target_modules="all-linear",
        task_type=TaskType.CAUSAL_LM,
    )

    # ── Load prompt dataset ───────────────────────────────────────────────────
    dataset = load_prompt_dataset(DATA_DIR, hparams["prompt_field"])

    # ── GRPO training configuration ───────────────────────────────────────────
    training_args = GRPOConfig(
        output_dir=os.path.join(CHECKPOINT_DIR, "trainer-state"),
        num_train_epochs=hparams["epochs"],
        per_device_train_batch_size=hparams["batch_size"],
        gradient_accumulation_steps=hparams["gradient_accumulation_steps"],
        learning_rate=hparams["learning_rate"],
        warmup_ratio=hparams["warmup_ratio"],
        beta=hparams["beta"],
        num_generations=hparams["num_generations"],
        max_completion_length=hparams["max_completion_length"],
        max_prompt_length=hparams["max_prompt_length"],
        bf16=True,
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=2,
        report_to="none",
    )

    # ── Check for existing checkpoint (spot resume) ───────────────────────────
    resume_from_checkpoint = None
    trainer_state_dir = os.path.join(CHECKPOINT_DIR, "trainer-state")
    if os.path.isdir(trainer_state_dir):
        checkpoints = sorted(
            glob.glob(os.path.join(trainer_state_dir, "checkpoint-*")),
            key=lambda x: int(x.rsplit("-", 1)[-1]) if x.rsplit("-", 1)[-1].isdigit() else 0,
        )
        if checkpoints:
            resume_from_checkpoint = checkpoints[-1]
            if accelerator.is_main_process:
                logger.info("Resuming from checkpoint: %s", resume_from_checkpoint)

    # ── Initialize GRPOTrainer ────────────────────────────────────────────────
    # GRPOTrainer samples num_generations completions per prompt, scores each with
    # the reward functions, and updates from the group-relative advantage. The
    # reference policy (for the KL/beta term) is created internally from the base
    # model — no separate critic model.
    trainer = GRPOTrainer(
        model=model,
        reward_funcs=reward_funcs,
        args=training_args,
        train_dataset=dataset,
        processing_class=tokenizer,
        peft_config=lora_config,
    )

    # ── Train ─────────────────────────────────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Starting GRPO training...")

    train_result = trainer.train(resume_from_checkpoint=resume_from_checkpoint)

    # ── Save adapter (rank 0 only) ────────────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Saving LoRA adapter to: %s", OUTPUT_DIR)
        trainer.save_model(OUTPUT_DIR)
        tokenizer.save_pretrained(OUTPUT_DIR)

        metrics = train_result.metrics
        print(f"train_loss: {metrics.get('train_loss', 0.0):.4f}")
        print(f"train_runtime: {metrics.get('train_runtime', 0.0):.1f}")
        print(f"train_samples_per_second: {metrics.get('train_samples_per_second', 0.0):.2f}")

        # GRPO reward metrics (logged by GRPOTrainer during training).
        reward_mean = metrics.get("reward", metrics.get("train_reward", None))
        reward_std = metrics.get("reward_std", metrics.get("train_reward_std", None))
        if reward_mean is not None:
            print(f"reward: {reward_mean:.4f}")
        if reward_std is not None:
            print(f"reward_std: {reward_std:.4f}")

        print(f"epochs: {hparams['epochs']}")

        logger.info("Training complete!")
        logger.info("  Loss:    %.4f", metrics.get("train_loss", 0.0))
        logger.info("  Runtime: %.1fs", metrics.get("train_runtime", 0.0))
        if reward_mean is not None:
            logger.info("  Mean reward: %.4f", reward_mean)

    accelerator.wait_for_everyone()


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()
