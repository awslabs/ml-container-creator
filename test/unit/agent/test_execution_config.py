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


class TestSchemaNormalizationBL079:
    """BL079: snake_case-first read with camelCase fallback + venv_path."""

    def _write_config(self, tmp_path, data):
        config_dir = tmp_path / '.mlcc'
        config_dir.mkdir(exist_ok=True)
        (config_dir / 'agent-config.json').write_text(json.dumps(data))

    def test_script_classes_snake_case_read(self, tmp_path):
        """`script_classes` (snake_case) is read and applied (Req 4.1, 5.4)."""
        self._write_config(tmp_path, {
            'confirmation': {
                'mode': 'default',
                'script_classes': {'do/deploy': 'auto'},
            },
        })
        config = load_execution_config(tmp_path)
        # do/deploy is normally 'confirm'; snake_case override flips it to 'auto'.
        assert config.decide('do/deploy') == 'auto'

    def test_camel_case_fallback(self, tmp_path):
        """Falls back to `scriptClasses` (camelCase) when snake_case absent (Req 4.1, 5.5)."""
        self._write_config(tmp_path, {
            'confirmation': {
                'mode': 'default',
                'scriptClasses': {'do/deploy': 'auto'},
            },
        })
        config = load_execution_config(tmp_path)
        assert config.decide('do/deploy') == 'auto'

    def test_snake_case_wins_over_camel_case(self, tmp_path):
        """When both keys are present, `script_classes` takes precedence (Req 4.2, 5.6)."""
        self._write_config(tmp_path, {
            'confirmation': {
                'mode': 'default',
                'script_classes': {'do/deploy': 'auto'},
                'scriptClasses': {'do/deploy': 'confirm'},
            },
        })
        config = load_execution_config(tmp_path)
        assert config.decide('do/deploy') == 'auto'

    def test_venv_path_read(self, tmp_path):
        """`venv_path` is read into ExecutionConfig (Req 4.4, 4.6)."""
        self._write_config(tmp_path, {
            'venv_path': '.mlcc/hey-venv',
        })
        config = load_execution_config(tmp_path)
        assert config.venv_path == '.mlcc/hey-venv'

    def test_venv_path_defaults_to_none(self, tmp_path):
        """venv_path is None when absent from the config."""
        self._write_config(tmp_path, {'permitted_scripts': ['do/test']})
        config = load_execution_config(tmp_path)
        assert config.venv_path is None

    def test_venv_path_default_when_no_file(self, tmp_path):
        """venv_path defaults to None when there is no config file at all."""
        config = load_execution_config(tmp_path)
        assert config.venv_path is None
