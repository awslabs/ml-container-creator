#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Push files to S3 bucket
# Usage: ./upload_to_s3.sh <bucket-name> <key-prefix>

set -e

if [ $# -ne 2 ]; then
    echo "Usage: $0 <bucket-name> <key-prefix>"
    echo "Example: $0 my-bucket my-project/v1.0"
    exit 1
fi

BUCKET=$1
KEY_PREFIX=$2

# Navigate to parent directory
cd "$(dirname "$0")/.."

echo "Pushing files to s3://$BUCKET/$KEY_PREFIX/"

# Sync all files and folders to S3
aws s3 sync . "s3://$BUCKET/$KEY_PREFIX/" --exclude "*.git/*"

echo "Files successfully pushed to S3"
