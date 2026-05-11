/* eslint-disable eqeqeq */
/**
 * Validates consistency rules across multiple payloads and configuration sources.
 * Checks GPU counts, tensor parallelism, model source requirements, role ARN format,
 * CUDA compatibility, and model type / instance alignment.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */
export default class CrossCuttingChecker {
    /**
     * Run all cross-cutting consistency checks.
     * @param {Object} context - ValidationContext from PayloadBuilder
     * @param {Object} instanceCatalog - Instance catalog (from servers/lib/catalogs/instances.json)
     * @returns {Array} Array of Finding objects
     */
    check(context, instanceCatalog) {
        const findings = [];

        findings.push(...this.checkGpuConsistency(context, instanceCatalog));
        findings.push(...this.checkTensorParallelism(context, instanceCatalog));
        findings.push(...this.checkModelSourceRequirements(context));
        findings.push(...this.checkRoleArnFormat(context));
        findings.push(...this.checkCudaCompatibility(context, instanceCatalog));
        findings.push(...this.checkModelTypeInstanceAlignment(context, instanceCatalog));

        return findings;
    }

    /**
     * Verify GPU count consistency: instance type ↔ IC spec.
     * @param {Object} context - ValidationContext
     * @param {Object} instanceCatalog - Instance catalog
     * @returns {Array} Findings
     */
    checkGpuConsistency(context, instanceCatalog) {
        const findings = [];
        const config = context.config || {};
        const catalog = instanceCatalog?.catalog || instanceCatalog || {};

        const instanceType = config.INSTANCE_TYPE;
        if (!instanceType) return findings;

        const instanceInfo = catalog[instanceType];
        if (!instanceInfo) return findings;

        const instanceGpuCount = instanceInfo.gpus;
        if (instanceGpuCount == null || instanceGpuCount === 0) return findings;

        const icGpuCount = config.IC_GPU_COUNT;
        if (icGpuCount == null) return findings;

        if (Number(icGpuCount) !== Number(instanceGpuCount)) {
            findings.push({
                service: 'cross-cutting',
                operation: 'configuration',
                fieldPath: 'NumberOfAcceleratorDevicesRequired',
                invalidValue: icGpuCount,
                constraint: {
                    type: 'gpu-consistency',
                    expected: instanceGpuCount,
                    instanceType
                },
                severity: 'error',
                confidence: 'high',
                source: 'cross-cutting',
                remediationHint: `NumberOfAcceleratorDevicesRequired (${icGpuCount}) does not match GPU count (${instanceGpuCount}) for instance type ${instanceType}. Set IC_GPU_COUNT to ${instanceGpuCount}.`
            });
        }

        return findings;
    }

    /**
     * Verify tensor parallelism three-way check:
     * VLLM_TENSOR_PARALLEL_SIZE == NumberOfAcceleratorDevicesRequired == instance GPU count.
     * Only applies when model server is vLLM or SGLang.
     * @param {Object} context - ValidationContext
     * @param {Object} instanceCatalog - Instance catalog
     * @returns {Array} Findings
     */
    checkTensorParallelism(context, instanceCatalog) {
        const findings = [];
        const config = context.config || {};
        const catalog = instanceCatalog?.catalog || instanceCatalog || {};

        const modelServer = config.MODEL_SERVER || config.modelServer || '';
        const normalizedServer = modelServer.toLowerCase();

        if (normalizedServer !== 'vllm' && normalizedServer !== 'sglang') {
            return findings;
        }

        const tpSize = config.VLLM_TENSOR_PARALLEL_SIZE;
        if (tpSize == null) return findings;

        const instanceType = config.INSTANCE_TYPE;
        const instanceInfo = instanceType ? catalog[instanceType] : null;
        const instanceGpuCount = instanceInfo?.gpus;

        const icGpuCount = config.IC_GPU_COUNT;

        // Check TP size vs IC GPU count
        if (icGpuCount != null && Number(tpSize) !== Number(icGpuCount)) {
            findings.push({
                service: 'cross-cutting',
                operation: 'configuration',
                fieldPath: 'VLLM_TENSOR_PARALLEL_SIZE',
                invalidValue: tpSize,
                constraint: {
                    type: 'tensor-parallelism',
                    expected: icGpuCount,
                    field: 'NumberOfAcceleratorDevicesRequired'
                },
                severity: 'error',
                confidence: 'high',
                source: 'cross-cutting',
                remediationHint: `VLLM_TENSOR_PARALLEL_SIZE (${tpSize}) must equal NumberOfAcceleratorDevicesRequired (${icGpuCount}) for ${modelServer}.`
            });
        }

        // Check TP size vs instance GPU count
        if (instanceGpuCount != null && Number(tpSize) !== Number(instanceGpuCount)) {
            findings.push({
                service: 'cross-cutting',
                operation: 'configuration',
                fieldPath: 'VLLM_TENSOR_PARALLEL_SIZE',
                invalidValue: tpSize,
                constraint: {
                    type: 'tensor-parallelism',
                    expected: instanceGpuCount,
                    field: 'instanceGpuCount'
                },
                severity: 'error',
                confidence: 'high',
                source: 'cross-cutting',
                remediationHint: `VLLM_TENSOR_PARALLEL_SIZE (${tpSize}) must equal instance GPU count (${instanceGpuCount}) for ${instanceType}.`
            });
        }

        return findings;
    }

