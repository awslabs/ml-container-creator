#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * extract-docs-claims.js
 *
 * Extracts ml-container-creator CLI commands from documentation markdown files
 * and normalizes them into configId hashes that are compatible with the MCC CI
 * DynamoDB table (written by `do/register --ci`).
 *
 * This is the bridge between "what the docs claim works" and "what CI has proven."
 * Use it to:
 *   - See all documented configurations as structured data
 *   - Reconcile docs claims against the CI table (find undocumented or failing configs)
 *   - Feed the results into a validation agent
 *
 * The configId hash matches the function in templates/do/register:
 *   SHA-256 of "${DEPLOYMENT_CONFIG}:${MODEL_NAME}:${INSTANCE_TYPE}:${AWS_REGION}:${DEPLOYMENT_TARGET}:ic1:adapt0"
 *   truncated to first 16 hex characters.
 *
 * Usage:
 *   node scripts/extract-docs-claims.js --format json
 *   node scripts/extract-docs-claims.js --format table
 *   node scripts/extract-docs-claims.js --format reconcile --aws-region us-east-1 --table mlcc-ci-table
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DOCS_DIR = join(__dirname, '..', 'docs');

// ============================================================
// CLI Argument Parsing
// ============================================================

function parseArgs(argv) {
    const args = { format: 'json', awsRegion: 'us-east-1', table: 'mlcc-ci-table' };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--format' && argv[i + 1]) {
            args.format = argv[++i];
        } else if (arg.startsWith('--format=')) {
            args.format = arg.split('=')[1];
        } else if (arg === '--aws-region' && argv[i + 1]) {
            args.awsRegion = argv[++i];
        } else if (arg.startsWith('--aws-region=')) {
            args.awsRegion = arg.split('=')[1];
        } else if (arg === '--table' && argv[i + 1]) {
            args.table = argv[++i];
        } else if (arg.startsWith('--table=')) {
            args.table = arg.split('=')[1];
        } else if (arg === '--help' || arg === '-h') {
            console.log(`Usage: node scripts/extract-docs-claims.js [options]

Options:
  --format <json|table|reconcile>  Output format (default: json)
  --aws-region <region>            AWS region for reconcile mode (default: us-east-1)
  --table <name>                   DynamoDB table name for reconcile mode (default: mlcc-ci-table)
  --help, -h                       Show this help message
`);
            process.exit(0);
        }
    }
    return args;
}

// ============================================================
// File Discovery
// ============================================================

function walkMarkdownFiles(dir) {
    const files = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkMarkdownFiles(fullPath));
        } else if (entry.name.endsWith('.md')) {
            files.push(fullPath);
        }
    }
    return files;
}

// ============================================================
// Command Extraction
// ============================================================

/**
 * Extract fenced code blocks from a markdown file and return
 * ml-container-creator generation commands with their line numbers.
 */
function extractCommands(filePath) {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const commands = [];

    let inCodeBlock = false;
    let blockLines = [];
    let blockStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inCodeBlock && /^```(?:bash|shell|sh)?$/.test(line.trim())) {
            inCodeBlock = true;
            blockLines = [];
            blockStartLine = i + 1; // 1-indexed
            continue;
        }

        if (inCodeBlock && line.trim() === '```') {
            inCodeBlock = false;
            // Process the block
            const joined = blockLines.join('\n');
            // Join continuation lines (backslash + newline)
            const merged = joined.replace(/\\\n\s*/g, ' ');
            const cmdLines = merged.split('\n');

            for (let j = 0; j < cmdLines.length; j++) {
                const cmd = cmdLines[j].trim();
                if (cmd.startsWith('ml-container-creator') && !isSubcommand(cmd)) {
                    commands.push({
                        command: cmd,
                        line: blockStartLine + j
                    });
                }
            }
            continue;
        }

        if (inCodeBlock) {
            blockLines.push(line);
        }
    }

    return commands;
}

/**
 * Returns true if the command is a subcommand (bootstrap, registry, etc.)
 * rather than a project generation command.
 */
function isSubcommand(cmd) {
    const subcommands = ['bootstrap', 'registry', 'mcp', 'secrets', 'manifest', 'validate'];
    const parts = cmd.split(/\s+/);
    if (parts.length >= 2) {
        const secondToken = parts[1];
        if (subcommands.includes(secondToken)) {
            return true;
        }
    }
    return false;
}

// ============================================================
// Flag Parsing
// ============================================================

/**
 * Parse CLI flags from a command string into a key-value map.
 * Handles --flag=value and --flag value patterns.
 */
