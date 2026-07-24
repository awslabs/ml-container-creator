#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Purpose: In-place update of a SageMaker InferenceComponent via UpdateInferenceComponent API.
# This enables zero-disruption model artifact swaps without delete/recreate.
#
# Inputs:
#   --ic-name <name>         Deployed IC name (from IC_DEPLOYED_NAME in ic/<name>.conf)
#   --region <region>        AWS region
#   --model-data <s3-uri>    (Optional) New model data URL
#   --image <image-uri>      (Optional) New container image URI
#
# Outputs (JSON to stdout):
#   {"status": "InService", "ic_name": "...", "updated_fields": [...]}
#   or {"error": true, "message": "..."}
#
# Side effects:
#   - Calls UpdateInferenceComponent API
#   - Polls DescribeInferenceComponent until InService or Failed
#
# Related files:
#   - templates/do/add-ic (caller)
#   - templates/do/lib/inference-component.sh (create path)

import argparse
import json
import sys
import time

import boto3
from botocore.exceptions import ClientError


def parse_args():
    parser = argparse.ArgumentParser(description="Update a SageMaker InferenceComponent in-place")
    parser.add_argument("--ic-name", required=True, help="Deployed inference component name")
    parser.add_argument("--region", required=True, help="AWS region")
    parser.add_argument("--model-data", default=None, help="New S3 URI for model data")
    parser.add_argument("--image", default=None, help="New container image URI")
    parser.add_argument("--timeout", type=int, default=1800, help="Max seconds to wait for InService (default: 1800)")
    parser.add_argument("--poll-interval", type=int, default=30, help="Seconds between status polls (default: 30)")
    return parser.parse_args()


def describe_ic(client, ic_name):
    """Describe an inference component, return full response."""
    return client.describe_inference_component(InferenceComponentName=ic_name)


def build_update_spec(current_spec, model_data=None, image=None):
    """Build the Specification parameter for UpdateInferenceComponent.

    Only includes fields that are changing. The API merges with existing config.
    """
    spec = {}
    container = {}

    if image:
        container["Image"] = image
    if model_data:
        container["ArtifactUrl"] = model_data

    if container:
        spec["Container"] = container

    return spec if spec else None


def update_inference_component(client, ic_name, spec):
    """Call UpdateInferenceComponent with the given specification."""
    kwargs = {
        "InferenceComponentName": ic_name,
        "Specification": spec,
    }
    return client.update_inference_component(**kwargs)


def poll_until_ready(client, ic_name, timeout, poll_interval):
    """Poll DescribeInferenceComponent until InService, Failed, or timeout."""
    start = time.time()
    last_status = None

    while True:
        elapsed = int(time.time() - start)

        try:
            resp = describe_ic(client, ic_name)
            status = resp.get("InferenceComponentStatus", "Unknown")
        except ClientError as e:
            return {"error": True, "message": f"DescribeInferenceComponent failed: {e}"}

        if status != last_status:
            print(f"   {time.strftime('%H:%M:%S')} Status: {status} ({elapsed}s elapsed)...", file=sys.stderr)
            last_status = status

        if status == "InService":
            return {"status": "InService", "elapsed_seconds": elapsed}

        if status == "Failed":
            reason = resp.get("FailureReason", "Unknown")
            return {"error": True, "message": f"InferenceComponent failed: {reason}"}

        if elapsed >= timeout:
            return {"error": True, "message": f"Timeout after {timeout}s. Last status: {status}"}

        time.sleep(poll_interval)


def main():
    args = parse_args()

    client = boto3.client("sagemaker", region_name=args.region)

    # 1. Describe current IC to validate it exists
    try:
        current = describe_ic(client, args.ic_name)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "ValidationException" or "does not exist" in str(e):
            print(json.dumps({"error": True, "message": f"Inference component '{args.ic_name}' not found"}))
            sys.exit(1)
        raise

    current_status = current.get("InferenceComponentStatus", "Unknown")
    if current_status not in ("InService", "Updating"):
        print(json.dumps({
            "error": True,
            "message": f"IC is in '{current_status}' state. Must be InService to update."
        }))
        sys.exit(1)

    # 2. Build update specification
    current_spec = current.get("Specification", {})
    spec = build_update_spec(current_spec, model_data=args.model_data, image=args.image)

    if not spec:
        print(json.dumps({"error": True, "message": "Nothing to update: no --model-data or --image provided"}))
        sys.exit(1)

    # 3. Call UpdateInferenceComponent
    updated_fields = []
    if args.model_data:
        updated_fields.append("ModelDataUrl")
    if args.image:
        updated_fields.append("Image")

    print(f"🔄 Updating inference component: {args.ic_name}", file=sys.stderr)
    for field in updated_fields:
        value = args.model_data if field == "ModelDataUrl" else args.image
        print(f"   {field}: {value}", file=sys.stderr)

    try:
        update_inference_component(client, args.ic_name, spec)
    except ClientError as e:
        print(json.dumps({"error": True, "message": f"UpdateInferenceComponent failed: {e}"}))
        sys.exit(1)

    print(f"   ✅ Update submitted. Waiting for InService...", file=sys.stderr)

    # 4. Poll until InService
    result = poll_until_ready(client, args.ic_name, args.timeout, args.poll_interval)

    if result.get("error"):
        print(json.dumps(result))
        sys.exit(1)

    output = {
        "status": "InService",
        "ic_name": args.ic_name,
        "updated_fields": updated_fields,
        "elapsed_seconds": result.get("elapsed_seconds", 0),
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
