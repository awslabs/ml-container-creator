#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent Knowledge MCP Server
 *
 * A bundled MCP server that provides project knowledge not covered by
 * other specialized servers: script reference, config documentation,
 * troubleshooting patterns, and capability matrix.
 *
 * Tool: query_knowledge
 *   Accepts: { topic, filter? }
 *   Returns: topic-specific structured data
 *
 * Topics:
 *   - script_reference: do/* script metadata (purpose, flags, lifecycle position)
 *   - config_reference: do/config exported variables and documentation
 *   - troubleshooting: parsed TROUBLESHOOTING.md patterns
 *   - capability_matrix: agent capability matrix (full or filtered)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename, join } from 'node:path';
import { loadWithOverridesObject, resolveProjectDir } from '../lib/override-loader.js';

// ── Path setup ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '../../');

// ── Logging ──────────────────────────────────────────────────────────────────

function log(message) {
    process.stderr.write(`[agent-knowledge] ${message}\n`);
}

// ── In-memory cache ──────────────────────────────────────────────────────────

const cache = new Map();

function getCached(key, loader) {
    if (cache.has(key)) {
        return cache.get(key);
    }
    const value = loader();
    cache.set(key, value);
    return value;
}

// ── Script Reference Parser ──────────────────────────────────────────────────

/**
 * Known lifecycle positions for do/* scripts.
 * Provides ordering context for the agent.
 */
const LIFECYCLE_POSITIONS = {
    config: 'configuration',
    build: 'build',
    run: 'local-test',
    test: 'local-test',
    push: 'publish',
    deploy: 'deploy',
    status: 'monitor',
    logs: 'monitor',
    clean: 'teardown',
    validate: 'pre-deploy',
    register: 'publish',
    stage: 'publish',
    optimize: 'pre-deploy',
    benchmark: 'post-deploy',
    evaluate: 'post-deploy',
    adapter: 'post-deploy',
    'add-ic': 'post-deploy',
    train: 'training',
    tune: 'training',
    ci: 'ci',
    submit: 'build',
    export: 'publish',
    manifest: 'metadata'
};

/**
 * Parse a single do/* script file to extract metadata from header comments.
 *
 * Looks for:
 *   - First comment block for purpose description
 *   - Usage: lines for flags
 *   - `source` directives for reads
 *   - Variable exports for writes
 */
