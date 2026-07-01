# Feature: agent-config-externalization
"""Property-based tests for agent config loader.

Tests validate correctness properties from the design document using Hypothesis.
The implementation under test lives in src/agent/config_loader.py.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import hypothesis.strategies as st
from hypothesis import given, settings, HealthCheck

# ── Import the module under test ──────────────────────────────────────────────
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "agent")
)
from config_loader import load_agent_config, _DEFAULTS, AgentConfig  # noqa: E402


# ── Strategies ────────────────────────────────────────────────────────────────

# Simple alphanumeric strings suitable for model IDs and server names
_simple_str = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
)

# List of server names (non-empty strings without commas)
_server_list = st.lists(
    st.text(
        min_size=1,
        max_size=20,
        alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
    ),
    min_size=1,
    max_size=6,
)

# Non-negative floats for cost values
_nn_float = st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)

# Non-negative integers for timeout
_nn_int = st.integers(min_value=0, max_value=3600)

# All MCC_* env vars that need to be controlled
_ALL_MCC_VARS = [
    "MCC_MODEL_ID",
    "MCC_MCP_SERVERS",
    "MCC_INPUT_COST_PER_1K",
    "MCC_OUTPUT_COST_PER_1K",
    "MCC_EXIT_COMMANDS",
    "MCC_RELOAD_COMMANDS",
    "MCC_MCP_SERVER_TIMEOUT",
]

# Non-existent path for config (forces env-var-only or default resolution)
_NONEXISTENT_CONFIG = Path(tempfile.gettempdir()) / "mcc_test_nonexistent" / "agent.json"


# ── Property 1: Precedence Resolution ────────────────────────────────────────
# Validates: Requirements 3.1, 3.2, 3.3, 3.4, 2.1, 2.2
#
# For any configuration parameter, when an environment override, a config file
# value, and a hardcoded default are all available, the resolved value SHALL
# equal the environment override. When only the config file value and default
# are available (no env var set), the resolved value SHALL equal the config
# file value. When neither env var nor config file value is available, the
# resolved value SHALL equal the hardcoded default.


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(env_model_id=_simple_str, file_model_id=_simple_str)
def test_env_var_takes_precedence_over_file_for_model_id(
    env_model_id, file_model_id, tmp_path
):
    """When env var is set and config file has a value, env var wins.

    **Validates: Requirements 3.1, 3.2, 2.1, 2.2**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"modelId": file_model_id}))

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MODEL_ID"] = env_model_id

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.model_id == env_model_id


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(file_model_id=_simple_str)
def test_file_value_takes_precedence_over_default_for_model_id(
    file_model_id, tmp_path
):
    """When no env var is set but config file has a value, file wins.

    **Validates: Requirements 3.3, 2.1**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"modelId": file_model_id}))

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.model_id == file_model_id


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(data=st.data())
def test_default_used_when_no_env_var_and_no_file_value(data, tmp_path):
    """When neither env var nor config file value is available, default is used.

    **Validates: Requirements 3.4**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({}))

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.model_id == _DEFAULTS.model_id
        assert config.mcp_servers == _DEFAULTS.mcp_servers
        assert config.input_cost_per_1k == _DEFAULTS.input_cost_per_1k
        assert config.output_cost_per_1k == _DEFAULTS.output_cost_per_1k
        assert config.exit_commands == _DEFAULTS.exit_commands
        assert config.reload_commands == _DEFAULTS.reload_commands
        assert config.mcp_server_timeout == _DEFAULTS.mcp_server_timeout


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(env_servers=_server_list, file_servers=_server_list)
def test_env_var_takes_precedence_over_file_for_list_field(
    env_servers, file_servers, tmp_path
):
    """When env var is set for list field, env var wins over file.

    **Validates: Requirements 3.1, 3.2**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"mcpServers": file_servers}))

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MCP_SERVERS"] = ",".join(env_servers)

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.mcp_servers == env_servers


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(file_servers=_server_list)
def test_file_value_takes_precedence_over_default_for_list_field(
    file_servers, tmp_path
):
    """When no env var, file value wins over default for list field.

    **Validates: Requirements 3.3**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"mcpServers": file_servers}))

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.mcp_servers == file_servers


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(env_timeout=_nn_int, file_timeout=_nn_int)
def test_env_var_takes_precedence_over_file_for_numeric_field(
    env_timeout, file_timeout, tmp_path
):
    """When env var is set for numeric field, env var wins over file.

    **Validates: Requirements 3.1, 3.2**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"mcpServerTimeout": file_timeout}))

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MCP_SERVER_TIMEOUT"] = str(env_timeout)

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.mcp_server_timeout == env_timeout


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(file_timeout=_nn_int)
def test_file_value_takes_precedence_over_default_for_numeric_field(
    file_timeout, tmp_path
):
    """When no env var, file value wins over default for numeric field.

    **Validates: Requirements 3.3**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"mcpServerTimeout": file_timeout}))

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.mcp_server_timeout == file_timeout


