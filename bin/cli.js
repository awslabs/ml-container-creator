#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { program, Option, Help } from 'commander';
import { run } from '../src/app.js';
import { cliOptions, helpGroups } from '../src/lib/generated/cli-options.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

/**
 * Collect repeatable options into an array.
 * Used for --model-env and --server-env which can be specified multiple times.
 */
function collect(value, previous) {
    return previous.concat([value]);
}

program
    .name('ml-container-creator')
    .version(version)
    .enablePositionalOptions()
    .helpCommand('help [command]', 'Display help for command')
    .argument('[project-name...]', 'Name for the generated project');

// Register all CLI options from generated schema
for (const opt of cliOptions) {
    const option = new Option(opt.flag, opt.description);
    if (opt.choices) option.choices(opt.choices);
    if (opt.hidden) option.hideHelp();
    if (opt.defaultValue !== undefined) option.default(opt.defaultValue);
    if (opt.repeatable) {
        option.argParser(collect);
        option.default([]);
    }
    program.addOption(option);
}

// BL084: --backend is a hand-added alias for --deployment-config.
// It is NOT in parameter-schema-v2.json / cli-options.js because codegen-cli.js
// has no alias concept. Reuse the SAME choices as --deployment-config to prevent drift.
// NOTE: registered via the inline addOption(new Option(...)) form (see line below)
// so scripts/sync-command-generator.js (which regex-extracts that exact pattern
// from this file) auto-detects it for the docs command manifest (BL083).
const deploymentConfigOpt = cliOptions.find(o => o.flag.startsWith('--deployment-config'));
program.addOption(new Option('--backend <config>', 'Deployment configuration: architecture+engine pair (e.g. transformers-vllm, diffusors-vllm-omni, http-flask). Alias for --deployment-config.'));
// Apply the shared choices enum to the just-added option (sourced from cliOptions to prevent drift).
if (deploymentConfigOpt?.choices) {
    const backendOpt = program.options.find(o => o.long === '--backend');
    if (backendOpt) backendOpt.choices(deploymentConfigOpt.choices);
}

program.action((projectNameArgs, options) => {
    // Mutual exclusion validation: plaintext token and ARN flags cannot both be provided
    if (options.hfToken && options.hfTokenArn) {
        console.error('❌ Cannot specify both --hf-token and --hf-token-arn. Use one or the other.');
        process.exit(1);
    }
    if (options.ngcToken && options.ngcTokenArn) {
        console.error('❌ Cannot specify both --ngc-token and --ngc-token-arn. Use one or the other.');
        process.exit(1);
    }

    // BL084: resolve the --backend alias into deploymentConfig before the
    // explicit-options filter runs, mirroring the hf-token mutual-exclusion pattern.
    if (options.backend && options.deploymentConfig && options.backend !== options.deploymentConfig) {
        console.error('❌ --backend and --deployment-config cannot both be specified with different values');
        process.exit(1);
    }
    if (options.backend && !options.deploymentConfig) {
        options.deploymentConfig = options.backend;
    }

    // Strip Commander default values from options so they don't override
    // environment variables in the config precedence chain.
    // Only pass options that were explicitly provided on the command line.
    const explicitOptions = {};
    for (const [key, value] of Object.entries(options)) {
        if (program.getOptionValueSource(key) !== 'default') {
            explicitOptions[key] = value;
        }
    }

    // BL084: ensure the resolved deploymentConfig survives the default-stripping
    // filter. When --backend was used, deploymentConfig was set programmatically
    // (source is not 'cli'), so include it explicitly. Also drop the raw alias key
    // so it is not mistaken for the derived architecture engine (answers.backend).
    if (options.backend && options.deploymentConfig) {
        explicitOptions.deploymentConfig = options.deploymentConfig;
        delete explicitOptions.backend;
    }

    return run(projectNameArgs?.[0] || null, explicitOptions);
});