function parseScriptFile(filePath) {
    try {
        const content = readFileSync(filePath, 'utf8');
        const name = basename(filePath);

        // Extract purpose from first comment block (lines starting with #, after shebang)
        const lines = content.split('\n');
        let purpose = '';
        let flags = [];
        const reads = [];
        const writes = [];
        const commonFailures = [];

        // Skip shebang and copyright, find first descriptive comment
        const inHeader = true;
        const headerComments = [];
        for (const line of lines) {
            if (line.startsWith('#!')) continue;
            if (line.startsWith('# Copyright')) continue;
            if (line.startsWith('# SPDX-License-Identifier')) continue;
            if (line === '#' || line === '') {
                if (headerComments.length > 0) break;
                continue;
            }
            if (inHeader && line.startsWith('#')) {
                headerComments.push(line.replace(/^#\s?/, ''));
            } else {
                break;
            }
        }

        // First non-empty header comment is the purpose
        purpose = headerComments.filter(c => c.trim()).join(' ').trim();

        // Parse Usage block for flags
        const usageMatch = content.match(/# Usage:\s*\n((?:#\s+.*\n)*)/);
        if (usageMatch) {
            const usageLines = usageMatch[1].split('\n')
                .map(l => l.replace(/^#\s*/, '').trim())
                .filter(Boolean);
            flags = usageLines;
        }

        // Parse individual flag definitions (--flag patterns in comments)
        const flagPattern = /^#\s+(--[\w-]+(?:\s+\S+)?)\s+(.+)/gm;
        let flagMatch;
        while ((flagMatch = flagPattern.exec(content)) !== null) {
            if (!flags.includes(flagMatch[1])) {
                flags.push(`${flagMatch[1]}  ${flagMatch[2]}`);
            }
        }

        // Detect source reads (source "..." or source '...')
        const sourcePattern = /source\s+["']?\$\{?SCRIPT_DIR\}?["']?\/?([^"'\s;]+)/g;
        let srcMatch;
        while ((srcMatch = sourcePattern.exec(content)) !== null) {
            reads.push(`do/${srcMatch[1]}`);
        }

        // Detect config sourcing
        if (content.includes('source "${SCRIPT_DIR}/config"') || content.includes('source \'${SCRIPT_DIR}/config\'')) {
            if (!reads.includes('do/config')) {
                reads.push('do/config');
            }
        }

        // Detect writes (common output patterns)
        if (content.includes('docker build')) writes.push('Docker image');
        if (content.includes('docker push') || content.includes('ecr')) writes.push('ECR repository');
        if (content.includes('aws sagemaker create-endpoint')) writes.push('SageMaker endpoint');
        if (content.includes('aws sagemaker create-model')) writes.push('SageMaker model');
        if (content.includes('aws sagemaker delete-')) writes.push('SageMaker resources (delete)');

        // Common failure patterns from script error handling
        const exitPattern = /echo\s+"(?:\u274c|\u26a0\ufe0f)\s+(.+?)"\s*\n\s*(echo\s+".+?")?\s*\n?\s*exit\s+\d+/gu;
        let exitMatch;
        while ((exitMatch = exitPattern.exec(content)) !== null) {
            commonFailures.push(exitMatch[1].replace(/\$\{[^}]+\}/g, '<variable>'));
        }

        return {
            name,
            purpose: purpose || `do/${name} script`,
            flags,
            reads,
            writes,
            lifecycle_position: LIFECYCLE_POSITIONS[name] || 'unknown',
            common_failures: commonFailures
        };
    } catch (err) {
        return {
            name: basename(filePath),
            purpose: 'Unable to parse',
            flags: [],
            reads: [],
            writes: [],
            lifecycle_position: LIFECYCLE_POSITIONS[basename(filePath)] || 'unknown',
            common_failures: [],
            error: err.message,
            partial: true
        };
    }
}

/**
 * Load and parse all do/* scripts from templates/do/.
 * Skips hidden files, directories, and non-executable templates (e.g., EJS partials).
 */
function loadScriptReference() {
    const doDir = resolve(PACKAGE_ROOT, 'templates/do');
    try {
        const entries = readdirSync(doDir);
        const scripts = [];

        for (const entry of entries) {
            // Skip hidden files, directories, __pycache__, README
            if (entry.startsWith('.') || entry === '__pycache__' || entry === 'README.md') continue;

            const fullPath = resolve(doDir, entry);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) continue;

            const parsed = parseScriptFile(fullPath);
            // Skip EJS-only templates (contain only <%- include(...) %>)
            if (parsed.purpose === '' && parsed.flags.length === 0) {
                // Check if it's just an include directive
                const content = readFileSync(fullPath, 'utf8').trim();
                if (content.startsWith('<%') && content.length < 200) {
                    parsed.purpose = 'Template include (delegates to sub-template)';
                }
            }
            scripts.push(parsed);
        }

        return scripts;
    } catch (err) {
        return { error: `Failed to read templates/do/: ${err.message}`, partial: true };
    }
}

// ── Config Reference Parser ──────────────────────────────────────────────────

/**
 * Parse the do/config template to extract exported variables and their documentation.
 */
function loadConfigReference() {
    const configPath = resolve(PACKAGE_ROOT, 'templates/do/config');
    try {
        const content = readFileSync(configPath, 'utf8');
        const lines = content.split('\n');

        const doConfigVars = [];
        const icEnvVars = [];
        const trainingConfig = [];

        let currentComment = '';
        let currentSection = 'do_config';

        for (const line of lines) {
            // Track sections
            if (line.includes('Training') || line.includes('training')) {
                currentSection = 'training';
            }
            if (line.includes('IC ') || line.includes('inference component') || line.includes('Inference Component')) {
                currentSection = 'ic';
            }

            // Collect comments
            if (line.startsWith('#') && !line.startsWith('#!') && !line.startsWith('# Copyright') && !line.startsWith('# SPDX')) {
                const comment = line.replace(/^#\s?/, '').trim();
                if (comment && !comment.startsWith('──')) {
                    currentComment = comment;
                }
                continue;
            }

            // Parse export lines
            const exportMatch = line.match(/^export\s+(\w+)=(.*)$/);
            if (exportMatch) {
                const varName = exportMatch[1];
                const defaultValue = exportMatch[2]
                    .replace(/\$\{[^:}]+:-([^}]*)\}/g, '$1')  // Extract default from ${VAR:-default}
                    .replace(/["'<>%=\s]/g, '')
                    .trim();

                const entry = {
                    name: varName,
                    description: currentComment || '',
                    default: defaultValue || null
                };

                if (currentSection === 'training') {
                    trainingConfig.push(entry);
                } else if (currentSection === 'ic') {
                    icEnvVars.push(entry);
                } else {
                    doConfigVars.push(entry);
                }
                currentComment = '';
                continue;
            }

            // Parse commented-out export lines (optional vars)
            const commentedExport = line.match(/^#\s*export\s+(\w+)=(.*)$/);
            if (commentedExport) {
                const varName = commentedExport[1];
                const entry = {
                    name: varName,
                    description: currentComment || '(optional, commented out)',
                    default: null,
                    optional: true
                };

                if (currentSection === 'training') {
                    trainingConfig.push(entry);
                } else if (currentSection === 'ic') {
                    icEnvVars.push(entry);
                } else {
                    doConfigVars.push(entry);
                }
                currentComment = '';
                continue;
            }

            // EJS conditionals reset comment
            if (line.startsWith('<%')) {
                currentComment = '';
            }
        }

        return {
            do_config_vars: doConfigVars,
            ic_env_vars: icEnvVars,
            training_config: trainingConfig
        };
    } catch (err) {
        return { error: `Failed to parse config: ${err.message}`, partial: true };
    }
}

// ── Troubleshooting Parser ───────────────────────────────────────────────────

/**
 * Parse TROUBLESHOOTING.md into structured patterns.
 * Each H3 (###) section becomes a troubleshooting entry with pattern, root cause,
 * diagnostic steps, and fix.
 */
function loadTroubleshooting() {
    const tsPath = resolve(PACKAGE_ROOT, 'docs/TROUBLESHOOTING.md');
    try {
        const content = readFileSync(tsPath, 'utf8');
        const patterns = [];

        // Split by ### headings (H3 = individual issues)
        const sections = content.split(/^### /gm).slice(1); // Skip content before first ###

        for (const section of sections) {
            const lines = section.split('\n');
            const pattern = lines[0].trim();

            let rootCause = '';
            const diagnosticSteps = [];
            let fix = '';

            let currentBlock = '';
            let inCodeBlock = false;
            let codeContent = '';

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];

                // Track code blocks
                if (line.startsWith('```')) {
                    if (inCodeBlock) {
                        inCodeBlock = false;
                        if (currentBlock === 'fix' || currentBlock === 'diagnostic') {
                            if (currentBlock === 'fix') {
                                fix += `${codeContent.trim()  }\n`;
                            } else {
                                diagnosticSteps.push(codeContent.trim());
                            }
                        }
                        codeContent = '';
                    } else {
                        inCodeBlock = true;
                    }
                    continue;
                }

                if (inCodeBlock) {
                    codeContent += `${line  }\n`;
                    continue;
                }

                // Detect section markers
                const lower = line.toLowerCase();
                if (lower.includes('**root cause') || lower.includes('**root cause:**') || lower.startsWith('**root cause')) {
                    currentBlock = 'root_cause';
                    const afterColon = line.replace(/\*\*[Rr]oot [Cc]ause:?\*\*:?\s*/, '').trim();
                    if (afterColon) rootCause = afterColon;
                    continue;
                }
                if (lower.includes('**fix') || lower.includes('**workaround')) {
                    currentBlock = 'fix';
                    const afterColon = line.replace(/\*\*[Ff]ix:?\*\*:?\s*|\*\*[Ww]orkaround:?\*\*:?\s*/, '').trim();
                    if (afterColon) fix = afterColon;
                    continue;
                }
                if (lower.includes('**symptoms') || lower.includes('**debug')) {
                    currentBlock = 'diagnostic';
                    continue;
                }

                // Accumulate content into current block
                if (currentBlock === 'root_cause' && line.trim()) {
                    rootCause += (rootCause ? ' ' : '') + line.trim().replace(/\*\*/g, '');
                } else if (currentBlock === 'fix' && line.trim()) {
                    fix += (fix ? ' ' : '') + line.trim().replace(/\*\*/g, '');
                } else if (currentBlock === 'diagnostic' && line.trim()) {
                    diagnosticSteps.push(line.trim().replace(/\*\*/g, ''));
                } else if (!currentBlock && line.trim() && !line.startsWith('#')) {
                    // Content before any explicit block — treat as root cause
                    rootCause += (rootCause ? ' ' : '') + line.trim().replace(/\*\*/g, '');
                }
            }

            // Only include entries that have meaningful content
            if (pattern && (rootCause || fix || diagnosticSteps.length > 0)) {
                patterns.push({
                    pattern: pattern.replace(/[`*]/g, ''),
                    root_cause: rootCause.trim() || 'See documentation',
                    diagnostic_steps: diagnosticSteps.length > 0 ? diagnosticSteps : ['Check logs for error details'],
                    fix: fix.trim() || 'See documentation'
                });
            }
        }

        return patterns;
    } catch (err) {
        return { error: `Failed to parse TROUBLESHOOTING.md: ${err.message}`, partial: true };
    }
}

// ── Capability Matrix Loader ─────────────────────────────────────────────────

/**
 * Load the capability matrix from src/agent/data/capability-matrix.json.
 * Returns full matrix or filtered by optional filter string.
 */
function loadCapabilityMatrix(filter) {
    const matrixPath = resolve(PACKAGE_ROOT, 'src/agent/data/capability-matrix.json');
    try {
        const content = readFileSync(matrixPath, 'utf8');
        const matrix = JSON.parse(content);

        if (!filter) return matrix;

        // Filter matrix entries by keyword match
        const filterLower = filter.toLowerCase();

        if (Array.isArray(matrix)) {
            return matrix.filter(entry => {
                const text = JSON.stringify(entry).toLowerCase();
                return text.includes(filterLower);
            });
        }

        // If matrix is an object with named categories, filter by key or values
        if (typeof matrix === 'object') {
            const filtered = {};
            for (const [key, value] of Object.entries(matrix)) {
                const keyMatch = key.toLowerCase().includes(filterLower);
                const valueMatch = JSON.stringify(value).toLowerCase().includes(filterLower);
                if (keyMatch || valueMatch) {
                    filtered[key] = value;
                }
            }
            return filtered;
        }

        return matrix;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { error: 'capability-matrix.json not found — run Task 3 to generate it', partial: true };
        }
        return { error: `Failed to load capability matrix: ${err.message}`, partial: true };
    }
}

// ── Tool Handler ─────────────────────────────────────────────────────────────

/**
 * Main tool handler for query_knowledge.
 */
async function handleQueryKnowledge({ topic, filter, context }) {
    log(`Query: topic=${topic}, filter=${filter || 'none'}`);

    let result;

    switch (topic) {
    case 'script_reference': {
        let scripts = getCached('script_reference', loadScriptReference);
        if (filter && Array.isArray(scripts)) {
            const filterLower = filter.toLowerCase();
            scripts = scripts.filter(s =>
                s.name.toLowerCase().includes(filterLower) ||
                    s.purpose.toLowerCase().includes(filterLower) ||
                    s.lifecycle_position.toLowerCase().includes(filterLower)
            );
        }
        result = scripts;
        break;
    }

    case 'config_reference': {
        result = getCached('config_reference', loadConfigReference);
        break;
    }

    case 'troubleshooting': {
        let patterns = getCached('troubleshooting', loadTroubleshooting);
        if (filter && Array.isArray(patterns)) {
            const filterLower = filter.toLowerCase();
            patterns = patterns.filter(p =>
                p.pattern.toLowerCase().includes(filterLower) ||
                    p.root_cause.toLowerCase().includes(filterLower) ||
                    p.fix.toLowerCase().includes(filterLower)
            );
        }
        result = patterns;
        break;
    }

    case 'capability_matrix': {
        // Load shipped matrix (cached) then merge local overrides fresh each call (AC-1.5)
        const cacheKey = `capability_matrix:${filter || ''}`;
        const shipped = getCached(cacheKey, () => loadCapabilityMatrix(filter || null));

        // Merge project-local overrides at query time
        const projectDir = resolveProjectDir(context);
        if (typeof shipped === 'object' && !Array.isArray(shipped) && !shipped.error) {
            result = loadWithOverridesObject(shipped, projectDir, 'capabilities.json');
        } else {
            result = shipped;
        }
        break;
    }

    case 'bootstrap_modules': {
        // Load module manifest and return module descriptions
        try {
            const manifestPath = resolve(PACKAGE_ROOT, 'infra/bootstrap-modules/module-manifest.json');
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            result = {
                modules: manifest.modules,
                note: 'Use `ml-container-creator bootstrap add <module>` to provision a module, or `bootstrap remove-module <module>` to tear down.'
            };
        } catch (err) {
            result = { error: `Failed to load module manifest: ${err.message}` };
        }
        break;
    }

    default:
        result = {
            error: `Unknown topic: "${topic}". Valid topics: script_reference, config_reference, troubleshooting, capability_matrix, bootstrap_modules`,
            partial: true
        };
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
        }]
    };
}

// ── MCP Server setup ─────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'agent-knowledge',
    version: '1.0.0'
});

server.tool(
    'query_knowledge',
    'Query project knowledge base. Returns structured data for script reference, config documentation, troubleshooting patterns, or capability matrix. Call this tool BEFORE answering questions about do/* scripts, configuration variables, or common issues.',
    {
        topic: z.enum(['script_reference', 'config_reference', 'troubleshooting', 'capability_matrix'])
            .describe('Knowledge topic to query'),
        filter: z.string().optional()
            .describe('Optional filter — narrows results by keyword match (e.g., script name, lifecycle stage, error pattern)'),
        context: z.object({
            projectDir: z.string().optional()
        }).optional().describe('Optional context with projectDir for local override resolution')
    },
    async (params) => {
        return handleQueryKnowledge(params);
    }
);

server.tool(
    'write_local_capability',
    'Add or update a capability status in the project-local override (.mlcc/capabilities.json). Use when the user has validated something locally that the shipped matrix doesn\'t reflect.',
    {
        capability: z.string().min(1).describe('Capability key (e.g., "vllm.realtime-inference.my-feature")'),
        status: z.enum(['green', 'yellow', 'red']).describe('Capability status'),
        message: z.string().optional().describe('Descriptive message about the capability'),
        alternatives: z.array(z.string()).optional().describe('Alternative capabilities or workarounds'),
        context: z.object({
            projectDir: z.string().optional()
        }).optional().describe('Optional context with projectDir')
    },
    async (params) => {
        const { capability, status, message, alternatives, context } = params;

        // Validate required fields
        if (!capability || !capability.trim()) {
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'capability is required and must be non-empty' }) }] };
        }
        if (!status) {
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'status is required (green, yellow, or red)' }) }] };
        }

        const projectDir = resolveProjectDir(context);
        const mlccDir = join(projectDir, '.mlcc');
        const overridePath = join(mlccDir, 'capabilities.json');
        const tmpPath = `${overridePath  }.tmp`;

        // Ensure .mlcc directory exists
        mkdirSync(mlccDir, { recursive: true });

        // Read existing or initialize
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

        // Build entry
        const entry = { status, source: 'local', addedAt: new Date().toISOString() };
        if (message) entry.message = message;
        if (alternatives) entry.alternatives = alternatives;

        // Upsert by capability key
        data.capabilities[capability] = entry;

        // Atomic write
        writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        renameSync(tmpPath, overridePath);

        // NFR-3 size check
        const result = { status: 'ok', entry: { capability, ...entry }, file: '.mlcc/capabilities.json' };
        const stat = statSync(overridePath);
        if (stat.size > 100 * 1024) {
            result.warning = 'Override file exceeds 100KB — consider upstreaming entries';
        }

        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
);

// ── Exports for testing ──────────────────────────────────────────────────────

export {
    handleQueryKnowledge,
    loadScriptReference,
    loadConfigReference,
    loadTroubleshooting,
    loadCapabilityMatrix,
    server,
    PACKAGE_ROOT
};

// ── Transport connection (main module only) ──────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;

if (isMain) {
    log('Starting agent-knowledge MCP server (stdio transport)');
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
