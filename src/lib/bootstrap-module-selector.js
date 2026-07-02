// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Module Selector
 *
 * Presents an interactive multi-select for bootstrap modules,
 * validates dependency constraints, and provides topological ordering.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, '../../infra/bootstrap-modules/module-manifest.json');

/**
 * Load the module manifest.
 * @returns {object} Parsed module manifest
 */
export function loadModuleManifest() {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/**
 * Present an interactive module selector.
 * Core is always selected and not deselectable.
 *
 * @param {string[]} alreadyProvisioned - Module names already provisioned
 * @param {function} promptFn - Prompt function (same interface as runPrompts)
 * @returns {Promise<string[]>} Selected module names
 */
export async function selectModules(alreadyProvisioned = [], promptFn) {
    const manifest = loadModuleManifest();
    const modules = manifest.modules;

    // Build choices for the multi-select
    const choices = Object.entries(modules).map(([name, config]) => {
        const isCore = config.required;
        const isProvisioned = alreadyProvisioned.includes(name);
        const costLabel = config.estimatedMonthlyCost ? ` (~${config.estimatedMonthlyCost}/mo)` : '';
        const statusLabel = isProvisioned ? ' [provisioned]' : '';

        return {
            name: `${config.displayName} — ${config.description}${costLabel}${statusLabel}`,
            value: name,
            checked: isCore || isProvisioned,
            disabled: isCore ? '(required)' : false
        };
    });

    const answers = await promptFn([{
        type: 'checkbox',
        name: 'selectedModules',
        message: 'Select infrastructure modules to provision:',
        choices
    }]);

    // Core is always included even if somehow not returned
    const selected = answers.selectedModules || [];
    if (!selected.includes('core')) {
        selected.unshift('core');
    }

    return selected;
}

/**
 * Validate that all dependencies are satisfied for the selected modules.
 *
 * @param {string[]} selected - Module names selected for provisioning
 * @returns {{ valid: boolean, missing: Array<{module: string, missingDeps: string[]}> }}
 */
export function validateDependencies(selected) {
    const manifest = loadModuleManifest();
    const modules = manifest.modules;
    const selectedSet = new Set(selected);
    const missing = [];

    for (const name of selected) {
        const config = modules[name];
        if (!config) continue;

        const missingDeps = (config.depends || []).filter(dep => !selectedSet.has(dep));
        if (missingDeps.length > 0) {
            missing.push({ module: name, missingDeps });
        }
    }

    return { valid: missing.length === 0, missing };
}

/**
 * Find modules that depend on the given module.
 * Used to warn before removal.
 *
 * @param {string} moduleName - Module to check dependents for
 * @param {string[]} provisioned - Currently provisioned modules
 * @returns {string[]} Names of provisioned modules that depend on moduleName
 */
export function findDependents(moduleName, provisioned) {
    const manifest = loadModuleManifest();
    const modules = manifest.modules;

    return provisioned.filter(name => {
        const config = modules[name];
        return config && (config.depends || []).includes(moduleName);
    });
}

/**
 * Topologically sort modules for provisioning order (Kahn's algorithm).
 * Ensures dependencies are provisioned before dependents.
 *
 * @param {string[]} selected - Module names to sort
 * @returns {string[]} Sorted module names (dependencies first)
 * @throws {Error} If circular dependency detected
 */
export function topologicalSort(selected) {
    const manifest = loadModuleManifest();
    const modules = manifest.modules;
    const selectedSet = new Set(selected);

    // Build in-degree map and adjacency list (only for selected modules)
    const inDegree = new Map();
    const adjacency = new Map();

    for (const name of selected) {
        inDegree.set(name, 0);
        adjacency.set(name, []);
    }

    for (const name of selected) {
        const config = modules[name];
        if (!config) continue;

        for (const dep of (config.depends || [])) {
            if (selectedSet.has(dep)) {
                // dep → name (dep must come before name)
                adjacency.get(dep).push(name);
                inDegree.set(name, (inDegree.get(name) || 0) + 1);
            }
        }
    }

    // Kahn's algorithm
    const queue = [];
    for (const [name, degree] of inDegree) {
        if (degree === 0) queue.push(name);
    }

    const sorted = [];
    while (queue.length > 0) {
        const node = queue.shift();
        sorted.push(node);

        for (const neighbor of (adjacency.get(node) || [])) {
            const newDegree = inDegree.get(neighbor) - 1;
            inDegree.set(neighbor, newDegree);
            if (newDegree === 0) {
                queue.push(neighbor);
            }
        }
    }

    if (sorted.length !== selected.length) {
        const remaining = selected.filter(n => !sorted.includes(n));
        throw new Error(`Circular dependency detected among modules: ${remaining.join(', ')}`);
    }

    return sorted;
}
