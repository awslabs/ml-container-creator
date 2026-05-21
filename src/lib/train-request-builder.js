// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Request Builder
 *
 * JavaScript module that replicates the Python helper's (.train_build_request.py)
 * logic for constructing a CreateTrainingJob JSON request from a parsed config.
 *
 * This module mirrors the behavior of the Python build_request() function,
 * providing a testable implementation of the config-to-API mapping logic.
 */

/**
 * Build a CreateTrainingJob request from a parsed training config.
 *
 * Maps config fields to the SageMaker CreateTrainingJob API structure:
 * - image → AlgorithmSpecification.TrainingImage
 * - instance_type → ResourceConfig.InstanceType
 * - instance_count → ResourceConfig.InstanceCount
 * - dataset → InputDataConfig[0].DataSource.S3DataSource.S3Uri
 * - output_path → OutputDataConfig.S3OutputPath
 * - hyperparameters → HyperParameters (string key-value pairs)
 * - max_runtime_seconds → StoppingCondition.MaxRuntimeInSeconds
 * - enable_spot=true → EnableManagedSpotTraining = true
 * - enable_spot=true → StoppingCondition.MaxWaitTimeInSeconds
 * - checkpoint_path → CheckpointConfig.S3Uri
 * - metric_definitions → AlgorithmSpecification.MetricDefinitions
 * - environment → Environment
 * - tags → Tags (converted from {k:v} to [{Key:k, Value:v}])
 *
 * @param {object} options - Build options
 * @param {string} options.jobName - Training job name
 * @param {string} options.roleArn - SageMaker execution role ARN
 * @param {object} options.config - Parsed training config (from parseTrainingConfig)
 * @returns {object} CreateTrainingJob request body
 */
export function buildTrainingJobRequest({ jobName, roleArn, config }) {
    const request = {
        TrainingJobName: jobName,
        RoleArn: roleArn,
        AlgorithmSpecification: {
            TrainingImage: config.image,
            TrainingInputMode: 'File'
        },
        InputDataConfig: [
            {
                ChannelName: 'training',
                DataSource: {
                    S3DataSource: {
                        S3DataType: 'S3Prefix',
                        S3Uri: config.dataset,
                        S3DataDistributionType: 'FullyReplicated'
                    }
                }
            }
        ],
        OutputDataConfig: {
            S3OutputPath: config.output_path
        },
        ResourceConfig: {
            InstanceType: config.instance_type,
            InstanceCount: parseInt(config.instance_count, 10),
            VolumeSizeInGB: parseInt(config.volume_size_gb, 10)
        },
        StoppingCondition: {
            MaxRuntimeInSeconds: parseInt(config.max_runtime_seconds, 10)
        }
    };

    // Hyperparameters — ensure all values are strings (SageMaker requirement)
    const hyperparams = config.hyperparameters || {};
    if (Object.keys(hyperparams).length > 0) {
        request.HyperParameters = {};
        for (const [k, v] of Object.entries(hyperparams)) {
            request.HyperParameters[String(k)] = String(v);
        }
    }

    // Managed spot training
    const enableSpot = config.enable_spot === 'true' || config.enable_spot === true;
    if (enableSpot) {
        request.EnableManagedSpotTraining = true;
        request.StoppingCondition.MaxWaitTimeInSeconds = parseInt(config.max_wait_seconds, 10);
    }

    // Checkpoint configuration (for spot training resumption)
    const checkpointPath = config.checkpoint_path || '';
    if (checkpointPath) {
        request.CheckpointConfig = {
            S3Uri: checkpointPath
        };
    }

    // Metric definitions (custom CloudWatch metrics)
    const metricDefs = config.metric_definitions || [];
    if (Array.isArray(metricDefs) && metricDefs.length > 0) {
        request.AlgorithmSpecification.MetricDefinitions = metricDefs.map(m => ({
            Name: m.name,
            Regex: m.regex
        }));
    }

    // Environment variables for the container
    const environment = config.environment || {};
    if (Object.keys(environment).length > 0) {
        request.Environment = environment;
    }

    // Tags — convert from {key: value} map to [{Key: k, Value: v}] array
    const tags = config.tags || {};
    if (Object.keys(tags).length > 0) {
        request.Tags = Object.entries(tags).map(([k, v]) => ({
            Key: String(k),
            Value: String(v)
        }));
    }

    return request;
}
