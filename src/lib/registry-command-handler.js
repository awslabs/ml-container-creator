// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Command Handler
 *
 * Handles the `registry` CLI subcommand tree for managing
 * deployment entries in the deployment registry.
 *
 * Subcommands:
 *   log                                 Internal: called by do/register
 *   list [--backend, --architecture, --model, --instance-type, --status]
 *   get <id>                            Show full entry details
 *   remove <id>                         Remove an entry
 *   replay <id> [overrides]             Replay a deployment
 *   export [id] [--status]              Export entries as JSON
 *   import <file> [--merge|--replace]   Import entries from JSON
 *   search [--model, --architecture, --backend, --instance-type]
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import DeploymentRegistry, { reconstructReplayFlags } from './deployment-registry.js';
import { syncArchitectures } from './architecture-sync.js';
import HuggingFaceClient from './huggingface-client.js';

const PERSONAL_REGISTRY_PATH = path.join(os.homedir(), '.ml-container-creator', 'registry.json');
const PROJECT_REGISTRY_PATH = path.join(process.cwd(), '.ml-container-creator', 'registry.json');

export default class RegistryCommandHandler {
    constructor() {
        // No external dependencies required
    }

    /**
     * Dispatch registry subcommands.
     * @param {string[]} args - Remaining positional args after 'registry'
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options) {
        if (args.length === 0) {
            this._showRegistryHelp();
            return;
        }

        const subcommand = args[0].toLowerCase();

        switch (subcommand) {
        case 'log':
            await this._handleLog(options);
            break;
        case 'list':
            this._handleList(options);
            break;
        case 'get':
            this._handleGet(args[1]);
            break;
        case 'remove':
            this._handleRemove(args[1]);
            break;
        case 'replay':
            await this._handleReplay(args[1], options);
            break;
        case 'export':
            this._handleExport(args[1], options);
            break;
        case 'import':
            await this._handleImport(args[1], options);
            break;
        case 'search':
            this._handleSearch(options);
            break;
        case 'sync-architectures':
            await this._handleSyncArchitectures();
            break;
        case 'list-architectures':
            this._handleListArchitectures(args, options);
            break;
        case 'check':
            await this._handleCheck(args);
            break;
        default:
            console.log(`Unknown registry subcommand: ${subcommand}`);
            this._showRegistryHelp();
            break;
        }
    }

    /**
     * Internal: log a deployment entry (called by do/register).
     *
     * Parses CLI flags into a Deployment_Entry structure and adds it
     * to the appropriate registry (personal or project-level).
     *
     * @param {object} options - Parsed CLI options from do/register
     */
    async _handleLog(options) {
        const registryPath = options.project ? PROJECT_REGISTRY_PATH : PERSONAL_REGISTRY_PATH;
        const registry = new DeploymentRegistry(registryPath);

        const deploymentConfig = options.deploymentConfig || options['deployment-config'] || '';
        const architecture = options.architecture || '';
        const backend = options.backend || '';

        const entry = {
            timestamp: new Date().toISOString(),
            status: options.status || 'success',
            deployment: {
                deploymentConfig,
                architecture,
                backend,
                baseImage: options.baseImage || options['base-image'] || null,
                deploymentTarget: options.deploymentTarget || options['deployment-target'] || null,
                buildTarget: options.buildTarget || options['build-target'] || null
            },
            model: {
                modelName: options.modelName || options['model-name'] || null,
                modelFormat: options.modelFormat || options['model-format'] || null
            },
            infrastructure: {
                instanceType: options.instanceType || options['instance-type'] || null,
                region: options.region || null,
                roleArn: options.roleArn || options['role-arn'] || null
            },
            configuration: {
                parameters: {}
            },
            outcome: {
                notes: options.notes || null
            },
            metadata: {
                generatorVersion: options.generatorVersion || options['generator-version'] || 'unknown',
                source: 'local',
                importedFrom: null
            }
        };

        // Parse parameters from JSON string if provided
        if (options.parameters) {
            try {
                entry.configuration.parameters = typeof options.parameters === 'string'
                    ? JSON.parse(options.parameters)
                    : options.parameters;
            } catch (err) {
                console.log(`Warning: Could not parse parameters JSON: ${err.message}`);
                entry.configuration.parameters = {};
            }
        }

        // Parse icList from JSON string if provided
        const icListRaw = options.icList || options['ic-list'];
        if (icListRaw) {
            try {
                entry.deployment.icList = typeof icListRaw === 'string'
                    ? JSON.parse(icListRaw)
                    : icListRaw;
            } catch (err) {
                console.log(`Warning: Could not parse ic-list JSON: ${err.message}`);
            }
        }

        try {
            const id = registry.add(entry);
            console.log('✅ Deployment entry logged successfully.');
            console.log(`   Entry ID: ${id}`);
            console.log(`   View details: ml-container-creator registry get ${id}`);
        } catch (err) {
            console.log(`Error logging deployment entry: ${err.message}`);
        }
    }

