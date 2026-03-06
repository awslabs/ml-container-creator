// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instance Type Registry
 * 
 * Defines available SageMaker instance types with metadata for display and selection.
 * This registry can be extended with additional metadata columns in the future
 * (e.g., cost per hour, availability zones, performance benchmarks).
 */

export default {
    // CPU-Optimized Instances
    'ml.m5.large': {
        type: 'ml.m5.large',
        vcpus: 2,
        memory: '8 GB',
        accelerator: 'None',
        useCase: 'Small CPU workloads',
        category: 'cpu'
    },
    'ml.m5.xlarge': {
        type: 'ml.m5.xlarge',
        vcpus: 4,
        memory: '16 GB',
        accelerator: 'None',
        useCase: 'Medium CPU workloads',
        category: 'cpu'
    },
    'ml.m5.2xlarge': {
        type: 'ml.m5.2xlarge',
        vcpus: 8,
        memory: '32 GB',
        accelerator: 'None',
        useCase: 'Large CPU workloads',
        category: 'cpu'
    },
    'ml.m5.4xlarge': {
        type: 'ml.m5.4xlarge',
        vcpus: 16,
        memory: '64 GB',
        accelerator: 'None',
        useCase: 'XL CPU workloads',
        category: 'cpu'
    },
    
    // GPU-Optimized Instances (G5 - A10G GPUs)
    'ml.g5.xlarge': {
        type: 'ml.g5.xlarge',
        vcpus: 4,
        memory: '16 GB',
        accelerator: '1x A10G (24GB)',
        useCase: 'Small GPU workloads',
        category: 'gpu'
    },
    'ml.g5.2xlarge': {
        type: 'ml.g5.2xlarge',
        vcpus: 8,
        memory: '32 GB',
        accelerator: '1x A10G (24GB)',
        useCase: 'Medium GPU workloads',
        category: 'gpu'
    },
    'ml.g5.4xlarge': {
        type: 'ml.g5.4xlarge',
        vcpus: 16,
        memory: '64 GB',
        accelerator: '1x A10G (24GB)',
        useCase: 'Large GPU workloads',
        category: 'gpu'
    },
    'ml.g5.12xlarge': {
        type: 'ml.g5.12xlarge',
        vcpus: 48,
        memory: '192 GB',
        accelerator: '4x A10G (96GB)',
        useCase: 'Multi-GPU workloads',
        category: 'gpu'
    },
    
    // GPU-Optimized Instances (G6 - L4 GPUs)
    'ml.g6.xlarge': {
        type: 'ml.g6.xlarge',
        vcpus: 4,
        memory: '16 GB',
        accelerator: '1x L4 (24GB)',
        useCase: 'Small GPU (newer)',
        category: 'gpu'
    },
    'ml.g6.2xlarge': {
        type: 'ml.g6.2xlarge',
        vcpus: 8,
        memory: '32 GB',
        accelerator: '1x L4 (24GB)',
        useCase: 'Medium GPU (newer)',
        category: 'gpu'
    },
    'ml.g6.12xlarge': {
        type: 'ml.g6.12xlarge',
        vcpus: 48,
        memory: '192 GB',
        accelerator: '4x L4 (96GB)',
        useCase: 'Multi-GPU (newer)',
        category: 'gpu'
    },
    
    // GPU-Optimized Instances (G4dn - T4 GPUs)
    'ml.g4dn.xlarge': {
        type: 'ml.g4dn.xlarge',
        vcpus: 4,
        memory: '16 GB',
        accelerator: '1x T4 (16GB)',
        useCase: 'Budget GPU',
        category: 'gpu'
    },
    'ml.g4dn.2xlarge': {
        type: 'ml.g4dn.2xlarge',
        vcpus: 8,
        memory: '32 GB',
        accelerator: '1x T4 (16GB)',
        useCase: 'Budget GPU (more CPU)',
        category: 'gpu'
    },
    
    // High-Performance GPU Instances (P3 - V100 GPUs)
    'ml.p3.2xlarge': {
        type: 'ml.p3.2xlarge',
        vcpus: 8,
        memory: '61 GB',
        accelerator: '1x V100 (16GB)',
        useCase: 'High-performance GPU',
        category: 'gpu'
    },
    'ml.p3.8xlarge': {
        type: 'ml.p3.8xlarge',
        vcpus: 32,
        memory: '244 GB',
        accelerator: '4x V100 (64GB)',
        useCase: 'Multi-GPU training',
        category: 'gpu'
    }
};
