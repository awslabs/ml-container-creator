<% if (deployTarget === 'codebuild') { %>#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# ⚠️  DEPRECATED: This script is deprecated and will be removed in a future version.
#
# Please migrate to the do-framework command:
#   ./do/submit
#
# See do/README.md for more information about the do-framework.
# See MIGRATION.md for a complete migration guide.

echo ""
echo "⚠️  =============================================="
echo "⚠️  WARNING: This script is DEPRECATED"
echo "⚠️  =============================================="
echo ""
echo "This script (deploy/submit_build.sh) is deprecated and will be"
echo "removed in a future version of ML Container Creator."
echo ""
echo "Please use the do-framework command instead:"
echo ""
echo "  ./do/submit"
echo ""
echo "For more information:"
echo "  - See do/README.md for do-framework documentation"
echo "  - See MIGRATION.md for migration guide"
echo ""
echo "⚠️  =============================================="
echo ""
echo "Forwarding to do-framework script in 3 seconds..."
echo "(Press Ctrl+C to cancel)"
echo ""
sleep 3

# Forward to do-framework script
./do/submit "$@"
<% } %>