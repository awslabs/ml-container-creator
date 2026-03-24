#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# start_server.sh — Alternative startup script for vLLM-Omni diffusion model serving.
# This script builds the vllm serve command with explicit diffusion-specific CLI flags.
# The primary entrypoint is the `serve` script; use this for manual customization.

set -e

echo "Starting vLLM-Omni server (diffusion model serving)"

# ---------------------------------------------------------------
# Validate required environment variables
# ---------------------------------------------------------------
if [ -z "$VLLM_MODEL" ]; then
    echo "Error: VLLM_MODEL environment variable is not set."
    echo "Set it to a HuggingFace diffusion model ID, e.g.:"
    echo "  export VLLM_MODEL=stabilityai/stable-diffusion-3.5-medium"
    exit 1
fi

# ---------------------------------------------------------------
# Build the base vllm serve command
# --omni: activates vLLM-Omni diffusion/multi-stage support
# --port 8080: SageMaker requires containers to listen on port 8080
#   https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms-inference-code.html
# ---------------------------------------------------------------
CMD="vllm serve $VLLM_MODEL --omni --host 0.0.0.0 --port 8081"

# ---------------------------------------------------------------
# Diffusion-specific CLI flags (configurable via environment variables)
# ---------------------------------------------------------------

# --num-gpus: Number of GPUs for diffusion inference (tensor parallelism)
# Example: export VLLM_NUM_GPUS=4
if [ -n "$VLLM_NUM_GPUS" ]; then
    CMD="$CMD --num-gpus $VLLM_NUM_GPUS"
fi

# --cache-backend: Diffusion acceleration backend
# Options: tea_cache (hook-based adaptive caching), cache_dit (library-based), none
# Example: export VLLM_CACHE_BACKEND=tea_cache
if [ -n "$VLLM_CACHE_BACKEND" ]; then
    CMD="$CMD --cache-backend $VLLM_CACHE_BACKEND"
fi

# --vae-use-tiling: Process VAE in tiles to reduce VRAM usage
# Set to any non-empty value to enable
# Example: export VLLM_VAE_USE_TILING=1
if [ -n "$VLLM_VAE_USE_TILING" ]; then
    CMD="$CMD --vae-use-tiling"
fi

# --ulysses-degree: Ulysses sequence parallelism degree for large models
# Example: export VLLM_ULYSSES_DEGREE=2
if [ -n "$VLLM_ULYSSES_DEGREE" ]; then
    CMD="$CMD --ulysses-degree $VLLM_ULYSSES_DEGREE"
fi

# --ring-degree: Ring sequence parallelism degree
# Example: export VLLM_RING_DEGREE=2
if [ -n "$VLLM_RING_DEGREE" ]; then
    CMD="$CMD --ring-degree $VLLM_RING_DEGREE"
fi

# --enable-cpu-offload: Offload model weights to CPU to save GPU memory
# Set to any non-empty value to enable
# Example: export VLLM_ENABLE_CPU_OFFLOAD=1
if [ -n "$VLLM_ENABLE_CPU_OFFLOAD" ]; then
    CMD="$CMD --enable-cpu-offload"
fi

echo "-------------------------------------------------------------------"
echo "vLLM-Omni command: $CMD"
echo "-------------------------------------------------------------------"

# Launch vLLM-Omni on internal port (8081), then nginx on SageMaker port (8080)
$CMD &
VLLM_PID=$!

# Wait for vLLM-Omni to be ready before starting nginx
echo "Waiting for vLLM-Omni server to start..."
for i in {1..300}; do
    if curl -s http://localhost:8081/health > /dev/null 2>&1; then
        echo "vLLM-Omni server is ready!"
        break
    fi
    if ! kill -0 $VLLM_PID 2>/dev/null; then
        echo "Error: vLLM-Omni process exited unexpectedly"
        exit 1
    fi
    if [ $i -eq 300 ]; then
        echo "Error: vLLM-Omni server failed to start within 300 seconds"
        exit 1
    fi
    sleep 1
done

echo "Starting nginx reverse proxy on port 8080..."
nginx -c /etc/nginx/nginx.conf &
NGINX_PID=$!

# Wait for either process to exit (this keeps the container running)
wait -n $VLLM_PID $NGINX_PID

# If we get here, one process exited - this is an error condition
EXIT_CODE=$?
echo "Error: Process exited with code $EXIT_CODE"

# Kill any remaining processes
kill $VLLM_PID $NGINX_PID 2>/dev/null || true

exit $EXIT_CODE
