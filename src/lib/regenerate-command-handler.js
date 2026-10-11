// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerate Command Handler
 *
 * Re-runs project generation from saved parameters using the current
 * generator version. Merges saved params with live overrides from
 * do/config and do/ic/*.conf.
 *
 * Requirements: US-3 (all ACs)
 */

import { writeProject } from '../app.js';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseDoConfig, shellVarsToAnswers } from './do-config.js';
import { runtimeOwnedVarsUnion } from './target-manifest-reader.js';
import { serveEngineRuntimeVarsUnion } from './serve-manifest-reader.js';
import BaseCommandHandler, { GENERATOR_ROOT, TEMPLATE_DIR } from './base-command-handler.js';

/**
 * Vars written at runtime (by do/deploy, do/draft, do/benchmark, do/optimize --apply, etc.)
 * that must survive mcc regenerate. Template-owned vars are NOT in this list — they get
 * their values from the EJS render and should be overwritten by regenerate.
 *
 * The PER-TARGET runtime-owned vars (each target's status var + its target-family
 * runtime vars) are DERIVED from the target descriptors below (ADR-008), so adding
 * a deployment target needs no edit here. What remains hand-listed is the
 * cross-cutting set written by verb scripts (benchmark / optimize / draft) plus the
 * shared MLflow / endpoint vars — these are not per-target.
 *
 * The SERVE-ENGINE benchmark-tunable slice (VLLM_/SGLANG_ … from each engine's
 * env_var_prefix + dimension_map) is now DERIVED via serveEngineRuntimeVarsUnion()
 * below (ADR-008 / BL105 resolved), so it covers every engine, not just vLLM.
 *
 * Add a new SHARED entry only when a cross-cutting do/ verb writes a new persistent
 * var to do/config that is neither per-target nor a serve-engine dimension — e.g.
 * the HP_SPECULATIVE_ draft settings (HyperPod/kubernetes, written by do/draft) and
 * the BENCHMARK_ / OPTIMIZE_ / MLFLOW_ job and tracking vars listed below.
 */
// Runtime-owned vars that are NOT tied to a single deployment target — written
// by cross-cutting verbs (benchmark, optimize, draft) or set by hand, and shared
// across targets. The per-target runtime-owned vars (each target's status var +
// its target-family runtime vars like the HP_* / KUBECONFIG set) are DERIVED from
// the target descriptors via runtimeOwnedVarsUnion(), so adding a deployment
// target does not require editing this list. See ADR-008.
const SHARED_RUNTIME_VARS = [
    // NOTE: the benchmark-tunable engine vars (e.g. VLLM_TENSOR_PARALLEL_SIZE,
    // VLLM_QUANTIZATION, VLLM_MAX_MODEL_LEN, VLLM_KV_CACHE_DTYPE) are NO LONGER
    // hardcoded here — they are DERIVED from every serve engine's manifest via
    // serveEngineRuntimeVarsUnion() below (ADR-008 / BL105), which also covers
    // non-vLLM engines like SGLANG_* that this list previously missed.
    // Manual runtime opt-ins for architectures needing custom-code trust (e.g. Kimi-K3's
    // MoonViT tokenizer) — set by hand in do/config, consumed by both the CRD's serving
    // container env AND do/benchmark's tokenizer_trust_remote_code param (BL127-adjacent).
    'VLLM_TRUST_REMOTE_CODE',
    // Manual runtime opt-out for architectures that don't support LoRA (BL127).
    'HP_LORA_ENABLED',
    // Written by do/stage: the S3 URI of the staged model weights. MODEL_NAME is
    // preserved as the HF id and re-derived from saved answers on regenerate, but
    // STAGED_MODEL_PATH is a RUNTIME pointer with no answer to restore it from —
    // so without preserving it here, `mcc regenerate` would silently drop the S3
    // staging and every subsequent deploy would fall back to pulling from
    // HuggingFace. Cross-cutting (used by eks + hyperpod-eks model-source
    // resolution), not per-target and not a serve-engine dimension.
    'STAGED_MODEL_PATH',
    // Written by do/draft set
    'HP_SPECULATIVE_ALGORITHM',
    'HP_SPECULATIVE_MODEL',
    'HP_SPECULATIVE_NUM_TOKENS',
    'HP_SPECULATIVE_DRAFT_TP',
    'HP_SPECULATIVE_EAGLE_TOPK',
    'HP_SPECULATIVE_DRAFT_SAMPLE_METHOD',
    'HP_SPECULATIVE_REJECTION_SAMPLE_METHOD',
    'HP_SPECULATIVE_DISABLE_BY_BATCH_SIZE',
    'HP_SPECULATIVE_NUM_STEPS',
    // Written by do/benchmark --set-baseline
    'BENCHMARK_PINNED_BASELINE',
    // Written by do/optimize --apply
    'OPTIMIZE_MODEL_PACKAGE_ARN',
    'OPTIMIZE_INFERENCE_SPEC',
    'OPTIMIZE_INSTANCE_TYPE',
    // Written by do/benchmark (job tracking)
    'BENCHMARK_JOB_NAME',
    'BENCHMARK_WORKLOAD_CONFIG_NAME',
    'BENCHMARK_RUN_NAME',
    // MLflow tracking — preserved so _mlflow_configured() doesn't need a profile lookup
    'MLFLOW_TRACKING_SERVER_ARN',
    'MLFLOW_TRACKING_URI',
    // Endpoint name is written at runtime by realtime/async deploys; shared
    // because it is not a status var and both endpoint families reuse it.
    'ENDPOINT_NAME'
];

