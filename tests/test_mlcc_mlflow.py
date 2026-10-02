"""Unit / example tests for the MLflow model-family foundation helper.

**Validates: Requirements 7.1, 7.2, 7.3**

Covers the exact cases Requirement 7 enumerates:
- sanitize_name for slash-only, space-only, and combined slash-and-space inputs
- family_tags (three keys present with expected values)
- search_family (mocked client returns a mix; only in-family models come back)
"""
import os
import sys
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Path setup — import the helper from templates/do/lib/python
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

from mlcc_mlflow import (  # noqa: E402
    TAG_FAMILY,
    TAG_ARTIFACT_TYPE,
    TAG_MANAGED_BY,
    MANAGED_BY_VALUE,
    PARAM_BASE_MODEL_ID,
    PARAM_ADAPTER_TYPE,
    PARAM_TRAINING_TECHNIQUE,
    sanitize_name,
    family_tags,
    family_params,
    search_family,
    register,
)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class _FakeLoggedModel:
    """Minimal LoggedModel stand-in carrying dict-shaped tags."""

    def __init__(self, family):
        self.tags = {TAG_FAMILY: family, TAG_MANAGED_BY: MANAGED_BY_VALUE}


class _FakePage(list):
    """A list subclass with a .token attribute, like MLflow's PagedList."""

    def __init__(self, items, token=None):
        super().__init__(items)
        self.token = token


# ---------------------------------------------------------------------------
# sanitize_name (Req 7.1)
# ---------------------------------------------------------------------------

class TestSanitizeName:
    """**Validates: Requirements 7.1**"""

    def test_slash_only_input(self):
        # Slashes become the double-dash delimiter (issue #8801 guard).
        assert sanitize_name("a/b/c") == "a--b--c"

    def test_space_only_input(self):
        # Spaces are removed everywhere, not merely trimmed.
        assert sanitize_name("a b c") == "abc"

    def test_combined_slash_and_space_input(self):
        assert sanitize_name("meta-llama/Llama 3.1") == "meta-llama--Llama3.1"

    def test_output_never_contains_slash_or_space(self):
        for s in ["a/b/c", "a b c", "meta-llama/Llama 3.1", "x / y / z"]:
            out = sanitize_name(s)
            assert "/" not in out
            assert " " not in out

    def test_idempotent(self):
        s = "meta-llama/Llama 3.1"
        assert sanitize_name(sanitize_name(s)) == sanitize_name(s)

    def test_empty_string(self):
        assert sanitize_name("") == ""

    def test_non_string_raises_type_error(self):
        with pytest.raises(TypeError):
            sanitize_name(None)


# ---------------------------------------------------------------------------
# family_tags (Req 7.2)
# ---------------------------------------------------------------------------

class TestFamilyTags:
    """**Validates: Requirements 7.2**"""

    def test_contains_the_three_family_keys(self):
        tags = family_tags("meta-llama/Llama-3.1-8B", "adapter")
        assert TAG_FAMILY in tags
        assert TAG_ARTIFACT_TYPE in tags
        assert TAG_MANAGED_BY in tags

    def test_expected_values(self):
        tags = family_tags("meta-llama/Llama-3.1-8B", "adapter")
        assert tags[TAG_FAMILY] == "meta-llama/Llama-3.1-8B"
        assert tags[TAG_ARTIFACT_TYPE] == "adapter"
        assert tags[TAG_MANAGED_BY] == MANAGED_BY_VALUE


# ---------------------------------------------------------------------------
# family_params (supporting coverage for Req 4)
# ---------------------------------------------------------------------------

class TestFamilyParams:
    def test_always_includes_base_model_id(self):
        params = family_params("base-x")
        assert params[PARAM_BASE_MODEL_ID] == "base-x"

    def test_includes_optional_keys_when_supplied(self):
        params = family_params(
            "base-x", adapter_type="lora", training_technique="sft"
        )
        assert params[PARAM_ADAPTER_TYPE] == "lora"
        assert params[PARAM_TRAINING_TECHNIQUE] == "sft"

    def test_omits_optional_keys_when_absent_or_none(self):
        params = family_params("base-x", adapter_type=None)
        assert PARAM_ADAPTER_TYPE not in params
        assert set(params.keys()) == {PARAM_BASE_MODEL_ID}

    def test_ignores_unrecognized_kwargs(self):
        params = family_params("base-x", not_a_real_key="whatever")
        assert set(params.keys()) == {PARAM_BASE_MODEL_ID}


# ---------------------------------------------------------------------------
# search_family (Req 7.3)
# ---------------------------------------------------------------------------

class TestSearchFamily:
    """**Validates: Requirements 7.3**"""

    def test_returns_only_in_family_models(self):
        base = "meta-llama/Llama-3.1-8B"
        in_family = [_FakeLoggedModel(base), _FakeLoggedModel(base)]
        out_of_family = [_FakeLoggedModel("other/model")]
        served = in_family + out_of_family

        client = MagicMock()
        client.search_logged_models.return_value = _FakePage(served, token=None)

        result = search_family(base, client=client, experiment_ids=["0"])

        assert len(result) == 2
        assert all(m.tags[TAG_FAMILY] == base for m in result)

    def test_filter_targets_mlcc_family_tag(self):
        base = "meta-llama/Llama-3.1-8B"
        client = MagicMock()
        client.search_logged_models.return_value = _FakePage([], token=None)

        search_family(base, client=client, experiment_ids=["0"])

        _, kwargs = client.search_logged_models.call_args
        assert "mlcc.family" in kwargs["filter_string"]
        assert base in kwargs["filter_string"]

    def test_exhausts_pagination(self):
        base = "b"
        page1 = _FakePage([_FakeLoggedModel(base)], token="next")
        page2 = _FakePage([_FakeLoggedModel(base)], token=None)
        client = MagicMock()
        client.search_logged_models.side_effect = [page1, page2]

        result = search_family(base, client=client, experiment_ids=["0"])

        assert len(result) == 2
        assert client.search_logged_models.call_count == 2

    def test_empty_family_returns_empty_list(self):
        client = MagicMock()
        client.search_logged_models.return_value = _FakePage([], token=None)
        assert search_family("no-such-family", client=client) == []


# ---------------------------------------------------------------------------
# register (supporting coverage for Req 6)
# ---------------------------------------------------------------------------

class TestRegister:
    def test_registers_sanitized_name(self):
        client = MagicMock()
        version = MagicMock()
        version.version = "1"
        client.create_model_version.return_value = version

        register("s3://bucket/model", "meta-llama/Llama 3.1", client=client)

        _, kwargs = client.create_model_version.call_args
        assert kwargs["name"] == "meta-llama--Llama3.1"

    def test_attaches_params_as_version_tags_and_aliases(self):
        client = MagicMock()
        version = MagicMock()
        version.version = "3"
        client.create_model_version.return_value = version

        register(
            "s3://bucket/model",
            "base/model",
            params={PARAM_ADAPTER_TYPE: "lora"},
            aliases=["champion"],
            client=client,
        )

        client.set_model_version_tag.assert_called_once_with(
            "base--model", "3", PARAM_ADAPTER_TYPE, "lora"
        )
        client.set_registered_model_alias.assert_called_once_with(
            "base--model", "champion", "3"
        )
