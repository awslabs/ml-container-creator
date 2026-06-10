# Feature: hf-dataset-file-selection, Property 1: Glob pattern filtering correctness
"""Property-based tests for HF dataset file selection filtering logic.

Tests validate correctness properties from the design document using Hypothesis.
The implementation under test lives in templates/do/.tune_helper.py.
"""

import fnmatch
import importlib.util
import io
import json
import os
import sys

import hypothesis.strategies as st
from hypothesis import given, settings, HealthCheck, assume
import pytest

# ── Import the module under test ──────────────────────────────────────────────
_HELPER_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "templates", "do", ".tune_helper.py"
)
_HELPER_PATH = os.path.normpath(_HELPER_PATH)

_spec = importlib.util.spec_from_file_location("tune_helper", _HELPER_PATH)
_tune_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tune_helper)

_filter_data_files = _tune_helper._filter_data_files
_is_glob_pattern = _tune_helper._is_glob_pattern
_check_schema_divergence = _tune_helper._check_schema_divergence


# ── Strategies ────────────────────────────────────────────────────────────────

# Characters safe for file path segments (no path separators, no null bytes)
_PATH_SEGMENT_CHARS = st.characters(
    whitelist_categories=("L", "N"),
    whitelist_characters="-_.",
)


@st.composite
def file_path(draw):
    """Generate a realistic file path like 'data/train-00000.parquet'.

    Paths have 0-2 directory segments followed by a filename with an extension.
    """
    num_dirs = draw(st.integers(min_value=0, max_value=2))
    segments = []
    for _ in range(num_dirs):
        seg = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=1, max_size=12))
        segments.append(seg)

    # Filename: base + extension
    base = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=1, max_size=20))
    ext = draw(st.sampled_from([".parquet", ".jsonl", ".json", ".csv", ".arrow"]))
    segments.append(base + ext)

    return "/".join(segments)


@st.composite
def file_path_list(draw, min_size=1, max_size=10):
    """Generate a list of unique file paths."""
    paths = draw(
        st.lists(
            file_path(),
            min_size=min_size,
            max_size=max_size,
            unique=True,
        )
    )
    return paths


@st.composite
def glob_pattern(draw):
    """Generate a glob pattern containing at least one metacharacter (*, ?, [).

    Produces patterns like '*.parquet', 'train-0000?-*', '*call*', '[a-z]*.jsonl'.
    """
    pattern_type = draw(st.sampled_from(["star", "question", "bracket", "combined"]))

    if pattern_type == "star":
        # Patterns with * wildcard
        prefix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=8))
        suffix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=8))
        # May include path separators for matching against full paths
        has_dir = draw(st.booleans())
        if has_dir:
            dir_seg = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=1, max_size=6))
            return f"{dir_seg}/{prefix}*{suffix}"
        return f"{prefix}*{suffix}"

    elif pattern_type == "question":
        # Patterns with ? wildcard
        prefix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=1, max_size=8))
        suffix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=8))
        num_questions = draw(st.integers(min_value=1, max_value=3))
        return prefix + "?" * num_questions + suffix

    elif pattern_type == "bracket":
        # Patterns with [] character class
        prefix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=8))
        suffix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=8))
        # Generate a valid bracket expression
        bracket_type = draw(st.sampled_from(["range", "set"]))
        if bracket_type == "range":
            bracket = "[a-z]"
        else:
            chars = draw(st.text(
                alphabet=st.characters(whitelist_categories=("L", "N")),
                min_size=2,
                max_size=5,
            ))
            bracket = f"[{chars}]"
        return prefix + bracket + suffix

    else:
        # Combined: *, ? mixed
        prefix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=6))
        mid = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=6))
        suffix = draw(st.text(alphabet=_PATH_SEGMENT_CHARS, min_size=0, max_size=6))
        return f"{prefix}*{mid}?{suffix}"


