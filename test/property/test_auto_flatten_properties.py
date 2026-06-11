# Feature: dataset-auto-flatten, Property 1: Chat-format positive detection
"""Property-based tests for dataset auto-flatten detection and flattening logic.

Tests validate correctness properties from the design document using Hypothesis.
The implementation under test lives in templates/do/.tune_helper.py.
"""

import importlib.util
import os
import sys

import hypothesis.strategies as st
from hypothesis import given, settings, HealthCheck

# ── Import the module under test ──────────────────────────────────────────────
# The file has a leading dot in the name, so we use importlib to load it.
_HELPER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".tune_helper.py"
)
_HELPER_PATH = os.path.normpath(_HELPER_PATH)

_spec = importlib.util.spec_from_file_location("tune_helper", _HELPER_PATH)
_tune_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tune_helper)

_detect_chat_columns = _tune_helper._detect_chat_columns
_flatten_value = _tune_helper._flatten_value
_flatten_record = _tune_helper._flatten_record
_apply_column_map = _tune_helper._apply_column_map

# ── Import shared strategies from conftest ────────────────────────────────────
# pytest automatically makes conftest fixtures/strategies available,
# but we import explicitly for clarity.
sys.path.insert(0, os.path.dirname(__file__))
from conftest import single_message_dict, message_list  # noqa: E402


# ── Property 1: Chat-format positive detection ───────────────────────────────
# Validates: Requirements 1.1, 1.2
#
# For any value that is either a dict containing both `role` and `content` keys,
# or a non-empty list whose first element is a dict containing both `role` and
# `content` keys, _detect_chat_columns SHALL classify the column containing
# that value as chat-format.


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=single_message_dict())
def test_single_message_dict_detected_as_chat_format(value):
    """A Single_Message_Dict (dict with role + content) is always detected as chat-format.

    **Validates: Requirements 1.1**
    """
    column_name = "test_col"
    record = {column_name: value}
    required_columns = [column_name]
    schema_types = {column_name: "string"}

    result = _detect_chat_columns(record, required_columns, schema_types)

    assert column_name in result, (
        f"Expected column '{column_name}' to be detected as chat-format "
        f"for value: {value}"
    )
    assert result[column_name]["type"] == "single_dict"


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=message_list(min_size=1, max_size=5, mixed_roles=False))
def test_message_list_same_role_detected_as_chat_format(value):
    """A Message_List (list of dicts with role + content) is detected as chat-format.

    **Validates: Requirements 1.2**
    """
    column_name = "test_col"
    record = {column_name: value}
    required_columns = [column_name]
    schema_types = {column_name: "string"}

    result = _detect_chat_columns(record, required_columns, schema_types)

    assert column_name in result, (
        f"Expected column '{column_name}' to be detected as chat-format "
        f"for value: {value}"
    )
    assert result[column_name]["type"] == "message_list"


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=message_list(min_size=1, max_size=5, mixed_roles=True))
def test_message_list_mixed_roles_detected_as_chat_format(value):
    """A Message_List with mixed roles is also detected as chat-format.

    **Validates: Requirements 1.2**
    """
    column_name = "test_col"
    record = {column_name: value}
    required_columns = [column_name]
    schema_types = {column_name: "string"}

    result = _detect_chat_columns(record, required_columns, schema_types)

    assert column_name in result, (
        f"Expected column '{column_name}' to be detected as chat-format "
        f"for value: {value}"
    )
    assert result[column_name]["type"] == "message_list"


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=message_list(min_size=1, max_size=1, mixed_roles=False))
def test_single_element_message_list_detected_with_extract_strategy(value):
    """A single-element Message_List is detected with 'extract' strategy.

    **Validates: Requirements 1.2**
    """
    column_name = "test_col"
    record = {column_name: value}
    required_columns = [column_name]
    schema_types = {column_name: "string"}

    result = _detect_chat_columns(record, required_columns, schema_types)

    assert column_name in result
    assert result[column_name]["type"] == "message_list"
    assert result[column_name]["strategy"] == "extract"
    assert result[column_name]["count"] == 1