function parseFlags(command) {
    const flags = {};
    const parts = command.split(/\s+/).slice(1); // remove 'ml-container-creator'

    let i = 0;
    // Skip the first non-flag token (positional project name)
    if (parts.length > 0 && !parts[0].startsWith('-')) {
        flags._projectName = parts[0];
        i = 1;
    }

    while (i < parts.length) {
        const token = parts[i];

        if (token.startsWith('--')) {
            if (token.includes('=')) {
                const [key, ...valueParts] = token.split('=');
                flags[key.replace(/^--/, '')] = valueParts.join('=');
            } else {
                const key = token.replace(/^--/, '');
                if (i + 1 < parts.length && !parts[i + 1].startsWith('-')) {
                    flags[key] = parts[i + 1];
                    i++;
                } else {
                    flags[key] = true;
                }
            }
        }
        i++;
    }

    return flags;
}

// ============================================================
// Config Normalization
// ============================================================

/**
 * Build a normalized config object from parsed flags.
 * Returns null if insufficient data to build a configId.
 */
function normalizeConfig(flags) {
    const deploymentConfig = flags['deployment-config'];
    if (!deploymentConfig) {
        return null;
    }

    const config = {
        deploymentConfig,
        modelName: flags['model-name'] || 'none',
        instanceType: flags['instance-type'] || 'unknown',
        awsRegion: flags['region'] || 'us-east-1',
        deploymentTarget: flags['deployment-target'] || 'realtime-inference'
    };

    return config;
}

// ============================================================
// ConfigId Hash (matches templates/do/register compute_config_id)
// ============================================================

/**
 * Compute configId: SHA-256 of the canonical config string, truncated to 16 hex chars.
 * Format matches templates/do/register:
 *   "${DEPLOYMENT_CONFIG}:${MODEL_NAME:-none}:${INSTANCE_TYPE}:${AWS_REGION}:${DEPLOYMENT_TARGET}:ic1:adapt0"
 */
function computeConfigId(config) {
    const input = `${config.deploymentConfig}:${config.modelName}:${config.instanceType}:${config.awsRegion}:${config.deploymentTarget}:ic1:adapt0`;
    const hash = createHash('sha256').update(input).digest('hex');
    return hash.substring(0, 16);
}

// ============================================================
// Main Extraction Pipeline
// ============================================================

function extractAllClaims() {
    const mdFiles = walkMarkdownFiles(DOCS_DIR);
    const claims = [];

    for (const filePath of mdFiles.sort()) {
        const relPath = relative(join(__dirname, '..'), filePath);
        const commands = extractCommands(filePath);

        for (const { command, line } of commands) {
            const flags = parseFlags(command);
            const config = normalizeConfig(flags);

            if (!config) {
                continue; // Skip commands without deployment-config
            }

            if (config.instanceType === 'unknown') {
                continue; // Skip commands without instance type (not deployable)
            }

            // Skip placeholder/template commands (contain angle brackets like <hf-id>)
            if (config.deploymentConfig.includes('<') || config.deploymentConfig.includes('>') ||
                config.modelName.includes('<') || config.modelName.includes('>') ||
                config.instanceType.includes('<') || config.instanceType.includes('>') ||
                config.awsRegion.includes('<') || config.awsRegion.includes('>')) {
                continue;
            }

            const configId = computeConfigId(config);

            claims.push({
                configId,
                source: `${relPath}:${line}`,
                deploymentConfig: config.deploymentConfig,
                modelName: config.modelName,
                instanceType: config.instanceType,
                region: config.awsRegion,
                deploymentTarget: config.deploymentTarget,
                fullCommand: command.length > 120 ? command.substring(0, 117) + '...' : command
            });
        }
    }

    // Deduplicate by configId (same config may appear in multiple places)
    const seen = new Map();
    for (const claim of claims) {
        if (!seen.has(claim.configId)) {
            seen.set(claim.configId, claim);
        } else {
            const existing = seen.get(claim.configId);
            if (!existing.additionalSources) {
                existing.additionalSources = [];
            }
            existing.additionalSources.push(claim.source);
        }
    }

    return [...seen.values()];
}

// ============================================================
// Output Formatters
// ============================================================

function outputJson(claims) {
    console.log(JSON.stringify(claims, null, 2));
}

function outputTable(claims) {
    if (claims.length === 0) {
        console.log('No deployable claims found in documentation.');
        return;
    }

    const header = `${'configId'.padEnd(18)} ${'deployment-config'.padEnd(22)} ${'model'.padEnd(35)} ${'instance'.padEnd(16)} ${'source'.padEnd(40)}`;
    console.log(header);
    console.log('─'.repeat(header.length));

    for (const claim of claims) {
        const model = claim.modelName.length > 33 ? claim.modelName.substring(0, 30) + '...' : claim.modelName;
        const source = claim.source.length > 38 ? claim.source.substring(0, 35) + '...' : claim.source;
        console.log(
            `${claim.configId.padEnd(18)} ${claim.deploymentConfig.padEnd(22)} ${model.padEnd(35)} ${claim.instanceType.padEnd(16)} ${source.padEnd(40)}`
        );
        if (claim.additionalSources) {
            for (const src of claim.additionalSources) {
                console.log(`${''.padEnd(18)} ${''.padEnd(22)} ${'(also in)'.padEnd(35)} ${''.padEnd(16)} ${src}`);
            }
        }
    }

    console.log('─'.repeat(header.length));
    console.log(`Total: ${claims.length} unique configurations documented`);
}

