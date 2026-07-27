from __future__ import annotations
"""Interactive deployment prompt engine.

Drives the interactive prompt flow for `do/deploy`. Reads current config,
diffs against the per-target schema, and prompts the user only for missing
values. Supports non-interactive usage via the DEPLOY_ANSWERS env var.

Output: JSON object on stdout containing all deployment answers.
Callers: .deploy_helper.py (prompt subcommand)
"""

import json
import logging
import os
import re
import sys
from typing import Any

from mcp_client import discover_mcp, mcp_recommend_instance, mcp_list_endpoints, mcp_list_clusters
import instance_sizer

# Suppress ALL logging to prevent stdout pollution (JSON output contract)
logging.disable(logging.CRITICAL)

from deploy_schema import SCHEMAS, normalize_target  # noqa: E402

# ---------------------------------------------------------------------------
# MCP fallback warning message (FR-2.4)
# ---------------------------------------------------------------------------

_MCP_FALLBACK_WARNING: str = "MCP servers unavailable \u2014 recommendations disabled."


# ---------------------------------------------------------------------------
# MCP integration layer — tries MCP first, falls back to built-in heuristic
# ---------------------------------------------------------------------------


def get_instance_recommendation(model_name: str, precision: str = "float16") -> str | None:
    """Get instance type recommendation, trying MCP first then built-in heuristic.

    Attempts to use MCP instance-sizer for the recommendation. If MCP is
    unavailable or returns no result, falls back to the built-in heuristic
    in instance_sizer.py.

    A warning is printed to stderr (not stdout) when falling back, to avoid
    polluting the JSON answer output contract.

    Args:
        model_name: HF Hub model identifier (e.g. "meta-llama/Llama-2-7b-hf").
        precision: Data type string (e.g. "float16", "int8").

    Returns:
        SageMaker instance type string (e.g. "ml.g6.xlarge"), or None if
        neither MCP nor the built-in heuristic can determine a recommendation.

    Validates: Requirements FR-2.4, FR-10.1, FR-10.2, FR-10.4
    """
    client = discover_mcp()

    if client is not None:
        result = mcp_recommend_instance(client, model_name, precision)
        if result is not None:
            return result.get("instance_type")

    # MCP unavailable or returned None — fall back to built-in heuristic
    print(_MCP_FALLBACK_WARNING, file=sys.stderr)
    return instance_sizer.recommend_for_model(model_name, precision)


def get_endpoints(region: str) -> list[str]:
    """Get available InService endpoints, trying MCP first then returning empty list.

    Attempts to use MCP endpoint-picker to list available endpoints. If MCP
    is unavailable, returns an empty list (caller falls back to manual input).

    A warning is printed to stderr when MCP is unavailable.

    Args:
        region: AWS region string (e.g. "us-east-1").

    Returns:
        List of InService endpoint name strings, or empty list if MCP is
        unavailable. Callers should fall back to manual input when empty.

    Validates: Requirements FR-2.4, FR-10.2
    """
    client = discover_mcp()

    if client is not None:
        endpoints = mcp_list_endpoints(client, region)
        if endpoints:
            return endpoints

    # MCP unavailable — return empty list with warning
    print(_MCP_FALLBACK_WARNING, file=sys.stderr)
    return []


def get_clusters(region: str) -> list[dict[str, Any]]:
    """Get available HyperPod clusters, trying MCP first then returning empty list.

    Attempts to use MCP cluster-picker to list clusters with GPU capacity.
    If MCP is unavailable, returns an empty list (caller falls back to
    manual input).

    A warning is printed to stderr when MCP is unavailable.

    Args:
        region: AWS region string (e.g. "us-east-1").

    Returns:
        List of cluster dicts (each with name, gpu_capacity, queues), or
        empty list if MCP is unavailable. Callers should fall back to
        manual input when empty.

    Validates: Requirements FR-2.4, FR-10.2
    """
    client = discover_mcp()

    if client is not None:
        clusters = mcp_list_clusters(client, region)
        if clusters:
            return clusters

    # MCP unavailable — return empty list with warning
    print(_MCP_FALLBACK_WARNING, file=sys.stderr)
    return []


# ---------------------------------------------------------------------------
# Targets list for the selection prompt
# ---------------------------------------------------------------------------

TARGETS: list[dict[str, str]] = [
    {"value": "realtime-inference", "name": "Real-time Inference (SageMaker)"},
    {"value": "async-inference", "name": "Async Inference (SageMaker async endpoint)"},
    {"value": "batch-transform", "name": "Batch Transform (SageMaker batch job)"},
    {"value": "hyperpod-eks", "name": "HyperPod EKS (GPU cluster inference)"},
]

