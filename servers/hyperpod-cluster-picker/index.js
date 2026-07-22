#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HyperPod Cluster Picker MCP Server
 *
 * A bundled MCP server that discovers available SageMaker HyperPod EKS clusters
 * via the AWS SageMaker ListClusters and DescribeCluster APIs.
 *
 * Only clusters that are InService and use EKS orchestration are returned.
 * Slurm-based clusters are excluded.
 *
 * Enhanced capabilities (v1.4):
 * - GPU capacity reporting (total/allocated/available per instance group)
 * - Model-aware node group recommendation (VRAM-based)
 * - Kueue/PriorityClass awareness for queue selection
 *
 * Tool: get_hyperpod_clusters
 *   Accepts: { parameters: string[], limit: number, context: object, modelName: string, modelParams: number }
 *   Returns: { values: Record<string, string>, choices: Record<string, string[]>, metadata: object }
 *
 * Environment variables:
 *   AWS_REGION - AWS region for SageMaker API calls (default: us-east-1)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { DynamicResolver } from '../lib/dynamic-resolver.js';
import {
    calculateTotalGpus,
    getAllocatedGpus,
    computeVramGb,
    recommendNodeGroup,
    lookupModelParams,
    detectKueueQueues,
    detectPriorityClasses
} from './gpu-capacity.js';

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[hyperpod-cluster-picker] ${message}\n`);
}

/**
 * Create a SageMaker client for the given region.
 * Accepts an optional factory function for testability.
 * If no credentials are found with the default provider chain,
 * falls back to the first available AWS profile.
 *
 * @param {string} region - AWS region
 * @param {Function|null} clientFactory - Optional factory (used in tests)
 * @returns {object} SageMaker client
 */
function createSageMakerClient(region, clientFactory = null) {
    if (clientFactory) return clientFactory(region);
    return _defaultClientFactory(region);
}

let _SageMakerClient = null;
let _ListClustersCommand = null;
let _DescribeClusterCommand = null;
let _fromIni = null;

/**
 * Lazily load the AWS SDK SageMaker client classes.
 * This allows the module to be imported in test environments
 * without requiring @aws-sdk/client-sagemaker to be installed.
 */
async function _ensureSdkLoaded() {
    if (_SageMakerClient) return;
    const sdk = await import('@aws-sdk/client-sagemaker');
    _SageMakerClient = sdk.SageMakerClient;
    _ListClustersCommand = sdk.ListClustersCommand;
    _DescribeClusterCommand = sdk.DescribeClusterCommand;
    try {
        const credentialProviders = await import('@aws-sdk/credential-providers');
        _fromIni = credentialProviders.fromIni;
    } catch {
        // credential-providers not available — profile-based fallback won't work
    }
}

function _defaultClientFactory(region) {
    return new _SageMakerClient({ region });
}

/**
 * Create a SageMaker client using a named AWS profile via fromIni.
 * @param {string} region - AWS region
 * @param {string} profile - AWS profile name
 * @returns {object} SageMaker client
 */
function _createClientWithProfile(region, profile) {
    if (!_fromIni) {
        throw new Error('Cannot use profile-based credentials: @aws-sdk/credential-providers not available');
    }
    return new _SageMakerClient({
        region,
        credentials: _fromIni({ profile })
    });
}

/**
 * Detect available AWS profile names from ~/.aws/credentials and ~/.aws/config.
 * @returns {string[]} Array of profile names
 */
function _detectAwsProfiles() {
    const profiles = new Set();
    try {
        const credsPath = resolve(homedir(), '.aws/credentials');
        const creds = readFileSync(credsPath, 'utf8');
        for (const match of creds.matchAll(/^\[(.+)\]$/gm)) {
            profiles.add(match[1]);
        }
    } catch { /* no credentials file */ }
    try {
        const configPath = resolve(homedir(), '.aws/config');
        const config = readFileSync(configPath, 'utf8');
        for (const match of config.matchAll(/^\[profile\s+(.+)\]$/gm)) {
            profiles.add(match[1]);
        }
    } catch { /* no config file */ }
    return [...profiles];
}

/**
 * Fetch all HyperPod clusters, filtering to InService + EKS only.
 *
 * @param {object} client - SageMaker client instance
 * @param {object} options - { limit }
 * @returns {Promise<Array<{ clusterName: string, clusterArn: string, status: string, instanceGroups: Array }>>}
 */
/**
 * Fetch raw instance group data for a cluster via AWS CLI.
 * Used as a fallback when the SDK version doesn't deserialize InstanceRequirements
 * (a newer API field for flexible instance groups).
 *
 * @param {string} clusterName
 * @param {string} region
 * @param {string} [profile]
 * @returns {Object} map of groupName → { instanceType, instanceTypes, isFlexible }
 */
function fetchFlexibleGroupsViaCLI(clusterName, region, profile) {
    try {
        const profileArg = profile ? `--profile ${profile}` : '';
        const cmd = `aws sagemaker describe-cluster --cluster-name "${clusterName}" --region ${region} ${profileArg} --query 'InstanceGroups[].{Name:InstanceGroupName,Type:InstanceType,Req:InstanceRequirements}' --output json 2>/dev/null`;
        const raw = execSync(cmd, { timeout: 10000 }).toString();
        const groups = JSON.parse(raw);
        const result = {};
        for (const g of groups) {
            const req = g.Req;
            const flexible = !g.Type && !!req;
            const instanceTypes = (req && req.DesiredInstanceTypes) || (g.Type ? [g.Type] : []);
            result[g.Name] = {
                instanceType: g.Type || (instanceTypes[0] || null),
                instanceTypes,
                isFlexible: flexible
            };
        }
        return result;
    } catch {
        return {};
    }
}

async function fetchHyperPodClusters(client, { limit = 10, region = 'us-east-1', profile = null } = {}) {
    const clusters = [];
    let nextToken;

    // Paginate through ListClusters
    do {
        const params = { MaxResults: 100 };
        if (nextToken) params.NextToken = nextToken;

        const command = new _ListClustersCommand(params);
        const response = await client.send(command);

        const summaries = response.ClusterSummaries || [];
        for (const summary of summaries) {
            // Filter: InService only
            if (summary.ClusterStatus !== 'InService') continue;

            clusters.push({
                clusterName: summary.ClusterName,
                clusterArn: summary.ClusterArn,
                status: summary.ClusterStatus
            });
        }

        nextToken = response.NextToken;
    } while (nextToken && clusters.length < limit * 3); // over-fetch to account for EKS filtering

    // Now describe each cluster to check orchestrator type and get instance groups
    const eksClusters = [];
    for (const cluster of clusters) {
        if (eksClusters.length >= limit) break;

        try {
            const describeCommand = new _DescribeClusterCommand({
                ClusterName: cluster.clusterName
            });
            const detail = await client.send(describeCommand);

            // Filter: EKS orchestrator only (exclude Slurm)
            const orchestrator = detail.Orchestrator?.Eks ? 'EKS' : 'Slurm';
            if (orchestrator !== 'EKS') continue;

            // The AWS SDK may not deserialize InstanceRequirements (newer API field).
            // Detect flexible groups by checking if any group is missing InstanceType,
            // then fall back to CLI to fetch the raw data.
            const sdkGroups = detail.InstanceGroups || [];
            const hasFlexible = sdkGroups.some(g => !g.InstanceType);
            const flexData = hasFlexible
                ? fetchFlexibleGroupsViaCLI(cluster.clusterName, region, profile)
                : {};

            const instanceGroups = sdkGroups.map(g => {
                const flex = flexData[g.InstanceGroupName] || {};
                const instanceType = g.InstanceType || flex.instanceType || null;
                const instanceTypes = flex.instanceTypes || (instanceType ? [instanceType] : []);
                const isFlexible = !g.InstanceType && flex.isFlexible === true;
                return {
                    name: g.InstanceGroupName,
                    instanceType,
                    instanceTypes,
                    count: g.CurrentCount ?? g.TargetCount ?? 0,
                    isFlexible
                };
            });

            eksClusters.push({
                clusterName: cluster.clusterName,
                clusterArn: cluster.clusterArn,
                status: cluster.status,
                instanceGroups
            });
        } catch (err) {
            log(`Warning: could not describe cluster "${cluster.clusterName}": ${err.message}`);
        }
    }

    return eksClusters;
}

/**
 * Build the MCP response from a list of discovered clusters.
 *
 * @param {Array} clusters - Array of cluster objects from fetchHyperPodClusters
 * @param {object} [options] - { modelName, modelParams, kubectlOptions }
 * @returns {{ values: object, choices: object, metadata?: object }}
 */
function buildResponse(clusters, options = {}) {
    if (!clusters || clusters.length === 0) {
        return {
            values: {},
            choices: { hyperPodCluster: [] },
            message: 'No InService HyperPod EKS clusters found in the specified region. Verify the region and that you have HyperPod EKS clusters provisioned.'
        };
    }

    const { modelName, modelParams, kubectlOptions } = options;
    const clusterNames = clusters.map(c => c.clusterName);

    // Enrich instance groups with GPU capacity
    const enrichedClusters = clusters.map(c => {
        const enrichedGroups = (c.instanceGroups || []).map(g => {
            const totalGpus = calculateTotalGpus(g.count, g.instanceType);
            return {
                ...g,
                gpuCapacity: {
                    total: totalGpus,
                    allocated: null,
                    available: null,
                    availability: 'unknown'
                }
            };
        });
        return { ...c, instanceGroups: enrichedGroups };
    });

    // Try to get allocated GPUs from kubectl (graceful degradation)
    const { allocated: totalAllocated } = getAllocatedGpus(kubectlOptions || {});
    if (totalAllocated !== null) {
        // Distribute allocated across instance groups (best-effort: sum all)
        for (const cluster of enrichedClusters) {
            for (const group of cluster.instanceGroups) {
                if (group.gpuCapacity.total !== null) {
                    group.gpuCapacity.allocated = totalAllocated;
                    group.gpuCapacity.available = Math.max(0, group.gpuCapacity.total - totalAllocated);
                    group.gpuCapacity.availability = 'known';
                }
            }
        }
    }

    // Model-aware recommendation
    let recommendation = null;
    let resolvedModelParams = modelParams || null;

    if (modelName && !resolvedModelParams) {
        resolvedModelParams = lookupModelParams(modelName);
    }

    if (resolvedModelParams) {
        const vramGb = computeVramGb(resolvedModelParams);
        // Aggregate all instance groups across all clusters for recommendation
        const allGroups = enrichedClusters.flatMap(c => c.instanceGroups);
        recommendation = recommendNodeGroup(allGroups, vramGb);
    }

    // Queue / PriorityClass detection
    let queues = null;
    let priorityClasses = null;
    const queueResult = detectKueueQueues(kubectlOptions || {});
    if (queueResult.queues.length > 0) {
        queues = queueResult.queues;
    } else {
        const pcResult = detectPriorityClasses(kubectlOptions || {});
        if (pcResult.priorityClasses.length > 0) {
            priorityClasses = pcResult.priorityClasses;
        }
    }

    // Build metadata: backward-compatible flat cluster map format
    // Each cluster is a key in metadata with clusterArn, status, instanceGroups
    const metadata = Object.fromEntries(
        enrichedClusters.map(c => [c.clusterName, {
            clusterArn: c.clusterArn,
            status: c.status,
            instanceGroups: c.instanceGroups
        }])
    );

    // Add new top-level fields to metadata (additive — existing consumers unaffected)
    if (recommendation) {
        metadata.recommendation = recommendation;
    }
    if (queues) {
        metadata.queues = queues;
    }
    if (priorityClasses) {
        metadata.priorityClasses = priorityClasses;
    }

    return {
        values: { hyperPodCluster: clusterNames[0] },
        choices: { hyperPodCluster: clusterNames },
        metadata
    };
}

// ── ClusterResolver ──────────────────────────────────────────────────────────

/**
 * ClusterResolver — discovers HyperPod EKS clusters via AWS SageMaker APIs.
 *
 * Extends DynamicResolver to fit the shared resolver pattern. Wraps the
 * existing fetchHyperPodClusters logic with credential strategy fallback.
 */
class ClusterResolver extends DynamicResolver {
    constructor(options = {}) {
        super();
        this._region = options.region || process.env.AWS_REGION || 'us-east-1';
        this._profile = options.profile || process.env.AWS_PROFILE || null;
        this._clientFactory = options.clientFactory || null;
    }

    async fetch(key, options = {}) {
        const { limit = 10 } = options;

        await _ensureSdkLoaded();

        let clusters = null;
        let lastError = null;

        // Strategy 1: If a specific profile was requested, use it directly
        if (this._profile) {
            try {
                const client = _createClientWithProfile(this._region, this._profile);
                clusters = await fetchHyperPodClusters(client, { limit, region: this._region, profile: this._profile });
            } catch (err) {
                log(`Profile "${this._profile}" failed: ${err.message}`);
                lastError = err;
            }
        }

        // Strategy 2: Try the default credential chain
        if (!clusters) {
            try {
                const client = createSageMakerClient(this._region, this._clientFactory);
                clusters = await fetchHyperPodClusters(client, { limit, region: this._region, profile: null });
            } catch (err) {
                log(`Default credential chain failed: ${err.message}`);
                lastError = err;
            }
        }

        // Strategy 3: Detect available AWS profiles and try each
        if (!clusters && _fromIni) {
            const profiles = _detectAwsProfiles();
            for (const p of profiles) {
                try {
                    const client = _createClientWithProfile(this._region, p);
                    clusters = await fetchHyperPodClusters(client, { limit, region: this._region, profile: p });
                    log(`Profile "${p}" succeeded`);
                    break;
                } catch (err) {
                    log(`Profile "${p}" failed: ${err.message}`);
                    lastError = err;
                }
            }
        }

        if (!clusters) {
            throw lastError || new Error('No AWS credentials available');
        }

        return {
            items: clusters,
            defaultItem: clusters[0] || null
        };
    }

    supportedKeys() {
        return ['hyperPodCluster'];
    }
}

// Create MCP server
const server = new McpServer({
    name: 'hyperpod-cluster-picker',
    version: '1.0.0'
});

// Register the get_hyperpod_clusters tool
server.tool(
    'get_hyperpod_clusters',
    'Discovers available SageMaker HyperPod EKS clusters for deployment target selection',
    {
        parameters: z.array(z.string()).describe('List of parameter names to provide values for'),
        limit: z.number().int().positive().default(10).describe('Maximum number of choices per parameter'),
        context: z.record(z.string(), z.any()).optional().describe('Current configuration context (awsRegion, etc.)'),
        modelName: z.string().optional().describe('Model name for VRAM-based node group recommendation (e.g. meta-llama/Llama-3.2-7B-Instruct)'),
        modelParams: z.number().optional().describe('Model parameter count in billions for VRAM calculation (e.g. 7 for 7B)')
    },
    async ({ parameters, limit, context, modelName, modelParams }) => {
        // If hyperPodCluster is not requested, return empty
        if (!parameters.includes('hyperPodCluster')) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ values: {}, choices: {} })
                }]
            };
        }

        const region = context?.awsRegion || process.env.AWS_REGION || 'us-east-1';
        const profile = context?.awsProfile || process.env.AWS_PROFILE || null;
        log(`Querying HyperPod clusters in region: ${region}${profile ? ` (profile: ${profile})` : ''}`);

        try {
            await _ensureSdkLoaded();

            let clusters = null;
            let lastError = null;

            // Strategy 1: If a specific profile was requested, use it directly
            if (profile) {
                try {
                    log(`Trying explicit profile: ${profile}`);
                    const client = _createClientWithProfile(region, profile);
                    clusters = await fetchHyperPodClusters(client, { limit, region, profile });
                } catch (err) {
                    log(`Profile "${profile}" failed: ${err.message}`);
                    lastError = err;
                }
            }

            // Strategy 2: Try the default credential chain (env vars, instance profile, etc.)
            if (!clusters) {
                try {
                    log('Trying default credential chain');
                    const client = createSageMakerClient(region);
                    clusters = await fetchHyperPodClusters(client, { limit, region, profile });
                } catch (err) {
                    log(`Default credential chain failed: ${err.message}`);
                    lastError = err;
                }
            }

            // Strategy 3: Detect available AWS profiles and try each
            if (!clusters && _fromIni) {
                const profiles = _detectAwsProfiles();
                if (profiles.length > 0) {
                    log(`Default credentials failed, trying ${profiles.length} detected profile(s): ${profiles.join(', ')}`);
                    for (const p of profiles) {
                        try {
                            const client = _createClientWithProfile(region, p);
                            clusters = await fetchHyperPodClusters(client, { limit, region, profile: p });
                            log(`Profile "${p}" succeeded`);
                            break;
                        } catch (err) {
                            log(`Profile "${p}" failed: ${err.message}`);
                            lastError = err;
                        }
                    }
                }
            }

            // If all strategies failed, throw the last error
            if (!clusters) {
                throw lastError || new Error('No AWS credentials available');
            }

            const result = buildResponse(clusters, { modelName, modelParams });

            if (clusters.length > 0) {
                log(`Found ${clusters.length} HyperPod EKS cluster(s)`);
            } else {
                log('No InService HyperPod EKS clusters found');
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result)
                }]
            };
        } catch (err) {
            log(`Error querying clusters: ${err.message}`);
            const errorResult = {
                values: {},
                choices: { hyperPodCluster: [] },
                error: err.message,
                message: `Failed to query HyperPod clusters: ${err.message}`
            };
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(errorResult)
                }]
            };
        }
    }
);

// Export for testing
export { fetchHyperPodClusters, buildResponse, createSageMakerClient, _ensureSdkLoaded, ClusterResolver };
export { getGpuCount, calculateTotalGpus, getAllocatedGpus, computeVramGb, recommendNodeGroup, lookupModelParams, detectKueueQueues, detectPriorityClasses } from './gpu-capacity.js';

// Guard MCP transport — only connect when run as main module
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;

if (isMain) {
    log('Starting HyperPod Cluster Picker MCP server');
    await _ensureSdkLoaded();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