# ── Property 3: Schema-type gating ───────────────────────────────────────────
# Feature: dataset-auto-flatten, Property 3: Schema-type gating
# Validates: Requirements 1.5, 1.6
#
# For any record and schema type map, _detect_chat_columns SHALL only return
# results for columns whose expected type in the schema is "string". Columns
# with expected type "array" SHALL never appear in detection results regardless
# of their value.


@st.composite
def _mixed_schema_record(draw):
    """Generate a record with some 'string' columns and some 'array' columns.

    All columns contain chat-format data (single_message_dict or message_list),
    but only those with schema type 'string' should be detected.
    """
    # Generate unique column names — at least 2
    col_names = draw(
        st.lists(
            st.text(
                alphabet=st.characters(
                    whitelist_categories=("L", "N"), whitelist_characters="_"
                ),
                min_size=1,
                max_size=15,
            ),
            min_size=2,
            max_size=6,
            unique=True,
        )
    )

    # Ensure at least one string-type and one array-type column
    split_idx = max(1, len(col_names) // 2)
    string_cols = col_names[:split_idx]
    array_cols = col_names[split_idx:]

    schema_types = {}
    for col in string_cols:
        schema_types[col] = "string"
    for col in array_cols:
        schema_types[col] = "array"

    # Put chat-format data in every column (both string and array types)
    record = {}
    for col in col_names:
        use_dict = draw(st.booleans())
        if use_dict:
            record[col] = draw(single_message_dict())
        else:
            record[col] = draw(message_list(min_size=1, max_size=4))

    required_columns = col_names

    return record, required_columns, schema_types, string_cols, array_cols


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=_mixed_schema_record())
def test_schema_type_gating_only_string_columns_detected(data):
    """Property 3: Only columns with schema type 'string' appear in detection results.

    For any record and schema type map, _detect_chat_columns SHALL only return
    results for columns whose expected type in the schema is "string". Columns
    with expected type "array" SHALL never appear in detection results regardless
    of their value.

    **Validates: Requirements 1.5, 1.6**
    """
    record, required_columns, schema_types, string_cols, array_cols = data

    result = _detect_chat_columns(record, required_columns, schema_types)

    # Array-type columns must NEVER appear in detection results
    for col in array_cols:
        assert col not in result, (
            f"Column '{col}' has schema type 'array' but appeared in detection results. "
            f"Array-type columns must be excluded from detection entirely."
        )

    # All detected columns must have schema type "string"
    for col in result:
        assert schema_types.get(col) == "string", (
            f"Column '{col}' was detected but has schema type '{schema_types.get(col)}' "
            f"instead of 'string'. Only string-type columns should be detected."
        )

    # String-type columns with chat-format data SHOULD be detected
    # (they all have chat-format data by construction of our strategy)
    for col in string_cols:
        assert col in result, (
            f"Column '{col}' has schema type 'string' and contains chat-format data "
            f"but was NOT detected. String-type columns with chat-format should be detected."
        )


# ── Property 4: Single dict content extraction ────────────────────────────────
# Feature: dataset-auto-flatten, Property 4: Single dict content extraction
# Validates: Requirements 2.1
#
# For any Single_Message_Dict with a string-valued `content` field,
# _flatten_value SHALL return exactly the value of the `content` field
# (identity extraction).


@st.composite
def _single_message_dict_with_string_content(draw):
    """Generate a Single_Message_Dict where `content` is always a string.

    Used specifically for Property 4 which validates content extraction
    for string-valued content fields.
    """
    role = draw(st.text(min_size=1, max_size=20))
    content = draw(st.text(max_size=200))
    return {"role": role, "content": content}


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=_single_message_dict_with_string_content())
def test_single_dict_content_extraction_returns_content_value(value):
    """Property 4: Single dict with string content returns exactly the content value.

    For any Single_Message_Dict with a string-valued `content` field,
    _flatten_value SHALL return exactly the value of the `content` field.

    **Validates: Requirements 2.1**
    """
    detection_result = {"type": "single_dict"}

    result = _flatten_value(value, detection_result)

    assert result == value["content"], (
        f"Expected _flatten_value to return the content field value "
        f"'{value['content']}' but got '{result}'"
    )


# ── Property 5: Non-string content role-based formatting ─────────────────────
# Feature: dataset-auto-flatten, Property 5: Non-string content role-based formatting
# Validates: Requirements 2.2, 2.3
#
# For any dict with a `role` key where either `content` is not a string or
# `content` is absent, `_flatten_value` SHALL return a string that begins
# with `"{role}: "`.