# Mapping from schema variable names to human-friendly prompt messages
PROMPT_MESSAGES: dict[str, str] = {
    "INSTANCE_TYPE": "Instance type",
    "ENDPOINT_NAME": "Endpoint name",
    "ENDPOINT_STRATEGY": "Endpoint strategy",
    "IC_GPU_COUNT": "GPU count",
    "INSTANCE_TYPES": "Instance types (comma-separated, availability-ordered)",
    "HP_CLUSTER_NAME": "HyperPod cluster name",
    "HP_GPU_COUNT": "GPU count",
    "HP_NAMESPACE": "Kubernetes namespace",
    "HP_REPLICAS": "Number of replicas",
    "HP_QUEUE": "Kueue queue name",
    "ASYNC_S3_OUTPUT_PATH": "S3 output path",
    "ASYNC_SNS_TOPIC": "SNS topic ARN (optional, press Enter to skip)",
    "ASYNC_MAX_CONCURRENT": "Max concurrent invocations",
    "BATCH_INPUT_PATH": "S3 input path",
    "BATCH_OUTPUT_PATH": "S3 output path",
    "BATCH_SPLIT_TYPE": "Split type",
    "BATCH_STRATEGY": "Batch strategy",
    "BATCH_MAX_CONCURRENT": "Max concurrent transforms",
}

# Variables with select-style choices (not free text)
SELECT_CHOICES: dict[str, list[str]] = {
    "ENDPOINT_STRATEGY": ["new", "existing", "heterogeneous"],
    "BATCH_SPLIT_TYPE": ["Line", "RecordIO", "None"],
    "BATCH_STRATEGY": ["MultiRecord", "SingleRecord"],
}


# ---------------------------------------------------------------------------
# Config file parsing
# ---------------------------------------------------------------------------


def parse_config(config_path: str) -> dict[str, str]:
    """Parse bash `export VAR="value"` lines from a config file.

    Extracts variable assignments from do/config format. Handles:
    - export VAR="value"
    - export VAR='value'
    - export VAR=value
    - Lines with trailing comments (# ...)

    Args:
        config_path: Path to the bash config file.

    Returns:
        Dict mapping variable names to their string values.
        Variables with empty values ("") are included with empty string.
    """
    config_vars: dict[str, str] = {}

    if not os.path.isfile(config_path):
        return config_vars

    with open(config_path) as f:
        for line in f:
            line = line.strip()
            # Match: export VAR="value" or export VAR='value' or export VAR=value
            match = re.match(
                r'^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line
            )
            if not match:
                continue

            var_name = match.group(1)
            raw_value = match.group(2)

            # Strip trailing comment (but not inside quotes)
            # Remove surrounding quotes
            value = _extract_value(raw_value)
            config_vars[var_name] = value

    return config_vars


def _extract_value(raw: str) -> str:
    """Extract the value from a bash assignment RHS.

    Handles double-quoted, single-quoted, and unquoted values.
    Strips trailing inline comments for unquoted values.
    """
    raw = raw.strip()

    # Double-quoted: export VAR="value" or export VAR="value" # comment
    if raw.startswith('"'):
        # Find the closing quote
        end = raw.find('"', 1)
        if end != -1:
            return raw[1:end]
        # No closing quote — take everything after opening quote
        return raw[1:]

    # Single-quoted: export VAR='value'
    if raw.startswith("'"):
        end = raw.find("'", 1)
        if end != -1:
            return raw[1:end]
        return raw[1:]

    # Unquoted: export VAR=value  # possible comment
    # Split on first # that has a space before it (bash comment convention)
    comment_match = re.search(r'\s+#', raw)
    if comment_match:
        raw = raw[:comment_match.start()]

    return raw.strip()


# ---------------------------------------------------------------------------
# Config diffing
# ---------------------------------------------------------------------------


def diff_config(target: str, config_vars: dict[str, str]) -> dict[str, str | None]:
    """Diff current config against the target schema to find missing values.

    Returns a dict of variable names that need values. For required vars
    that are missing/empty, the value is None. For optional vars that are
    missing, the value is the default from the schema.

    Args:
        target: Deployment target key (e.g. "realtime-inference").
        config_vars: Current config variable values.

    Returns:
        Dict of {var_name: default_or_None} for vars that need prompting.
        Required vars with no value have None as the default.
        Optional vars not present in config have their schema default.
    """
    if target not in SCHEMAS:
        target = normalize_target(target)
    if target not in SCHEMAS:
        raise ValueError(f"Unknown target: {target!r}")

    schema = SCHEMAS[target]
    missing: dict[str, str | None] = {}

    # Check required vars
    for var in schema["required"]:
        value = config_vars.get(var, "")
        if not value:
            missing[var] = None

    # Check optional vars — only prompt if not already set in config
    for var, default in schema["optional"].items():
        if var not in config_vars or config_vars[var] == "":
            missing[var] = default

    return missing


