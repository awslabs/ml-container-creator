// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CUDA Resolver - Handles CUDA version selection and AMI resolution.
 * Uses delegation pattern: receives parent PromptRunner reference to access shared state.
 */

export const CUDA_AMI_MAP = {
    '11.0': 'al2-ami-sagemaker-inference-gpu-2',
    '11.4': 'al2-ami-sagemaker-inference-gpu-2-1',
    '11.8': 'al2-ami-sagemaker-inference-gpu-2-1',
    '12.1': 'al2-ami-sagemaker-inference-gpu-3-1',
    '12.2': 'al2-ami-sagemaker-inference-gpu-3-1',
    '12.4': 'al2-ami-sagemaker-inference-gpu-3-1',
    '12.6': 'al2-ami-sagemaker-inference-gpu-3-1',
    '13.0': 'al2023-ami-sagemaker-inference-gpu-4-1'
};

export default class CudaResolver {
    constructor(runner) {
        this.runner = runner;
    }

    /**
     * Prompt the user to select a CUDA version when the selected GPU instance
     * supports multiple versions.
     *
     * @param {string} instanceType - Selected instance type (e.g. "ml.g5.2xlarge")
     * @param {string} framework - Selected framework name
     * @param {string} frameworkVersion - Selected framework version
     * @param {string} [baseImageCuda] - CUDA version from selected base image (for auto-resolution)
     * @returns {Promise<{cudaVersion: string, inferenceAmiVersion: string}|null>}
     */
    async _promptCudaVersion(instanceType, framework, frameworkVersion, baseImageCuda) {
        if (!instanceType) return null;

        const instanceInfo = this.runner._instanceAcceleratorMapping[instanceType];
        if (!instanceInfo || instanceInfo.accelerator.type !== 'cuda') return null;

        const instanceCudaVersions = instanceInfo.accelerator.versions;
        if (!instanceCudaVersions || instanceCudaVersions.length === 0) return null;

        // Auto-resolution: when base image specifies a CUDA version, intersect with instance support
        if (baseImageCuda) {
            const majorRequired = baseImageCuda.split('.')[0];
            const intersection = instanceCudaVersions.filter(v => {
                if (v === baseImageCuda) return true;
                if (v.startsWith(`${majorRequired}.`)) return true;
                return false;
            });

            if (intersection.length > 0) {
                const exactMatch = intersection.find(v => v === baseImageCuda);
                const selectedVersion = exactMatch || intersection.sort().pop();
                const inferenceAmiVersion = CUDA_AMI_MAP[selectedVersion];
                if (inferenceAmiVersion) {
                    console.log(`\n🔧 CUDA ${selectedVersion} auto-resolved from base image (requires ${baseImageCuda})`);
                    console.log(`   AMI: ${inferenceAmiVersion}`);
                    return { cudaVersion: selectedVersion, inferenceAmiVersion };
                }
            } else {
                console.log(`\n   ⚠️  Base image requires CUDA ${baseImageCuda} but instance ${instanceType} supports: ${instanceCudaVersions.join(', ')}`);
                console.log('   No compatible CUDA version found. Falling back to manual selection.');
            }
        }

        // Get framework CUDA requirements (if available)
        const registryConfigManager = this.runner.registryConfigManager;
        const frameworkConfig = registryConfigManager?.frameworkRegistry?.[framework]?.[frameworkVersion];
        const frameworkAccel = frameworkConfig?.accelerator;

        // Compute compatible CUDA versions
        let compatibleVersions;
        if (frameworkAccel?.versionRange) {
            const { min, max } = frameworkAccel.versionRange;
            compatibleVersions = instanceCudaVersions.filter(v => {
                return v >= min && v <= max;
            });
        } else {
            compatibleVersions = [...instanceCudaVersions];
        }

        if (compatibleVersions.length === 0) {
            compatibleVersions = [...instanceCudaVersions];
        }

        // If only one option, auto-select it silently
        if (compatibleVersions.length === 1) {
            const cudaVersion = compatibleVersions[0];
            const inferenceAmiVersion = CUDA_AMI_MAP[cudaVersion];
            if (inferenceAmiVersion) {
                console.log(`\n🔧 CUDA ${cudaVersion} auto-selected (only compatible version for ${instanceType})`);
                console.log(`   AMI: ${inferenceAmiVersion}`);
            }
            return inferenceAmiVersion ? { cudaVersion, inferenceAmiVersion } : null;
        }

        // Multiple options — let the user choose (or auto-select in auto-prompt mode)
        const defaultVersion = frameworkAccel?.version
            && compatibleVersions.includes(frameworkAccel.version)
            ? frameworkAccel.version
            : instanceInfo.accelerator.default || compatibleVersions[compatibleVersions.length - 1];

        // In auto-prompt mode, auto-select the default without prompting
        if (this.runner.configManager?.isAutoPrompt()) {
            const inferenceAmiVersion = CUDA_AMI_MAP[defaultVersion];
            if (inferenceAmiVersion) {
                console.log(`\n🔧 CUDA ${defaultVersion} auto-selected (auto-prompt mode)`);
                console.log(`   AMI: ${inferenceAmiVersion}`);
            }
            return inferenceAmiVersion ? { cudaVersion: defaultVersion, inferenceAmiVersion } : null;
        }

        const choices = compatibleVersions.map(v => {
            const ami = CUDA_AMI_MAP[v] || 'unknown';
            const isDefault = v === defaultVersion ? ' (recommended)' : '';
            return {
                name: `CUDA ${v}${isDefault}  →  AMI: ${ami}`,
                value: v,
                short: `CUDA ${v}`
            };
        });

        const { cudaVersion } = await this.runner._runPrompts([{
            type: 'list',
            name: 'cudaVersion',
            message: `Select CUDA version for ${instanceType} (${instanceInfo.accelerator.hardware}):`,
            choices,
            default: defaultVersion
        }]);

        const inferenceAmiVersion = CUDA_AMI_MAP[cudaVersion];
        if (inferenceAmiVersion) {
            console.log(`   ✅ CUDA ${cudaVersion} → AMI: ${inferenceAmiVersion}`);
        }

        return inferenceAmiVersion ? { cudaVersion, inferenceAmiVersion } : null;
    }
}
