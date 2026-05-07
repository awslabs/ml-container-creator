# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0


#!/usr/bin/env python3
"""
Local testing script for transformers models

This script allows you to test your model locally before containerizing.
Unlike serve.py (which runs a production HTTP server), this is a CLI tool
for development and debugging.

Usage examples:
  # Test with array input
  python test_model_handler.py --input-data '[[1,2,3,4]]'
  
  # Test with SageMaker format
  python test_model_handler.py --input-data '{"instances": [[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]}'
  
  # Custom model path
  python test_model_handler.py --model-path ./ --input-data '[[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]'

This is NOT used in production - serve.py handles containerized inference.
"""
import json
import argparse
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'code'))
from model_handler import ModelHandler

def usage():
    """Print usage examples and exit"""
    print("\nTRANSFORMERS Model Handler Test Tool")
    print("=" * 40)
    print("\nUsage examples:")
    print("  # Basic test with array input:")
    print("  python test_model_handler.py --input-data '[[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]'")
    print("\n  # SageMaker format:")
    print("  python test_model_handler.py --input-data '{\"instances\": [[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]}'")
    print("\n  # Custom model path:")
    print("  python test_model_handler.py --model-path ../sample_model --input-data '[[1, 0.455, 0.365, 0.095, 0.514, 0.2245, 0.101, 0.15]]'")
    print("\n  # Show this help:")
    print("  python test_model_handler.py --help")
    print("\nNote: This is for local testing only. Production uses serve.py in containers.\n")
    sys.exit(0)

def main():
    parser = argparse.ArgumentParser(
        description='Local CLI tool for testing transformers model inference',
        epilog='Use --usage for detailed examples'
    )
    parser.add_argument('--model-path', type=str, default='sample_model',
                        help='Path to model directory (default: sample_model)')
    parser.add_argument('--input-data', type=str,
                        help='Input data as application/json string')
    parser.add_argument('--usage', action='store_true',
                        help='Show detailed usage examples')

    args = parser.parse_args()

    if args.usage:
        usage()

    if not args.input_data:
        print("Error: --input-data is required")
        print("Use --usage for examples or --help for options")
        sys.exit(1)

    print(f"Loading model from: {args.model_path}")
    handler = ModelHandler(args.model_path)
    handler.load_model()

    try:
        input_data = json.loads(args.input_data)
    except json.JSONDecodeError:
        input_data = args.input_data

    print("Running inference...")
    result = handler.predict(input_data)
    print("\nResult:")
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()