@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(
    env_model_id=_simple_str,
    env_cost=_nn_float,
    file_model_id=_simple_str,
    file_servers=_server_list,
    file_cost=_nn_float,
)
def test_precedence_applies_per_field_independently(
    env_model_id, env_cost, file_model_id, file_servers, file_cost, tmp_path
):
    """Precedence is resolved per field: env wins where set, file wins elsewhere.

    **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({
        "modelId": file_model_id,
        "mcpServers": file_servers,
        "inputCostPer1k": file_cost,
    }))

    # Set env var only for model_id and input_cost
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MODEL_ID"] = env_model_id
    clean_env["MCC_INPUT_COST_PER_1K"] = str(env_cost)

    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)

        # Env wins for model_id and input_cost
        assert config.model_id == env_model_id
        assert config.input_cost_per_1k == env_cost
        # File wins for mcp_servers (no env override set)
        assert config.mcp_servers == file_servers
        # Default wins for fields not in file or env
        assert config.output_cost_per_1k == _DEFAULTS.output_cost_per_1k
        assert config.exit_commands == _DEFAULTS.exit_commands
        assert config.reload_commands == _DEFAULTS.reload_commands
        assert config.mcp_server_timeout == _DEFAULTS.mcp_server_timeout


# ── Property 5: Per-Field Type Validation Fallback ────────────────────────────
# Validates: Requirements 5.2
#
# For any config JSON object where exactly one field has a value of the wrong
# type (e.g., a string where a number is expected), the loader SHALL return
# the hardcoded default for that specific field while preserving valid values
# from the config file for all other fields.


# Valid value strategies per field (for Property 5)
_valid_model_id = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters=".-_/"),
    min_size=1,
    max_size=50,
)

_valid_mcp_servers = st.lists(
    st.text(
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
        min_size=1,
        max_size=20,
    ),
    min_size=1,
    max_size=6,
)

_valid_input_cost = st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)
_valid_output_cost = st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)

_valid_exit_commands = st.lists(
    st.text(
        alphabet=st.characters(whitelist_categories=("L",), whitelist_characters="-_"),
        min_size=1,
        max_size=10,
    ),
    min_size=1,
    max_size=5,
)

_valid_reload_commands = st.lists(
    st.text(
        alphabet=st.characters(whitelist_categories=("L",), whitelist_characters="-_"),
        min_size=1,
        max_size=10,
    ),
    min_size=1,
    max_size=5,
)

_valid_mcp_server_timeout = st.integers(min_value=0, max_value=300)


# Invalid value strategies (wrong type for each field)
_invalid_for_string = st.one_of(
    st.integers(min_value=-1000, max_value=1000),
    st.lists(st.text(min_size=1, max_size=5), min_size=1, max_size=3),
)

_invalid_for_number = st.text(
    alphabet=st.characters(whitelist_categories=("L",)),
    min_size=1,
    max_size=10,
)

_invalid_for_list = st.one_of(
    st.text(min_size=1, max_size=20),
    st.integers(min_value=0, max_value=100),
)

_invalid_for_int = st.one_of(
    st.text(
        alphabet=st.characters(whitelist_categories=("L",)),
        min_size=1,
        max_size=10,
    ),
    st.floats(min_value=0.1, max_value=100.0, allow_nan=False, allow_infinity=False).filter(
        lambda x: x != int(x)
    ),
)


# Field definitions: (json_key, valid_strategy, invalid_strategy, default_attr)
_FIELDS_P5 = [
    ("modelId", _valid_model_id, _invalid_for_string, "model_id"),
    ("mcpServers", _valid_mcp_servers, _invalid_for_list, "mcp_servers"),
    ("inputCostPer1k", _valid_input_cost, _invalid_for_number, "input_cost_per_1k"),
    ("outputCostPer1k", _valid_output_cost, _invalid_for_number, "output_cost_per_1k"),
    ("exitCommands", _valid_exit_commands, _invalid_for_list, "exit_commands"),
    ("reloadCommands", _valid_reload_commands, _invalid_for_list, "reload_commands"),
    ("mcpServerTimeout", _valid_mcp_server_timeout, _invalid_for_int, "mcp_server_timeout"),
]


@st.composite
def valid_config_with_one_corrupted_field(draw):
    """Generate a valid config dict, then corrupt exactly one field with a wrong-type value.

    Returns (config_dict, corrupted_field_index, valid_values) where corrupted_field_index
    identifies which field was corrupted.
    """
    # Generate valid values for all fields
    config = {}
    valid_values = {}
    for json_key, valid_strat, _, _ in _FIELDS_P5:
        val = draw(valid_strat)
        config[json_key] = val
        valid_values[json_key] = val

    # Pick one field to corrupt
    corrupted_idx = draw(st.integers(min_value=0, max_value=len(_FIELDS_P5) - 1))
    json_key, _, invalid_strat, _ = _FIELDS_P5[corrupted_idx]
    invalid_val = draw(invalid_strat)
    config[json_key] = invalid_val

    return config, corrupted_idx, valid_values


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=valid_config_with_one_corrupted_field())
def test_per_field_type_validation_fallback(data):
    """When exactly one field has a wrong-type value, the loader returns the default
    for that field and preserves valid values for all other fields.

    **Validates: Requirements 5.2**
    """
    config_dict, corrupted_idx, valid_values = data

    # Clear any MCC_* env vars to isolate config file behavior
    original_env = {}
    for var in _ALL_MCC_VARS:
        if var in os.environ:
            original_env[var] = os.environ.pop(var)

    try:
        # Write config to temp file and load
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(config_dict, f)
            tmp_path = f.name

        try:
            result = load_agent_config(config_path=Path(tmp_path))

            # The corrupted field should equal the hardcoded default
            corrupted_json_key, _, _, corrupted_attr = _FIELDS_P5[corrupted_idx]
            expected_default = getattr(_DEFAULTS, corrupted_attr)
            actual_corrupted = getattr(result, corrupted_attr)
            assert actual_corrupted == expected_default, (
                f"Corrupted field '{corrupted_json_key}' (attr '{corrupted_attr}') "
                f"should be default {expected_default!r}, got {actual_corrupted!r}. "
                f"Config value was: {config_dict[corrupted_json_key]!r}"
            )

            # All other fields should preserve their valid values from the file
            for i, (json_key, _, _, attr_name) in enumerate(_FIELDS_P5):
                if i == corrupted_idx:
                    continue
                expected_val = valid_values[json_key]
                actual_val = getattr(result, attr_name)
                assert actual_val == expected_val, (
                    f"Valid field '{json_key}' (attr '{attr_name}') should be "
                    f"{expected_val!r}, got {actual_val!r}"
                )
        finally:
            os.unlink(tmp_path)
    finally:
        # Restore original env vars
        for var, val in original_env.items():
            os.environ[var] = val


# ── Property 4: Invalid JSON Total Fallback ───────────────────────────────────
# Validates: Requirements 5.1
#
# For any string that is not valid JSON, when written to the config file path,
# the loader SHALL return an AgentConfig whose every field equals the
# corresponding hardcoded default value.

from hypothesis import assume


@st.composite
def invalid_json(draw):
    """Generate strings that are NOT valid JSON."""
    text = draw(st.text(min_size=1, max_size=200))
    try:
        json.loads(text)
        assume(False)  # skip if it happens to be valid JSON
    except (json.JSONDecodeError, ValueError):
        pass
    return text


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(content=invalid_json())
def test_invalid_json_total_fallback(content: str, tmp_path) -> None:
    """Property 4: Invalid JSON Total Fallback.

    For any string that is not valid JSON, when written to the config file path,
    the loader SHALL return an AgentConfig whose every field equals the
    corresponding hardcoded default value.

    **Validates: Requirements 5.1**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(content, encoding="utf-8")

    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}

    with patch.dict(os.environ, clean_env, clear=True):
        result = load_agent_config(config_path=config_file)

        assert result.model_id == _DEFAULTS.model_id
        assert result.mcp_servers == _DEFAULTS.mcp_servers
        assert result.input_cost_per_1k == _DEFAULTS.input_cost_per_1k
        assert result.output_cost_per_1k == _DEFAULTS.output_cost_per_1k
        assert result.exit_commands == _DEFAULTS.exit_commands
        assert result.reload_commands == _DEFAULTS.reload_commands
        assert result.mcp_server_timeout == _DEFAULTS.mcp_server_timeout