# ---------------------------------------------------------------------------
# Non-interactive answers (DEPLOY_ANSWERS env var)
# ---------------------------------------------------------------------------

# Mapping from answer JSON keys to config variable names
_ANSWER_KEY_TO_VAR: dict[str, str] = {
    "target": "DEPLOYMENT_TARGET",
    "instance_type": "INSTANCE_TYPE",
    "endpoint_name": "ENDPOINT_NAME",
    "endpoint_strategy": "ENDPOINT_STRATEGY",
    "instance_types": "INSTANCE_TYPES",
    "gpu_count": "IC_GPU_COUNT",
    "cluster_name": "HP_CLUSTER_NAME",
    "hp_gpu_count": "HP_GPU_COUNT",
    "namespace": "HP_NAMESPACE",
    "replicas": "HP_REPLICAS",
    "queue": "HP_QUEUE",
    "async_output_path": "ASYNC_S3_OUTPUT_PATH",
    "async_sns_topic": "ASYNC_SNS_TOPIC",
    "async_max_concurrent": "ASYNC_MAX_CONCURRENT",
    "batch_input_path": "BATCH_INPUT_PATH",
    "batch_output_path": "BATCH_OUTPUT_PATH",
    "batch_split_type": "BATCH_SPLIT_TYPE",
    "batch_strategy": "BATCH_STRATEGY",
    "batch_max_concurrent": "BATCH_MAX_CONCURRENT",
}

# Reverse mapping: config var name to answer JSON key
_VAR_TO_ANSWER_KEY: dict[str, str] = {v: k for k, v in _ANSWER_KEY_TO_VAR.items()}


def load_answers_from_env() -> dict[str, str] | None:
    """Load pre-set answers from the DEPLOY_ANSWERS environment variable.

    When set, DEPLOY_ANSWERS should contain a JSON object with answer keys.
    This enables non-interactive testing without a TTY.

    Returns:
        Parsed answers dict (JSON keys mapped to config var names), or None
        if the env var is not set.

    Raises:
        SystemExit: If DEPLOY_ANSWERS is set but contains invalid JSON.
    """
    raw = os.environ.get("DEPLOY_ANSWERS")
    if not raw:
        return None

    try:
        answers = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid DEPLOY_ANSWERS JSON: {e}"}))
        sys.exit(1)

    # Map answer keys to config var names
    mapped: dict[str, str] = {}
    for key, value in answers.items():
        var_name = _ANSWER_KEY_TO_VAR.get(key)
        if var_name:
            mapped[var_name] = str(value)
        else:
            # Pass through unknown keys — might be var names directly
            mapped[key] = str(value)

    return mapped


# ---------------------------------------------------------------------------
# Interactive prompts (questionary-based)
# ---------------------------------------------------------------------------


