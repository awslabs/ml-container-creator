#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

set -e

# Configuration
PROJECT_NAME="<%= projectName %>"
CODEBUILD_PROJECT_NAME="<%= codebuildProjectName %>"
AWS_REGION="<%= awsRegion %>"
COMPUTE_TYPE="<%= codebuildComputeType %>"

# Use a single ECR repository for all ML container projects
ECR_REPOSITORY_NAME="ml-container-creator"

# Environment variable overrides
COMPUTE_TYPE=${ML_CODEBUILD_COMPUTE_TYPE:-$COMPUTE_TYPE}
AWS_REGION=${AWS_REGION:-$AWS_REGION}
ECR_REPOSITORY_NAME=${ECR_REPOSITORY_NAME:-$ECR_REPOSITORY_NAME}

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$AWS_ACCOUNT_ID" ]; then
    echo "❌ Failed to get AWS account ID. Please check your AWS credentials."
    exit 1
fi

echo "🏗️  Submitting CodeBuild job..."
echo "Project: $CODEBUILD_PROJECT_NAME"
echo "Region: $AWS_REGION"
echo "Compute Type: $COMPUTE_TYPE"
echo "ECR Repository: $ECR_REPOSITORY_NAME"

# Create ECR repository if it doesn't exist
echo "📦 Checking ECR repository..."
if ! aws ecr describe-repositories --repository-names $ECR_REPOSITORY_NAME --region $AWS_REGION >/dev/null 2>&1; then
    echo "Creating shared ECR repository: $ECR_REPOSITORY_NAME"
    aws ecr create-repository --repository-name $ECR_REPOSITORY_NAME --region $AWS_REGION
    echo "✅ ECR repository created successfully"
    echo "ℹ️  This repository will be shared by all ML container projects"
else
    echo "✅ ECR repository already exists: $ECR_REPOSITORY_NAME"
fi

# Create CodeBuild service role if it doesn't exist
ROLE_NAME="${CODEBUILD_PROJECT_NAME}-service-role"
echo "🔐 Checking CodeBuild service role..."
if ! aws iam get-role --role-name $ROLE_NAME >/dev/null 2>&1; then
    echo "Creating CodeBuild service role: $ROLE_NAME"
    
    # Create trust policy
    cat > /tmp/codebuild-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codebuild.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

    # Create the role
    aws iam create-role \
        --role-name $ROLE_NAME \
        --assume-role-policy-document file:///tmp/codebuild-trust-policy.json \
        --description "Service role for CodeBuild project $CODEBUILD_PROJECT_NAME"

    # Create and attach policy
    cat > /tmp/codebuild-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:$AWS_REGION:$AWS_ACCOUNT_ID:log-group:/aws/codebuild/$CODEBUILD_PROJECT_NAME*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:GetAuthorizationToken",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::codebuild-source-$AWS_ACCOUNT_ID-$AWS_REGION/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::codebuild-source-$AWS_ACCOUNT_ID-$AWS_REGION"
      ]
    }
  ]
}
EOF

    aws iam put-role-policy \
        --role-name $ROLE_NAME \
        --policy-name CodeBuildServicePolicy \
        --policy-document file:///tmp/codebuild-policy.json

    # Clean up temporary files
    rm -f /tmp/codebuild-trust-policy.json /tmp/codebuild-policy.json
    
    echo "✅ CodeBuild service role created successfully"
    
    # Wait a moment for role to propagate
    echo "⏳ Waiting for IAM role to propagate..."
    sleep 10
else
    echo "✅ CodeBuild service role already exists"
fi