    /**
     * registry list [--backend, --architecture, --model, --instance-type, --status]
     *
     * Displays entries from both personal and project-level registries.
     * Supports filtering by backend, architecture, model, instance-type, and status.
     *
     * @param {object} options - Parsed CLI options
     */
    _handleList(options) {
        const filters = this._extractFilters(options);

        const personalRegistry = new DeploymentRegistry(PERSONAL_REGISTRY_PATH);
        const projectRegistry = new DeploymentRegistry(PROJECT_REGISTRY_PATH);

        const personalEntries = personalRegistry.list(filters).map(e => ({ ...e, _source: 'personal' }));
        const projectEntries = projectRegistry.list(filters).map(e => ({ ...e, _source: 'project' }));

        const allEntries = [...personalEntries, ...projectEntries];

        if (allEntries.length === 0) {
            console.log('No deployment entries found.');
            console.log('Use "./do/register" after a successful deployment to add an entry.');
            return;
        }

        console.log('\nDeployment Registry Entries:\n');
        for (const entry of allEntries) {
            const id = entry.id || '(no id)';
            const ts = entry.timestamp ? entry.timestamp.slice(0, 19) : '(no timestamp)';
            const dc = entry.deployment?.deploymentConfig || '(none)';
            const mn = entry.model?.modelName || '(none)';
            const it = entry.infrastructure?.instanceType || '(none)';
            const st = entry.status || '(none)';
            const src = entry._source === 'project' ? ' [project]' : '';
            console.log(`  ${id}  ${ts}  ${dc}  ${mn}  ${it}  ${st}${src}`);
        }
        console.log('');
    }

    /**
     * registry get <id>
     *
     * Displays the full entry as formatted JSON.
     *
     * @param {string} id - Entry ID
     */
    _handleGet(id) {
        if (!id) {
            console.log('Usage: ml-container-creator registry get <id>');
            return;
        }

        const entry = this._findEntry(id);

        if (!entry) {
            console.log(`Error: Entry "${id}" not found.`);
            return;
        }

        console.log(`\nDeployment Entry: ${id}\n`);
        console.log(JSON.stringify(entry, null, 2));
        console.log('');
    }

    /**
     * registry remove <id>
     *
     * Removes an entry from the registry.
     *
     * @param {string} id - Entry ID
     */
    _handleRemove(id) {
        if (!id) {
            console.log('Usage: ml-container-creator registry remove <id>');
            return;
        }

        const personalRegistry = new DeploymentRegistry(PERSONAL_REGISTRY_PATH);
        if (personalRegistry.remove(id)) {
            console.log(`✅ Entry "${id}" removed from personal registry.`);
            return;
        }

        const projectRegistry = new DeploymentRegistry(PROJECT_REGISTRY_PATH);
        if (projectRegistry.remove(id)) {
            console.log(`✅ Entry "${id}" removed from project registry.`);
            return;
        }

        console.log(`Error: Entry "${id}" not found.`);
    }