@st.composite
def non_matching_pattern(draw, file_paths):
    """Generate a glob pattern guaranteed not to match any file in the list.

    Uses a UUID-based string that cannot be a substring of any generated filename.
    """
    unique_str = draw(st.text(
        alphabet=st.characters(whitelist_categories=("Lu",)),
        min_size=12,
        max_size=16,
    ))
    pattern = f"*ZZNOMATCH{unique_str}ZZ*"
    return pattern


# ── Property 1: Glob pattern filtering correctness ────────────────────────────
# Feature: hf-dataset-file-selection, Property 1: Glob pattern filtering correctness
# Validates: Requirements 2.1, 2.5
#
# For any list of file paths and any pattern containing glob metacharacters
# (*, ?, [), _filter_data_files SHALL return exactly the files whose full
# relative path matches the pattern via fnmatch.fnmatch.


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(
    data_files=file_path_list(min_size=1, max_size=10),
    pattern=glob_pattern(),
)
def test_glob_pattern_filtering_matches_fnmatch(data_files, pattern):
    """Property 1: Glob pattern filtering returns exactly fnmatch-matched files.

    For any list of file paths and any pattern containing glob metacharacters,
    _filter_data_files SHALL return exactly the files whose full relative path
    matches the pattern via fnmatch.fnmatch.

    **Validates: Requirements 2.1, 2.5**
    """
    # Confirm the pattern is indeed a glob pattern
    assert _is_glob_pattern(pattern), f"Pattern '{pattern}' should be a glob pattern"

    # Compute expected matches using fnmatch on full path
    expected = [f for f in data_files if fnmatch.fnmatch(f, pattern)]

    if expected:
        # When matches exist, _filter_data_files should return exactly those files
        result = _filter_data_files(data_files, pattern)
        assert result == expected, (
            f"Mismatch for pattern '{pattern}':\n"
            f"  Expected: {expected}\n"
            f"  Got:      {result}\n"
            f"  Files:    {data_files}"
        )
    else:
        # When no files match, _filter_data_files should raise SystemExit
        with pytest.raises(SystemExit):
            _filter_data_files(data_files, pattern)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=st.data())
def test_glob_pattern_no_match_raises_system_exit(data):
    """Property 1 (no-match case): When no files match a glob pattern, SystemExit is raised.

    Verifies that _filter_data_files exits with an error when the glob pattern
    matches none of the provided files.

    **Validates: Requirements 2.1, 2.5**
    """
    files = data.draw(file_path_list(min_size=1, max_size=8))
    pattern = data.draw(non_matching_pattern(files))

    # Confirm it's a glob pattern
    assert _is_glob_pattern(pattern)

    with pytest.raises(SystemExit):
        _filter_data_files(files, pattern)


# ── Property 7: Single file skips divergence check ────────────────────────────
# Feature: hf-dataset-file-selection, Property 7: Single file skips divergence check
# Validates: Requirements 5.3, 6.3
#
# For any single file (whether from filtering or naturally), the schema
# divergence check SHALL not be performed, regardless of the file's column
# content.

_check_schema_divergence = _tune_helper._check_schema_divergence


