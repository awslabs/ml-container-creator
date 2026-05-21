#!/usr/bin/env node
/**
 * sync-command-generator.js — Three-layer sync for the Command Generator widget.
 *
 * Layer 1: Extract all config sources (CLI flags, server env vars, IC vars, adapter flags)
 * Layer 2: Generate docs/data/cli-manifest.json as the single source of truth
 * Layer 3: Validate widget coverage — every manifest entry is either rendered or explicitly excluded
 *
 * Usage:
 *   node scripts/sync-command-generator.js          # Sync docs/data/
 *   node scripts/sync-command-generator.js --check  # CI drift detection (exits non-zero on drift)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const CHECK_MODE = process.argv.includes('--check');
const DOCS_DATA = path.join(ROOT, 'docs', 'data');
const CATALOG_DIR = path.join(ROOT, 'servers', 'lib', 'catalogs');

const CATALOGS_TO_SYNC = [
    'model-servers.json',
    'model-sizes.json',
    'instances.json',
    'popular-transformers.json',
    'popular-diffusors.json'
];

// ============================================================
// LAYER 1: Source extraction
// ============================================================

/** Extract CLI options from bin/cli.js source */
function extractCliOptions() {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'cli.js'), 'utf8');
    const options = [];
    const re = /\.addOption\(new Option\('(--[\w-]+)(?:\s+<([^>]+)>)?',\s*'([^']+)'\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        options.push({ flag: m[1], argName: m[2] || null, description: m[3] });
    }
    return options;
}

/** Extract all env vars from model-servers catalog (defaults + profiles) */
function extractServerEnvVars() {
    const data = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'model-servers.json'), 'utf8'));
    const result = {};
    for (const [server, versions] of Object.entries(data)) {
        const vars = new Set();
        for (const v of versions) {
            if (v.defaults?.envVars) Object.keys(v.defaults.envVars).forEach(k => vars.add(k));
            if (v.profiles) {
                Object.values(v.profiles).forEach(p => {
                    if (p.envVars) Object.keys(p.envVars).forEach(k => vars.add(k));
                });
            }
        }
        result[server] = [...vars].sort();
    }
    return result;
}

/** Extract IC config variables from templates/do/ic/default.conf */
function extractIcVars() {
    const src = fs.readFileSync(path.join(ROOT, 'templates', 'do', 'ic', 'default.conf'), 'utf8');
    const vars = [];
    const re = /^export (IC_\w+)/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
        vars.push(m[1]);
    }
    // Also capture commented-out optional overrides
    const optRe = /^#\s*export (IC_\w+)/gm;
    while ((m = optRe.exec(src)) !== null) {
        if (!vars.includes(m[1])) vars.push(m[1]);
    }
    return [...new Set(vars)].sort();
}

/** Extract adapter subcommands and flags from templates/do/adapter */
function extractAdapterFlags() {
    const src = fs.readFileSync(path.join(ROOT, 'templates', 'do', 'adapter'), 'utf8');
    const subcommands = [];
    // Extract subcommands from usage section
    const subRe = /echo\s+"  (add|remove|list|update|search)\b([^"]*)/g;
    let m;
    while ((m = subRe.exec(src)) !== null) {
        const sub = m[1];
        if (!subcommands.find(s => s.name === sub)) {
            subcommands.push({ name: sub, flags: [] });
        }
    }
    // Extract flags per subcommand from usage lines
    const flagRe = /echo\s+"  (?:add|update|search)[^"]*?(--[\w-]+)(?:\s+<([^>]+)>)?/g;
    while ((m = flagRe.exec(src)) !== null) {
        const flag = m[1];
        const argName = m[2] || null;
        // Determine which subcommand this belongs to
        const line = src.substring(Math.max(0, m.index - 100), m.index + m[0].length);
        for (const sub of subcommands) {
            if (line.includes(sub.name) && !sub.flags.find(f => f.flag === flag)) {
                sub.flags.push({ flag, argName });
            }
        }
    }
    return subcommands;
}

