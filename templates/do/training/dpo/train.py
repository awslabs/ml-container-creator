#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unmanaged DPO fine-tuning using TRL DPOTrainer + PEFT LoRA.

Direct Preference Optimization trains a model to prefer chosen responses
over rejected responses without explicit reward modeling. This script uses
TRL's DPOTrainer with PEFT LoRA for parameter-efficient training.

Portable env-var contract (works on SageMaker AI and HyperPod EKS):
    DATA_DIR / SM_CHANNEL_TRAINING   -> training data path
    OUTPUT_DIR / SM_MODEL_DIR        -> model artifact output
    CHECKPOINT_DIR / SM_CHECKPOINT_DIR -> checkpoint path for spot resume
    HF_MODEL_ID / SM_HP_MODEL_ID     -> base model HuggingFace ID
    SM_HPS                           -> JSON blob of all hyperparameters

Dataset format:
    JSONL with fields: prompt, chosen, rejected
    Example: {"prompt": "Explain X", "chosen": "Good answer", "rejected": "Bad answer"}

Output:
    LoRA adapter saved to OUTPUT_DIR (adapter_model.safetensors + adapter_config.json)
    Metrics logged to stdout in SageMaker-parseable format
"""

import glob
import json
import logging
import os
import sys

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("dpo-trainer")

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

    Returns:
        dict with typed hyperparameter values.
    """
    defaults = {
        "model_id": MODEL_ID,
        "beta": 0.1,
        "lora_r": 16,
        "lora_alpha": 32,
        "lora_dropout": 0.05,
        "learning_rate": 5e-7,
        "epochs": 1,
        "batch_size": 2,
        "max_length": 1024,
        "max_prompt_length": 512,
        "gradient_accumulation_steps": 4,
        "warmup_ratio": 0.03,
        "chosen_field": "chosen",
        "rejected_field": "rejected",
        "prompt_field": "prompt",
        "reference_free": False,
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


# ── Dataset Loading ───────────────────────────────────────────────────────────

def load_preference_dataset(data_dir, chosen_field, rejected_field, prompt_field):
    """Load DPO preference dataset from data directory.

    Expects JSONL with at minimum `chosen` and `rejected` fields.
    Optionally includes a `prompt` field for conditional DPO.

    Args:
        data_dir: Path to directory containing training data files.
        chosen_field: Column name for preferred responses.
        rejected_field: Column name for dispreferred responses.
        prompt_field: Column name for prompts (optional).

    Returns:
        A Hugging Face Dataset object.
    """
    from datasets import load_dataset as hf_load_dataset

    # Find data files
    extensions = ["jsonl", "json", "parquet", "csv"]
    data_files = []
    for ext in extensions:
        data_files.extend(glob.glob(os.path.join(data_dir, f"*.{ext}")))
        data_files.extend(glob.glob(os.path.join(data_dir, f"**/*.{ext}"), recursive=True))

    if not data_files:
        logger.error("No data files found in %s (searched: %s)", data_dir, extensions)
        sys.exit(1)

    # Deduplicate and sort
    data_files = sorted(set(data_files))
    logger.info("Found %d data file(s) in %s", len(data_files), data_dir)

    # Determine format from first file extension
    first_ext = data_files[0].rsplit(".", 1)[-1].lower()
    format_map = {"jsonl": "json", "json": "json", "parquet": "parquet", "csv": "csv"}
    file_format = format_map.get(first_ext, "json")

    dataset = hf_load_dataset(file_format, data_files=data_files, split="train")
    logger.info("Loaded dataset: %d rows, columns: %s", len(dataset), dataset.column_names)

    # Verify required fields exist
    missing = []
    if chosen_field not in dataset.column_names:
        missing.append(f"chosen_field='{chosen_field}'")
    if rejected_field not in dataset.column_names:
        missing.append(f"rejected_field='{rejected_field}'")

    if missing:
        logger.error(
            "Required fields not found in dataset: %s. Available columns: %s",
            ", ".join(missing), dataset.column_names,
        )
        sys.exit(1)

    # Check for optional prompt field
    has_prompt = prompt_field in dataset.column_names
    if has_prompt:
        logger.info("Prompt field '%s' found — using conditional DPO", prompt_field)
    else:
        logger.info("No prompt field '%s' — using unconditional DPO", prompt_field)

    return dataset


# ── Main Training Function ────────────────────────────────────────────────────

def main():
    """Run DPO training with TRL DPOTrainer + PEFT LoRA."""
    from accelerate import Accelerator
    from peft import LoraConfig, TaskType
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import DPOConfig, DPOTrainer

    # Initialize accelerator (handles distributed setup)
    accelerator = Accelerator()

    # Load hyperparameters
    hparams = load_hyperparameters()
    model_id = hparams["model_id"]

    if not model_id:
        logger.error("No model ID specified. Set HF_MODEL_ID env var or model_id hyperparameter.")
        sys.exit(1)

    if accelerator.is_main_process:
        logger.info("=" * 60)
        logger.info("DPO Training Configuration")
        logger.info("=" * 60)
        logger.info("  Model:          %s", model_id)
        logger.info("  Data dir:       %s", DATA_DIR)
        logger.info("  Output dir:     %s", OUTPUT_DIR)
        logger.info("  Checkpoint dir: %s", CHECKPOINT_DIR)
        logger.info("  Beta:           %s", hparams["beta"])
        logger.info("  LoRA r:         %d", hparams["lora_r"])
        logger.info("  LoRA alpha:     %d", hparams["lora_alpha"])
        logger.info("  Learning rate:  %s", hparams["learning_rate"])
        logger.info("  Epochs:         %d", hparams["epochs"])
        logger.info("  Batch size:     %d", hparams["batch_size"])
        logger.info("  Max length:     %d", hparams["max_length"])
        logger.info("  Chosen field:   %s", hparams["chosen_field"])
        logger.info("  Rejected field: %s", hparams["rejected_field"])
        logger.info("  Prompt field:   %s", hparams["prompt_field"])
        logger.info("  Reference free: %s", hparams["reference_free"])
        logger.info("=" * 60)

    # ── Load tokenizer and model ──────────────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Loading tokenizer and model: %s", model_id)

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

    # ── Load preference dataset ───────────────────────────────────────────────
    dataset = load_preference_dataset(
        DATA_DIR,
        hparams["chosen_field"],
        hparams["rejected_field"],
        hparams["prompt_field"],
    )

    # ── DPO training configuration ───────────────────────────────────────────
    training_args = DPOConfig(
        output_dir=os.path.join(CHECKPOINT_DIR, "trainer-state"),
        num_train_epochs=hparams["epochs"],
        per_device_train_batch_size=hparams["batch_size"],
        gradient_accumulation_steps=hparams["gradient_accumulation_steps"],
        learning_rate=hparams["learning_rate"],
        warmup_ratio=hparams["warmup_ratio"],
        beta=hparams["beta"],
        max_length=hparams["max_length"],
        max_prompt_length=hparams["max_prompt_length"],
        bf16=True,
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=2,
        report_to="none",
        remove_unused_columns=False,
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

    # ── Initialize DPOTrainer ─────────────────────────────────────────────────
    # DPOTrainer creates the reference model internally (frozen copy of base).
    # With reference_free=True, it skips the reference model to save memory.
    trainer_kwargs = {
        "model": model,
        "args": training_args,
        "train_dataset": dataset,
        "processing_class": tokenizer,
        "peft_config": lora_config,
    }

    # Handle reference-free mode (skips frozen reference model to save memory)
    if hparams["reference_free"]:
        trainer_kwargs["ref_model"] = None
        if accelerator.is_main_process:
            logger.info("Reference-free mode: skipping reference model (saves ~50%% memory)")

    trainer = DPOTrainer(**trainer_kwargs)

    # ── Train ─────────────────────────────────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Starting DPO training...")

    train_result = trainer.train(resume_from_checkpoint=resume_from_checkpoint)

    # ── Save adapter (rank 0 only) ───────────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Saving LoRA adapter to: %s", OUTPUT_DIR)
        trainer.save_model(OUTPUT_DIR)
        tokenizer.save_pretrained(OUTPUT_DIR)

        # ── Log final metrics ─────────────────────────────────────────────────
        # DPO-specific metrics: rewards/chosen, rewards/rejected, rewards/margins
        metrics = train_result.metrics
        print(f"train_loss: {metrics.get('train_loss', 0.0):.4f}")
        print(f"train_runtime: {metrics.get('train_runtime', 0.0):.1f}")
        print(f"train_samples_per_second: {metrics.get('train_samples_per_second', 0.0):.2f}")

        # DPO reward metrics (logged by DPOTrainer during training)
        rewards_chosen = metrics.get("rewards/chosen", metrics.get("train_rewards/chosen", None))
        rewards_rejected = metrics.get("rewards/rejected", metrics.get("train_rewards/rejected", None))
        if rewards_chosen is not None:
            print(f"rewards_chosen: {rewards_chosen:.4f}")
        if rewards_rejected is not None:
            print(f"rewards_rejected: {rewards_rejected:.4f}")
        if rewards_chosen is not None and rewards_rejected is not None:
            margin = rewards_chosen - rewards_rejected
            print(f"rewards_margin: {margin:.4f}")

        print(f"epochs: {hparams['epochs']}")

        logger.info("Training complete!")
        logger.info("  Loss:     %.4f", metrics.get("train_loss", 0.0))
        logger.info("  Runtime:  %.1fs", metrics.get("train_runtime", 0.0))
        if rewards_chosen is not None:
            logger.info("  Reward margin: %.4f (chosen=%.4f, rejected=%.4f)",
                       rewards_chosen - rewards_rejected, rewards_chosen, rewards_rejected)

    # Wait for all processes before exit
    accelerator.wait_for_everyone()


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()
