// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Driver-Aware Image Filtering Module.
 *
 * Filters container images by three dimensions:
 *   A) GPU driver compatibility (fleet driver vs image min_driver_version)
 *   B) Tensor parallel eligibility (TP > 1 cannot use CUDA compat layer)
 *   C) Model architecture support (framework version must support the model)
 *
 * Exports:
 *   - filterImages(images, options) → { images, metadata }
 *   - parseInstanceFamily(instanceType) → string
 *   - compareVersions(a, b) → number (-1, 0, 1)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Load catalogs ────────────────────────────────────────────────────────────

let fleetDrivers = null;
let modelArchSupport = null;

function loadFleetDrivers() {
    if (!fleetDrivers) {
        const path = resolve(__dirname, 'catalogs/fleet-drivers.json');
        fleetDrivers = JSON.parse(readFileSync(path, 'utf8'));
    }
    return fleetDrivers;
}

function loadModelArchSupport() {
    if (!modelArchSupport) {
        const path = resolve(__dirname, 'catalogs/model-arch-support.json');
        modelArchSupport = JSON.parse(readFileSync(path, 'utf8'));
    }
    return modelArchSupport;
}

// ── Utility functions ────────────────────────────────────────────────────────

/**
 * Parse instance family from SageMaker instance type.
 * E.g., "ml.g5.24xlarge" → "g5", "ml.p5e.48xlarge" → "p5e"
 */
export function parseInstanceFamily(instanceType) {
    if (!instanceType) return null;
    // Pattern: ml.<family>.<size>
    const match = instanceType.match(/^ml\.([a-z0-9]+)\./i);
    return match ? match[1] : null;
}

/**
 * Compare two semver-like version strings.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b.
 * Handles: "v0.23.0" vs "v0.20.0", "v0.5.14" vs "v0.4.5"
 */
export function compareVersions(a, b) {
    if (!a || !b) return 0;
    // Strip leading 'v'
    const va = a.replace(/^v/, '').split('.').map(Number);
    const vb = b.replace(/^v/, '').split('.').map(Number);

    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const na = va[i] || 0;
        const nb = vb[i] || 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }
    return 0;
}

/**
 * Resolve fleet driver version from instance type or overrides.
 *
 * Priority: driverVersion override > inferenceAmiVersion lookup > instance family lookup
 *
 * @param {object} options
 * @param {string} [options.instanceType] - SageMaker instance type (e.g., "ml.g5.24xlarge")
 * @param {string} [options.driverVersion] - Explicit driver version override
 * @param {string} [options.inferenceAmiVersion] - Inference AMI version (resolves to driver)
 * @returns {{ driver: string|null, source: string }}
 */
export function resolveFleetDriver(options = {}) {
    const { instanceType, driverVersion, inferenceAmiVersion } = options;
    const catalog = loadFleetDrivers();

    // Priority 1: explicit override
    if (driverVersion) {
        return { driver: driverVersion, source: 'override' };
    }

    // Priority 2: AMI version lookup
    if (inferenceAmiVersion) {
        const amiKey = inferenceAmiVersion.toLowerCase().replace(/_/g, '-');
        const amiEntry = catalog.ami_versions[amiKey];
        if (amiEntry) {
            return { driver: amiEntry.driver, source: 'ami_version' };
        }
    }

    // Priority 3: instance family lookup
    if (instanceType) {
        const family = parseInstanceFamily(instanceType);
        if (family) {
            const familyEntry = catalog.instance_families[family];
            if (familyEntry) {
                return { driver: familyEntry.driver, source: 'instance_family' };
            }
        }
    }

    return { driver: null, source: 'none' };
}

/**
 * Resolve minimum framework version required for a model architecture.
 *
 * @param {string} framework - Framework name (e.g., "vllm", "sglang")
 * @param {string} modelArchitecture - Architecture class (e.g., "Qwen3ForCausalLM")
 * @returns {string|null} Minimum version string, or null if unknown
 */