// Custom help formatting — group options into logical sections (root command only)
program.configureHelp({
    formatHelp(cmd, helper) {
        // Only apply custom grouping to the root command
        if (cmd !== program) {
            // Fall back to default Commander formatting for subcommands
            return Help.prototype.formatHelp.call(this, cmd, helper);
        }

        const termWidth = helper.padWidth(cmd, helper);

        function callFormatItem(term, description) {
            return helper.formatItem(term, termWidth, description, helper);
        }

        function formatSection(title, options) {
            if (options.length === 0) return [];
            const lines = options.map(opt => {
                return callFormatItem(
                    helper.styleOptionTerm(helper.optionTerm(opt)),
                    helper.styleOptionDescription(helper.optionDescription(opt))
                );
            });
            return [helper.styleTitle(`${title}:`), ...lines, ''];
        }

        // Collect all visible options
        const allOptions = helper.visibleOptions(cmd);

        // Partition options into groups using schema-derived helpGroups
        const groups = {
            general: [],
            model: [],
            infra: [],
            endpoint: [],
            ic: [],
            async: [],
            batch: [],
            hyperpod: [],
            env: [],
            auth: [],
            features: [],
            mcp: [],
            validation: []
        };

        for (const opt of allOptions) {
            const long = opt.long || '';
            // BL084: --backend is hand-added and absent from the generated helpGroups.
            // Group it with --deployment-config (the 'model' group) since it is an alias.
            const section = (long === '--backend') ? 'model' : (helpGroups[long] || 'general');
            if (groups[section]) {
                groups[section].push(opt);
            } else {
                groups.general.push(opt);
            }
        }

        // Build output
        let output = [
            `${helper.styleTitle('Usage:')} ${helper.styleUsage(helper.commandUsage(cmd))}`,
            ''
        ];

        // Arguments
        const args = helper.visibleArguments(cmd);
        if (args.length > 0) {
            const argList = args.map(arg => {
                return callFormatItem(
                    helper.styleArgumentTerm(helper.argumentTerm(arg)),
                    helper.styleArgumentDescription(helper.argumentDescription(arg))
                );
            });
            output = output.concat([helper.styleTitle('Arguments:'), ...argList, '']);
        }

        // Option sections
        output = output.concat(formatSection('General', groups.general));
        output = output.concat(formatSection('Model & Framework', groups.model));
        output = output.concat(formatSection('Build & Infrastructure', groups.infra));
        output = output.concat(formatSection('Endpoint (Real-Time Inference)', groups.endpoint));
        output = output.concat(formatSection('Inference Component', groups.ic));
        output = output.concat(formatSection('Async Inference', groups.async));
        output = output.concat(formatSection('Batch Transform', groups.batch));
        output = output.concat(formatSection('HyperPod (EKS)', groups.hyperpod));
        output = output.concat(formatSection('Environment Variables', groups.env));
        output = output.concat(formatSection('Authentication', groups.auth));
        output = output.concat(formatSection('Optional Features', groups.features));
        output = output.concat(formatSection('MCP & Discovery', groups.mcp));
        output = output.concat(formatSection('Validation', groups.validation));

        // Commands
        const cmds = helper.visibleCommands(cmd);
        if (cmds.length > 0) {
            const cmdList = cmds.map(sub => {
                return callFormatItem(
                    helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
                    helper.styleSubcommandDescription(helper.subcommandDescription(sub))
                );
            });
            output = output.concat([helper.styleTitle('Commands:'), ...cmdList, '']);
        }

        return output.join('\n');
    }
});

// Sub-commands — wired to actual handlers

