/**
 * Framework Registry
 * 
 * Stores framework-specific configurations including base images, environment variables,
 * SageMaker settings, and accelerator requirements.
 * 
 * Schema:
 * {
 *   "framework_name": {
 *     "version": {
 *       baseImage: string,
 *       accelerator: {
 *         type: "cuda" | "neuron" | "cpu" | "rocm",
 *         version: string | null,
 *         versionRange: { min: string, max: string }
 *       },
 *       envVars: { [key: string]: string },
 *       inferenceAmiVersion: string,
 *       recommendedInstanceTypes: string[],
 *       validationLevel: "tested" | "community-validated" | "experimental" | "unknown",
 *       profiles?: {
 *         [profileName: string]: {
 *           displayName: string,
 *           description: string,
 *           envVars: { [key: string]: string },
 *           recommendedInstanceTypes?: string[],
 *           notes?: string
 *         }
 *       },
 *       notes?: string
 *     }
 *   }
 * }
 */

export default {
    'vllm': {
        '0.3.0': {
            baseImage: 'vllm/vllm-openai:v0.3.0',
            accelerator: {
                type: 'cuda',
                version: '12.1',
                versionRange: { min: '11.8', max: '12.2' }
            },
            envVars: {
                'VLLM_TENSOR_PARALLEL_SIZE': '1',
                'VLLM_GPU_MEMORY_UTILIZATION': '0.9',
                'VLLM_MAX_NUM_SEQS': '256',
                'VLLM_MAX_MODEL_LEN': '4096'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge'],
            validationLevel: 'community-validated',
            profiles: {
                'low-latency': {
                    displayName: 'Low Latency',
                    description: 'Optimized for single-request latency with smaller batch sizes',
                    envVars: {
                        'VLLM_MAX_NUM_SEQS': '32',
                        'VLLM_GPU_MEMORY_UTILIZATION': '0.85'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge'],
                    notes: 'Best for real-time inference with low latency requirements'
                },
                'high-throughput': {
                    displayName: 'High Throughput',
                    description: 'Optimized for batch processing with larger batch sizes',
                    envVars: {
                        'VLLM_MAX_NUM_SEQS': '512',
                        'VLLM_GPU_MEMORY_UTILIZATION': '0.95',
                        'VLLM_MAX_MODEL_LEN': '2048'
                    },
                    recommendedInstanceTypes: ['ml.g5.4xlarge', 'ml.g5.12xlarge'],
                    notes: 'Best for high-throughput batch inference workloads'
                }
            },
            notes: 'vLLM 0.3.0 supports CUDA 11.8-12.2. Requires NVIDIA GPU with compute capability 7.0+'
        },
        '0.4.0': {
            baseImage: 'vllm/vllm-openai:v0.4.0',
            accelerator: {
                type: 'cuda',
                version: '12.1',
                versionRange: { min: '12.0', max: '12.3' }
            },
            envVars: {
                'VLLM_TENSOR_PARALLEL_SIZE': '1',
                'VLLM_GPU_MEMORY_UTILIZATION': '0.9',
                'VLLM_MAX_NUM_SEQS': '256',
                'VLLM_MAX_MODEL_LEN': '4096',
                'VLLM_ENABLE_PREFIX_CACHING': 'true'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.12xlarge'],
            validationLevel: 'tested',
            profiles: {
                'low-latency': {
                    displayName: 'Low Latency',
                    description: 'Optimized for single-request latency with prefix caching',
                    envVars: {
                        'VLLM_MAX_NUM_SEQS': '32',
                        'VLLM_GPU_MEMORY_UTILIZATION': '0.85',
                        'VLLM_ENABLE_PREFIX_CACHING': 'true'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge'],
                    notes: 'Prefix caching improves latency for repeated prompts'
                },
                'high-throughput': {
                    displayName: 'High Throughput',
                    description: 'Optimized for batch processing with continuous batching',
                    envVars: {
                        'VLLM_MAX_NUM_SEQS': '512',
                        'VLLM_GPU_MEMORY_UTILIZATION': '0.95',
                        'VLLM_MAX_MODEL_LEN': '2048',
                        'VLLM_ENABLE_PREFIX_CACHING': 'false'
                    },
                    recommendedInstanceTypes: ['ml.g5.4xlarge', 'ml.g5.12xlarge'],
                    notes: 'Continuous batching maximizes GPU utilization'
                },
                'multi-gpu': {
                    displayName: 'Multi-GPU',
                    description: 'Tensor parallel across multiple GPUs for large models',
                    envVars: {
                        'VLLM_TENSOR_PARALLEL_SIZE': '4',
                        'VLLM_GPU_MEMORY_UTILIZATION': '0.9',
                        'VLLM_MAX_NUM_SEQS': '256'
                    },
                    recommendedInstanceTypes: ['ml.g5.12xlarge', 'ml.g5.48xlarge'],
                    notes: 'Requires instance with 4+ GPUs. Set TENSOR_PARALLEL_SIZE to match GPU count'
                }
            },
            notes: 'vLLM 0.4.0 adds prefix caching and improved performance. Requires CUDA 12.0+'
        }
    },
    'tensorrt-llm': {
        '0.8.0': {
            baseImage: 'nvidia/tensorrt-llm:0.8.0-py3',
            accelerator: {
                type: 'cuda',
                version: '12.1',
                versionRange: { min: '12.0', max: '12.2' }
            },
            envVars: {
                'TRTLLM_TENSOR_PARALLEL_SIZE': '1',
                'TRTLLM_PIPELINE_PARALLEL_SIZE': '1',
                'TRTLLM_MAX_BATCH_SIZE': '8',
                'TRTLLM_MAX_INPUT_LEN': '2048',
                'TRTLLM_MAX_OUTPUT_LEN': '512',
                'UCX_MEMTYPE_CACHE': 'n'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
            recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.12xlarge'],
            validationLevel: 'community-validated',
            profiles: {
                'fp16': {
                    displayName: 'FP16 Precision',
                    description: 'Half-precision inference for balanced performance and accuracy',
                    envVars: {
                        'TRTLLM_DTYPE': 'float16',
                        'TRTLLM_MAX_BATCH_SIZE': '16'
                    },
                    recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge'],
                    notes: 'Good balance between speed and accuracy'
                },
                'int8': {
                    displayName: 'INT8 Quantization',
                    description: '8-bit quantization for maximum throughput',
                    envVars: {
                        'TRTLLM_DTYPE': 'int8',
                        'TRTLLM_MAX_BATCH_SIZE': '32',
                        'TRTLLM_USE_WEIGHT_ONLY': 'true'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
                    notes: 'Reduces memory usage and increases throughput with minimal accuracy loss'
                }
            },
            notes: 'TensorRT-LLM 0.8.0 requires CUDA 12.0+. UCX_MEMTYPE_CACHE=n disables UCX memory caching to avoid issues'
        },
        '1.0.0': {
            baseImage: 'nvidia/tensorrt-llm:1.0.0-py3',
            accelerator: {
                type: 'cuda',
                version: '12.2',
                versionRange: { min: '12.1', max: '12.3' }
            },
            envVars: {
                'TRTLLM_TENSOR_PARALLEL_SIZE': '1',
                'TRTLLM_PIPELINE_PARALLEL_SIZE': '1',
                'TRTLLM_MAX_BATCH_SIZE': '8',
                'TRTLLM_MAX_INPUT_LEN': '2048',
                'TRTLLM_MAX_OUTPUT_LEN': '512',
                'TRTLLM_ENABLE_CHUNKED_CONTEXT': 'true',
                'UCX_MEMTYPE_CACHE': 'n'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.12xlarge', 'ml.g5.48xlarge'],
            validationLevel: 'tested',
            profiles: {
                'fp16': {
                    displayName: 'FP16 Precision',
                    description: 'Half-precision inference with chunked context support',
                    envVars: {
                        'TRTLLM_DTYPE': 'float16',
                        'TRTLLM_MAX_BATCH_SIZE': '16',
                        'TRTLLM_ENABLE_CHUNKED_CONTEXT': 'true'
                    },
                    recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge'],
                    notes: 'Chunked context allows processing longer sequences'
                },
                'int8': {
                    displayName: 'INT8 Quantization',
                    description: '8-bit quantization with weight-only quantization',
                    envVars: {
                        'TRTLLM_DTYPE': 'int8',
                        'TRTLLM_MAX_BATCH_SIZE': '32',
                        'TRTLLM_USE_WEIGHT_ONLY': 'true',
                        'TRTLLM_WEIGHT_ONLY_PRECISION': 'int8'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
                    notes: 'Weight-only quantization provides best speed/accuracy tradeoff'
                },
                'int4': {
                    displayName: 'INT4 Quantization',
                    description: '4-bit quantization for maximum memory efficiency',
                    envVars: {
                        'TRTLLM_DTYPE': 'int4',
                        'TRTLLM_MAX_BATCH_SIZE': '64',
                        'TRTLLM_USE_WEIGHT_ONLY': 'true',
                        'TRTLLM_WEIGHT_ONLY_PRECISION': 'int4'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge'],
                    notes: 'Enables running larger models on smaller instances with acceptable accuracy'
                }
            },
            notes: 'TensorRT-LLM 1.0.0 adds chunked context and INT4 support. Requires CUDA 12.1+'
        }
    },
    'sglang': {
        '0.2.0': {
            baseImage: 'lmsysorg/sglang:v0.2.0-cu121',
            accelerator: {
                type: 'cuda',
                version: '12.1',
                versionRange: { min: '11.8', max: '12.2' }
            },
            envVars: {
                'SGLANG_TENSOR_PARALLEL_SIZE': '1',
                'SGLANG_MEM_FRACTION': '0.9',
                'SGLANG_MAX_RUNNING_REQUESTS': '256',
                'SGLANG_CONTEXT_LENGTH': '4096'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge'],
            validationLevel: 'experimental',
            profiles: {
                'default': {
                    displayName: 'Default Configuration',
                    description: 'Balanced configuration for general use',
                    envVars: {
                        'SGLANG_MAX_RUNNING_REQUESTS': '256',
                        'SGLANG_MEM_FRACTION': '0.9'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
                    notes: 'Good starting point for most workloads'
                },
                'high-throughput': {
                    displayName: 'High Throughput',
                    description: 'Optimized for maximum throughput with RadixAttention',
                    envVars: {
                        'SGLANG_MAX_RUNNING_REQUESTS': '512',
                        'SGLANG_MEM_FRACTION': '0.95',
                        'SGLANG_CONTEXT_LENGTH': '2048',
                        'SGLANG_ENABLE_RADIX_CACHE': 'true'
                    },
                    recommendedInstanceTypes: ['ml.g5.4xlarge', 'ml.g5.12xlarge'],
                    notes: 'RadixAttention provides automatic KV cache reuse for improved throughput'
                }
            },
            notes: 'SGLang 0.2.0 features RadixAttention for automatic KV cache reuse. Experimental support'
        }
    },
    'lmi': {
        '14.0.0': {
            baseImage: '763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:0.32.0-lmi14.0.0-cu126',
            accelerator: {
                type: 'cuda',
                version: '12.6',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'SERVING_PORT': '8080',
                'OPTION_TENSOR_PARALLEL_DEGREE': '1',
                'OPTION_MAX_ROLLING_BATCH_SIZE': '32',
                'OPTION_DTYPE': 'fp16'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.12xlarge'],
            validationLevel: 'tested',
            profiles: {
                'vllm-backend': {
                    displayName: 'vLLM Backend',
                    description: 'Use vLLM as the inference backend for LMI',
                    envVars: {
                        'OPTION_ROLLING_BATCH': 'vllm',
                        'OPTION_MAX_ROLLING_BATCH_SIZE': '32',
                        'OPTION_DTYPE': 'fp16'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
                    notes: 'vLLM backend provides excellent performance for most models'
                },
                'tensorrt-backend': {
                    displayName: 'TensorRT-LLM Backend',
                    description: 'Use TensorRT-LLM for maximum performance',
                    envVars: {
                        'OPTION_ROLLING_BATCH': 'tensorrt-llm',
                        'OPTION_MAX_ROLLING_BATCH_SIZE': '16',
                        'OPTION_DTYPE': 'fp16'
                    },
                    recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge'],
                    notes: 'TensorRT-LLM provides best performance but requires model compilation'
                },
                'lmi-dist': {
                    displayName: 'LMI-Dist (DeepSpeed)',
                    description: 'Use LMI-Dist with DeepSpeed for large models',
                    envVars: {
                        'OPTION_ROLLING_BATCH': 'lmi-dist',
                        'OPTION_TENSOR_PARALLEL_DEGREE': '4',
                        'OPTION_MAX_ROLLING_BATCH_SIZE': '64'
                    },
                    recommendedInstanceTypes: ['ml.g5.12xlarge', 'ml.g5.48xlarge'],
                    notes: 'Best for very large models requiring multi-GPU tensor parallelism'
                },
                'auto': {
                    displayName: 'Auto Backend Selection',
                    description: 'Let LMI automatically select the best backend',
                    envVars: {
                        'OPTION_MAX_ROLLING_BATCH_SIZE': '32',
                        'OPTION_DTYPE': 'fp16'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge'],
                    notes: 'LMI will analyze your model and select the optimal backend automatically'
                }
            },
            notes: 'AWS Large Model Inference (LMI) 14.0.0 with automatic backend selection. Supports vLLM, TensorRT-LLM, LMI-Dist, and Transformers NeuronX backends'
        }
    },
    'djl': {
        '0.32.0': {
            baseImage: 'deepjavalibrary/djl-serving:0.32.0-pytorch-cu126',
            accelerator: {
                type: 'cuda',
                version: '12.6',
                versionRange: { min: '11.8', max: '12.6' }
            },
            envVars: {
                'SERVING_PORT': '8080',
                'OPTION_TENSOR_PARALLEL_DEGREE': '1',
                'OPTION_DEVICE_MAP': 'auto'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge'],
            validationLevel: 'community-validated',
            profiles: {
                'pytorch': {
                    displayName: 'PyTorch Engine',
                    description: 'Use PyTorch as the inference engine',
                    envVars: {
                        'ENGINE': 'Python',
                        'OPTION_DEVICE_MAP': 'auto',
                        'BATCH_SIZE': '1'
                    },
                    recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
                    notes: 'PyTorch engine provides good compatibility with HuggingFace models'
                },
                'multi-gpu': {
                    displayName: 'Multi-GPU',
                    description: 'Tensor parallel across multiple GPUs',
                    envVars: {
                        'ENGINE': 'Python',
                        'OPTION_TENSOR_PARALLEL_DEGREE': '4',
                        'OPTION_DEVICE_MAP': 'auto'
                    },
                    recommendedInstanceTypes: ['ml.g5.12xlarge', 'ml.g5.48xlarge'],
                    notes: 'Distribute model across multiple GPUs for large models'
                }
            },
            notes: 'DJL Serving 0.32.0 with PyTorch backend. Flexible Java-based serving framework with Python engine support'
        }
    },
    'triton-fil': {
        '24.08': {
            baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
            accelerator: {
                type: 'cuda',
                version: '12.5',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'TRITON_MODEL_REPOSITORY': '/opt/ml/model/model_repository'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
            validationLevel: 'experimental',
            notes: 'Triton FIL backend for tree-based models (XGBoost, LightGBM). GPU optional but recommended for performance'
        }
    },
    'triton-onnxruntime': {
        '24.08': {
            baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
            accelerator: {
                type: 'cuda',
                version: '12.5',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'TRITON_MODEL_REPOSITORY': '/opt/ml/model/model_repository'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
            validationLevel: 'experimental',
            notes: 'Triton ONNX Runtime backend for ONNX models. GPU optional but recommended for performance'
        }
    },
    'triton-tensorflow': {
        '24.08': {
            baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
            accelerator: {
                type: 'cuda',
                version: '12.5',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'TRITON_MODEL_REPOSITORY': '/opt/ml/model/model_repository'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
            validationLevel: 'experimental',
            notes: 'Triton TensorFlow backend for SavedModel format. GPU optional but recommended for performance'
        }
    },
    'triton-pytorch': {
        '24.08': {
            baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
            accelerator: {
                type: 'cuda',
                version: '12.5',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'TRITON_MODEL_REPOSITORY': '/opt/ml/model/model_repository'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
            validationLevel: 'experimental',
            notes: 'Triton PyTorch backend for TorchScript models. GPU recommended for performance'
        }
    },
    'triton-vllm': {
        '24.08': {
            baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
            accelerator: {
                type: 'cuda',
                version: '12.5',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'TRITON_MODEL_REPOSITORY': '/opt/ml/model/model_repository'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge'],
            validationLevel: 'experimental',
            notes: 'Triton vLLM backend for LLM serving. Requires GPU instance'
        }
    },
    'triton-tensorrtllm': {
        '24.08': {
            baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
            accelerator: {
                type: 'cuda',
                version: '12.5',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'TRITON_MODEL_REPOSITORY': '/opt/ml/model/model_repository'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.12xlarge'],
            validationLevel: 'experimental',
            notes: 'Triton TensorRT-LLM backend for optimized LLM serving. Requires GPU instance'
        }
    },
    'triton-python': {
        '24.08': {
            baseImage: 'nvcr.io/nvidia/tritonserver:24.08-py3',
            accelerator: {
                type: 'cuda',
                version: '12.5',
                versionRange: { min: '12.0', max: '12.6' }
            },
            envVars: {
                'TRITON_MODEL_REPOSITORY': '/opt/ml/model/model_repository'
            },
            inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-2',
            recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
            validationLevel: 'experimental',
            notes: 'Triton Python backend for custom model serving with TritonPythonModel interface. GPU optional'
        }
    }
};