def prompt_target_selection(pre_set_target: str | None = None) -> str:
    """Prompt user to select a deployment target.

    If pre_set_target is provided (from flags or DEPLOY_ANSWERS), returns it
    directly without prompting.

    Args:
        pre_set_target: Pre-selected target value, or None to prompt.

    Returns:
        Selected target string (e.g. "realtime-inference").
    """
    if pre_set_target:
        return pre_set_target

    import questionary

    choices = [
        questionary.Choice(title=t["name"], value=t["value"])
        for t in TARGETS
    ]

    result = questionary.select(
        "Deployment target:",
        choices=choices,
    ).ask()

    if result is None:
        # User cancelled (Ctrl+C)
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_instance_type(
    config_vars: dict[str, str],
    default: str | None = None,
) -> str:
    """Prompt for instance type with MCP sizer recommendation as default.

    Calls get_instance_recommendation() using the MODEL_NAME (or HF_MODEL_ID)
    from config to pre-populate the instance type default. If a recommendation
    is available, it is shown in the prompt message and used as the default
    value. If no recommendation can be determined, falls back to the provided
    default (or empty string).

    Args:
        config_vars: Parsed config variables (used to extract model name).
        default: Fallback default if no MCP recommendation is available.

    Returns:
        The user-provided or default instance type string.

    Validates: Requirements FR-5.1
    """
    import questionary

    # Resolve model name from config (MODEL_NAME or HF_MODEL_ID)
    model_name = config_vars.get("MODEL_NAME") or config_vars.get("HF_MODEL_ID") or ""

    # Get MCP recommendation if we have a model name
    recommendation: str | None = None
    if model_name:
        recommendation = get_instance_recommendation(model_name, "float16")

    # Use recommendation as default, falling back to provided default
    effective_default = recommendation or default or ""

    # Build prompt message with recommendation hint
    if recommendation:
        message = f"Instance type (recommended: {recommendation}):"
    else:
        message = "Instance type:"

    result = questionary.text(
        message,
        default=effective_default,
    ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_endpoint_strategy(default: str | None = None) -> str:
    """Prompt for endpoint strategy with human-friendly choice titles.

    Presents 3 options with descriptive display names mapped to internal values:
    - "New endpoint (single instance type)" → "new"
    - "New endpoint (heterogeneous — availability-ordered fallback)" → "heterogeneous"
    - "Attach to existing endpoint" → "existing"

    Args:
        default: Default value ("new", "existing", or "heterogeneous").
            Defaults to "new" if not provided or not a valid choice.

    Returns:
        The selected strategy value string ("new", "heterogeneous", or "existing").

    Validates: Requirements FR-5.2
    """
    import questionary

    choices = [
        questionary.Choice(
            title="New endpoint (single instance type)",
            value="new",
        ),
        questionary.Choice(
            title="New endpoint (heterogeneous \u2014 availability-ordered fallback)",
            value="heterogeneous",
        ),
        questionary.Choice(
            title="Attach to existing endpoint",
            value="existing",
        ),
    ]

    valid_defaults = ["new", "existing", "heterogeneous"]
    effective_default = default if default in valid_defaults else "new"

    result = questionary.select(
        "Endpoint strategy:",
        choices=choices,
        default=effective_default,
    ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_endpoint_name(config_vars: dict[str, str], strategy: str) -> str:
    """Prompt for endpoint name with MCP endpoint-picker for 'existing' strategy.

    When strategy is "existing":
    - Calls get_endpoints(region) to list InService endpoints
    - If endpoints available: shows questionary.select() for user to pick
    - If no endpoints (MCP unavailable or empty): falls back to questionary.text()

    When strategy is not "existing":
    - Uses questionary.text() with a default of "${PROJECT_NAME}-ep"

    Args:
        config_vars: Parsed config variables (used to extract region and project name).
        strategy: Endpoint strategy ("new", "existing", or "heterogeneous").

    Returns:
        The selected or entered endpoint name string.

    Validates: Requirements FR-5.3
    """
    import questionary

    if strategy == "existing":
        # Determine region from config vars
        region = (
            config_vars.get("AWS_REGION")
            or config_vars.get("REGION")
            or config_vars.get("AWS_DEFAULT_REGION")
            or "us-east-1"
        )

        # Call MCP endpoint-picker to list InService endpoints
        endpoints = get_endpoints(region)

        if endpoints:
            # Show select list of available endpoints
            result = questionary.select(
                "Select endpoint:",
                choices=endpoints,
            ).ask()
        else:
            # No endpoints available — fall back to manual text input
            result = questionary.text(
                "Endpoint name:",
                default="",
            ).ask()
    else:
        # Non-existing strategy: use text input with project name default
        project_name = config_vars.get("PROJECT_NAME", "")
        default_name = f"{project_name}-ep" if project_name else ""

        result = questionary.text(
            "Endpoint name:",
            default=default_name,
        ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_cluster_name(config_vars: dict[str, str]) -> str:
    """Prompt for HyperPod cluster name with MCP cluster-picker selection.

    Calls discover_mcp() to check MCP availability, then:
    - If MCP available and clusters returned: shows questionary.select() with
      cluster names including GPU capacity info (e.g. "cluster-1 (8 GPUs)")
    - If MCP available but no clusters: errors with FR-6.5 message
    - If MCP unavailable: falls back to questionary.text() for manual input

    Args:
        config_vars: Parsed config variables (used to extract region).

    Returns:
        The selected or entered cluster name string.

    Validates: Requirements FR-6.1, FR-6.5
    """
    import questionary

    # Determine region from config vars (same fallback order as prompt_endpoint_name)
    region = (
        config_vars.get("AWS_REGION")
        or config_vars.get("REGION")
        or config_vars.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )

    # Check MCP availability directly to distinguish between
    # "no clusters exist" vs "MCP unavailable"
    client = discover_mcp()
    clusters: list = []

    if client is not None:
        # MCP is available — query for clusters
        clusters = mcp_list_clusters(client, region)

        if clusters:
            # Build choices with GPU capacity info in display title
            choices = [
                questionary.Choice(
                    title=f"{c['name']} ({c['gpu_capacity']} GPUs)",
                    value=c["name"],
                )
                for c in clusters
            ]

            result = questionary.select(
                "Select cluster:",
                choices=choices,
            ).ask()
        else:
            # MCP available but no clusters found — error per FR-6.5
            print(json.dumps({"error": "No HyperPod cluster found. Run: mcc bootstrap add-module hyperpod"}))
            sys.exit(1)
    else:
        # MCP unavailable — fall back to manual text input with warning
        print(_MCP_FALLBACK_WARNING, file=sys.stderr)
        result = questionary.text(
            "HyperPod cluster name:",
            default="",
        ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    # Store the selected cluster's queues for prompt_hp_queue()
    if client is not None and clusters:
        selected = next(
            (c for c in clusters if c["name"] == result), None
        )
        global _LAST_CLUSTER_QUEUES
        _LAST_CLUSTER_QUEUES = (
            selected.get("queues", []) if selected else []
        )

    return result


# Module-level storage for queue data from the last cluster selection.
# Used by prompt_hp_queue() to show Kueue queue choices.
_LAST_CLUSTER_QUEUES: list[str] = []


def prompt_hp_gpu_count(
    config_vars: dict[str, str], answers: dict[str, str]
) -> str:
    """Prompt for HyperPod GPU count with auto-detection.

    Same logic as prompt_gpu_count() (used for IC_GPU_COUNT) but for
    the HyperPod target's HP_GPU_COUNT variable.

    Args:
        config_vars: Parsed config variables.
        answers: Answers collected so far in this prompt_for_missing call.

    Returns:
        The user-provided or auto-detected GPU count as a string.

    Validates: Requirements FR-6.2
    """
    import questionary

    instance_type = (
        answers.get("INSTANCE_TYPE")
        or config_vars.get("INSTANCE_TYPE")
        or ""
    )

    if instance_type:
        detected = detect_gpu_count(instance_type)
        message = f"GPU count (auto-detected: {detected}):"
        default = detected
    else:
        message = "GPU count:"
        default = "1"

    result = questionary.text(
        message,
        default=default,
    ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_async_s3_output_path(config_vars: dict[str, str]) -> str:
    """Prompt for async-inference S3 output path with profile bucket default.

    Constructs a default path from the profile's bucket variable and project
    name: s3://<bucket>/async-output/<project>/

    The bucket is sourced from MODELS_BUCKET first, then S3_BUCKET. If neither
    is available, falls back to a plain text prompt with no default.

    Args:
        config_vars: Parsed config variables (used to extract bucket and project name).

    Returns:
        The user-provided or default S3 output path string.

    Validates: Requirements FR-7.1
    """
    import questionary

    # Resolve bucket from config (MODELS_BUCKET or S3_BUCKET)
    bucket = config_vars.get("MODELS_BUCKET") or config_vars.get("S3_BUCKET") or ""
    project = config_vars.get("PROJECT_NAME") or ""

    # Construct default if bucket is available
    if bucket:
        default_path = f"s3://{bucket}/async-output/{project}/" if project else f"s3://{bucket}/async-output/"
        message = f"S3 output path (default: {default_path}):"
    else:
        default_path = ""
        message = "S3 output path:"

    result = questionary.text(
        message,
        default=default_path,
    ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_batch_output_path(config_vars: dict[str, str]) -> str:
    """Prompt for batch-transform S3 output path with profile bucket default.

    Constructs a default path from the profile's bucket variable and project
    name: s3://<bucket>/batch-output/<project>/

    The bucket is sourced from MODELS_BUCKET first, then S3_BUCKET. If neither
    is available, falls back to a plain text prompt with no default.

    Args:
        config_vars: Parsed config variables (used to extract bucket and project name).

    Returns:
        The user-provided or default S3 output path string.

    Validates: Requirements FR-8.2
    """
    import questionary

    # Resolve bucket from config (MODELS_BUCKET or S3_BUCKET)
    bucket = config_vars.get("MODELS_BUCKET") or config_vars.get("S3_BUCKET") or ""
    project = config_vars.get("PROJECT_NAME") or ""

    # Construct default if bucket is available
    if bucket:
        default_path = f"s3://{bucket}/batch-output/{project}/" if project else f"s3://{bucket}/batch-output/"
        message = f"S3 output path (default: {default_path}):"
    else:
        default_path = ""
        message = "S3 output path:"

    result = questionary.text(
        message,
        default=default_path,
    ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_hp_queue(config_vars: dict[str, str]) -> str:
    """Prompt for Kueue queue with cluster-detected choices.

    Uses the queue list stored by prompt_cluster_name() (from the MCP
    cluster-picker response). If queues available, shows a select prompt.
    Otherwise falls back to a text prompt (skip-able with Enter).

    Args:
        config_vars: Parsed config variables.

    Returns:
        The selected/entered queue name, or empty string if skipped.

    Validates: Requirements FR-6.4
    """
    import questionary

    global _LAST_CLUSTER_QUEUES
    queues = _LAST_CLUSTER_QUEUES

    if queues:
        choices = [
            questionary.Choice(title=q, value=q) for q in queues
        ]
        choices.append(
            questionary.Choice(title="(skip — no queue)", value="")
        )

        result = questionary.select(
            "Kueue queue:",
            choices=choices,
        ).ask()
    else:
        result = questionary.text(
            "Kueue queue name (optional, Enter to skip):",
            default="",
        ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_instance_types(config_vars: dict[str, str]) -> str:
    """Prompt for an ordered list of instance types (max 5) for heterogeneous endpoints.

    Uses an iterative "add instance type" approach to preserve ordering.
    The MCP-recommended instance type is pre-added as the first entry.
    After each addition, asks "Add more?" until max 5 or user declines.

    Each instance type is validated against the ml.* pattern.

    For non-interactive mode (DEPLOY_ANSWERS), accepts the comma-separated
    value directly via the env_answers path in prompt_for_missing().

    Args:
        config_vars: Parsed config variables (used for MCP sizer recommendation).

    Returns:
        Comma-separated string of ordered instance types
        (e.g. "ml.g5.xlarge,ml.g5.2xlarge,ml.g6.xlarge").

    Validates: Requirements FR-5.4
    """
    import questionary

    MAX_INSTANCE_TYPES = 5
    instance_types: list[str] = []

    # Get MCP recommendation to pre-add as first entry
    model_name = config_vars.get("MODEL_NAME") or config_vars.get("HF_MODEL_ID") or ""
    recommendation: str | None = None
    if model_name:
        recommendation = get_instance_recommendation(model_name, "float16")

    # Pre-add recommended instance as first entry
    if recommendation:
        instance_types.append(recommendation)
        print(f"  [1] {recommendation} (recommended)", file=sys.stderr)

    # Iteratively add instance types
    while len(instance_types) < MAX_INSTANCE_TYPES:
        position = len(instance_types) + 1

        if instance_types:
            # Ask if user wants to add more
            add_more = questionary.confirm(
                f"Add another instance type? ({len(instance_types)}/{MAX_INSTANCE_TYPES} added)",
                default=False,
            ).ask()

            if add_more is None:
                print(json.dumps({"error": "Prompt cancelled by user"}))
                sys.exit(1)

            if not add_more:
                break

        # Prompt for the next instance type
        message = f"Instance type [{position}]:"
        result = questionary.text(
            message,
            default="",
            validate=lambda text: (
                True if re.match(r'^ml\.[a-z0-9]+\.[a-z0-9]+$', text)
                else "Must match ml.* pattern (e.g. ml.g5.xlarge)"
            ),
        ).ask()

        if result is None:
            print(json.dumps({"error": "Prompt cancelled by user"}))
            sys.exit(1)

        instance_types.append(result)

    if not instance_types:
        print(json.dumps({"error": "At least one instance type is required for heterogeneous endpoints"}))
        sys.exit(1)

    return ",".join(instance_types)


def validate_instance_types(value: str) -> str | None:
    """Validate a comma-separated instance types string.

    Checks:
    - At least 1 entry
    - At most 5 entries
    - Each entry matches ml.* pattern

    Args:
        value: Comma-separated instance types string.

    Returns:
        None if valid, error message string if invalid.
    """
    if not value.strip():
        return "At least one instance type is required"

    types = [t.strip() for t in value.split(",") if t.strip()]

    if not types:
        return "At least one instance type is required"

    if len(types) > 5:
        return f"Maximum 5 instance types allowed (got {len(types)})"

    for t in types:
        if not re.match(r'^ml\.[a-z0-9]+\.[a-z0-9]+$', t):
            return f"Invalid instance type: {t!r} (must match ml.* pattern)"

    return None


def detect_gpu_count(instance_type: str) -> str:
    """Detect GPU count from the instance catalog for a given instance type.

    Looks up the instance type in instance_sizer.INSTANCE_CATALOG and
    returns the GPU count (the 3rd element of the tuple) as a string.

    Args:
        instance_type: SageMaker instance type (e.g. "ml.g6.12xlarge").

    Returns:
        GPU count as a string (e.g. "1", "4", "8").
        Returns "1" if the instance type is not found in the catalog.
    """
    for catalog_type, _vram, gpu_count in instance_sizer.INSTANCE_CATALOG:
        if catalog_type == instance_type:
            return str(gpu_count)
    return "1"


def prompt_gpu_count(config_vars: dict[str, str], answers: dict[str, str]) -> str:
    """Prompt for GPU count with auto-detection from the selected instance type.

    Gets the selected instance type from answers (collected earlier in the
    same prompt_for_missing call) or config_vars, then auto-detects the GPU
    count from the instance catalog. Shows the auto-detected value as the
    default so the user can accept it by pressing Enter.

    Args:
        config_vars: Parsed config variables.
        answers: Answers collected so far in this prompt_for_missing call.

    Returns:
        The user-provided or auto-detected GPU count as a string.

    Validates: Requirements FR-5.1
    """
    import questionary

    # Get the selected instance type from answers or config
    instance_type = (
        answers.get("INSTANCE_TYPE")
        or config_vars.get("INSTANCE_TYPE")
        or ""
    )

    if instance_type:
        detected = detect_gpu_count(instance_type)
        message = f"GPU count (auto-detected: {detected}):"
        default = detected
    else:
        message = "GPU count:"
        default = "1"

    result = questionary.text(
        message,
        default=default,
    ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_for_var(var_name: str, default: str | None = None) -> str:
    """Prompt the user for a single variable value.

    Uses questionary.select() for variables with predefined choices,
    questionary.text() for free-text input.

    Args:
        var_name: The config variable name (e.g. "INSTANCE_TYPE").
        default: Default value to show, or None for no default.

    Returns:
        The user-provided value string.
    """
    import questionary

    message = PROMPT_MESSAGES.get(var_name, var_name)

    if var_name in SELECT_CHOICES:
        choices = SELECT_CHOICES[var_name]
        result = questionary.select(
            f"{message}:",
            choices=choices,
            default=default if default in choices else None,
        ).ask()
    else:
        result = questionary.text(
            f"{message}:",
            default=default or "",
        ).ask()

    if result is None:
        print(json.dumps({"error": "Prompt cancelled by user"}))
        sys.exit(1)

    return result


def prompt_for_missing(
    missing_vars: dict[str, str | None],
    env_answers: dict[str, str] | None = None,
    config_vars: dict[str, str] | None = None,
) -> dict[str, str]:
    """Prompt for all missing variables, using env answers where available.

    For each missing variable:
    - If env_answers provides a value, use it (no prompt)
    - For INSTANCE_TYPE, use the MCP-aware prompt_instance_type()
    - For ENDPOINT_STRATEGY, use prompt_endpoint_strategy()
    - For INSTANCE_TYPES when strategy is "heterogeneous", use prompt_instance_types()
    - Otherwise, prompt the user interactively

    Args:
        missing_vars: Dict of {var_name: default_or_None} from diff_config().
        env_answers: Pre-set answers from DEPLOY_ANSWERS, or None.
        config_vars: Parsed config variables (used for MCP sizer context).

    Returns:
        Dict of {var_name: value} for all prompted variables.
    """
    answers: dict[str, str] = {}

    for var_name, default in missing_vars.items():
        # Check env answers first
        if env_answers and var_name in env_answers:
            # Validate INSTANCE_TYPES from env answers
            if var_name == "INSTANCE_TYPES":
                error = validate_instance_types(env_answers[var_name])
                if error:
                    print(json.dumps({"error": f"INSTANCE_TYPES: {error}"}))
                    sys.exit(1)
            answers[var_name] = env_answers[var_name]
            continue

        # Use MCP-aware prompt for INSTANCE_TYPE
        if var_name == "INSTANCE_TYPE" and config_vars is not None:
            answers[var_name] = prompt_instance_type(config_vars, default)
            continue

        # Use GPU auto-detection for IC_GPU_COUNT when default is "auto"
        if var_name == "IC_GPU_COUNT" and default == "auto":
            answers[var_name] = prompt_gpu_count(config_vars or {}, answers)
            continue

        # Use dedicated prompt for ENDPOINT_STRATEGY
        if var_name == "ENDPOINT_STRATEGY":
            answers[var_name] = prompt_endpoint_strategy(default)
            continue

        # Use MCP-aware prompt for ENDPOINT_NAME
        if var_name == "ENDPOINT_NAME" and config_vars is not None:
            # Determine the endpoint strategy from answers collected so far,
            # env_answers, or config_vars
            strategy = (
                answers.get("ENDPOINT_STRATEGY")
                or (env_answers.get("ENDPOINT_STRATEGY") if env_answers else None)
                or (config_vars.get("ENDPOINT_STRATEGY") if config_vars else None)
                or "new"
            )
            answers[var_name] = prompt_endpoint_name(config_vars, strategy)
            continue

        # Use MCP-aware prompt for HP_CLUSTER_NAME
        if var_name == "HP_CLUSTER_NAME" and config_vars is not None:
            answers[var_name] = prompt_cluster_name(config_vars)
            continue

        # Use GPU auto-detection for HP_GPU_COUNT when default is "auto"
        if var_name == "HP_GPU_COUNT" and default == "auto":
            answers[var_name] = prompt_hp_gpu_count(
                config_vars or {}, answers
            )
            continue

        # Use Kueue-aware prompt for HP_QUEUE
        if var_name == "HP_QUEUE":
            answers[var_name] = prompt_hp_queue(config_vars or {})
            continue

        # Use dedicated prompt for ASYNC_S3_OUTPUT_PATH
        if var_name == "ASYNC_S3_OUTPUT_PATH" and config_vars is not None:
            answers[var_name] = prompt_async_s3_output_path(config_vars)
            continue

        # Use dedicated prompt for BATCH_OUTPUT_PATH
        if var_name == "BATCH_OUTPUT_PATH" and config_vars is not None:
            answers[var_name] = prompt_batch_output_path(config_vars)
            continue

        # Use heterogeneous multi-select prompt for INSTANCE_TYPES
        # when endpoint strategy is "heterogeneous"
        if var_name == "INSTANCE_TYPES":
            # Determine the endpoint strategy from answers collected so far,
            # env_answers, or config_vars
            strategy = (
                answers.get("ENDPOINT_STRATEGY")
                or (env_answers.get("ENDPOINT_STRATEGY") if env_answers else None)
                or (config_vars.get("ENDPOINT_STRATEGY") if config_vars else None)
                or ""
            )
            if strategy == "heterogeneous":
                answers[var_name] = prompt_instance_types(config_vars or {})
                continue
            else:
                # For non-heterogeneous, use the single INSTANCE_TYPE value
                # or default to empty string
                single_type = (
                    answers.get("INSTANCE_TYPE")
                    or (env_answers.get("INSTANCE_TYPE") if env_answers else None)
                    or (config_vars.get("INSTANCE_TYPE") if config_vars else None)
                    or ""
                )
                answers[var_name] = single_type
                continue

        # Interactive prompt
        answers[var_name] = prompt_for_var(var_name, default)

    return answers


# ---------------------------------------------------------------------------
# Answer output
# ---------------------------------------------------------------------------


def build_answer_json(target: str, answers: dict[str, str], config_vars: dict[str, str]) -> dict[str, Any]:
    """Build the final answer JSON object for stdout output.

    Combines the target selection with collected answers and existing config
    values to produce a complete answer object. Only includes fields relevant
    to the selected target.

    Args:
        target: Selected deployment target.
        answers: Newly collected answers (var_name -> value).
        config_vars: Existing config values (used to fill in already-set vars).

    Returns:
        Dict ready for JSON serialization and stdout output.
    """
    schema = SCHEMAS[target]
    result: dict[str, Any] = {"target": target}

    # Collect all vars for this target (required + optional)
    all_vars = list(schema["required"]) + list(schema["optional"].keys())

    for var_name in all_vars:
        answer_key = _VAR_TO_ANSWER_KEY.get(var_name, var_name.lower())
        # Priority: new answers > existing config > schema default
        if var_name in answers:
            result[answer_key] = answers[var_name]
        elif var_name in config_vars and config_vars[var_name]:
            result[answer_key] = config_vars[var_name]
        elif var_name in schema["optional"]:
            result[answer_key] = schema["optional"][var_name]

    return result


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def run_prompt_flow(
    config_path: str,
    pre_target: str | None = None,
    pre_instance_type: str | None = None,
) -> None:
    """Execute the full prompt flow and print JSON answer to stdout.

    Steps:
    1. Parse current config from config_path
    2. Check DEPLOY_ANSWERS env var for non-interactive answers
    3. Select target (from flag, env, or interactive prompt)
    4. Diff config against target schema
    5. Prompt for missing values (or use env answers)
    6. Output JSON answer object on stdout

    Args:
        config_path: Path to do/config file.
        pre_target: Pre-selected target from --target flag.
        pre_instance_type: Pre-selected instance type from --instance-type flag.
    """
    # 1. Parse current config
    config_vars = parse_config(config_path)

    # 2. Check for non-interactive answers
    env_answers = load_answers_from_env()

    # 3. Determine target
    target_from_env = env_answers.get("DEPLOYMENT_TARGET") if env_answers else None
    effective_target = pre_target or target_from_env or config_vars.get("DEPLOYMENT_TARGET")

    target = prompt_target_selection(effective_target or None)
    target = normalize_target(target)

    # Apply pre-set instance type to config for diffing
    if pre_instance_type:
        config_vars["INSTANCE_TYPE"] = pre_instance_type

    # 4. Diff config vs schema
    missing = diff_config(target, config_vars)

    # Remove vars that are pre-set via flags
    if pre_instance_type and "INSTANCE_TYPE" in missing:
        del missing["INSTANCE_TYPE"]

    # 5. Collect missing values
    collected = prompt_for_missing(missing, env_answers, config_vars)

    # Merge pre-set values into collected
    if pre_instance_type:
        collected["INSTANCE_TYPE"] = pre_instance_type

    # 6. Build and output JSON
    answer = build_answer_json(target, collected, config_vars)
    print(json.dumps(answer))
    sys.exit(0)
