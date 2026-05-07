// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Register Helpers
 *
 * Extracted logic from the `do/register` bash template into testable
 * JavaScript functions. These functions mirror the bash implementations
 * for configId hashing, CI record building, and record default handling.
 *
 * Used by unit and property-based tests to validate CI registration
 * behavior without executing the bash template directly.
 */

import { createHash } from 'node:crypto';

/**
 * Compute a deterministic configId from canonical deployment fields.
 *
 * Mirrors the bash logic:
 *   echo -n "${DEPLOYMENT_CONFIG}:${MODEL_NAME:-none}:${INSTANCE_TYPE}:${AWS_REGION}:${DEPLOYMENT_TARGET}" \
 *     | sha256sum | cut -c1-16
 *
 * @param {string} deploymentConfig - e.g. "transformers-vllm"
 * @param {string} modelName - e.g. "meta-llama/Llama-2-7b-chat-hf", defaults to "none"
 * @param {string} instanceType - e.g. "ml.g5.xlarge"
 * @param {string} region - e.g. "us-east-1"
 * @param {string} deploymentTarget - e.g. "managed-inference"
 * @returns {string} 16-character lowercase hex string
 */
export function computeConfigId(deploymentConfig, modelName, instanceType, region, deploymentTarget) {
    const input = `${deploymentConfig}:${modelName || 'none'}:${instanceType}:${region}:${deploymentTarget}`;
    const hash = createHash('sha256').update(input).digest('hex');
    return hash.slice(0, 16);
}

/**
 * Build a CI DynamoDB record structure from registration inputs.
 *
 * Mirrors the `write_ci_record` function in the bash template.
 *
 * @param {string} configId - The computed configId (16-char hex)
 * @param {string} configJson - Compact JSON string of the full configuration
 * @param {object} promotedAttrs - Promoted top-level attributes
 * @param {string} promotedAttrs.deploymentConfig - e.g. "transformers-vllm"
 * @param {string} promotedAttrs.baseImage - e.g. "vllm/vllm-openai:v0.8.5"
 * @param {string} promotedAttrs.baseImageVersion - e.g. "v0.8.5"
 * @param {string} promotedAttrs.projectName - e.g. "test-vllm"
 * @returns {object} DynamoDB item structure (plain JS object, not DynamoDB JSON)
 */
export function buildCiRecord(configId, configJson, promotedAttrs) {
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
        configId,
        schemaVersion: 1,
        configJson,
        testStatus: 'untested',
        lastTestTimestamp: '1970-01-01T00:00:00Z',
        deploymentConfig: promotedAttrs.deploymentConfig || '',
        baseImage: promotedAttrs.baseImage || '',
        baseImageVersion: promotedAttrs.baseImageVersion || '',
        projectName: promotedAttrs.projectName || '',
        createdAt
    };
}

/**
 * Apply default values for missing attributes on a CI record.
 *
 * Ensures consumers handle records written under older schemaVersions
 * gracefully (Requirement 2.7).
 *
 * @param {object} record - A CI record that may have missing attributes
 * @returns {object} The record with defaults applied (mutates and returns same object)
 */
export function applyRecordDefaults(record) {
    if (record.schemaVersion === undefined || record.schemaVersion === null) {
        record.schemaVersion = 1;
    }
    if (!record.testStatus) {
        record.testStatus = 'untested';
    }
    if (!record.lastTestTimestamp) {
        record.lastTestTimestamp = '1970-01-01T00:00:00Z';
    }
    if (!record.buildStrategy) {
        record.buildStrategy = 'codebuild-submit';
    }
    if (!record.stageResults) {
        record.stageResults = {};
    }
    if (!record.errorMessage && record.errorMessage !== '') {
        record.errorMessage = '';
    }
    if (!record.deploymentConfig) {
        record.deploymentConfig = '';
    }
    if (!record.baseImage) {
        record.baseImage = '';
    }
    if (!record.baseImageVersion) {
        record.baseImageVersion = '';
    }
    if (!record.projectName) {
        record.projectName = '';
    }
    return record;
}

/**
 * Extract the baseImageVersion from a base image string.
 *
 * Mirrors the bash logic:
 *   case "${promoted_base_image}" in *:*) promoted_base_image_version="${promoted_base_image##*:}" ;; esac
 *
 * @param {string} baseImage - e.g. "vllm/vllm-openai:v0.8.5"
 * @returns {string} The version tag, or empty string if no tag present
 */
export function extractBaseImageVersion(baseImage) {
    if (!baseImage || !baseImage.includes(':')) {
        return '';
    }
    return baseImage.split(':').pop();
}
