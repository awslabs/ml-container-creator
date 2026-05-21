#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Parse DescribeTrainingJob JSON response and display formatted status.

This helper is called by do/train --status to parse the AWS CLI JSON output
from DescribeTrainingJob and display a user-friendly status summary.
"""

import json
import sys
import time
from datetime import datetime, timezone


# Status emoji mapping
STATUS_EMOJI = {
    'InProgress': '🔄',
    'Completed': '✅',
    'Failed': '❌',
    'Stopping': '⏸️',
    'Stopped': '⏹️'
}

# Secondary status descriptions
SECONDARY_DESCRIPTIONS = {
    'Starting': 'Preparing training instance',
    'LaunchingMLInstances': 'Launching ML instances',
    'PreparingTrainingStack': 'Preparing training stack',
    'Downloading': 'Downloading training data',
    'DownloadingTrainingImage': 'Downloading training image',
    'Training': 'Training in progress',
    'Uploading': 'Uploading model artifacts',
    'Completed': 'Training completed',
    'MaxRuntimeExceeded': 'Max runtime exceeded',
    'Stopped': 'Training stopped',
    'MaxWaitTimeExceeded': 'Max wait time exceeded (spot)',
    'Interrupted': 'Spot instance interrupted'
}


def format_duration(seconds):
    """Format seconds into a human-readable duration string."""
    if seconds is None or seconds < 0:
        return 'N/A'
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f'{hours}h {minutes}m {secs}s'
    elif minutes > 0:
        return f'{minutes}m {secs}s'
    else:
        return f'{secs}s'


def parse_iso_time(time_str):
    """Parse an ISO 8601 timestamp string to a datetime object."""
    if not time_str:
        return None
    try:
        # Handle various AWS timestamp formats
        # Remove trailing 'Z' and replace with +00:00 for fromisoformat
        time_str = time_str.replace('Z', '+00:00')
        return datetime.fromisoformat(time_str)
    except (ValueError, TypeError):
        return None


def calculate_elapsed(start_time_str):
    """Calculate elapsed time from start to now."""
    start = parse_iso_time(start_time_str)
    if not start:
        return None
    now = datetime.now(timezone.utc)
    elapsed = (now - start).total_seconds()
    return max(0, elapsed)


def display_status(job_data):
    """Display formatted training job status."""
    job_name = job_data.get('TrainingJobName', 'Unknown')
    status = job_data.get('TrainingJobStatus', 'Unknown')
    secondary_status = job_data.get('SecondaryStatus', '')
    failure_reason = job_data.get('FailureReason', '')
    training_start = job_data.get('TrainingStartTime', '')
    training_end = job_data.get('TrainingEndTime', '')
    billable_seconds = job_data.get('BillableTimeInSeconds')
    training_seconds = job_data.get('TrainingTimeInSeconds')
    final_metrics = job_data.get('FinalMetricDataList', [])
    output_path = job_data.get('OutputDataConfig', {}).get('S3OutputPath', '')
    model_artifacts = job_data.get('ModelArtifacts', {}).get('S3ModelArtifacts', '')
    instance_type = job_data.get('ResourceConfig', {}).get('InstanceType', '')
    instance_count = job_data.get('ResourceConfig', {}).get('InstanceCount', 1)
    spot_enabled = job_data.get('EnableManagedSpotTraining', False)

    emoji = STATUS_EMOJI.get(status, '❓')

    print(f'')
    print(f'   {emoji} Status: {status}')

    # Secondary status with description
    if secondary_status:
        desc = SECONDARY_DESCRIPTIONS.get(secondary_status, '')
        if desc:
            print(f'   📍 Phase:  {secondary_status} ({desc})')
        else:
            print(f'   📍 Phase:  {secondary_status}')

    # Elapsed time
    if status == 'InProgress' and training_start:
        elapsed = calculate_elapsed(training_start)
        if elapsed is not None:
            print(f'   ⏱️  Elapsed: {format_duration(elapsed)}')
    elif training_seconds is not None:
        print(f'   ⏱️  Training time: {format_duration(training_seconds)}')

    # Instance info
    if instance_type:
        instance_info = f'{instance_type}'
        if instance_count and instance_count > 1:
            instance_info += f' x {instance_count}'
        if spot_enabled:
            instance_info += ' (spot)'
        print(f'   🖥️  Instance: {instance_info}')

    # Billable time and cost savings (for completed spot jobs)
    if status == 'Completed' and spot_enabled and billable_seconds is not None and training_seconds is not None:
        savings_seconds = training_seconds - billable_seconds
        if training_seconds > 0:
            savings_pct = (savings_seconds / training_seconds) * 100
            print(f'   💰 Spot savings: {format_duration(savings_seconds)} saved ({savings_pct:.0f}% discount)')
            print(f'      Billable: {format_duration(billable_seconds)} / Total: {format_duration(training_seconds)}')

    # Training metrics
    if final_metrics:
        print(f'   📈 Metrics:')
        for metric in final_metrics:
            name = metric.get('MetricName', 'unknown')
            value = metric.get('Value', 0)
            # Format value nicely
            if isinstance(value, float):
                if abs(value) < 0.001:
                    print(f'      {name}: {value:.6f}')
                elif abs(value) < 1:
                    print(f'      {name}: {value:.4f}')
                else:
                    print(f'      {name}: {value:.2f}')
            else:
                print(f'      {name}: {value}')

    # Output artifacts (for completed jobs)
    if status == 'Completed' and model_artifacts:
        print(f'   📦 Artifacts: {model_artifacts}')
    elif status == 'Completed' and output_path:
        print(f'   📦 Output: {output_path}')

    # Failure reason
    if status == 'Failed' and failure_reason:
        print(f'   💥 Reason: {failure_reason}')
        print(f'')
        print(f'   To start a new job: ./do/train --force')

    # Spot interruption guidance
    if secondary_status == 'Interrupted':
        print(f'')
        print(f'   ℹ️  Spot instance was interrupted. The job will automatically')
        print(f'      resume from the last checkpoint. Re-run ./do/train to poll.')

    print(f'')


def main():
    """Main entry point — reads JSON from stdin."""
    try:
        job_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f'❌ Failed to parse DescribeTrainingJob response: {e}', file=sys.stderr)
        sys.exit(1)

    display_status(job_data)


if __name__ == '__main__':
    main()
