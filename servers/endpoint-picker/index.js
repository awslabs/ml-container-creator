#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Endpoint Picker MCP Server
 *
 * A bundled MCP server that discovers available SageMaker real-time endpoints
 * with capacity for attaching new inference components.
 *
 * Uses ListEndpoints (InService only), DescribeEndpoint for variant info,
 * and ListInferenceComponents to calculate available GPU capacity.
 *
 * Tool: get_inference_endpoints
 *   Accepts: { parameters: string[], limit: number, context: object }
 *   Returns: { values: Record<string, string>, choices: Record<string, string[]>, metadata: object }
 *
 * Environment variables:
 *   AWS_REGION - AWS region for SageMaker API calls (default: us-east-1)
 *   AWS_PROFILE - AWS profile to use for credentials
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { DynamicResolver } from '../lib/dynamic-resolver.js';

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[endpoint-picker] ${message}\n`);
}

// ── Instance catalog for GPU lookup ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _instanceCatalog = null;

/**
 * Load the instance catalog from servers/lib/catalogs/instances.json.
 * Returns a map of instanceType -> { gpus, ... }
 */
function _loadInstanceCatalog() {
    if (_instanceCatalog) return _instanceCatalog;
    try {
        const catalogPath = resolve(__dirname, '../lib/catalogs/instances.json');
        const raw = readFileSync(catalogPath, 'utf8');
        const parsed = JSON.parse(raw);
        _instanceCatalog = parsed.catalog || parsed;
        return _instanceCatalog;
    } catch (err) {
        log(`Warning: could not load instance catalog: ${err.message}`);
        _instanceCatalog = {};
        return _instanceCatalog;
    }
}

/**
 * Look up GPUs per instance for a given instance type.
 * Returns null if the instance type is not in the catalog.
 */
function getGpusForInstance(instanceType) {
    const catalog = _loadInstanceCatalog();
    const entry = catalog[instanceType];
    if (!entry) return null;
    return entry.gpus ?? null;
}

// ── AWS SDK lazy loading ─────────────────────────────────────────────────────

let _SageMakerClient = null;
let _ListEndpointsCommand = null;
let _DescribeEndpointCommand = null;
let _DescribeEndpointConfigCommand = null;
let _ListInferenceComponentsCommand = null;
let _fromIni = null;

/**
 * Lazily load the AWS SDK SageMaker client classes.
 */
async function _ensureSdkLoaded() {
    if (_SageMakerClient) return;
    const sdk = await import('@aws-sdk/client-sagemaker');
    _SageMakerClient = sdk.SageMakerClient;
    _ListEndpointsCommand = sdk.ListEndpointsCommand;
    _DescribeEndpointCommand = sdk.DescribeEndpointCommand;
    _DescribeEndpointConfigCommand = sdk.DescribeEndpointConfigCommand;
    _ListInferenceComponentsCommand = sdk.ListInferenceComponentsCommand;
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
 * Create a SageMaker client for the given region.
 */
function createSageMakerClient(region, clientFactory = null) {
    if (clientFactory) return clientFactory(region);
    return _defaultClientFactory(region);
}

/**
 * Create a SageMaker client using a named AWS profile via fromIni.
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

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Fetch InService real-time endpoints with capacity information.
 *
 * @param {object} client - SageMaker client instance
 * @param {object} options - { limit, showFull }
 * @returns {Promise<Array<object>>} Array of endpoint info objects
 */
async function fetchEndpoints(client, { limit = 10, showFull = false } = {}) {
    const endpoints = [];
    let nextToken;
    const maxDescribeCalls = 10;

    // Paginate ListEndpoints — InService only, sorted by creation time descending
    const collectedNames = [];
    do {
        const params = {
            StatusEquals: 'InService',
            SortBy: 'CreationTime',
            SortOrder: 'Descending',
            MaxResults: 100
        };
        if (nextToken) params.NextToken = nextToken;

        const command = new _ListEndpointsCommand(params);
        const response = await client.send(command);

        const summaries = response.Endpoints || [];
        for (const summary of summaries) {
            collectedNames.push(summary.EndpointName);
            if (collectedNames.length >= limit) break;
        }

        nextToken = response.NextToken;
    } while (nextToken && collectedNames.length < limit);

    // Cap describe calls to maxDescribeCalls
    const toDescribe = collectedNames.slice(0, maxDescribeCalls);

    // Describe each endpoint and list its inference components
    for (const endpointName of toDescribe) {
        try {
            // DescribeEndpoint
            const describeCmd = new _DescribeEndpointCommand({ EndpointName: endpointName });
            const detail = await client.send(describeCmd);

            const variants = detail.ProductionVariants || [];
            const primaryVariant = variants[0] || {};

            const variantName = primaryVariant.VariantName || 'AllTraffic';
            let instanceType = primaryVariant.InstanceType || null;
            let instancePools = primaryVariant.InstancePools || null;

            // For IC-based endpoints, InstanceType may not be in the variant runtime response.
            // Fall back to DescribeEndpointConfig which has either InstanceType or InstancePools.
            if (!instanceType && !instancePools && detail.EndpointConfigName) {
                try {
                    const ecCmd = new _DescribeEndpointConfigCommand({ EndpointConfigName: detail.EndpointConfigName });
                    const ecDetail = await client.send(ecCmd);
                    const ecVariant = (ecDetail.ProductionVariants || [])[0];
                    if (ecVariant?.InstanceType) {
                        instanceType = ecVariant.InstanceType;
                    } else if (ecVariant?.InstancePools && ecVariant.InstancePools.length > 0) {
                        instancePools = ecVariant.InstancePools;
                    }
                } catch (ecErr) {
                    log(`Warning: could not describe endpoint config for "${endpointName}": ${ecErr.message}`);
                }
            }

            // Resolve instanceType display string from pools if needed
            if (!instanceType && instancePools && instancePools.length > 0) {
                // Sort by priority, use highest-priority (lowest number) for GPU lookup
                const sorted = [...instancePools].sort((a, b) => (a.Priority || 99) - (b.Priority || 99));
                instanceType = sorted[0].InstanceType || 'unknown';
                // Build display string showing the pool: "ml.g5.12xl (pool: 3 types)"
                if (sorted.length > 1) {
                    instanceType = `${instanceType} (pool: ${sorted.length} types)`;
                }
            } else {
                instanceType = instanceType || 'unknown';
            }

            const instanceCount = primaryVariant.CurrentInstanceCount ?? primaryVariant.DesiredInstanceCount ?? 1;
            const hasInstancePools = !!(primaryVariant.InstancePools && primaryVariant.InstancePools.length > 0);

            // ListInferenceComponents for this endpoint
            let icCount = 0;
            let totalGpuAllocated = 0;
            let icNextToken;
            do {
                const icParams = { EndpointNameEquals: endpointName, MaxResults: 100 };
                if (icNextToken) icParams.NextToken = icNextToken;

                const icCmd = new _ListInferenceComponentsCommand(icParams);
                const icResponse = await client.send(icCmd);

                const components = icResponse.InferenceComponents || [];
                for (const ic of components) {
                    icCount++;
                    const gpuReq = ic.Specification?.ComputeResourceRequirements?.NumberOfAcceleratorDevicesRequired
                        ?? ic.ComputeResourceRequirements?.NumberOfAcceleratorDevicesRequired
                        ?? 0;
                    totalGpuAllocated += gpuReq;
                }

                icNextToken = icResponse.NextToken;
            } while (icNextToken);

            // Capacity estimation
            // For pool endpoints, instanceType may be "ml.g5.12xlarge (pool: 3 types)"
            // Extract the raw type for catalog lookup
            const instanceTypeForLookup = instanceType.includes(' (pool:')
                ? instanceType.split(' (pool:')[0]
                : instanceType;
            const gpusPerInstance = getGpusForInstance(instanceTypeForLookup);
            let availableGpus;
            if (gpusPerInstance === null) {
                availableGpus = '?';
            } else {
                availableGpus = (instanceCount * gpusPerInstance) - totalGpuAllocated;
            }

            // Filter: by default only return endpoints with available capacity
            if (!showFull && availableGpus !== '?' && availableGpus <= 0) {
                continue;
            }

            endpoints.push({
                endpointName,
                variantName,
                instanceType,
                instanceCount,
                icCount,
                availableGpus,
                hasInstancePools
            });
        } catch (err) {
            if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException') {
                log(`AccessDeniedException for endpoint "${endpointName}" — skipping`);
                continue;
            }
            log(`Warning: could not describe endpoint "${endpointName}": ${err.message}`);
        }
    }

    return endpoints;
}

/**
 * Build the MCP response from a list of discovered endpoints.
 *
 * @param {Array} endpoints - Array of endpoint objects from fetchEndpoints
 * @returns {{ values: object, choices: object, metadata?: object, message?: string }}
 */
function buildResponse(endpoints) {
    if (!endpoints || endpoints.length === 0) {
        return {
            values: {},
            choices: { endpointName: [] },
            message: 'No InService real-time endpoints with available capacity found in the specified region.'
        };
    }

    const endpointNames = endpoints.map(e => e.endpointName);

    return {
        values: { endpointName: endpointNames[0] },
        choices: { endpointName: endpointNames },
        metadata: Object.fromEntries(
            endpoints.map(e => [e.endpointName, {
                variantName: e.variantName,
                instanceType: e.instanceType,
                instanceCount: e.instanceCount,
                icCount: e.icCount,
                availableGpus: e.availableGpus,
                hasInstancePools: e.hasInstancePools
            }])
        )
    };
}

// ── EndpointResolver ─────────────────────────────────────────────────────────

/**
 * EndpointResolver — discovers InService SageMaker real-time endpoints.
 *
 * Extends DynamicResolver to fit the shared resolver pattern. Wraps the
 * fetchEndpoints logic with credential strategy fallback.
 */
class EndpointResolver extends DynamicResolver {
    constructor(options = {}) {
        super();
        this._region = options.region || process.env.AWS_REGION || 'us-east-1';
        this._profile = options.profile || process.env.AWS_PROFILE || null;
        this._clientFactory = options.clientFactory || null;
    }

    async fetch(key, options = {}) {
        const { limit = 10, showFull = false } = options;

        await _ensureSdkLoaded();

        let endpoints = null;
        let lastError = null;

        // Strategy 1: If a specific profile was requested, use it directly
        if (this._profile) {
            try {
                const client = _createClientWithProfile(this._region, this._profile);
                endpoints = await fetchEndpoints(client, { limit, showFull });
            } catch (err) {
                log(`Profile "${this._profile}" failed: ${err.message}`);
                lastError = err;
            }
        }

        // Strategy 2: Try the default credential chain
        if (!endpoints) {
            try {
                const client = createSageMakerClient(this._region, this._clientFactory);
                endpoints = await fetchEndpoints(client, { limit, showFull });
            } catch (err) {
                log(`Default credential chain failed: ${err.message}`);
                lastError = err;
            }
        }

        // Strategy 3: Detect available AWS profiles and try each
        if (!endpoints && _fromIni) {
            const profiles = _detectAwsProfiles();
            for (const p of profiles) {
                try {
                    const client = _createClientWithProfile(this._region, p);
                    endpoints = await fetchEndpoints(client, { limit, showFull });
                    log(`Profile "${p}" succeeded`);
                    break;
                } catch (err) {
                    log(`Profile "${p}" failed: ${err.message}`);
                    lastError = err;
                }
            }
        }

        if (!endpoints) {
            throw lastError || new Error('No AWS credentials available');
        }

        return {
            items: endpoints,
            defaultItem: endpoints[0] || null
        };
    }

    supportedKeys() {
        return ['endpointName'];
    }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'endpoint-picker',
    version: '1.0.0'
});

// Register the get_inference_endpoints tool
server.tool(
    'get_inference_endpoints',
    'Discovers InService SageMaker real-time endpoints with available capacity for IC attachment',
    {
        parameters: z.array(z.string()).describe('List of parameter names to provide values for'),
        limit: z.number().int().positive().default(10).describe('Maximum number of endpoints to return'),
        context: z.record(z.string(), z.any()).optional().describe('Current configuration context (awsRegion, awsProfile, deploymentTarget)')
    },
    async ({ parameters: _parameters, limit, context }) => {
        // Only respond if context.deploymentTarget is realtime-inference
        // Note: parameters may be empty when called on-demand via queryMcpServer()
        if (context?.deploymentTarget && context.deploymentTarget !== 'realtime-inference') {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ values: {}, choices: {} })
                }]
            };
        }

        const region = context?.awsRegion || process.env.AWS_REGION || 'us-east-1';
        const profile = context?.awsProfile || process.env.AWS_PROFILE || null;
        const showFull = context?.showFull || false;
        log(`Querying InService endpoints in region: ${region}${profile ? ` (profile: ${profile})` : ''}`);

        try {
            await _ensureSdkLoaded();

            let endpoints = null;
            let lastError = null;

            // Strategy 1: If a specific profile was requested, use it directly
            if (profile) {
                try {
                    log(`Trying explicit profile: ${profile}`);
                    const client = _createClientWithProfile(region, profile);
                    endpoints = await fetchEndpoints(client, { limit, showFull });
                } catch (err) {
                    log(`Profile "${profile}" failed: ${err.message}`);
                    lastError = err;
                }
            }

            // Strategy 2: Try the default credential chain
            if (!endpoints) {
                try {
                    log('Trying default credential chain');
                    const client = createSageMakerClient(region);
                    endpoints = await fetchEndpoints(client, { limit, showFull });
                } catch (err) {
                    log(`Default credential chain failed: ${err.message}`);
                    lastError = err;
                }
            }

            // Strategy 3: Detect available AWS profiles and try each
            if (!endpoints && _fromIni) {
                const profiles = _detectAwsProfiles();
                if (profiles.length > 0) {
                    log(`Default credentials failed, trying ${profiles.length} detected profile(s): ${profiles.join(', ')}`);
                    for (const p of profiles) {
                        try {
                            const client = _createClientWithProfile(region, p);
                            endpoints = await fetchEndpoints(client, { limit, showFull });
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
            if (!endpoints) {
                throw lastError || new Error('No AWS credentials available');
            }

            const result = buildResponse(endpoints);

            if (endpoints.length > 0) {
                log(`Found ${endpoints.length} endpoint(s) with available capacity`);
            } else {
                log('No InService endpoints with available capacity found');
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result)
                }]
            };
        } catch (err) {
            log(`Error querying endpoints: ${err.message}`);

            // Handle AccessDeniedException gracefully
            if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException') {
                log('AccessDeniedException — returning empty result');
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            values: {},
                            choices: { endpointName: [] },
                            message: 'Access denied when querying SageMaker endpoints. Check IAM permissions.'
                        })
                    }]
                };
            }

            const errorResult = {
                values: {},
                choices: { endpointName: [] },
                error: err.message,
                message: `Failed to query endpoints: ${err.message}`
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
export {
    fetchEndpoints,
    buildResponse,
    createSageMakerClient,
    getGpusForInstance,
    _ensureSdkLoaded,
    _loadInstanceCatalog,
    EndpointResolver
};

// Guard MCP transport — only connect when run as main module
const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;

if (isMain) {
    log('Starting Endpoint Picker MCP server');
    await _ensureSdkLoaded();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
