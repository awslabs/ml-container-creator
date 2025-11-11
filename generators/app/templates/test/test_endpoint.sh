# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

#!/bin/bash

# Exit on any error
set -e

<% if (framework !== 'transformers') { %>

# Check if endpoint name is provided
if [ $# -ne 1 ]; then
    echo "Usage: $0 <endpoint-name>"
    echo "Example: $0 <%= framework %>-endpoint-1234567890"
    exit 1
fi

ENDPOINT_NAME=$1
AWS_REGION="us-east-1"

<% } else { %>
if [ $# -ne 2 ]; then
    echo "Usage: $0 <endpoint-name> <model-id>"
    echo "Example: $0 <%= framework %>-endpoint-1234567890"
    exit 1
fi

ENDPOINT_NAME=$1
MODEL_ID=$2
AWS_REGION="us-east-1"

<% } %>

echo "Testing SageMaker endpoint: ${ENDPOINT_NAME}"

echo "Checking endpoint status..."
aws sagemaker describe-endpoint --endpoint-name ${ENDPOINT_NAME} --region ${AWS_REGION} --query 'EndpointStatus' --output text

echo "Testing inference endpoint..."

<% if (framework !== 'transformers') { %>
echo '{"instances": [[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]}' > input.json
<% } else {%>

cat > input.json << EOF
{
  "model": "${MODEL_ID}",
  "messages": [
    {
      "role": "user",
      "content": "Hello, how are you?"
    }
  ],
  "max_tokens": 100,
  "temperature": 0.7
}
EOF

<% } %>

aws sagemaker-runtime invoke-endpoint \
    --endpoint-name ${ENDPOINT_NAME} \
    --region ${AWS_REGION} \
    --content-type 'application/json' \
    --body fileb://input.json \
    response.json

echo "Response:"
if command -v jq &> /dev/null; then
    # Decode base64 if response is encoded
    jq -r '.Body // .' response.json 2>/dev/null || cat response.json
else
    cat response.json
fi
echo

echo "Cleaning up files..."
rm -f response.json input.json

echo "Test complete!"