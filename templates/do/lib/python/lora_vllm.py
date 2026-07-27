#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""
lora_vllm.py — Helper for vLLM LoRA adapter hot-loading via REST API.

Used by do/adapter on HyperPod EKS deployments to load/unload/list LoRA adapters
through vLLM's built-in REST endpoints.

Usage (CLI mode):
    python3 lora_vllm.py load <name> <s3_path> <base_url>
    python3 lora_vllm.py unload <name> <base_url>
    python3 lora_vllm.py list <base_url>
"""

import json
import sys

import requests


def load_lora(base_url: str, name: str, s3_path: str) -> dict:
    """Load a LoRA adapter into vLLM.

    POST /v1/load_lora_adapter with {"lora_name": name, "lora_path": s3_path}.

    Returns:
        {"success": True} on success.
        {"success": False, "error": "...", "status_code": N} on failure.
    """
    url = f"{base_url.rstrip('/')}/v1/load_lora_adapter"
    payload = {"lora_name": name, "lora_path": s3_path}

    try:
        resp = requests.post(url, json=payload, timeout=60)
        if resp.status_code == 200:
            return {"success": True}
        else:
            error_msg = resp.text
            try:
                error_msg = resp.json().get("message", resp.text)
            except (ValueError, KeyError):
                pass
            return {
                "success": False,
                "error": error_msg,
                "status_code": resp.status_code,
            }
    except requests.exceptions.RequestException as e:
        return {"success": False, "error": str(e), "status_code": 0}


def unload_lora(base_url: str, name: str) -> dict:
    """Unload a LoRA adapter from vLLM.

    POST /v1/unload_lora_adapter with {"lora_name": name}.

    Returns:
        {"success": True} on success.
        {"success": False, "error": "...", "status_code": N} on failure.
    """
    url = f"{base_url.rstrip('/')}/v1/unload_lora_adapter"
    payload = {"lora_name": name}

    try:
        resp = requests.post(url, json=payload, timeout=30)
        if resp.status_code == 200:
            return {"success": True}
        else:
            error_msg = resp.text
            try:
                error_msg = resp.json().get("message", resp.text)
            except (ValueError, KeyError):
                pass
            return {
                "success": False,
                "error": error_msg,
                "status_code": resp.status_code,
            }
    except requests.exceptions.RequestException as e:
        return {"success": False, "error": str(e), "status_code": 0}


def list_loras(base_url: str) -> list:
    """List loaded LoRA adapters on a vLLM instance.

    GET /v1/models, filter entries that are not the base model.

    Returns:
        List of {"name": ..., "path": ...} dicts for LoRA adapters.
        Returns empty list on error.
    """
    url = f"{base_url.rstrip('/')}/v1/models"

    try:
        resp = requests.get(url, timeout=30)
        if resp.status_code != 200:
            return []
        data = resp.json()
        models = data.get("data", [])

        # The first model in the list is typically the base model.
        # LoRA adapters have "parent" field or are listed after the base model.
        # Filter: entries where root is False, or that have a parent field,
        # or simply all entries after the first one (base model).
        if not models:
            return []

        # vLLM marks the base model with root=True or lists it first.
        # Adapters typically have a "parent" key set to the base model.
        loras = []
        base_model_id = models[0].get("id", "") if models else ""

        for model in models:
            model_id = model.get("id", "")
            # Skip the base model
            if model_id == base_model_id:
                continue
            # This is a LoRA adapter
            loras.append({
                "name": model_id,
                "path": model.get("root", model_id),
            })

        return loras
    except requests.exceptions.RequestException:
        return []


def _cli_main():
    """CLI entry point for bash integration."""
    if len(sys.argv) < 3:
        print("Usage: python3 lora_vllm.py <command> <args...>", file=sys.stderr)
        print("Commands: load <name> <s3_path> <base_url>", file=sys.stderr)
        print("          unload <name> <base_url>", file=sys.stderr)
        print("          list <base_url>", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]

    if command == "load":
        if len(sys.argv) != 5:
            print("Usage: python3 lora_vllm.py load <name> <s3_path> <base_url>", file=sys.stderr)
            sys.exit(1)
        name, s3_path, base_url = sys.argv[2], sys.argv[3], sys.argv[4]
        result = load_lora(base_url, name, s3_path)
        print(json.dumps(result))
        sys.exit(0 if result["success"] else 1)

    elif command == "unload":
        if len(sys.argv) != 4:
            print("Usage: python3 lora_vllm.py unload <name> <base_url>", file=sys.stderr)
            sys.exit(1)
        name, base_url = sys.argv[2], sys.argv[3]
        result = unload_lora(base_url, name)
        print(json.dumps(result))
        sys.exit(0 if result["success"] else 1)

    elif command == "list":
        if len(sys.argv) != 3:
            print("Usage: python3 lora_vllm.py list <base_url>", file=sys.stderr)
            sys.exit(1)
        base_url = sys.argv[2]
        loras = list_loras(base_url)
        print(json.dumps(loras))
        sys.exit(0)

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _cli_main()
