#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model Registry MCP Server
 *
 * A bundled MCP server that queries registered models, adapters, datasets,
 * and evaluators from SageMaker Model Registry and local registries.
 *
 * Six tools:
 *   - get_model_registry: List MPG versions with metadata (filters: project-name, status, adapter-only, limit)
 *   - get_model_version: Get details for a specific version ARN
 *   - list_datasets: Query registered datasets (filter: technique, name-pattern)
 *   - list_evaluators: Query registered evaluators (filter: technique, type)
 *   - get_dataset: Full metadata for a specific dataset by name
 *   - get_evaluator: Full metadata for a specific evaluator by name
 *
 * Handles SageMaker pagination internally (max 100 per call, NFR-2).
 * Uses bootstrap profile for credentials.
 * Falls back to local registry when SageMaker API is unreachable.
 *
 * Environment variables:
 *   AWS_REGION - AWS region for SageMaker API calls (default: us-east-1)
 *   AWS_PROFILE - AWS profile to use for credentials
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);

const MLCC_DIR = join(homedir(), '.ml-container-creator');
const BOOTSTRAP_CONFIG_PATH = join(MLCC_DIR, 'config.json');
const LOCAL_REGISTRY_PATH = join(MLCC_DIR, 'registry.json');
const DATASETS_REGISTRY_PATH = join(MLCC_DIR, 'datasets.json');
const EVALUATORS_REGISTRY_PATH = join(MLCC_DIR, 'evaluators.json');

const DEFAULT_LIMIT = 20;
const SAGEMAKER_MAX_RESULTS = 100;