/** Extract EXCLUDE_VARS per server from templates/code/serve */
function extractServeExcludeVars() {
    const src = fs.readFileSync(path.join(ROOT, 'templates', 'code', 'serve'), 'utf8');
    const result = {};
    // Match: EXCLUDE_VARS=("VAR1" "VAR2")
    const re = /EXCLUDE_VARS=\(([^)]*)\)/g;
    let m;
    // We need to associate each with the server context
    const sections = src.split(/<%.*?%>/);
    const serverRe = /modelServer === '(\w+)'/;

    // Simpler approach: find all EXCLUDE_VARS arrays and their preceding server condition
    const lines = src.split('\n');
    let currentServer = null;
    for (const line of lines) {
        const serverMatch = line.match(/modelServer === '(\w[\w-]*)'/);
        if (serverMatch) currentServer = serverMatch[1];
        const exMatch = line.match(/EXCLUDE_VARS=\(([^)]*)\)/);
        if (exMatch && currentServer) {
            const vars = exMatch[1].match(/"([^"]+)"/g)?.map(v => v.replace(/"/g, '')) || [];
            result[currentServer] = vars;
        }
    }
    return result;
}

/** Extract deployment configs from model-servers catalog */
function extractDeploymentConfigs() {
    const data = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'model-servers.json'), 'utf8'));
    const configMap = {
        'vllm': 'transformers-vllm',
        'sglang': 'transformers-sglang',
        'tensorrt-llm': 'transformers-tensorrt-llm',
        'lmi': 'transformers-lmi',
        'djl': 'transformers-djl',
        'vllm-omni': 'diffusors-vllm-omni'
    };
    const configs = [];
    for (const [key, versions] of Object.entries(data)) {
        if (!configMap[key]) continue;
        configs.push({
            id: configMap[key],
            serverKey: key,
            versions: versions.map(v => ({
                tag: v.tag,
                cuda: v.labels?.cuda_version || null,
                validationLevel: v.validationLevel || 'unknown',
                supportedModelTypes: v.supportedModelTypes || []
            }))
        });
    }
    configs.push({ id: 'http-flask', serverKey: 'flask', versions: [] });
    configs.push({ id: 'http-fastapi', serverKey: 'fastapi', versions: [] });
    return configs;
}

/** Extract GPU instances from catalog */
function extractGpuInstances() {
    const raw = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'instances.json'), 'utf8'));
    const catalog = raw.catalog || raw;
    const instances = {};
    for (const [name, info] of Object.entries(catalog)) {
        if (info.gpus > 0) {
            instances[name] = {
                gpus: info.gpus,
                gpuType: info.gpuType || info.hardware || null,
                gpuMemoryGb: info.gpuMemoryGb || null,
                vcpus: info.vcpus,
                memGb: info.memGb,
                family: info.family,
                costTier: info.costTier
            };
        }
    }
    return instances;
}

// ============================================================
// LAYER 2: Manifest generation
// ============================================================

function buildManifest() {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return {
        generatedAt: new Date().toISOString(),
        version: pkg.version,
        cliOptions: extractCliOptions(),
        deploymentConfigs: extractDeploymentConfigs(),
        gpuInstances: extractGpuInstances(),
        deploymentTargets: [
            { id: 'managed-inference', label: 'Managed Inference (Real-Time)' },
            { id: 'async-inference', label: 'Async Inference' },
            { id: 'batch-transform', label: 'Batch Transform' },
            { id: 'hyperpod-eks', label: 'HyperPod EKS' }
        ],
        serverEnvVars: extractServerEnvVars(),
        icVars: extractIcVars(),
        adapterCommands: extractAdapterFlags(),
        serveExcludeVars: extractServeExcludeVars()
    };
}

// ============================================================
// LAYER 3: Widget coverage validation
// ============================================================

/**
 * The widget declares coverage via docs/data/widget-coverage.json.
 * This file lists every manifest entry the widget handles, plus explicit exclusions.
 */
