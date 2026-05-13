#!/bin/bash
# CUDA Compatibility Setup
# Required for SageMaker inference AMIs using NVIDIA Container Toolkit 1.17.4+
# (al2-ami-sagemaker-inference-gpu-2-1, al2-ami-sagemaker-inference-gpu-3-1,
#  al2023-ami-sagemaker-inference-gpu-4-1)
#
# These AMIs no longer auto-mount CUDA compat libraries. This script detects
# whether the host NVIDIA driver is older than what the container's CUDA toolkit
# requires, and adds the compat libraries to LD_LIBRARY_PATH if needed.

_verlt() {
    [ "$1" = "$2" ] && return 1 || [ "$1" = "$(echo -e "$1\n$2" | sort -V | head -n1)" ]
}

if [ -f /usr/local/cuda/compat/libcuda.so.1 ]; then
    CUDA_COMPAT_MAX_DRIVER_VERSION=$(readlink /usr/local/cuda/compat/libcuda.so.1 | cut -d'.' -f 3-)
    NVIDIA_DRIVER_VERSION=$(sed -n 's/^NVRM.*Kernel Module *\([0-9.]*\).*$/\1/p' /proc/driver/nvidia/version 2>/dev/null || true)
    if [ -n "$NVIDIA_DRIVER_VERSION" ] && _verlt "$NVIDIA_DRIVER_VERSION" "$CUDA_COMPAT_MAX_DRIVER_VERSION"; then
        echo "CUDA compat: driver ${NVIDIA_DRIVER_VERSION} < ${CUDA_COMPAT_MAX_DRIVER_VERSION}, adding compat libs"
        export LD_LIBRARY_PATH=/usr/local/cuda/compat:${LD_LIBRARY_PATH:-}
    fi
fi
