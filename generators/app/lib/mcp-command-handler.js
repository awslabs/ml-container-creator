// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Command Handler
 *
 * Handles the `mcp` CLI subcommand tree for managing MCP server
 * configurations in config/mcp.json.
 *
 * Subcommands:
 *   add <name> -- <command> [args...]   Add or update an MCP server
 *   list                                List configured MCP servers
 *   get <name>                          Show full server configuration
 *   remove <name>                       Remove an MCP server
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const CONFIG_FILENAME = 'config/mcp.json';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVERS_DIR = path.resolve(__dirname, '../../../servers');

export default class McpCommandHandler {
    constructor(generator) {
        this.generator = generator;
    }

    /**
     * Dispatch mcp subcommands.
     * @param {string[]} args - Remaining positional args after 'mcp'
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options) {
        if (args.length === 0) {
            this._showMcpHelp();
            return;
        }

        const subcommand = args[0].toLowerCase();

        switch (subcommand) {
        case 'add':
            await this._handleAdd(args.slice(1), options);
            break;
        case 'init':
            await this._handleInit();
            break;
        case 'list':
            this._handleList(options);
            break;
        case 'get':
            this._handleGet(args[1]);
            break;
        case 'remove':
            await this._handleRemove(args[1]);
            break;
        default:
            console.log(`Unknown mcp subcommand: ${subcommand}`);
            this._showMcpHelp();
            break;
        }
    }

    /**
     * mcp add <name> -- <command> [args...]
     * Supports: -e KEY=VALUE, --tool-name <toolName>, --limit <num>
     * @param {string[]} positionalArgs - Args after 'add'
     * @param {object} options - Parsed CLI options
     */
    async _handleAdd(positionalArgs, options) {
        if (positionalArgs.length === 0) {
            console.log('Usage: yo ml-container-creator mcp add <name> -- <command> [args...]');
            return;
        }

        const name = positionalArgs[0];
        const isBundled = options.bundled === true || options.bundled === 'true';

        let command, commandArgs;

        if (isBundled) {
            // Resolve bundled server
            const resolved = this._resolveBundledServer(name);
            if (!resolved) return;

            // Lazy dependency installation
            const installed = await this._installBundledDependencies(resolved.serverDir, name);
            if (!installed) return;

            command = 'node';
            commandArgs = [resolved.entryPoint];
        } else {
            // Find the '--' separator to split name from command
            const separatorIndex = positionalArgs.indexOf('--');
            if (separatorIndex === -1 || separatorIndex + 1 >= positionalArgs.length) {
                console.log('Usage: yo ml-container-creator mcp add <name> -- <command> [args...]');
                console.log('The "--" separator is required between the server name and the command.');
                return;
            }

            const commandParts = positionalArgs.slice(separatorIndex + 1);
            command = commandParts[0];
            commandArgs = commandParts.slice(1);
        }

        // Build server config
        const serverConfig = { command };
        if (commandArgs.length > 0) {
            serverConfig.args = commandArgs;
        }

        // Parse -e KEY=VALUE env flags
        const env = this._parseEnvFlags(options);
        if (Object.keys(env).length > 0) {
            serverConfig.env = env;
        }

        // Parse --tool-name
        const toolName = options['tool-name'] || options.toolName;
        if (toolName) {
            serverConfig.toolName = toolName;
        }

        // Parse --limit
        const limit = options.limit;
        if (limit !== undefined) {
            const parsed = parseInt(limit, 10);
            if (isNaN(parsed) || parsed < 1) {
                console.log('Error: --limit must be a positive integer');
                return;
            }
            serverConfig.limit = parsed;
        }

        // Read existing config
        const config = this._readConfig();

        // Check if server already exists
        if (config.mcpServers && config.mcpServers[name]) {
            const answers = await this.generator.prompt([{
                type: 'confirm',
                name: 'overwrite',
                message: `MCP server "${name}" already exists. Overwrite?`,
                default: false
            }]);
            if (!answers.overwrite) {
                console.log('Aborted.');
                return;
            }
        }

        // Add server
        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        config.mcpServers[name] = serverConfig;

        this._writeConfig(config);
        console.log(`✅ MCP server "${name}" added successfully.`);
    }

