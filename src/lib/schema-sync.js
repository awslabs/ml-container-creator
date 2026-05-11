// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema Sync — Downloads AWS service model files from the AWS SDK GitHub source
 * and stores them in the local schema registry.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 10.1
 */

import https from 'node:https';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SERVICES = ['sagemaker', 'iam', 'ecr', 's3'];

const SOURCE_BASE_URL = 'https://raw.githubusercontent.com/aws/aws-sdk-js-v3/main/codegen/sdk-codegen/aws-models';

/**
 * Get the default schema registry path.
 * @returns {string}
 */
export function getRegistryPath() {
    return path.join(os.homedir(), '.ml-container-creator', 'schemas');
}

/**
 * Download a file from a URL using the built-in https module.
 * @param {string} url - URL to download
 * @returns {Promise<string>} - Response body as string
 */
function downloadFile(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadFile(res.headers.location).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Count shapes and enums in a service model.
 * @param {object} model - Parsed service model JSON
 * @returns {{ shapeCount: number, enumCount: number, version: string }}
 */
function getModelStats(model) {
    const shapes = model.shapes || {};
    let shapeCount = 0;
    let enumCount = 0;

    for (const shape of Object.values(shapes)) {
        shapeCount++;
        if (shape.type === 'string' && shape.enum) {
            enumCount++;
        }
        // Smithy models use traits for enums
        if (shape.traits && shape.traits['smithy.api#enum']) {
            enumCount++;
        }
        // Smithy v2 enum shapes
        if (shape.type === 'enum') {
            enumCount++;
        }
    }

    const version = model.metadata?.apiVersion || '';

    return { shapeCount, enumCount, version };
}

/**
 * Sync all service models from the AWS SDK GitHub source.
 * @param {object} [options]
 * @param {string} [options.registryPath] - Override registry path
 * @param {function} [options.downloadFn] - Override download function (for testing)
 * @returns {Promise<{ success: boolean, services: object }>}
 */
export async function syncSchemas(options = {}) {
    const registryPath = options.registryPath || getRegistryPath();
    const download = options.downloadFn || downloadFile;

    // Ensure registry directory exists
    mkdirSync(registryPath, { recursive: true });

    const serviceStats = {};
    let hasErrors = false;

    for (const service of SERVICES) {
        const url = `${SOURCE_BASE_URL}/${service}.json`;
        const serviceDir = path.join(registryPath, service);

        try {
            console.log(`  Syncing ${service}...`);
            const content = await download(url);

            // Parse to extract stats
            let model;
            try {
                model = JSON.parse(content);
            } catch (parseErr) {
                console.log(`  ⚠️  ${service}: Failed to parse model — ${parseErr.message}`);
                hasErrors = true;
                continue;
            }

            const stats = getModelStats(model);

            // Store the file
            mkdirSync(serviceDir, { recursive: true });
            writeFileSync(path.join(serviceDir, 'service-2.json'), content, 'utf8');

            serviceStats[service] = {
                shapeCount: stats.shapeCount,
                enumCount: stats.enumCount,
                version: stats.version
            };

            console.log(`  ✅ ${service}: ${stats.shapeCount} shapes, ${stats.enumCount} enums`);
        } catch (err) {
            console.log(`  ⚠️  ${service}: ${err.message}`);
            hasErrors = true;
        }
    }

    // Write manifest
    const manifest = {
        lastSynced: new Date().toISOString(),
        services: serviceStats,
        source: 'https://github.com/aws/aws-sdk-js-v3/tree/main/codegen/sdk-codegen/aws-models'
    };

    writeFileSync(
        path.join(registryPath, 'manifest.json'),
        JSON.stringify(manifest, null, 4),
        'utf8'
    );

    return { success: !hasErrors, services: serviceStats, manifest };
}

/**
 * Load the manifest from the schema registry.
 * @param {string} [registryPath] - Override registry path
 * @returns {object|null} Parsed manifest or null if not found
 */
export function loadManifest(registryPath) {
    const regPath = registryPath || getRegistryPath();
    const manifestPath = path.join(regPath, 'manifest.json');

    if (!existsSync(manifestPath)) {
        return null;
    }

    try {
        return JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Load a service model from the registry.
 * @param {string} serviceName - Service name (e.g., 'sagemaker')
 * @param {string} [registryPath] - Override registry path
 * @returns {string|null} Raw file content or null if not found
 */
export function loadServiceModel(serviceName, registryPath) {
    const regPath = registryPath || getRegistryPath();
    const modelPath = path.join(regPath, serviceName, 'service-2.json');

    if (!existsSync(modelPath)) {
        return null;
    }

    return readFileSync(modelPath, 'utf8');
}

/**
 * Store a service model in the registry.
 * @param {string} serviceName - Service name (e.g., 'sagemaker')
 * @param {string} content - Raw file content to store
 * @param {string} [registryPath] - Override registry path
 */
export function storeServiceModel(serviceName, content, registryPath) {
    const regPath = registryPath || getRegistryPath();
    const serviceDir = path.join(regPath, serviceName);

    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(path.join(serviceDir, 'service-2.json'), content, 'utf8');
}
