"""Unit tests for BL123 native ML Lineage edge helpers in mlcc_mlflow.

**Validates: BL123 Requirements 6.1, 6.2, 6.3** (dataset→model + base→derivative
lineage edges, non-fatal + idempotent).

All offline: the SageMaker client and MLflow run state are mocked, so behavior —
not any live account/lineage state — is asserted.
"""
import os
import sys
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Path setup — import the helper from templates/do/lib/python
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PYTHON = os.path.join(REPO_ROOT, "templates", "do", "lib", "python")
if LIB_PYTHON not in sys.path:
    sys.path.insert(0, LIB_PYTHON)

import mlcc_mlflow  # noqa: E402


# ── dataset→model edge: log_training_dataset_lineage (Req 6.1) ─────────────────

class TestLogTrainingDatasetLineage:
    def test_no_uri_returns_false(self):
        assert mlcc_mlflow.log_training_dataset_lineage(
            dataset_s3_uri="", dataset_name="d") is False

    def test_no_active_run_returns_false(self):
        fake_mlflow = MagicMock()
        fake_mlflow.active_run.return_value = None
        with patch.dict(sys.modules, {"mlflow": fake_mlflow}):
            result = mlcc_mlflow.log_training_dataset_lineage(
                dataset_s3_uri="s3://b/datasets/calib/", dataset_name="calib")
        assert result is False

    def test_active_run_logs_dataset_input(self):
        fake_mlflow = MagicMock()
        fake_mlflow.active_run.return_value = object()  # a run exists
        with patch.dict(sys.modules, {"mlflow": fake_mlflow}), \
             patch.object(mlcc_mlflow, "log_dataset") as log_ds:
            result = mlcc_mlflow.log_training_dataset_lineage(
                dataset_s3_uri="s3://b/datasets/calib/",
                dataset_name="calib", context="training")
        assert result is True
        log_ds.assert_called_once()
        _, kwargs = log_ds.call_args
        assert kwargs["source"] == "s3://b/datasets/calib/"
        assert kwargs["name"] == "calib"
        assert kwargs["context"] == "training"

    def test_logging_error_is_non_fatal(self):
        fake_mlflow = MagicMock()
        fake_mlflow.active_run.return_value = object()
        with patch.dict(sys.modules, {"mlflow": fake_mlflow}), \
             patch.object(mlcc_mlflow, "log_dataset",
                          side_effect=RuntimeError("boom")):
            result = mlcc_mlflow.log_training_dataset_lineage(
                dataset_s3_uri="s3://b/datasets/calib/", dataset_name="calib")
        assert result is False


# ── base→derivative edge: add_derived_from_edge (Req 6.2, 6.3) ─────────────────

def _artifact_resp(arn):
    return {"ArtifactSummaries": [{"ArtifactArn": arn}]}


class TestAddDerivedFromEdge:
    def test_missing_uris_return_false(self):
        assert mlcc_mlflow.add_derived_from_edge(
            base_source_uri="", derivative_source_uri="x", sm_client=MagicMock()
        ) is False

    def test_resolves_artifacts_and_adds_association(self):
        sm = MagicMock()
        sm.list_artifacts.side_effect = [
            _artifact_resp("arn:artifact:base"),
            _artifact_resp("arn:artifact:deriv"),
        ]
        result = mlcc_mlflow.add_derived_from_edge(
            base_source_uri="arn:mpg:base",
            derivative_source_uri="arn:mpg:deriv",
            sm_client=sm,
        )
        assert result is True
        sm.add_association.assert_called_once_with(
            SourceArn="arn:artifact:base",
            DestinationArn="arn:artifact:deriv",
            AssociationType="DerivedFrom",
        )

    def test_missing_artifact_skips_non_fatal(self):
        sm = MagicMock()
        # Base resolves, derivative does not (async artifact not materialized yet).
        sm.list_artifacts.side_effect = [
            _artifact_resp("arn:artifact:base"),
            {"ArtifactSummaries": []},
        ]
        result = mlcc_mlflow.add_derived_from_edge(
            base_source_uri="arn:mpg:base",
            derivative_source_uri="arn:mpg:deriv",
            sm_client=sm,
        )
        assert result is False
        sm.add_association.assert_not_called()

    def test_already_exists_is_idempotent_success(self):
        sm = MagicMock()
        sm.list_artifacts.side_effect = [
            _artifact_resp("arn:artifact:base"),
            _artifact_resp("arn:artifact:deriv"),
        ]
        sm.add_association.side_effect = Exception(
            "Association already exists between these artifacts")
        result = mlcc_mlflow.add_derived_from_edge(
            base_source_uri="arn:mpg:base",
            derivative_source_uri="arn:mpg:deriv",
            sm_client=sm,
        )
        assert result is True

    def test_iam_error_is_non_fatal(self):
        sm = MagicMock()
        sm.list_artifacts.side_effect = [
            _artifact_resp("arn:artifact:base"),
            _artifact_resp("arn:artifact:deriv"),
        ]
        sm.add_association.side_effect = Exception("AccessDeniedException")
        result = mlcc_mlflow.add_derived_from_edge(
            base_source_uri="arn:mpg:base",
            derivative_source_uri="arn:mpg:deriv",
            sm_client=sm,
        )
        assert result is False


class TestResolveLineageArtifactArn:
    def test_returns_first_arn(self):
        sm = MagicMock()
        sm.list_artifacts.return_value = _artifact_resp("arn:artifact:x")
        assert mlcc_mlflow._resolve_lineage_artifact_arn(sm, "arn:src") == "arn:artifact:x"

    def test_none_when_empty(self):
        sm = MagicMock()
        sm.list_artifacts.return_value = {"ArtifactSummaries": []}
        assert mlcc_mlflow._resolve_lineage_artifact_arn(sm, "arn:src") is None

    def test_none_when_lookup_raises(self):
        sm = MagicMock()
        sm.list_artifacts.side_effect = Exception("boom")
        assert mlcc_mlflow._resolve_lineage_artifact_arn(sm, "arn:src") is None