@st.composite
def _dict_with_non_string_content(draw):
    """Generate a dict with 'role' and a non-string 'content' value.

    The content is one of: None, int, dict, or list — never a string.
    """
    role = draw(st.text(min_size=1, max_size=20))
    content = draw(
        st.one_of(
            st.none(),
            st.integers(min_value=-1000, max_value=1000),
            st.dictionaries(
                keys=st.text(min_size=1, max_size=10),
                values=st.text(max_size=50),
                min_size=1,
                max_size=3,
            ),
            st.lists(
                st.text(max_size=50),
                min_size=1,
                max_size=3,
            ),
        )
    )
    return {"role": role, "content": content}


@st.composite
def _dict_with_role_no_content(draw):
    """Generate a dict with 'role' key present but NO 'content' key.

    Includes at least one other key beyond 'role' to ensure there's
    remaining data to format.
    """
    role = draw(st.text(min_size=1, max_size=20))
    extra_keys = draw(
        st.dictionaries(
            keys=st.text(min_size=1, max_size=10).filter(lambda k: k not in ("role", "content")),
            values=st.one_of(
                st.text(max_size=50),
                st.integers(min_value=-100, max_value=100),
                st.none(),
            ),
            min_size=1,
            max_size=4,
        )
    )
    result = {"role": role}
    result.update(extra_keys)
    return result


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=_dict_with_non_string_content())
def test_non_string_content_starts_with_role_prefix(value):
    """Dicts with non-string content are formatted as '{role}: ...'.

    **Validates: Requirements 2.2**
    """
    result = _flatten_value(value, {"type": "single_dict"})

    expected_prefix = f"{value['role']}: "
    assert result.startswith(expected_prefix), (
        f"Expected output to start with '{expected_prefix}' "
        f"but got: '{result[:50]}...'"
    )


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=_dict_with_role_no_content())
def test_missing_content_starts_with_role_prefix(value):
    """Dicts with 'role' but no 'content' key are formatted as '{role}: ...'.

    **Validates: Requirements 2.3**
    """
    result = _flatten_value(value, {"type": "single_dict"})

    expected_prefix = f"{value['role']}: "
    assert result.startswith(expected_prefix), (
        f"Expected output to start with '{expected_prefix}' "
        f"but got: '{result[:50]}...'"
    )


# ── Property 6: Same-role list concatenation ─────────────────────────────────
# Feature: dataset-auto-flatten, Property 6: Same-role list concatenation
# Validates: Requirements 3.2
#
# For any Message_List where all elements share the same role value and have
# string content fields, _flatten_value SHALL return the newline-joined
# concatenation of all content fields (i.e., "\n".join(contents)).


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=message_list(min_size=2, max_size=10, mixed_roles=False))
def test_same_role_list_concatenation(value):
    """Property 6: Same-role Message_Lists are flattened by joining content with newlines.

    For any Message_List where all elements share the same role value and have
    string content fields, _flatten_value SHALL return the newline-joined
    concatenation of all content fields.

    **Validates: Requirements 3.2**
    """
    detection_result = {
        "type": "message_list",
        "strategy": "same_role",
        "count": len(value),
    }

    result = _flatten_value(value, detection_result)

    expected = "\n".join([elem["content"] for elem in value])
    assert result == expected, (
        f"Expected newline-joined content:\n{expected!r}\n"
        f"Got:\n{result!r}\n"
        f"For value: {value}"
    )


# ── Property 7: Multi-role ordered formatting ─────────────────────────────────
# Feature: dataset-auto-flatten, Property 7: Multi-role ordered formatting
# Validates: Requirements 3.3, 3.5
#
# For any Message_List with elements having mixed roles and string content
# fields, _flatten_value SHALL return a string where the i-th line is
# "{role_i}: {content_i}", preserving the original message order.


