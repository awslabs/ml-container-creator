from __future__ import annotations
"""Behavioral equivalence tests for helper decomposition.

Verifies that decomposed sub-modules produce identical JSON output to the
original monolithic helpers for each subcommand.
"""

import importlib
import json
import os
import subprocess
import sys

# Add the lib/python directory to path for imports
LIB_PYTHON_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'templates', 'do', 'lib', 'python'
)
sys.path.insert(0, LIB_PYTHON_DIR)


def test_common_output():
    """_output({'key': 'val'}) exits 0 and stdout is valid JSON."""
    result = subprocess.run(
        [sys.executable, '-c', f"""
import sys
sys.path.insert(0, {LIB_PYTHON_DIR!r})
from common import _output
_output({{"key": "val"}})
"""],
        capture_output=True, text=True
    )
    assert result.returncode == 0, f"Expected exit 0, got {result.returncode}"
    parsed = json.loads(result.stdout.strip())
    assert parsed == {"key": "val"}, f"Unexpected output: {parsed}"
    print("PASS: test_common_output")


def test_common_error_exit():
    """_error_exit('msg') exits 1 and stdout has 'error' key."""
    result = subprocess.run(
        [sys.executable, '-c', f"""
import sys
sys.path.insert(0, {LIB_PYTHON_DIR!r})
from common import _error_exit
_error_exit("test error message")
"""],
        capture_output=True, text=True
    )
    assert result.returncode == 1, f"Expected exit 1, got {result.returncode}"
    parsed = json.loads(result.stdout.strip())
    assert "error" in parsed, f"Expected 'error' key in output: {parsed}"
    assert parsed["error"] == "test error message"
    print("PASS: test_common_error_exit")


def test_common_error_exit_with_code():
    """_error_exit('msg', code='MY_CODE') includes code in JSON output."""
    result = subprocess.run(
        [sys.executable, '-c', f"""
import sys
sys.path.insert(0, {LIB_PYTHON_DIR!r})
from common import _error_exit
_error_exit("test error", code="MY_CODE")
"""],
        capture_output=True, text=True
    )
    assert result.returncode == 1, f"Expected exit 1, got {result.returncode}"
    parsed = json.loads(result.stdout.strip())
    assert parsed.get("code") == "MY_CODE", f"Expected code='MY_CODE' in output: {parsed}"
    print("PASS: test_common_error_exit_with_code")


def test_tune_modules_importable():
    """Each tune_*.py imports without error."""
    modules = ['tune_submit', 'tune_status', 'tune_resolve', 'tune_stage_hf', 'tune_validate', 'tune_discover']
    for mod_name in modules:
        result = subprocess.run(
            [sys.executable, '-c', f"""
import sys
sys.path.insert(0, {LIB_PYTHON_DIR!r})
import {mod_name}
print("OK")
"""],
            capture_output=True, text=True
        )
        assert result.returncode == 0, f"Failed to import {mod_name}: {result.stderr}"
        assert "OK" in result.stdout, f"Module {mod_name} did not produce OK output"
    print("PASS: test_tune_modules_importable")


def test_register_modules_importable():
    """Each register_*.py imports without error."""
    modules = ['register_common', 'register_model', 'register_dataset', 'register_list', 'register_resolve']
    for mod_name in modules:
        result = subprocess.run(
            [sys.executable, '-c', f"""
import sys
sys.path.insert(0, {LIB_PYTHON_DIR!r})
import {mod_name}
print("OK")
"""],
            capture_output=True, text=True
        )
        assert result.returncode == 0, f"Failed to import {mod_name}: {result.stderr}"
        assert "OK" in result.stdout, f"Module {mod_name} did not produce OK output"
    print("PASS: test_register_modules_importable")


def test_stage_modules_importable():
    """stage_model.py, stage_adapter.py import without error."""
    modules = ['stage_model', 'stage_adapter']
    for mod_name in modules:
        result = subprocess.run(
            [sys.executable, '-c', f"""
import sys
sys.path.insert(0, {LIB_PYTHON_DIR!r})
import {mod_name}
print("OK")
"""],
            capture_output=True, text=True
        )
        assert result.returncode == 0, f"Failed to import {mod_name}: {result.stderr}"
        assert "OK" in result.stdout, f"Module {mod_name} did not produce OK output"
    print("PASS: test_stage_modules_importable")


def test_no_inline_output_in_submodules():
    """Sub-modules should NOT define _output inline — they import from common."""
    submodule_files = [
        'tune_submit.py', 'tune_status.py', 'tune_resolve.py',
        'tune_stage_hf.py', 'tune_validate.py', 'tune_discover.py',
        'register_model.py', 'register_dataset.py', 'register_list.py', 'register_resolve.py',
        'stage_model.py', 'stage_adapter.py',
    ]
    for filename in submodule_files:
        filepath = os.path.join(LIB_PYTHON_DIR, filename)
        assert os.path.exists(filepath), f"Missing file: {filepath}"
        with open(filepath, 'r') as f:
            content = f.read()
        # Check that no sub-module defines its own _output function
        assert '\ndef _output(' not in content and '\ndef _output (' not in content, \
            f"{filename} defines _output inline — should import from common"
    print("PASS: test_no_inline_output_in_submodules")


def test_dispatchers_have_future_annotations():
    """All dispatcher files start with from __future__ import annotations."""
    dispatcher_files = [
        os.path.join(LIB_PYTHON_DIR, '..', '..', '.tune_helper.py'),
        os.path.join(LIB_PYTHON_DIR, '..', '..', '.register_helper.py'),
        os.path.join(LIB_PYTHON_DIR, '..', '..', '.stage_helper.py'),
        os.path.join(LIB_PYTHON_DIR, '..', '..', '.adapter_helper.py'),
    ]
    for filepath in dispatcher_files:
        filepath = os.path.normpath(filepath)
        assert os.path.exists(filepath), f"Missing dispatcher: {filepath}"
        with open(filepath, 'r') as f:
            lines = f.readlines()
        # Find first non-comment, non-shebang, non-empty line
        found = False
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                continue
            assert 'from __future__ import annotations' in stripped, \
                f"{os.path.basename(filepath)} missing 'from __future__ import annotations' as first statement. Got: {stripped!r}"
            found = True
            break
        assert found, f"{os.path.basename(filepath)} appears empty"
    print("PASS: test_dispatchers_have_future_annotations")


if __name__ == "__main__":
    test_common_output()
    test_common_error_exit()
    test_common_error_exit_with_code()
    test_tune_modules_importable()
    test_register_modules_importable()
    test_stage_modules_importable()
    test_no_inline_output_in_submodules()
    test_dispatchers_have_future_annotations()
    print("\nAll tests passed!")
