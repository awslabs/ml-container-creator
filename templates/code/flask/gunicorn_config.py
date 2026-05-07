# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Gunicorn configuration file
"""
import os
import multiprocessing
from serve import load_model_for_worker

# Bind address
bind = f"0.0.0.0:8080"

# Worker processes - cap at 4 for memory efficiency
workers = min(multiprocessing.cpu_count(), 4)

# Worker type
worker_class = 'sync'

# Timeouts
timeout = 120
keepalive = 5

# Worker lifecycle management
max_requests = 500
max_requests_jitter = 100

# Logging
accesslog = '-'  # Log to stdout
errorlog = '-'   # Log to stderr
loglevel = 'info'

# Worker initialization hook - load model in each worker
def post_worker_init(worker):
    load_model_for_worker()