async function outputReconcile(claims, awsRegion, tableName) {
    let DynamoDBClient, GetItemCommand;

    try {
        const dynamoModule = await import('@aws-sdk/client-dynamodb');
        DynamoDBClient = dynamoModule.DynamoDBClient;
        GetItemCommand = dynamoModule.GetItemCommand;
    } catch {
        console.error('❌ @aws-sdk/client-dynamodb not available.');
        console.error('   Install it: npm install @aws-sdk/client-dynamodb');
        console.error('   Or use --format json|table for offline mode.');
        process.exit(1);
    }

    const client = new DynamoDBClient({ region: awsRegion });

    console.log(`\n🔍 Reconciling ${claims.length} docs claims against CI table: ${tableName} (${awsRegion})\n`);

    const results = { proven: 0, untested: 0, failed: 0, unregistered: 0, error: 0 };

    for (const claim of claims) {
        try {
            const response = await client.send(new GetItemCommand({
                TableName: tableName,
                Key: { configId: { S: claim.configId } }
            }));

            if (!response.Item) {
                console.log(`🔴 ${claim.configId}  ${claim.deploymentConfig.padEnd(20)} ${claim.modelName.padEnd(30)} UNREGISTERED  (${claim.source})`);
                results.unregistered++;
            } else {
                const testStatus = response.Item.testStatus?.S || 'unknown';
                switch (testStatus) {
                case 'passed':
                    console.log(`✅ ${claim.configId}  ${claim.deploymentConfig.padEnd(20)} ${claim.modelName.padEnd(30)} PROVEN        (${claim.source})`);
                    results.proven++;
                    break;
                case 'untested':
                    console.log(`⏳ ${claim.configId}  ${claim.deploymentConfig.padEnd(20)} ${claim.modelName.padEnd(30)} UNTESTED      (${claim.source})`);
                    results.untested++;
                    break;
                case 'failed':
                    console.log(`❌ ${claim.configId}  ${claim.deploymentConfig.padEnd(20)} ${claim.modelName.padEnd(30)} FAILED        (${claim.source})`);
                    results.failed++;
                    break;
                default:
                    console.log(`❓ ${claim.configId}  ${claim.deploymentConfig.padEnd(20)} ${claim.modelName.padEnd(30)} ${testStatus.padEnd(12)} (${claim.source})`);
                    results.untested++;
                }
            }
        } catch (err) {
            if (err.name === 'ResourceNotFoundException') {
                console.error(`\n❌ Table '${tableName}' not found in ${awsRegion}.`);
                console.error('   Run `ml-container-creator bootstrap --ci` to provision CI infrastructure.');
                process.exit(1);
            }
            if (err.name === 'CredentialsProviderError' || err.name === 'ExpiredTokenException') {
                console.error(`\n❌ AWS credentials error: ${err.message}`);
                console.error('   Ensure AWS credentials are configured (aws sso login, env vars, or ~/.aws/credentials).');
                process.exit(1);
            }
            console.log(`⚠️  ${claim.configId}  ${claim.deploymentConfig.padEnd(20)} ERROR: ${err.message}`);
            results.error++;
        }
    }

    console.log('\n' + '─'.repeat(80));
    console.log(`Summary: ${claims.length} documented configs`);
    console.log(`  ✅ Proven:       ${results.proven}`);
    console.log(`  ⏳ Untested:     ${results.untested}`);
    console.log(`  ❌ Failed:       ${results.failed}`);
    console.log(`  🔴 Unregistered: ${results.unregistered}`);
    if (results.error > 0) {
        console.log(`  ⚠️  Errors:       ${results.error}`);
    }
    console.log('');

    if (results.failed > 0 || results.unregistered > 0) {
        process.exit(1);
    }
}

// ============================================================
// Entry Point
// ============================================================

async function main() {
    const args = parseArgs(process.argv);
    const claims = extractAllClaims();

    switch (args.format) {
    case 'json':
        outputJson(claims);
        break;
    case 'table':
        outputTable(claims);
        break;
    case 'reconcile':
        await outputReconcile(claims, args.awsRegion, args.table);
        break;
    default:
        console.error(`Unknown format: ${args.format}. Use json, table, or reconcile.`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
