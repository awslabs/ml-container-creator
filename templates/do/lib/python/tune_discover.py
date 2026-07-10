from __future__ import annotations
"""Tune discover: query JumpStart Hub for tune-eligible models.

Purpose: cmd_discover subcommand for do/tune
Inputs: --family, --filter, --region
Outputs: JSON with models list and count
Caller: .tune_helper.py dispatcher
Related: tune_submit.py (submits jobs for discovered models)

NOTE: This subcommand intentionally stays on boto3.client('sagemaker')
because list_hub_contents / Hub API is NOT available in sagemaker-core.
This is a documented exception per the SDK v3 migration policy.
"""

import os

from common import _output, _error_exit


def cmd_discover(args):
    """Query JumpStart Hub for tune-eligible models matching a family.

    Returns: {"models": [str], "count": int}
    """
    region = args.region or os.environ.get('AWS_REGION', 'us-east-1')

    family = args.family or ""
    # Map family names to Hub content name prefixes
    FAMILY_PREFIX_MAP = {
        "qwen-2.5": "huggingface-llm-qwen2-5",
        "qwen-3": "huggingface-reasoning-qwen3",
        "llama-3": "meta-textgeneration-llama-3",
        "deepseek-r1": "deepseek-llm-r1-distill",
        "gpt-oss": "openai-reasoning-gpt-oss",
    }

    prefix = FAMILY_PREFIX_MAP.get(family, args.filter or "")
    if not prefix:
        _error_exit("No family or filter provided for discovery")

    try:
        import boto3
    except ImportError:
        _error_exit("Hub discovery failed: boto3 is not installed. Install with: pip install boto3")

    try:
        # Documented exception: Hub API (list_hub_contents) is not available in
        # sagemaker-core, so we retain boto3.client('sagemaker') here.
        client = boto3.client("sagemaker", region_name=region)
        models = []
        paginator = client.get_paginator('list_hub_contents')
        pages = paginator.paginate(
            HubName="SageMakerPublicHub",
            HubContentType="Model",
            NameContains=prefix,
            MaxResults=20
        )
        for page in pages:
            for item in page.get('HubContentSummaries', []):
                if item.get('HubContentStatus') == 'Available':
                    models.append(item['HubContentName'])

        _output({"models": models[:5], "count": len(models)})

    except Exception as e:
        _error_exit(f"Hub discovery failed: {e}")