// Exported for the ADR-008 conformance test, which asserts the DERIVED set still
// contains every per-target runtime_owned_var from the descriptors.
export const RUNTIME_OWNED_VARS = new Set([
    ...SHARED_RUNTIME_VARS,
    // DERIVED: each target's status var + its target-family runtime vars.
    ...runtimeOwnedVarsUnion(),
    // DERIVED: each serve engine's benchmark-tunable vars (env_var_prefix +
    // dimension_map), across all engines (ADR-008 / BL105).
    ...serveEngineRuntimeVarsUnion()
]);

// parseDoConfig + shellVarsToAnswers now come from the shared ./do-config.js
// module (single source of truth). The canonical SHELL_VAR_TO_ANSWER mapping
// there is the superset that includes GENERATOR_VERSION and the per-target
// DEPLOYMENT_TARGET_*_STATUS vars this handler relies on (FR-9.3).

/**
 * Get the current installed generator version.
 * @returns {string} Version string
 */
function getInstalledVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(GENERATOR_ROOT, 'package.json'), 'utf8'));
        return pkg.version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}


/**
 * Capture the current values of runtime-owned vars from do/config.
 * Returns a map of varName → value for vars that have a non-empty value.
 */
function _captureRuntimeVars(configPath) {
    if (!existsSync(configPath)) return {};
    const captured = {};
    const content = readFileSync(configPath, 'utf8');
    for (const line of content.split('\n')) {
        const match = line.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=["']?([^"']*)["']?\s*$/);
        if (match && RUNTIME_OWNED_VARS.has(match[1]) && match[2].trim()) {
            captured[match[1]] = match[2].trim();
        }
    }
    return captured;
}

/**
 * Re-inject runtime vars into do/config after regeneration.
 * Overwrites any template-default values with the captured runtime values.
 */
function _injectRuntimeVars(configPath, runtimeVars) {
    if (!existsSync(configPath) || Object.keys(runtimeVars).length === 0) return;
    let content = readFileSync(configPath, 'utf8');
    for (const [key, value] of Object.entries(runtimeVars)) {
        const exportLine = `export ${key}="${value}"`;
        if (content.match(new RegExp(`^\\s*export\\s+${key}=`, 'm'))) {
            // Replace existing line
            content = content.replace(
                new RegExp(`^(\\s*export\\s+${key}=).*$`, 'm'),
                exportLine
            );
        } else {
            // Append at end
            content += `\n${exportLine}`;
        }
    }
    writeFileSync(configPath, content);
}

/**
 * Handler for `mcc regenerate`.
 * Re-runs generation from saved parameters using the current generator version.
 */
export default class RegenerateCommandHandler extends BaseCommandHandler {
    /**
     * @param {object} options
     * @param {boolean} [options.dryRun] - Show what would change without writing
     * @param {boolean} [options.force] - Regenerate even if version matches
     * @param {boolean} [options.noRegister] - Skip do/register after regeneration
     * @param {boolean} [options.allTargets] - Generate all deployment targets (BL062 migration)
     */
    constructor({ dryRun, force, noRegister, allTargets } = {}) {
        super();
        this.dryRun = dryRun || false;
        this.force = force || false;
        this.noRegister = noRegister || false;
        this.allTargets = allTargets || false;
    }