# ── Property 2: Comma-Separated List Round-Trip ──────────────────────────────
# Validates: Requirements 2.3, 2.6, 2.7

# Strategy: lists of non-empty strings without commas
_list_items = st.text(
    min_size=1,
    max_size=15,
    alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
)
_list_of_strings = st.lists(_list_items, min_size=1, max_size=10)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(original_list=_list_of_strings)
def test_comma_separated_list_round_trip(original_list):
    """Joining a list with commas and setting as env var produces the same list back.

    **Validates: Requirements 2.3, 2.6, 2.7**
    """
    env_vars_to_fields = {
        "MCC_MCP_SERVERS": "mcp_servers",
        "MCC_EXIT_COMMANDS": "exit_commands",
        "MCC_RELOAD_COMMANDS": "reload_commands",
    }
    for env_var, field_name in env_vars_to_fields.items():
        joined = ",".join(original_list)
        clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
        clean_env[env_var] = joined
        with patch.dict(os.environ, clean_env, clear=True):
            config = load_agent_config(config_path=_NONEXISTENT_CONFIG)
            resolved = getattr(config, field_name)
            expected = [s.strip() for s in original_list]
            assert resolved == expected


# ── Property 3: Numeric Environment Variable Round-Trip ───────────────────────
# Validates: Requirements 2.4, 2.5, 2.8

