// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// render-eks-manifests.js — BL111 deploy-time EJS renderer for the plain-EKS target.
//
// do/deploy.d/eks invokes this at DEPLOY time (not mcc generate time) to render
// the eks manifest EJS *source* (eks/*.yaml.ejs) against the CURRENT do/config
// values. This makes the .ejs template the render source of truth: instanceType,
// GPU count, model source, and serve config are resolved from the process
// environment (which the do/deploy dispatcher has already populated by sourcing
// do/config) at the moment of deploy, rather than being frozen at generate time.
//
// This is the "node + ejs" render path the BL111 spec describes. It is the
// PREFERRED path; do/deploy.d/eks falls back to a portable envsubst() shim (and
// emits a warning) when this renderer is unavailable — i.e. when `node` or the
// `ejs` module cannot be loaded. Requiring `ejs` at the top means a project
// without the module fails fast with a non-zero exit, which the deploy driver
// detects to take the documented fallback.
//
// Usage:
//   node do/lib/render-eks-manifests.cjs <template.yaml.ejs>
//     → prints the rendered manifest to stdout.
//   node do/lib/render-eks-manifests.cjs --probe
//     → exits 0 if the EJS renderer is usable (node + ejs present), non-zero otherwise.
//
// The rendered output still contains ${VAR} / ${VAR:-default} shell placeholders
// (image, GPU/CPU/memory sizing, model source, serve pass-throughs). The deploy
// driver resolves those against the environment after this render, so BOTH the
// EJS path and the envsubst fallback converge on the same placeholder resolution.

'use strict';

const fs = require('fs');

// Fail fast (non-zero exit) when the ejs module is not installed in the project.
// do/deploy.d/eks treats this failure as "EJS renderer unavailable" and falls
// back to envsubst with a warning.
let ejs;
try {
    ejs = require('ejs');
} catch (err) {
    process.stderr.write('render-eks-manifests: ejs module not available\n');
    process.exit(2);
}

// --probe: capability check only. Reaching here means node ran and `ejs` loaded.
if (process.argv.includes('--probe')) {
    process.exit(0);
}

const templatePath = process.argv[2];
if (!templatePath) {
    process.stderr.write('render-eks-manifests: missing template path argument\n');
    process.exit(3);
}
if (!fs.existsSync(templatePath)) {
    process.stderr.write(`render-eks-manifests: template not found: ${templatePath}\n`);
    process.exit(3);
}

const env = process.env;

// Positive-integer coercion for GPU count with a safe default of 1. Non-integer
// or non-positive values fall back to 1, matching the deploy driver's auto-detect
// and the template's ${VAR:-1} shell defaults.
function positiveIntOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? String(n) : String(fallback);
}

// Map do/config environment variables → the EJS variable names the eks
// templates (Deployment/Service/ConfigMap.yaml.ejs) reference. These EJS
// expressions were previously resolved at generate time; BL111 resolves them at
// deploy time from the current environment so a reconfigure/edit is reflected.
const HP_GPU_COUNT = positiveIntOr(env.HP_GPU_COUNT, 1);

// ADR-010: Tier-1 engine config is DERIVED, not hardcoded. do/deploy.d/eks
// resolves the active engine's capability_map (serve_manifest.py
// resolve_capability_vars) into an ordered list of {key,value} env pairs and
// hands it here as JSON in EKS_TIER1_ENV_JSON. The ConfigMap template loops this
// list, so it carries ONLY the active engine's keys (no stray VLLM_*/SGLANG_*
// cross-leak) and already honors value-shape + companion rules. A missing/empty
// value means the resolver was unavailable; the template falls back to its own
// ${VAR:-default} shapes, so parse defensively.
function parseTier1(raw) {
    if (!raw) {
        return [];
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        process.stderr.write(`render-eks-manifests: ignoring unparseable EKS_TIER1_ENV_JSON: ${err.message}\n`);
        return [];
    }
    const resolved = data && Array.isArray(data.resolved) ? data.resolved : [];
    return resolved
        .filter((e) => e && typeof e.key === 'string' && e.key)
        .map((e) => ({ key: e.key, value: e.value == null ? '' : String(e.value) }));
}

const templateVars = {
    projectName: env.PROJECT_NAME || '',
    framework: env.FRAMEWORK || '',
    hyperPodNamespace: env.HP_NAMESPACE || 'default',
    hyperPodReplicas: positiveIntOr(env.HP_REPLICAS, 1),
    modelName: env.MODEL_NAME || '',
    // Active serving engine (ADR-004 single-source selection); defaults to vllm.
    modelServer: env.MODEL_SERVER || 'vllm',
    // When set, the model volume is a hostPath at this node-local NVMe base
    // (e.g. /opt/dlami/nvme) instead of an emptyDir on the node's ephemeral-storage
    // root — for large models on nodes whose instance-store isn't the kubelet root.
    // The deploy driver sets HP_MODEL_HOSTPATH; the template appends the project.
    modelHostPath: env.HP_MODEL_HOSTPATH || '',
    // Manifest-derived Tier-1 env pairs for the active engine (ADR-010). Empty
    // list when the resolver was unavailable → template uses its own fallbacks.
    tier1Env: parseTier1(env.EKS_TIER1_ENV_JSON),
    // Tier-2 unbounded prefix pass-through (ADR-010): any <PREFIX>* var the user
    // set that is not a Tier-1 key, forwarded verbatim. Same {resolved:[...]}
    // shape, parsed with the same defensive reader.
    tier2Env: parseTier1(env.EKS_TIER2_ENV_JSON),
    // The templates read HP_GPU_COUNT via `typeof HP_GPU_COUNT !== 'undefined'`
    // for the ${VAR:-default} shell fallbacks; supply it as a string.
    HP_GPU_COUNT,
    // BL115: LoRA-on switch retained for the fallback render path. Normalized to
    // a string so the template's strict `=== 'true'` comparison works.
    HP_LORA_ENABLED: env.HP_LORA_ENABLED || ''
};

const source = fs.readFileSync(templatePath, 'utf8');
let rendered;
try {
    rendered = ejs.render(source, templateVars, { filename: templatePath });
} catch (err) {
    const line = err && err.line ? ` (line ${err.line})` : '';
    process.stderr.write(`render-eks-manifests: EJS render failed for ${templatePath}${line}: ${err.message}\n`);
    process.exit(4);
}

process.stdout.write(rendered);