    /**
     * Verify model source requirements (artifact URI, hub access config).
     * @param {Object} context - ValidationContext
     * @returns {Array} Findings
     */
    checkModelSourceRequirements(context) {
        const findings = [];
        const config = context.config || {};

        const modelSource = config.modelSource || config.MODEL_SOURCE || '';

        // When modelSource is 'jumpstart-hub', verify HubAccessConfig.HubContentArn is present
        if (modelSource === 'jumpstart-hub') {
            const payloads = context.payloads || {};
            let hubContentArnFound = false;

            for (const payload of Object.values(payloads)) {
                if (payload?.HubAccessConfig?.HubContentArn) {
                    hubContentArnFound = true;
                    break;
                }
            }

            if (!hubContentArnFound && !config.HUB_CONTENT_ARN) {
                findings.push({
                    service: 'cross-cutting',
                    operation: 'configuration',
                    fieldPath: 'HubAccessConfig.HubContentArn',
                    invalidValue: null,
                    constraint: {
                        type: 'conditional-required',
                        condition: 'modelSource === jumpstart-hub'
                    },
                    severity: 'error',
                    confidence: 'high',
                    source: 'cross-cutting',
                    remediationHint: 'When modelSource is "jumpstart-hub", HubAccessConfig.HubContentArn must be present in the payload.'
                });
            }
        }

        // When modelSource in {s3, jumpstart, jumpstart-hub, registry}, verify MODEL_ARTIFACT_URI is non-empty
        const sourcesRequiringArtifact = ['s3', 'jumpstart', 'jumpstart-hub', 'registry'];
        if (sourcesRequiringArtifact.includes(modelSource)) {
            const artifactUri = config.MODEL_ARTIFACT_URI || '';
            if (!artifactUri || artifactUri.trim() === '') {
                findings.push({
                    service: 'cross-cutting',
                    operation: 'configuration',
                    fieldPath: 'MODEL_ARTIFACT_URI',
                    invalidValue: artifactUri || null,
                    constraint: {
                        type: 'conditional-required',
                        condition: `modelSource === ${modelSource}`
                    },
                    severity: 'error',
                    confidence: 'high',
                    source: 'cross-cutting',
                    remediationHint: `When modelSource is "${modelSource}", MODEL_ARTIFACT_URI must be set and non-empty.`
                });
            }
        }

        return findings;
    }