// ── Logging ──────────────────────────────────────────────────────────────────

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[model-registry] ${message}\n`);
}

// ── Bootstrap Profile ────────────────────────────────────────────────────────

/**
 * Load the bootstrap config and return the active profile's AWS settings.
 * Returns { awsRegion, awsProfile } or null if not configured.
 */
function loadBootstrapProfile() {
    try {
        if (!existsSync(BOOTSTRAP_CONFIG_PATH)) {
            return null;
        }
        const raw = readFileSync(BOOTSTRAP_CONFIG_PATH, 'utf8');
        const config = JSON.parse(raw);
        if (!config || !config.activeProfile || !config.profiles) {
            return null;
        }
        const profile = config.profiles[config.activeProfile];
        if (!profile) {
            return null;
        }
        return {
            awsRegion: profile.awsRegion || null,
            awsProfile: profile.awsProfile || null
        };
    } catch {
        return null;
    }
}

// ── AWS SDK Lazy Loading ─────────────────────────────────────────────────────

let _SageMakerClient = null;
let _ListModelPackagesCommand = null;
let _DescribeModelPackageCommand = null;
let _fromIni = null;

/**
 * Lazily load the AWS SDK SageMaker client classes.
 */
async function _ensureSdkLoaded() {
    if (_SageMakerClient) return;
    const sdk = await import('@aws-sdk/client-sagemaker');
    _SageMakerClient = sdk.SageMakerClient;
    _ListModelPackagesCommand = sdk.ListModelPackagesCommand;
    _DescribeModelPackageCommand = sdk.DescribeModelPackageCommand;
    try {
        const credentialProviders = await import('@aws-sdk/credential-providers');
        _fromIni = credentialProviders.fromIni;
    } catch {
        // credential-providers not available
    }
}

/**
 * Create a SageMaker client using bootstrap profile or env credentials.
 */
function _createClient(region, profile) {
    const clientConfig = { region };
    if (profile && _fromIni) {
        clientConfig.credentials = _fromIni({ profile });
    }
    return new _SageMakerClient(clientConfig);
}

/**
 * Resolve region and profile from bootstrap config + env vars.
 */
function _resolveCredentials() {
    const bootstrap = loadBootstrapProfile();
    const region = process.env.AWS_REGION || bootstrap?.awsRegion || 'us-east-1';
    const profile = process.env.AWS_PROFILE || bootstrap?.awsProfile || null;
    return { region, profile };
}

// ── Local Registry Helpers ───────────────────────────────────────────────────

/**
 * Load a JSON registry file. Returns an array of entries.
 */
function _loadLocalRegistry(path) {
    try {
        if (!existsSync(path)) return [];
        const raw = readFileSync(path, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

/**
 * Load the local deployment registry (registry.json).
 * Returns array of deployment entries.
 */
function _loadDeploymentRegistry() {
    return _loadLocalRegistry(LOCAL_REGISTRY_PATH);
}

/**
 * Load the local datasets registry (datasets.json).
 */
function _loadDatasetsRegistry() {
    return _loadLocalRegistry(DATASETS_REGISTRY_PATH);
}

/**
 * Load the local evaluators registry (evaluators.json).
 */
function _loadEvaluatorsRegistry() {
    return _loadLocalRegistry(EVALUATORS_REGISTRY_PATH);
}

// ── SageMaker API: get_model_registry ────────────────────────────────────────

/**
 * List model package versions from SageMaker with internal pagination.
 * Accumulates results until limit is reached or all pages are exhausted.
 *
 * @param {object} client - SageMaker client
 * @param {string} projectName - Model Package Group name
 * @param {object} options - { status, adapterOnly, limit }
 * @returns {Promise<object>} { versions, totalCount }
 */
async function _listModelPackages(client, projectName, { status, limit = DEFAULT_LIMIT } = {}) {
    const versions = [];
    let nextToken;
    let totalCount = 0;

    do {
        const params = {
            ModelPackageGroupName: projectName,
            MaxResults: Math.min(SAGEMAKER_MAX_RESULTS, limit - versions.length),
            SortBy: 'CreationTime',
            SortOrder: 'Descending'
        };
        if (status) {
            params.ModelApprovalStatusEquals = status;
        }
        if (nextToken) {
            params.NextToken = nextToken;
        }

        const command = new _ListModelPackagesCommand(params);
        const response = await client.send(command);

        const summaries = response.ModelPackageSummaryList || [];
        for (const summary of summaries) {
            totalCount++;
            // If adapterOnly filter is set, check customer metadata
            // We'll fetch full details later if needed, for now include all
            versions.push({
                arn: summary.ModelPackageArn,
                version: summary.ModelPackageVersion,
                status: summary.ModelApprovalStatus || 'PendingManualApproval',
                createdAt: summary.CreationTime ? summary.CreationTime.toISOString() : null,
                description: summary.ModelPackageDescription || ''
            });

            if (versions.length >= limit) break;
        }

        nextToken = response.NextToken;
    } while (nextToken && versions.length < limit);

    return { versions, totalCount };
}

/**
 * Describe a model package and extract metadata.
 *
 * @param {object} client - SageMaker client
 * @param {string} versionArn - Model Package ARN
 * @returns {Promise<object>} Full version details
 */
async function _describeModelPackage(client, versionArn) {
    const command = new _DescribeModelPackageCommand({
        ModelPackageName: versionArn
    });
    const response = await client.send(command);

    const metadata = response.CustomerMetadataProperties || {};
    const container = response.InferenceSpecification?.Containers?.[0] || {};

    return {
        arn: response.ModelPackageArn,
        version: response.ModelPackageVersion,
        status: response.ModelApprovalStatus || 'PendingManualApproval',
        createdAt: response.CreationTime ? response.CreationTime.toISOString() : null,
        description: response.ModelPackageDescription || '',
        isAdapter: metadata.isAdapter === 'true',
        parentModelVersionArn: metadata.parentModelVersionArn || null,
        tuneTechnique: metadata.tuneTechnique || null,
        metadata: {
            deploymentConfig: metadata.deploymentConfig || null,
            modelName: metadata.modelName || null,
            instanceType: metadata.instanceType || null,
            architecture: metadata.architecture || null,
            backend: metadata.backend || null,
            baseImage: metadata.baseImage || null,
            modelFormat: metadata.modelFormat || null,
            generatorVersion: metadata.generatorVersion || null,
            projectName: metadata.projectName || null
        },
        inferenceSpec: {
            containerImage: container.Image || null,
            modelDataUrl: container.ModelDataUrl || null,
            supportedContentTypes: response.InferenceSpecification?.SupportedContentTypes || [],
            supportedResponseMIMETypes: response.InferenceSpecification?.SupportedResponseMIMETypes || []
        },
        modelMetrics: response.ModelMetrics || null
    };
}

// ── Offline Fallback ─────────────────────────────────────────────────────────

/**
 * Build model registry response from local deployment registry (offline fallback).
 *
 * @param {string} projectName - Project name to filter by
 * @param {object} options - { status, adapterOnly, limit }
 * @returns {object} { versions, source, totalCount, limit }
 */
function _offlineFallback(projectName, { status, adapterOnly, limit = DEFAULT_LIMIT } = {}) {
    const entries = _loadDeploymentRegistry();

    let filtered = entries.filter(e => {
        if (e.projectName !== projectName && e.project_name !== projectName) return false;
        if (status && e.modelApprovalStatus && e.modelApprovalStatus !== status) return false;
        if (adapterOnly && e.isAdapter !== true && e.isAdapter !== 'true') return false;
        return true;
    });

    const totalCount = filtered.length;
    filtered = filtered.slice(0, limit);

    const versions = filtered.map((e, index) => ({
        arn: e.modelPackageArn || `local://${projectName}/${index + 1}`,
        version: e.modelPackageVersion || index + 1,
        status: e.modelApprovalStatus || 'Approved',
        createdAt: e.registeredAt || e.timestamp || null,
        description: e.description || `${e.deploymentConfig || ''} on ${e.instanceType || ''}`.trim(),
        isAdapter: e.isAdapter === true || e.isAdapter === 'true',
        metadata: {
            deploymentConfig: e.deploymentConfig || null,
            modelName: e.modelName || null,
            instanceType: e.instanceType || null
        }
    }));

    return {
        versions,
        source: 'local',
        totalCount,
        limit
    };
}