    /**
     * mcp init
     * Registers all bundled servers in one shot, creating or updating
     * config/mcp.json.  Existing non-MCP keys are preserved.
     */
    async _handleInit() {
        const bundled = this._getAvailableBundledServers();
        if (bundled.length === 0) {
            console.log('No bundled servers found in servers/ directory.');
            return;
        }

        const config = this._readConfig();
        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        let added = 0;
        let skipped = 0;

        for (const server of bundled) {
            if (config.mcpServers[server.name]) {
                skipped++;
                continue;
            }

            const resolved = this._resolveBundledServer(server.name);
            if (!resolved) continue;

            const installed = await this._installBundledDependencies(resolved.serverDir, server.name);
            if (!installed) continue;

            config.mcpServers[server.name] = {
                command: 'node',
                args: [resolved.entryPoint]
            };
            added++;
        }

        this._writeConfig(config);

        if (added > 0) {
            console.log(`\n✅ Initialized ${added} bundled MCP server(s).`);
        }
        if (skipped > 0) {
            console.log(`   ${skipped} server(s) already configured (skipped).`);
        }
        if (added === 0 && skipped > 0) {
            console.log('\nAll bundled servers are already configured.');
        }
        console.log(`\nConfig written to ${this._getConfigPath()}`);
    }

    /**
     * mcp list [--bundled]
     * @param {object} options - Parsed CLI options
     */
    _handleList(options) {
        const isBundled = options.bundled === true || options.bundled === 'true';

        if (isBundled) {
            this._listBundledServers();
            return;
        }

        const config = this._readConfig();
        const servers = config.mcpServers;

        if (!servers || Object.keys(servers).length === 0) {
            console.log('No MCP servers configured.');
            console.log('Use "yo ml-container-creator mcp add <name> -- <command> [args...]" to add one.');
            return;
        }

        console.log('\nConfigured MCP servers:\n');
        for (const [name, serverConfig] of Object.entries(servers)) {
            const args = serverConfig.args ? serverConfig.args.join(' ') : '';
            console.log(`  ${name}: ${serverConfig.command} ${args}`.trimEnd());
        }
        console.log('');
    }

    /**
     * mcp get <name>
     * @param {string} name - Server name
     */
    _handleGet(name) {
        if (!name) {
            console.log('Usage: yo ml-container-creator mcp get <name>');
            return;
        }

        const config = this._readConfig();
        const servers = config.mcpServers;

        if (!servers || !servers[name]) {
            const available = servers ? Object.keys(servers) : [];
            console.log(`Error: MCP server "${name}" not found.`);
            if (available.length > 0) {
                console.log(`Available servers: ${available.join(', ')}`);
            }
            return;
        }

        const serverConfig = servers[name];
        console.log(`\nMCP server: ${name}\n`);
        console.log(`  command:  ${serverConfig.command}`);
        console.log(`  args:     ${serverConfig.args ? serverConfig.args.join(' ') : '(none)'}`);
        console.log(`  env:      ${serverConfig.env ? JSON.stringify(serverConfig.env) : '(none)'}`);
        console.log(`  toolName: ${serverConfig.toolName || '(default: get_ml_config)'}`);
        console.log(`  limit:    ${serverConfig.limit || '(default: 10)'}`);
        console.log('');
    }

    /**
     * mcp remove <name>
     * @param {string} name - Server name
     */
    async _handleRemove(name) {
        if (!name) {
            console.log('Usage: yo ml-container-creator mcp remove <name>');
            return;
        }

        const config = this._readConfig();
        const servers = config.mcpServers;

        if (!servers || !servers[name]) {
            console.log(`Error: MCP server "${name}" not found.`);
            return;
        }

        delete servers[name];

        // If last server removed, remove the mcpServers key entirely
        if (Object.keys(servers).length === 0) {
            delete config.mcpServers;
        }

        this._writeConfig(config);
        console.log(`✅ MCP server "${name}" removed.`);
    }

    /**
     * Show mcp usage help.
     */
    _showMcpHelp() {
        console.log(`
MCP Server Management

USAGE:
  yo ml-container-creator mcp <subcommand> [options]

SUBCOMMANDS:
  init                                Add all bundled servers at once
  add <name> -- <command> [args...]   Add an MCP server
  add <name> --bundled                Add a bundled MCP server
  list                                List configured MCP servers
  list --bundled                      List available bundled servers
  get <name>                          Show full server configuration
  remove <name>                       Remove an MCP server

ADD OPTIONS:
  -e KEY=VALUE                        Set environment variable (repeatable)
  --tool-name <toolName>              MCP tool name (default: get_ml_config)
  --limit <num>                       Max results per parameter (default: 10)
  --bundled                           Use a bundled server from servers/

EXAMPLES:
  yo ml-container-creator mcp init
  yo ml-container-creator mcp add team-config -- node servers/instance-recommender/index.js
  yo ml-container-creator mcp add instance-recommender --bundled
  yo ml-container-creator mcp add corp-policy -- npx -y @corp/mcp-policy -e TEAM_ID=ml-platform
  yo ml-container-creator mcp list
  yo ml-container-creator mcp list --bundled
  yo ml-container-creator mcp get team-config
  yo ml-container-creator mcp remove team-config
`);
    }