function validateCoverage(manifest) {
    const coveragePath = path.join(DOCS_DATA, 'widget-coverage.json');
    if (!fs.existsSync(coveragePath)) {
        console.error('❌ docs/data/widget-coverage.json does not exist.');
        console.error('   Run: node scripts/sync-command-generator.js (without --check) to generate it.');
        process.exit(1);
    }

    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    const errors = [];

    // Check CLI options coverage
    const coveredFlags = new Set([...(coverage.cliOptions?.covered || []), ...(coverage.cliOptions?.excluded || [])]);
    for (const opt of manifest.cliOptions) {
        if (!coveredFlags.has(opt.flag)) {
            errors.push(`CLI option ${opt.flag} is not covered by widget or explicitly excluded`);
        }
    }

    // Check server env vars coverage
    const coveredEnvVars = new Set([...(coverage.serverEnvVars?.covered || []), ...(coverage.serverEnvVars?.excluded || [])]);
    for (const vars of Object.values(manifest.serverEnvVars)) {
        for (const v of vars) {
            if (!coveredEnvVars.has(v)) {
                errors.push(`Server env var ${v} is not covered by widget or explicitly excluded`);
            }
        }
    }

    // Check IC vars coverage
    const coveredIcVars = new Set([...(coverage.icVars?.covered || []), ...(coverage.icVars?.excluded || [])]);
    for (const v of manifest.icVars) {
        if (!coveredIcVars.has(v)) {
            errors.push(`IC var ${v} is not covered by widget or explicitly excluded`);
        }
    }

    // Check adapter subcommands coverage
    const coveredAdapterCmds = new Set([...(coverage.adapterCommands?.covered || []), ...(coverage.adapterCommands?.excluded || [])]);
    for (const cmd of manifest.adapterCommands) {
        if (!coveredAdapterCmds.has(cmd.name)) {
            errors.push(`Adapter subcommand '${cmd.name}' is not covered by widget or explicitly excluded`);
        }
    }

    if (errors.length) {
        console.error(`❌ Widget coverage gaps (${errors.length}):`);
        errors.forEach(e => console.error(`   • ${e}`));
        process.exit(1);
    }

    console.log('✅ Widget coverage: all manifest entries are covered or explicitly excluded');
}

// ============================================================
// Drift detection (Layer 2 check)
// ============================================================

function checkDrift(manifest) {
    const manifestPath = path.join(DOCS_DATA, 'cli-manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('❌ docs/data/cli-manifest.json does not exist. Run: node scripts/sync-command-generator.js');
        process.exit(1);
    }

    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const errors = [];

    // CLI options count
    if (existing.cliOptions.length !== manifest.cliOptions.length) {
        const newOpts = manifest.cliOptions.filter(o => !existing.cliOptions.find(e => e.flag === o.flag)).map(o => o.flag);
        const removedOpts = existing.cliOptions.filter(o => !manifest.cliOptions.find(e => e.flag === o.flag)).map(o => o.flag);
        if (newOpts.length) errors.push(`New CLI options: ${newOpts.join(', ')}`);
        if (removedOpts.length) errors.push(`Removed CLI options: ${removedOpts.join(', ')}`);
    }

    // Deployment configs
    const existingConfigs = existing.deploymentConfigs.map(c => c.id).sort().join(',');
    const newConfigs = manifest.deploymentConfigs.map(c => c.id).sort().join(',');
    if (existingConfigs !== newConfigs) errors.push('Deployment configs changed');

    // Server versions
    for (const config of manifest.deploymentConfigs) {
        const ex = existing.deploymentConfigs.find(c => c.id === config.id);
        if (!ex) continue;
        const newTags = config.versions.map(v => v.tag).join(',');
        const exTags = ex.versions.map(v => v.tag).join(',');
        if (newTags !== exTags) errors.push(`Server versions for ${config.id}: [${exTags}] → [${newTags}]`);
    }

    // Server env vars
    const existingEnvCount = Object.values(existing.serverEnvVars || {}).flat().length;
    const newEnvCount = Object.values(manifest.serverEnvVars || {}).flat().length;
    if (existingEnvCount !== newEnvCount) {
        const allExisting = new Set(Object.values(existing.serverEnvVars || {}).flat());
        const allNew = new Set(Object.values(manifest.serverEnvVars || {}).flat());
        const added = [...allNew].filter(v => !allExisting.has(v));
        const removed = [...allExisting].filter(v => !allNew.has(v));
        if (added.length) errors.push(`New server env vars: ${added.join(', ')}`);
        if (removed.length) errors.push(`Removed server env vars: ${removed.join(', ')}`);
    }

    // IC vars
    const existingIc = (existing.icVars || []).join(',');
    const newIc = (manifest.icVars || []).join(',');
    if (existingIc !== newIc) errors.push(`IC vars changed: [${existingIc}] → [${newIc}]`);

    // Instance count
    const exInstCount = Object.keys(existing.gpuInstances || {}).length;
    const newInstCount = Object.keys(manifest.gpuInstances || {}).length;
    if (exInstCount !== newInstCount) errors.push(`GPU instances: ${exInstCount} → ${newInstCount}`);

    if (errors.length) {
        console.error(`❌ Command generator drift detected (${errors.length} issues):`);
        errors.forEach(e => console.error(`   • ${e}`));
        console.error('\n   Fix: run `node scripts/sync-command-generator.js` and commit docs/data/');
        process.exit(1);
    }

    console.log('✅ Manifest is in sync with CLI and catalogs');
}

