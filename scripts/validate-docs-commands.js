#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * validate-docs-commands.js
 *
 * Validates all `ml-container-creator` CLI commands found in documentation
 * against the parameter schema (config/parameter-schema-v2.json).
 *
 * What it catches:
 * - Unknown/invalid CLI flags (typos, removed flags, hallucinated flags)
 * - Invalid enum values (e.g., --deployment-target=managed-inference)
 * - Deprecated flags used without acknowledgement
 *
 * Usage:
 *   node scripts/validate-docs-commands.js
 *
 * Exit codes:
 *   0 — all commands valid
 *   1 — one or more errors found
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ============================================================
// Load parameter schema
// ============================================================

const schemaPath = join(ROOT, 'config', 'parameter-schema-v2.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// Build a map: cliFlag → { type, enum?, key, deprecated }
const schemaFlags = new Map();
for (const [key, param] of Object.entries(schema.parameters)) {
    const flag = param.cliFlag;
    if (!flag) continue;
    schemaFlags.set(flag, {
        key,
        type: param.type,
        enum: param.validation?.enum || null,
        deprecated: param.deprecated || false
    });
}

// ============================================================
// Allowlist: flags that exist in bin/cli.js but NOT in the schema
// These are subcommand flags, meta flags, or Commander built-ins.
// We won't flag these as errors when found in docs code blocks.
// ============================================================

const ALLOWLIST = new Set([
    // Meta/global flags (Commander built-ins + project-level)
    '--help', '--version',

    // Bootstrap subcommand flags
    '--non-interactive', '--profile', '--name', '--ci', '--skip-ci',
    '--skip-s3', '--skip-post-setup', '--delete-stack', '--verify',
    '--ignore-staleness',

    // Registry subcommand flags
    '--backend', '--architecture', '--model', '--status', '--merge',
    '--replace', '--notes', '--project', '--parameters', '--ic-list',
    '--generator-version', '--server', '--verbose', '--json',

    // Secrets subcommand flags
    '--type', '--secret-value', '--description', '--kms-key-id',

    // MCP subcommand flags
    '--tool-name', '--limit', '--bundled',

    // do/ script flags that appear in docs (not CLI flags)
    '--technique', '--dataset', '--from-tune', '--adapter-name',
    '--cli-read-timeout', '--goal', '--instances',
    '--concurrency', '--input-tokens', '--output-tokens',
    '--auto', '--dry-run',

    // Benchmark script flags in docs
    '--request-count', '--streaming'
]);

// ============================================================
// Deprecated values to flag
// ============================================================

const DEPRECATED_VALUES = new Map([
    ['--deployment-target', new Map([
        ['managed-inference', 'Use "realtime-inference" instead (managed-inference is deprecated)']
    ])]
]);

// ============================================================
// Walk docs/ for .md files
// ============================================================

function walkDir(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            results.push(...walkDir(fullPath));
        } else if (entry.endsWith('.md')) {
            results.push(fullPath);
        }
    }
    return results;
}

// ============================================================
// Extract fenced code blocks containing ml-container-creator commands
// ============================================================

function extractCommands(filePath) {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const commands = [];

    let inCodeBlock = false;
    let blockLines = [];
    let blockStartLine = 0;
    let blockLang = '';

    // Languages that should NOT be validated (non-executable)
    const skipLangs = new Set(['text', 'json', 'yaml', 'yml', 'python', 'py', 'javascript', 'js', 'html', 'css', 'xml', 'toml', 'ini', 'sql', 'diff', 'plaintext']);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.trimStart().startsWith('```') && !inCodeBlock) {
            // Extract language tag (e.g., ```bash, ```text, ```json)
            blockLang = line.trimStart().slice(3).trim().toLowerCase();
            inCodeBlock = true;
            blockLines = [];
            blockStartLine = i + 1; // 1-indexed
            continue;
        }

        if (line.trimStart().startsWith('```') && inCodeBlock) {
            // End of code block — check for ml-container-creator commands
            // Skip non-executable code blocks
            if (skipLangs.has(blockLang)) {
                inCodeBlock = false;
                blockLang = '';
                continue;
            }
            const blockText = blockLines.join('\n');
            if (blockText.includes('ml-container-creator')) {
                // Join continuation lines (ending with \)
                const joined = blockText.replace(/\\\s*\n\s*/g, ' ');
                // Find lines that start with ml-container-creator
                for (const cmdLine of joined.split('\n')) {
                    const trimmed = cmdLine.trim();
                    // Match lines starting with ml-container-creator (possibly after $ or #)
                    const match = trimmed.match(/^(?:\$\s+)?ml-container-creator\s+(.*)/);
                    if (match) {
                        commands.push({
                            command: match[1],
                            line: blockStartLine,
                            file: filePath
                        });
                    }
                }
            }
            inCodeBlock = false;
            blockLines = [];
            continue;
        }

        if (inCodeBlock) {
            blockLines.push(line);
        }
    }

    return commands;
}

