#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unmanaged SFT fine-tuning using TRL SFTTrainer + PEFT LoRA.

This script performs LoRA-based supervised fine-tuning on a causal language
model. It is invoked via `accelerate launch` and works on both single-GPU
and multi-GPU instances without code changes.

Portable env-var contract (works on SageMaker AI and HyperPod EKS):
    DATA_DIR / SM_CHANNEL_TRAINING   -> training data path
    OUTPUT_DIR / SM_MODEL_DIR        -> model artifact output
    CHECKPOINT_DIR / SM_CHECKPOINT_DIR -> checkpoint path for spot resume
    HF_MODEL_ID / SM_HP_MODEL_ID     -> base model HuggingFace ID
    SM_HPS                           -> JSON blob of all hyperparameters

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
logger = logging.getLogger("sft-trainer")

# ── Portable Path Resolution ─────────────────────────────────────────────────
# Fallback chain: generic env var -> SageMaker env var -> default path
# This allows the same script to run on SageMaker, HyperPod, or locally.

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
        "lora_r": 16,
        "lora_alpha": 32,
        "lora_dropout": 0.05,
        "learning_rate": 2e-4,
        "epochs": 3,
        "batch_size": 4,
        "max_seq_length": 2048,
        "gradient_accumulation_steps": 4,
        "warmup_ratio": 0.03,
        "dataset_text_field": "text",
    }

    # Try SM_HPS (JSON blob of all hyperparameters)
    sm_hps = os.environ.get("SM_HPS")
    if sm_hps:
        try:
            raw = json.loads(sm_hps)
            # SageMaker passes all values as strings — cast them
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

def load_dataset(data_dir, text_field):
    """Load training dataset from data directory.

    Supports .jsonl, .parquet, and .csv files.

    Args:
        data_dir: Path to directory containing training data files.
        text_field: Name of the text column in the dataset.

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

    # Verify text field exists
    if text_field not in dataset.column_names:
        logger.error(
            "Text field '%s' not found in dataset. Available columns: %s",
            text_field, dataset.column_names,
        )
        sys.exit(1)

    return dataset


# ── Main Training Function ────────────────────────────────────────────────────

def main():
    """Run SFT training with TRL SFTTrainer + PEFT LoRA."""
    from accelerate import Accelerator
    from peft import LoraConfig, TaskType
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        TrainingArguments,
    )
    from trl import SFTTrainer

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
        logger.info("SFT Training Configuration")
        logger.info("=" * 60)
        logger.info("  Model:          %s", model_id)
        logger.info("  Data dir:       %s", DATA_DIR)
        logger.info("  Output dir:     %s", OUTPUT_DIR)
        logger.info("  Checkpoint dir: %s", CHECKPOINT_DIR)
        logger.info("  LoRA r:         %d", hparams["lora_r"])
        logger.info("  LoRA alpha:     %d", hparams["lora_alpha"])
        logger.info("  Learning rate:  %s", hparams["learning_rate"])
        logger.info("  Epochs:         %d", hparams["epochs"])
        logger.info("  Batch size:     %d", hparams["batch_size"])
        logger.info("  Max seq len:    %d", hparams["max_seq_length"])
        logger.info("  Text field:     %s", hparams["dataset_text_field"])
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

    # ── Load dataset ──────────────────────────────────────────────────────────
    dataset = load_dataset(DATA_DIR, hparams["dataset_text_field"])

    # ── Training arguments ────────────────────────────────────────────────────
    training_args = TrainingArguments(
        output_dir=os.path.join(CHECKPOINT_DIR, "trainer-state"),
        num_train_epochs=hparams["epochs"],
        per_device_train_batch_size=hparams["batch_size"],
        gradient_accumulation_steps=hparams["gradient_accumulation_steps"],
        learning_rate=hparams["learning_rate"],
        warmup_ratio=hparams["warmup_ratio"],
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

    # ── Initialize SFTTrainer ─────────────────────────────────────────────────
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        peft_config=lora_config,
        args=training_args,
        max_seq_length=hparams["max_seq_length"],
        dataset_text_field=hparams["dataset_text_field"],
    )

    # ── Train ─────────────────────────────────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Starting SFT training...")

    train_result = trainer.train(resume_from_checkpoint=resume_from_checkpoint)

    # ── Save adapter (rank 0 only) ───────────────────────────────────────────
    if accelerator.is_main_process:
        logger.info("Saving LoRA adapter to: %s", OUTPUT_DIR)
        trainer.save_model(OUTPUT_DIR)
        tokenizer.save_pretrained(OUTPUT_DIR)

        # ── Log final metrics ─────────────────────────────────────────────────
        # Format: metric_name: value (SageMaker captures via regex in config.yaml)
        metrics = train_result.metrics
        print(f"train_loss: {metrics.get('train_loss', 0.0):.4f}")
        print(f"train_runtime: {metrics.get('train_runtime', 0.0):.1f}")
        print(f"train_samples_per_second: {metrics.get('train_samples_per_second', 0.0):.2f}")
        print(f"epochs: {hparams['epochs']}")

        logger.info("Training complete!")
        logger.info("  Loss:     %.4f", metrics.get("train_loss", 0.0))
        logger.info("  Runtime:  %.1fs", metrics.get("train_runtime", 0.0))
        logger.info("  Samples/s: %.2f", metrics.get("train_samples_per_second", 0.0))

    # Wait for all processes before exit
    accelerator.wait_for_everyone()


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()
