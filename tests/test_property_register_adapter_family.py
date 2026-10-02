"""Property-based tests for BL056 — adapters as family sub-models.

**Validates: Requirements 1.1, 2.1, 2.2, 2.3, 2.4, 4.1, 5.1**

One Hypothesis test per Correctness Property (Properties 1-5) from the design.
BL056's own logic is pure at the seams that matter — adapter name construction,
tag/param composition, the MPG metadata dict build, and the --list grouping
transform — so those are the PBT targets. The MLflow/SageMaker interactions
themselves are exercised with mocked clients in the unit/integration tests.
"""
import os
import sys
import types
from unittest import mock
from unittest.mock import MagicMock

from hypothesis import given, settings
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

import mlcc_mlflow  # noqa: E402
import register_model  # noqa: E402
import register_list  # noqa: E402
from mlcc_mlflow import (  # noqa: E402
    TAG_FAMILY,
    TAG_ARTIFACT_TYPE,
    PARAM_BASE_MODEL_ID,
    PARAM_BASE_MODEL_RUN_ID,
    PARAM_ADAPTER_TYPE,
    sanitize_name,
)

st_text = st.text(max_size=48)


class _LoggedModel:
    def __init__(self, family, artifact_type="adapter", name=""):
        self.tags = {TAG_FAMILY: family, TAG_ARTIFACT_TYPE: artifact_type}
        self.params = {}
        self.name = name


def _capture_register():
    """Return (register_fn, captured) where register_fn records its kwargs."""
    captured = {}
    version = MagicMock()

    def _register(**kwargs):
        captured.update(kwargs)
        version.name = sanitize_name(kwargs["name"])
        return version

    return _register, captured


# Feature: v18-w2-04-bl056, Property 1: Adapter is registered under the family sub-model name
@given(base_id=st_text, name=st_text)
@settings(max_examples=100)
def test_property_1_adapter_family_submodel_name(base_id, name):
    register_fn, captured = _capture_register()
    with mock.patch.object(mlcc_mlflow, "register", register_fn):
        register_model._register_adapter_in_mlflow(
            base_id=base_id,
            adapter_name=name,
            model_uri="s3://b/",
            source_run_id="run",
            adapter_type="lora",
        )
    submitted = captured["name"]
    assert submitted == f"{base_id}__adapter__{name}"
    effective = sanitize_name(submitted)
    assert "/" not in effective
    assert " " not in effective


# Feature: v18-w2-04-bl056, Property 2: Adapter tags carry family membership
@given(base_id=st_text)
@settings(max_examples=100)
def test_property_2_adapter_tags_carry_family(base_id):
    register_fn, captured = _capture_register()
    with mock.patch.object(mlcc_mlflow, "register", register_fn):
        register_model._register_adapter_in_mlflow(
            base_id=base_id,
            adapter_name="a",
            model_uri="s3://b/",
            source_run_id="run",
            adapter_type="lora",
        )
    tags = captured["tags"]
    assert tags[TAG_FAMILY] == base_id
    assert tags[TAG_ARTIFACT_TYPE] == "adapter"


# Feature: v18-w2-04-bl056, Property 3: Adapter params carry base run id and adapter type
@given(base_id=st_text, source_run_id=st.text(min_size=1, max_size=32),
       adapter_type=st.text(min_size=1, max_size=32))
@settings(max_examples=100)
def test_property_3_adapter_params_carry_lineage(base_id, source_run_id, adapter_type):
    register_fn, captured = _capture_register()
    with mock.patch.object(mlcc_mlflow, "register", register_fn):
        register_model._register_adapter_in_mlflow(
            base_id=base_id,
            adapter_name="a",
            model_uri="s3://b/",
            source_run_id=source_run_id,
            adapter_type=adapter_type,
        )
    params = captured["params"]
    assert params[PARAM_BASE_MODEL_RUN_ID] == source_run_id
    assert params[PARAM_ADAPTER_TYPE] == adapter_type
    assert params[PARAM_BASE_MODEL_ID] == base_id


# Feature: v18-w2-04-bl056, Property 4: MPG metadata mirrors the family linkage
@given(
    base_id=st_text,
    tune_technique=st_text,
    dataset_s3_uri=st_text,
    parent_arn=st.text(min_size=1, max_size=48),
)
@settings(max_examples=100)
def test_property_4_mpg_metadata_mirrors_family(base_id, tune_technique,
                                                dataset_s3_uri, parent_arn):
    args = types.SimpleNamespace(
        base_id=base_id,
        deployment_config="c", architecture="a", backend="b",
        instance_type="i", model_name="m", base_image="", model_format="f",
        generator_version="g", project_name="p",
        parent_version_arn=parent_arn,
        tune_technique=tune_technique,
        dataset_s3_uri=dataset_s3_uri,
        dataset_version="",
    )
    props = register_model._build_adapter_metadata(args)
    assert props["mlcc.family"] == base_id
    assert props["mlcc.base_model_id"] == base_id
    # Existing adapter keys preserved.
    assert props["isAdapter"] == "true"
    assert props["parentModelVersionArn"] == parent_arn
    assert props["tuneTechnique"] == tune_technique
    assert props["datasetS3Uri"] == dataset_s3_uri


# Feature: v18-w2-04-bl056, Property 5: --list groups every adapter under its own family when grouping is enabled
@given(families=st.lists(st.text(min_size=1, max_size=12), min_size=0, max_size=15))
@settings(max_examples=100)
def test_property_5_grouping_places_each_adapter_under_its_family(families):
    # One adapter LoggedModel per family value; a stub search_family returns,
    # for each base_id, exactly the adapters whose mlcc.family equals it
    # (mirroring search_family's in-family guarantee).
    all_models = [
        _LoggedModel(f, artifact_type="adapter", name=f"{f}__adapter__{i}")
        for i, f in enumerate(families)
    ]
    base_ids = list(dict.fromkeys(families))  # unique, order-preserving

    def _search(base_id, client=None):
        return [m for m in all_models if m.tags[TAG_FAMILY] == base_id]

    with mock.patch.object(mlcc_mlflow, "search_family", side_effect=_search):
        result = register_list._list_adapters(base_ids, group_by_family=True)

    grouped = {f["base_id"]: f["adapters"] for f in result["families"]}

    # Each adapter is placed under exactly its own family.
    for base_id, entries in grouped.items():
        for entry in entries:
            assert entry["name"].startswith(f"{base_id}__adapter__")

    # No adapter dropped, duplicated, or placed under a foreign family: the
    # union of grouped adapters equals the input set of adapter names.
    grouped_names = sorted(
        e["name"] for entries in grouped.values() for e in entries
    )
    input_names = sorted(m.name for m in all_models)
    assert grouped_names == input_names