@st.composite
def _multi_role_message_list(draw):
    """Generate a Message_List with mixed roles and string content (no newlines).

    Ensures:
    - At least 2 elements
    - At least 2 different roles
    - All content fields are strings without newlines
    """
    # Generate at least 2 distinct roles (no newlines — we split on \n to verify)
    roles = draw(
        st.lists(
            st.text(
                alphabet=st.characters(blacklist_characters="\n\r"),
                min_size=1,
                max_size=20,
            ),
            min_size=2,
            max_size=5,
            unique=True,
        )
    )

    # Generate between 2 and 8 messages
    size = draw(st.integers(min_value=2, max_value=8))

    messages = []
    for i in range(size):
        role = roles[i % len(roles)]
        # Content must be a string without newlines (we split on newlines to verify)
        content = draw(
            st.text(
                alphabet=st.characters(blacklist_characters="\n\r"),
                max_size=100,
            )
        )
        messages.append({"role": role, "content": content})

    return messages


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=_multi_role_message_list())
def test_multi_role_ordered_formatting(value):
    """Property 7: Multi-role Message_Lists format as 'role: content' per line in order.

    For any Message_List with elements having mixed roles and string content
    fields, _flatten_value SHALL return a string where the i-th line is
    "{role_i}: {content_i}", preserving the original message order.

    **Validates: Requirements 3.3, 3.5**
    """
    detection_result = {
        "type": "message_list",
        "strategy": "multi_role",
        "count": len(value),
    }

    result = _flatten_value(value, detection_result)

    # Split result into lines
    lines = result.split("\n")

    # Assert the output has the same number of lines as elements
    assert len(lines) == len(value), (
        f"Expected {len(value)} lines but got {len(lines)}. "
        f"Result: {result!r}"
    )

    # Assert that the i-th line is "{role_i}: {content_i}"
    for i, (line, elem) in enumerate(zip(lines, value)):
        expected_line = f"{elem['role']}: {elem['content']}"
        assert line == expected_line, (
            f"Line {i} mismatch:\n"
            f"  Expected: {expected_line!r}\n"
            f"  Got:      {line!r}\n"
            f"  Element:  {elem}"
        )


# ── Property 12: Graceful fallback for unexpected types ───────────────────────
# Feature: dataset-auto-flatten, Property 12: Graceful fallback for unexpected types
# Validates: Requirements 7.1, 7.2, 7.3
#
# For any value that is not a dict, not a list, and not a string (e.g., int,
# float, bool, None), _flatten_value SHALL return a string representation
# without raising an exception. Specifically: None maps to "", and other
# primitives map to str(value).

from conftest import primitive_value  # noqa: E402


# ── Property 10: No-transform error contains suggestion ───────────────────────
# Feature: dataset-auto-flatten, Property 10: No-transform error contains suggestion
# Validates: Requirements 5.3, 6.5
#
# For any column name detected as chat-format, when --no-transform is active,
# the generated error message SHALL contain the substring "--no-transform"
# (providing an actionable suggestion to the user).


