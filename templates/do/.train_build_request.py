#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build a CreateTrainingJob JSON request from CLI arguments.

Called by do/train _build_job_request() to construct the JSON payload
that is later passed to either AWS CLI or .train_helper.py for submission.

Outputs a JSON file at --output-file containing the full CreateTrainingJob request.
"""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Build CreateTrainingJob JSON request")
    parser.add_argument("--job-name", required=True)
    parser.add_argument("--role-arn", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--instance-type", required=True)
    parser.add_argument("--instance-count", default="1")
    parser.add_argument("--volume-size", default="50")
    parser.add_argument("--dataset", default="")
    parser.add_argument("--output-path", required=True)
    parser.add_argument("--max-runtime", default="86400")
    parser.add_argument("--hyperparams", default="{}")
    parser.add_argument("--enable-spot", default="false")
    parser.add_argument("--max-wait", default="172800")
    parser.add_argument("--checkpoint-path", default="")
    parser.add_argument("--metric-definitions", default="[]")
    parser.add_argument("--environment", default="{}")
    parser.add_argument("--tags", default="[]")
    parser.add_argument("--output-file", required=True)
    args = parser.parse_args()

    # Parse JSON args
    try:
        hyperparams = json.loads(args.hyperparams) if args.hyperparams else {}
    except json.JSONDecodeError:
        hyperparams = {}

    try:
        metric_definitions = json.loads(args.metric_definitions) if args.metric_definitions else []
    except json.JSONDecodeError:
        metric_definitions = []

    try:
        environment = json.loads(args.environment) if args.environment else {}
    except json.JSONDecodeError:
        environment = {}

    try:
        tags = json.loads(args.tags) if args.tags else []
    except json.JSONDecodeError:
        tags = []

    # Build the request
    request = {
        "TrainingJobName": args.job_name,
        "RoleArn": args.role_arn,
        "AlgorithmSpecification": {
            "TrainingImage": args.image,
            "TrainingInputMode": "File",
        },
        "ResourceConfig": {
            "InstanceType": args.instance_type,
            "InstanceCount": int(args.instance_count),
            "VolumeSizeInGB": int(args.volume_size),
        },
        "OutputDataConfig": {
            "S3OutputPath": args.output_path,
        },
        "StoppingCondition": {
            "MaxRuntimeInSeconds": int(args.max_runtime),
        },
    }

    # Input data channels
    if args.dataset:
        request["InputDataConfig"] = [
            {
                "ChannelName": "training",
                "DataSource": {
                    "S3DataSource": {
                        "S3DataType": "S3Prefix",
                        "S3Uri": args.dataset,
                        "S3DataDistributionType": "FullyReplicated",
                    }
                },
                "ContentType": "application/jsonlines",
            }
        ]

    # Hyperparameters (all values must be strings)
    if hyperparams:
        request["HyperParameters"] = {k: str(v) for k, v in hyperparams.items()}

    # Environment variables
    if environment:
        request["Environment"] = {k: str(v) for k, v in environment.items()}

    # Metric definitions
    if metric_definitions:
        request["AlgorithmSpecification"]["MetricDefinitions"] = metric_definitions

    # Spot training
    if args.enable_spot.lower() == "true":
        request["EnableManagedSpotTraining"] = True
        request["StoppingCondition"]["MaxWaitTimeInSeconds"] = int(args.max_wait)

    # Checkpoint config
    if args.checkpoint_path:
        request["CheckpointConfig"] = {
            "S3Uri": args.checkpoint_path,
        }

    # Tags
    if tags:
        request["Tags"] = tags

    # Write to output file
    with open(args.output_file, "w") as f:
        json.dump(request, f, indent=2)

    print(f"✅ Request written to {args.output_file}", file=sys.stderr)


if __name__ == "__main__":
    main()
