#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'module';
import path from 'path';
import { program, Option, Help } from 'commander';
import { run } from '../src/app.js';

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
    .argument('[project-name...]', 'Name for the generated project')

    // --- General ---
    .addOption(new Option('--skip-prompts', 'Skip interactive prompts and use configuration from other sources'))
    .addOption(new Option('--auto-prompt', 'Fill defaults, prompt only for missing required values'))
    .addOption(new Option('--config <path>', 'Path to JSON configuration file'))
    .addOption(new Option('--project-name <name>', 'Project name'))
    .addOption(new Option('--project-dir <dir>', 'Output directory path'))
    .addOption(new Option('--force', 'Overwrite existing output directory without prompting'))

    // --- Model & Framework ---
    .addOption(new Option('--deployment-config <config>', 'Deployment configuration (e.g. http-flask, transformers-vllm, triton-fil)'))
    .addOption(new Option('--framework <framework>', 'ML framework — DEPRECATED: use --deployment-config').choices(['sklearn', 'xgboost', 'tensorflow', 'transformers']).hideHelp())
    .addOption(new Option('--model-format <format>', 'Model serialization format (pkl, joblib, json, model, ubj, keras, h5, SavedModel)'))
    .addOption(new Option('--model-name <name>', 'Model identifier (<hf-org/model>, s3://..., registry://..., marketplace://...)'))
    .addOption(new Option('--model-server <server>', 'Model server — DEPRECATED: use --deployment-config').choices(['flask', 'fastapi', 'vllm', 'sglang']).hideHelp())
    .addOption(new Option('--base-image <image>', 'Base container image for Dockerfile'))

    // --- Build & Infrastructure ---
    .addOption(new Option('--deployment-target <target>', 'Deployment target (realtime-inference, async-inference, batch-transform, hyperpod-eks)'))
    .addOption(new Option('--instance-type <type>', 'SageMaker instance type (e.g. ml.g5.xlarge, ml.m5.large)'))
    .addOption(new Option('--region <region>', 'AWS region'))
    .addOption(new Option('--role-arn <arn>', 'IAM role ARN for SageMaker execution'))
    .addOption(new Option('--build-target <target>', 'Build target (codebuild)'))
    .addOption(new Option('--codebuild-compute-type <type>', 'CodeBuild compute type (SMALL, MEDIUM, LARGE)'))

    // --- Endpoint (Real-Time Inference) ---
    .addOption(new Option('--endpoint-initial-instance-count <n>', 'Number of instances for the endpoint (default: 1)'))
    .addOption(new Option('--endpoint-data-capture-percent <pct>', 'Data capture percentage for monitoring, 0-100 (default: 0)'))
    .addOption(new Option('--endpoint-variant-name <name>', 'Production variant name (default: AllTraffic)'))
    .addOption(new Option('--endpoint-volume-size <gb>', 'ML storage volume size in GB'))

    // --- Inference Component ---
    .addOption(new Option('--ic-cpu-count <n>', 'vCPUs allocated to the inference component'))
    .addOption(new Option('--ic-memory-size <mb>', 'Memory in MB for the inference component'))
    .addOption(new Option('--ic-gpu-count <n>', 'GPUs allocated to the inference component'))
    .addOption(new Option('--ic-copy-count <n>', 'Number of inference component copies (default: 1)'))
    .addOption(new Option('--ic-model-weight <weight>', 'Traffic routing weight, 0-1 (default: 1.0)'))

    // --- Async Inference ---
    .addOption(new Option('--async-s3-output-path <path>', 'S3 output path for async results'))
    .addOption(new Option('--async-sns-success-topic <arn>', 'SNS topic ARN for success notifications'))
    .addOption(new Option('--async-sns-error-topic <arn>', 'SNS topic ARN for error notifications'))
    .addOption(new Option('--async-max-concurrent <n>', 'Max concurrent invocations per instance (default: 1)'))

    // --- Batch Transform ---
    .addOption(new Option('--batch-input-path <path>', 'S3 input path for batch data'))
    .addOption(new Option('--batch-output-path <path>', 'S3 output path for batch results'))
    .addOption(new Option('--batch-instance-count <n>', 'Number of instances (default: 1)'))
    .addOption(new Option('--batch-split-type <type>', 'Input split type: Line, RecordIO, None (default: Line)'))
    .addOption(new Option('--batch-strategy <strategy>', 'Batch strategy: MultiRecord, SingleRecord (default: MultiRecord)'))
    .addOption(new Option('--batch-join-source <source>', 'Join source: Input, None (default: None)'))
    .addOption(new Option('--batch-max-concurrent <n>', 'Max concurrent transforms per instance (default: 1)'))
    .addOption(new Option('--batch-max-payload <mb>', 'Max payload size in MB, 0-100 (default: 6)'))

    // --- HyperPod (EKS) ---
    .addOption(new Option('--hyperpod-cluster <name>', 'HyperPod EKS cluster name'))
    .addOption(new Option('--hyperpod-namespace <ns>', 'Kubernetes namespace (default: default)'))
    .addOption(new Option('--hyperpod-replicas <count>', 'Number of replicas (default: 1)'))
    .addOption(new Option('--fsx-volume-handle <handle>', 'FSx for Lustre volume handle'))

    // --- Environment Variables ---
    .addOption(new Option('--model-env <KEY=VALUE>', 'Model env var, repeatable (e.g. VLLM_TENSOR_PARALLEL_SIZE=4)').argParser(collect).default([]))
    .addOption(new Option('--server-env <KEY=VALUE>', 'Server env var, repeatable (e.g. SGLANG_MEM_FRACTION=0.9)').argParser(collect).default([]))

    // --- Authentication ---
    .addOption(new Option('--hf-token <token>', 'HuggingFace token (or "$HF_TOKEN" for env var reference)'))
    .addOption(new Option('--hf-token-arn <arn>', 'HuggingFace token ARN from Secrets Manager'))
    .addOption(new Option('--ngc-token <token>', 'NVIDIA NGC token (or "$NGC_API_KEY" for env var reference)'))
    .addOption(new Option('--ngc-token-arn <arn>', 'NVIDIA NGC token ARN from Secrets Manager'))

    // --- Optional Features ---
    .addOption(new Option('--include-sample', 'Include sample model code'))
    .addOption(new Option('--include-testing', 'Include test suite'))
    .addOption(new Option('--test-types <types>', 'Comma-separated test types'))
    .addOption(new Option('--enable-lora', 'Enable LoRA adapter serving (transformers with vllm/sglang/djl-lmi only)'))
    .addOption(new Option('--max-loras <n>', 'Maximum concurrent LoRA adapters in GPU memory (default: 30)'))
    .addOption(new Option('--max-lora-rank <n>', 'Maximum LoRA rank (default: 64)'))

    // --- Benchmarking ---
    .addOption(new Option('--include-benchmark', 'Include SageMaker AI Benchmarking (transformers/diffusors only)'))
    .addOption(new Option('--benchmark-concurrency <n>', 'Benchmark concurrent requests (default: 10)'))
    .addOption(new Option('--benchmark-input-tokens <n>', 'Benchmark mean input tokens (default: 550)'))
    .addOption(new Option('--benchmark-output-tokens <n>', 'Benchmark mean output tokens (default: 150)'))
    .addOption(new Option('--benchmark-streaming', 'Enable streaming in benchmark (default: true)'))
    .addOption(new Option('--benchmark-request-count <n>', 'Total benchmark requests (optional)'))
    .addOption(new Option('--benchmark-s3-output-path <path>', 'S3 path for benchmark results'))

    // --- MCP & Discovery ---
    .addOption(new Option('--smart', 'Enable Bedrock-powered smart mode on MCP servers'))
    .addOption(new Option('--discover', 'Enable live registry lookups via MCP discovery'))

    // --- Validation ---
    .addOption(new Option('--no-validate', 'Skip schema-driven validation at generation time'))
    .addOption(new Option('--validate-env-vars', 'Enable environment variable validation (default: true)'))
    .addOption(new Option('--validate-with-docker', 'Enable Docker introspection validation (opt-in)'))
    .addOption(new Option('--offline', 'Disable HuggingFace API lookups'))

    .action((projectNameArgs, options) => {
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

        // Partition options into groups by flag prefix/purpose
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
            if (['--skip-prompts', '--auto-prompt', '--config', '--project-name', '--project-dir', '--force', '--version', '--help'].includes(long)) {
                groups.general.push(opt);
            } else if (['--deployment-config', '--framework', '--model-format', '--model-name', '--model-server', '--base-image'].includes(long)) {
                groups.model.push(opt);
            } else if (['--deployment-target', '--instance-type', '--region', '--role-arn', '--build-target', '--codebuild-compute-type'].includes(long)) {
                groups.infra.push(opt);
            } else if (long.startsWith('--endpoint-')) {
                groups.endpoint.push(opt);
            } else if (long.startsWith('--ic-')) {
                groups.ic.push(opt);
            } else if (long.startsWith('--async-')) {
                groups.async.push(opt);
            } else if (long.startsWith('--batch-')) {
                groups.batch.push(opt);
            } else if (long.startsWith('--hyperpod-') || long === '--fsx-volume-handle') {
                groups.hyperpod.push(opt);
            } else if (['--model-env', '--server-env'].includes(long)) {
                groups.env.push(opt);
            } else if (['--hf-token', '--hf-token-arn', '--ngc-token', '--ngc-token-arn'].includes(long)) {
                groups.auth.push(opt);
            } else if (['--include-sample', '--include-testing', '--test-types', '--enable-lora', '--max-loras', '--max-lora-rank'].includes(long)) {
                groups.features.push(opt);
            } else if (['--smart', '--discover'].includes(long)) {
                groups.mcp.push(opt);
            } else if (['--validate-env-vars', '--validate-with-docker', '--offline', '--no-validate'].includes(long)) {
                groups.validation.push(opt);
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
    .description('Set up AWS infrastructure (IAM role, ECR repo, S3 buckets)')
    .passThroughOptions()
    .argument('[action]', 'Bootstrap action (status, use, list, remove, scan, prune, update, sync-schemas)')
    .argument('[args...]', 'Additional arguments')
    .option('--profile <profile>', 'AWS profile name')
    .option('--region <region>', 'AWS region')
    .option('--role-arn <arn>', 'Existing IAM role ARN to use')
    .option('--non-interactive', 'Run without prompts (requires --profile and --region)')
    .option('--force', 'Force removal without confirmation')
    .option('--verify', 'Verify resources exist (for status)')
    .option('--delete-stack', 'Delete CloudFormation stack on remove')
    .option('--ignore-staleness', 'Suppress schema staleness warnings')
    .option('--ci', 'Provision CI integration infrastructure')
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

program.parse();