@st.composite
def column_set(draw):
    """Generate a set of column name strings (may be empty)."""
    cols = draw(
        st.lists(
            st.text(
                alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_"),
                min_size=1,
                max_size=15,
            ),
            min_size=0,
            max_size=10,
            unique=True,
        )
    )
    return set(cols)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(
    filename=file_path(),
    columns=column_set(),
    dataset_id=st.text(
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="/-_"),
        min_size=3,
        max_size=30,
    ),
    technique=st.sampled_from(["sft", "dpo", "rlvr", "rlaif"]),
)
def test_single_file_skips_divergence_check(filename, columns, dataset_id, technique):
    """Property 7: Single file never triggers schema divergence error.

    For any single file (whether from filtering or naturally), the schema
    divergence check SHALL not be performed, regardless of the file's column
    content — even if columns are empty.

    **Validates: Requirements 5.3, 6.3**
    """
    file_records = [(filename, columns)]

    # Single file must always return None without raising
    result = _check_schema_divergence(file_records, dataset_id, technique)
    assert result is None, (
        f"Expected None for single file, got {result}.\n"
        f"  file_records: {file_records}\n"
        f"  dataset_id: {dataset_id}\n"
        f"  technique: {technique}"
    )


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(
    dataset_id=st.text(
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="/-_"),
        min_size=3,
        max_size=30,
    ),
    technique=st.sampled_from(["sft", "dpo", "rlvr", "rlaif"]),
)
def test_empty_file_records_skips_divergence_check(dataset_id, technique):
    """Property 7 (empty case): Empty file list returns None without error.

    An empty file_records list should also return None — there is nothing
    to compare.

    **Validates: Requirements 5.3, 6.3**
    """
    file_records = []

    result = _check_schema_divergence(file_records, dataset_id, technique)
    assert result is None, (
        f"Expected None for empty file_records, got {result}.\n"
        f"  dataset_id: {dataset_id}\n"
        f"  technique: {technique}"
    )


# ── Property 6: Identical schemas allow concatenation ─────────────────────────
# Feature: hf-dataset-file-selection, Property 6: Identical schemas allow concatenation
# Validates: Requirements 3.5, 6.1
#
# For any set of two or more files whose effective column sets are all identical,
# _check_schema_divergence SHALL not raise an error.

_check_schema_divergence = _tune_helper._check_schema_divergence


@st.composite
def column_set(draw):
    """Generate a non-empty set of column name strings."""
    col_names = draw(
        st.lists(
            st.text(
                alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_"),
                min_size=1,
                max_size=15,
            ),
            min_size=1,
            max_size=8,
            unique=True,
        )
    )
    return set(col_names)


@st.composite
def identical_schema_file_records(draw):
    """Generate file_records with 2-5 files all sharing the SAME column set.

    Returns a list of (filename, column_set) tuples where every column_set is identical.
    """
    # Generate one shared column set
    shared_columns = draw(column_set())

    # Generate 2-5 unique filenames
    num_files = draw(st.integers(min_value=2, max_value=5))
    filenames = draw(
        st.lists(
            file_path(),
            min_size=num_files,
            max_size=num_files,
            unique=True,
        )
    )

    # Build file_records with the same column set for all files
    return [(fname, shared_columns) for fname in filenames]


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(
    file_records=identical_schema_file_records(),
    dataset_id=st.text(
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="/-_"),
        min_size=3,
        max_size=30,
    ),
    technique=st.sampled_from(["sft", "dpo", "rlvr", "rlaif"]),
)
def test_identical_schemas_allow_concatenation(file_records, dataset_id, technique):
    """Property 6: Identical schemas allow concatenation.

    For any set of two or more files whose effective column sets are all identical,
    _check_schema_divergence SHALL not raise an error.

    **Validates: Requirements 3.5, 6.1**
    """
    # All file_records have the same column set — should return None without error
    result = _check_schema_divergence(file_records, dataset_id, technique)
    assert result is None, (
        f"Expected None (no error) for identical schemas, got: {result}\n"
        f"  file_records: {file_records}\n"
        f"  dataset_id: {dataset_id}\n"
        f"  technique: {technique}"
    )


# ── Strategies for schema divergence tests ────────────────────────────────────

# Column name strategy: simple identifiers suitable for dataframe columns
_COLUMN_CHARS = st.characters(whitelist_categories=("Ll",), whitelist_characters="_")


@st.composite
def column_name(draw):
    """Generate a realistic column name like 'prompt', 'col_a', etc."""
    name = draw(st.text(alphabet=_COLUMN_CHARS, min_size=1, max_size=12))
    assume(name.strip("_"))  # Avoid all-underscore names
    return name


