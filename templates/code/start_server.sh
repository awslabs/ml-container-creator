#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

set -e

echo "Starting TensorRT-LLM server on port 8081..."
/usr/bin/serve_trtllm &
TRTLLM_PID=$!

# Wait for TensorRT-LLM to be ready
echo "Waiting for TensorRT-LLM server to start..."
for i in {1..300}; do
    if curl -s http://localhost:8081/health > /dev/null 2>&1; then
        echo "TensorRT-LLM server is ready!"
        break
    fi
    if [ $i -eq 300 ]; then
        echo "ERROR: TensorRT-LLM server failed to start within 300 seconds"
        exit 1
    fi
    sleep 1
done

echo "Starting nginx reverse proxy on port 8080..."
nginx -c /etc/nginx/nginx.conf &
NGINX_PID=$!

# Wait for either process to exit (this keeps the container running)
wait -n $TRTLLM_PID $NGINX_PID

# If we get here, one process exited - this is an error condition
EXIT_CODE=$?
echo "ERROR: A critical process exited unexpectedly (exit code: $EXIT_CODE)"

# Kill any remaining processes
kill $TRTLLM_PID $NGINX_PID 2>/dev/null || true

exit $EXIT_CODE