export function resolveMinFrameworkVersion(framework, modelArchitecture) {
    if (!framework || !modelArchitecture) return null;
    const catalog = loadModelArchSupport();
    const frameworkMap = catalog[framework];
    if (!frameworkMap) return null;
    return frameworkMap[modelArchitecture] || null;
}

// ── CUDA → Driver derivation ─────────────────────────────────────────────────

/**
 * CUDA Toolkit → Minimum Driver Version mapping (Linux).
 *
 * Used to derive `min_driver_version` for dynamic Docker Hub entries
 * that don't have it explicitly set in a static catalog.
 *
 * Source: NVIDIA CUDA Compatibility documentation.
 */
const CUDA_DRIVER_MAP = [
    { min: 12.9, driver: '580.0' },
    { min: 12.7, driver: '570.86' },
    { min: 12.5, driver: '555.42' },
    { min: 12.4, driver: '550.54' },
    { min: 12.2, driver: '535.54' },
    { min: 12.0, driver: '525.60' }
];

/**
 * Parse CUDA toolkit version from a Docker image tag string.
 *
 * Recognizes patterns:
 *   - "-cu124" suffix → CUDA 12.4
 *   - "-cu121" suffix → CUDA 12.1
 *   - "-cuda12.4" suffix → CUDA 12.4
 *   - "-cuda12.4.1" suffix → CUDA 12.4
 *
 * @param {string} tag - Docker image tag (e.g., "v0.6.6.post8-cu124")
 * @returns {number|null} Parsed CUDA version as float (e.g., 12.4) or null
 */
export function parseCudaVersionFromTag(tag) {
    if (!tag) return null;

    // Pattern: -cu<major><minor> (e.g., "-cu124" → 12.4, "-cu121" → 12.1)
    const cuMatch = tag.match(/-cu(\d{2})(\d+)/i);
    if (cuMatch) {
        const major = parseInt(cuMatch[1], 10);
        const minor = parseInt(cuMatch[2], 10);
        return major + minor / 10;
    }

    // Pattern: -cuda<major>.<minor> (e.g., "-cuda12.4" or "-cuda12.4.1")
    const cudaMatch = tag.match(/-cuda(\d+)\.(\d+)/i);
    if (cudaMatch) {
        return parseInt(cudaMatch[1], 10) + parseInt(cudaMatch[2], 10) / 10;
    }

    return null;
}

/**
 * Derive the minimum driver version from a CUDA toolkit version number.
 *
 * @param {number} cudaVersion - CUDA toolkit version as float (e.g., 12.4)
 * @returns {string|null} Minimum driver version string, or null if not mappable
 */
export function deriveDriverFromCuda(cudaVersion) {
    if (cudaVersion === null || cudaVersion === undefined || isNaN(cudaVersion)) return null;

    for (const entry of CUDA_DRIVER_MAP) {
        if (cudaVersion >= entry.min) {
            return entry.driver;
        }
    }

    // CUDA < 12.0 — not in our map, return null (conservative)
    return null;
}

/**
 * Derive `min_driver_version` for a dynamic image entry.
 *
 * Attempts to determine the CUDA toolkit version from:
 *   1. `labels.cuda_version` field (if present)
 *   2. Tag name patterns (-cu124, -cuda12.4)
 *
 * If CUDA version can be determined, maps it to the minimum driver version.
 * If not, returns null (entry will pass all driver filters — backward compat).
 *
 * @param {object} entry - Image entry with `tag` and optional `labels`
 * @returns {string|null} Derived min_driver_version, or null
 */
