// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DLC Resolver — Driver-Aware Deep Learning Container Image Resolution.
 *
 * Resolves a stock AWS DLC image URI compatible with the target instance's
 * CUDA driver version. Uses filterImages() from the image-filter module for
 * driver compatibility checking, and queries the base-image-picker MCP server
 * for the available image catalog.
 *
 * Flow:
 *   1. Resolve fleet driver from instance type (via resolveFleetDriver)
 *   2. Query base-image-picker MCP for available DLC images
 *   3. Apply filterImages() for CUDA driver + model arch compatibility
 *   4. Return best-match URI
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterImages, resolveFleetDriver, parseInstanceFamily } from '../../servers/lib/image-filter.js';
import McpClient from './mcp-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '../..');

/**
 * Known AWS DLC-publishing account IDs.
 * Used by do/deploy to distinguish DLC images from custom ECR images
 * and skip ECR auth (SageMaker can pull DLC images natively).
 */
export const DLC_ACCOUNT_IDS = [
    '763104351884',  // us-east-1, us-west-2, eu-west-1, ap-southeast-1, ap-northeast-1
    '217643126080',  // eu-central-1
    '462105765813',  // ap-northeast-1 (alternate)
    '727897471807',  // ap-south-1, ap-southeast-2
    '683313688378',  // us-east-2
    '520713654638',  // eu-west-2
    '626614931356',  // af-south-1
    '871362719292'  // eu-north-1
];

/**
 * Error thrown when no CUDA-driver-compatible DLC image can be resolved.
 */
export class DlcResolutionError extends Error {
    /**
     * @param {string} message - Human-readable error message
     * @param {string[]} availableOptions - List of available (incompatible) images for user reference
     */
    constructor(message, availableOptions = []) {
        super(message);
        this.name = 'DlcResolutionError';
        this.availableOptions = availableOptions;
    }
}

/**
 * Load MCP server configuration from config/mcp.json.
 * @param {string} serverName - Server key in mcpServers
 * @returns {object} Server config { command, args, env }
 * @throws {Error} If server not found in config
 */
function _loadMcpServerConfig(serverName) {
    const configPath = resolve(PACKAGE_ROOT, 'config', 'mcp.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const serverConfig = config.mcpServers?.[serverName];
    if (!serverConfig) {
        throw new Error(`MCP server '${serverName}' not found in config/mcp.json`);
    }
    return serverConfig;
}

/**
 * Resolve a DLC image URI using driver-aware filtering.
 *
 * @param {object} params
 * @param {string} params.framework - ML framework (e.g., "transformers")
 * @param {string} params.model_server - Model server (e.g., "vllm", "sglang")
 * @param {string} params.instance_type - SageMaker instance type (e.g., "ml.g5.xlarge")
 * @param {string} params.region - AWS region (e.g., "us-west-2")
 * @param {string} [params.accelerator] - Accelerator type (e.g., "gpu")
 * @param {string} [params.model_architecture] - Model architecture class for version filtering
 * @returns {Promise<string>} Full ECR URI for the resolved DLC image
 * @throws {DlcResolutionError} If no compatible image found
 */
export async function resolveDlcImage({ framework, model_server, instance_type, region: _region, accelerator: _accelerator, model_architecture }) {
    // Step 1: Resolve fleet driver from instance type
    const { driver, source: driverSource } = resolveFleetDriver({ instanceType: instance_type });

    if (!driver) {
        const family = parseInstanceFamily(instance_type);
        throw new DlcResolutionError(
            `Cannot determine GPU driver for instance type: ${instance_type} ` +
            `(family: ${family || 'unknown'}). Instance family not found in fleet-drivers.json. ` +
            'Non-GPU instances (CPU, Trainium, Inferentia) are not supported for DLC-direct mode.',
            []
        );
    }

    // Step 2: Query base-image-picker MCP for available DLC images
    let images = [];
    try {
        const serverConfig = _loadMcpServerConfig('base-image-picker');
        const mcp = new McpClient(serverConfig, {
            timeout: 10000,
            parameterMatrix: {
                base_image: { valueSpace: 'unbounded', mcp: true }
            }
        });

        const result = await mcp.query();
        await mcp.close();

        if (result) {
            // The MCP server returns images in metadata.images or values.base_image
            images = result.metadata?.images
                || result.choices?.base_image?.map(uri => ({ uri, tag: uri.split(':').pop() }))
                || [];
        }
    } catch (err) {
        throw new DlcResolutionError(
            `Failed to query base-image-picker MCP server: ${err.message}. ` +
            'Ensure the server is available and config/mcp.json is correct.',
            []
        );
    }

    if (images.length === 0) {
        throw new DlcResolutionError(
            'base-image-picker MCP returned no images for: ' +
            `framework=${framework}, server=${model_server}. ` +
            'The image catalog may be empty or the server failed to respond.',
            []
        );
    }

    // Step 3: Apply filterImages() for CUDA driver compatibility + model arch
    const { images: compatible } = filterImages(images, {
        instanceType: instance_type,
        framework: model_server,  // filterImages uses framework for version checks
        tensorParallelSize: 1,    // Single-GPU assumption for DLC-direct
        modelArchitecture: model_architecture || ''
    });

    if (compatible.length === 0) {
        const allUris = images
            .map(img => img.uri || img.tag || 'unknown')
            .slice(0, 10);

        throw new DlcResolutionError(
            'No CUDA-driver-compatible DLC image for: ' +
            `instance=${instance_type} (driver ${driver}, source: ${driverSource}), ` +
            `server=${model_server}. ` +
            `The fleet driver (${driver}) is lower than what the available images require. ` +
            'Consider using a newer instance family or custom-container mode.',
            allUris
        );
    }

    // Return the best match (first compatible image)
    const selected = compatible[0];
    const uri = selected.uri || selected.image_uri;

    if (!uri) {
        throw new DlcResolutionError(
            'Resolved a compatible image but it has no URI field. ' +
            `Image entry: ${JSON.stringify(selected).slice(0, 200)}`,
            []
        );
    }

    return uri;
}

/**
 * Check if an image URI belongs to a known DLC account.
 * Used by do/deploy scripts to skip ECR auth for DLC images.
 *
 * @param {string} imageUri - Full ECR image URI
 * @returns {boolean} True if the image is from a known DLC account
 */
export function isDlcImage(imageUri) {
    if (!imageUri) return false;
    return DLC_ACCOUNT_IDS.some(accountId => imageUri.includes(`${accountId}.dkr.ecr.`));
}
