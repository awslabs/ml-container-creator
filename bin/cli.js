#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'module';
import path from 'path';
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
    if (opt.hidden) continue;
    const option = new Option(opt.flag, opt.description);
    if (opt.choices) option.choices(opt.choices);
    if (opt.repeatable) {
        option.argParser(collect);
        option.default([]);
    }
    program.addOption(option);
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
    return run(projectNameArgs?.[0] || null, options);
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
            const section = helpGroups[long] || 'general';
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
    .argument('[action]', 'Bootstrap action (add, remove, add-module, remove-module, status, use, list, scan, prune, update, migrate, sync-schemas, sync-model-families)')
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
    .command('registry')
    .description('Registry operations (list, get, remove, replay, export, import, search) — experimental, may be reconciled with do/register')
    .argument('<action>', 'Registry action (log, list, get, remove, replay, export, import, search)')
    .argument('[args...]', 'Additional arguments')
    .option('--backend <backend>', 'Filter by backend')
    .option('--architecture <arch>', 'Filter by architecture')
    .option('--model <model>', 'Filter by model name')
    .option('--instance-type <type>', 'Filter by instance type')
    .option('--status <status>', 'Filter by status')
    .option('--merge', 'Merge on import')
    .option('--replace', 'Replace on import')
    // Options used by `registry log` (called from do/register)
    .option('--deployment-config <config>', 'Deployment configuration')
    .option('--region <region>', 'AWS region')
    .option('--deployment-target <target>', 'Deployment target')
    .option('--build-target <target>', 'Build target')
    .option('--model-name <name>', 'Model name')
    .option('--model-format <format>', 'Model format')
    .option('--base-image <image>', 'Base container image')
    .option('--notes <text>', 'Deployment notes')
    .option('--project', 'Use project-level registry')
    .option('--parameters <json>', 'Parameters JSON string')
    .option('--ic-list <json>', 'IC list JSON string')
    .option('--generator-version <version>', 'Generator version')
    // Options used by `registry list-architectures`
    .option('--server <name>', 'Filter by server name (for list-architectures)')
    .option('--verbose', 'Show full list of supported model types (for list-architectures)')
    .action(async (action, args, options) => {
        const { default: RegistryCommandHandler } = await import('../src/lib/registry-command-handler.js');
        const handler = new RegistryCommandHandler();
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

program
    .command('configure')
    .description('Interactive configuration setup (experimental)')
    .action(async () => {
        const { runPrompts } = await import('../src/prompt-adapter.js');

        console.log('\n🔧 ML Container Creator Configuration (experimental)');
        console.log('\nThis will help you set up configuration files for your project.\n');

        const answers = await runPrompts([
            {
                type: 'list',
                name: 'configType',
                message: 'What type of configuration would you like to create?',
                choices: [
                    { name: 'Show CLI option examples', value: 'cli' },
                    { name: 'Show environment variable examples', value: 'env' }
                ]
            }
        ]);

        if (answers.configType === 'cli') {
            console.log(`
💻 CLI Examples:

  # Basic sklearn project
  ml-container-creator --deployment-config=http-flask --model-format=pkl --skip-prompts

  # Transformers with vLLM
  ml-container-creator --deployment-config=transformers-vllm \\
    --model-name=meta-llama/Llama-2-7b-chat-hf \\
    --instance-type=ml.g5.xlarge --skip-prompts

  # Using a config file
  ml-container-creator --config=my-config.json --skip-prompts
`);
        } else if (answers.configType === 'env') {
            console.log(`
🌍 Environment Variables:

  export ML_INSTANCE_TYPE="ml.m5.large"
  export AWS_REGION="us-east-1"
  export AWS_ROLE="arn:aws:iam::123456789012:role/SageMakerRole"
  export HF_TOKEN="hf_..."

  Then run: ml-container-creator --deployment-config=http-flask --skip-prompts
`);
        }
    });

program
    .command('hey')
    .description('Chat with the ml-container-creator advisor')
    .option('--project-dir <dir>', 'Project directory to analyze', process.cwd())
    .option('-o, --offline', 'Static reference mode (no Bedrock calls)')
    .action(async (options) => {
        // 1. Check python3 is available
        try {
            execSync('python3 --version', { stdio: 'ignore' });
        } catch {
            console.error('❌ python3 not found. Install Python 3.10+ to use the advisor.');
            console.error('   macOS: brew install python3');
            console.error('   Ubuntu: sudo apt install python3');
            process.exit(1);
        }

        // 2. If not offline, check strands-agents is installed
        if (!options.offline) {
            try {
                execSync('python3 -c "import strands"', { stdio: 'ignore' });
            } catch {
                console.error('❌ strands-agents not installed. Run:');
                console.error('   pip install -r src/agent/requirements-agent.txt');
                process.exit(1);
            }
        }

        // 3. Resolve agent script path
        const agentScript = path.join(__dirname, '..', 'src', 'agent', 'agent.py');

        // 4. Build args and spawn
        const args = [agentScript, '--project-dir', options.projectDir];
        if (options.offline) {
            args.push('--offline');
        }

        const child = spawn('python3', args, {
            stdio: 'inherit',
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        // 5. Forward exit code
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

program.parse();
