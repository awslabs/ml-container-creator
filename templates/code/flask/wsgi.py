# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
WSGI entry point for Gunicorn
"""
from serve import create_app

# Create the Flask application
application = create_app()
