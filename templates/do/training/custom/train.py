#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""SageMaker Training Script — Placeholder / Skeleton

This file demonstrates the contract that SageMaker expects from a custom
training script. Replace the placeholder logic with your own model training
code while keeping the I/O paths and conventions intact.

SageMaker copies this script into the container at /opt/ml/code/ and invokes
it as the entry point. The container filesystem is laid out as follows:

    /opt/ml/
    ├── input/
    │   ├── config/              # Training job configuration (JSON files)
    │   │   ├── hyperparameters.json
    │   │   ├── resourceconfig.json
    │   │   └── inputdataconfig.json
    │   └── data/                # Input data channels
    │       └── training/        # Default channel name (configurable)
    │           └── ...          # Your training data files
    ├── model/                   # Write final model artifacts here
    │   └── ...                  # Everything here is packaged as model.tar.gz
    ├── checkpoints/             # Save/restore checkpoints here (spot training)
    │   └── ...                  # Persisted to S3 between interruptions
    └── output/
        └── failure              # Write failure reason here on error

Key conventions:
  - Hyperparameters are passed as string key-value pairs (always strings!)
  - Training data is downloaded to /opt/ml/input/data/<channel_name>/
  - Final model artifacts MUST be written to /opt/ml/model/
  - Checkpoints in /opt/ml/checkpoints/ survive spot interruptions
  - Stdout/stderr are captured to CloudWatch Logs automatically
  - Exit code 0 = success, non-zero = failure