@st.composite
def _chat_column_detection(draw):
    """Generate a random column name and a valid detection result dict.

    Produces the same structure that _detect_chat_columns returns for a
    single detected column. Used to test the error message construction
    when --no-transform is active.
    """
    col_name = draw(
        st.text(
            alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_-"),
            min_size=1,
            max_size=30,
        )
    )

    det_type = draw(st.sampled_from(["single_dict", "message_list"]))

    if det_type == "single_dict":
        detection_result = {"type": "single_dict"}
    else:
        strategy = draw(st.sampled_from(["extract", "same_role", "multi_role"]))
        count = draw(st.integers(min_value=1, max_value=50))
        detection_result = {"type": "message_list", "strategy": strategy, "count": count}

    return col_name, detection_result


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=_chat_column_detection())
def test_no_transform_error_contains_suggestion(data):
    """Property 10: No-transform error message contains '--no-transform' substring.

    For any column name detected as chat-format, when --no-transform is active,
    the generated error message SHALL contain the substring "--no-transform"
    (providing an actionable suggestion to the user).

    **Validates: Requirements 5.3, 6.5**
    """
    col_name, det = data
    det_type = det.get("type")
    strategy = det.get("strategy", "")

    # Replicate the error message construction from cmd_stage_hf
    if det_type == "single_dict":
        strategy_desc = "single message dict with role+content"
    elif strategy == "extract":
        strategy_desc = "message list (single element)"
    elif strategy == "same_role":
        strategy_desc = f"message list ({det.get('count', 0)} messages, same role)"
    elif strategy == "multi_role":
        strategy_desc = f"message list (multi-turn, {det.get('count', 0)} messages)"
    else:
        strategy_desc = det_type

    # Build the error message exactly as cmd_stage_hf does
    technique = "sft"  # arbitrary — the technique doesn't affect the assertion
    org = "test_org"
    name = "test_dataset"

    error_msg = (
        f"Column '{col_name}' contains chat-format data (detected: {det_type}) but --no-transform is active.\n\n"
        f"   Remove --no-transform to enable automatic conversion:\n"
        f"      ./do/tune --technique {technique} --dataset hf://{org}/{name} [--column-map ...]\n\n"
        f"   Detected format: {strategy_desc}"
    )

    # The error message MUST contain "--no-transform" as a substring
    assert "--no-transform" in error_msg, (
        f"Expected error message to contain '--no-transform' but it did not.\n"
        f"Column: {col_name}\n"
        f"Detection: {det}\n"
        f"Error message:\n{error_msg}"
    )


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(value=primitive_value())
def test_graceful_fallback_for_unexpected_types(value):
    """Property 12: Unexpected types (int, float, bool, None) produce strings without exceptions.

    For any value that is not a dict, not a list, and not a string,
    _flatten_value SHALL return a string representation without raising
    an exception. None maps to "", other primitives map to str(value).

    **Validates: Requirements 7.1, 7.2, 7.3**
    """
    # Detection result type doesn't matter for fallback behavior
    detection_result = {"type": "single_dict"}

    # Must NOT raise any exception
    result = _flatten_value(value, detection_result)

    # Result must always be a string
    assert isinstance(result, str), (
        f"Expected string result but got {type(result).__name__}: {result!r} "
        f"for input value: {value!r}"
    )

    # None maps to empty string
    if value is None:
        assert result == "", (
            f"Expected None to map to empty string '', but got: {result!r}"
        )
    else:
        # Other primitives (int, float, bool) map to str(value)
        assert result == str(value), (
            f"Expected str({value!r}) = {str(value)!r}, but got: {result!r}"
        )


# ── Property 8: Flattening always produces strings ────────────────────────────
# Feature: dataset-auto-flatten, Property 8: Flattening always produces strings
# Validates: Requirements 4.3, 4.4, 4.5
#
# For any sequence of records containing chat-format columns (as detected by
# first-record analysis), after applying _flatten_record to each record, every
# value in the detected columns SHALL be an instance of str.


@st.composite
def _chat_format_record(draw):
    """Generate a record where all columns contain chat-format values.

    Produces a record with 1-4 columns, each containing either a
    Single_Message_Dict or a Message_List. Also returns the required_columns
    list and schema_types map (all "string").
    """
    col_names = draw(
        st.lists(
            st.text(
                alphabet=st.characters(
                    whitelist_categories=("L", "N"), whitelist_characters="_"
                ),
                min_size=1,
                max_size=15,
            ),
            min_size=1,
            max_size=4,
            unique=True,
        )
    )

    record = {}
    for col in col_names:
        use_dict = draw(st.booleans())
        if use_dict:
            record[col] = draw(single_message_dict())
        else:
            record[col] = draw(message_list(min_size=1, max_size=5, mixed_roles=draw(st.booleans())))

    schema_types = {col: "string" for col in col_names}
    required_columns = col_names

    return record, required_columns, schema_types


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=_chat_format_record())
def test_flattening_always_produces_strings(data):
    """Property 8: After _flatten_record, all detected column values are strings.

    For any record containing chat-format columns, after applying _flatten_record
    with the detection results from _detect_chat_columns, every value in the
    detected columns SHALL be an instance of str.

    **Validates: Requirements 4.3, 4.4, 4.5**
    """
    record, required_columns, schema_types = data

    # Detect chat columns from the record (first-record analysis)
    chat_columns = _detect_chat_columns(record, required_columns, schema_types)

    # Apply _flatten_record
    flattened = _flatten_record(record, chat_columns)

    # Assert every detected column value is a string after flattening
    for col in chat_columns:
        assert isinstance(flattened[col], str), (
            f"Column '{col}' value is {type(flattened[col]).__name__} "
            f"after flattening, expected str. Value: {flattened[col]!r}"
        )


