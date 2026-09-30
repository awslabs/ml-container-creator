// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Update Command Handler
 *
 * Updates project configuration fields and regenerates only affected files.
 * Preserves customizations to unrelated files.
 *
 * Requirements: US-2 (all ACs)
 */

import { parseKeyValue } from './key-value-parser.js';
import { getAffectedFiles } from './template-dependency-map.js';
import { writeProject } from '../app.js';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseDoConfig, shellVarsToAnswers } from './do-config.js';
import BaseCommandHandler, { TEMPLATE_DIR } from './base-command-handler.js';

/**
 * Handler for `mcc update`.
 * Updates configuration fields and regenerates only affected template files.
 */
export default class UpdateCommandHandler extends BaseCommandHandler {
    /**
     * @param {object} options
     * @param {boolean} [options.dryRun] - Show affected files without writing
     * @param {boolean} [options.noRegister] - Skip do/register after update
     * @param {string[]} [options.fields] - Array of key=value field assignments
     * @param {Function} [options.promptFn] - Custom prompt function (for testing)
     */
    constructor({ dryRun, noRegister, fields, promptFn } = {}) {
        super();
        this.dryRun = dryRun || false;
        this.noRegister = noRegister || false;
        this.fields = fields || [];
        this.promptFn = promptFn || null;
    }

    /**
     * Execute the update command in the current working directory.
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

        // Parse current configuration
        const shellVars = parseDoConfig(configPath);
        const currentAnswers = shellVarsToAnswers(shellVars);

        // Collect changes
        const changes = {};

        if (this.fields.length > 0) {
            // Non-interactive: parse --field flags
            for (const fieldStr of this.fields) {
                const { key, value } = parseKeyValue(fieldStr);
                changes[key] = value;
            }
        } else if (this.promptFn) {
            // Use custom prompt function (for testing)
            const prompted = await this.promptFn(currentAnswers);
            Object.assign(changes, prompted);
        } else {
            // Interactive mode
            const { checkbox, input } = await import('@inquirer/prompts');

            const availableFields = Object.keys(currentAnswers).filter(k => k !== 'projectName');
            const selected = await checkbox({
                message: 'Select fields to update:',
                choices: availableFields.map(k => ({ name: `${k} = ${currentAnswers[k] || '(empty)'}`, value: k }))
            });

            if (selected.length === 0) {
                console.log('ℹ️  No fields selected. Nothing to update.');
                return;
            }

            for (const key of selected) {
                const newValue = await input({
                    message: `New value for ${key}:`,
                    default: currentAnswers[key] || ''
                });
                if (newValue !== currentAnswers[key]) {
                    changes[key] = newValue;
                }
            }
        }

        if (Object.keys(changes).length === 0) {
            console.log('ℹ️  No changes detected. Nothing to update.');
            return;
        }

        // Determine affected files
        const changedKeys = Object.keys(changes);
        const affectedFiles = getAffectedFiles(changedKeys);

        // Cross-field dependency warnings
        if (changes.instanceType && currentAnswers.quantization) {
            const newType = changes.instanceType;
            if (newType.includes('.m5') || newType.includes('.c5') || newType.includes('.r5')) {
                console.log('⚠️  Warning: Changing to a CPU instance type with quantization set.');
                console.log('   Consider also updating quantization method.');
            }
        }

        console.log(`\n📝 Update: ${changedKeys.length} field(s) changed`);
        for (const [key, value] of Object.entries(changes)) {
            console.log(`   ${key}: ${currentAnswers[key] || '(empty)'} → ${value}`);
        }
        console.log(`\n📁 Affected files (${affectedFiles.length}):`);
        for (const f of affectedFiles) {
            console.log(`   ${f}`);
        }

        if (this.dryRun) {
            console.log('\n📋 Dry run — no files written.');
            return;
        }

        // Merge answers
        const mergedAnswers = { ...currentAnswers, ...changes };

        // Regenerate only affected files
        if (affectedFiles.length > 0) {
            await writeProject(TEMPLATE_DIR, cwd, mergedAnswers, null, {}, null, {
                onlyFiles: affectedFiles
            });
        }

        // Update do/config directly for changed values
        let configContent = readFileSync(configPath, 'utf8');
        const answerToShell = {
            instanceType: 'INSTANCE_TYPE',
            deploymentConfig: 'DEPLOYMENT_CONFIG',
            modelName: 'MODEL_NAME',
            baseImage: 'BASE_IMAGE',
            region: 'REGION',
            awsRegion: 'AWS_REGION',
            icGpuCount: 'IC_GPU_COUNT',
            icCopyCount: 'IC_COPY_COUNT',
            icMemorySize: 'IC_MEMORY_SIZE',
            icCpuCount: 'IC_CPU_COUNT',
            enableLora: 'ENABLE_LORA',
            maxLoras: 'MAX_LORAS',
            quantization: 'QUANTIZATION'
        };

        for (const [camelKey, value] of Object.entries(changes)) {
            const shellKey = answerToShell[camelKey] || camelKey.replace(/([A-Z])/g, '_$1').toUpperCase();
            const regex = new RegExp(`^(\\s*export\\s+${shellKey}=).*$`, 'm');
            if (regex.test(configContent)) {
                configContent = configContent.replace(regex, `$1"${value}"`);
            } else {
                configContent += `\nexport ${shellKey}="${value}"\n`;
            }
        }
        writeFileSync(configPath, configContent);

        // Append to do/update.log
        const logEntry = {
            timestamp: new Date().toISOString(),
            changedFields: changes,
            affectedFiles
        };
        const logPath = join(cwd, 'do', 'update.log');
        appendFileSync(logPath, `${JSON.stringify(logEntry)  }\n`);

        console.log('\n✅ Update complete.');

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
