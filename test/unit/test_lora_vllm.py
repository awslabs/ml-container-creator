"""Unit tests for templates/do/lib/python/lora_vllm.py.

Tests cover: load success, load 409 conflict, unload success, unload 404,
list filtered results, list on empty, network error handling, and the s3:// refusal guard (Wave 6.1 R1.5).
"""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add the module path so we can import lora_vllm
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "templates" / "do" / "lib" / "python"))

import lora_vllm  # noqa: E402


BASE_URL = "http://localhost:8080"


class TestLoadLora:
    """Tests for load_lora()."""

    @patch("lora_vllm.requests.post")
    def test_load_success(self, mock_post):
        """Load returns success=True on HTTP 200."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        result = lora_vllm.load_lora(BASE_URL, "my-adapter", "/opt/ml/model/.mlcc-adapters/p/a")

        assert result == {"success": True}
        mock_post.assert_called_once_with(
            "http://localhost:8080/v1/load_lora_adapter",
            json={"lora_name": "my-adapter", "lora_path": "/opt/ml/model/.mlcc-adapters/p/a"},
            timeout=60,
        )

    @patch("lora_vllm.requests.post")
    def test_load_conflict_409(self, mock_post):
        """Load returns success=False with status 409 when adapter already exists."""
        mock_resp = MagicMock()
        mock_resp.status_code = 409
        mock_resp.text = "Adapter already loaded"
        mock_resp.json.return_value = {"message": "Adapter already loaded"}
        mock_post.return_value = mock_resp

        result = lora_vllm.load_lora(BASE_URL, "my-adapter", "/opt/ml/model/.mlcc-adapters/p/a")

        assert result["success"] is False
        assert result["status_code"] == 409
        assert "already loaded" in result["error"].lower()

    @patch("lora_vllm.requests.post")
    def test_load_network_error(self, mock_post):
        """Load handles network errors gracefully."""
        mock_post.side_effect = lora_vllm.requests.exceptions.ConnectionError(
            "Connection refused"
        )

        result = lora_vllm.load_lora(BASE_URL, "my-adapter", "/opt/ml/model/.mlcc-adapters/p/a")

        assert result["success"] is False
        assert result["status_code"] == 0
        assert "Connection refused" in result["error"]

    @patch("lora_vllm.requests.post")
    def test_load_s3_uri_refused_before_any_engine_call(self, mock_post):
        """Wave 6.1 R1.5: an s3:// lora_path is refused (vLLM would treat it as an
        HF repo id) and vLLM is never called. Supersedes the old passthrough test."""
        s3_uri = "s3://my-training-bucket/adapters/ectsum/epoch-3/"
        result = lora_vllm.load_lora(BASE_URL, "ectsum", s3_uri)

        assert result["success"] is False
        assert "s3://" in result["error"] and "LOCAL path" in result["error"]
        mock_post.assert_not_called()

    @patch("lora_vllm.requests.post")
    def test_load_local_path_passthrough(self, mock_post):
        """A local (mounted) path is passed as lora_path unchanged."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        local = "/opt/ml/model/.mlcc-adapters/proj/ectsum"
        lora_vllm.load_lora(BASE_URL, "ectsum", local)

        call_payload = mock_post.call_args[1]["json"]
        assert call_payload["lora_path"] == local

    @patch("lora_vllm.requests.post")
    def test_load_server_error_500(self, mock_post):
        """Load returns failure on HTTP 500."""
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal server error"
        mock_resp.json.side_effect = ValueError("not json")
        mock_post.return_value = mock_resp

        result = lora_vllm.load_lora(BASE_URL, "my-adapter", "/opt/ml/model/.mlcc-adapters/p/a")

        assert result["success"] is False
        assert result["status_code"] == 500