/**
 * Build offline fallback for get_model_version.
 */
function _offlineFallbackVersion(versionArn) {
    const entries = _loadDeploymentRegistry();
    const entry = entries.find(e => e.modelPackageArn === versionArn);

    if (!entry) {
        return { error: `Version not found in local registry: ${versionArn}`, source: 'local' };
    }

    return {
        arn: entry.modelPackageArn,
        version: entry.modelPackageVersion || 1,
        status: entry.modelApprovalStatus || 'Approved',
        createdAt: entry.registeredAt || entry.timestamp || null,
        description: entry.description || '',
        isAdapter: entry.isAdapter === true || entry.isAdapter === 'true',
        parentModelVersionArn: entry.parentModelVersionArn || null,
        tuneTechnique: entry.tuneTechnique || null,
        metadata: {
            deploymentConfig: entry.deploymentConfig || null,
            modelName: entry.modelName || null,
            instanceType: entry.instanceType || null,
            architecture: entry.architecture || null,
            backend: entry.backend || null,
            baseImage: entry.baseImage || null,
            modelFormat: entry.modelFormat || null,
            generatorVersion: entry.generatorVersion || null,
            projectName: entry.projectName || entry.project_name || null
        },
        inferenceSpec: {
            containerImage: entry.containerImage || null,
            modelDataUrl: entry.modelDataUrl || null
        },
        source: 'local'
    };
}

// ── Batch Describe Helper ────────────────────────────────────────────────────

/**
 * Describe multiple model packages in parallel with concurrency limit.
 * Prevents SageMaker API throttling while still being faster than sequential.
 *
 * @param {object} client - SageMaker client
 * @param {Array} versions - Array of version objects with .arn
 * @param {number} concurrency - Max parallel requests (default: 5)
 * @returns {Promise<Map>} Map of ARN → describe result (or null on error)
 */
async function _batchDescribe(client, versions, concurrency = 5) {
    const results = new Map();

    for (let i = 0; i < versions.length; i += concurrency) {
        const batch = versions.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
            batch.map(v => _describeModelPackage(client, v.arn))
        );

        batch.forEach((v, idx) => {
            const result = batchResults[idx];
            if (result.status === 'fulfilled') {
                results.set(v.arn, result.value);
            } else {
                log(`Warning: could not describe ${v.arn}: ${result.reason?.message || 'unknown error'}`);
                results.set(v.arn, null);
            }
        });
    }

    return results;
}

// ── Tool Implementations ─────────────────────────────────────────────────────

/**
 * get_model_registry tool implementation.
 */
