from __future__ import annotations
"""Common utilities shared across do/ script Python helpers.

Purpose: Single source of truth for output formatting, error handling, and
         AWS client initialization shared by tune_*, register_*, and stage_* modules.
Callers: .tune_helper.py, .register_helper.py, .stage_helper.py, .adapter_helper.py
"""

import json
import logging
import os
import sys
import warnings

# Suppress noisy dependency version warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*urllib3.*")
warnings.filterwarnings("ignore", message=".*charset_normalizer.*")

# Suppress ALL logging to prevent sagemaker-core/rich from writing to stdout.
# These scripts output JSON on stdout — any other stdout output corrupts parsing.
logging.disable(logging.CRITICAL)
os.environ.setdefault("SAGEMAKER_LOG_LEVEL", "CRITICAL")


def get_region():
    """Resolve AWS region from environment variables.

    Precedence: AWS_DEFAULT_REGION → AWS_REGION → REGION → 'us-east-1'
    """
    return (
        os.environ.get('AWS_DEFAULT_REGION')
        or os.environ.get('AWS_REGION')
        or os.environ.get('REGION')
        or 'us-east-1'
    )


def setup_region(region=None):
    """Set region in environment before any sagemaker import.

    sagemaker-core creates boto3 clients at import time and reads
    AWS_DEFAULT_REGION from the environment.

    Args:
        region: Explicit region override. If None, uses get_region().
    """
    resolved = region or get_region()
    os.environ["AWS_DEFAULT_REGION"] = resolved
    os.environ.setdefault("AWS_REGION", resolved)
    return resolved


def _output(data):
    """Print JSON result to stdout and exit 0."""
    print(json.dumps(data))
    sys.exit(0)


def _error_exit(message, code=None, exit_code=1):
    """Print error and exit.

    Supports two calling conventions:
    - register_helper style: _error_exit("msg", code="REGISTRATION_ERROR", exit_code=1)
      → prints JSON {"error": message, "code": code} to stdout + message to stderr
    - tune/stage style: _error_exit("msg") or _error_exit("msg", exit_code=1)
      → prints JSON {"error": message} to stdout

    Args:
        message: Error message string
        code: Optional error code string (for structured error responses)
        exit_code: Process exit code (default 1)
    """
    if code is not None:
        print(f"Error: {message}", file=sys.stderr)
        print(json.dumps({"error": message, "code": code}))
    else:
        print(json.dumps({"error": message}))
    sys.exit(exit_code)


def _warn(message):
    """Print warning to stderr."""
    print(f"\u26a0\ufe0f  {message}", file=sys.stderr)


def _check_sagemaker_core():
    """Verify sagemaker-core is installed."""
    try:
        from sagemaker.core.resources import ModelPackageGroup, ModelPackage  # noqa: F401
    except ImportError:
        _error_exit(
            "sagemaker-core is not installed. "
            "Please install: pip install 'sagemaker>=3.0.0' (includes sagemaker-core)",
            code="MISSING_DEPENDENCY",
        )


def _check_sagemaker_sdk():
    """Verify sagemaker SDK is installed with minimum version (>=3.0)."""
    import re  # noqa: F811
    MIN_SAGEMAKER_VERSION = "3.0"
    try:
        import sagemaker  # noqa: F401
        from importlib.metadata import version as pkg_version
        from packaging.version import Version
        installed = pkg_version("sagemaker")
        if Version(installed) < Version(MIN_SAGEMAKER_VERSION):
            _error_exit(
                f"sagemaker SDK version {installed} is below minimum "
                f"required version {MIN_SAGEMAKER_VERSION}. "
                f"Please upgrade: pip install --upgrade 'sagemaker>={MIN_SAGEMAKER_VERSION}'"
            )
    except ImportError:
        _error_exit(
            f"sagemaker Python SDK is not installed. "
            f"Please install: pip install 'sagemaker>={MIN_SAGEMAKER_VERSION}'"
        )


def _check_boto3():
    """Verify boto3 is available."""
    try:
        import boto3  # noqa: F401
    except ImportError:
        _error_exit(
            "boto3 is not installed. "
            "Please install: pip install boto3"
        )