    /**
     * Verify role ARN format for realtime-inference.
     * @param {Object} context - ValidationContext
     * @returns {Array} Findings
     */
    checkRoleArnFormat(context) {
        const findings = [];
        const config = context.config || {};
        const deploymentTarget = context.deploymentTarget || '';

        if (deploymentTarget !== 'realtime-inference') return findings;

        const roleArn = config.ROLE_ARN;
        if (roleArn == null || roleArn === '') return findings;

        const arnPattern = /^arn:aws:iam::\d{12}:role\/.+$/;
        if (!arnPattern.test(roleArn)) {
            findings.push({
                service: 'cross-cutting',
                operation: 'configuration',
                fieldPath: 'ROLE_ARN',
                invalidValue: roleArn,
                constraint: {
                    type: 'pattern',
                    pattern: 'arn:aws:iam::\\d{12}:role/.+'
                },
                severity: 'error',
                confidence: 'high',
                source: 'cross-cutting',
                remediationHint: `ROLE_ARN "${roleArn}" does not match IAM role ARN pattern. Expected format: arn:aws:iam::<12-digit-account-id>:role/<role-name>.`
            });
        }

        return findings;
    }

    /**
     * Verify CUDA version compatibility: base image CUDA ∩ instance CUDA versions is non-empty.
     * @param {Object} context - ValidationContext
     * @param {Object} instanceCatalog - Instance catalog
     * @returns {Array} Findings
     */
    checkCudaCompatibility(context, instanceCatalog) {
        const findings = [];
        const config = context.config || {};
        const catalog = instanceCatalog?.catalog || instanceCatalog || {};

        const instanceType = config.INSTANCE_TYPE;
        if (!instanceType) return findings;

        const instanceInfo = catalog[instanceType];
        if (!instanceInfo) return findings;

        const instanceCudaVersions = instanceInfo.cudaVersions;
        if (!instanceCudaVersions || !Array.isArray(instanceCudaVersions) || instanceCudaVersions.length === 0) {
            return findings;
        }

        // Extract base image CUDA requirement from config
        const cudaRequirement = config.acceleratorVersion || config.CUDA_VERSION || '';
        if (!cudaRequirement) return findings;

        // Check if any instance CUDA version matches the base image requirement
        // Compare major version (e.g., "12" matches "12.1", "12.2")
        const requiredMajor = String(cudaRequirement).split('.')[0];

        const hasCompatible = instanceCudaVersions.some(v => {
            const vMajor = String(v).split('.')[0];
            return vMajor === requiredMajor;
        });

        if (!hasCompatible) {
            findings.push({
                service: 'cross-cutting',
                operation: 'configuration',
                fieldPath: 'acceleratorVersion',
                invalidValue: cudaRequirement,
                constraint: {
                    type: 'cuda-compatibility',
                    instanceCudaVersions,
                    instanceType
                },
                severity: 'error',
                confidence: 'high',
                source: 'cross-cutting',
                remediationHint: `Base image requires CUDA ${cudaRequirement} but instance ${instanceType} supports CUDA versions [${instanceCudaVersions.join(', ')}]. No compatible CUDA version found.`
            });
        }

        return findings;
    }

    /**
     * Verify predictor models are not assigned GPU instances.
     * @param {Object} context - ValidationContext
     * @param {Object} instanceCatalog - Instance catalog
     * @returns {Array} Findings
     */
    checkModelTypeInstanceAlignment(context, instanceCatalog) {
        const findings = [];
        const config = context.config || {};
        const catalog = instanceCatalog?.catalog || instanceCatalog || {};

        const modelType = config.modelType || config.MODEL_TYPE || '';
        if (modelType !== 'predictor') return findings;

        const instanceType = config.INSTANCE_TYPE;
        if (!instanceType) return findings;

        const instanceInfo = catalog[instanceType];
        if (!instanceInfo) return findings;

        if (instanceInfo.gpus > 0 || instanceInfo.category === 'gpu') {
            findings.push({
                service: 'cross-cutting',
                operation: 'configuration',
                fieldPath: 'INSTANCE_TYPE',
                invalidValue: instanceType,
                constraint: {
                    type: 'model-type-alignment',
                    modelType: 'predictor',
                    instanceCategory: instanceInfo.category
                },
                severity: 'warning',
                confidence: 'high',
                source: 'cross-cutting',
                remediationHint: `Model type "predictor" typically does not require GPU acceleration. Consider using a CPU instance (e.g., ml.m5.xlarge) instead of ${instanceType}.`
            });
        }

        return findings;
    }
}
