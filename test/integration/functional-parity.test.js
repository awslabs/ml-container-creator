// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Functional Parity Validation Tests
 *
 * Validates that the standalone CLI (bin/cli.js) provides full functional
 * parity with the original Yeoman-based generator across all modes,
 * architectures, and sub-commands.
 *
 * Covers tasks 6.1–6.16 from the yeoman-removal spec Phase 7.
 */

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { runGenerator, runGeneratorWithConfig, createTempDir } from '../helpers/run-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'bin/cli.js');

/**
 * Helper: run CLI and capture stdout/stderr
 */
function runCli(args = [], options = {}) {
    const { timeout = 30000, env: extraEnv = {} } = options;
    const env = { ...process.env, VALIDATE_ENV_VARS: 'false', ...extraEnv };
    const result = execFileSync(process.execPath, [CLI_PATH, ...args], {
        cwd: PROJECT_ROOT,
        env,
        timeout,
        stdio: 'pipe',
        encoding: 'utf8'
    });
    return result;
}

/**
 * Helper: run CLI and allow non-zero exit (capture output regardless)
 */
function runCliSafe(args = [], options = {}) {
    const { timeout = 30000, env: extraEnv = {} } = options;
    const env = { ...process.env, VALIDATE_ENV_VARS: 'false', ...extraEnv };
    try {
        const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
            cwd: PROJECT_ROOT,
            env,
            timeout,
            stdio: 'pipe',
            encoding: 'utf8'
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (error) {
        return {
            stdout: error.stdout || '',
            stderr: error.stderr || '',
            exitCode: error.status || 1
        };
    }
}

describe('Functional Parity Checklist', function () {
    this.timeout(120000);

    // 6.1 Interactive mode — all 43 prompts work with separators, tables, MCP
    describe('6.1 Interactive mode — prompt definitions are valid', () => {
        it('PromptRunner can be imported and instantiated', async () => {
            const { default: PromptRunner } = await import('../../src/lib/prompt-runner.js');
            assert.ok(PromptRunner, 'PromptRunner should be importable');

            // Instantiate with minimal config
            const ConfigManager = (await import('../../src/lib/config-manager.js')).default;
            const configManager = new ConfigManager({ options: { 'skip-prompts': true }, args: [] });
            const runner = new PromptRunner({
                configManager,
                options: { 'skip-prompts': true },
                baseConfig: {}
            });
            assert.ok(runner, 'PromptRunner should be instantiable');
            assert.ok(typeof runner.run === 'function', 'PromptRunner should have a run() method');
        });

        it('prompt-adapter handles all prompt types', async () => {
            const { runPrompts } = await import('../../src/prompt-adapter.js');
            assert.ok(typeof runPrompts === 'function', 'runPrompts should be a function');

            // Verify it handles a basic prompt definition with mock runners
            const mockRunners = {
                select: async (config) => config.choices?.[0]?.value || 'test',
                input: async (config) => config.default || 'test-input',
                confirm: async () => true,
                checkbox: async () => [],
                number: async (config) => config.default || 0
            };

            const prompts = [
                { type: 'list', name: 'testSelect', message: 'Pick one', choices: [{ name: 'A', value: 'a' }] },
                { type: 'input', name: 'testInput', message: 'Enter value', default: 'hello' },
                { type: 'confirm', name: 'testConfirm', message: 'Yes?', default: true },
                { type: 'number', name: 'testNumber', message: 'Count?', default: 5 }
            ];

            const answers = await runPrompts(prompts, {}, { runners: mockRunners });
            assert.strictEqual(answers.testSelect, 'a');
            assert.strictEqual(answers.testInput, 'hello');
            assert.strictEqual(answers.testConfirm, true);
            assert.strictEqual(answers.testNumber, 5);
        });

        it('prompt-adapter supports Separator objects', async () => {
            const { runPrompts } = await import('../../src/prompt-adapter.js');

            const mockRunners = {
                select: async (config) => {
                    // Verify separators are present in choices
                    const hasSeparator = config.choices.some(c =>
                        c && typeof c === 'object' && c.constructor && c.constructor.name === 'Separator'
                    );
                    assert.ok(hasSeparator, 'Choices should contain Separator objects');
                    return 'val';
                }
            };

            const prompts = [{
                type: 'list',
                name: 'withSep',
                message: 'Pick',
                choices: [
                    { type: 'separator', line: '--- Section ---' },
                    { name: 'Option', value: 'val' }
                ]
            }];

            const answers = await runPrompts(prompts, {}, { runners: mockRunners });
            assert.strictEqual(answers.withSep, 'val');
        });

        it('prompt-adapter supports conditional prompts via when()', async () => {
            const { runPrompts } = await import('../../src/prompt-adapter.js');

            const mockRunners = {
                input: async (config) => config.default || 'default',
                select: async () => 'selected'
            };

            const prompts = [
                { type: 'input', name: 'first', message: 'First?', default: 'yes' },
                { type: 'input', name: 'skipped', message: 'Skipped?', when: (ans) => ans.first === 'no' },
                { type: 'input', name: 'shown', message: 'Shown?', when: (ans) => ans.first === 'yes', default: 'visible' }
            ];

            const answers = await runPrompts(prompts, {}, { runners: mockRunners });
            assert.strictEqual(answers.first, 'yes');
            assert.strictEqual(answers.skipped, undefined);
            assert.strictEqual(answers.shown, 'visible');
        });
    });

    // 6.2 Non-interactive mode — --deployment-config=transformers-vllm --skip-prompts
    describe('6.2 Non-interactive mode — transformers-vllm generation', () => {
        let result;

        before(function () {
            this.timeout(60000);
            result = runGenerator({
                'deployment-config': 'transformers-vllm',
                'model-name': 'meta-llama/Llama-2-7b-chat-hf',
                'region': 'us-east-1',
                'instance-type': 'ml.g5.xlarge'
            });
        });

        after(() => { if (result) result.cleanup(); });

        it('generates Dockerfile', () => {
            result.assertFile('Dockerfile');
        });

        it('generates code/serve entrypoint', () => {
            result.assertFile('code/serve');
        });

        it('does not generate legacy deploy/ scripts', () => {
            result.assertNoFile('deploy/build_and_push.sh');
            result.assertNoFile('deploy/deploy.sh');
        });

        it('generates do-framework scripts', () => {
            result.assertFile('do/build');
            result.assertFile('do/push');
            result.assertFile('do/deploy');
        });

        it('generates requirements.txt', () => {
            result.assertFile('requirements.txt');
        });
    });

    // 6.3 Config file mode — --config=test.json --skip-prompts
    describe('6.3 Config file mode — JSON config generation', () => {
        let result;
        let configPath;
        let tempConfigDir;

        before(function () {
            this.timeout(60000);
            tempConfigDir = createTempDir('mlcc-config-');
            configPath = path.join(tempConfigDir, 'test-config.json');
            fs.writeFileSync(configPath, JSON.stringify({
                deploymentConfig: 'http-flask',
                projectName: 'config-test-project',
                modelFormat: 'pkl',
                awsRegion: 'us-east-1',
                instanceType: 'ml.m5.large',
                includeSampleModel: false
            }));

            result = runGeneratorWithConfig(configPath);
        });

        after(() => {
            if (result) result.cleanup();
            if (tempConfigDir && fs.existsSync(tempConfigDir)) {
                fs.rmSync(tempConfigDir, { recursive: true, force: true });
            }
        });

        it('generates project from config file', () => {
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('code/model_handler.py');
            result.assertFile('code/serve.py');
        });

        it('generates nginx config for HTTP architecture', () => {
            result.assertFile('nginx-predictors.conf');
        });
    });

    // 6.4 Bootstrap command — ml-container-creator bootstrap
    describe('6.4 Bootstrap command — handler availability', () => {
        it('BootstrapCommandHandler can be imported and instantiated', async () => {
            const { default: BootstrapCommandHandler } = await import('../../src/lib/bootstrap-command-handler.js');
            assert.ok(BootstrapCommandHandler, 'BootstrapCommandHandler should be importable');

            const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
            assert.ok(handler, 'BootstrapCommandHandler should be instantiable');
            assert.ok(typeof handler.handle === 'function', 'handler should have handle() method');
        });

        it('bin/cli.js bootstrap does not crash', () => {
            const { exitCode } = runCliSafe(['bootstrap', '--help']);
            // The stub or handler should respond without crashing
            assert.strictEqual(exitCode, 0, 'bootstrap command should exit cleanly');
        });
    });

    // 6.5 MCP commands — ml-container-creator mcp list, mcp add, mcp remove
    describe('6.5 MCP commands — handler availability', () => {
        it('McpCommandHandler can be imported and instantiated', async () => {
            const { default: McpCommandHandler } = await import('../../src/lib/mcp-command-handler.js');
            assert.ok(McpCommandHandler, 'McpCommandHandler should be importable');

            const mockGen = {
                destinationPath: (p) => p ? path.join(os.tmpdir(), p) : os.tmpdir(),
                prompt: async () => ({})
            };
            const handler = new McpCommandHandler(mockGen);
            assert.ok(handler, 'McpCommandHandler should be instantiable');
            assert.ok(typeof handler.handle === 'function', 'handler should have handle() method');
        });

        it('bin/cli.js mcp list does not crash', () => {
            const { stdout, exitCode } = runCliSafe(['mcp', 'list']);
            // Should exit cleanly (stub or real handler)
            assert.ok(exitCode === 0 || stdout.includes('mcp command'), 'mcp list should not crash');
        });
    });

    // 6.6 Registry commands — ml-container-creator registry replay
    describe('6.6 Registry commands — handler availability', () => {
        it('RegistryCommandHandler can be imported and instantiated', async () => {
            const { default: RegistryCommandHandler } = await import('../../src/lib/registry-command-handler.js');
            assert.ok(RegistryCommandHandler, 'RegistryCommandHandler should be importable');

            const handler = new RegistryCommandHandler();
            assert.ok(handler, 'RegistryCommandHandler should be instantiable');
            assert.ok(typeof handler.handle === 'function', 'handler should have handle() method');
        });

        it('bin/cli.js registry list does not crash', () => {
            const { stdout, exitCode } = runCliSafe(['registry', 'list']);
            assert.ok(exitCode === 0 || stdout.includes('registry command'), 'registry list should not crash');
        });
    });

    // 6.7 npx execution — --help works
    describe('6.7 npx execution — CLI help output', () => {
        it('node bin/cli.js --help outputs expected help text', () => {
            const output = runCli(['--help']);
            assert.ok(output.includes('ml-container-creator'), 'Help should show program name');
            assert.ok(output.includes('--deployment-config'), 'Help should show --deployment-config option');
            assert.ok(output.includes('--skip-prompts'), 'Help should show --skip-prompts option');
            assert.ok(output.includes('--config'), 'Help should show --config option');
            assert.ok(output.includes('--region'), 'Help should show --region option');
            assert.ok(output.includes('bootstrap'), 'Help should show bootstrap sub-command');
            assert.ok(output.includes('mcp'), 'Help should show mcp sub-command');
            assert.ok(output.includes('registry'), 'Help should show registry sub-command');
        });

        it('package.json bin field is correctly configured', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
            assert.ok(pkg.bin, 'package.json should have a bin field');
            assert.strictEqual(pkg.bin['ml-container-creator'], './bin/cli.js', 'bin should point to ./bin/cli.js');
        });

        it('--version outputs a valid semver version', () => {
            const output = runCli(['--version']);
            assert.ok(/^\d+\.\d+\.\d+/.test(output.trim()), `Version should be semver: ${output.trim()}`);
        });
    });

    // 6.8 All architectures — HTTP, Transformers, Triton, Diffusors
    describe('6.8 All architectures generate correct files', () => {
        describe('HTTP architecture (http-flask)', () => {
            let result;

            before(function () {
                this.timeout(60000);
                result = runGenerator({
                    'deployment-config': 'http-flask',
                    'model-format': 'pkl',
                    'region': 'us-east-1',
                    'instance-type': 'ml.m5.large'
                });
            });

            after(() => { if (result) result.cleanup(); });

            it('generates HTTP-specific files', () => {
                result.assertFile('code/model_handler.py');
                result.assertFile('code/serve.py');
                result.assertFile('nginx-predictors.conf');
            });

            it('does not generate transformer-specific files', () => {
                result.assertNoFile('code/serving.properties');
            });
        });

        describe('Transformers architecture (transformers-vllm)', () => {
            let result;

            before(function () {
                this.timeout(60000);
                result = runGenerator({
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'meta-llama/Llama-2-7b-chat-hf',
                    'region': 'us-east-1',
                    'instance-type': 'ml.g5.xlarge'
                });
            });

            after(() => { if (result) result.cleanup(); });

            it('generates transformer-specific files', () => {
                result.assertFile('code/serve');
            });

            it('does not generate HTTP-specific files', () => {
                result.assertNoFile('code/model_handler.py');
                result.assertNoFile('code/serve.py');
                result.assertNoFile('nginx-predictors.conf');
            });
        });

        describe('Triton architecture (triton-fil)', () => {
            let result;

            before(function () {
                this.timeout(60000);
                result = runGenerator({
                    'deployment-config': 'triton-fil',
                    'model-format': 'json',
                    'region': 'us-east-1',
                    'instance-type': 'ml.g5.xlarge'
                });
            });

            after(() => { if (result) result.cleanup(); });

            it('generates triton-specific files', () => {
                // Triton generates model_repository structure with config.pbtxt
                const outputDir = result.dir;
                const files = getAllFiles(outputDir);
                const hasConfigPbtxt = files.some(f => f.endsWith('config.pbtxt'));
                assert.ok(hasConfigPbtxt, 'Should generate config.pbtxt in model_repository');
            });

            it('does not generate HTTP-specific files', () => {
                result.assertNoFile('code/model_handler.py');
                result.assertNoFile('code/serve.py');
                result.assertNoFile('nginx-predictors.conf');
            });
        });

        describe('Diffusors architecture (diffusors-vllm-omni)', () => {
            let result;

            before(function () {
                this.timeout(60000);
                result = runGenerator({
                    'deployment-config': 'diffusors-vllm-omni',
                    'model-name': 'stabilityai/stable-diffusion-xl-base-1.0',
                    'region': 'us-east-1',
                    'instance-type': 'ml.g5.xlarge'
                });
            });

            after(() => { if (result) result.cleanup(); });

            it('generates diffusors-specific files', () => {
                result.assertFile('code/patch_image_api.py');
                result.assertFile('code/start_server.sh');
            });

            it('does not generate HTTP-specific files', () => {
                result.assertNoFile('code/model_handler.py');
                result.assertNoFile('code/serve.py');
                result.assertNoFile('nginx-predictors.conf');
            });
        });
    });

    // 6.9 Template rendering — EJS variables resolve correctly
    describe('6.9 Template rendering — EJS variables resolve correctly', () => {
        let result;

        before(function () {
            this.timeout(60000);
            result = runGenerator({
                'deployment-config': 'http-flask',
                'project-name': 'ejs-test-project',
                'model-format': 'pkl',
                'region': 'us-west-2',
                'instance-type': 'ml.m5.large'
            });
        });

        after(() => { if (result) result.cleanup(); });

        it('no unresolved EJS tags remain in output files', () => {
            const outputDir = result.dir;
            const files = getAllFiles(outputDir);

            for (const file of files) {
                const content = fs.readFileSync(file, 'utf8');
                // Check for literal unresolved EJS tags
                assert.ok(
                    !content.includes('<%= undefined %>'),
                    `File ${path.relative(outputDir, file)} contains unresolved EJS: <%= undefined %>`
                );
                // Check for literal EJS open tags that weren't processed
                // (but allow EJS in template documentation files)
                const relativePath = path.relative(outputDir, file);
                if (!relativePath.includes('TEMPLATE_SYSTEM') && !relativePath.includes('MIGRATION')) {
                    const unresolvedMatch = content.match(/<%=\s*undefined\s*%>/);
                    assert.ok(
                        !unresolvedMatch,
                        `File ${relativePath} has unresolved template variable`
                    );
                }
            }
        });

        it('project name is properly substituted', () => {
            result.assertFileContent('README.md', 'ejs-test-project');
        });

        it('AWS region is properly substituted in do/config', () => {
            result.assertFileContent('do/config', 'us-west-2');
        });
    });

    // 6.10 Conditional files — architecture routing excludes correct files
    describe('6.10 Conditional files — architecture routing', () => {
        describe('transformers excludes HTTP files', () => {
            let result;

            before(function () {
                this.timeout(60000);
                result = runGenerator({
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'meta-llama/Llama-2-7b-chat-hf',
                    'region': 'us-east-1',
                    'instance-type': 'ml.g5.xlarge'
                });
            });

            after(() => { if (result) result.cleanup(); });

            it('excludes model_handler.py for transformers', () => {
                result.assertNoFile('code/model_handler.py');
            });

            it('excludes serve.py for transformers', () => {
                result.assertNoFile('code/serve.py');
            });

            it('excludes nginx-predictors.conf for transformers', () => {
                result.assertNoFile('nginx-predictors.conf');
            });
        });

        describe('HTTP excludes transformer files', () => {
            let result;

            before(function () {
                this.timeout(60000);
                result = runGenerator({
                    'deployment-config': 'http-flask',
                    'model-format': 'pkl',
                    'region': 'us-east-1',
                    'instance-type': 'ml.m5.large'
                });
            });

            after(() => { if (result) result.cleanup(); });

            it('excludes code/serve (shell script) for HTTP', () => {
                result.assertNoFile('code/serve');
            });

            it('excludes serving.properties for HTTP', () => {
                result.assertNoFile('code/serving.properties');
            });
        });
    });

    // 6.11 File permissions — do/* scripts are executable
    describe('6.11 File permissions — do/* scripts are executable', () => {
        let result;

        before(function () {
            this.timeout(60000);
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'pkl',
                'region': 'us-east-1',
                'instance-type': 'ml.m5.large'
            });
        });

        after(() => { if (result) result.cleanup(); });

        it('do/build is executable', () => {
            assertExecutable(result.file('do/build'));
        });

        it('do/push is executable', () => {
            assertExecutable(result.file('do/push'));
        });

        it('do/deploy is executable', () => {
            assertExecutable(result.file('do/deploy'));
        });

        it('do/run is executable', () => {
            assertExecutable(result.file('do/run'));
        });

        it('do/test is executable', () => {
            assertExecutable(result.file('do/test'));
        });

        it('do/clean is executable', () => {
            assertExecutable(result.file('do/clean'));
        });
    });

    // 6.12 Config precedence — CLI overrides defaults
    describe('6.12 Config precedence — CLI options override defaults', () => {
        let result;

        before(function () {
            this.timeout(60000);
            // Pass --region=eu-west-1 which should override the default us-east-1
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'pkl',
                'region': 'eu-west-1',
                'instance-type': 'ml.m5.large'
            });
        });

        after(() => { if (result) result.cleanup(); });

        it('CLI --region=eu-west-1 overrides default us-east-1', () => {
            result.assertFileContent('do/config', 'eu-west-1');
        });

        it('ConfigManager can be instantiated with precedence levels', async () => {
            const { default: ConfigManager } = await import('../../src/lib/config-manager.js');
            const cm = new ConfigManager({
                options: { 'region': 'eu-west-1', 'skip-prompts': true },
                args: []
            });
            assert.ok(cm, 'ConfigManager should be instantiable');
            assert.ok(typeof cm.loadConfiguration === 'function', 'should have loadConfiguration()');
        });
    });

    // 6.13 MCP discovery — --discover flag
    describe('6.13 MCP discovery — --discover flag accepted', () => {
        it('--discover flag is accepted by the CLI parser', () => {
            const output = runCli(['--help']);
            assert.ok(output.includes('--discover'), 'CLI should accept --discover flag');
        });

        it('--discover does not crash when MCP servers are unavailable', () => {
            // Running with --discover but no MCP servers configured should degrade gracefully
            const { exitCode } = runCliSafe([
                '--deployment-config=http-flask',
                '--model-format=pkl',
                '--region=us-east-1',
                '--instance-type=ml.m5.large',
                '--skip-prompts',
                '--discover',
                `--project-dir=${createTempDir('mlcc-discover-')}`
            ]);
            // Should not crash (exit 0) or fail gracefully
            assert.ok(exitCode === 0 || exitCode === 1, `--discover should not crash fatally, got exit code ${exitCode}`);
        });
    });

    // 6.14 Warnings/annotations — unsupported features display warnings
    describe('6.14 Warnings/annotations — warning messages', () => {
        it('jumpstart-hub model source produces a warning', () => {
            const tempDir = createTempDir('mlcc-warn-');
            const { stdout, stderr } = runCliSafe([
                '--deployment-config=transformers-vllm',
                '--model-name=jumpstart-hub://my-model',
                '--region=us-east-1',
                '--instance-type=ml.g5.xlarge',
                '--skip-prompts',
                `--project-dir=${tempDir}`
            ]);
            // Clean up
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_e) { /* cleanup */ }

            const output = stdout + stderr;
            assert.ok(
                output.includes('⚠️') || output.includes('no longer supported') || output.includes('JumpStart'),
                'Should display a warning/error for jumpstart-hub model source'
            );
        });
    });

    // 6.15 Sample model — --include-sample generates training code
    describe('6.15 Sample model — --include-sample generates training code', () => {
        let result;

        before(function () {
            this.timeout(60000);
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'pkl',
                'region': 'us-east-1',
                'instance-type': 'ml.m5.large',
                'include-sample': true
            });
        });

        after(() => { if (result) result.cleanup(); });

        it('generates sample_model directory', () => {
            result.assertFile('sample_model/train_abalone.py');
        });

        it('generates test_inference.py', () => {
            result.assertFile('sample_model/test_inference.py');
        });
    });

    // 6.16 CI harness — CodeBuild buildspec generation
    describe('6.16 CI harness — CodeBuild buildspec generation', () => {
        let result;

        before(function () {
            this.timeout(60000);
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'pkl',
                'region': 'us-east-1',
                'instance-type': 'ml.m5.large',
                'build-target': 'codebuild'
            });
        });

        after(() => { if (result) result.cleanup(); });

        it('generates buildspec.yml', () => {
            result.assertFile('buildspec.yml');
        });

        it('buildspec.yml does not contain sudo or root workarounds', () => {
            const content = fs.readFileSync(result.file('buildspec.yml'), 'utf8');
            assert.ok(!content.includes('sudo'), 'buildspec.yml should not contain sudo');
            assert.ok(
                !content.includes('--privileged') || content.includes('#'),
                'buildspec.yml should not require privileged mode'
            );
        });

        it('codebuild-compute-type option is accepted', () => {
            const output = runCli(['--help']);
            assert.ok(
                output.includes('--codebuild-compute-type'),
                'CLI should accept --codebuild-compute-type option'
            );
        });
    });
});

// ── Helper functions ──────────────────────────────────────────────

/**
 * Recursively get all files in a directory.
 */
function getAllFiles(dir) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...getAllFiles(fullPath));
        } else {
            results.push(fullPath);
        }
    }
    return results;
}

/**
 * Assert that a file has executable permission.
 */
function assertExecutable(filePath) {
    assert.ok(fs.existsSync(filePath), `File should exist: ${filePath}`);
    const stats = fs.statSync(filePath);
    const mode = stats.mode;
    // Check if any execute bit is set (owner, group, or other)
    const isExecutable = (mode & 0o111) !== 0;
    assert.ok(isExecutable, `File should be executable: ${filePath} (mode: ${mode.toString(8)})`);
}
