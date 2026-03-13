/**
 * Model Registry
 * 
 * Stores model-specific overrides, known issues, and fallback configurations.
 * Supports pattern matching for model IDs (e.g., "mistral*" matches all Mistral variants).
 * 
 * Schema:
 * {
 *   "model_id_or_pattern": {
 *     family: string,
 *     chatTemplate: string | null,
 *     requiresTemplate: boolean,
 *     validationLevel: "tested" | "community-validated" | "experimental",
 *     frameworkCompatibility: {
 *       [framework: string]: string  // version range
 *     },
 *     profiles?: {
 *       [profileName: string]: {
 *         displayName: string,
 *         envVars: { [key: string]: string },
 *         recommendedInstanceTypes?: string[]
 *       }
 *     },
 *     notes?: string
 *   }
 * }
 */

export default {
    // Llama-2 family - exact model IDs
    'meta-llama/Llama-2-7b-chat-hf': {
        family: 'llama-2',
        chatTemplate: '{% for message in messages %}{% if message[\'role\'] == \'system\' %}{{ \'[INST] <<SYS>>\\n\' + message[\'content\'] + \'\\n<</SYS>>\\n\\n\' }}{% elif message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ \' \' + message[\'content\'] + \' \' }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'tested',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        profiles: {
            '7b': {
                displayName: 'Llama-2 7B',
                envVars: {
                    'MAX_MODEL_LEN': '4096',
                    'GPU_MEMORY_UTILIZATION': '0.9'
                },
                recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge']
            }
        },
        notes: 'Llama-2 7B chat model with official chat template. Requires HuggingFace authentication for download'
    },
    'meta-llama/Llama-2-13b-chat-hf': {
        family: 'llama-2',
        chatTemplate: '{% for message in messages %}{% if message[\'role\'] == \'system\' %}{{ \'[INST] <<SYS>>\\n\' + message[\'content\'] + \'\\n<</SYS>>\\n\\n\' }}{% elif message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ \' \' + message[\'content\'] + \' \' }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'tested',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        profiles: {
            '13b': {
                displayName: 'Llama-2 13B',
                envVars: {
                    'MAX_MODEL_LEN': '4096',
                    'GPU_MEMORY_UTILIZATION': '0.9'
                },
                recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge']
            }
        },
        notes: 'Llama-2 13B chat model. Requires more GPU memory than 7B variant'
    },
    'meta-llama/Llama-2-70b-chat-hf': {
        family: 'llama-2',
        chatTemplate: '{% for message in messages %}{% if message[\'role\'] == \'system\' %}{{ \'[INST] <<SYS>>\\n\' + message[\'content\'] + \'\\n<</SYS>>\\n\\n\' }}{% elif message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ \' \' + message[\'content\'] + \' \' }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'community-validated',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        profiles: {
            '70b-tp2': {
                displayName: 'Llama-2 70B (2-GPU)',
                envVars: {
                    'TENSOR_PARALLEL_SIZE': '2',
                    'MAX_MODEL_LEN': '4096',
                    'GPU_MEMORY_UTILIZATION': '0.95'
                },
                recommendedInstanceTypes: ['ml.g5.12xlarge']
            },
            '70b-tp4': {
                displayName: 'Llama-2 70B (4-GPU)',
                envVars: {
                    'TENSOR_PARALLEL_SIZE': '4',
                    'MAX_MODEL_LEN': '4096',
                    'GPU_MEMORY_UTILIZATION': '0.9'
                },
                recommendedInstanceTypes: ['ml.g5.12xlarge', 'ml.g5.48xlarge']
            }
        },
        notes: 'Llama-2 70B requires tensor parallelism across multiple GPUs'
    },
    
    // Mistral family - pattern matching examples
    'mistralai/Mistral-7B-Instruct-v0.1': {
        family: 'mistral',
        chatTemplate: '{{ bos_token }}{% for message in messages %}{% if message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ message[\'content\'] + eos_token }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'tested',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        profiles: {
            '7b': {
                displayName: 'Mistral 7B Instruct',
                envVars: {
                    'MAX_MODEL_LEN': '8192',
                    'GPU_MEMORY_UTILIZATION': '0.9'
                },
                recommendedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge']
            }
        },
        notes: 'Mistral 7B v0.1 with 8K context window'
    },
    'mistralai/Mistral-7B-Instruct-v0.2': {
        family: 'mistral',
        chatTemplate: '{{ bos_token }}{% for message in messages %}{% if message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ message[\'content\'] + eos_token }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'tested',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        profiles: {
            '7b': {
                displayName: 'Mistral 7B Instruct v0.2',
                envVars: {
                    'MAX_MODEL_LEN': '32768',
                    'GPU_MEMORY_UTILIZATION': '0.9'
                },
                recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge']
            }
        },
        notes: 'Mistral 7B v0.2 with extended 32K context window. Requires more memory for long contexts'
    },
    'mistralai/Mixtral-8x7B-Instruct-v0.1': {
        family: 'mistral',
        chatTemplate: '{{ bos_token }}{% for message in messages %}{% if message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ message[\'content\'] + eos_token }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'community-validated',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        profiles: {
            '8x7b-tp2': {
                displayName: 'Mixtral 8x7B (2-GPU)',
                envVars: {
                    'TENSOR_PARALLEL_SIZE': '2',
                    'MAX_MODEL_LEN': '32768',
                    'GPU_MEMORY_UTILIZATION': '0.95'
                },
                recommendedInstanceTypes: ['ml.g5.12xlarge']
            }
        },
        notes: 'Mixtral 8x7B MoE model. Requires tensor parallelism for efficient inference'
    },
    
    // Pattern matching for Mistral family
    'mistralai/Mistral-*': {
        family: 'mistral',
        chatTemplate: '{{ bos_token }}{% for message in messages %}{% if message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ message[\'content\'] + eos_token }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'experimental',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        notes: 'Fallback configuration for Mistral models not explicitly listed. Uses standard Mistral chat template'
    },
    
    // Pattern matching for Llama-2 family
    'meta-llama/Llama-2-*': {
        family: 'llama-2',
        chatTemplate: '{% for message in messages %}{% if message[\'role\'] == \'system\' %}{{ \'[INST] <<SYS>>\\n\' + message[\'content\'] + \'\\n<</SYS>>\\n\\n\' }}{% elif message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ \' \' + message[\'content\'] + \' \' }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'experimental',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0',
            'sglang': '>=0.2.0'
        },
        notes: 'Fallback configuration for Llama-2 models not explicitly listed. Uses standard Llama-2 chat template'
    },
    
    // Additional model families for pattern matching examples
    'codellama/*': {
        family: 'codellama',
        chatTemplate: '{% for message in messages %}{% if message[\'role\'] == \'system\' %}{{ \'[INST] <<SYS>>\\n\' + message[\'content\'] + \'\\n<</SYS>>\\n\\n\' }}{% elif message[\'role\'] == \'user\' %}{{ \'[INST] \' + message[\'content\'] + \' [/INST]\' }}{% elif message[\'role\'] == \'assistant\' %}{{ \' \' + message[\'content\'] + \' \' }}{% endif %}{% endfor %}',
        requiresTemplate: true,
        validationLevel: 'experimental',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0'
        },
        notes: 'CodeLlama models use Llama-2 chat template. Optimized for code generation'
    },
    'tiiuae/falcon-*': {
        family: 'falcon',
        chatTemplate: null,
        requiresTemplate: false,
        validationLevel: 'experimental',
        frameworkCompatibility: {
            'vllm': '>=0.3.0',
            'tensorrt-llm': '>=0.8.0'
        },
        notes: 'Falcon models typically don\'t require chat templates for instruction following'
    }
};
