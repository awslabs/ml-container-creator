"""Unit / integration tests for BL056 — adapters as family sub-models.

**Validates: Requirements 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 3.1, 4.1, 5.1, 5.2, 5.3**

BL-FAM (mlcc_mlflow) already property-tests the *internal* correctness of
sanitize_name / family_tags / family_params / search_family / register. These
tests validate BL056's **composition** of them: the adapter name construction,
the MPG metadata mirror, the resolve-before-register ordering, the naming-failure
fallback, and the --list flat-default vs family-grouped views.
"""
import logging
import os
import sys
import types
from unittest import mock
from unittest.mock import MagicMock, call

import pytest

# ---------------------------------------------------------------------------
# Path setup — import the helpers from templates/do/lib/python
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
sys.path.insert(0, LIB_PYTHON)

import mlcc_mlflow  # noqa: E402
import register_model  # noqa: E402
import register_list  # noqa: E402
from register_model import (  # noqa: E402
    BaseRunNotFoundError,
    _build_adapter_metadata,
    _resolve_base_source_run_id,
    _register_adapter_in_mlflow,
)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

def _args(**overrides):
    """Build a minimal args namespace for adapter registration."""
    base = dict(
        project_name="proj",
        parent_version_arn="arn:aws:sagemaker:us-east-1:1:model-package/proj/1",
        base_id="meta-llama/Llama-3.1-8B",
        adapter_name="my-lora",
        tune_technique="lora",
        dataset_s3_uri="s3://b/ds/",
        dataset_version="",
        deployment_config="transformers-vllm",
        architecture="transformers",
        backend="vllm",
        instance_type="ml.g6.12xlarge",
        model_name="meta-llama/Llama-3.1-8B",
        base_image="",
        model_format="safetensors",
        generator_version="1.0",
        model_data_url="s3://bucket/adapter/",
        container_image="",
        region="us-east-1",
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


class _LoggedModel:
    """Minimal LoggedModel stand-in carrying tags, params, name, run id."""

    def __init__(self, family, artifact_type, name="", run_id=None,
                 adapter_type=None, base_model_run_id=None):
        self.tags = {
            mlcc_mlflow.TAG_FAMILY: family,
            mlcc_mlflow.TAG_ARTIFACT_TYPE: artifact_type,
        }
        self.params = {}
        if adapter_type is not None:
            self.params[mlcc_mlflow.PARAM_ADAPTER_TYPE] = adapter_type
        if base_model_run_id is not None:
            self.params[mlcc_mlflow.PARAM_BASE_MODEL_RUN_ID] = base_model_run_id
        self.name = name
        self.source_run_id = run_id


# ---------------------------------------------------------------------------
# _build_adapter_metadata — MPG mirror (Req 4)
# ---------------------------------------------------------------------------

class TestAdapterMetadataMirror:
    """**Validates: Requirements 4.1**"""

    def test_carries_both_family_keys(self):
        props = _build_adapter_metadata(_args())
        assert props["mlcc.family"] == "meta-llama/Llama-3.1-8B"
        assert props["mlcc.base_model_id"] == "meta-llama/Llama-3.1-8B"

    def test_preserves_existing_adapter_keys(self):
        props = _build_adapter_metadata(_args())
        assert props["isAdapter"] == "true"
        assert props["parentModelVersionArn"].startswith("arn:aws:sagemaker")
        assert props["tuneTechnique"] == "lora"
        assert props["datasetS3Uri"] == "s3://b/ds/"

    def test_empty_base_id_yields_empty_family_values(self):
        props = _build_adapter_metadata(_args(base_id=""))
        assert props["mlcc.family"] == ""
        assert props["mlcc.base_model_id"] == ""


# ---------------------------------------------------------------------------
# _resolve_base_source_run_id (Req 3)
# ---------------------------------------------------------------------------

class TestResolveBaseSourceRunId:
    """**Validates: Requirements 3.1**"""

    def test_returns_base_member_run_id(self):
        base = "meta-llama/Llama-3.1-8B"
        members = [
            _LoggedModel(base, "adapter", name="a1"),
            _LoggedModel(base, "base", name="b1", run_id="run-base-123"),
        ]
        with mock.patch.object(mlcc_mlflow, "search_family", return_value=members):
            run_id = _resolve_base_source_run_id(base)
        assert run_id == "run-base-123"

    def test_raises_when_no_base_member(self):
        base = "b"
        members = [_LoggedModel(base, "adapter", name="a1", run_id="r")]
        with mock.patch.object(mlcc_mlflow, "search_family", return_value=members):
            with pytest.raises(BaseRunNotFoundError):
                _resolve_base_source_run_id(base)

    def test_raises_when_family_empty(self):
        with mock.patch.object(mlcc_mlflow, "search_family", return_value=[]):
            with pytest.raises(BaseRunNotFoundError):
                _resolve_base_source_run_id("nope")


# ---------------------------------------------------------------------------
# _register_adapter_in_mlflow — name + tag/param composition (Reqs 1, 2)
# ---------------------------------------------------------------------------

class TestRegisterAdapterInMlflow:
    """**Validates: Requirements 1.1, 1.2, 2.1, 2.2, 2.3, 2.4**"""

    def test_submits_family_submodel_name(self):
        version = MagicMock()
        version.name = mlcc_mlflow.sanitize_name(
            "meta-llama/Llama-3.1-8B__adapter__my-lora"
        )
        with mock.patch.object(mlcc_mlflow, "register", return_value=version) as reg:
            intended, registered = _register_adapter_in_mlflow(
                base_id="meta-llama/Llama-3.1-8B",
                adapter_name="my-lora",
                model_uri="s3://bucket/adapter/",
                source_run_id="run-base-123",
                adapter_type="lora",
            )
        _, kwargs = reg.call_args
        assert kwargs["name"] == "meta-llama/Llama-3.1-8B__adapter__my-lora"
        assert intended == "meta-llama/Llama-3.1-8B__adapter__my-lora"
        # Effective registry name is slash/space free.
        assert "/" not in registered and " " not in registered

    def test_composes_family_tags_and_params(self):
        version = MagicMock()
        version.name = mlcc_mlflow.sanitize_name("base__adapter__a")
        with mock.patch.object(mlcc_mlflow, "register", return_value=version) as reg:
            _register_adapter_in_mlflow(
                base_id="base",
                adapter_name="a",
                model_uri="s3://b/",
                source_run_id="run-9",
                adapter_type="lora",
            )
        _, kwargs = reg.call_args
        tags = kwargs["tags"]
        params = kwargs["params"]
        assert tags[mlcc_mlflow.TAG_FAMILY] == "base"
        assert tags[mlcc_mlflow.TAG_ARTIFACT_TYPE] == "adapter"
        assert params[mlcc_mlflow.PARAM_BASE_MODEL_RUN_ID] == "run-9"
        assert params[mlcc_mlflow.PARAM_ADAPTER_TYPE] == "lora"
        assert params[mlcc_mlflow.PARAM_BASE_MODEL_ID] == "base"

    def test_naming_failure_fallback_logs_warning_and_succeeds(self, caplog):
        """Req 1.2: registry resolves a divergent name -> warn, do not fail."""
        version = MagicMock()
        version.name = "some-other-resolved-name"  # diverges from sanitized intent
        with mock.patch.object(mlcc_mlflow, "register", return_value=version):
            with caplog.at_level(logging.WARNING, logger="register_model"):
                intended, registered = _register_adapter_in_mlflow(
                    base_id="base",
                    adapter_name="a",
                    model_uri="s3://b/",
                    source_run_id="run-9",
                    adapter_type="lora",
                )
        assert registered == "some-other-resolved-name"
        assert any("naming/lineage violation" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Integration: resolve-before-register ordering (Req 3) + both systems fire
# ---------------------------------------------------------------------------

class TestRegisterAdapterOrdering:
    """**Validates: Requirements 1.1, 2.x, 3.1, 4.1**"""

    def _install_mocks(self, monkeypatch, search_members, sm_client):
        # Skip the sagemaker-core availability gate.
        monkeypatch.setattr(register_model, "_check_sagemaker_core", lambda: None)

        # Fake ModelPackageGroup + ModelPackage on a fake sagemaker.core.resources.
        fake_resources = types.ModuleType("sagemaker.core.resources")

        class _MPG:
            model_package_group_arn = "arn:mpg"

            @classmethod
            def create(cls, **kwargs):
                return cls()

            @classmethod
            def get(cls, **kwargs):
                return cls()

        class _MP:
            @classmethod
            def get_all(cls, **kwargs):
                return []  # no dedup match

        fake_resources.ModelPackageGroup = _MPG
        fake_resources.ModelPackage = _MP

        fake_sagemaker = types.ModuleType("sagemaker")
        fake_core = types.ModuleType("sagemaker.core")
        monkeypatch.setitem(sys.modules, "sagemaker", fake_sagemaker)
        monkeypatch.setitem(sys.modules, "sagemaker.core", fake_core)
        monkeypatch.setitem(sys.modules, "sagemaker.core.resources", fake_resources)

        # Fake boto3 whose sagemaker client is our recorder.
        fake_boto3 = types.ModuleType("boto3")
        fake_boto3.client = lambda *a, **k: sm_client
        monkeypatch.setitem(sys.modules, "boto3", fake_boto3)

        monkeypatch.setattr(
            mlcc_mlflow, "search_family", lambda base_id, client=None: search_members
        )

    def test_resolve_runs_before_register_and_run_id_propagates(self, monkeypatch):
        base = "meta-llama/Llama-3.1-8B"
        members = [_LoggedModel(base, "base", name="b1", run_id="run-base-777")]

        sm_client = MagicMock()
        sm_client.create_model_package.return_value = {
            "ModelPackageArn": "arn:aws:sagemaker:us-east-1:1:model-package/proj/2"
        }
        self._install_mocks(monkeypatch, members, sm_client)

        # Wire resolve + register onto a single parent to record call order.
        recorder = mock.Mock()
        real_resolve = register_model._resolve_base_source_run_id

        def _resolve(base_id, client=None):
            recorder("resolve")
            return real_resolve(base_id, client=client)

        version = MagicMock()
        version.name = mlcc_mlflow.sanitize_name(f"{base}__adapter__my-lora")
        captured = {}

        def _register(**kwargs):
            recorder("register")
            captured.update(kwargs)
            return version

        monkeypatch.setattr(register_model, "_resolve_base_source_run_id", _resolve)
        monkeypatch.setattr(mlcc_mlflow, "register", _register)

        with pytest.raises(SystemExit) as exc:  # _output calls sys.exit(0)
            register_model.cmd_register_adapter(_args())
        assert exc.value.code == 0

        # Ordering: resolve strictly before register.
        assert recorder.call_args_list == [call("resolve"), call("register")]
        # Value propagation: resolved run id lands in base_model_run_id.
        assert captured["params"][mlcc_mlflow.PARAM_BASE_MODEL_RUN_ID] == "run-base-777"
        # MPG mirror fired with both family keys.
        _, sm_kwargs = sm_client.create_model_package.call_args
        props = sm_kwargs["CustomerMetadataProperties"]
        assert props["mlcc.family"] == base
        assert props["mlcc.base_model_id"] == base

    def test_base_run_not_found_exits_before_register(self, monkeypatch):
        base = "b"
        members = [_LoggedModel(base, "adapter", name="a", run_id="r")]  # no base
        sm_client = MagicMock()
        self._install_mocks(monkeypatch, members, sm_client)

        register_called = mock.Mock()
        monkeypatch.setattr(
            mlcc_mlflow, "register",
            lambda **k: (register_called(), MagicMock())[1],
        )

        with pytest.raises(SystemExit) as exc:
            register_model.cmd_register_adapter(_args(base_id=base))
        assert exc.value.code == 1
        register_called.assert_not_called()
        sm_client.create_model_package.assert_not_called()


# ---------------------------------------------------------------------------
# --list — flat default vs family grouping (Req 5)
# ---------------------------------------------------------------------------

class TestListAdapterViews:
    """**Validates: Requirements 5.1, 5.2, 5.3**"""

    def test_flat_default_returns_flat_shape(self):
        base = "base-a"
        members = [
            _LoggedModel(base, "adapter", name="base-a__adapter__x",
                         adapter_type="lora", base_model_run_id="r1"),
        ]
        with mock.patch.object(mlcc_mlflow, "search_family", return_value=members):
            result = register_list._list_adapters([base], group_by_family=False)
        assert "adapters" in result and "families" not in result
        assert result["adapters"][0]["name"] == "base-a__adapter__x"
        assert result["adapters"][0]["adapter_type"] == "lora"
        assert result["adapters"][0]["base_model_run_id"] == "r1"

    def test_grouped_places_each_adapter_under_its_family(self):
        base_a = "base-a"
        base_b = "base-b"

        def _search(base_id, client=None):
            if base_id == base_a:
                return [
                    _LoggedModel(base_a, "adapter", name="base-a__adapter__x"),
                    _LoggedModel(base_a, "base", name="base-a"),  # excluded
                ]
            return [_LoggedModel(base_b, "adapter", name="base-b__adapter__y")]

        with mock.patch.object(mlcc_mlflow, "search_family", side_effect=_search):
            result = register_list._list_adapters(
                [base_a, base_b], group_by_family=True
            )

        assert "families" in result
        fams = {f["base_id"]: f["adapters"] for f in result["families"]}
        assert [a["name"] for a in fams[base_a]] == ["base-a__adapter__x"]
        assert [a["name"] for a in fams[base_b]] == ["base-b__adapter__y"]

    def test_resolve_base_ids_dedups_and_splits(self):
        args = types.SimpleNamespace(base_id=["a", "b"], base_ids="b,c")
        assert register_list._resolve_base_ids(args) == ["a", "b", "c"]
