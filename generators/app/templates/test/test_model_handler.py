# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

<% if (framework === 'sglang') { %>
#!/usr/bin/env python3
"""
Local testing script for SGLang models

This script allows you to test your SGLang model locally before containerizing.
Unlike serve.py (which runs a production HTTP server), this is a CLI tool
for development and debugging.

Usage examples:
  # Test with text input
  python test_model_handler.py --input-data '"Hello, how are you?"'

  # Test with SageMaker format
  python test_model_handler.py --input-data '{"instances": ["Hello, world!", "How are you?"]}'

  # Custom model
  python test_model_handler.py --model-id microsoft/DialoGPT-small --input-data '"Hello!"'

This is NOT used in production - serve.py handles containerized inference.
"""
import json
import argparse
import sys
import os
import asyncio
from sglang import Runtime

def usage():
    """Print usage examples and exit"""
    print("\nSGLANG Model Handler Test Tool")
    print("=" * 40)
    print("\nUsage examples:")
    print("  # Basic test with text input:")
    print('  python test_model_handler.py --input-data \'"Hello, how are you?"\'')
    print("\n  # SageMaker format:")
    print('  python test_model_handler.py --input-data \'{"instances": ["Hello!", "How are you?"]}\'')
    print("\n  # Custom model:")
    print('  python test_model_handler.py --model-id microsoft/DialoGPT-small --input-data \'"Hello!"\'')
    print("\n  # Show this help:")
    print("  python test_model_handler.py --help")
    print("\nNote: This is for local testing only. Production uses serve.py in containers.\n")
    sys.exit(0)

async def main():
    parser = argparse.ArgumentParser(
        description='Local CLI tool for testing SGLang model inference',
        epilog='Use --usage for detailed examples'
    )
    parser.add_argument('--model-id', type=str, default='<%= model || "microsoft/DialoGPT-medium" %>',
                        help='Model ID to load (default: <%= model || "microsoft/DialoGPT-medium" %>)')
    parser.add_argument('--input-data', type=str,
                        help='Input data as JSON string')
    parser.add_argument('--usage', action='store_true',
                        help='Show detailed usage examples')

    args = parser.parse_args()

    if args.usage:
        usage()

    if not args.input_data:
        print("Error: --input-data is required")
        print("Use --usage for examples or --help for options")
        sys.exit(1)

    print(f"Loading SGLang model: {args.model_id}")
    runtime = Runtime(
        model_path=args.model_id,
        tokenizer_path=args.model_id,
        device="cuda" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu",
        mem_fraction_static=0.8
    )

    try:
        input_data = json.loads(args.input_data)
    except json.JSONDecodeError:
        input_data = args.input_data

    # Extract prompts
    if isinstance(input_data, dict):
        prompts = input_data.get('instances', input_data.get('inputs', [input_data]))
    else:
        prompts = [input_data]

    print("Running inference...")
    outputs = runtime.generate(prompts)

    result = {'predictions': outputs}
    print("\nResult:")
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
<% } else { %>
#!/usr/bin/env python3
"""
Local testing script for <%= framework %> models

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
    print("\n<%= framework.toUpperCase() %> Model Handler Test Tool")
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
        description='Local CLI tool for testing <%= framework %> model inference',
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
<% } %>
