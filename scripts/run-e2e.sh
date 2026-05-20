#!/bin/bash
set -e

# Shell wrapper for CodeBuild e2e execution.
# Sources nvm, sets Node.js version, and invokes the e2e runner.

# Source nvm from common installation locations
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
elif [ -s "/usr/local/share/nvm/nvm.sh" ]; then
    . "/usr/local/share/nvm/nvm.sh"
elif [ -s "/opt/nvm/nvm.sh" ]; then
    . "/opt/nvm/nvm.sh"
else
    echo "Error: nvm not found" >&2
    exit 1
fi

# Set Node.js version
nvm use node

# Run the e2e runner with tier and any additional flags
# shellcheck disable=SC2086
node scripts/e2e-runner.js --tier "$TIER" $E2E_FLAGS