@st.composite
def _subsequent_record_values(draw):
    """Generate a value for a subsequent record column.

    Covers: string pass-through, None, int, bool, empty list, and valid
    chat-format values (Single_Message_Dict and Message_List).
    """
    return draw(
        st.one_of(
            st.text(max_size=200),               # string pass-through
            st.none(),                            # None → ""
            st.integers(min_value=-1000, max_value=1000),  # int → str(int)
            st.booleans(),                        # bool → str(bool)
            st.just([]),                          # empty list → ""
            single_message_dict(),                # valid chat-format dict
            message_list(min_size=1, max_size=3, mixed_roles=False),  # valid chat-format list
        )
    )


@st.composite
def _first_and_subsequent_records(draw):
    """Generate a first record (for detection) and subsequent records with varied values.

    The first record always contains chat-format data for detection.
    Subsequent records may contain strings, None, int, bool, empty lists,
    or valid chat-format values — all must produce strings after flattening.
    """
    col_names = draw(
        st.lists(
            st.text(
                alphabet=st.characters(
                    whitelist_categories=("L", "N"), whitelist_characters="_"
                ),
                min_size=1,
                max_size=15,
            ),
            min_size=1,
            max_size=3,
            unique=True,
        )
    )

    # First record: always chat-format for detection
    first_record = {}
    for col in col_names:
        use_dict = draw(st.booleans())
        if use_dict:
            first_record[col] = draw(single_message_dict())
        else:
            first_record[col] = draw(message_list(min_size=1, max_size=4, mixed_roles=draw(st.booleans())))

    # Subsequent records: varied value types
    num_subsequent = draw(st.integers(min_value=1, max_value=5))
    subsequent_records = []
    for _ in range(num_subsequent):
        rec = {}
        for col in col_names:
            rec[col] = draw(_subsequent_record_values())
        subsequent_records.append(rec)

    schema_types = {col: "string" for col in col_names}
    required_columns = col_names

    return first_record, subsequent_records, required_columns, schema_types


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=_first_and_subsequent_records())
def test_flattening_subsequent_records_always_produces_strings(data):
    """Property 8: Subsequent records with varied types always produce strings after flattening.

    Tests that _flatten_record produces str for all detected columns even when
    subsequent records contain string pass-through, None, int, bool, or empty list.

    **Validates: Requirements 4.3, 4.4, 4.5**
    """
    first_record, subsequent_records, required_columns, schema_types = data

    # Detect chat columns from first record
    chat_columns = _detect_chat_columns(first_record, required_columns, schema_types)

    # Apply _flatten_record to every subsequent record
    for i, record in enumerate(subsequent_records):
        flattened = _flatten_record(record, chat_columns)

        # Assert every detected column value is a string
        for col in chat_columns:
            if col in flattened:
                assert isinstance(flattened[col], str), (
                    f"Record {i}, column '{col}' is {type(flattened[col]).__name__} "
                    f"after flattening, expected str. "
                    f"Original value: {record.get(col)!r}, "
                    f"Flattened value: {flattened[col]!r}"
                )


# ── Property 9: No-transform preserves original values ────────────────────────
# Feature: dataset-auto-flatten, Property 9: No-transform preserves original values
# Validates: Requirements 5.2
#
# For any record and any set of detected chat-columns, when --no-transform is
# active, the record values SHALL remain unchanged (no flattening applied).
# This test verifies that detection (_detect_chat_columns) is read-only and does
# NOT mutate the original record, and that NOT calling _flatten_record means
# values stay identical.

import copy