# Create CodeBuild project if it doesn't exist
echo "🏗️  Checking CodeBuild project..."
PROJECT_EXISTS=$(aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT_NAME" --region $AWS_REGION --query 'projects[0].name' --output text 2>/dev/null)
if [ "$PROJECT_EXISTS" = "None" ] || [ -z "$PROJECT_EXISTS" ] || [ "$PROJECT_EXISTS" = "null" ]; then
    echo "Creating CodeBuild project: $CODEBUILD_PROJECT_NAME"
    
    # Create the CodeBuild project with proper error handling
    echo "Creating CodeBuild project..."
    
    # Create project configuration as JSON
    cat > /tmp/codebuild-project.json << EOF
{
    "name": "$CODEBUILD_PROJECT_NAME",
    "description": "Build project for $PROJECT_NAME ML container ($COMPUTE_TYPE)",
    "source": {
        "type": "NO_SOURCE",
        "buildspec": "version: 0.2\n\nenv:\n  variables:\n    AWS_DEFAULT_REGION: $AWS_REGION\n    AWS_ACCOUNT_ID: \"\"\n    ECR_REPOSITORY_NAME: \"ml-container-creator\"\n    PROJECT_NAME: \"$PROJECT_NAME\"\n    IMAGE_TAG: \"latest\"\n\nphases:\n  pre_build:\n    commands:\n      - echo Logging in to Amazon ECR...\n      - AWS_ACCOUNT_ID=\$(aws sts get-caller-identity --query Account --output text)\n      - aws ecr get-login-password --region \$AWS_DEFAULT_REGION | docker login --username AWS --password-stdin \$AWS_ACCOUNT_ID.dkr.ecr.\$AWS_DEFAULT_REGION.amazonaws.com\n      - REPOSITORY_URI=\$AWS_ACCOUNT_ID.dkr.ecr.\$AWS_DEFAULT_REGION.amazonaws.com/\$ECR_REPOSITORY_NAME\n      - IMAGE_TAG=\${CODEBUILD_RESOLVED_SOURCE_VERSION:-latest}\n      - PROJECT_TAG=\"\$PROJECT_NAME-\$(date +%Y%m%d-%H%M%S)\"\n      - echo Repository URI is \$REPOSITORY_URI\n      - echo Project tag is \$PROJECT_TAG\n      - echo Image tag is \$IMAGE_TAG\n    on-failure: ABORT\n  build:\n    commands:\n      - echo Build started on \`date\`\n      - echo Building the Docker image for project \$PROJECT_NAME...\n      - docker build -t \$REPOSITORY_URI:\$PROJECT_TAG .\n      - docker tag \$REPOSITORY_URI:\$PROJECT_TAG \$REPOSITORY_URI:\$PROJECT_NAME-latest\n      - docker tag \$REPOSITORY_URI:\$PROJECT_TAG \$REPOSITORY_URI:latest\n      - echo Build completed on \`date\`\n    on-failure: ABORT\n  post_build:\n    commands:\n      - echo Post-build started on \`date\`\n      - echo Pushing the Docker images for project \$PROJECT_NAME...\n      - docker push \$REPOSITORY_URI:\$PROJECT_TAG || (echo \"Failed to push project tag \$PROJECT_TAG\" && exit 1)\n      - docker push \$REPOSITORY_URI:\$PROJECT_NAME-latest || (echo \"Failed to push project latest tag\" && exit 1)\n      - docker push \$REPOSITORY_URI:latest || (echo \"Failed to push latest tag\" && exit 1)\n      - echo Successfully pushed images to ECR repository \$ECR_REPOSITORY_NAME\n      - echo \"Available tags:\"\n      - echo \"  - \$PROJECT_TAG (timestamped build)\"\n      - echo \"  - \$PROJECT_NAME-latest (project latest)\"\n      - echo \"  - latest (global latest)\"\n      - echo Writing image definitions file...\n      - printf '[{\"name\":\"%s\",\"imageUri\":\"%s\"}]' \$PROJECT_NAME \$REPOSITORY_URI:\$PROJECT_TAG > imagedefinitions.json\n      - echo Post-build completed on \`date\`\n\nartifacts:\n  files:\n    - imagedefinitions.json\n  name: $PROJECT_NAME-artifacts"
    },
    "artifacts": {
        "type": "NO_ARTIFACTS"
    },
    "environment": {
        "type": "LINUX_CONTAINER",
        "image": "aws/codebuild/amazonlinux2-x86_64-standard:3.0",
        "computeType": "$COMPUTE_TYPE",
        "privilegedMode": true
    },
    "serviceRole": "arn:aws:iam::$AWS_ACCOUNT_ID:role/$ROLE_NAME"
}
EOF
    
    # Create project using JSON input
    aws codebuild create-project \
        --region $AWS_REGION \
        --cli-input-json file:///tmp/codebuild-project.json > /tmp/codebuild-create-output.json 2>&1
    
    CREATE_EXIT_CODE=$?
    
    if [ $CREATE_EXIT_CODE -eq 0 ]; then
        echo "✅ CodeBuild project created successfully"
        if [ -f /tmp/codebuild-create-output.json ]; then
            PROJECT_ARN=$(cat /tmp/codebuild-create-output.json | jq -r '.project.arn // "N/A"' 2>/dev/null || echo "N/A")
            echo "Project ARN: $PROJECT_ARN"
        fi
        
        # Wait a moment for project to be available
        echo "⏳ Waiting for CodeBuild project to be available..."
        sleep 5
        
        # Verify project was created
        VERIFY_PROJECT=$(aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT_NAME" --region $AWS_REGION --query 'projects[0].name' --output text 2>/dev/null)
        if [ "$VERIFY_PROJECT" = "None" ] || [ -z "$VERIFY_PROJECT" ] || [ "$VERIFY_PROJECT" = "null" ]; then
            echo "❌ Project creation verification failed"
            echo "Create output:"
            cat /tmp/codebuild-create-output.json 2>/dev/null || echo "No output file"
            rm -f /tmp/codebuild-create-output.json /tmp/codebuild-project.json
            exit 1
        else
            echo "✅ Project creation verified: $VERIFY_PROJECT"
        fi
    else
        echo "❌ Failed to create CodeBuild project: $CODEBUILD_PROJECT_NAME (exit code: $CREATE_EXIT_CODE)"
        echo "Error output:"
        cat /tmp/codebuild-create-output.json 2>/dev/null || echo "No error output available"
        echo ""
        echo "Please check:"
        echo "  1. IAM permissions for CodeBuild operations"
        echo "  2. Service role ARN: arn:aws:iam::$AWS_ACCOUNT_ID:role/$ROLE_NAME"
        echo "  3. AWS region: $AWS_REGION"
        echo "  4. Project name format: $CODEBUILD_PROJECT_NAME"
        echo "  5. Network connectivity to AWS services"
        rm -f /tmp/codebuild-create-output.json /tmp/codebuild-project.json
        exit 1
    fi
    
    # Clean up output files
    rm -f /tmp/codebuild-create-output.json /tmp/codebuild-project.json
else
    echo "✅ CodeBuild project already exists: $PROJECT_EXISTS"
fi

# Start build with source code from current directory
echo "🚀 Starting CodeBuild job..."
echo "Using project name: $CODEBUILD_PROJECT_NAME"
echo "📁 Uploading source code from current directory..."

# Create a temporary zip file with the current directory contents
TEMP_ZIP="/tmp/${PROJECT_NAME}-source.zip"
echo "Creating source archive..."

# Create zip file excluding unnecessary files
zip -r "$TEMP_ZIP" . \
    -x "*.git*" \
    -x "*node_modules*" \
    -x "*.DS_Store*" \
    -x "*__pycache__*" \
    -x "*.pyc" \
    -x "*/.pytest_cache/*" \
    -x "*/test/*" \
    -x "*/tests/*" \
    >/dev/null 2>&1

if [ ! -f "$TEMP_ZIP" ]; then
    echo "❌ Failed to create source archive"
    exit 1
fi

echo "✅ Source archive created: $(du -h "$TEMP_ZIP" | cut -f1)"

# Upload source to S3 for CodeBuild (CodeBuild needs source in S3 for NO_SOURCE projects)
S3_BUCKET="codebuild-source-${AWS_ACCOUNT_ID}-${AWS_REGION}"
S3_KEY="${PROJECT_NAME}/source-$(date +%Y%m%d-%H%M%S).zip"

# Create S3 bucket if it doesn't exist
if ! aws s3api head-bucket --bucket "$S3_BUCKET" --region $AWS_REGION >/dev/null 2>&1; then
    echo "Creating S3 bucket for CodeBuild source: $S3_BUCKET"
    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$S3_BUCKET" --region $AWS_REGION
    else
        aws s3api create-bucket --bucket "$S3_BUCKET" --region $AWS_REGION --create-bucket-configuration LocationConstraint=$AWS_REGION
    fi
fi

# Upload source to S3
echo "📤 Uploading source to S3..."
aws s3 cp "$TEMP_ZIP" "s3://$S3_BUCKET/$S3_KEY" --region $AWS_REGION

# Clean up local zip file
rm -f "$TEMP_ZIP"

# Start build with S3 source
echo "🚀 Starting CodeBuild job with source from S3..."
echo "Using project name: '$CODEBUILD_PROJECT_NAME'"
echo "S3 source location: s3://$S3_BUCKET/$S3_KEY"

# Double-check project exists before starting build
FINAL_CHECK=$(aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT_NAME" --region $AWS_REGION --query 'projects[0].name' --output text 2>/dev/null)
if [ "$FINAL_CHECK" = "None" ] || [ -z "$FINAL_CHECK" ] || [ "$FINAL_CHECK" = "null" ]; then
    echo "❌ CodeBuild project not found before starting build: $CODEBUILD_PROJECT_NAME"
    echo "Available projects in region $AWS_REGION:"
    aws codebuild list-projects --region $AWS_REGION --query 'projects' --output table 2>/dev/null || echo "Could not list projects"
    exit 1
fi

# Start build (removed timeout for macOS compatibility)
echo "Starting build..."
aws codebuild start-build \
    --project-name "$CODEBUILD_PROJECT_NAME" \
    --source-type-override S3 \
    --source-location-override "$S3_BUCKET/$S3_KEY" \
    --region $AWS_REGION \
    --query 'build.id' \
    --output text > /tmp/build-id.txt 2>&1

START_EXIT_CODE=$?
BUILD_ID=""

if [ $START_EXIT_CODE -eq 0 ]; then
    BUILD_ID=$(cat /tmp/build-id.txt)
    rm -f /tmp/build-id.txt
else
    echo "❌ Failed to start build (exit code: $START_EXIT_CODE)"
    echo "Error output:"
    cat /tmp/build-id.txt 2>/dev/null || echo "No error output available"
    rm -f /tmp/build-id.txt
    exit 1
fi

# Check if BUILD_ID is valid
if [ -z "$BUILD_ID" ] || [ "$BUILD_ID" = "None" ] || [ "$BUILD_ID" = "null" ]; then
    echo "❌ Failed to start CodeBuild job"
    echo "Debugging information:"
    echo "  Project name: $CODEBUILD_PROJECT_NAME"
    echo "  Region: $AWS_REGION"
    echo "  Account ID: $AWS_ACCOUNT_ID"
    echo "  S3 Source: s3://$S3_BUCKET/$S3_KEY"
    
    # Try to get more information about the project
    echo ""
    echo "🔍 Checking if project exists..."
    PROJECT_EXISTS=$(aws codebuild batch-get-projects --names "$CODEBUILD_PROJECT_NAME" --region $AWS_REGION --query 'projects[0].name' --output text 2>/dev/null)
    if [ "$PROJECT_EXISTS" = "None" ] || [ -z "$PROJECT_EXISTS" ]; then
        echo "❌ CodeBuild project does not exist: $CODEBUILD_PROJECT_NAME"
    else
        echo "✅ CodeBuild project exists: $PROJECT_EXISTS"
    fi
    
    # Check if S3 object exists
    echo ""
    echo "🔍 Checking if S3 source exists..."
    if aws s3api head-object --bucket "$S3_BUCKET" --key "$S3_KEY" --region $AWS_REGION >/dev/null 2>&1; then
        echo "✅ S3 source exists: s3://$S3_BUCKET/$S3_KEY"
    else
        echo "❌ S3 source does not exist: s3://$S3_BUCKET/$S3_KEY"
    fi
    
    exit 1
fi

echo "Build started with ID: $BUILD_ID"
echo "📊 You can monitor the build at: https://$AWS_REGION.console.aws.amazon.com/codesuite/codebuild/projects/$CODEBUILD_PROJECT_NAME/build/$BUILD_ID"
echo ""
echo "⏳ Monitoring build progress..."

# Monitor build status
PREVIOUS_STATUS=""
while true; do
    BUILD_INFO=$(aws codebuild batch-get-builds \
        --ids $BUILD_ID \
        --region $AWS_REGION \
        --query 'builds[0].[buildStatus,currentPhase]' \
        --output text)
    
    # Parse status more carefully
    BUILD_STATUS=$(echo "$BUILD_INFO" | awk '{print $1}')
    CURRENT_PHASE=$(echo "$BUILD_INFO" | awk '{print $2}')
    
    # Debug output to see what we're getting
    # echo "DEBUG: BUILD_INFO='$BUILD_INFO'"
    # echo "DEBUG: BUILD_STATUS='$BUILD_STATUS'"
    # echo "DEBUG: CURRENT_PHASE='$CURRENT_PHASE'"
    
    # Only print status changes
    CURRENT_STATUS="$BUILD_STATUS:$CURRENT_PHASE"
    if [ "$CURRENT_STATUS" != "$PREVIOUS_STATUS" ]; then
        echo "📋 Build status: $BUILD_STATUS | Phase: $CURRENT_PHASE"
        PREVIOUS_STATUS="$CURRENT_STATUS"
    fi
    
    # Check for completion - be more flexible with status matching
    if [[ "$BUILD_STATUS" == "SUCCEEDED"* ]]; then
        echo ""
        echo "✅ Build completed successfully!"
        echo "🐳 Docker image available at: $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY_NAME:latest"
        echo ""
        echo "Next steps:"
        echo "  1. Run './deploy/deploy.sh' to deploy to SageMaker"
        echo "  2. Or use the ECR image URI in your own deployment process"
        exit 0
    elif [[ "$BUILD_STATUS" == "FAILED"* ]] || [[ "$BUILD_STATUS" == "FAULT"* ]] || [[ "$BUILD_STATUS" == "STOPPED"* ]] || [[ "$BUILD_STATUS" == "TIMED_OUT"* ]]; then
        echo ""
        echo "❌ Build failed with status: $BUILD_STATUS"
        echo ""
        echo "📋 Fetching build logs..."
        
        # Try to get build logs
        LOG_GROUP="/aws/codebuild/$CODEBUILD_PROJECT_NAME"
        LOG_STREAM=$(aws logs describe-log-streams \
            --log-group-name $LOG_GROUP \
            --order-by LastEventTime \
            --descending \
            --max-items 1 \
            --region $AWS_REGION \
            --query 'logStreams[0].logStreamName' \
            --output text 2>/dev/null || echo "")
        
        if [ -n "$LOG_STREAM" ] && [ "$LOG_STREAM" != "None" ]; then
            echo "Recent build logs:"
            echo "=================="
            aws logs get-log-events \
                --log-group-name $LOG_GROUP \
                --log-stream-name $LOG_STREAM \
                --region $AWS_REGION \
                --query 'events[-20:].message' \
                --output text 2>/dev/null || echo "Could not retrieve logs"
        else
            echo "Could not retrieve build logs. Check the CodeBuild console for details."
        fi
        
        echo ""
        echo "🔍 For detailed logs, visit: https://$AWS_REGION.console.aws.amazon.com/codesuite/codebuild/projects/$CODEBUILD_PROJECT_NAME/build/$BUILD_ID"
        exit 1
    fi
    
    sleep 30
done