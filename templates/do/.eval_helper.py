#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Model Quality Evaluation Helper.

Subcommands:
    evaluate   - Run evaluation against deployed endpoint, compute metrics
    eval-write - Write evaluation results to S3/Athena (Parquet)

All output is JSON on stdout for bash consumption.
"""

import argparse
import json
import math
import os
import sys
import time


# ── Utility functions ─────────────────────────────────────────────────────────

def _error_exit(message):
    """Print JSON error to stdout and exit."""
    print(json.dumps({"error": True, "message": message}))
    sys.exit(1)


def _output(data):
    """Print JSON result to stdout."""
    print(json.dumps(data))
    sys.exit(0)


# ── Endpoint invocation ───────────────────────────────────────────────────────

def _invoke_endpoint(endpoint_name, ic_name, region, payload):
    """Invoke SageMaker endpoint via boto3 runtime.

    Uses InvokeEndpoint with InferenceComponentName header for IC routing.
    Payload should be an OpenAI-compatible chat completion request.

    Returns: parsed JSON response dict
    """
    import boto3

    client = boto3.client('sagemaker-runtime', region_name=region)

    kwargs = {
        'EndpointName': endpoint_name,
        'ContentType': 'application/json',
        'Body': json.dumps(payload),
    }
    if ic_name:
        kwargs['InferenceComponentName'] = ic_name

    try:
        response = client.invoke_endpoint(**kwargs)
        body = response['Body'].read().decode('utf-8')
        return json.loads(body)
    except Exception as e:
        return {"error": str(e)}


def _score_text(endpoint_name, ic_name, region, prompt, completion):
    """Score a completion by getting its logprobs via the endpoint.

    Sends prompt + completion and requests logprobs for the completion tokens.
    Returns sum of token logprobs, or None if logprobs unavailable.
    """
    messages = [
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": completion},
    ]

    payload = {
        "messages": messages,
        "max_tokens": 1,
        "temperature": 0.0,
        "logprobs": True,
        "top_logprobs": 1,
    }

    response = _invoke_endpoint(endpoint_name, ic_name, region, payload)

    if "error" in response:
        return None

    # Extract logprobs from response
    try:
        choices = response.get("choices", [])
        if not choices:
            return None

        # For scoring, we need the logprobs of the completion tokens
        # The response format varies — try OpenAI-compatible format
        logprobs_data = choices[0].get("logprobs")
        if logprobs_data and "content" in logprobs_data:
            token_logprobs = [t.get("logprob", 0.0) for t in logprobs_data["content"]]
            return sum(token_logprobs) if token_logprobs else None

        return None
    except (KeyError, TypeError, IndexError):
        return None


def _generate_response(endpoint_name, ic_name, region, prompt, max_tokens=256):
    """Generate a response from the endpoint for generation-based metrics.

    Returns: generated text string, or None on failure.
    """
    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.0,
    }

    response = _invoke_endpoint(endpoint_name, ic_name, region, payload)

    if "error" in response:
        return None

    try:
        choices = response.get("choices", [])
        if choices:
            return choices[0].get("message", {}).get("content", "")
        return None
    except (KeyError, TypeError, IndexError):
        return None


# ── Metric computation ────────────────────────────────────────────────────────

def _compute_sft_metrics(endpoint_name, ic_name, region, dataset, samples):
    """Compute SFT evaluation metrics.

    Metrics: perplexity (via logprobs), avg_response_length, format_compliance, exact_match
    """
    metrics = {}
    logprob_scores = []
    response_lengths = []
    exact_matches = 0
    total = 0

    for i, record in enumerate(dataset):
        if samples and i >= samples:
            break

        prompt = record.get("prompt", "")
        reference = record.get("reference", "")

        if not prompt:
            continue

        total += 1

        # Score via logprobs (for perplexity)
        if reference:
            score = _score_text(endpoint_name, ic_name, region, prompt, reference)
            if score is not None:
                # Approximate per-token logprob
                # score is sum of logprobs; we need per-token average
                # Estimate token count from character length (rough: 4 chars/token)
                est_tokens = max(1, len(reference) // 4)
                logprob_scores.append(score / est_tokens)

        # Generate response (for length and exact match)
        generated = _generate_response(endpoint_name, ic_name, region, prompt)
        if generated is not None:
            response_lengths.append(len(generated.split()))
            if reference and generated.strip() == reference.strip():
                exact_matches += 1

    # Compute aggregate metrics
    if logprob_scores:
        avg_logprob = sum(logprob_scores) / len(logprob_scores)
        metrics["perplexity"] = round(math.exp(-avg_logprob), 4)

    if response_lengths:
        metrics["avg_response_length"] = round(sum(response_lengths) / len(response_lengths), 1)

    if total > 0:
        metrics["exact_match_accuracy"] = round(exact_matches / total, 4)

    metrics["samples_scored"] = total

    return metrics


def _compute_dpo_metrics(endpoint_name, ic_name, region, dataset, samples):
    """Compute DPO evaluation metrics.

    Metrics: reward_accuracy, avg_chosen_logprob, avg_rejected_logprob, reward_margin
    """
    metrics = {}
    chosen_scores = []
    rejected_scores = []
    reward_correct = 0
    total = 0

    for i, record in enumerate(dataset):
        if samples and i >= samples:
            break

        prompt = record.get("prompt", "")
        chosen = record.get("chosen", "")
        rejected = record.get("rejected", "")

        if not prompt or not chosen or not rejected:
            continue

        total += 1

        # Score chosen
        chosen_score = _score_text(endpoint_name, ic_name, region, prompt, chosen)
        # Score rejected
        rejected_score = _score_text(endpoint_name, ic_name, region, prompt, rejected)

        if chosen_score is not None and rejected_score is not None:
            chosen_scores.append(chosen_score)
            rejected_scores.append(rejected_score)
            if chosen_score > rejected_score:
                reward_correct += 1

    # Compute aggregate metrics
    scored = len(chosen_scores)
    if scored > 0:
        metrics["reward_accuracy"] = round(reward_correct / scored, 4)
        metrics["avg_chosen_logprob"] = round(sum(chosen_scores) / scored, 4)
        metrics["avg_rejected_logprob"] = round(sum(rejected_scores) / scored, 4)
        metrics["reward_margin"] = round(
            (sum(chosen_scores) - sum(rejected_scores)) / scored, 4
        )

    metrics["pairs_scored"] = scored
    metrics["samples_evaluated"] = total

    return metrics


# ── Dataset loading ───────────────────────────────────────────────────────────

def _load_eval_dataset(eval_dataset_path):
    """Load evaluation dataset from local JSONL file or S3.

    For this MVP, expects a local JSONL file path.
    S3 and HF resolution is handled by the bash wrapper.

    Returns: list of dicts
    """
    records = []

    if not eval_dataset_path:
        _error_exit("No evaluation dataset specified. Use --eval-dataset <path>")

    # Handle S3 paths by downloading
    if eval_dataset_path.startswith("s3://"):
        import boto3
        import tempfile
        s3 = boto3.client('s3')
        bucket = eval_dataset_path.split('/')[2]
        key = '/'.join(eval_dataset_path.split('/')[3:])
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.jsonl')
        s3.download_file(bucket, key, tmp.name)
        eval_dataset_path = tmp.name

    # Load JSONL
    try:
        with open(eval_dataset_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    except (IOError, json.JSONDecodeError) as e:
        _error_exit(f"Failed to load eval dataset: {e}")

    if not records:
        _error_exit("Evaluation dataset is empty")

    return records


# ── cmd_evaluate ──────────────────────────────────────────────────────────────

def cmd_evaluate(args):
    """Run evaluation against deployed endpoint.

    Returns JSON with metrics and metadata.
    """
    endpoint_name = args.endpoint_name
    ic_name = args.ic_name
    region = args.region or os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')
    technique = args.technique or ''
    samples = int(args.samples) if args.samples else None

    # Load eval dataset
    dataset = _load_eval_dataset(args.eval_dataset)

    # Determine technique and compute metrics
    if technique.lower() == 'dpo':
        metrics = _compute_dpo_metrics(endpoint_name, ic_name, region, dataset, samples)
    else:
        # Default to SFT metrics (works for any technique)
        metrics = _compute_sft_metrics(endpoint_name, ic_name, region, dataset, samples)

    # Build result
    result = {
        "adapter_name": args.ic_name,
        "technique": technique or "sft",
        "model": os.environ.get("MODEL_NAME", ""),
        "eval_dataset": args.eval_dataset or "",
        "samples_evaluated": metrics.get("samples_evaluated", metrics.get("samples_scored", 0)),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": metrics,
    }

    _output(result)


# ── cmd_eval_write ────────────────────────────────────────────────────────────

def cmd_eval_write(args):
    """Write evaluation results to S3 as Parquet for Athena.

    Reads a results JSON file and converts to Parquet format.
    """
    results_file = args.results_file
    bucket = args.bucket
    region = args.region or os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')

    # Read results
    try:
        with open(results_file, 'r') as f:
            data = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        _error_exit(f"Failed to read results file: {e}")

    adapter_name = data.get("adapter_name", "unknown")
    technique = data.get("technique", "unknown")
    model = data.get("model", "unknown")
    timestamp = data.get("timestamp", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    # Build Parquet record
    record = {
        "project_name": os.environ.get("PROJECT_NAME", ""),
        "model_name": model,
        "adapter_name": adapter_name,
        "technique": technique,
        "eval_dataset": data.get("eval_dataset", ""),
        "samples_evaluated": data.get("samples_evaluated", 0),
        "metrics": json.dumps(data.get("metrics", {})),
        "timestamp": timestamp,
        "region": region,
    }

    # Write as JSON lines (Athena can read JSON as well as Parquet)
    # For MVP, write as JSON lines to S3. Parquet requires pyarrow dep.
    s3_key = f"evaluations/model={model}/adapter={adapter_name}/{timestamp.replace(':', '-')}.json"
    s3_uri = f"s3://{bucket}/{s3_key}"

    try:
        import boto3
        s3 = boto3.client('s3', region_name=region)
        s3.put_object(
            Bucket=bucket,
            Key=s3_key,
            Body=json.dumps(record),
            ContentType='application/json',
        )
        _output({"written": True, "s3_uri": s3_uri})
    except Exception as e:
        _error_exit(f"Failed to write to S3: {e}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Model Quality Evaluation Helper')
    subparsers = parser.add_subparsers(dest='command', required=True)

    # evaluate
    eval_parser = subparsers.add_parser('evaluate', help='Run evaluation')
    eval_parser.add_argument('--endpoint-name', required=True)
    eval_parser.add_argument('--ic-name', required=True)
    eval_parser.add_argument('--region')
    eval_parser.add_argument('--technique', default='')
    eval_parser.add_argument('--eval-dataset', default='')
    eval_parser.add_argument('--samples', default='')
    eval_parser.add_argument('--metrics', default='')

    # eval-write
    write_parser = subparsers.add_parser('eval-write', help='Write results to S3')
    write_parser.add_argument('--results-file', required=True)
    write_parser.add_argument('--bucket', required=True)
    write_parser.add_argument('--region')

    args = parser.parse_args()

    if args.command == 'evaluate':
        cmd_evaluate(args)
    elif args.command == 'eval-write':
        cmd_eval_write(args)
    else:
        _error_exit(f"Unknown command: {args.command}")


if __name__ == '__main__':
    main()