async function toolGetModelRegistry({ project_name, status, adapter_only, limit }) {
    const effectiveLimit = limit || DEFAULT_LIMIT;

    try {
        await _ensureSdkLoaded();
        const { region, profile } = _resolveCredentials();
        log(`Querying MPG "${project_name}" in ${region}`);

        const client = _createClient(region, profile);
        const { versions, totalCount } = await _listModelPackages(client, project_name, {
            status,
            limit: effectiveLimit
        });

        // Batch-describe all versions in parallel (5 at a time to avoid throttling)
        const descriptions = await _batchDescribe(client, versions);

        let finalVersions;
        if (adapter_only) {
            finalVersions = versions
                .filter(v => descriptions.get(v.arn)?.isAdapter)
                .map(v => {
                    const detail = descriptions.get(v.arn);
                    return { ...v, isAdapter: true, metadata: detail.metadata };
                });
        } else {
            finalVersions = versions.map(v => {
                const detail = descriptions.get(v.arn);
                if (detail) {
                    return { ...v, isAdapter: detail.isAdapter, metadata: detail.metadata };
                }
                return { ...v, isAdapter: false, metadata: {} };
            });
        }

        return {
            versions: finalVersions,
            source: 'sagemaker',
            totalCount,
            limit: effectiveLimit
        };
    } catch (err) {
        log(`SageMaker API error: ${err.message}. Falling back to local registry.`);
        return _offlineFallback(project_name, {
            status,
            adapterOnly: adapter_only,
            limit: effectiveLimit
        });
    }
}

/**
 * get_model_version tool implementation.
 */
async function toolGetModelVersion({ version_arn }) {
    try {
        await _ensureSdkLoaded();
        const { region, profile } = _resolveCredentials();
        log(`Describing model package: ${version_arn}`);

        const client = _createClient(region, profile);
        const detail = await _describeModelPackage(client, version_arn);

        return { ...detail, source: 'sagemaker' };
    } catch (err) {
        log(`SageMaker API error: ${err.message}. Falling back to local registry.`);
        return _offlineFallbackVersion(version_arn);
    }
}

/**
 * list_datasets tool implementation.
 * Reads from local datasets registry (AI Registry API not available).
 */
function toolListDatasets({ technique, name_pattern }) {
    const entries = _loadDatasetsRegistry();

    let filtered = entries;
    if (technique) {
        filtered = filtered.filter(e => e.technique === technique);
    }
    if (name_pattern) {
        const pattern = name_pattern.toLowerCase();
        filtered = filtered.filter(e => e.name && e.name.toLowerCase().includes(pattern));
    }

    const datasets = filtered.map(e => ({
        name: e.name,
        s3Uri: e.s3_uri,
        format: e.format || 'jsonl',
        technique: e.technique || null,
        rowCount: e.row_count || null,
        registeredAt: e.registered_at || null
    }));

    return {
        datasets,
        source: 'local'
    };
}

/**
 * list_evaluators tool implementation.
 * Reads from local evaluators registry (AI Registry API not available).
 */
function toolListEvaluators({ technique, type }) {
    const entries = _loadEvaluatorsRegistry();

    let filtered = entries;
    if (technique) {
        filtered = filtered.filter(e => e.technique === technique);
    }
    if (type) {
        filtered = filtered.filter(e => e.type === type);
    }

    const evaluators = filtered.map(e => ({
        name: e.name,
        type: e.type || null,
        arn: e.arn_or_uri || null,
        technique: e.technique || null,
        description: e.description || ''
    }));

    return {
        evaluators,
        source: 'local'
    };
}

/**
 * get_dataset tool implementation.
 * Returns full metadata for a specific dataset by name.
 */
function toolGetDataset({ name }) {
    const entries = _loadDatasetsRegistry();
    const entry = entries.find(e => e.name === name);

    if (!entry) {
        return { error: `Dataset not found: ${name}`, source: 'local' };
    }

    return {
        name: entry.name,
        s3Uri: entry.s3_uri,
        format: entry.format || 'jsonl',
        technique: entry.technique || null,
        rowCount: entry.row_count || null,
        columnSchema: entry.column_schema || null,
        projectName: entry.project_name || null,
        registeredAt: entry.registered_at || null,
        source: 'local'
    };
}

/**
 * get_evaluator tool implementation.
 * Returns full metadata for a specific evaluator by name.
 */