export function deriveMinDriverVersion(entry) {
    if (!entry) return null;

    // Priority 1: explicit cuda_version in labels
    if (entry.labels && entry.labels.cuda_version) {
        const cudaVer = parseFloat(entry.labels.cuda_version);
        if (!isNaN(cudaVer)) {
            return deriveDriverFromCuda(cudaVer);
        }
    }

    // Priority 2: parse from tag name
    const cudaFromTag = parseCudaVersionFromTag(entry.tag);
    if (cudaFromTag !== null) {
        return deriveDriverFromCuda(cudaFromTag);
    }

    // Fallback: cannot determine — leave unset (passes all filters)
    return null;
}

// ── Main filter function ─────────────────────────────────────────────────────

/**
 * Filter images by driver compatibility and model architecture support.
 *
 * @param {Array} images - Array of image catalog entries
 * @param {object} options
 * @param {string} [options.framework] - Framework name (vllm, sglang, etc.)
 * @param {string} [options.instanceType] - SageMaker instance type
 * @param {string} [options.driverVersion] - Explicit driver version override
 * @param {string} [options.inferenceAmiVersion] - Inference AMI version
 * @param {number} [options.tensorParallelSize] - TP degree (default: 1)
 * @param {string} [options.modelArchitecture] - Model architecture class name
 * @returns {{ images: Array, metadata: object }}
 */
export function filterImages(images, options = {}) {
    const {
        framework = '',
        tensorParallelSize = 1,
        modelArchitecture = ''
    } = options;

    // Resolve fleet driver
    const { driver: fleetDriver, source: driverSource } = resolveFleetDriver(options);

    // Resolve min framework version for model
    const minFrameworkVersion = resolveMinFrameworkVersion(framework, modelArchitecture);

    // If no filtering criteria, return all images unchanged
    if (!fleetDriver && !minFrameworkVersion) {
        return {
            images,
            metadata: {
                filtered: false,
                fleetDriver: null,
                driverSource: 'none',
                modelArchitecture: modelArchitecture || null,
                minFrameworkVersion: null,
                excludedCount: 0,
                exclusionReasons: {}
            }
        };
    }

    const exclusionReasons = { driver_compat: 0, model_support: 0 };
    const filtered = [];

    for (const img of images) {
        let excluded = false;
        let warning = null;

        // (A) + (B): Driver compatibility check
        if (fleetDriver && img.min_driver_version) {
            const fleetParts = fleetDriver.split('.').map(Number);
            const minParts = img.min_driver_version.split('.').map(Number);

            // Compare as version: major.minor (e.g., 550.163 vs 550.54)
            let fleetLessThanMin = false;
            for (let i = 0; i < Math.max(fleetParts.length, minParts.length); i++) {
                const fp = fleetParts[i] || 0;
                const mp = minParts[i] || 0;
                if (fp < mp) { fleetLessThanMin = true; break; }
                if (fp > mp) { break; }
            }

            if (fleetLessThanMin) {
                if (tensorParallelSize > 1) {
                    // Multi-GPU: hard reject (NCCL hangs with compat layer)
                    excluded = true;
                    exclusionReasons.driver_compat++;
                } else {
                    // Single-GPU: CUDA compat might work — warn but allow
                    warning = 'Requires CUDA forward compatibility layer — may fail on multi-GPU TP';
                }
            }
        }

        // (C): Model architecture support check
        if (!excluded && minFrameworkVersion && img.tag) {
            if (compareVersions(img.tag, minFrameworkVersion) < 0) {
                excluded = true;
                exclusionReasons.model_support++;
            }
        }

        if (!excluded) {
            if (warning) {
                // Clone to avoid mutating original catalog entry
                const annotated = { ...img, _warning: warning };
                filtered.push(annotated);
            } else {
                filtered.push(img);
            }
        }
    }

    return {
        images: filtered,
        metadata: {
            filtered: true,
            fleetDriver: fleetDriver || null,
            driverSource,
            instanceFamily: parseInstanceFamily(options.instanceType) || null,
            modelArchitecture: modelArchitecture || null,
            minFrameworkVersion: minFrameworkVersion || null,
            excludedCount: images.length - filtered.length,
            exclusionReasons
        }
    };
}