class TestUnloadLora:
    """Tests for unload_lora()."""

    @patch("lora_vllm.requests.post")
    def test_unload_success(self, mock_post):
        """Unload returns success=True on HTTP 200."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        result = lora_vllm.unload_lora(BASE_URL, "my-adapter")

        assert result == {"success": True}
        mock_post.assert_called_once_with(
            "http://localhost:8080/v1/unload_lora_adapter",
            json={"lora_name": "my-adapter"},
            timeout=30,
        )

    @patch("lora_vllm.requests.post")
    def test_unload_not_found_404(self, mock_post):
        """Unload returns failure on HTTP 404 (adapter not loaded)."""
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_resp.text = "Adapter not found"
        mock_resp.json.return_value = {"message": "Adapter not found"}
        mock_post.return_value = mock_resp

        result = lora_vllm.unload_lora(BASE_URL, "nonexistent")

        assert result["success"] is False
        assert result["status_code"] == 404

    @patch("lora_vllm.requests.post")
    def test_unload_network_error(self, mock_post):
        """Unload handles network timeout errors."""
        mock_post.side_effect = lora_vllm.requests.exceptions.Timeout("timed out")

        result = lora_vllm.unload_lora(BASE_URL, "my-adapter")

        assert result["success"] is False
        assert result["status_code"] == 0
        assert "timed out" in result["error"]


class TestListLoras:
    """Tests for list_loras()."""

    @patch("lora_vllm.requests.get")
    def test_list_returns_filtered_results(self, mock_get):
        """List returns only LoRA adapters, filtering out the base model."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": [
                {"id": "meta-llama/Llama-3.1-8B", "object": "model", "root": "meta-llama/Llama-3.1-8B"},
                {"id": "ectsum", "object": "model", "root": "s3://bucket/ectsum/"},
                {"id": "code-review", "object": "model", "root": "s3://bucket/code-review/"},
            ]
        }
        mock_get.return_value = mock_resp

        result = lora_vllm.list_loras(BASE_URL)

        assert len(result) == 2
        assert result[0] == {"name": "ectsum", "path": "s3://bucket/ectsum/"}
        assert result[1] == {"name": "code-review", "path": "s3://bucket/code-review/"}

    @patch("lora_vllm.requests.get")
    def test_list_empty_when_no_adapters(self, mock_get):
        """List returns empty list when only base model is present."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": [
                {"id": "meta-llama/Llama-3.1-8B", "object": "model", "root": "meta-llama/Llama-3.1-8B"},
            ]
        }
        mock_get.return_value = mock_resp

        result = lora_vllm.list_loras(BASE_URL)

        assert result == []

    @patch("lora_vllm.requests.get")
    def test_list_empty_on_network_error(self, mock_get):
        """List returns empty list on connection error."""
        mock_get.side_effect = lora_vllm.requests.exceptions.ConnectionError(
            "Connection refused"
        )

        result = lora_vllm.list_loras(BASE_URL)

        assert result == []

    @patch("lora_vllm.requests.get")
    def test_list_empty_on_server_error(self, mock_get):
        """List returns empty list on non-200 response."""
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_get.return_value = mock_resp

        result = lora_vllm.list_loras(BASE_URL)

        assert result == []

    @patch("lora_vllm.requests.get")
    def test_list_uses_correct_url(self, mock_get):
        """List calls GET /v1/models."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"data": []}
        mock_get.return_value = mock_resp

        lora_vllm.list_loras("http://localhost:9090")

        mock_get.assert_called_once_with(
            "http://localhost:9090/v1/models",
            timeout=30,
        )


class TestCliMain:
    """Tests for CLI entry point."""

    @patch("lora_vllm.load_lora")
    def test_cli_load(self, mock_load):
        """CLI 'load' invokes load_lora with correct args."""
        mock_load.return_value = {"success": True}

        with patch.object(sys, "argv", ["lora_vllm.py", "load", "my-lora", "/opt/ml/model/x", "http://localhost:8080"]):
            with pytest.raises(SystemExit) as exc_info:
                lora_vllm._cli_main()
            assert exc_info.value.code == 0

        mock_load.assert_called_once_with("http://localhost:8080", "my-lora", "/opt/ml/model/x")

    @patch("lora_vllm.unload_lora")
    def test_cli_unload(self, mock_unload):
        """CLI 'unload' invokes unload_lora with correct args."""
        mock_unload.return_value = {"success": True}

        with patch.object(sys, "argv", ["lora_vllm.py", "unload", "my-lora", "http://localhost:8080"]):
            with pytest.raises(SystemExit) as exc_info:
                lora_vllm._cli_main()
            assert exc_info.value.code == 0

        mock_unload.assert_called_once_with("http://localhost:8080", "my-lora")

    @patch("lora_vllm.list_loras")
    def test_cli_list(self, mock_list):
        """CLI 'list' invokes list_loras with correct args."""
        mock_list.return_value = []

        with patch.object(sys, "argv", ["lora_vllm.py", "list", "http://localhost:8080"]):
            with pytest.raises(SystemExit) as exc_info:
                lora_vllm._cli_main()
            assert exc_info.value.code == 0

        mock_list.assert_called_once_with("http://localhost:8080")
