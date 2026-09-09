// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture Command Handler
 *
 * Handles model-architecture registry operations. Extracted from the former
 * `registry` command handler (BL078) so that the deployment-history registry
 * could be removed without losing this live functionality.
 *
 * These operations read/write the model-servers catalog (supportedModelTypes)
 * and query HuggingFace — they have NO dependency on the removed deployment
 * flat-file registry.
 *
 * Subcommands:
 *   sync-architectures                  Sync supported model types from server repos
 *   list-architectures [--server, --verbose]
 *   check <model-id>                    Check a model's architecture compatibility
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syncArchitectures } from './architecture-sync.js';
import HuggingFaceClient from './huggingface-client.js';

export default class ArchitectureCommandHandler {
    constructor() {
        // No external dependencies required
    }

    /**
     * Dispatch architecture subcommands.
     * @param {string[]} args - Positional args; args[0] is the subcommand
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options = {}) {
        if (!args || args.length === 0) {
            this._showHelp();
            return;
        }

        const subcommand = args[0].toLowerCase();

        switch (subcommand) {
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
            console.log(`Unknown architecture subcommand: ${subcommand}`);
            this._showHelp();
            break;
        }
    }

    /**
     * sync-architectures
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
     * list-architectures [--server <name>] [--verbose]
     *
     * Displays a table of server versions and their supported architecture counts.
     * With --server or --verbose, shows the full list of supported model types.
     *
     * @param {string[]} args - Positional args (may carry pass-through flags)
     * @param {object} options - Parsed CLI options
     */
    _handleListArchitectures(args, options = {}) {
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
     * check <model-id>
     *
     * Fetches a model's config.json from HuggingFace, extracts the model_type,
     * and checks compatibility against all server versions in the catalog.
     *
     * @param {string[]} args - Positional args (args[1] = model-id)
     */
    async _handleCheck(args) {
        const modelId = args[1];

        if (!modelId) {
            console.log('Usage: ml-container-creator architecture check <model-id>');
            console.log('Example: ml-container-creator architecture check meta-llama/Llama-2-7b-chat-hf');
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
            console.log('\n   ⚠️  No architecture data available. Run "architecture sync-architectures" first.');
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
     * Show architecture usage help.
     */
    _showHelp() {
        console.log(`
Model Architecture Registry

USAGE:
  ml-container-creator architecture <subcommand> [options]

SUBCOMMANDS:
  sync-architectures                  Sync supported model types from server repos
  list-architectures [--server <name>] [--verbose]
                                      Show supported architectures per server version
  check <model-id>                    Check a model's architecture compatibility
`);
    }
}
