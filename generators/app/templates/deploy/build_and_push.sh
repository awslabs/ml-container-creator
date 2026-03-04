#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# ⚠️  DEPRECATED: This script is deprecated and will be removed in a future version.
#
# Please migrate to the do-framework commands:
#   ./do/build   # Build Docker image
#   ./do/push    # Push image to ECR
#
# Or run both in sequence:
#   ./do/build && ./do/push
#
# See do/README.md for more information about the do-framework.
# See MIGRATION.md for a complete migration guide.

echo ""
echo "⚠️  =============================================="
echo "⚠️  WARNING: This script is DEPRECATED"
echo "⚠️  =============================================="
echo ""
echo "This script (deploy/build_and_push.sh) is deprecated and will be"
echo "removed in a future version of ML Container Creator."
echo ""
echo "Please use the do-framework commands instead:"
echo ""
echo "  ./do/build   # Build Docker image"
echo "  ./do/push    # Push image to ECR"
echo ""
echo "Or run both in sequence:"
echo ""
echo "  ./do/build && ./do/push"
echo ""
echo "For more information:"
echo "  - See do/README.md for do-framework documentation"
echo "  - See MIGRATION.md for migration guide"
echo ""
echo "⚠️  =============================================="
echo ""
echo "Forwarding to do-framework scripts in 3 seconds..."
echo "(Press Ctrl+C to cancel)"
echo ""
sleep 3

# Forward to do-framework scripts
./do/build && ./do/push