program
    .command('bootstrap')
    .description('Set up modular AWS infrastructure (core, benchmark, registry, training, ci)')
    .passThroughOptions()
    .argument('[action]', 'Bootstrap action (add, remove, add-module, remove-module, add-secret, status, use, list, scan, prune, update, migrate, sync-schemas, sync-model-families)')
    .argument('[args...]', 'Additional arguments')
    .option('--profile <profile>', 'AWS profile name')
    .option('--region <region>', 'AWS region')
    .option('--role-arn <arn>', 'Existing IAM role ARN to use')
    .option('--non-interactive', 'Run without prompts (requires --profile and --region)')
    .option('--name <name>', 'Bootstrap profile name (default: "default")')
    .option('--with <modules>', 'Comma-separated modules to provision (non-interactive; default: core,registry)')
    .option('--force', 'Force removal without confirmation')
    .option('--dry-run', 'Preview module changes (stacks, resources, profile updates) without provisioning or destroying anything')
    .option('--verify', 'Verify resources exist (for status)')
    .option('--delete-stack', 'Delete CloudFormation stack on remove')
    .option('--ignore-staleness', 'Suppress schema staleness warnings')
    .option('--ci', 'Provision CI integration infrastructure')
    .option('--benchmark-infra', 'Provision Athena/Glue benchmark infrastructure (requires --ci)')
    .option('--skip-ci', 'Skip CI infrastructure provisioning')
    .option('--skip-s3', 'Skip S3 bucket creation')
    .option('--skip-post-setup', 'Skip post-setup chain (mcp init, sync-architectures, sync-schemas)')
    .action(async (action, args, options) => {
        const { default: BootstrapCommandHandler } = await import('../src/lib/bootstrap-command-handler.js');
        const handler = new BootstrapCommandHandler();
        const allArgs = action ? [action, ...args] : [];
        await handler.handle(allArgs, options);
    });

program
    .command('mcp')
    .description('Manage MCP servers (add, list, get, remove, init)')
    .passThroughOptions()
    .argument('<action>', 'MCP action (add, list, get, remove, init)')
    .argument('[args...]', 'Additional arguments')
    .option('-e <env>', 'Environment variable in KEY=VALUE format (for add)')
    .option('--tool-name <name>', 'Tool name for MCP server (for add)')
    .option('--limit <n>', 'Result limit for MCP server (for add)')
    .option('--bundled', 'Use a bundled server from servers/ directory')
    .action(async (action, args, options) => {
        const { default: McpCommandHandler } = await import('../src/lib/mcp-command-handler.js');
        const { runPrompts } = await import('../src/prompt-adapter.js');
        // McpCommandHandler expects a generator-like object with destinationPath() and prompt()
        const generatorAdapter = {
            destinationPath(...segments) {
                if (segments.length === 0) return process.cwd();
                return path.join(process.cwd(), ...segments);
            },
            async prompt(prompts) {
                return runPrompts(prompts);
            }
        };
        const handler = new McpCommandHandler(generatorAdapter);
        await handler.handle([action, ...args], options);
    });

program
    .command('secrets')
    .description('Manage secrets in AWS Secrets Manager (create, list, describe)')
    .argument('[action]', 'Secrets action (create, list, describe)')
    .argument('[args...]', 'Additional arguments')
    .option('--type <type>', 'Secret type (e.g., hf-token, ngc-token)')
    .option('--name <label>', 'Secret label (used in naming convention)')
    .option('--secret-value <value>', 'Secret value (masked in terminal)')
    .option('--description <text>', 'Secret description')
    .option('--kms-key-id <key>', 'KMS key for encryption')
    .option('--json <json-or-path>', 'JSON input (inline or file://path)')
    .action(async (action, args, options) => {
        const { default: SecretsCommandHandler } = await import('../src/lib/secrets-command-handler.js');
        const handler = new SecretsCommandHandler();
        const allArgs = action ? [action, ...args] : [];
        await handler.handle(allArgs, options);
    });

// ─── BL079: `mcc hey init` — advisory agent environment provisioning ──────────

const HEY_VENV_REL = '.mlcc/hey-venv';

/**
 * Detect whether the `uv` tool is available on PATH.
 * @returns {boolean}
 */
