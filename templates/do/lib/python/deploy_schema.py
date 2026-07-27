from __future__ import annotations
"""Per-target deployment variable schemas.

Declares required and optional configuration variables for each deployment
target. Used by the prompt engine and deploy dispatcher to determine which
variables are missing and need to be collected before deployment.

Callers: .deploy_helper.py, do/deploy
"""

from typing import Any

# ---------------------------------------------------------------------------
# Schema declarations: each target lists required vars (must be non-empty)
# and optional vars (with sensible defaults).
# ---------------------------------------------------------------------------

SCHEMAS: dict[str, dict[str, Any]] = {
    "realtime-inference": {
        "required": [
            "INSTANCE_TYPE",
            "ENDPOINT_NAME",
        ],
        "optional": {
            "ENDPOINT_STRATEGY": "new",
            "IC_GPU_COUNT": "auto",
            "INSTANCE_TYPES": "",
        },
    },
    "hyperpod-eks": {
        "required": [
            "INSTANCE_TYPE",
            "HP_CLUSTER_NAME",
        ],
        "optional": {
            "HP_GPU_COUNT": "auto",
            "HP_NAMESPACE": "default",
            "HP_REPLICAS": "1",
            "HP_QUEUE": "",
        },
    },
    "async-inference": {
        "required": [
            "INSTANCE_TYPE",
            "ASYNC_S3_OUTPUT_PATH",
        ],
        "optional": {
            "ASYNC_SNS_TOPIC": "",
            "ASYNC_MAX_CONCURRENT": "1",
        },
    },
    "batch-transform": {
        "required": [
            "INSTANCE_TYPE",
            "BATCH_INPUT_PATH",
            "BATCH_OUTPUT_PATH",
        ],
        "optional": {
            "BATCH_SPLIT_TYPE": "Line",
            "BATCH_STRATEGY": "MultiRecord",
            "BATCH_MAX_CONCURRENT": "1",
        },
    },
}

# ---------------------------------------------------------------------------
# Status variable names: each target writes a status flag to do/config upon
# successful deployment. Used for idempotent re-deploys and target switching.
# ---------------------------------------------------------------------------

STATUS_VARS: dict[str, str] = {
    "realtime-inference": "DEPLOYMENT_TARGET_SMAI_STATUS",
    "hyperpod-eks": "DEPLOYMENT_TARGET_HP_STATUS",
    "async-inference": "DEPLOYMENT_TARGET_ASYNC_STATUS",
    "batch-transform": "DEPLOYMENT_TARGET_BATCH_STATUS",
}


# Target aliases for backward compatibility (v1.4 → v1.5 rename)
TARGET_ALIASES: dict[str, str] = {
    "managed-inference": "realtime-inference",
    "realtime": "realtime-inference",
    "hyperpod": "hyperpod-eks",
    "batch": "batch-transform",
    "async": "async-inference",
}


def normalize_target(target: str) -> str:
    """Normalize a target name, resolving any aliases.

    Args:
        target: Target name (may be an alias like "realtime-inference").

    Returns:
        The canonical target name (e.g. "realtime-inference").
    """
    return TARGET_ALIASES.get(target, target)


def validate_config(target: str, config_vars: dict[str, str]) -> list[str]:
    """Check *config_vars* against the schema for *target*.

    Args:
        target: One of the keys in SCHEMAS (e.g. "managed-inference").
            Also accepts aliases (e.g. "managed-inference").
        config_vars: Mapping of variable names to their current values
                     (as read from do/config or provided via flags).

    Returns:
        A list of required variable names that are missing or empty in
        *config_vars*. An empty list means the config satisfies the schema.

    Raises:
        ValueError: If *target* is not a recognized deployment target.
    """
    target = normalize_target(target)
    if target not in SCHEMAS:
        raise ValueError(
            f"Unknown deployment target: {target!r}. "
            f"Valid targets: {', '.join(sorted(SCHEMAS))}"
        )

    schema = SCHEMAS[target]
    missing: list[str] = []

    for var in schema["required"]:
        value = config_vars.get(var, "")
        if not value:
            missing.append(var)

    return missing
