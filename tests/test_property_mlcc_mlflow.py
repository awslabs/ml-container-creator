"""Property-based tests for the MLflow model-family foundation helper.

**Validates: Requirements 2.1, 2.2, 2.3, 3.1, 4.1, 4.2, 5.1, 6.1, 8.2, 8.3, 8.4**

One Hypothesis test per Correctness Property from the design (Properties 1-11).
The pure helpers are tested over generated strings; the MLflow-touching helpers
are exercised against a mocked/injected client so runs stay cheap and
deterministic.
"""
import os
import sys
from unittest.mock import MagicMock

from hypothesis import given, settings
from hypothesis import strategies as st

# ---------------------------------------------------------------------------
# Path setup
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
    PARAM_BASE_MODEL_RUN_ID,
    PARAM_ADAPTER_TYPE,
    PARAM_TRAINING_TECHNIQUE,
    PARAM_DRAFT_ALGORITHM,
    sanitize_name,
    family_tags,
    family_params,
    search_family,
    register,
)

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

st_text = st.text(max_size=64)
# Strings without spaces (for Property 3, slash-behavior isolation)
st_no_space = st.text(alphabet=st.characters(blacklist_characters=" "), max_size=64)
# Strings without slashes (for Property 4, space-behavior isolation)
st_no_slash = st.text(alphabet=st.characters(blacklist_characters="/"), max_size=64)

_RECOGNIZED_KWARGS = {
    "base_model_run_id": PARAM_BASE_MODEL_RUN_ID,
    "adapter_type": PARAM_ADAPTER_TYPE,
    "training_technique": PARAM_TRAINING_TECHNIQUE,
    "draft_algorithm": PARAM_DRAFT_ALGORITHM,
}


class _FakeLoggedModel:
    def __init__(self, family):
        self.tags = {TAG_FAMILY: family}


class _FakePage(list):
    def __init__(self, items, token=None):
        super().__init__(items)
        self.token = token


# ---------------------------------------------------------------------------
# sanitize_name properties (1-4)
# ---------------------------------------------------------------------------

# Feature: v18-w1-04-bl-fam-01-02, Property 1: sanitize_name is idempotent
@given(s=st_text)
@settings(max_examples=200)
def test_property_1_sanitize_name_idempotent(s):
    assert sanitize_name(sanitize_name(s)) == sanitize_name(s)


# Feature: v18-w1-04-bl-fam-01-02, Property 2: sanitize_name output is registry-safe
@given(s=st_text)
@settings(max_examples=200)
def test_property_2_sanitize_name_registry_safe(s):
    out = sanitize_name(s)
    assert "/" not in out
    assert " " not in out


# Feature: v18-w1-04-bl-fam-01-02, Property 3: sanitize_name replaces slashes with --
@given(s=st_no_space)
@settings(max_examples=200)
def test_property_3_sanitize_name_replaces_slashes(s):
    assert sanitize_name(s) == s.replace("/", "--")


# Feature: v18-w1-04-bl-fam-01-02, Property 4: sanitize_name strips spaces
@given(s=st_no_slash)
@settings(max_examples=200)
def test_property_4_sanitize_name_strips_spaces(s):
    assert sanitize_name(s) == s.replace(" ", "")


# ---------------------------------------------------------------------------
# family_tags / family_params properties (5-7)
# ---------------------------------------------------------------------------

# Feature: v18-w1-04-bl-fam-01-02, Property 5: family_tags always carries the family keys
@given(base_id=st_text, artifact_type=st_text)
@settings(max_examples=200)
def test_property_5_family_tags_carries_family_keys(base_id, artifact_type):
    tags = family_tags(base_id, artifact_type)
    assert tags[TAG_FAMILY] == base_id
    assert TAG_ARTIFACT_TYPE in tags
    assert tags[TAG_MANAGED_BY] == MANAGED_BY_VALUE


# Feature: v18-w1-04-bl-fam-01-02, Property 6: family_params always carries the base model id
@given(
    base_id=st_text,
    extra=st.dictionaries(st.sampled_from(list(_RECOGNIZED_KWARGS)), st.text(max_size=16)),
)
@settings(max_examples=200)
def test_property_6_family_params_carries_base_model_id(base_id, extra):
    params = family_params(base_id, **extra)
    assert params[PARAM_BASE_MODEL_ID] == base_id


# Feature: v18-w1-04-bl-fam-01-02, Property 7: family_params includes an optional key exactly when its kwarg is supplied
@given(
    base_id=st_text,
    supplied=st.sets(st.sampled_from(list(_RECOGNIZED_KWARGS))),
)
@settings(max_examples=200)
def test_property_7_family_params_optional_keys(base_id, supplied):
    kwargs = {name: "v-" + name for name in supplied}
    params = family_params(base_id, **kwargs)
    for name, key in _RECOGNIZED_KWARGS.items():
        if name in supplied:
            assert params[key] == "v-" + name
        else:
            assert key not in params


# ---------------------------------------------------------------------------
# search_family property (8)
# ---------------------------------------------------------------------------