function _hasUv() {
    try {
        execSync('uv --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve the absolute path to src/agent/requirements-agent.txt relative to the
 * MLCC package root (NOT the project cwd), per Requirement 1.2.
 * @returns {string}
 */
function _requirementsAgentPath() {
    return path.join(__dirname, '..', 'src', 'agent', 'requirements-agent.txt');
}

/**
 * Compute the venv Python interpreter path for a given venv directory,
 * accounting for platform layout differences.
 * @param {string} venvDir Absolute path to the venv directory.
 * @returns {string}
 */
function _venvPython(venvDir) {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python3');
}

/**
 * Merge `venv_path` into .mlcc/agent-config.json, creating the file/dir if absent.
 * @param {string} projectDir Absolute project directory.
 * @param {string} venvPathValue Relative venv path to persist.
 */
function _writeVenvPathToConfig(projectDir, venvPathValue) {
    const mlccDir = path.join(projectDir, '.mlcc');
    const configPath = path.join(mlccDir, 'agent-config.json');
    fs.mkdirSync(mlccDir, { recursive: true });

    let config = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config === null || typeof config !== 'object' || Array.isArray(config)) {
                config = {};
            }
        } catch {
            // Malformed existing config — start fresh rather than crash.
            config = {};
        }
    }

    config.venv_path = venvPathValue;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)  }\n`, 'utf8');
}

/**
 * Read `venv_path` from .mlcc/agent-config.json, if present.
 * @param {string} projectDir Absolute project directory.
 * @returns {string|null}
 */
function _readVenvPath(projectDir) {
    const configPath = path.join(projectDir, '.mlcc', 'agent-config.json');
    if (!fs.existsSync(configPath)) return null;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const value = config && config.venv_path;
        return typeof value === 'string' && value ? value : null;
    } catch {
        return null;
    }
}

/**
 * Resolve which Python interpreter `mcc hey` should spawn (Requirement 2).
 * Prefers the dedicated hey-venv when `venv_path` is set and exists; otherwise
 * warns (when configured-but-missing) and falls back to system python3.
 * @param {string} projectDir Absolute project directory.
 * @returns {string} Path/name of the Python interpreter to use.
 */
function _resolveHeyPython(projectDir) {
    const venvPathRel = _readVenvPath(projectDir);
    if (!venvPathRel) {
        return 'python3';
    }

    const venvDir = path.isAbsolute(venvPathRel)
        ? venvPathRel
        : path.join(projectDir, venvPathRel);
    const venvPython = _venvPython(venvDir);

    if (fs.existsSync(venvPython)) {
        return venvPython;
    }

    console.warn(`⚠️  Venv not found at ${venvPathRel}. Run: mcc hey init`);
    return 'python3';
}

/**
 * Count the number of package requirements declared in requirements-agent.txt
 * (non-empty, non-comment lines).
 * @param {string} requirementsPath
 * @returns {string[]} List of package base names.
 */
function _parseRequirementNames(requirementsPath) {
    const raw = fs.readFileSync(requirementsPath, 'utf8');
    return raw
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split(/[<>=!~ ]/)[0].trim())
        .filter(Boolean);
}

/**
 * BL079 Requirement 1: provision (or upgrade) the dedicated advisory-agent venv
 * at .mlcc/hey-venv, install the agent requirements, persist `venv_path`, and
 * print a success summary.
 *
 * Environment creation / package installation are delegated to `execSync` so
 * unit tests can mock them.
 *
 * @param {string} projectDir Absolute (or cwd-relative) project directory.
 * @param {object} [deps] Injectable dependencies for testing.
 * @param {(cmd: string, opts?: object) => void} [deps.exec] Command executor.
 * @param {() => boolean} [deps.hasUv] uv-availability detector.
 * @param {typeof fs} [deps.fsImpl] filesystem implementation.
 */
function _initHeyEnvironment(projectDir, deps = {}) {
    const exec = deps.exec || ((cmd) => execSync(cmd, { stdio: 'inherit' }));
    const hasUv = deps.hasUv || _hasUv;
    const fsImpl = deps.fsImpl || fs;

    const resolvedProjectDir = path.resolve(projectDir);
    const venvDir = path.join(resolvedProjectDir, HEY_VENV_REL);
    const venvPython = _venvPython(venvDir);
    const requirementsPath = _requirementsAgentPath();

    if (!fsImpl.existsSync(requirementsPath)) {
        console.error(`❌ requirements-agent.txt not found at ${requirementsPath}`);
        process.exit(1);
    }

    const isUpgrade = fsImpl.existsSync(venvPython);
    const useUv = hasUv();

    // 1. Create the venv (idempotent — safe to re-run on an existing venv).
    if (!isUpgrade) {
        if (useUv) {
            exec(`uv venv ${JSON.stringify(venvDir)}`);
        } else {
            exec(`python3 -m venv ${JSON.stringify(venvDir)}`);
        }
    }

    // 2. Install (or upgrade) the agent requirements.
    const upgradeFlag = isUpgrade ? ' -U' : '';
    if (useUv) {
        exec(`uv pip install${upgradeFlag} -r ${JSON.stringify(requirementsPath)} --python ${JSON.stringify(venvPython)}`);
    } else {
        const pipBin = process.platform === 'win32'
            ? path.join(venvDir, 'Scripts', 'pip.exe')
            : path.join(venvDir, 'bin', 'pip');
        exec(`${JSON.stringify(pipBin)} install${upgradeFlag} -r ${JSON.stringify(requirementsPath)}`);
    }

    // 3. Persist venv_path into .mlcc/agent-config.json (create/merge).
    _writeVenvPathToConfig(resolvedProjectDir, HEY_VENV_REL);

    // 4. Print the success summary.
    let names = [];
    try {
        names = _parseRequirementNames(requirementsPath);
    } catch {
        names = [];
    }
    const highlighted = ['strands-agents', 'sagemaker', 'huggingface_hub', 'boto3'];
    const others = Math.max(names.length - highlighted.length, 0);
    const verb = isUpgrade ? 'updated' : 'ready';
    console.log(`✅ mcc hey environment ${verb}`);
    console.log(`   Venv: ${HEY_VENV_REL}/`);
    console.log(`   Packages: ${highlighted.join(', ')} (and ${others} others)`);
    console.log('   Run: mcc hey --goal "..."');
}

program
    .command('hey')
    .description('Chat with the ml-container-creator advisor')
    .argument('[subcommand]', 'Optional subcommand: "init" to provision the advisory agent venv')
    .option('--project-dir <dir>', 'Project directory to analyze', process.cwd())
    .option('-o, --offline', 'Static reference mode (no Bedrock calls)')
    .option('--goal <goal>', 'Plan and execute toward a specific goal')
    .option('--from-plan [file]', 'Execute a saved plan.json without re-planning (defaults to ./plan.json)')
    .option('--auto', 'Fully autonomous goal execution (no confirmation prompts)')
    .option('--dry-run', 'Preview the plan without executing anything')
    .action(async (subcommand, options) => {
        // BL079: `mcc hey init` provisions the dedicated advisory-agent venv.
        if (subcommand === 'init') {
            _initHeyEnvironment(options.projectDir);
            return;
        }

        // BL080: --from-plan and --goal are mutually exclusive.
        if (options.fromPlan && options.goal) {
            console.error('❌ --from-plan and --goal are mutually exclusive');
            process.exit(1);
        }

        // 1. Check python3 is available
        try {
            execSync('python3 --version', { stdio: 'ignore' });
        } catch {
            console.error('❌ python3 not found. Install Python 3.10+ to use the advisor.');
            console.error('   macOS: brew install python3');
            console.error('   Ubuntu: sudo apt install python3');
            process.exit(1);
        }

        // 2. Resolve the Python interpreter — prefer the dedicated hey-venv (BL079).
        const pythonBin = _resolveHeyPython(options.projectDir);

        // 3. If not offline, check strands-agents is installed in the chosen interpreter
        if (!options.offline) {
            try {
                execSync(`${JSON.stringify(pythonBin)} -c "import strands"`, { stdio: 'ignore' });
            } catch {
                console.error('❌ strands-agents not installed. Run:');
                console.error('   mcc hey init');
                console.error('   (or: pip install -r src/agent/requirements-agent.txt)');
                process.exit(1);
            }
        }

        // 4. Resolve agent script path
        const agentScript = path.join(__dirname, '..', 'src', 'agent', 'agent.py');

        // 5. Build args and spawn
        const args = [agentScript, '--project-dir', options.projectDir];
        if (options.offline) {
            args.push('--offline');
        }
        if (options.goal) {
            args.push('--goal', options.goal);
        }
        if (options.auto) {
            args.push('--auto');
        }
        if (options.dryRun) {
            args.push('--dry-run');
        }

        // BL080: resolve and pass through --from-plan.
        if (options.fromPlan) {
            let planPath;
            if (options.fromPlan === true) {
                // Flag provided without a value → default to <projectDir>/plan.json.
                planPath = path.join(options.projectDir, 'plan.json');
            } else {
                // Absolute path stays as-is; relative resolves against cwd.
                planPath = path.resolve(process.cwd(), options.fromPlan);
            }
            args.push('--from-plan', planPath);
        }

        const child = spawn(pythonBin, args, {
            stdio: 'inherit',
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        // 6. Forward exit code
        child.on('close', (code) => {
            process.exit(code ?? 0);
        });

        child.on('error', (err) => {
            console.error(`❌ Failed to start agent: ${err.message}`);
            process.exit(1);
        });
    });

program
    .command('prove')
    .description('Prove that a configuration works end-to-end (generate → deploy → test → clean)')
    .passThroughOptions()
    .argument('[config]', 'Path to prove.json config file (or subcommand: report, sync, status)')
    .argument('[args...]', 'Additional arguments')
    .option('--interactive', 'Build prove config interactively')
    .option('--model <model>', 'Model name (shorthand for prove.json base.model_name)')
    .option('--deployment-config <config>', 'Deployment config (e.g. transformers-vllm)')
    .option('--instance-type <type>', 'Instance type (e.g. ml.g5.xlarge)')
    .option('--stages <stages>', 'Comma-separated stages to run (default: all)')
    .option('--concurrency <n>', 'Parallel prove runs for sweeps (default: 1)', parseInt)
    .option('--no-clean', 'Skip cleanup after prove')
    .option('--dry-run', 'Print what would run without executing')
    .option('--budget <usd>', 'Max spend in USD (default: 50)', parseFloat)
    .action(async (config, args, options) => {
        const { default: ProveCommandHandler } = await import('../src/lib/prove-command-handler.js');
        const handler = new ProveCommandHandler();
        const allArgs = config ? [config, ...args] : args;
        await handler.handle(allArgs, options);
    });

program
    .command('import')
    .description('Generate an operational project from a running SageMaker endpoint')
    .argument('<endpoint-arn>', 'SageMaker endpoint ARN (any endpoint status)')
    .option('--output-dir <path>', 'Output directory (default: ./<endpoint-name>)')
    .option('--region <region>', 'AWS region override (default: from ARN or AWS_DEFAULT_REGION)')
    .option('--dry-run', 'Show what would be generated without writing')
    .action(async (endpointArn, options) => {
        const { default: ImportCommandHandler } = await import('../src/lib/import-command-handler.js');
        const handler = new ImportCommandHandler(options);
        await handler.handle(endpointArn);
    });

program
    .command('update')
    .description('Update project configuration fields and regenerate only affected files')
    .option('--field <key=value>', 'Set a field non-interactively (repeatable)', collect, [])
    .option('--dry-run', 'Show affected files without writing')
    .option('--no-register', 'Skip do/register after update')
    .action(async (options) => {
        const { default: UpdateCommandHandler } = await import('../src/lib/update-command-handler.js');
        const handler = new UpdateCommandHandler({ ...options, fields: options.field });
        await handler.handle();
    });

program
    .command('regenerate')
    .description('Re-run generation from saved parameters using the current generator version')
    .option('--force', 'Regenerate all files even if version matches')
    .option('--dry-run', 'Show what would change without writing')
    .option('--no-register', 'Skip do/register after regeneration')
    .option('--all-targets', 'Generate all deployment targets and migrate HYPERPOD_* to HP_*')
    .action(async (options) => {
        const { default: RegenerateCommandHandler } = await import('../src/lib/regenerate-command-handler.js');
        const handler = new RegenerateCommandHandler(options);
        await handler.handle();
    });

// Only parse argv when executed directly as a CLI (not when imported by tests).
// Resolve symlinks on both sides: under `npm link`, process.argv[1] is the
// symlink in the global bin while __filename is the real file — a plain string
// compare would never match, silently skipping program.parse().
const _invokedAsScript = process.argv[1] && (() => {
    try {
        return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
    } catch {
        return path.resolve(process.argv[1]) === __filename;
    }
})();
if (_invokedAsScript) {
    program.parse();
}

// Exported for unit testing (BL079). These are internal helpers; not a public API.
export {
    _initHeyEnvironment,
    _resolveHeyPython,
    _readVenvPath,
    _writeVenvPathToConfig,
    _venvPython,
    _parseRequirementNames,
    HEY_VENV_REL
};
