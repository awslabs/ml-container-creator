#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Picker MCP Server
 *
 * A bundled MCP server that discovers active AWS Marketplace model package
 * subscriptions for deployment via the ml-container-creator generator.
 *
 * Uses ListModelPackages with ModelPackageType='Marketplace' to find subscribed
 * packages, then DescribeModelPackage for each to extract InferenceSpecification
 * details (supported instance types, content types).
 *
 * Tool: get_marketplace_subscriptions
 *   Accepts: { region?: string, limit?: number }
 *   Returns: { subscriptions: [...], message: string }
 *
 * Environment variables:
 *   AWS_REGION - AWS region for SageMaker API calls (default: us-east-1)
 *   AWS_PROFILE - AWS profile to use for credentials
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * Log to stderr so it doesn't interfere with MCP stdio protocol on stdout.
 */
function log(message) {
    process.stderr.write(`[marketplace-picker] ${message}\n`)
}

// ── AWS SDK lazy loading ─────────────────────────────────────────────────────

let _SageMakerClient = null
let _ListModelPackagesCommand = null
let _DescribeModelPackageCommand = null
let _fromIni = null

/**
 * Lazily load the AWS SDK SageMaker client classes.
 */
async function _ensureSdkLoaded() {
    if (_SageMakerClient) return
    const sdk = await import('@aws-sdk/client-sagemaker')
    _SageMakerClient = sdk.SageMakerClient
    _ListModelPackagesCommand = sdk.ListModelPackagesCommand
    _DescribeModelPackageCommand = sdk.DescribeModelPackageCommand
    try {
        const credentialProviders = await import('@aws-sdk/credential-providers')
        _fromIni = credentialProviders.fromIni
    } catch {
        // credential-providers not available — profile-based fallback won't work
    }
}

/**
 * Create a SageMaker client for the given region using default credential chain.
 */
function _createClient(region) {
    return new _SageMakerClient({ region })
}

/**
 * Create a SageMaker client using a named AWS profile via fromIni.
 */
function _createClientWithProfile(region, profile) {
    if (!_fromIni) {
        throw new Error('Cannot use profile-based credentials: @aws-sdk/credential-providers not available')
    }
    return new _SageMakerClient({
        region,
        credentials: _fromIni({ profile })
    })
}

/**
 * Detect available AWS profile names from ~/.aws/credentials and ~/.aws/config.
 */
function _detectAwsProfiles() {
    const profiles = new Set()
    try {
        const credsPath = resolve(homedir(), '.aws/credentials')
        const creds = readFileSync(credsPath, 'utf8')
        for (const match of creds.matchAll(/^\[(.+)\]$/gm)) {
            profiles.add(match[1])
        }
    } catch { /* no credentials file */ }
    try {
        const configPath = resolve(homedir(), '.aws/config')
        const config = readFileSync(configPath, 'utf8')
        for (const match of config.matchAll(/^\[profile\s+(.+)\]$/gm)) {
            profiles.add(match[1])
        }
    } catch { /* no config file */ }
    return [...profiles]
}

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Fetch marketplace model package subscriptions from SageMaker.
 *
 * Lists model packages with ModelPackageType='Marketplace', then describes
 * each to extract InferenceSpecification details.
 *
 * @param {object} client - SageMaker client instance
 * @param {object} options - { limit }
 * @returns {Promise<Array<object>>} Array of subscription info objects
 */
async function fetchMarketplaceSubscriptions(client, { limit = 20 } = {}) {
    const subscriptions = []
    let nextToken

    // Paginate ListModelPackages — Marketplace type only
    const collectedArns = []
    do {
        const params = {
            ModelPackageType: 'Marketplace',
            MaxResults: Math.min(limit, 100)
        }
        if (nextToken) params.NextToken = nextToken

        const command = new _ListModelPackagesCommand(params)
        const response = await client.send(command)

        const summaries = response.ModelPackageSummaryList || []
        for (const summary of summaries) {
            collectedArns.push(summary.ModelPackageArn)
            if (collectedArns.length >= limit) break
        }

        nextToken = response.NextToken
    } while (nextToken && collectedArns.length < limit)

    // Describe each model package to get InferenceSpecification details
    for (const arn of collectedArns) {
        try {
            const describeCmd = new _DescribeModelPackageCommand({
                ModelPackageName: arn
            })
            const detail = await client.send(describeCmd)

            const inferenceSpec = detail.InferenceSpecification || {}
            const supportedInstanceTypes = inferenceSpec.SupportedRealtimeInferenceInstanceTypes || []
            const supportedContentTypes = inferenceSpec.SupportedContentTypes || []

            // Extract model name from the ARN (last segment before version)
            const arnParts = arn.split('/')
            const modelName = arnParts.length >= 2 ? arnParts[arnParts.length - 2] : arn

            // Extract vendor from model package description or source
            const vendor = detail.ModelPackageDescription
                ? detail.ModelPackageDescription.split(' ')[0]
                : 'Unknown'

            subscriptions.push({
                arn,
                modelName,
                vendor,
                supportedInstanceTypes,
                supportedContentTypes,
                status: detail.ModelPackageStatus || 'Unknown'
            })
        } catch (err) {
            if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException') {
                log(`AccessDeniedException for package "${arn}" — skipping`)
                continue
            }
            log(`Warning: could not describe package "${arn}": ${err.message}`)
        }
    }

    return subscriptions
}

