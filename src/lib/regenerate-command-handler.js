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
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GENERATOR_ROOT = resolve(__dirname, '../..');
const TEMPLATE_DIR = join(GENERATOR_ROOT, 'templates');

/**
 * Parse a do/config file into a key-value map.
 * @param {string} configPath - Path to do/config
 * @returns {object} Parsed key-value pairs
 */
function parseDoConfig(configPath) {
    const content = readFileSync(configPath, 'utf8');
    const result = {};
    for (const line of content.split('\n')) {
        const match = line.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=["']?([^"']*)["']?\s*$/);
        if (match) {
            result[match[1]] = match[2];
        }
    }
    return result;
}

/**
 * Convert shell-style KEY names to camelCase answer keys.
 * @param {object} shellVars - Shell variable map
 * @returns {object} camelCase answers map
 */
function shellVarsToAnswers(shellVars) {
    const answers = {};
    const mapping = {
        PROJECT_NAME: 'projectName',
        DEPLOYMENT_CONFIG: 'deploymentConfig',
        DEPLOYMENT_TARGET: 'deploymentTarget',
        INSTANCE_TYPE: 'instanceType',
        MODEL_NAME: 'modelName',
        BASE_IMAGE: 'baseImage',
        REGION: 'region',
        AWS_REGION: 'awsRegion',
        ENDPOINT_NAME: 'endpointName',
        DEPLOY_MODE: 'deployMode',
        CONTAINER_IMAGE_URI: 'container_image_uri',
        ENDPOINT_STATUS: 'endpointStatus',
        IC_GPU_COUNT: 'icGpuCount',
        IC_COPY_COUNT: 'icCopyCount',
        IC_MEMORY_SIZE: 'icMemorySize',
        IC_CPU_COUNT: 'icCpuCount',
        ENABLE_LORA: 'enableLora',
        MAX_LORAS: 'maxLoras',
        QUANTIZATION: 'quantization',
        HF_TOKEN_ARN: 'hfTokenArn',
        NGC_TOKEN_ARN: 'ngcTokenArn',
        GENERATOR_VERSION: 'generatorVersion',
        // Per-target deployment status vars (FR-9.3: preserved on regeneration)
        DEPLOYMENT_TARGET_SMAI_STATUS: 'deploymentTargetSmaiStatus',
        DEPLOYMENT_TARGET_HP_STATUS: 'deploymentTargetHpStatus',
        DEPLOYMENT_TARGET_ASYNC_STATUS: 'deploymentTargetAsyncStatus',
        DEPLOYMENT_TARGET_BATCH_STATUS: 'deploymentTargetBatchStatus'
    };

    for (const [shellKey, value] of Object.entries(shellVars)) {
        const camelKey = mapping[shellKey];
        if (camelKey) {
            answers[camelKey] = value;
        }
    }
    return answers;
}

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
 * Handler for `mcc regenerate`.
 * Re-runs generation from saved parameters using the current generator version.
 */
export default class RegenerateCommandHandler {
    /**
     * @param {object} options
     * @param {boolean} [options.dryRun] - Show what would change without writing
     * @param {boolean} [options.force] - Regenerate even if version matches
     * @param {boolean} [options.noRegister] - Skip do/register after regeneration
     * @param {boolean} [options.allTargets] - Generate all deployment targets (BL062 migration)
     */
    constructor({ dryRun, force, noRegister, allTargets } = {}) {
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

        // Check if regeneration is needed
        if (projectVersion === installedVersion && !this.force) {
            console.log(`✅ Already up to date (v${installedVersion})`);
            return;
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
        await writeProject(TEMPLATE_DIR, cwd, answers, null, {}, null);

        // Write .mlcc-version
        writeFileSync(versionPath, `${installedVersion  }\n`);
        console.log(`\n✅ Regeneration complete (v${projectVersion} → v${installedVersion})`);

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