@st.composite
def column_set(draw, min_size=1, max_size=6):
    """Generate a non-empty set of unique column names."""
    cols = draw(
        st.lists(
            column_name(),
            min_size=min_size,
            max_size=max_size,
            unique=True,
        )
    )
    return set(cols)


@st.composite
def divergent_file_records(draw, min_files=2, max_files=5):
    """Generate file_records where column sets are NOT all identical.

    Produces 2-5 (filename, column_set) tuples where at least two files
    have different column sets.
    """
    num_files = draw(st.integers(min_value=min_files, max_value=max_files))

    # Generate unique filenames
    filenames = draw(
        st.lists(
            file_path(),
            min_size=num_files,
            max_size=num_files,
            unique=True,
        )
    )

    # Generate at least 2 distinct column sets
    base_cols = draw(column_set(min_size=1, max_size=5))
    alt_cols = draw(column_set(min_size=1, max_size=5))
    assume(base_cols != alt_cols)

    # Assign column sets: first file gets base_cols, at least one gets alt_cols
    records = []
    records.append((filenames[0], base_cols))

    # Ensure at least one file differs from the first
    differ_idx = draw(st.integers(min_value=1, max_value=num_files - 1))
    for i in range(1, num_files):
        if i == differ_idx:
            records.append((filenames[i], alt_cols))
        else:
            chosen = draw(st.sampled_from([base_cols, alt_cols]))
            records.append((filenames[i], chosen))

    return records


# ── Property 5: Schema divergence detection ───────────────────────────────────
# Feature: hf-dataset-file-selection, Property 5: Schema divergence detection
# Validates: Requirements 3.2, 3.3, 3.4, 5.1, 5.2
#
# For any set of two or more files whose effective column sets are not all
# identical, _check_schema_divergence SHALL exit with an error that contains
# each filename, each file's column list, and a ?file= remediation suggestion.


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=st.data())
def test_schema_divergence_detection(data):
    """Property 5: Schema divergence detection exits with actionable error.

    For any set of two or more files whose effective column sets are not all
    identical, _check_schema_divergence SHALL exit with an error that contains
    each filename, each file's column list, and a ?file= remediation suggestion.

    **Validates: Requirements 3.2, 3.3, 3.4, 5.1, 5.2**
    """
    file_records = data.draw(divergent_file_records(min_files=2, max_files=5))
    dataset_id = data.draw(st.text(
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="/-_"),
        min_size=3,
        max_size=30,
    ))
    technique = data.draw(st.sampled_from(["sft", "dpo", "rlvr", "rlaif"]))

    # Capture stdout and expect SystemExit
    captured = io.StringIO()
    old_stdout = sys.stdout
    try:
        sys.stdout = captured
        with pytest.raises(SystemExit) as exc_info:
            _check_schema_divergence(file_records, dataset_id, technique)
    finally:
        sys.stdout = old_stdout

    # Verify exit code is 1
    assert exc_info.value.code == 1

    # Parse the captured stdout (JSON with "error" key)
    output = captured.getvalue()
    error_data = json.loads(output)
    error_msg = error_data["error"]

    # Requirement 3.3: Error contains each filename
    for filename, _ in file_records:
        assert filename in error_msg, (
            f"Filename '{filename}' not found in error message:\n{error_msg}"
        )

    # Requirement 3.3: Error contains at least one column from each file
    for filename, columns in file_records:
        found_any = any(col in error_msg for col in columns)
        assert found_any, (
            f"No columns from file '{filename}' (columns: {columns}) "
            f"found in error message:\n{error_msg}"
        )

    # Requirement 3.4, 5.2: Error contains ?file= remediation suggestion
    assert "?file=" in error_msg, (
        f"Remediation suggestion '?file=' not found in error message:\n{error_msg}"
    )


