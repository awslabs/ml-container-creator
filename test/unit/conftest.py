"""Conftest for unit tests — ensures decomposed helper sub-modules are importable.

After helper decomposition, tests that patch module-level constants need the
sub-modules to be in sys.modules so patch("module_name.attr") works.
"""
import os
import sys

# Add the decomposed modules to sys.path
_LIB_PYTHON = os.path.join(
    os.path.dirname(__file__), '..', '..', 'templates', 'do', 'lib', 'python'
)
_LIB_PYTHON = os.path.normpath(_LIB_PYTHON)
if _LIB_PYTHON not in sys.path:
    sys.path.insert(0, _LIB_PYTHON)

# Pre-import sub-modules so patch("register_dataset._DATASETS_REGISTRY") works
import register_common  # noqa: E402, F401
import register_dataset  # noqa: E402, F401
import register_resolve  # noqa: E402, F401
import register_model  # noqa: E402, F401
import register_list  # noqa: E402, F401
