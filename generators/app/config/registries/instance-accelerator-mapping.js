/**
 * Instance Accelerator Mapping
 * 
 * Maps AWS SageMaker instance types to their accelerator capabilities.
 * Used for validating framework accelerator requirements against instance capabilities.
 * 
 * Schema:
 * {
 *   "instance_type": {
 *     family: string,
 *     accelerator: {
 *       type: "cuda" | "neuron" | "cpu" | "rocm",
 *       hardware: string,
 *       architecture: string,
 *       versions: string[] | null,
 *       default: string | null
 *     },
 *     memory: string,
 *     vcpus: number,
 *     notes?: string
 *   }
 * }
 */

export default {
    // ml.g5 family - NVIDIA A10G GPUs with CUDA 12.x support
    'ml.g5.xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '16 GB',
        vcpus: 4,
        notes: '1x NVIDIA A10G GPU (24GB). Good for small to medium models'
    },
    'ml.g5.2xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '32 GB',
        vcpus: 8,
        notes: '1x NVIDIA A10G GPU (24GB). Better CPU/memory for preprocessing'
    },
    'ml.g5.4xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '64 GB',
        vcpus: 16,
        notes: '1x NVIDIA A10G GPU (24GB). High CPU/memory for complex preprocessing'
    },
    'ml.g5.8xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '128 GB',
        vcpus: 32,
        notes: '1x NVIDIA A10G GPU (24GB). Maximum CPU/memory for single GPU'
    },
    'ml.g5.12xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '192 GB',
        vcpus: 48,
        notes: '4x NVIDIA A10G GPUs (96GB total). Good for tensor parallelism'
    },
    'ml.g5.16xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '256 GB',
        vcpus: 64,
        notes: '1x NVIDIA A10G GPU (24GB). Very high CPU/memory ratio'
    },
    'ml.g5.24xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '384 GB',
        vcpus: 96,
        notes: '4x NVIDIA A10G GPUs (96GB total). High CPU/memory with multi-GPU'
    },
    'ml.g5.48xlarge': {
        family: 'g5',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA A10G',
            architecture: 'Ampere',
            versions: ['11.8', '12.1', '12.2'],
            default: '12.1'
        },
        memory: '768 GB',
        vcpus: 192,
        notes: '8x NVIDIA A10G GPUs (192GB total). Maximum multi-GPU configuration'
    },
    
    // ml.g4dn family - NVIDIA T4 GPUs with CUDA 11.x support
    'ml.g4dn.xlarge': {
        family: 'g4dn',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA T4',
            architecture: 'Turing',
            versions: ['11.4', '11.8'],
            default: '11.8'
        },
        memory: '16 GB',
        vcpus: 4,
        notes: '1x NVIDIA T4 GPU (16GB). Cost-effective for smaller models'
    },
    'ml.g4dn.2xlarge': {
        family: 'g4dn',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA T4',
            architecture: 'Turing',
            versions: ['11.4', '11.8'],
            default: '11.8'
        },
        memory: '32 GB',
        vcpus: 8,
        notes: '1x NVIDIA T4 GPU (16GB). Better CPU/memory for preprocessing'
    },
    'ml.g4dn.4xlarge': {
        family: 'g4dn',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA T4',
            architecture: 'Turing',
            versions: ['11.4', '11.8'],
            default: '11.8'
        },
        memory: '64 GB',
        vcpus: 16,
        notes: '1x NVIDIA T4 GPU (16GB). High CPU/memory ratio'
    },
    'ml.g4dn.8xlarge': {
        family: 'g4dn',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA T4',
            architecture: 'Turing',
            versions: ['11.4', '11.8'],
            default: '11.8'
        },
        memory: '128 GB',
        vcpus: 32,
        notes: '1x NVIDIA T4 GPU (16GB). Maximum CPU/memory for single GPU'
    },
    'ml.g4dn.12xlarge': {
        family: 'g4dn',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA T4',
            architecture: 'Turing',
            versions: ['11.4', '11.8'],
            default: '11.8'
        },
        memory: '192 GB',
        vcpus: 48,
        notes: '4x NVIDIA T4 GPUs (64GB total). Multi-GPU for tensor parallelism'
    },
    'ml.g4dn.16xlarge': {
        family: 'g4dn',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA T4',
            architecture: 'Turing',
            versions: ['11.4', '11.8'],
            default: '11.8'
        },
        memory: '256 GB',
        vcpus: 64,
        notes: '1x NVIDIA T4 GPU (16GB). Very high CPU/memory ratio'
    },
    
    // ml.p3 family - NVIDIA V100 GPUs with CUDA 11.x support
    'ml.p3.2xlarge': {
        family: 'p3',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA V100',
            architecture: 'Volta',
            versions: ['11.0', '11.4', '11.8'],
            default: '11.8'
        },
        memory: '61 GB',
        vcpus: 8,
        notes: '1x NVIDIA V100 GPU (16GB). High-performance for training and inference'
    },
    'ml.p3.8xlarge': {
        family: 'p3',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA V100',
            architecture: 'Volta',
            versions: ['11.0', '11.4', '11.8'],
            default: '11.8'
        },
        memory: '244 GB',
        vcpus: 32,
        notes: '4x NVIDIA V100 GPUs (64GB total). Multi-GPU for large models'
    },
    'ml.p3.16xlarge': {
        family: 'p3',
        accelerator: {
            type: 'cuda',
            hardware: 'NVIDIA V100',
            architecture: 'Volta',
            versions: ['11.0', '11.4', '11.8'],
            default: '11.8'
        },
        memory: '488 GB',
        vcpus: 64,
        notes: '8x NVIDIA V100 GPUs (128GB total). Maximum multi-GPU configuration'
    },
    
    // ml.inf2 family - AWS Inferentia2 with Neuron SDK
    'ml.inf2.xlarge': {
        family: 'inf2',
        accelerator: {
            type: 'neuron',
            hardware: 'AWS Inferentia2',
            architecture: 'Inferentia2',
            versions: ['2.15.0', '2.16.0', '2.17.0'],
            default: '2.16.0'
        },
        memory: '16 GB',
        vcpus: 4,
        notes: '1x Inferentia2 chip. Cost-effective for transformer inference'
    },
    'ml.inf2.8xlarge': {
        family: 'inf2',
        accelerator: {
            type: 'neuron',
            hardware: 'AWS Inferentia2',
            architecture: 'Inferentia2',
            versions: ['2.15.0', '2.16.0', '2.17.0'],
            default: '2.16.0'
        },
        memory: '128 GB',
        vcpus: 32,
        notes: '1x Inferentia2 chip. Higher CPU/memory for preprocessing'
    },
    'ml.inf2.24xlarge': {
        family: 'inf2',
        accelerator: {
            type: 'neuron',
            hardware: 'AWS Inferentia2',
            architecture: 'Inferentia2',
            versions: ['2.15.0', '2.16.0', '2.17.0'],
            default: '2.16.0'
        },
        memory: '384 GB',
        vcpus: 96,
        notes: '6x Inferentia2 chips. Multi-chip for large models'
    },
    'ml.inf2.48xlarge': {
        family: 'inf2',
        accelerator: {
            type: 'neuron',
            hardware: 'AWS Inferentia2',
            architecture: 'Inferentia2',
            versions: ['2.15.0', '2.16.0', '2.17.0'],
            default: '2.16.0'
        },
        memory: '768 GB',
        vcpus: 192,
        notes: '12x Inferentia2 chips. Maximum multi-chip configuration'
    },
    
    // ml.trn1 family - AWS Trainium with Neuron SDK
    'ml.trn1.2xlarge': {
        family: 'trn1',
        accelerator: {
            type: 'neuron',
            hardware: 'AWS Trainium',
            architecture: 'Trainium1',
            versions: ['2.15.0', '2.16.0', '2.17.0'],
            default: '2.16.0'
        },
        memory: '32 GB',
        vcpus: 8,
        notes: '1x Trainium chip. Optimized for training, also supports inference'
    },
    'ml.trn1.32xlarge': {
        family: 'trn1',
        accelerator: {
            type: 'neuron',
            hardware: 'AWS Trainium',
            architecture: 'Trainium1',
            versions: ['2.15.0', '2.16.0', '2.17.0'],
            default: '2.16.0'
        },
        memory: '512 GB',
        vcpus: 128,
        notes: '16x Trainium chips. Maximum multi-chip for large-scale training/inference'
    }
};
