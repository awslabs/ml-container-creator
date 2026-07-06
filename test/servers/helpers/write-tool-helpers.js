// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test helpers that replicate the write_local_* tool logic for unit testing.
 *
 * These functions implement the same logic as the MCP server tool handlers,
 * allowing us to test the core write functionality in isolation.
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectDir } from '../../../servers/lib/override-loader.js';

/**
 * write_local_model implementation (mirrors model-picker/index.js handler)
 */
export async function writeLocalModel(params) {
    const { name, parameters, architecture, contextLength, quantizationOptions, context } = params;

    if (!name || !name.trim()) {
        return { status: 'error', message: 'name is required and must be non-empty' };
    }
    if (!parameters || !parameters.trim()) {
        return { status: 'error', message: 'parameters is required and must be non-empty' };
    }

    const projectDir = resolveProjectDir(context);
    const mlccDir = join(projectDir, '.mlcc');
    const overridePath = join(mlccDir, 'model-picker.json');
    const tmpPath = `${overridePath  }.tmp`;

    mkdirSync(mlccDir, { recursive: true });

    let data = { models: [] };
    if (existsSync(overridePath)) {
        try {
            data = JSON.parse(readFileSync(overridePath, 'utf8'));
        } catch {
            data = { models: [] };
        }
    }
    if (!Array.isArray(data.models)) {
        data.models = [];
    }

    const entry = { name, parameters, source: 'local', addedAt: new Date().toISOString() };
    if (architecture) entry.architecture = architecture;
    if (contextLength) entry.contextLength = contextLength;
    if (quantizationOptions) entry.quantizationOptions = quantizationOptions;

    const idx = data.models.findIndex(m => m.name === name);
    if (idx >= 0) {
        data.models[idx] = entry;
    } else {
        data.models.push(entry);
    }

    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmpPath, overridePath);

    const result = { status: 'ok', entry, file: '.mlcc/model-picker.json' };
    const stat = statSync(overridePath);
    if (stat.size > 100 * 1024) {
        result.warning = 'Override file exceeds 100KB — consider upstreaming entries';
    }

    return result;
}

/**
 * write_local_instance implementation (mirrors instance-sizer/index.js handler)
 */
export async function writeLocalInstance(params) {
    const { instanceType, gpuCount, gpuType, gpuMemoryGb, vCpus, memoryGb, context } = params;

    if (!instanceType || !instanceType.trim()) {
        return { status: 'error', message: 'instanceType is required and must be non-empty' };
    }
    if (!gpuType || !gpuType.trim()) {
        return { status: 'error', message: 'gpuType is required and must be non-empty' };
    }
    if (!gpuCount || gpuCount <= 0) {
        return { status: 'error', message: 'gpuCount must be a positive integer' };
    }
    if (!gpuMemoryGb || gpuMemoryGb <= 0) {
        return { status: 'error', message: 'gpuMemoryGb must be a positive number' };
    }
    if (!vCpus || vCpus <= 0) {
        return { status: 'error', message: 'vCpus must be a positive integer' };
    }
    if (!memoryGb || memoryGb <= 0) {
        return { status: 'error', message: 'memoryGb must be a positive number' };
    }

    const projectDir = resolveProjectDir(context);
    const mlccDir = join(projectDir, '.mlcc');
    const overridePath = join(mlccDir, 'instance-sizer.json');
    const tmpPath = `${overridePath  }.tmp`;

    mkdirSync(mlccDir, { recursive: true });

    let data = { instances: [] };
    if (existsSync(overridePath)) {
        try {
            data = JSON.parse(readFileSync(overridePath, 'utf8'));
        } catch {
            data = { instances: [] };
        }
    }
    if (!Array.isArray(data.instances)) {
        data.instances = [];
    }

    const entry = {
        instanceType,
        gpuCount,
        gpuType,
        gpuMemoryGb,
        vCpus,
        memoryGb,
        source: 'local',
        addedAt: new Date().toISOString()
    };

    const idx = data.instances.findIndex(i => i.instanceType === instanceType);
    if (idx >= 0) {
        data.instances[idx] = entry;
    } else {
        data.instances.push(entry);
    }

    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmpPath, overridePath);

    const result = { status: 'ok', entry, file: '.mlcc/instance-sizer.json' };
    const stat = statSync(overridePath);
    if (stat.size > 100 * 1024) {
        result.warning = 'Override file exceeds 100KB — consider upstreaming entries';
    }

    return result;
}