"""

import argparse
import json
import logging
import os
import sys

# ── Logging setup ─────────────────────────────────────────────────────────────
# SageMaker captures stdout/stderr to CloudWatch Logs automatically.
# Use structured logging for easier debugging in production.

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ── SageMaker environment paths ──────────────────────────────────────────────
# These paths are fixed by the SageMaker training container contract.

INPUT_DATA_DIR = os.environ.get("SM_CHANNEL_TRAINING", "/opt/ml/input/data/training")
MODEL_DIR = os.environ.get("SM_MODEL_DIR", "/opt/ml/model")
CHECKPOINT_DIR = "/opt/ml/checkpoints"
OUTPUT_DIR = "/opt/ml/output"
HYPERPARAMS_FILE = "/opt/ml/input/config/hyperparameters.json"
RESOURCE_CONFIG_FILE = "/opt/ml/input/config/resourceconfig.json"


# ── Hyperparameter loading ────────────────────────────────────────────────────


def load_hyperparameters():
    """Load hyperparameters from SageMaker's config file.

    SageMaker passes all hyperparameters as STRING values in a JSON file.
    You must cast them to the appropriate types in your code.

    Returns:
        dict: Hyperparameters with string values.

    Example hyperparameters.json:
        {
            "epochs": "10",
            "batch_size": "32",
            "learning_rate": "0.001"
        }
    """
    if os.path.exists(HYPERPARAMS_FILE):
        with open(HYPERPARAMS_FILE, "r") as f:
            params = json.load(f)
        logger.info("Loaded hyperparameters: %s", json.dumps(params, indent=2))
        return params

    logger.warning("No hyperparameters file found at %s", HYPERPARAMS_FILE)
    return {}


# ── Data loading ──────────────────────────────────────────────────────────────


def load_training_data(data_dir):
    """Load training data from the input channel directory.

    SageMaker downloads your dataset from S3 to this directory before
    training starts. The directory structure mirrors your S3 prefix.

    Args:
        data_dir: Path to the input data channel (e.g., /opt/ml/input/data/training).

    Returns:
        Your training data in whatever format your model expects.

    Example directory contents:
        /opt/ml/input/data/training/
        ├── train.csv
        ├── train.jsonl
        └── data_part_001.parquet
    """
    logger.info("Loading training data from: %s", data_dir)

    # List available files
    if os.path.isdir(data_dir):
        files = os.listdir(data_dir)
        logger.info("Found %d file(s): %s", len(files), files)
    else:
        logger.error("Data directory does not exist: %s", data_dir)
        sys.exit(1)

    # ─── Replace this with your actual data loading logic ───
    # Examples:
    #
    # For CSV:
    #   import pandas as pd
    #   df = pd.read_csv(os.path.join(data_dir, "train.csv"))
    #
    # For JSONL:
    #   records = []
    #   with open(os.path.join(data_dir, "train.jsonl")) as f:
    #       for line in f:
    #           records.append(json.loads(line))
    #
    # For PyTorch datasets:
    #   from torch.utils.data import DataLoader
    #   dataset = MyDataset(data_dir)
    #   dataloader = DataLoader(dataset, batch_size=32, shuffle=True)
    #
    # For Hugging Face datasets:
    #   from datasets import load_from_disk
    #   dataset = load_from_disk(data_dir)

    return None  # Replace with your loaded data


# ── Checkpoint management ─────────────────────────────────────────────────────
# Checkpoints are CRITICAL for managed spot training. When SageMaker interrupts
# a spot instance, it saves /opt/ml/checkpoints/ to S3. When the job resumes,
# it restores the checkpoint directory before re-running your script.
#
# Best practices:
#   - Save checkpoints periodically (e.g., every N epochs or steps)
#   - Include enough state to fully resume: model weights, optimizer state, epoch
#   - On startup, check if a checkpoint exists and resume from it
#   - Use atomic writes (write to temp file, then rename) to avoid corruption


def save_checkpoint(model_state, optimizer_state, epoch, step):
    """Save a training checkpoint for spot training resumption.

    Args:
        model_state: Model weights/parameters to save.
        optimizer_state: Optimizer state for resuming training.
        epoch: Current epoch number.
        step: Current global step number.

    The checkpoint directory (/opt/ml/checkpoints/) is automatically synced
    to S3 by SageMaker. On spot interruption and restart, the contents are
    restored before your script runs again.
    """
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)

    checkpoint = {
        "epoch": epoch,
        "step": step,
        # Add your model and optimizer state here:
        # "model_state_dict": model_state,
        # "optimizer_state_dict": optimizer_state,
    }

    checkpoint_path = os.path.join(CHECKPOINT_DIR, "checkpoint_latest.json")

    # Atomic write: write to temp file first, then rename
    tmp_path = checkpoint_path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(checkpoint, f)
    os.replace(tmp_path, checkpoint_path)

    logger.info("Saved checkpoint at epoch %d, step %d", epoch, step)

    # ─── For PyTorch, you would typically do: ───
    # import torch
    # torch.save({
    #     "epoch": epoch,
    #     "step": step,
    #     "model_state_dict": model.state_dict(),
    #     "optimizer_state_dict": optimizer.state_dict(),
    #     "loss": current_loss,
    # }, os.path.join(CHECKPOINT_DIR, "checkpoint_latest.pt"))


def load_checkpoint():
    """Restore training state from a checkpoint if one exists.

    Returns:
        dict or None: Checkpoint data if found, None otherwise.

    Call this at the start of training to resume from where you left off
    after a spot interruption.
    """
    checkpoint_path = os.path.join(CHECKPOINT_DIR, "checkpoint_latest.json")

    if os.path.exists(checkpoint_path):
        with open(checkpoint_path, "r") as f:
            checkpoint = json.load(f)
        logger.info(
            "Restored checkpoint: epoch %d, step %d",
            checkpoint.get("epoch", 0),
            checkpoint.get("step", 0),
        )
        return checkpoint

    logger.info("No checkpoint found — starting from scratch")
    return None

    # ─── For PyTorch, you would typically do: ───
    # import torch
    # ckpt_path = os.path.join(CHECKPOINT_DIR, "checkpoint_latest.pt")
    # if os.path.exists(ckpt_path):
    #     checkpoint = torch.load(ckpt_path)
    #     model.load_state_dict(checkpoint["model_state_dict"])
    #     optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
    #     start_epoch = checkpoint["epoch"]
    #     return checkpoint
    # return None


# ── Model saving ──────────────────────────────────────────────────────────────


def save_model(model, model_dir):
    """Save final model artifacts to the output directory.

    IMPORTANT: Everything written to /opt/ml/model/ is packaged into a
    model.tar.gz and uploaded to S3 at the output path you configured.
    This is what gets deployed to a SageMaker endpoint.

    Args:
        model: Your trained model object.
        model_dir: Path to write artifacts (default: /opt/ml/model/).

    Common patterns:
        - sklearn: joblib.dump(model, os.path.join(model_dir, "model.pkl"))
        - PyTorch: torch.save(model.state_dict(), os.path.join(model_dir, "model.pt"))
        - Hugging Face: model.save_pretrained(model_dir)
        - XGBoost: model.save_model(os.path.join(model_dir, "model.json"))
    """
    os.makedirs(model_dir, exist_ok=True)

    logger.info("Saving model artifacts to: %s", model_dir)

    # ─── Replace with your model saving logic ───
    # Examples:
    #
    # For scikit-learn:
    #   import joblib
    #   joblib.dump(model, os.path.join(model_dir, "model.pkl"))
    #
    # For PyTorch:
    #   import torch
    #   torch.save(model.state_dict(), os.path.join(model_dir, "model.pt"))
    #   # Also save model config/architecture for inference
    #   with open(os.path.join(model_dir, "config.json"), "w") as f:
    #       json.dump(model_config, f)
    #
    # For Hugging Face transformers:
    #   model.save_pretrained(model_dir)
    #   tokenizer.save_pretrained(model_dir)
    #
    # For LoRA adapters (PEFT):
    #   model.save_pretrained(model_dir)
    #   # This creates adapter_config.json + adapter weights
    #   # The feedback loop will detect this and suggest ./do/adapter add

    # Placeholder: save a marker file
    with open(os.path.join(model_dir, "model_info.json"), "w") as f:
        json.dump({"status": "placeholder", "message": "Replace with real model"}, f)

    logger.info("Model artifacts saved successfully")


# ── Training loop ─────────────────────────────────────────────────────────────


def train(hyperparams, data_dir, model_dir, checkpoint_dir):
    """Main training loop.

    This is where your actual training logic goes. The structure below
    shows the recommended pattern for SageMaker compatibility:

    1. Load hyperparameters (cast strings to proper types)
    2. Load training data from the input channel
    3. Check for existing checkpoint (for spot training resumption)
    4. Run training loop with periodic checkpoint saves
    5. Save final model to the output directory

    Args:
        hyperparams: Dict of hyperparameters (all values are strings).
        data_dir: Path to input training data.
        model_dir: Path to write final model artifacts.
        checkpoint_dir: Path for checkpoint save/restore.
    """
    # ── Step 1: Parse hyperparameters (cast from strings) ──
    epochs = int(hyperparams.get("epochs", "10"))
    batch_size = int(hyperparams.get("batch_size", "32"))
    learning_rate = float(hyperparams.get("learning_rate", "0.001"))
    checkpoint_frequency = int(hyperparams.get("checkpoint_frequency", "1"))

    logger.info(
        "Training config: epochs=%d, batch_size=%d, lr=%f",
        epochs, batch_size, learning_rate,
    )

    # ── Step 2: Load training data ──
    training_data = load_training_data(data_dir)

    # ── Step 3: Check for existing checkpoint (spot resumption) ──
    checkpoint = load_checkpoint()
    start_epoch = 0
    if checkpoint:
        start_epoch = checkpoint.get("epoch", 0)
        # Restore model and optimizer state from checkpoint here
        logger.info("Resuming training from epoch %d", start_epoch)

    # ── Step 4: Training loop ──
    model = None  # Replace with your model initialization

    for epoch in range(start_epoch, epochs):
        logger.info("Epoch %d/%d", epoch + 1, epochs)

        # ─── Replace with your actual training step ───
        # Example (PyTorch):
        #   model.train()
        #   for batch_idx, (data, target) in enumerate(dataloader):
        #       optimizer.zero_grad()
        #       output = model(data)
        #       loss = criterion(output, target)
        #       loss.backward()
        #       optimizer.step()
        #
        #       if batch_idx % log_interval == 0:
        #           logger.info("  Step %d, Loss: %.4f", batch_idx, loss.item())

        # Print metrics in a format SageMaker can parse for CloudWatch
        # Use the regex pattern defined in config.yaml metric_definitions
        train_loss = 0.0  # Replace with actual loss
        print(f"loss: {train_loss:.4f}")
        print(f"epoch: {epoch + 1}")

        # ── Save checkpoint periodically ──
        if (epoch + 1) % checkpoint_frequency == 0:
            save_checkpoint(
                model_state=None,       # Replace with model.state_dict()
                optimizer_state=None,   # Replace with optimizer.state_dict()
                epoch=epoch + 1,
                step=(epoch + 1) * batch_size,
            )

    # ── Step 5: Save final model ──
    save_model(model, model_dir)

    logger.info("Training complete!")


# ── Distributed training helpers ──────────────────────────────────────────────
# When instance_count > 1 in config.yaml, SageMaker launches multiple instances
# and sets up inter-node communication. Your script must be distribution-aware.
#
# SageMaker provides these environment variables for distributed training:
#   SM_HOSTS          - JSON list of all host names
#   SM_CURRENT_HOST   - This instance's host name
#   SM_NUM_GPUS       - Number of GPUs on this instance
#
# Example (PyTorch DDP):
#   import torch.distributed as dist
#   dist.init_process_group(backend="nccl")
#   local_rank = int(os.environ.get("LOCAL_RANK", 0))
#   model = torch.nn.parallel.DistributedDataParallel(model, device_ids=[local_rank])


def get_distributed_info():
    """Get distributed training configuration from SageMaker environment.

    Returns:
        dict: Distributed training info including hosts, current host, and GPU count.
    """
    hosts = json.loads(os.environ.get("SM_HOSTS", '["localhost"]'))
    current_host = os.environ.get("SM_CURRENT_HOST", "localhost")
    num_gpus = int(os.environ.get("SM_NUM_GPUS", "0"))

    return {
        "hosts": hosts,
        "current_host": current_host,
        "num_gpus": num_gpus,
        "num_hosts": len(hosts),
        "is_leader": current_host == hosts[0],
    }


# ── Entry point ───────────────────────────────────────────────────────────────


if __name__ == "__main__":
    # SageMaker also passes hyperparameters as command-line arguments.
    # You can use either the JSON file or argparse — both work.
    parser = argparse.ArgumentParser(description="SageMaker Training Script")

    # SageMaker standard arguments
    parser.add_argument("--model-dir", type=str, default=MODEL_DIR,
                        help="Directory to save model artifacts")
    parser.add_argument("--data-dir", type=str, default=INPUT_DATA_DIR,
                        help="Directory containing training data")

    # Add your custom hyperparameters as CLI args if preferred:
    # parser.add_argument("--epochs", type=int, default=10)
    # parser.add_argument("--batch-size", type=int, default=32)
    # parser.add_argument("--learning-rate", type=float, default=0.001)

    args, _ = parser.parse_known_args()

    # Load hyperparameters from SageMaker config file
    hyperparams = load_hyperparameters()

    # Log distributed training info
    dist_info = get_distributed_info()
    if dist_info["num_hosts"] > 1:
        logger.info("Distributed training: %d hosts, %d GPUs per host",
                    dist_info["num_hosts"], dist_info["num_gpus"])
        logger.info("Current host: %s (leader: %s)",
                    dist_info["current_host"], dist_info["is_leader"])

    # Run training
    try:
        train(
            hyperparams=hyperparams,
            data_dir=args.data_dir,
            model_dir=args.model_dir,
            checkpoint_dir=CHECKPOINT_DIR,
        )
    except Exception as e:
        # Write failure reason to /opt/ml/output/failure
        failure_path = os.path.join(OUTPUT_DIR, "failure")
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(failure_path, "w") as f:
            f.write(str(e))
        logger.error("Training failed: %s", e, exc_info=True)
        sys.exit(1)