// ============================================================
// Write operations
// ============================================================

function syncCatalogs() {
    fs.mkdirSync(DOCS_DATA, { recursive: true });
    for (const file of CATALOGS_TO_SYNC) {
        fs.copyFileSync(path.join(CATALOG_DIR, file), path.join(DOCS_DATA, file));
    }
}

function writeManifest(manifest) {
    fs.writeFileSync(path.join(DOCS_DATA, 'cli-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

/** Generate initial widget-coverage.json if it doesn't exist */
function generateCoverageFile(manifest) {
    const coveragePath = path.join(DOCS_DATA, 'widget-coverage.json');
    if (fs.existsSync(coveragePath)) return; // Don't overwrite existing

    // Auto-generate with all items as "excluded" with reason "not yet implemented"
    // Developer moves items from excluded → covered as they wire them into the widget
    const coverage = {
        _comment: 'Widget coverage declaration. Move items from excluded to covered as you wire them into the widget UI.',
        cliOptions: {
            covered: [],
            excluded: manifest.cliOptions.map(o => o.flag),
            _excludedReason: 'Initial generation — move to covered as widget implements each option'
        },
        serverEnvVars: {
            covered: [],
            excluded: [...new Set(Object.values(manifest.serverEnvVars).flat())].sort(),
            _excludedReason: 'Initial generation — move to covered as widget implements each var'
        },
        icVars: {
            covered: [],
            excluded: manifest.icVars,
            _excludedReason: 'Initial generation — move to covered as widget implements each var'
        },
        adapterCommands: {
            covered: [],
            excluded: manifest.adapterCommands.map(c => c.name),
            _excludedReason: 'Initial generation — move to covered as widget implements each command'
        }
    };
    fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2) + '\n');
}

// ============================================================
// Main
// ============================================================

const manifest = buildManifest();

if (CHECK_MODE) {
    checkDrift(manifest);
    validateCoverage(manifest);
} else {
    syncCatalogs();
    writeManifest(manifest);
    generateCoverageFile(manifest);
    console.log(`✅ Synced to docs/data/:`);
    console.log(`   Catalogs: ${CATALOGS_TO_SYNC.length} files`);
    console.log(`   CLI options: ${manifest.cliOptions.length}`);
    console.log(`   Deployment configs: ${manifest.deploymentConfigs.length}`);
    console.log(`   GPU instances: ${Object.keys(manifest.gpuInstances).length}`);
    console.log(`   Server env vars: ${Object.values(manifest.serverEnvVars).flat().length} across ${Object.keys(manifest.serverEnvVars).length} servers`);
    console.log(`   IC vars: ${manifest.icVars.length}`);
    console.log(`   Adapter commands: ${manifest.adapterCommands.length}`);
}
