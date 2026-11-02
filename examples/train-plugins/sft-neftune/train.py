#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Sample do/train technique: LoRA SFT with NEFTune embedding noise.

A copy-and-modify starting point for your own technique. It follows the shipped
`sft` recipe (TRL SFTTrainer + PEFT LoRA, same trainer API, same portable env-var
contract) and adds four knobs, each declared in manifest.json:

    neftune_noise_alpha  embedding noise during training (0 = off)
    lr_scheduler_type    learning-rate schedule
    packing              pack short examples into one sequence
    seed                 random seed

Portable env-var contract (SageMaker AI and HyperPod EKS):
    DATA_DIR / SM_CHANNEL_TRAINING     -> training data path
    OUTPUT_DIR / SM_MODEL_DIR          -> model artifact output
    CHECKPOINT_DIR / SM_CHECKPOINT_DIR -> checkpoint path for spot resume
    HF_MODEL_ID / SM_HP_MODEL_ID       -> base model HuggingFace id
    SM_HPS                             -> JSON blob of all hyperparameters

Output: a LoRA adapter in OUTPUT_DIR (adapter_model.safetensors + adapter_config.json).
"""

import glob
import json
import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("sft-neftune")

DATA_DIR = os.environ.get("DATA_DIR") or os.environ.get("SM_CHANNEL_TRAINING") or "/opt/ml/input/data/training"
OUTPUT_DIR = os.environ.get("OUTPUT_DIR") or os.environ.get("SM_MODEL_DIR") or "/opt/ml/model"
CHECKPOINT_DIR = os.environ.get("CHECKPOINT_DIR") or os.environ.get("SM_CHECKPOINT_DIR") or "/opt/ml/checkpoints"
MODEL_ID = os.environ.get("HF_MODEL_ID") or os.environ.get("SM_HP_MODEL_ID") or ""


def default_hyperparameters():
    """Every knob this script reads, with an in-script fallback value.

    Keep this in step with manifest.json: each key here should be a declared knob,
    and each declared knob should be read here. do/train passes the resolved values
    (defaults.yaml < config.yaml < --set) as strings in SM_HPS; these fallbacks only
    apply when a key is missing entirely.
    """
    return {
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
        "neftune_noise_alpha": 5.0,
        "lr_scheduler_type": "cosine",
        "packing": False,
        "seed": 42,
    }


def _cast(value, target_type):
    """SageMaker passes hyperparameters as strings; cast to the fallback's type."""
    if target_type is bool:
        return str(value).strip().lower() in ("true", "1", "yes")
    if target_type is int:
        return int(float(value))
    if target_type is float:
        return float(value)
    return str(value)


def load_hyperparameters():
    """Read hyperparameters from SM_HPS, else from individual SM_HP_<KEY> env vars."""
    hparams = default_hyperparameters()
    raw = {}
    sm_hps = os.environ.get("SM_HPS")
    if sm_hps:
        try:
            raw = json.loads(sm_hps)
        except json.JSONDecodeError as exc:
            logger.warning("Ignoring unparseable SM_HPS: %s", exc)
    for key, fallback in list(hparams.items()):
        value = raw.get(key, os.environ.get(f"SM_HP_{key.upper()}"))
        if value is not None:
            hparams[key] = _cast(value, type(fallback))
    return hparams


def load_dataset(data_dir, text_field):
    """Load .jsonl / .json / .parquet / .csv files from data_dir."""
    from datasets import load_dataset as hf_load_dataset

    files = []
    for ext in ("jsonl", "json", "parquet", "csv"):
        files.extend(glob.glob(os.path.join(data_dir, "**", f"*.{ext}"), recursive=True))
    files = sorted(set(files))
    if not files:
        logger.error("No data files found in %s", data_dir)
        sys.exit(1)
    fmt = {"jsonl": "json", "json": "json", "parquet": "parquet", "csv": "csv"}[files[0].rsplit(".", 1)[-1].lower()]
    dataset = hf_load_dataset(fmt, data_files=files, split="train")
    if text_field not in dataset.column_names:
        logger.error("Text column '%s' not in dataset columns %s", text_field, dataset.column_names)
        sys.exit(1)
    logger.info("Loaded %d rows from %d file(s)", len(dataset), len(files))
    return dataset


def main():
    from accelerate import Accelerator
    from peft import LoraConfig, TaskType
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
    from trl import SFTTrainer

    accelerator = Accelerator()
    hp = load_hyperparameters()
    if not hp["model_id"]:
        logger.error("No base model: set HF_MODEL_ID or the model_id hyperparameter.")
        sys.exit(1)
    if accelerator.is_main_process:
        logger.info("sft-neftune hyperparameters: %s", json.dumps(hp, sort_keys=True))

    tokenizer = AutoTokenizer.from_pretrained(hp["model_id"], trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(hp["model_id"], torch_dtype="auto", trust_remote_code=True)

    lora_config = LoraConfig(
        r=hp["lora_r"],
        lora_alpha=hp["lora_alpha"],
        lora_dropout=hp["lora_dropout"],
        target_modules="all-linear",
        task_type=TaskType.CAUSAL_LM,
    )

    training_args = TrainingArguments(
        output_dir=os.path.join(CHECKPOINT_DIR, "trainer-state"),
        num_train_epochs=hp["epochs"],
        per_device_train_batch_size=hp["batch_size"],
        gradient_accumulation_steps=hp["gradient_accumulation_steps"],
        learning_rate=hp["learning_rate"],
        warmup_ratio=hp["warmup_ratio"],
        lr_scheduler_type=hp["lr_scheduler_type"],
        # NEFTune is applied by the trainer when this is set; None turns it off.
        neftune_noise_alpha=hp["neftune_noise_alpha"] or None,
        seed=hp["seed"],
        bf16=True,
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=2,
        report_to="none",
        remove_unused_columns=False,
    )

    # Resume from the latest checkpoint if a spot interruption left one behind.
    resume = None
    checkpoints = glob.glob(os.path.join(CHECKPOINT_DIR, "trainer-state", "checkpoint-*"))
    if checkpoints:
        resume = max(checkpoints, key=lambda p: int(p.rsplit("-", 1)[-1]) if p.rsplit("-", 1)[-1].isdigit() else 0)
        if accelerator.is_main_process:
            logger.info("Resuming from %s", resume)

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=load_dataset(DATA_DIR, hp["dataset_text_field"]),
        peft_config=lora_config,
        args=training_args,
        max_seq_length=hp["max_seq_length"],
        dataset_text_field=hp["dataset_text_field"],
        packing=hp["packing"],
    )
    result = trainer.train(resume_from_checkpoint=resume)

    if accelerator.is_main_process:
        trainer.save_model(OUTPUT_DIR)
        tokenizer.save_pretrained(OUTPUT_DIR)
        metrics = result.metrics
        # SageMaker can scrape these lines via metric_definitions in config.yaml.
        print(f"train_loss: {metrics.get('train_loss', 0.0):.4f}")
        print(f"train_runtime: {metrics.get('train_runtime', 0.0):.1f}")
        print(f"epochs: {hp['epochs']}")
    accelerator.wait_for_everyone()


if __name__ == "__main__":
    main()