    /**
     * Execute the regenerate command in the current working directory.
     */
    async handle() {
        const cwd = process.cwd();
        const configPath = join(cwd, 'do', 'config');

        // Check this is a project directory
        if (!existsSync(configPath)) {
            console.error('❌ Not a project directory — do/config not found.');
            console.error('   Run this command from the root of an MCC-generated project.');
            process.exit(1);
        }

        // Guard: imported projects without generation params
        const importSourcePath = join(cwd, '.mlcc-import-source');
        const genParamsPath = join(cwd, '.mlcc-generation-params.json');

        if (existsSync(importSourcePath) && !existsSync(genParamsPath)) {
            console.error('❌ This is an imported project — regeneration requires original generation parameters.');
            console.error('   Use \'mcc update\' to change specific fields instead.');
            process.exit(1);
        }

        // Read project version
        const versionPath = join(cwd, '.mlcc-version');
        let projectVersion = '0.0.0';
        if (existsSync(versionPath)) {
            projectVersion = readFileSync(versionPath, 'utf8').trim();
        } else {
            // Fallback: try GENERATOR_VERSION from do/config
            const shellVars = parseDoConfig(configPath);
            projectVersion = shellVars.GENERATOR_VERSION || '0.0.0';
        }

        const installedVersion = getInstalledVersion();

        // Dev-checkout detection: when the generator runs from a git working tree
        // (not an installed semver release), the version string does NOT track
        // template CONTENT — edits to templates/ don't bump package.json. In that
        // mode a version-match short-circuit would silently skip real changes
        // (the "regenerate didn't surface my edits" trap), so we always regenerate.
        const isDevCheckout = existsSync(join(GENERATOR_ROOT, '.git'));

        // Check if regeneration is needed. The version guard is an optimization to
        // skip redundant work for an INSTALLED generator; it is bypassed by --force
        // and by a dev checkout (where version ≠ content).
        if (projectVersion === installedVersion && !this.force && !isDevCheckout) {
            console.log(`✅ Already up to date (v${installedVersion})`);
            console.log('   (Templates are regenerated only when the generator version differs.');
            console.log('    Run `mcc regenerate --force` to re-apply the current templates anyway.)');
            return;
        }
        if (isDevCheckout && projectVersion === installedVersion && !this.force) {
            console.log('ℹ️  Dev checkout detected (generator has a .git working tree) — regenerating');
            console.log(`   despite matching version v${installedVersion}, since templates may have`);
            console.log('   changed without a version bump.');
        }

        console.log('\n🔄 Regenerating project...');
        console.log(`   Project version: v${projectVersion}`);
        console.log(`   Generator version: v${installedVersion}`);

        // Load answers from .mlcc-generation-params.json (preferred) or do/config (fallback)
        let answers = {};
        if (existsSync(genParamsPath)) {
            try {
                const params = JSON.parse(readFileSync(genParamsPath, 'utf8'));
                answers = params.answers || {};
                console.log('   Source: .mlcc-generation-params.json');
            } catch {
                console.log('   ⚠️  Failed to parse .mlcc-generation-params.json, falling back to do/config');
                answers = shellVarsToAnswers(parseDoConfig(configPath));
            }
        } else {
            answers = shellVarsToAnswers(parseDoConfig(configPath));
            console.log('   Source: do/config (no generation params file)');
        }

        // Merge live overrides from do/config (live values win)
        const liveShellVars = parseDoConfig(configPath);
        const liveAnswers = shellVarsToAnswers(liveShellVars);
        for (const [key, value] of Object.entries(liveAnswers)) {
            if (value && value !== '[REDACTED]') {
                answers[key] = value;
            }
        }

        // Merge IC sizing from do/ic/default.conf if exists
        const defaultIcPath = join(cwd, 'do', 'ic', 'default.conf');
        if (existsSync(defaultIcPath)) {
            const icVars = parseDoConfig(defaultIcPath);
            if (icVars.IC_GPU_COUNT) answers.icGpuCount = icVars.IC_GPU_COUNT;
            if (icVars.IC_COPY_COUNT) answers.icCopyCount = icVars.IC_COPY_COUNT;
            if (icVars.IC_MEMORY_SIZE) answers.icMemorySize = icVars.IC_MEMORY_SIZE;
            if (icVars.IC_CPU_COUNT) answers.icCpuCount = icVars.IC_CPU_COUNT;
        }

        // Merge bootstrap profile
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const bootstrapConfigPath = join(homeDir, '.ml-container-creator', 'config.json');
        if (existsSync(bootstrapConfigPath)) {
            try {
                const bootstrapConfig = JSON.parse(readFileSync(bootstrapConfigPath, 'utf8'));
                const activeProfile = bootstrapConfig.activeProfile || 'default';
                const profile = bootstrapConfig.profiles?.[activeProfile];
                if (profile) {
                    if (profile.roleArn && !answers.roleArn) answers.roleArn = profile.roleArn;
                    if (profile.region && !answers.region) answers.region = profile.region;
                    if (profile.ecrRepositoryName && !answers.ecrRepositoryName) answers.ecrRepositoryName = profile.ecrRepositoryName;
                }
            } catch {
                // Ignore bootstrap config errors
            }
        }

        // Ensure destinationDir is set
        answers.destinationDir = answers.destinationDir || cwd;

        // BL062: --all-targets migration
        if (this.allTargets) {
            // Remove deploymentTarget from answers so all targets are generated
            console.log('   🎯 --all-targets: generating all deployment targets');
            // Keep deploymentTarget as default for backward compat
            if (!answers.deploymentTarget) {
                answers.deploymentTarget = 'realtime-inference';
            }

            // Migrate HYPERPOD_* → HP_* in existing do/config
            const existingConfigContent = readFileSync(configPath, 'utf8');
            let migratedCount = 0;
            const renames = [
                ['HYPERPOD_CLUSTER_NAME', 'HP_CLUSTER_NAME'],
                ['HYPERPOD_EKS_CLUSTER_NAME', 'HP_EKS_CLUSTER_NAME'],
                ['HYPERPOD_NAMESPACE', 'HP_NAMESPACE'],
                ['HYPERPOD_REPLICAS', 'HP_REPLICAS'],
                ['HYPERPOD_SUBNET_ID', 'HP_SUBNET_ID'],
                ['HYPERPOD_EFA_ENABLED', 'HP_EFA_ENABLED']
            ];
            let migratedContent = existingConfigContent;
            for (const [oldName, newName] of renames) {
                if (migratedContent.includes(oldName)) {
                    migratedContent = migratedContent.replace(new RegExp(oldName, 'g'), newName);
                    migratedCount++;
                }
            }
            if (migratedCount > 0) {
                writeFileSync(configPath, migratedContent);
                console.log(`   📝 Renamed ${migratedCount} HYPERPOD_* vars to HP_* in do/config`);
            }
        }

        if (this.dryRun) {
            console.log('\n📋 Dry run — showing what would be regenerated');
            console.log('   All generated files would be overwritten with current templates.');
            console.log(`   Answers: ${Object.keys(answers).length} parameters`);
            console.log('   No files written.');
            return;
        }

        // Backup generated files
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = join(cwd, '.mlcc-backup', timestamp);
        mkdirSync(backupDir, { recursive: true });

        const dirsToBackup = ['do'];
        if (existsSync(join(cwd, 'code'))) dirsToBackup.push('code');
        if (existsSync(join(cwd, 'Dockerfile'))) {
            cpSync(join(cwd, 'Dockerfile'), join(backupDir, 'Dockerfile'));
        }
        if (existsSync(join(cwd, 'buildspec.yml'))) {
            cpSync(join(cwd, 'buildspec.yml'), join(backupDir, 'buildspec.yml'));
        }

        for (const dir of dirsToBackup) {
            const srcDir = join(cwd, dir);
            if (existsSync(srcDir)) {
                cpSync(srcDir, join(backupDir, dir), { recursive: true });
            }
        }

        console.log(`   Backup: .mlcc-backup/${timestamp}/`);

        // Full regeneration
        // Capture runtime-owned vars before writeProject overwrites do/config
        const runtimeVars = _captureRuntimeVars(configPath);

        await writeProject(TEMPLATE_DIR, cwd, answers, null, {}, null);

        // Re-inject runtime vars that writeProject just cleared
        _injectRuntimeVars(configPath, runtimeVars);

        // Write .mlcc-version
        writeFileSync(versionPath, `${installedVersion  }\n`);
        console.log(`\n✅ Regeneration complete (v${projectVersion} → v${installedVersion})`);
        if (Object.keys(runtimeVars).length > 0) {
            console.log(`   ♻️  Preserved ${Object.keys(runtimeVars).length} runtime vars in do/config`);
        }

        // Run do/register unless --no-register
        if (!this.noRegister) {
            const registerPath = join(cwd, 'do', 'register');
            if (existsSync(registerPath)) {
                console.log('🔄 Running do/register...');
                const child = spawn(registerPath, [], { stdio: 'inherit', cwd });
                child.on('error', (err) => {
                    console.log(`⚠️  do/register failed: ${err.message}`);
                });
            }
        }
    }
}