    /**
     * registry replay <id> [overrides]
     *
     * Looks up an entry, reconstructs CLI flags, applies overrides,
     * and invokes the generator with the reconstructed flags.
     *
     * @param {string} id - Entry ID
     * @param {object} options - Parsed CLI options (overrides)
     */
    async _handleReplay(id, options) {
        if (!id) {
            console.log('Usage: ml-container-creator registry replay <id> [--model-name <name>] [--instance-type <type>] ...');
            return;
        }

        const entry = this._findEntry(id);

        if (!entry) {
            console.log(`Error: Entry "${id}" not found.`);
            return;
        }

        // Build overrides from user-provided CLI options
        const overrides = {};
        const overrideMap = {
            'deployment-config': '--deployment-config',
            'deploymentConfig': '--deployment-config',
            'model-name': '--model-name',
            'modelName': '--model-name',
            'instance-type': '--instance-type',
            'instanceType': '--instance-type',
            'region': '--region',
            'model-format': '--model-format',
            'modelFormat': '--model-format'
        };

        for (const [optKey, flagKey] of Object.entries(overrideMap)) {
            if (options[optKey] !== null && options[optKey] !== undefined) {
                overrides[flagKey] = options[optKey];
            }
        }

        const flags = reconstructReplayFlags(entry, overrides);

        console.log(`\nReplaying deployment entry: ${id}`);
        console.log(`  Deployment config: ${flags['--deployment-config'] || '(will prompt)'}`);
        console.log(`  Model name: ${flags['--model-name'] || '(will prompt)'}`);
        console.log(`  Instance type: ${flags['--instance-type'] || '(will prompt)'}`);
        console.log(`  Region: ${flags['--region'] || '(will prompt)'}`);
        console.log('');

        const flagArgs = [];
        for (const [flag, value] of Object.entries(flags)) {
            flagArgs.push(flag, value);
        }

        // Resolve the CLI script path relative to this module
        const __filename = fileURLToPath(import.meta.url);
        const cliPath = path.resolve(path.dirname(__filename), '../../bin/cli.js');

        try {
            execSync(`ml-container-creator ${flagArgs.join(' ')}`, { stdio: 'inherit' });
        } catch {
            // Fallback: invoke via node + script path if binary is not on PATH
            execSync(`${process.execPath} ${cliPath} ${flagArgs.join(' ')}`, { stdio: 'inherit' });
        }
    }

    /**
     * registry export [id] [--status]
     *
     * Exports entries as JSON to stdout.
     *
     * @param {string} [id] - Optional entry ID to export a single entry
     * @param {object} options - Parsed CLI options
     */
    _handleExport(id, options) {
        const registryPath = options.project ? PROJECT_REGISTRY_PATH : PERSONAL_REGISTRY_PATH;
        const registry = new DeploymentRegistry(registryPath);

        const exportOptions = {};
        if (options.status) {
            exportOptions.status = options.status;
        }

        const result = registry.exportEntries(id || null, exportOptions);

        if (result.entries.length === 0) {
            console.log('No entries to export.');
            return;
        }

        console.log(JSON.stringify(result, null, 2));
    }

    /**
     * registry import <file> [--merge|--replace]
     *
     * Reads a JSON file, validates it, and imports entries into the registry.
     *
     * @param {string} filePath - Path to the import file
     * @param {object} options - Parsed CLI options
     */
    async _handleImport(filePath, options) {
        if (!filePath) {
            console.log('Usage: ml-container-creator registry import <file> [--merge|--replace]');
            return;
        }

        let raw;
        try {
            raw = readFileSync(filePath, 'utf8');
        } catch (err) {
            console.log(`Error: File not found: ${filePath}`);
            return;
        }

        let json;
        try {
            json = JSON.parse(raw);
        } catch (err) {
            console.log(`Error: Invalid JSON in ${filePath}: ${err.message}`);
            return;
        }

        if (!json.version || !Array.isArray(json.entries)) {
            console.log('Error: Invalid export format — missing required "version" or "entries" fields.');
            return;
        }

        let strategy = 'skip';
        if (options.merge) {
            strategy = 'merge';
        } else if (options.replace) {
            strategy = 'replace';
        }

        const registryPath = options.project ? PROJECT_REGISTRY_PATH : PERSONAL_REGISTRY_PATH;
        const registry = new DeploymentRegistry(registryPath);

        try {
            const result = registry.importEntries(json, strategy, path.basename(filePath));
            console.log('\nImport complete:');
            console.log(`  Added:     ${result.added}`);
            console.log(`  Skipped:   ${result.skipped}`);
            console.log(`  Conflicts: ${result.conflicts}`);
            console.log('');
        } catch (err) {
            console.log(`Error importing entries: ${err.message}`);
        }
    }