# ── Property 8: Schema comparison respects column mapping ─────────────────────
# Feature: hf-dataset-file-selection, Property 8: Schema comparison respects column mapping
# Validates: Requirements 3.6
#
# For any set of files whose raw column names differ but whose column names
# after applying _apply_column_map are identical, _check_schema_divergence
# SHALL not raise an error.

_apply_column_map = _tune_helper._apply_column_map
_check_schema_divergence = _tune_helper._check_schema_divergence


@st.composite
def column_mapping_scenario(draw):
    """Generate a scenario where multiple files have different raw columns but
    identical effective columns after applying column mapping.

    Returns:
        tuple: (effective_columns, file_raw_records, column_maps)
            - effective_columns: set of target column names all files share
            - file_raw_records: list of dicts with raw column names per file
            - column_maps: list of column_map dicts to apply per file
    """
    # Generate 2-5 effective (target) column names
    num_cols = draw(st.integers(min_value=2, max_value=5))
    effective_cols = draw(
        st.lists(
            st.text(
                alphabet=st.characters(whitelist_categories=("Ll",)),
                min_size=2,
                max_size=10,
            ),
            min_size=num_cols,
            max_size=num_cols,
            unique=True,
        )
    )
    effective_columns = set(effective_cols)

    # Generate 2-4 files, each with different raw column names
    num_files = draw(st.integers(min_value=2, max_value=4))
    file_raw_records = []
    column_maps = []

    for _ in range(num_files):
        # For each file, generate unique raw names for each effective column
        raw_names = draw(
            st.lists(
                st.text(
                    alphabet=st.characters(whitelist_categories=("Ll", "N")),
                    min_size=2,
                    max_size=12,
                ),
                min_size=num_cols,
                max_size=num_cols,
                unique=True,
            )
        )
        # Ensure raw names are different from effective names for at least one
        # (otherwise it's trivially the same schema without mapping)
        # Build the record with raw column names and dummy values
        raw_record = {raw_name: f"value_{i}" for i, raw_name in enumerate(raw_names)}

        # Build column_map: target -> source (effective_name -> raw_name)
        column_map = {}
        for eff_name, raw_name in zip(effective_cols, raw_names):
            if eff_name != raw_name:
                column_map[eff_name] = raw_name

        file_raw_records.append(raw_record)
        column_maps.append(column_map)

    return effective_columns, file_raw_records, column_maps


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(data=st.data())
def test_schema_comparison_respects_column_mapping(data):
    """Property 8: Schema comparison respects column mapping.

    For any set of files whose raw column names differ but whose column names
    after applying _apply_column_map are identical, _check_schema_divergence
    SHALL not raise an error.

    **Validates: Requirements 3.6**
    """
    effective_columns, file_raw_records, column_maps = data.draw(
        column_mapping_scenario()
    )

    # Step 1: Apply _apply_column_map to each file's raw record
    mapped_records = []
    for raw_record, col_map in zip(file_raw_records, column_maps):
        mapped = _apply_column_map(raw_record, col_map)
        mapped_records.append(mapped)

    # Step 2: Extract the column sets from mapped records
    mapped_column_sets = [set(mapped.keys()) for mapped in mapped_records]

    # Step 3: Verify all mapped column sets are identical (precondition)
    # All files should produce the same effective columns after mapping
    assume(all(cols == mapped_column_sets[0] for cols in mapped_column_sets))

    # Step 4: Build file_records as expected by _check_schema_divergence
    file_records = [
        (f"data/file-{i:05d}.parquet", mapped_column_sets[i])
        for i in range(len(mapped_column_sets))
    ]

    # Step 5: _check_schema_divergence should return None (no error)
    result = _check_schema_divergence(file_records, "test-org/test-dataset", "sft")
    assert result is None, (
        f"Expected None (no divergence) but got error.\n"
        f"Effective columns: {effective_columns}\n"
        f"Mapped column sets: {mapped_column_sets}"
    )