/**
 * write_local_capability implementation (mirrors agent-knowledge/index.js handler)
 */
export async function writeLocalCapability(params) {
    const { capability, status, message, alternatives, context } = params;

    if (!capability || !capability.trim()) {
        return { status: 'error', message: 'capability is required and must be non-empty' };
    }
    if (!status) {
        return { status: 'error', message: 'status is required (green, yellow, or red)' };
    }

    const projectDir = resolveProjectDir(context);
    const mlccDir = join(projectDir, '.mlcc');
    const overridePath = join(mlccDir, 'capabilities.json');
    const tmpPath = `${overridePath  }.tmp`;

    mkdirSync(mlccDir, { recursive: true });

    let data = { capabilities: {} };
    if (existsSync(overridePath)) {
        try {
            data = JSON.parse(readFileSync(overridePath, 'utf8'));
        } catch {
            data = { capabilities: {} };
        }
    }
    if (!data.capabilities || typeof data.capabilities !== 'object' || Array.isArray(data.capabilities)) {
        data.capabilities = {};
    }

    const entry = { status, source: 'local', addedAt: new Date().toISOString() };
    if (message) entry.message = message;
    if (alternatives) entry.alternatives = alternatives;

    data.capabilities[capability] = entry;

    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmpPath, overridePath);

    const result = { status: 'ok', entry: { capability, ...entry }, file: '.mlcc/capabilities.json' };
    const stat = statSync(overridePath);
    if (stat.size > 100 * 1024) {
        result.warning = 'Override file exceeds 100KB — consider upstreaming entries';
    }

    return result;
}

/**
 * write_local_image implementation (mirrors base-image-picker/index.js handler)
 */
export async function writeLocalImage(params) {
    const { name, image, framework, pythonVersion, cudaVersion, context } = params;

    if (!name || !name.trim()) {
        return { status: 'error', message: 'name is required and must be non-empty' };
    }
    if (!image || !image.trim()) {
        return { status: 'error', message: 'image is required and must be non-empty' };
    }

    const projectDir = resolveProjectDir(context);
    const mlccDir = join(projectDir, '.mlcc');
    const overridePath = join(mlccDir, 'base-image-picker.json');
    const tmpPath = `${overridePath  }.tmp`;

    mkdirSync(mlccDir, { recursive: true });

    let data = { images: [] };
    if (existsSync(overridePath)) {
        try {
            data = JSON.parse(readFileSync(overridePath, 'utf8'));
        } catch {
            data = { images: [] };
        }
    }
    if (!Array.isArray(data.images)) {
        data.images = [];
    }

    const entry = { name, image, source: 'local', addedAt: new Date().toISOString() };
    if (framework) entry.framework = framework;
    if (pythonVersion) entry.pythonVersion = pythonVersion;
    if (cudaVersion) entry.cudaVersion = cudaVersion;

    const idx = data.images.findIndex(i => i.name === name);
    if (idx >= 0) {
        data.images[idx] = entry;
    } else {
        data.images.push(entry);
    }

    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmpPath, overridePath);

    const result = { status: 'ok', entry, file: '.mlcc/base-image-picker.json' };
    const stat = statSync(overridePath);
    if (stat.size > 100 * 1024) {
        result.warning = 'Override file exceeds 100KB — consider upstreaming entries';
    }

    return result;
}
