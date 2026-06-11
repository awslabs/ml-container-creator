"""Shared Hypothesis strategies for dataset auto-flatten property tests.

These strategies generate randomized inputs for testing the detection and
flattening logic in templates/do/.tune_helper.py.
"""

import hypothesis.strategies as st
from hypothesis import settings


# Default settings for all property tests in this directory
settings.register_profile("default", max_examples=100)
settings.load_profile("default")


@st.composite
def single_message_dict(draw):
    """Generate a dict with 'role' (non-empty str) and 'content' (str | None | int | dict).

    Always produces dicts that have both 'role' and 'content' keys, matching
    the Single_Message_Dict definition from the spec.
    """
    role = draw(st.text(min_size=1, max_size=20))
    content = draw(
        st.one_of(
            st.text(max_size=200),
            st.none(),
            st.integers(min_value=-1000, max_value=1000),
            st.dictionaries(
                keys=st.text(min_size=1, max_size=10),
                values=st.text(max_size=50),
                min_size=1,
                max_size=3,
            ),
        )
    )
    return {"role": role, "content": content}


@st.composite
def message_list(draw, min_size=1, max_size=5, mixed_roles=False):
    """Generate a list of message dicts (Message_List).

    Args:
        min_size: Minimum number of messages in the list (default 1).
        max_size: Maximum number of messages in the list (default 5).
        mixed_roles: When False, all messages share the same role.
                     When True, messages have varying roles.
    """
    size = draw(st.integers(min_value=min_size, max_value=max_size))

    if mixed_roles:
        # Generate messages with different roles (at least 2 distinct roles)
        roles = draw(
            st.lists(
                st.text(min_size=1, max_size=20),
                min_size=2,
                max_size=5,
            )
        )
        messages = []
        for i in range(size):
            role = roles[i % len(roles)]
            content = draw(st.text(max_size=200))
            messages.append({"role": role, "content": content})
    else:
        # All messages share the same role
        shared_role = draw(st.text(min_size=1, max_size=20))
        messages = []
        for _ in range(size):
            content = draw(st.text(max_size=200))
            messages.append({"role": shared_role, "content": content})

    return messages


@st.composite
def flat_string(draw):
    """Generate an arbitrary non-empty string (not a dict or list).

    Used to represent values that are already flat strings and should NOT
    be detected as chat-format.
    """
    return draw(st.text(min_size=1, max_size=200))


@st.composite
def plain_string_list(draw):
    """Generate a list of plain strings (no dicts).

    These represent non-chat-format list values that should NOT trigger
    chat-format detection.
    """
    return draw(
        st.lists(
            st.text(min_size=1, max_size=100),
            min_size=1,
            max_size=10,
        )
    )


@st.composite
def schema_types_map(draw):
    """Generate a dict mapping column names to schema types ('string' or 'array').

    Represents the schema_types parameter passed to _detect_chat_columns,
    where each column has an expected type from the technique schema.
    """
    return draw(
        st.dictionaries(
            keys=st.text(
                alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_-"),
                min_size=1,
                max_size=20,
            ),
            values=st.sampled_from(["string", "array"]),
            min_size=1,
            max_size=6,
        )
    )


@st.composite
def primitive_value(draw):
    """Generate a primitive value: int, float, bool, or None.

    Used to test graceful fallback behavior when columns contain
    unexpected non-dict, non-list, non-string values.
    """
    return draw(
        st.one_of(
            st.integers(min_value=-10000, max_value=10000),
            st.floats(allow_nan=False, allow_infinity=False, min_value=-1e6, max_value=1e6),
            st.booleans(),
            st.none(),
        )
    )
