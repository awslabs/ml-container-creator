#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Build the CreateTrainingJob JSON request for SageMaker.

This helper is called by do/train to construct the full API request body.
It handles conditional fields (spot training, metric definitions, environment,
tags) and writes the result to a JSON file for use with:
    aws sagemaker create-training-job --cli-input-json file://path.json
"""

import argparse
import json
import sys


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description='Build CreateTrainingJob request JSON')
    parser.add_argument('--job-name', required=True, help='Training job name')
    parser.add_argument('--role-arn', required=True, help='SageMaker execution role ARN')
    parser.add_argument('--image', required=True, help='Training container image URI')
    parser.add_argument('--instance-type', required=True, help='Instance type')
    parser.add_argument('--instance-count', required=True, help='Instance count')
    parser.add_argument('--volume-size', required=True, help='Volume size in GB')
    parser.add_argument('--dataset', required=True, help='S3 URI for training dataset')
    parser.add_argument('--output-path', required=True, help='S3 URI for output')
    parser.add_argument('--max-runtime', required=True, help='Max runtime in seconds')
    parser.add_argument('--hyperparams', required=True, help='Hyperparameters as JSON string')
    parser.add_argument('--enable-spot', required=True, help='Enable spot training (true/false)')
    parser.add_argument('--max-wait', required=True, help='Max wait time for spot in seconds')
    parser.add_argument('--checkpoint-path', required=True, help='S3 checkpoint path')
    parser.add_argument('--metric-definitions', required=True, help='Metric definitions as JSON array')
    parser.add_argument('--environment', required=True, help='Environment variables as JSON object')
    parser.add_argument('--tags', required=True, help='Tags as JSON object (key-value map)')
    parser.add_argument('--output-file', required=True, help='Output file path for the JSON')
    return parser.parse_args()


def build_request(args):
    """Construct the CreateTrainingJob request dictionary."""
    # Parse JSON inputs
    hyperparams = json.loads(args.hyperparams) if args.hyperparams else {}
    metric_definitions = json.loads(args.metric_definitions) if args.metric_definitions else []
    environment = json.loads(args.environment) if args.environment else {}
    tags = json.loads(args.tags) if args.tags else {}

    # Base request structure
    request = {
        'TrainingJobName': args.job_name,
        'RoleArn': args.role_arn,
        'AlgorithmSpecification': {
            'TrainingImage': args.image,
            'TrainingInputMode': 'File'
        },
        'InputDataConfig': [
            {
                'ChannelName': 'training',
                'DataSource': {
                    'S3DataSource': {
                        'S3DataType': 'S3Prefix',
                        'S3Uri': args.dataset,
                        'S3DataDistributionType': 'FullyReplicated'
                    }
                }
            }
        ],
        'OutputDataConfig': {
            'S3OutputPath': args.output_path
        },
        'ResourceConfig': {
            'InstanceType': args.instance_type,
            'InstanceCount': int(args.instance_count),
            'VolumeSizeInGB': int(args.volume_size)
        },
        'StoppingCondition': {
            'MaxRuntimeInSeconds': int(args.max_runtime)
        }
    }

    # Hyperparameters — ensure all values are strings (SageMaker requirement)
    if hyperparams:
        request['HyperParameters'] = {
            str(k): str(v) for k, v in hyperparams.items()
        }

    # Managed spot training
    if args.enable_spot == 'true':
        request['EnableManagedSpotTraining'] = True
        request['StoppingCondition']['MaxWaitTimeInSeconds'] = int(args.max_wait)

    # Checkpoint configuration (for spot training resumption)
    if args.checkpoint_path:
        request['CheckpointConfig'] = {
            'S3Uri': args.checkpoint_path
        }

    # Metric definitions (custom CloudWatch metrics)
    if metric_definitions and metric_definitions != []:
        request['AlgorithmSpecification']['MetricDefinitions'] = [
            {'Name': m['name'], 'Regex': m['regex']}
            for m in metric_definitions
        ]

    # Environment variables for the container
    if environment and environment != {}:
        request['Environment'] = environment

    # Tags — convert from {key: value} map to [{Key: k, Value: v}] array
    if tags and tags != {}:
        request['Tags'] = [
            {'Key': str(k), 'Value': str(v)}
            for k, v in tags.items()
        ]

    return request


def main():
    """Main entry point."""
    args = parse_args()

    try:
        request = build_request(args)
    except (json.JSONDecodeError, ValueError) as e:
        print(f'❌ Failed to build request: {e}', file=sys.stderr)
        sys.exit(1)

    # Write the JSON request to the output file
    try:
        with open(args.output_file, 'w') as f:
            json.dump(request, f, indent=2)
    except IOError as e:
        print(f'❌ Failed to write request file: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