# Feature: v18-w1-04-bl-fam-01-02, Property 8: search_family returns only in-family models
@given(
    base_id=st.text(min_size=1, max_size=16),
    families=st.lists(st.text(min_size=1, max_size=16), max_size=20),
)
@settings(max_examples=200)
def test_property_8_search_family_only_in_family(base_id, families):
    served = [_FakeLoggedModel(f) for f in families]
    client = MagicMock()
    # The fake store returns ALL served models regardless of filter; the module
    # must enforce the in-family invariant itself.
    client.search_logged_models.return_value = _FakePage(served, token=None)

    result = search_family(base_id, client=client, experiment_ids=["0"])

    expected_count = sum(1 for f in families if f == base_id)
    assert len(result) == expected_count
    assert all(m.tags[TAG_FAMILY] == base_id for m in result)


# ---------------------------------------------------------------------------
# register property (9)
# ---------------------------------------------------------------------------

# Feature: v18-w1-04-bl-fam-01-02, Property 9: register always registers a sanitized name
@given(model_uri=st.text(max_size=32), name=st_text)
@settings(max_examples=200)
def test_property_9_register_sanitizes_name(model_uri, name):
    client = MagicMock()
    version = MagicMock()
    version.version = "1"
    client.create_model_version.return_value = version

    register(model_uri, name, client=client)

    _, kwargs = client.create_model_version.call_args
    submitted = kwargs["name"]
    assert submitted == sanitize_name(name)
    assert "/" not in submitted
    assert " " not in submitted


# ---------------------------------------------------------------------------
# log_dataset properties (10-11) — exercised against a fake active run
# ---------------------------------------------------------------------------

class _FakeDataset:
    def __init__(self, name, digest):
        self.name = name
        self.digest = digest


class _FakeDatasetInput:
    def __init__(self, dataset):
        self.dataset = dataset


class _FakeInputs:
    def __init__(self, dataset_inputs):
        self.dataset_inputs = dataset_inputs


class _FakeRun:
    """Fake MLflow run whose inputs grow when log_input records a dataset."""

    def __init__(self):
        self.info = MagicMock()
        self.info.run_id = "run-1"
        self.inputs = _FakeInputs([])


from contextlib import contextmanager
from unittest import mock


@contextmanager
def _fake_mlflow_for_log_dataset(run):
    """Install a fake mlflow module + MetaDataset so log_dataset runs offline.

    A context manager (not a fixture) so it re-applies for every Hypothesis
    example without tripping the function-scoped-fixture health check.
    """
    logged = run.inputs.dataset_inputs

    class _FakeMetaDataset:
        def __init__(self, source, name, digest, schema=None):
            self.source = source
            self.name = name
            self.digest = digest

    def _log_input(dataset, context=None, tags=None, model=None):
        logged.append(_FakeDatasetInput(_FakeDataset(dataset.name, dataset.digest)))

    fake_mlflow = MagicMock()
    fake_mlflow.active_run.return_value = run
    fake_mlflow.log_input.side_effect = _log_input

    fake_meta_module = MagicMock()
    fake_meta_module.MetaDataset = _FakeMetaDataset

    # _make_uri_source imports the real DatasetSource base; provide a stand-in so
    # log_dataset builds its source without the real mlflow package present.
    class _FakeDatasetSource:
        pass

    fake_source_module = MagicMock()
    fake_source_module.DatasetSource = _FakeDatasetSource

    patched = {
        "mlflow": fake_mlflow,
        "mlflow.data": MagicMock(),
        "mlflow.data.meta_dataset": fake_meta_module,
        "mlflow.data.dataset_source": fake_source_module,
    }
    with mock.patch.dict(sys.modules, patched):
        # Injected client used by the idempotence check to read run inputs.
        client = MagicMock()
        client.get_run.return_value = run
        yield client


# Feature: v18-w1-04-bl-fam-01-02, Property 10: log_dataset records a sanitized name
@given(source=st.text(max_size=32), name=st_text, context=st.text(max_size=16))
@settings(max_examples=100)
def test_property_10_log_dataset_sanitizes_name(source, name, context):
    from mlcc_mlflow import log_dataset

    run = _FakeRun()
    with _fake_mlflow_for_log_dataset(run) as client:
        recorded_name, _digest = log_dataset(source, name, context, client=client)

    assert recorded_name == sanitize_name(name)
    assert run.inputs.dataset_inputs[0].dataset.name == sanitize_name(name)


# Feature: v18-w1-04-bl-fam-01-02, Property 11: log_dataset is idempotent by (name, digest)
@given(source=st.text(max_size=32), name=st_text, context=st.text(max_size=16))
@settings(max_examples=100)
def test_property_11_log_dataset_idempotent(source, name, context):
    from mlcc_mlflow import log_dataset

    run = _FakeRun()
    with _fake_mlflow_for_log_dataset(run) as client:
        log_dataset(source, name, context, client=client)
        inputs_after_first = list(run.inputs.dataset_inputs)
        log_dataset(source, name, context, client=client)
        inputs_after_second = list(run.inputs.dataset_inputs)

    assert len(inputs_after_second) == len(inputs_after_first)