    /**
     * registry search [--model, --architecture, --backend, --instance-type, --status]
     *
     * Searches across both personal and project-level registries.
     * Uses glob matching for model names.
     *
     * @param {object} options - Parsed CLI options
     */
    _handleSearch(options) {
        const query = this._extractFilters(options);

        const personalRegistry = new DeploymentRegistry(PERSONAL_REGISTRY_PATH);
        const projectRegistry = new DeploymentRegistry(PROJECT_REGISTRY_PATH);

        const personalResults = personalRegistry.search(query).map(e => ({ ...e, _source: 'personal' }));
        const projectResults = projectRegistry.search(query).map(e => ({ ...e, _source: 'project' }));

        const allResults = [...personalResults, ...projectResults];

        if (allResults.length === 0) {
            console.log('No matching entries found.');
            return;
        }

        console.log(`\nSearch Results (${allResults.length} match${allResults.length === 1 ? '' : 'es'}):\n`);
        for (const entry of allResults) {
            const id = entry.id || '(no id)';
            const ts = entry.timestamp ? entry.timestamp.slice(0, 19) : '(no timestamp)';
            const dc = entry.deployment?.deploymentConfig || '(none)';
            const mn = entry.model?.modelName || '(none)';
            const it = entry.infrastructure?.instanceType || '(none)';
            const st = entry.status || '(none)';
            const src = entry._source === 'project' ? ' [project]' : '';
            console.log(`  ${id}  ${ts}  ${dc}  ${mn}  ${it}  ${st}${src}`);
        }
        console.log('');
    }

    /**
     * registry sync-architectures
     *
     * Fetches model registry source files from server GitHub repositories
     * and populates supportedModelTypes in the model-servers catalog.
     */
    async _handleSyncArchitectures() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const catalogPath = path.resolve(__dirname, '../../servers/lib/catalogs/model-servers.json');

        console.log('\n📋 Syncing model architecture registry...\n');

        const summary = await syncArchitectures(catalogPath);