// ============================================================
// Parse flags from a command string
// ============================================================

function parseFlags(commandStr) {
    const flags = [];
    // Tokenize — handle --flag=value and --flag value
    const tokens = commandStr.split(/\s+/).filter(t => t.length > 0);

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token.startsWith('--')) {
            // Handle --flag=value
            const eqIdx = token.indexOf('=');
            if (eqIdx !== -1) {
                const flag = token.substring(0, eqIdx);
                const value = token.substring(eqIdx + 1);
                flags.push({ flag, value });
            } else {
                // Handle --flag value or boolean --flag
                const flag = token;
                // Peek next token to see if it's a value (doesn't start with --)
                const next = tokens[i + 1];
                if (next && !next.startsWith('--')) {
                    flags.push({ flag, value: next });
                    i++; // skip the value token
                } else {
                    flags.push({ flag, value: null });
                }
            }
        }
        // Skip positional args (project name, subcommands like bootstrap, registry, etc.)
    }

    return flags;
}

// ============================================================
// Determine if a command is a subcommand (bootstrap, mcp, registry, secrets, configure)
// ============================================================

function isSubcommand(commandStr) {
    const first = commandStr.trim().split(/\s+/)[0];
    return ['bootstrap', 'mcp', 'registry', 'secrets', 'configure', 'help'].includes(first);
}

// ============================================================
// Validate a single command
// ============================================================

function validateCommand(cmd) {
    const errors = [];

    // Skip subcommands — their flags are different and handled by Commander subparsers
    if (isSubcommand(cmd.command)) {
        return { errors, skipped: true };
    }

    const flags = parseFlags(cmd.command);

    for (const { flag, value } of flags) {
        // Check allowlist first
        if (ALLOWLIST.has(flag)) continue;

        // Check schema
        const schemaInfo = schemaFlags.get(flag);
        if (!schemaInfo) {
            errors.push({
                type: 'unknown-flag',
                message: `unknown flag '${flag}'`,
                file: cmd.file,
                line: cmd.line
            });
            continue;
        }

        // Check enum values
        if (value !== null && schemaInfo.enum) {
            if (!schemaInfo.enum.includes(value)) {
                errors.push({
                    type: 'invalid-value',
                    message: `invalid value '${value}' for ${flag} (allowed: [${schemaInfo.enum.join(', ')}])`,
                    file: cmd.file,
                    line: cmd.line
                });
            }
        }

        // Check deprecated values
        const deprecatedMap = DEPRECATED_VALUES.get(flag);
        if (deprecatedMap && value && deprecatedMap.has(value)) {
            errors.push({
                type: 'deprecated-value',
                message: `deprecated value '${value}' for ${flag}. ${deprecatedMap.get(value)}`,
                file: cmd.file,
                line: cmd.line
            });
        }

        // Check deprecated flags
        if (schemaInfo.deprecated) {
            errors.push({
                type: 'deprecated-flag',
                message: `deprecated flag '${flag}' (key: ${schemaInfo.key})`,
                file: cmd.file,
                line: cmd.line
            });
        }
    }

    return { errors, skipped: false };
}

// ============================================================
// Main
// ============================================================

function main() {
    const docsDir = join(ROOT, 'docs');
    const mdFiles = walkDir(docsDir);

    let totalCommands = 0;
    let skippedCommands = 0;
    const allErrors = [];

    for (const file of mdFiles) {
        const commands = extractCommands(file);

        for (const cmd of commands) {
            totalCommands++;
            const { errors, skipped } = validateCommand(cmd);
            if (skipped) {
                skippedCommands++;
                continue;
            }
            allErrors.push(...errors);
        }
    }

    const relPath = (file) => relative(ROOT, file);

    // Output errors
    for (const err of allErrors) {
        const icon = err.type === 'deprecated-value' || err.type === 'deprecated-flag' ? '⚠️' : '❌';
        console.log(`${icon}  ${relPath(err.file)}:${err.line} — ${err.message}`);
    }

    // Summary
    console.log('');
    const validated = totalCommands - skippedCommands;
    const hardErrors = allErrors.filter(e => e.type !== 'deprecated-value' && e.type !== 'deprecated-flag');
    const warnings = allErrors.filter(e => e.type === 'deprecated-value' || e.type === 'deprecated-flag');

    if (hardErrors.length === 0 && warnings.length === 0) {
        console.log(`✅ ${validated} commands validated, 0 errors (${skippedCommands} subcommands skipped)`);
    } else if (hardErrors.length === 0) {
        console.log(`✅ ${validated} commands validated, 0 errors, ${warnings.length} deprecation warnings (${skippedCommands} subcommands skipped)`);
    } else {
        console.log(`❌ ${validated} commands validated, ${hardErrors.length} errors, ${warnings.length} warnings (${skippedCommands} subcommands skipped)`);
    }

    process.exit(hardErrors.length > 0 ? 1 : 0);
}

main();
