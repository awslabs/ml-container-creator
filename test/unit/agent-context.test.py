# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Minimal unit tests for src/agent/context.py — edge cases not in property tests.

Complements the existing test/property/test_project_context.py (18 tests).
Focus on edge cases around export parsing patterns and unusual file states.
"""

from pathlib import Path

import pytest

from src.agent.context import ProjectContext


class TestExportParsingEdgeCases:
    """Edge cases in shell export parsing not covered by property tests."""

    def test_empty_quoted_value(self, tmp_path, monkeypatch):
        """export KEY="" produces empty string, not None."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text('export EMPTY_VAR=""\n')

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()
        assert result["do_config_vars"]["EMPTY_VAR"] == ""

    def test_single_quoted_value(self, tmp_path, monkeypatch):
        """export KEY='value' is parsed the same as double-quoted."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text("export SINGLE_Q='single-quoted-val'\n")

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()
        assert result["do_config_vars"]["SINGLE_Q"] == "single-quoted-val"

    def test_value_with_special_chars(self, tmp_path, monkeypatch):
        """Values containing paths and colons parse correctly."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text(
            'export IMAGE_URI="123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag"\n'
        )

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()
        assert (
            result["do_config_vars"]["IMAGE_URI"]
            == "123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag"
        )

    def test_multiple_ic_conf_files(self, tmp_path, monkeypatch):
        """Multiple .conf files in do/ic/ are all parsed and grouped by stem."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text('export PROJECT_NAME="test"\n')

        ic_dir = do_dir / "ic"
        ic_dir.mkdir()
        (ic_dir / "default.conf").write_text('export IC_ENV_A="val_a"\n')
        (ic_dir / "custom.conf").write_text('export IC_ENV_B="val_b"\n')

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()
        assert "default" in result["ic_env_vars"]
        assert "custom" in result["ic_env_vars"]
        assert result["ic_env_vars"]["default"]["IC_ENV_A"] == "val_a"
        assert result["ic_env_vars"]["custom"]["IC_ENV_B"] == "val_b"


class TestGracefulDegradation:
    """Verify context loads partially when files are unreadable."""

    def test_unreadable_dockerfile(self, tmp_path, monkeypatch):
        """Dockerfile that can't be read results in None base_image, no crash."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text('export PROJECT_NAME="test"\n')

        # Create a directory named "Dockerfile" (can't be read as file)
        (tmp_path / "Dockerfile").mkdir()

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()
        # Should not crash — Dockerfile check is is_file() so it will say missing
        assert result["base_image"] is None
        assert "Dockerfile" in result["_missing"]

    def test_yaml_with_non_dict_content(self, tmp_path, monkeypatch):
        """YAML that parses to a list (not dict) is treated as invalid."""
        monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
        do_dir = tmp_path / "do"
        do_dir.mkdir()
        (do_dir / "config").write_text('export PROJECT_NAME="test"\n')

        training_dir = do_dir / "training"
        training_dir.mkdir()
        (training_dir / "config.yaml").write_text("- item1\n- item2\n")

        ctx = ProjectContext(str(tmp_path))
        result = ctx.load()
        assert result["training_config"] is None
        assert any("config.yaml" in m for m in result["_missing"])