    /**
     * Resolve a bundled server from the servers/ directory.
     * @param {string} name - Server name (directory name under servers/)
     * @returns {{ serverDir: string, entryPoint: string } | null}
     */
    _resolveBundledServer(name) {
        const serverDir = path.join(SERVERS_DIR, name);
        const pkgPath = path.join(serverDir, 'package.json');

        if (!fs.existsSync(pkgPath)) {
            const available = this._getAvailableBundledServers();
            console.log(`Error: Bundled server "${name}" not found.`);
            if (available.length > 0) {
                console.log(`Available bundled servers: ${available.map(s => s.name).join(', ')}`);
            } else {
                console.log('No bundled servers are available.');
            }
            return null;
        }

        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch (err) {
            console.log(`Error reading package.json for bundled server "${name}": ${err.message}`);
            return null;
        }

        const main = pkg.main || 'index.js';
        const entryPoint = path.join(serverDir, main);

        return { serverDir, entryPoint };
    }

    /**
     * Install dependencies for a bundled server if not already installed.
     * @param {string} serverDir - Absolute path to the server directory
     * @param {string} name - Server name for display
     * @returns {boolean} true if dependencies are ready, false on failure
     */
    async _installBundledDependencies(serverDir, name) {
        const nodeModulesDir = path.join(serverDir, 'node_modules');

        if (fs.existsSync(nodeModulesDir)) {
            return true;
        }

        console.log(`Installing dependencies for ${name}...`);
        try {
            execSync('npm install --production', {
                cwd: serverDir,
                stdio: 'pipe',
                timeout: 60000
            });
            return true;
        } catch (err) {
            const stderr = err.stderr ? err.stderr.toString() : err.message;
            console.log(`Error: Failed to install dependencies for "${name}".`);
            console.log(stderr);
            return false;
        }
    }

    /**
     * List available bundled servers from the servers/ directory.
     */
    _listBundledServers() {
        const servers = this._getAvailableBundledServers();

        if (servers.length === 0) {
            console.log('No bundled servers available.');
            return;
        }

        console.log('\nAvailable bundled servers:\n');
        for (const server of servers) {
            console.log(`  ${server.name}: ${server.description}`);
        }
        console.log('\nUse "yo ml-container-creator mcp add <name> --bundled" to add one.');
        console.log('');
    }

    /**
     * Get list of available bundled servers with metadata.
     * @returns {Array<{ name: string, description: string }>}
     */
    _getAvailableBundledServers() {
        if (!fs.existsSync(SERVERS_DIR)) {
            return [];
        }

        const entries = fs.readdirSync(SERVERS_DIR, { withFileTypes: true });
        const servers = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const pkgPath = path.join(SERVERS_DIR, entry.name, 'package.json');
            if (!fs.existsSync(pkgPath)) continue;

            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

                // Skip non-server packages (e.g. shared libraries) —
                // a bundled MCP server must declare @modelcontextprotocol/sdk
                // as a dependency.
                const deps = pkg.dependencies || {};
                if (!deps['@modelcontextprotocol/sdk']) continue;

                servers.push({
                    name: entry.name,
                    description: pkg.description || '(no description)'
                });
            } catch (_) {
                servers.push({
                    name: entry.name,
                    description: '(unable to read package.json)'
                });
            }
        }

        return servers;
    }

    /**
     * Parse -e KEY=VALUE flags from options.
     * @param {object} options
     * @returns {object} env key-value pairs
     */
    _parseEnvFlags(options) {
        const env = {};
        const envFlags = options.e || options.env;
        if (!envFlags) return env;

        const entries = Array.isArray(envFlags) ? envFlags : [envFlags];
        for (const entry of entries) {
            const eqIndex = entry.indexOf('=');
            if (eqIndex > 0) {
                const key = entry.slice(0, eqIndex);
                const value = entry.slice(eqIndex + 1);
                env[key] = value;
            }
        }
        return env;
    }

    /**
     * Read config/mcp.json, preserving all keys.
     * Returns empty object if file doesn't exist.
     * @returns {object}
     */
    _readConfig() {
        const configPath = this._getConfigPath();
        if (!fs.existsSync(configPath)) {
            return {};
        }
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (err) {
            console.log(`Error reading ${CONFIG_FILENAME}: ${err.message}`);
            return {};
        }
    }

    /**
     * Write config to config/mcp.json, preserving non-MCP keys.
     * @param {object} config
     */
    _writeConfig(config) {
        const configPath = this._getConfigPath();
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }

    /**
     * Resolve the config file path.
     * @returns {string}
     */
    _getConfigPath() {
        return this.generator.destinationPath
            ? this.generator.destinationPath(CONFIG_FILENAME)
            : path.resolve(CONFIG_FILENAME);
    }
}