function toolGetEvaluator({ name }) {
    const entries = _loadEvaluatorsRegistry();
    const entry = entries.find(e => e.name === name);

    if (!entry) {
        return { error: `Evaluator not found: ${name}`, source: 'local' };
    }

    return {
        name: entry.name,
        type: entry.type || null,
        arn: entry.arn_or_uri || null,
        technique: entry.technique || null,
        description: entry.description || '',
        projectName: entry.project_name || null,
        registeredAt: entry.registered_at || null,
        source: 'local'
    };
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'model-registry',
    version: '1.0.0'
});

// Tool: get_model_registry
server.tool(
    'get_model_registry',
    'Lists Model Package versions from a SageMaker Model Package Group with metadata. Supports filtering by status and adapter-only flag. Falls back to local registry when offline.',
    {
        project_name: z.string().describe('Name of the Model Package Group (project name)'),
        status: z.enum(['Approved', 'Rejected', 'PendingManualApproval']).optional().describe('Filter by model approval status'),
        adapter_only: z.boolean().optional().describe('If true, return only adapter versions (isAdapter=true)'),
        limit: z.number().int().positive().default(DEFAULT_LIMIT).describe('Maximum number of versions to return (default: 20)')
    },
    async ({ project_name, status, adapter_only, limit }) => {
        const result = await toolGetModelRegistry({ project_name, status, adapter_only, limit });
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result)
            }]
        };
    }
);

// Tool: get_model_version
server.tool(
    'get_model_version',
    'Returns full details for a specific Model Package version by ARN, including metadata, inference spec, and metrics.',
    {
        version_arn: z.string().describe('Full ARN of the Model Package version')
    },
    async ({ version_arn }) => {
        const result = await toolGetModelVersion({ version_arn });
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result)
            }]
        };
    }
);

// Tool: list_datasets
server.tool(
    'list_datasets',
    'Queries registered datasets from the local registry. Supports filtering by technique and name pattern.',
    {
        technique: z.enum(['sft', 'dpo', 'rlaif', 'rlvr']).optional().describe('Filter by tuning technique'),
        name_pattern: z.string().optional().describe('Filter by name (case-insensitive substring match)')
    },
    async ({ technique, name_pattern }) => {
        const result = toolListDatasets({ technique, name_pattern });
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result)
            }]
        };
    }
);

// Tool: list_evaluators
server.tool(
    'list_evaluators',
    'Queries registered evaluators from the local registry. Supports filtering by technique and type.',
    {
        technique: z.enum(['rlvr', 'rlaif']).optional().describe('Filter by tuning technique'),
        type: z.enum(['lambda', 'model']).optional().describe('Filter by evaluator type')
    },
    async ({ technique, type }) => {
        const result = toolListEvaluators({ technique, type });
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result)
            }]
        };
    }
);

// Tool: get_dataset
server.tool(
    'get_dataset',
    'Returns full metadata for a specific registered dataset by name.',
    {
        name: z.string().describe('Name of the dataset to look up')
    },
    async ({ name }) => {
        const result = toolGetDataset({ name });
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result)
            }]
        };
    }
);

// Tool: get_evaluator
server.tool(
    'get_evaluator',
    'Returns full metadata for a specific registered evaluator by name.',
    {
        name: z.string().describe('Name of the evaluator to look up')
    },
    async ({ name }) => {
        const result = toolGetEvaluator({ name });
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result)
            }]
        };
    }
);

// ── Exports for testing ──────────────────────────────────────────────────────

export {
    toolGetModelRegistry,
    toolGetModelVersion,
    toolListDatasets,
    toolListEvaluators,
    toolGetDataset,
    toolGetEvaluator,
    loadBootstrapProfile,
    _loadLocalRegistry,
    _loadDeploymentRegistry,
    _loadDatasetsRegistry,
    _loadEvaluatorsRegistry,
    _offlineFallback,
    _offlineFallbackVersion,
    _listModelPackages,
    _describeModelPackage,
    _batchDescribe,
    _resolveCredentials,
    _ensureSdkLoaded,
    _createClient,
    DATASETS_REGISTRY_PATH,
    EVALUATORS_REGISTRY_PATH,
    LOCAL_REGISTRY_PATH,
    DEFAULT_LIMIT,
    SAGEMAKER_MAX_RESULTS
};

// Guard MCP transport — only connect when run as main module
const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;

if (isMain) {
    log('Starting Model Registry MCP server');
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
