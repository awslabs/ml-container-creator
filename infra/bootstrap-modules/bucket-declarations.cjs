// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Bucket declarations reader (plain CommonJS — consumed by module-runner.cjs and the
 * Node tests without a build step).
 *
 * Each owning stack declares its buckets ONCE in a `buckets.json` next to its
 * stack source (ADR-008 derive-dont-hardcode; bucket consolidation R1.2):
 *
 *   { "stack": "<stackNameSuffix>",
 *     "buckets": { "<construct id>": { "name": "mlcc-x-{account}-{region}",
 *                                       "adoptContext": "...", "output": "...",
 *                                       "profileKey": "...", "envVar": "..." } } }
 *
 * The files are DISCOVERED by walking the bootstrap-modules tree — there is no
 * hand-maintained list of stacks. bucket-declarations.ts is the TypeScript twin used
 * by the CDK stacks; test/unit/no-literal-bucket-names.test.js asserts both render
 * identical names.
 */
const fs = require('fs');
const path = require('path');

const MODULES_ROOT = path.resolve(__dirname);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', '.hyperpod-helm-cache']);

let _cache = null;

function _walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
            _walk(path.join(dir, entry.name), out);
        } else if (entry.name === 'buckets.json') {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

/**
 * Load every buckets.json under the bootstrap-modules tree.
 * @returns {Record<string, {stack: string, file: string, buckets: Record<string, object>}>}
 *   stackNameSuffix -> declaration
 */
function loadBucketDeclarations() {
    if (_cache) return _cache;
    const byStack = {};
    for (const file of _walk(MODULES_ROOT, []).sort()) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed.stack || !parsed.buckets || typeof parsed.buckets !== 'object') {
            throw new Error(`Malformed bucket declaration ${file}: needs "stack" and "buckets"`);
        }
        if (byStack[parsed.stack]) {
            throw new Error(`Stack '${parsed.stack}' declares buckets twice (${byStack[parsed.stack].file}, ${file})`);
        }
        byStack[parsed.stack] = { stack: parsed.stack, file, buckets: parsed.buckets };
    }
    _cache = byStack;
    return byStack;
}

/**
 * Render a declared name template. split/join so no replacement-pattern surprises.
 * @param {string} template
 * @param {{account?: string, region?: string, profileName?: string}} vars
 * @returns {string}
 */
function renderBucketName(template, vars) {
    return String(template)
        .split('{account}').join(vars.account || '')
        .split('{region}').join(vars.region || '')
        .split('{profile}').join(vars.profileName || '');
}

/**
 * The declared buckets of one stack, with rendered physical names.
 * @param {string} stackNameSuffix
 * @param {{account: string, region: string, profileName?: string}} vars
 * @returns {Array<object>} [{ logicalId, name, adoptContext, output, profileKey, envVar, legacy }]
 */
function declaredBucketsForStack(stackNameSuffix, vars) {
    const decl = loadBucketDeclarations()[stackNameSuffix];
    if (!decl) return [];
    return Object.entries(decl.buckets).map(([logicalId, b]) => ({
        ...b,
        logicalId,
        template: b.name,
        name: renderBucketName(b.name, vars)
    }));
}

/**
 * Every declared bucket across all stacks (templates, not rendered).
 * @returns {Array<object>} [{ stack, logicalId, template, ...declaration }]
 */
function allBucketDeclarations() {
    const out = [];
    for (const decl of Object.values(loadBucketDeclarations())) {
        for (const [logicalId, b] of Object.entries(decl.buckets)) {
            out.push({ ...b, stack: decl.stack, logicalId, template: b.name, file: decl.file });
        }
    }
    return out;
}

module.exports = {
    loadBucketDeclarations,
    renderBucketName,
    declaredBucketsForStack,
    allBucketDeclarations
};