/**
 * Build the MCP response from a list of discovered subscriptions.
 *
 * @param {Array} subscriptions - Array of subscription objects from fetchMarketplaceSubscriptions
 * @returns {{ subscriptions: Array, message: string }}
 */
function buildResponse(subscriptions) {
    if (!subscriptions || subscriptions.length === 0) {
        return {
            subscriptions: [],
            message: 'No active AWS Marketplace model package subscriptions found in this region. Subscribe to models at https://aws.amazon.com/marketplace/solutions/machine-learning'
        }
    }

    return {
        subscriptions,
        message: `Found ${subscriptions.length} Marketplace model package subscription(s).`
    }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'marketplace-picker',
    version: '1.0.0'
})

// Register the get_marketplace_subscriptions tool
server.tool(
    'get_marketplace_subscriptions',
    'Discovers active AWS Marketplace model package subscriptions with supported instance types and content types',
    {
        region: z.string().optional().describe('AWS region to query (defaults to AWS_REGION env var or us-east-1)'),
        limit: z.number().int().positive().default(20).describe('Maximum number of subscriptions to return')
    },
    async ({ region, limit }) => {
        const effectiveRegion = region || process.env.AWS_REGION || 'us-east-1'
        const profile = process.env.AWS_PROFILE || null
        log(`Querying Marketplace subscriptions in region: ${effectiveRegion}${profile ? ` (profile: ${profile})` : ''}`)

        try {
            await _ensureSdkLoaded()

            let subscriptions = null
            let lastError = null

            // Strategy 1: If a specific profile was requested, use it directly
            if (profile) {
                try {
                    log(`Trying explicit profile: ${profile}`)
                    const client = _createClientWithProfile(effectiveRegion, profile)
                    subscriptions = await fetchMarketplaceSubscriptions(client, { limit })
                } catch (err) {
                    log(`Profile "${profile}" failed: ${err.message}`)
                    lastError = err
                }
            }

            // Strategy 2: Try the default credential chain
            if (!subscriptions) {
                try {
                    log('Trying default credential chain')
                    const client = _createClient(effectiveRegion)
                    subscriptions = await fetchMarketplaceSubscriptions(client, { limit })
                } catch (err) {
                    log(`Default credential chain failed: ${err.message}`)
                    lastError = err
                }
            }

            // Strategy 3: Detect available AWS profiles and try each
            if (!subscriptions && _fromIni) {
                const profiles = _detectAwsProfiles()
                if (profiles.length > 0) {
                    log(`Default credentials failed, trying ${profiles.length} detected profile(s): ${profiles.join(', ')}`)
                    for (const p of profiles) {
                        try {
                            const client = _createClientWithProfile(effectiveRegion, p)
                            subscriptions = await fetchMarketplaceSubscriptions(client, { limit })
                            log(`Profile "${p}" succeeded`)
                            break
                        } catch (err) {
                            log(`Profile "${p}" failed: ${err.message}`)
                            lastError = err
                        }
                    }
                }
            }

            // If all strategies failed, throw the last error
            if (!subscriptions) {
                throw lastError || new Error('No AWS credentials available')
            }

            const result = buildResponse(subscriptions)

            if (subscriptions.length > 0) {
                log(`Found ${subscriptions.length} Marketplace subscription(s)`)
            } else {
                log('No Marketplace subscriptions found')
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result)
                }]
            }
        } catch (err) {
            log(`Error querying Marketplace subscriptions: ${err.message}`)

            // Handle AccessDeniedException gracefully
            if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException') {
                log('AccessDeniedException — returning empty result')
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            subscriptions: [],
                            message: 'Access denied when querying Marketplace subscriptions. Check IAM permissions for sagemaker:ListModelPackages and sagemaker:DescribeModelPackage.'
                        })
                    }]
                }
            }

            const errorResult = {
                subscriptions: [],
                error: err.message,
                message: `Failed to query Marketplace subscriptions: ${err.message}`
            }
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(errorResult)
                }]
            }
        }
    }
)

// Export for testing
export {
    fetchMarketplaceSubscriptions,
    buildResponse,
    _ensureSdkLoaded,
    _createClient,
    _createClientWithProfile,
    _detectAwsProfiles
}

// Guard MCP transport — only connect when run as main module
const __filename = fileURLToPath(import.meta.url)
const isMain = process.argv[1] && resolve(process.argv[1]) === __filename

if (isMain) {
    log('Starting Marketplace Picker MCP server')
    await _ensureSdkLoaded()
    const transport = new StdioServerTransport()
    await server.connect(transport)
}
