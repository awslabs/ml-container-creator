# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for ExecutionConfig — confirmation policy and config loading."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.agent.execution_config import ExecutionConfig, load_execution_config


class TestDecideDefaultMode:
    """Tests for decide() in default mode."""

    def test_decide_default_confirm_class(self):
        """Confirm-class script returns 'confirm' in default mode."""
        config = ExecutionConfig()
        assert config.decide('do/deploy') == 'confirm'
        assert config.decide('do/stage') == 'confirm'
        assert config.decide('do/build') == 'confirm'
        assert config.decide('do/push') == 'confirm'
        assert config.decide('do/train') == 'confirm'

    def test_decide_default_auto_class(self):
        """Auto-class script returns 'auto' in default mode."""
        config = ExecutionConfig()
        assert config.decide('do/test') == 'auto'
        assert config.decide('do/status') == 'auto'
        assert config.decide('do/logs') == 'auto'
        assert config.decide('do/validate') == 'auto'
        assert config.decide('do/export') == 'auto'
        assert config.decide('do/ci') == 'auto'

    def test_decide_default_unknown_script(self):
        """Unknown script defaults to 'confirm' in default mode."""
        config = ExecutionConfig()
        assert config.decide('do/unknown-script') == 'confirm'


class TestDecideModeOverrides:
    """Tests for decide() with mode overrides."""

    def test_decide_mode_all(self):
        """Any script returns 'confirm' when mode='all'."""
        config = ExecutionConfig(mode='all')
        assert config.decide('do/test') == 'confirm'
        assert config.decide('do/status') == 'confirm'
        assert config.decide('do/deploy') == 'confirm'
        assert config.decide('do/unknown') == 'confirm'

    def test_decide_mode_none(self):
        """Any script returns 'auto' when mode='none'."""
        config = ExecutionConfig(mode='none')
        assert config.decide('do/test') == 'auto'
        assert config.decide('do/deploy') == 'auto'
        assert config.decide('do/stage') == 'auto'
        assert config.decide('do/unknown') == 'auto'


class TestLoadFromConfigFile:
    """Tests for load_execution_config reading from .mlcc/agent-config.json."""

    def test_load_from_config_file(self, tmp_path):
        """Loads script_classes and mode from .mlcc/agent-config.json."""
        config_dir = tmp_path / '.mlcc'
        config_dir.mkdir()
        config_file = config_dir / 'agent-config.json'
        config_file.write_text(json.dumps({
            'permitted_scripts': ['do/test', 'do/build'],
            'cost_warnings': {},
            'max_script_timeout': 600,
            'confirmation': {
                'mode': 'none',
                'scriptClasses': {
                    'do/test': 'auto',
                    'do/build': 'confirm',
                },
            },
        }))

        config = load_execution_config(tmp_path)
        assert config.mode == 'none'
        assert config.decide('do/test') == 'auto'  # mode=none overrides
        assert config.decide('do/build') == 'auto'  # mode=none overrides

    def test_load_from_config_file_default_mode(self, tmp_path):
        """Loads with mode=default and custom scriptClasses."""
        config_dir = tmp_path / '.mlcc'
        config_dir.mkdir()
        config_file = config_dir / 'agent-config.json'
        config_file.write_text(json.dumps({
            'permitted_scripts': ['do/test', 'do/build', 'do/custom'],
            'confirmation': {
                'mode': 'default',
                'scriptClasses': {
                    'do/custom': 'auto',
                },
            },
        }))

        config = load_execution_config(tmp_path)
        assert config.mode == 'default'
        assert config.decide('do/custom') == 'auto'
        assert config.decide('do/test') == 'auto'  # from defaults
        assert config.decide('do/build') == 'confirm'  # from defaults

    def test_load_fallback_on_missing_file(self, tmp_path):
        """Falls back to defaults when config file is missing."""
        config = load_execution_config(tmp_path)
        assert config.mode == 'default'
        assert config.decide('do/test') == 'auto'
        assert config.decide('do/deploy') == 'confirm'


class TestIsPermitted:
    """Existing is_permitted tests should still pass."""

    def test_is_permitted_default_scripts(self):
        """Default permitted scripts are recognized."""
        config = ExecutionConfig()
        assert config.is_permitted('do/stage') is True
        assert config.is_permitted('do/build') is True
        assert config.is_permitted('do/push') is True
        assert config.is_permitted('do/submit') is True

    def test_is_not_permitted(self):
        """Non-permitted scripts are rejected."""
        config = ExecutionConfig()
        assert config.is_permitted('do/hack') is False
        assert config.is_permitted('rm -rf /') is False

    def test_cost_warning(self):
        """Cost warnings return for known scripts."""
        config = ExecutionConfig()
        assert config.get_cost_warning('do/stage') is not None
        assert config.get_cost_warning('do/submit') is not None
        assert config.get_cost_warning('do/test') is None
