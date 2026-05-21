#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Parse DescribeTrainingJob JSON for the polling loop in do/train.

Reads JSON from stdin and outputs structured key=value lines for bash consumption:
  STATUS=<TrainingJobStatus>
  SECONDARY=<SecondaryStatus>
  FAILURE_REASON=<FailureReason or empty>
  DISPLAY=<formatted single-line status display>

This keeps the bash poll loop simple while handling JSON parsing in Python.
"""

import json
import sys
from datetime import datetime, timezone


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


def format_metrics(final_metrics):
    """Format FinalMetricDataList into a compact string."""
    if not final_metrics:
        return ''
    parts = []
    for metric in final_metrics:
        name = metric.get('MetricName', 'unknown')
        value = metric.get('Value', 0)
        if isinstance(value, float):
            if abs(value) < 0.001:
                parts.append(f'{name}={value:.6f}')
            elif abs(value) < 1:
                parts.append(f'{name}={value:.4f}')
            else:
                parts.append(f'{name}={value:.2f}')
        else:
            parts.append(f'{name}={value}')
    return ', '.join(parts)


# Status emoji mapping
STATUS_EMOJI = {
    'InProgress': '🔄',
    'Completed': '✅',
    'Failed': '❌',
    'Stopping': '⏸️',
    'Stopped': '⏹️'
}


def main():
    """Parse DescribeTrainingJob JSON from stdin and output structured lines."""
    try:
        job_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f'Error parsing JSON: {e}', file=sys.stderr)
        sys.exit(1)

    status = job_data.get('TrainingJobStatus', 'Unknown')
    secondary_status = job_data.get('SecondaryStatus', '')
    failure_reason = job_data.get('FailureReason', '')
    training_start = job_data.get('TrainingStartTime', '')
    final_metrics = job_data.get('FinalMetricDataList', [])

    # Calculate elapsed time
    elapsed_str = ''
    if training_start:
        elapsed = calculate_elapsed(training_start)
        if elapsed is not None:
            elapsed_str = format_duration(elapsed)

    # Format metrics
    metrics_str = format_metrics(final_metrics)

    # Build display line
    emoji = STATUS_EMOJI.get(status, '❓')
    display_parts = [f'   {emoji} {status}']

    if secondary_status:
        display_parts.append(f'| {secondary_status}')

    if elapsed_str:
        display_parts.append(f'| elapsed: {elapsed_str}')

    if metrics_str:
        display_parts.append(f'| {metrics_str}')

    display_line = ' '.join(display_parts)

    # Output structured lines for bash
    print(f'STATUS={status}')
    print(f'SECONDARY={secondary_status}')
    print(f'FAILURE_REASON={failure_reason}')
    print(f'DISPLAY={display_line}')


if __name__ == '__main__':
    main()