        console.log('\n── Summary ──────────────────────────────────────');
        if (summary.servers.length > 0) {
            console.log('\n   Architectures synced:');
            for (const { server, version, count } of summary.servers) {
                console.log(`     ${server} ${version}: ${count} architectures`);
            }
        }
        if (summary.failures.length > 0) {
            console.log('\n   Failures:');
            for (const { server, version, reason } of summary.failures) {
                console.log(`     ${server} ${version}: ${reason}`);
            }
        }
        if (summary.servers.length === 0 && summary.failures.length === 0) {
            console.log('\n   No server entries found with matching registry sources.');
        }
        console.log('');
    }

    /**
     * registry list-architectures [--server <name>] [--verbose]
     *
     * Displays a table of server versions and their supported architecture counts.
     * With --server or --verbose, shows the full list of supported model types.
     *
     * @param {object} options - Parsed CLI options
     */
    _handleListArchitectures(args, options) {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const catalogPath = path.resolve(__dirname, '../../servers/lib/catalogs/model-servers.json');

        let catalog;
        try {
            catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        } catch (err) {
            console.log(`Error: Could not read model-servers catalog: ${err.message}`);
            return;
        }

        // Parse --server and --verbose from pass-through args (Commander's passThroughOptions
        // puts options after the subcommand into the args array)
        let serverFilter = options.server || null;
        let verbose = options.verbose || false;
        for (const arg of args) {
            if (arg.startsWith('--server=')) {
                serverFilter = arg.split('=')[1];
            } else if (arg === '--server' && args.indexOf(arg) + 1 < args.length) {
                serverFilter = args[args.indexOf(arg) + 1];
            } else if (arg === '--verbose') {
                verbose = true;
            }
        }

        // Collect rows: { server, version, count, types }
        const rows = [];
        for (const [server, entries] of Object.entries(catalog)) {
            if (serverFilter && server !== serverFilter) continue;
            for (const entry of entries) {
                const version = entry.labels?.framework_version || '(unknown)';
                const types = entry.supportedModelTypes || [];
                rows.push({ server, version, count: types.length, types });
            }
        }

        if (rows.length === 0) {
            if (serverFilter) {
                console.log(`No entries found for server "${serverFilter}".`);
            } else {
                console.log('No server entries found in catalog.');
            }
            return;
        }

        // Display summary table
        console.log('\nModel Architecture Support:\n');
        console.log('  Server                Version      Architectures');
        console.log('  ────────────────────  ───────────  ─────────────');
        for (const row of rows) {
            const srv = row.server.padEnd(20);
            const ver = row.version.padEnd(11);
            const cnt = row.count === 0 ? '(not synced)' : String(row.count);
            console.log(`  ${srv}  ${ver}  ${cnt}`);
        }
        console.log('');

        // Show full list when --server or --verbose is set
        if (serverFilter || verbose) {
            for (const row of rows) {
                if (row.types.length === 0) continue;
                console.log(`  ${row.server} ${row.version} supported model types:`);
                console.log(`    ${row.types.join(', ')}`);
                console.log('');
            }
        }
    }

    /**
     * registry check <model-id>
     *
     * Fetches a model's config.json from HuggingFace, extracts the model_type,
     * and checks compatibility against all server versions in the catalog.
     *
     * @param {string[]} args - Remaining positional args (args[1] = model-id)
     */
    async _handleCheck(args) {
        const modelId = args[1];

        if (!modelId) {
            console.log('Usage: ml-container-creator registry check <model-id>');
            console.log('Example: ml-container-creator registry check meta-llama/Llama-2-7b-chat-hf');
            return;
        }

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const catalogPath = path.resolve(__dirname, '../../servers/lib/catalogs/model-servers.json');

        // Fetch model's config.json from HuggingFace
        console.log(`\n🔍 Checking model: ${modelId}\n`);
        console.log('   Fetching model config from HuggingFace...');

        const hfClient = new HuggingFaceClient({ timeout: 10000 });
        const config = await hfClient.fetchModelConfig(modelId);

        if (!config) {
            console.log(`\n   ❌ Could not fetch config.json for "${modelId}".`);
            console.log('      Verify the model ID is correct and accessible on HuggingFace.');
            return;
        }

        const modelType = config.model_type;
        if (!modelType) {
            console.log(`\n   ❌ No "model_type" field found in config.json for "${modelId}".`);
            return;
        }

        console.log(`   Model type: ${modelType}`);

        // Load model-servers catalog
        let catalog;
        try {
            catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        } catch (err) {
            console.log(`\n   ❌ Could not read model-servers catalog: ${err.message}`);
            return;
        }

        // Check model_type against all server entries
        const compatible = [];
        const incompatible = [];
        let hasAnyData = false;

        for (const [server, entries] of Object.entries(catalog)) {
            for (const entry of entries) {
                const version = entry.labels?.framework_version || '(unknown)';
                const supported = entry.supportedModelTypes;

                if (!supported || supported.length === 0) continue;

                hasAnyData = true;
                const modelTypeLower = modelType.toLowerCase();
                if (supported.includes(modelTypeLower) || supported.includes(modelType)) {
                    compatible.push({ server, version });
                } else {
                    incompatible.push({ server, version });
                }
            }
        }

        // Display results
        if (!hasAnyData) {
            console.log('\n   ⚠️  No architecture data available. Run "registry sync-architectures" first.');
            return;
        }

        if (compatible.length > 0) {
            console.log('\n   ✅ Compatible server versions:');
            for (const { server, version } of compatible) {
                console.log(`      • ${server} ${version}`);
            }
        }

        if (incompatible.length > 0) {
            console.log('\n   ⚠️  Potentially incompatible server versions:');
            for (const { server, version } of incompatible) {
                console.log(`      • ${server} ${version}`);
            }
        }

        if (compatible.length === 0) {
            console.log(`\n   ⚠️  Model architecture "${modelType}" was not found in any server's supported types.`);
            console.log('      This may indicate the model requires a newer server version,');
            console.log('      or it may work via trust_remote_code. Check server documentation for details.');
        }

        console.log('');
    }

    /**
     * Show registry usage help.
     */
    _showRegistryHelp() {
        console.log(`
Deployment Registry Management

USAGE:
  ml-container-creator registry <subcommand> [options]

SUBCOMMANDS:
  list                                List deployment entries
  get <id>                            Show full entry details
  remove <id>                         Remove an entry
  replay <id> [overrides]             Replay a deployment configuration
  export [id] [--status <status>]     Export entries as JSON
  import <file> [--merge|--replace]   Import entries from JSON
  search [filters]                    Search entries with glob matching
  sync-architectures                  Sync supported model types from server repos
  list-architectures                  Show supported architectures per server version
  check <model-id>                    Check model compatibility with server versions

FILTER OPTIONS (for list and search):
  --backend <backend>                 Filter by backend (e.g., vllm, flask)
  --architecture <arch>               Filter by architecture (e.g., transformers, http)
  --model <name>                      Filter by model name (search supports glob patterns)
  --instance-type <type>              Filter by instance type
  --status <status>                   Filter by status (success, partial, failed)

REPLAY OPTIONS:
  --deployment-config <config>        Override deployment config
  --model-name <name>                 Override model name
  --instance-type <type>              Override instance type
  --region <region>                   Override region

IMPORT OPTIONS:
  --merge                             Keep both existing and imported on conflict
  --replace                           Overwrite existing with imported on conflict

LIST-ARCHITECTURES OPTIONS:
  --server <name>                     Show full model type list for a specific server
  --verbose                           Show full model type list for all servers

OTHER OPTIONS:
  --project                           Use project-level registry instead of personal

EXAMPLES:
  ml-container-creator registry list
  ml-container-creator registry list --backend vllm --status success
  ml-container-creator registry get a1b2c3d4
  ml-container-creator registry remove a1b2c3d4
  ml-container-creator registry replay a1b2c3d4
  ml-container-creator registry replay a1b2c3d4 --instance-type ml.g5.2xlarge
  ml-container-creator registry export > my-deployments.json
  ml-container-creator registry export a1b2c3d4
  ml-container-creator registry import team-deployments.json --merge
  ml-container-creator registry search --model "meta-llama/*" --backend vllm
  ml-container-creator registry list-architectures
  ml-container-creator registry list-architectures --server vllm
  ml-container-creator registry list-architectures --verbose
  ml-container-creator registry check meta-llama/Llama-2-7b-chat-hf
`);
    }

    // ── Helper methods ──────────────────────────────────────────────

    /**
     * Extract filter options from CLI options into a filters object.
     * @param {object} options - Parsed CLI options
     * @returns {object} Filter key-value pairs
     */
    _extractFilters(options) {
        const filters = {};
        if (options.backend) filters.backend = options.backend;
        if (options.architecture) filters.architecture = options.architecture;
        if (options.model) filters.model = options.model;
        if (options['instance-type'] || options.instanceType) {
            filters['instance-type'] = options['instance-type'] || options.instanceType;
        }
        if (options.status) filters.status = options.status;
        return filters;
    }

    /**
     * Find an entry by ID across both personal and project registries.
     * @param {string} id - Entry ID
     * @returns {object|null} The matching entry, or null
     */
    _findEntry(id) {
        const personalRegistry = new DeploymentRegistry(PERSONAL_REGISTRY_PATH);
        const entry = personalRegistry.get(id);
        if (entry) return entry;

        const projectRegistry = new DeploymentRegistry(PROJECT_REGISTRY_PATH);
        return projectRegistry.get(id);
    }
}