_test_float = st.floats(min_value=0.0, max_value=1000.0, allow_nan=False, allow_infinity=False)
_test_int = st.integers(min_value=0, max_value=10000)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=_test_float)
def test_numeric_float_env_var_round_trip(value):
    """Setting MCC_INPUT_COST_PER_1K or MCC_OUTPUT_COST_PER_1K to str(f) produces f back.

    **Validates: Requirements 2.4, 2.5**
    """
    for env_var, field in [("MCC_INPUT_COST_PER_1K", "input_cost_per_1k"), ("MCC_OUTPUT_COST_PER_1K", "output_cost_per_1k")]:
        clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
        clean_env[env_var] = str(value)
        with patch.dict(os.environ, clean_env, clear=True):
            config = load_agent_config(config_path=_NONEXISTENT_CONFIG)
            assert getattr(config, field) == float(str(value))


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=_test_int)
def test_numeric_int_env_var_round_trip(value):
    """Setting MCC_MCP_SERVER_TIMEOUT to str(n) produces n back.

    **Validates: Requirements 2.8**
    """
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MCP_SERVER_TIMEOUT"] = str(value)
    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=_NONEXISTENT_CONFIG)
        assert config.mcp_server_timeout == value


# ── Property 6: Invalid Environment Variable Fallthrough ──────────────────────
# Validates: Requirements 5.3

