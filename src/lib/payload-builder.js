/* eslint-disable eqeqeq */
/**
 * Constructs AWS API payloads from configuration values.
 * Produces a JSON-serializable ValidationContext for the validation pipeline.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */
export default class PayloadBuilder {
    /**
     * Coerce a value to integer. Returns null if not parseable as integer.
     * @param {*} val
     * @returns {number|null}
     */
    _toInt(val) {
        if (val == null) return null;
        const n = Number(val);
        return Number.isInteger(n) ? n : null;
    }

    /**
     * Build all payloads for a deployment configuration.
     * @param {Object} config - Configuration from do/config or generator answers
     * @param {string} deploymentTarget - 'realtime-inference' | 'async-inference' | 'batch-transform'
     * @returns {Object} ValidationContext (JSON-serializable)
     */
    build(config, deploymentTarget) {
        const payloads = {};

        const endpointConfig = this.buildCreateEndpointConfig(config);
        if (endpointConfig && Object.keys(endpointConfig).length > 0) {
            payloads['sagemaker:CreateEndpointConfig'] = endpointConfig;
        }

        const icPayload = this.buildCreateInferenceComponent(config);
        if (icPayload && Object.keys(icPayload).length > 0) {
            payloads['sagemaker:CreateInferenceComponent'] = icPayload;
        }

        if (deploymentTarget === 'async-inference') {
            const modelPayload = this.buildCreateModel(config);
            if (modelPayload && Object.keys(modelPayload).length > 0) {
                payloads['sagemaker:CreateModel'] = modelPayload;
            }
        }

        if (deploymentTarget === 'batch-transform') {
            const transformPayload = this.buildCreateTransformJob(config);
            if (transformPayload && Object.keys(transformPayload).length > 0) {
                payloads['sagemaker:CreateTransformJob'] = transformPayload;
            }
        }

        // Filter out undefined values from config to ensure JSON-serializability
        const cleanConfig = {};
        for (const [key, value] of Object.entries(config)) {
            if (value !== undefined) {
                cleanConfig[key] = value;
            }
        }

        return {
            payloads,
            config: cleanConfig,
            deploymentTarget,
            metadata: {
                generatedAt: new Date().toISOString(),
                generatorVersion: '0.2.5',
                services: [...new Set(Object.keys(payloads).map(k => k.split(':')[0]))]
            }
        };
    }

    /**
     * Build CreateEndpointConfig payload.
     * @param {Object} config
     * @returns {Object} AWS API payload
     */
    buildCreateEndpointConfig(config) {
        const variant = {};

        if (config.INSTANCE_TYPE != null) variant.InstanceType = config.INSTANCE_TYPE;
        if (config.INFERENCE_AMI_VERSION != null) variant.InferenceAmiVersion = config.INFERENCE_AMI_VERSION;
        if (config.ENDPOINT_VARIANT_NAME != null) variant.VariantName = config.ENDPOINT_VARIANT_NAME;
        if (config.ENDPOINT_INITIAL_INSTANCE_COUNT != null) variant.InitialInstanceCount = this._toInt(config.ENDPOINT_INITIAL_INSTANCE_COUNT) ?? config.ENDPOINT_INITIAL_INSTANCE_COUNT;
        if (config.ENDPOINT_VOLUME_SIZE != null) variant.VolumeSizeInGB = this._toInt(config.ENDPOINT_VOLUME_SIZE) ?? config.ENDPOINT_VOLUME_SIZE;

        if (Object.keys(variant).length === 0) return {};

        return {
            ProductionVariants: [variant]
        };
    }

    /**
     * Build CreateInferenceComponent payload.
     * @param {Object} config
     * @returns {Object} AWS API payload
     */
    buildCreateInferenceComponent(config) {
        const payload = {};
        const computeResources = {};

        if (config.IC_CPU_COUNT != null) computeResources.NumberOfCpuCoresRequired = this._toInt(config.IC_CPU_COUNT) ?? config.IC_CPU_COUNT;
        if (config.IC_MEMORY_SIZE != null) computeResources.MinMemoryRequiredInMb = this._toInt(config.IC_MEMORY_SIZE) ?? config.IC_MEMORY_SIZE;
        if (config.IC_GPU_COUNT != null) computeResources.NumberOfAcceleratorDevicesRequired = this._toInt(config.IC_GPU_COUNT) ?? config.IC_GPU_COUNT;

        if (Object.keys(computeResources).length > 0) {
            payload.Specification = { ComputeResourceRequirements: computeResources };
        }

        if (config.IC_COPY_COUNT != null) {
            payload.RuntimeConfig = { CopyCount: this._toInt(config.IC_COPY_COUNT) ?? config.IC_COPY_COUNT };
        }

        return payload;
    }

    /**
     * Build CreateModel payload (async inference).
     * @param {Object} config
     * @returns {Object} AWS API payload
     */
    buildCreateModel(config) {
        const payload = {};

        if (config.CONTAINER_IMAGE != null) {
            payload.PrimaryContainer = { Image: config.CONTAINER_IMAGE };
            if (config.MODEL_DATA_URL != null) {
                payload.PrimaryContainer.ModelDataUrl = config.MODEL_DATA_URL;
            }
        }

        if (config.ROLE_ARN != null) payload.ExecutionRoleArn = config.ROLE_ARN;

        return payload;
    }

    /**
     * Build CreateTransformJob payload (batch transform).
     * @param {Object} config
     * @returns {Object} AWS API payload
     */
    buildCreateTransformJob(config) {
        const payload = {};
        const transformResources = {};

        if (config.INSTANCE_TYPE != null) transformResources.InstanceType = config.INSTANCE_TYPE;
        if (config.BATCH_INSTANCE_COUNT != null) transformResources.InstanceCount = config.BATCH_INSTANCE_COUNT;

        if (Object.keys(transformResources).length > 0) {
            payload.TransformResources = transformResources;
        }

        if (config.BATCH_SPLIT_TYPE != null) {
            payload.TransformInput = { SplitType: config.BATCH_SPLIT_TYPE };
        }

        if (config.BATCH_STRATEGY != null) {
            payload.BatchStrategy = config.BATCH_STRATEGY;
        }

        return payload;
    }
}
