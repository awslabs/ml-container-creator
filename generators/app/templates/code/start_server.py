# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

#!/usr/bin/env python3
"""
Script to start the SageMaker inference server
"""
import signal
import subprocess
import sys


def signal_handler(signum, frame):
    """Handle shutdown signals"""
    print(f"Received signal {signum}, shutting down gracefully...")
    sys.exit(0)


if __name__ == '__main__':
    # Register signal handlers
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

<% if (modelServer === 'flask') { %>
    print("Starting SageMaker inference server with Gunicorn")
    subprocess.run([
        'gunicorn',
        '--config', '/opt/ml/code/gunicorn_config.py',
        'wsgi:application'
    ])
<% } else if (modelServer === 'fastapi' || modelServer === 'sglang') { %>
    print("Starting SageMaker inference server with Uvicorn")
    subprocess.run([
        'uvicorn',
        'serve:app',
        '--host', '0.0.0.0',
        '--port', '8080',
        '--workers', '4'
    ])
<% } %>