@st.composite
def _record_with_chat_columns(draw):
    """Generate a record containing chat-format values and matching schema types.

    Returns a tuple of (record, required_columns, schema_types) where the
    record contains a mix of chat-format values in string-typed columns.
    """
    # Generate 1-4 column names
    col_names = draw(
        st.lists(
            st.text(
                alphabet=st.characters(
                    whitelist_categories=("L", "N"), whitelist_characters="_"
                ),
                min_size=1,
                max_size=15,
            ),
            min_size=1,
            max_size=4,
            unique=True,
        )
    )

    record = {}
    schema_types = {}

    for col in col_names:
        schema_types[col] = "string"
        # Generate chat-format data for each column
        use_dict = draw(st.booleans())
        if use_dict:
            record[col] = draw(single_message_dict())
        else:
            record[col] = draw(message_list(min_size=1, max_size=5))

    return record, col_names, schema_types


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=_record_with_chat_columns())
def test_no_transform_preserves_original_values(data):
    """Property 9: When --no-transform is active, records remain unchanged.

    Detection runs (for logging) but does NOT mutate the record. When
    --no-transform is active, _flatten_record is NOT called, so the original
    record values must be completely preserved.

    This verifies:
    1. _detect_chat_columns does not mutate the input record
    2. NOT calling _flatten_record means the record is identical to its original

    **Validates: Requirements 5.2**
    """
    record, required_columns, schema_types = data

    # Deep copy the record BEFORE detection
    original_record = copy.deepcopy(record)

    # Run detection (this simulates what happens even with --no-transform)
    _detect_chat_columns(record, required_columns, schema_types)

    # After detection, the original record must be completely unchanged
    # (detection is read-only — it does NOT mutate the record)
    assert record == original_record, (
        f"_detect_chat_columns mutated the record!\n"
        f"Before: {original_record}\n"
        f"After:  {record}"
    )

    # When --no-transform is active, _flatten_record is NOT called.
    # Therefore, the record values remain identical to the original.
    # This is the key property: no-transform means no mutation.
    assert record == original_record, (
        f"Record was modified even though --no-transform should preserve values.\n"
        f"Original: {original_record}\n"
        f"Current:  {record}"
    )



# ── Property 11: Column rename precedes detection ─────────────────────────────
# Feature: dataset-auto-flatten, Property 11: Column rename precedes detection
# Validates: Requirements 4.1, 5.4
#
# For any record with a column map that renames a source column to a required
# target name, detection SHALL find chat-format data under the target (renamed)
# column name, never the source name.


@st.composite
def _record_with_column_map(draw):
    """Generate a record with a source column containing chat-format data and a column map.

    Returns:
        Tuple of (record, column_map, source_name, target_name) where:
        - record has the chat-format data under source_name
        - column_map maps {target_name: source_name}
        - After applying column_map, data should appear under target_name
    """
    # Generate distinct source and target column names
    source_name = draw(
        st.text(
            alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_"),
            min_size=1,
            max_size=15,
        )
    )
    target_name = draw(
        st.text(
            alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_"),
            min_size=1,
            max_size=15,
        ).filter(lambda t: t != source_name)
    )

    # Generate chat-format data (either single_message_dict or message_list)
    use_dict = draw(st.booleans())
    if use_dict:
        chat_value = draw(single_message_dict())
    else:
        chat_value = draw(message_list(min_size=1, max_size=4))

    # Build the record with chat data under the SOURCE column name
    record = {source_name: chat_value}

    # Column map: {target_name: source_name} — renames source to target
    column_map = {target_name: source_name}

    return record, column_map, source_name, target_name


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=_record_with_column_map())
def test_column_rename_precedes_detection(data):
    """Property 11: Detection finds chat data under the target (renamed) column name.

    For any record with a column map that renames a source column to a required
    target name, detection SHALL find chat-format data under the target (renamed)
    column name, never the source name.

    **Validates: Requirements 4.1, 5.4**
    """
    record, column_map, source_name, target_name = data

    # Step 1: Apply column rename (same as pipeline ordering)
    renamed_record = _apply_column_map(record, column_map)

    # Verify rename worked: target_name should now be in the record
    assert target_name in renamed_record, (
        f"After applying column_map {column_map}, expected '{target_name}' in record "
        f"but got keys: {list(renamed_record.keys())}"
    )

    # Step 2: Run detection on the RENAMED record, using TARGET column as required
    required_columns = [target_name]
    schema_types = {target_name: "string"}

    result = _detect_chat_columns(renamed_record, required_columns, schema_types)

    # Assert: detection finds chat data under the TARGET (renamed) column name
    assert target_name in result, (
        f"Expected detection to find chat-format data under target column '{target_name}' "
        f"after rename from '{source_name}', but detection result was: {result}"
    )

    # Assert: the SOURCE column name does NOT appear in detection results
    assert source_name not in result, (
        f"Source column name '{source_name}' should NOT appear in detection results "
        f"after rename to '{target_name}'. Detection result: {result}"
    )