_unparseable_str = st.text(
    alphabet=st.characters(whitelist_categories=("L",)),
    min_size=1,
    max_size=10,
)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(bad_value=_unparseable_str, file_timeout=_nn_int)
def test_invalid_env_var_fallthrough_to_file(bad_value, file_timeout, tmp_path):
    """Unparseable env var falls through to config file value.

    **Validates: Requirements 5.3**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"mcpServerTimeout": file_timeout}))
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MCP_SERVER_TIMEOUT"] = bad_value
    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.mcp_server_timeout == file_timeout


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(bad_value=_unparseable_str)
def test_invalid_env_var_fallthrough_to_default(bad_value, tmp_path):
    """Unparseable env var falls through to default when no file value.

    **Validates: Requirements 5.3**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({}))
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MCP_SERVER_TIMEOUT"] = bad_value
    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.mcp_server_timeout == _DEFAULTS.mcp_server_timeout


# ── Property 7: Negative Numeric Rejection ────────────────────────────────────
# Validates: Requirements 5.4

_negative_float = st.floats(min_value=-1000.0, max_value=-0.001, allow_nan=False, allow_infinity=False)
_negative_int = st.integers(min_value=-10000, max_value=-1)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(neg_cost=_negative_float)
def test_negative_float_from_file_rejected(neg_cost, tmp_path):
    """Negative float in config file falls back to default.

    **Validates: Requirements 5.4**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"inputCostPer1k": neg_cost, "outputCostPer1k": neg_cost}))
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.input_cost_per_1k == _DEFAULTS.input_cost_per_1k
        assert config.output_cost_per_1k == _DEFAULTS.output_cost_per_1k


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(neg_timeout=_negative_int)
def test_negative_int_from_file_rejected(neg_timeout, tmp_path):
    """Negative int in config file falls back to default.

    **Validates: Requirements 5.4**
    """
    config_file = tmp_path / "agent.json"
    config_file.write_text(json.dumps({"mcpServerTimeout": neg_timeout}))
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=config_file)
        assert config.mcp_server_timeout == _DEFAULTS.mcp_server_timeout


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(neg_cost=_negative_float)
def test_negative_float_from_env_var_rejected(neg_cost):
    """Negative float in env var falls back to default.

    **Validates: Requirements 5.4**
    """
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_INPUT_COST_PER_1K"] = str(neg_cost)
    clean_env["MCC_OUTPUT_COST_PER_1K"] = str(neg_cost)
    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=_NONEXISTENT_CONFIG)
        assert config.input_cost_per_1k == _DEFAULTS.input_cost_per_1k
        assert config.output_cost_per_1k == _DEFAULTS.output_cost_per_1k


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(neg_timeout=_negative_int)
def test_negative_int_from_env_var_rejected(neg_timeout):
    """Negative int in env var falls back to default.

    **Validates: Requirements 5.4**
    """
    clean_env = {k: v for k, v in os.environ.items() if k not in _ALL_MCC_VARS}
    clean_env["MCC_MCP_SERVER_TIMEOUT"] = str(neg_timeout)
    with patch.dict(os.environ, clean_env, clear=True):
        config = load_agent_config(config_path=_NONEXISTENT_CONFIG)
        assert config.mcp_server_timeout == _DEFAULTS.mcp_server_timeout
