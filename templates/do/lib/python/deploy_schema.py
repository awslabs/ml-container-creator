from __future__ import annotations
"""Per-target deployment variable schemas.

Declares required and optional configuration variables for each deployment
target. Used by the prompt engine and deploy dispatcher to determine which
variables are missing and need to be collected before deployment.

Callers: .deploy_helper.py, do/deploy

ADR-008 (Wave 8 T6): SCHEMAS, STATUS_VARS, and TARGET_ALIASES are DERIVED at
import time from the per-target descriptors (templates/do/targets.d/<t>/manifest.json)
via the sibling `target_manifest` runtime module — the single source of truth.
This is an in-process import (no subprocess, no new dependency), so it does not
add cost to the deploy path. If the descriptors cannot be read (unusual layout),
the module falls back to the baked-in literals below so the deploy helper never
breaks; the descriptor-conformance test guarantees the two agree on the real tree.
"""

from typing import Any

# ---------------------------------------------------------------------------
# Fallback literals — the last-known-good per-target contract. These are ONLY
# used if the descriptors cannot be read; on a normal tree the values below are
# replaced wholesale by the descriptor-derived structures. Kept in sync with the
# descriptors by test/unit/target-descriptor-conformance.test.js.
# ---------------------------------------------------------------------------

_FALLBACK_SCHEMAS: dict[str, dict[str, Any]] = {
    "realtime-inference": {
        "required": ["INSTANCE_TYPE", "ENDPOINT_NAME"],
        "optional": {"ENDPOINT_STRATEGY": "new", "IC_GPU_COUNT": "auto", "INSTANCE_TYPES": ""},
    },
    "hyperpod-eks": {
        "required": ["INSTANCE_TYPE", "HP_CLUSTER_NAME"],
        "optional": {
            "HP_GPU_COUNT": "auto",
            "HP_NAMESPACE": "default",
            "HP_REPLICAS": "1",
            "HP_QUEUE": "",
            "HP_INSTANCE_GROUP_NAME": "",
        },
    },
    # BL103: plain EKS target. HP_CLUSTER_NAME is OPTIONAL — when unset, the
    # deploy uses the ambient kubectl context (no kubeconfig update). Reuses the
    # HyperPod cluster/GPU fields.
    "eks": {
        "required": [],
        "optional": {
            "HP_CLUSTER_NAME": "",
            "HP_GPU_COUNT": "auto",
            "HP_NAMESPACE": "default",
            "HP_REPLICAS": "1",
            "HP_QUEUE": "",
        },
    },
    "async-inference": {
        "required": ["INSTANCE_TYPE", "ASYNC_S3_OUTPUT_PATH"],
        "optional": {"ASYNC_SNS_TOPIC": "", "ASYNC_MAX_CONCURRENT_INVOCATIONS": "1"},
    },
    "batch-transform": {
        "required": ["INSTANCE_TYPE", "BATCH_INPUT_PATH", "BATCH_OUTPUT_PATH"],
        "optional": {
            "BATCH_SPLIT_TYPE": "Line",
            "BATCH_STRATEGY": "MultiRecord",
            "BATCH_MAX_CONCURRENT": "1",
        },
    },
}

_FALLBACK_STATUS_VARS: dict[str, str] = {
    "realtime-inference": "DEPLOYMENT_TARGET_SMAI_STATUS",
    "hyperpod-eks": "DEPLOYMENT_TARGET_HP_STATUS",
    "async-inference": "DEPLOYMENT_TARGET_ASYNC_STATUS",
    "batch-transform": "DEPLOYMENT_TARGET_BATCH_STATUS",
    "eks": "DEPLOYMENT_TARGET_EKS_STATUS",
}

# Target aliases for backward compatibility (v1.4 → v1.5 rename). `managed-inference`
# is the shell-layer alias for realtime-inference. Every entry mirrors a descriptor
# `aliases` field; each canonical name also maps to itself so callers can normalize
# either form. This mirrors exactly what _derive_from_descriptors() builds.
_FALLBACK_TARGET_ALIASES: dict[str, str] = {
    "async-inference": "async-inference",
    "async": "async-inference",
    "batch-transform": "batch-transform",
    "batch": "batch-transform",
    "eks": "eks",
    "hyperpod-eks": "hyperpod-eks",
    "hyperpod": "hyperpod-eks",
    "realtime-inference": "realtime-inference",
    "managed-inference": "realtime-inference",
    "realtime": "realtime-inference",
}


# ---------------------------------------------------------------------------
# Descriptor derivation (ADR-008). Build the three structures from the
# descriptors; on any failure, fall back to the literals above.
# ---------------------------------------------------------------------------


def _derive_from_descriptors() -> tuple[
    dict[str, dict[str, Any]], dict[str, str], dict[str, str]
] | None:
    """Build (SCHEMAS, STATUS_VARS, TARGET_ALIASES) from the target descriptors.

    Returns None if the descriptors cannot be read, signalling the caller to use
    the fallback literals.
    """
    try:
        import target_manifest  # sibling runtime module; same lib/python dir
    except ImportError:
        return None

    try:
        targets = target_manifest.list_targets()
        if not targets:
            return None

        schemas: dict[str, dict[str, Any]] = {}
        status_vars: dict[str, str] = {}
        aliases: dict[str, str] = {}

        for target in targets:
            manifest = target_manifest.read_manifest(target)
            schemas[target] = {
                "required": list(manifest.get("required_vars", [])),
                "optional": dict(manifest.get("optional_vars", {})),
            }
            status_vars[target] = manifest["status_var"]
            aliases[target] = target
            for alias in manifest.get("aliases", []):
                aliases[alias] = target

        return schemas, status_vars, aliases
    except (KeyError, OSError, ValueError, target_manifest.ManifestError):
        return None


_derived = _derive_from_descriptors()
if _derived is not None:
    SCHEMAS, STATUS_VARS, TARGET_ALIASES = _derived
else:
    SCHEMAS = _FALLBACK_SCHEMAS
    STATUS_VARS = _FALLBACK_STATUS_VARS
    TARGET_ALIASES = _FALLBACK_TARGET_ALIASES


def normalize_target(target: str) -> str:
    """Normalize a target name, resolving any aliases.

    Args:
        target: Target name (may be an alias like "managed-inference").

    Returns:
        The canonical target name (e.g. "realtime-inference").
    """
    return TARGET_ALIASES.get(target, target)


def validate_config(target: str, config_vars: dict[str, str]) -> list[str]:
    """Check *config_vars* against the schema for *target*.

    Args:
        target: One of the keys in SCHEMAS (e.g. "realtime-inference").
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
