// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { copyTpl } from './copy-tpl.js';
import { runPrompts } from './prompt-adapter.js';
import ConfigManager from './lib/config-manager.js';
import PromptRunner from './lib/prompt-runner.js';
import TemplateManager from './lib/template-manager.js';
import DeploymentConfigResolver from './lib/deployment-config-resolver.js';
import CommentGenerator from './lib/comment-generator.js';
import RegistryConfigManager from './lib/registry-config-manager.js';
import RegistryLoader from './lib/registry-loader.js';
import { resolvePrefixedEnvVars } from './lib/engine-prefix-resolver.js';
import { isMarketplaceConfig, isMarketplaceModelName, refuseMarketplaceAndExit } from './lib/marketplace-refusal.js';
import { readEnvVarPrefix, resolveEngineFeatureVars } from './lib/serve-manifest-reader.js';
import { isLlm as tritonIsLlm, isKnownBackend as isTritonBackend } from './lib/triton-backend-reader.js';
import {
    listPredictorFrameworks,
    pipDependencies as predictorPipDependencies,
    testPayload as predictorTestPayload,
    handlerPath as predictorHandlerPath
} from './lib/predictor-manifest-reader.js';
import { _ensureTemplateVariables, _validateEnvironmentVariables } from './lib/template-variable-resolver.js';
import ejs from 'ejs';
import { globSync } from 'tinyglobby';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(GENERATOR_ROOT, 'templates');
const LIB_DIR = path.join(GENERATOR_ROOT, 'src', 'lib');

/**
 * Main application entry point.
 * Orchestrates the ML Container Creator generation workflow,
 * replicating the original generator lifecycle phases:
 * initializing → prompting → writing → end
 *
 * @param {string|undefined} projectName - Name for the generated project (from positional argument)
 * @param {object} options - Parsed CLI options from commander
 */
export async function run(projectName, options) {
    // --- Phase: Initializing ---
    // Convert commander's camelCase options to kebab-case for ConfigManager compatibility
    // (ConfigManager expects kebab-case format for option keys)
    const kebabOptions = _toKebabCaseOptions(options);

    // Hard-refuse marketplace deployments (deprecated — see marketplace-refusal.js).
    // Detected from either the requested deployment config or a marketplace:// model
    // name, as the very first step so every path (skip-prompts, auto-prompt, full
    // prompt) refuses uniformly with a non-zero exit. Mirrors the JumpStart precedent.
    if (isMarketplaceConfig(kebabOptions['deployment-config']) ||
        isMarketplaceModelName(kebabOptions['model-name'])) {
        refuseMarketplaceAndExit();
    }

    // Build a lightweight adapter that satisfies ConfigManager's generator interface
    const generatorAdapter = _createGeneratorAdapter(projectName, kebabOptions);
    const args = projectName ? [projectName] : [];

    const configManager = new ConfigManager({ options: kebabOptions, args });

    let baseConfig;
    try {
        baseConfig = await configManager.loadConfiguration();
    } catch (error) {
        console.log(`⚠️  ${error.message}`);
        return;
    }

    // Re-check against the RESOLVED config (config file / env), not just CLI options,
    // so a marketplace deployment requested through any source is refused uniformly.
    const explicitConfig = configManager.getExplicitConfiguration();
    if (isMarketplaceConfig(explicitConfig.deploymentConfig) ||
        isMarketplaceModelName(explicitConfig.modelName)) {
        refuseMarketplaceAndExit();
    }

    const errors = configManager.validateConfiguration();
    if (errors.length > 0) {
        console.log(`⚠️  ${errors[0]}`);
        return;
    }

    // Initialize registry system
    let registryConfigManager = null;
    let tritonBackends = {};
    try {
        const validateEnvVars = kebabOptions['validate-env-vars'] !== false;
        const validateWithDocker = kebabOptions['validate-with-docker'] === true;
        const offline = kebabOptions['offline'] === true;

        let effectiveValidateWithDocker = validateWithDocker;
        if (validateWithDocker && !validateEnvVars) {
            console.log('\n⚠️  Warning: --validate-with-docker requires --validate-env-vars to be enabled');
            console.log('   Docker validation will be disabled');
            effectiveValidateWithDocker = false;
        }

        registryConfigManager = new RegistryConfigManager({
            validateEnvVars,
            validateWithDocker: effectiveValidateWithDocker,
            offline,
            hfTimeout: 5000
        });

        await registryConfigManager.loadRegistries();

        const registryLoader = new RegistryLoader();
        tritonBackends = await registryLoader.loadTritonBackends();

        console.log('\n📚 Registry System Initialized');
        console.log('   • Framework Registry: Loaded');
        console.log('   • Model Registry: Loaded');
        console.log('   • Instance Accelerator Mapping: Loaded');

        if (validateEnvVars) {
            console.log('   • Environment Variable Validation: Enabled');
            if (effectiveValidateWithDocker) {
                console.log('   • Docker Introspection Validation: Enabled (experimental)');
            }
        } else {
            console.log('   • Environment Variable Validation: Disabled');
        }

        if (offline) {
            console.log('   • HuggingFace API: Offline mode');
        }
    } catch (error) {
        console.log('\n⚠️  Registry system initialization failed, using defaults');
        console.log(`   Error: ${error.message}`);
        registryConfigManager = null;
        tritonBackends = {};
    }

    // Attach registry info to the adapter so PromptRunner can access it
    generatorAdapter.registryConfigManager = registryConfigManager;
    generatorAdapter.configManager = configManager;
    generatorAdapter.baseConfig = baseConfig;

    // --- Phase: Prompting ---
    let answers;
    if (configManager.shouldSkipPrompts()) {
        console.log('\n🚀 Skipping prompts - using configuration from other sources');

        // Fail-fast if required parameters are missing
        const missing = configManager.getMissingRequiredParameters();
        if (missing.length > 0) {
            console.error('\n❌ Cannot skip prompts — required parameters are missing:\n');
            for (const param of missing) {
                const matrix = configManager._getParameterMatrix()[param];
                const cliFlag = matrix?.cliOption ? `--${matrix.cliOption}` : '';
                const envVar = matrix?.envVar || '';
                const hints = [cliFlag, envVar].filter(Boolean).join(' or ');
                console.error(`   • ${param}${hints ? ` (${hints})` : ''}`);
            }
            console.error('\n   Provide these via CLI flags, environment variables, or a config file.');
            console.error('   Run "ml-container-creator --help" for available options.\n');
            process.exit(1);
        }

        answers = configManager.getFinalConfiguration();

        // FR-1.7, FR-1.8: Ensure deployment defaults for skip-prompts mode.
        // deploymentTarget defaults to 'realtime-inference' from parameter-matrix.
        // If instanceType is not explicitly provided, auto-size from architecture heuristic.
        if (!answers.deploymentTarget) {
            answers.deploymentTarget = 'realtime-inference';
        }
        if (!answers.instanceType) {
            // Use architecture-based heuristic: transformers/diffusors → GPU, predictor/http → CPU
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const HEURISTIC_DEFAULTS = {
                'transformers': 'ml.g5.xlarge',
                'diffusors': 'ml.g5.2xlarge',
                'predictor': 'ml.m5.large',
                'http': 'ml.m5.large'
            };
            answers.instanceType = HEURISTIC_DEFAULTS[architecture] || 'ml.g5.xlarge';
            console.log(`   • Instance type auto-sized: ${answers.instanceType} (from architecture: ${architecture || 'default'})`);
        }

        // Infer modelSource from model name prefix if not set
        const modelName = answers.modelName;
        if (!answers.modelSource && modelName) {
            // Reject deprecated JumpStart prefixes with migration message
            if (modelName.startsWith('jumpstart://') || modelName.startsWith('jumpstart-hub://')) {
                const bareId = modelName.replace(/^jumpstart(-hub)?:\/\//, '');
                console.error(`\n   ⚠️  JumpStart is no longer supported. Use the HuggingFace model ID directly: ${bareId}`);
                console.error('   JumpStart model sources have been removed. Use one of:');
                console.error('     • HuggingFace model ID (e.g., meta-llama/Llama-2-7b-hf)');
                console.error('     • s3://bucket/path/model.tar.gz');
                console.error('     • registry://model-package-name\n');
                process.exit(1);
            }
            if (modelName.startsWith('s3://')) {
                answers.modelSource = 's3';
                if (!answers.artifactUri) {
                    answers.artifactUri = modelName;
                }
            } else if (modelName.startsWith('registry://')) {
                answers.modelSource = 'registry';
            }
        }

        // Note about registry model requirements
        if (answers.modelSource === 'registry') {
            console.log('\n   ℹ️  Registry model: the container will resolve the artifact URI at startup');
            console.log('   via DescribeModelPackage. Ensure the model package has a valid');
            console.log('   InferenceSpecification with ModelDataUrl or S3DataSource.');
            console.log('   If your model package lacks an InferenceSpecification, use the S3 path');
            console.log('   directly instead: --model-name="s3://bucket/path/model.tar.gz"\n');
        }
    } else if (configManager.isAutoPrompt()) {
        // Auto-prompt mode: run the wizard with all resolved values pre-filled.
        // The wizard skips prompts for values already in explicitConfig and
        // uses phase-level gates to skip irrelevant sections entirely.
        // This gives context-aware prompting (correct MCP queries, filtered choices)
        // while only asking for what's truly missing.
        console.log('\n🔄 Auto-prompt mode — prompting only for missing values with full context');

        const promptRunner = new PromptRunner({
            configManager,
            options: kebabOptions,
            registryConfigManager,
            baseConfig
        });
        const promptAnswers = await promptRunner.run();
        answers = configManager.getFinalConfiguration(promptAnswers);
    } else {
        const promptRunner = new PromptRunner({
            configManager,
            options: kebabOptions,
            registryConfigManager,
            baseConfig
        });
        const promptAnswers = await promptRunner.run();
        answers = configManager.getFinalConfiguration(promptAnswers);
    }

    // Ensure template variables have defaults and enrich with registry data
    await _ensureTemplateVariables(answers, registryConfigManager);

    // --- Phase: DLC Resolution (--no-build mode) ---
    if (answers.no_build) {
        const { resolveDlcImage } = await import('./lib/dlc-resolver.js');

        // If existing endpoint, resolve instance type from live endpoint
        const instanceType = answers.instanceType;
        if (answers.existingEndpointName && !instanceType) {
            // Instance type must be resolved before DLC selection
            console.log('\n⚠️  --no-build with --existing-endpoint requires instance type for DLC image selection.');
            console.log('   Provide --instance-type or ensure the endpoint is resolvable.');
            // Fallback: require user to specify instance type
            if (!instanceType) {
                console.log('\n❌ Cannot resolve DLC image without instance type.');
                console.log('   Use: --instance-type ml.g5.xlarge (or similar)');
                process.exit(1);
            }
        }

        try {
            const dlcUri = await resolveDlcImage({
                framework: answers.framework,
                model_server: answers.modelServer || answers.backend,
                instance_type: instanceType,
                region: answers.region || answers.awsRegion || 'us-east-1',
                accelerator: 'gpu',
                model_architecture: answers.modelArchitecture || ''
            });
            answers.container_image_uri = dlcUri;
            answers.deploy_mode = 'dlc-direct';
            console.log(`\n✅ DLC image resolved: ${dlcUri}`);
        } catch (err) {
            if (err.name === 'DlcResolutionError') {
                console.log(`\n❌ DLC Resolution Failed: ${err.message}`);
                if (err.availableOptions.length > 0) {
                    console.log('\n   Available images (incompatible with your instance):');
                    err.availableOptions.slice(0, 5).forEach(opt => console.log(`     • ${opt}`));
                }
                console.log('\n   Suggestion: Use custom-container mode (omit --no-build) for this instance type.');
                process.exit(1);
            }
            throw err;
        }
    }

    // --- Phase: Writing ---
    const destDir = path.resolve(answers.destinationDir);

    // Safety guard: refuse to generate into the generator's own directory
    const destPkgPath = path.join(destDir, 'package.json');
    if (fs.existsSync(destPkgPath)) {
        try {
            const destPkg = JSON.parse(fs.readFileSync(destPkgPath, 'utf8'));
            if (destPkg.name === '@aws/ml-container-creator') {
                console.log('\n❌ Refusing to generate into the generator\'s own directory.');
                console.log('   This would overwrite the generator source files.');
                console.log('   Use --project-dir or provide a project name instead.\n');
                return;
            }
        } catch {
            // If we can't read/parse package.json, it's not the generator dir — proceed
        }
    }

    fs.mkdirSync(destDir, { recursive: true });

    await writeProject(TEMPLATE_DIR, destDir, answers, registryConfigManager, tritonBackends, configManager);

    // --- Phase: End ---
    await postGenerate(destDir, answers, tritonBackends);

    console.log('\n✅ Project generated successfully!');
    console.log(`   📁 ${destDir}`);
}

/**
 * Writes the project files from templates to the destination directory.
 * Replicates the writing() phase of the original generator.
 *
 * @param {string} templateDir - Path to the template directory
 * @param {string} destDir - Path to the destination directory
 * @param {object} answers - Merged configuration answers
 * @param {object|null} registryConfigManager - Registry configuration manager (or null)
 * @param {object} tritonBackends - Triton backends catalog
 * @param {object|null} configManager - Configuration manager instance (or null)
 * @param {object} options - Optional generation options
 * @param {string[]} [options.skipTemplates] - Glob patterns of files to skip
 * @param {string[]} [options.onlyFiles] - Only write these exact output file paths
 * @param {boolean} [options.noGenerationParams] - Skip writing .mlcc-generation-params.json
 */
export async function writeProject(templateDir, destDir, answers, registryConfigManager = null, tritonBackends = {}, configManager = null, options = {}) {
    // Validate required parameters via ConfigManager
    if (configManager) {
        const requiredParamErrors = configManager.validateRequiredParameters(answers);
        if (requiredParamErrors.length > 0) {
            console.log('\n❌ Required Parameter Validation Failed:');
            requiredParamErrors.forEach(error => {
                console.log(`   • ${error}`);
            });
            console.log('\nPlease provide the missing required parameters and try again.');
            throw new Error('Required parameters are missing. Cannot proceed with file generation.');
        }
    }

    // Validate environment variables if registry system is available
    if (registryConfigManager && (answers.frameworkVersion || answers.architecture === 'triton')) {
        await _validateEnvironmentVariables(answers, registryConfigManager);
    }

    // Validate template configuration
    const templateManager = new TemplateManager(answers);
    templateManager.validate();

    // Generate comments for templates
    const commentGenerator = new CommentGenerator();
    const comments = commentGenerator.generateDockerfileComments(answers);

    // Prepare ordered environment variables
    const orderedEnvVars = _getOrderedEnvVars(answers.envVars || {});

    // Append model env vars and prefixed server env vars
    const modelEnvVars = answers.modelEnvVars || {};
    const serverEnvVars = answers.serverEnvVars || {};
    const engine = answers.modelServer || answers.backend || '';

    Object.entries(modelEnvVars).forEach(([key, value]) => {
        orderedEnvVars.push({ key, value });
    });

    const prefixedServerEnvVars = resolvePrefixedEnvVars(engine, serverEnvVars);
    Object.entries(prefixedServerEnvVars).forEach(([key, value]) => {
        orderedEnvVars.push({ key, value });
    });

    // Engine-specific features (ADR-004 §c): resolve each requested feature to the
    // engine's real env var and validate against the serve-plugin manifest's
    // engine_features. Reads the manifest generically — no engine-name branching.
    // The resolved env vars join orderedEnvVars so do/config (and the Dockerfile)
    // emit them identically to --server-env; the container reads them directly.
    const engineFeatureVars = answers.engineFeatureVars || {};
    if (Object.keys(engineFeatureVars).length > 0) {
        const { resolved, errors } = resolveEngineFeatureVars(engine, engineFeatureVars);
        if (errors.length > 0) {
            throw new Error(
                `Invalid --engine-feature value(s):\n   • ${errors.join('\n   • ')}`
            );
        }
        resolved.forEach(({ key, value }) => {
            orderedEnvVars.push({ key, value });
        });
    }

    // De-duplicate orderedEnvVars by key. The sources above are pushed in order of
    // increasing specificity (catalog/envVars → model-env → prefixed server-env →
    // engine-feature), so a later entry for the same key is the more deliberate
    // one and wins. Without this, two sources targeting the same engine var (e.g.
    // --engine-feature rolling_batch_backend=vllm → OPTION_ROLLING_BATCH=vllm AND
    // --server-env OPTION_ROLLING_BATCH=auto) would emit two conflicting `export`
    // lines into do/config and bash would silently take the last — order-dependent
    // and invisible. Collapse to one entry per key (last-wins) and warn when the
    // collision actually changed the value.
    const _dedupedEnvVars = [];
    const _envVarIndexByKey = new Map();
    for (const { key, value } of orderedEnvVars) {
        if (_envVarIndexByKey.has(key)) {
            const idx = _envVarIndexByKey.get(key);
            if (_dedupedEnvVars[idx].value !== value) {
                console.warn(
                    `⚠️  Multiple values for ${key}: using "${value}" (overrides "${_dedupedEnvVars[idx].value}"). ` +
                    'Set it once — via --engine-feature OR --server-env/--model-env, not both.'
                );
            }
            _dedupedEnvVars[idx] = { key, value };
        } else {
            _envVarIndexByKey.set(key, _dedupedEnvVars.length);
            _dedupedEnvVars.push({ key, value });
        }
    }
    orderedEnvVars.length = 0;
    orderedEnvVars.push(..._dedupedEnvVars);

    // Prepare template variables
    const templateVars = {
        ...answers,
        comments,
        orderedEnvVars,
        serverEnvVars: prefixedServerEnvVars
    };

    // BL107: inject the active engine's env-var prefix from its serve-layer
    // manifest (serve.d/<engine>/manifest.json). The serve wrappers read this
    // via <%= envVarPrefix %> instead of hardcoding e.g. PREFIX="SGLANG_", so the
    // prefix has a single source of truth (the manifest). Falls back to the
    // engine-prefix map for engines without a manifest, then to empty.
    templateVars.envVarPrefix = readEnvVarPrefix(engine) || '';

    // Predictor-framework plugin data (HTTP architecture): the per-framework pip
    // dependencies and the do/test payload come from the framework descriptor
    // (predictors.d/<framework>/manifest.json) via the reader, not from hardcoded
    // EJS branches. The framework is the `engine` answer (sklearn/xgboost/
    // tensorflow). Non-http architectures leave these empty (the templates guard
    // on length), and the per-framework handler is materialized separately in the
    // `http` routing branch below.
    const predictorFramework = answers.engine || '';
    templateVars.predictorPipDependencies = predictorFramework
        ? predictorPipDependencies(predictorFramework)
        : [];
    templateVars.predictorTestPayload = predictorFramework
        ? (predictorTestPayload(predictorFramework) || '')
        : '';

    // Add generator version to template vars so templates can embed it (e.g. MCC_VERSION in do/config)
    try {
        const { version } = JSON.parse(fs.readFileSync(path.join(GENERATOR_ROOT, 'package.json'), 'utf8'));
        templateVars.generatorVersion = version || '';
    } catch {
        templateVars.generatorVersion = '';
    }

    // Build ignore patterns
    const ignorePatterns = [];

    // EJS partials — included by templates at render time, not copied to output
    ignorePatterns.push('**/serve.d/**');

    // Predictor-framework plugins — descriptor + handler consumed at generation
    // time (the selected framework's handler is materialized into
    // code/model_handler.py by _materializePredictorHandler); the plugin tree
    // itself is never copied verbatim, mirroring serve.d. There is no
    // templates/code/model_handler.py source any more — the per-framework
    // predictors.d/<framework>/handler.py is the only source of the generated
    // code/model_handler.py.
    ignorePatterns.push('**/predictors.d/**');

    // Resolve architecture
    const resolver = new DeploymentConfigResolver();
    let architecture = answers.architecture;

    if (!architecture && answers.deploymentConfig) {
        try {
            const parts = resolver.decompose(answers.deploymentConfig);
            architecture = parts.architecture;
        } catch (e) {
            architecture = answers.framework === 'transformers' ? 'transformers' : 'http';
        }
    } else if (!architecture) {
        architecture = answers.framework === 'transformers' ? 'transformers' : 'http';
    }

    // Exclude sample_model when not needed
    if (!answers.includeSampleModel || architecture === 'transformers' || architecture === 'diffusors') {
        ignorePatterns.push('**/sample_model/**');
    }

    // Exclude do/benchmark when benchmarking is not selected
    if (!answers.includeBenchmark) {
        ignorePatterns.push('**/do/benchmark');
        ignorePatterns.push('**/do/.benchmark_writer.py');
        ignorePatterns.push('**/do/optimize');
    }

    // Exclude do/adapter, do/adapters/, and adapter sidecar when LoRA is not enabled
    if (!answers.enableLora) {
        ignorePatterns.push('**/do/adapter');
        ignorePatterns.push('**/do/adapters/**');
        ignorePatterns.push('**/code/adapter_sidecar.py');
    }

    // Exclude tune files when framework is NOT transformers OR deploymentTarget is batch-transform
    const tuneIncluded = architecture === 'transformers' && answers.deploymentTarget !== 'batch-transform';
    if (!tuneIncluded) {
        ignorePatterns.push('**/do/tune');
        ignorePatterns.push('**/do/.tune_helper.py');
    }

    // Exclude train files when deploymentTarget is batch-transform
    const trainIncluded = answers.deploymentTarget !== 'batch-transform';
    if (!trainIncluded) {
        ignorePatterns.push('**/do/train');
        ignorePatterns.push('**/do/.train_helper.py');
        ignorePatterns.push('**/do/.train_build_request.py');
        ignorePatterns.push('**/do/training/**');
        ignorePatterns.push('**/do/evaluate');
        ignorePatterns.push('**/do/.eval_helper.py');
    }

    // Exclude feedback.sh when neither tune nor train is included
    if (!tuneIncluded && !trainIncluded) {
        ignorePatterns.push('**/do/lib/feedback.sh');
    }

    // Exclude do/stage when model is already S3-sourced (nothing to stage)
    const modelName = answers.modelName || answers.customModelName || '';
    if (answers.modelSource === 's3' || modelName.startsWith('s3://')) {
        ignorePatterns.push('**/do/stage');
    }

    // Exclude do/test when hosted-model-endpoint is not selected
    const testTypes = answers.testTypes || [];
    if (!testTypes.includes('hosted-model-endpoint')) {
        ignorePatterns.push('**/do/test');
    }

    // DLC-direct mode (--no-build): skip container build artifacts
    // do/stage is always included — model weights must be staged to S3
    if (answers.no_build) {
        ignorePatterns.push('**/Dockerfile');
        ignorePatterns.push('**/do/build');
        ignorePatterns.push('**/do/push');
        ignorePatterns.push('**/.dockerignore');
        ignorePatterns.push('**/buildspec.yml');
        ignorePatterns.push('**/code/**');
        ignorePatterns.push('**/requirements.txt');
        // Set deploy mode for template rendering
        answers.deploy_mode = 'dlc-direct';
    }

    // Always exclude architecture-specific source directories from main copy
    // (they are overlaid separately for their respective architectures)
    ignorePatterns.push('**/triton/**');
    ignorePatterns.push('**/diffusors/**');

    // For triton and diffusors, exclude the default Dockerfile
    if (architecture === 'triton' || architecture === 'diffusors') {
        ignorePatterns.push('**/Dockerfile');
    }

    // Append skipTemplates from options to ignore patterns
    if (options.skipTemplates && options.skipTemplates.length > 0) {
        for (const pattern of options.skipTemplates) {
            ignorePatterns.push(`**/${pattern}`);
        }
    }

    // Copy all templates with EJS rendering
    if (options.onlyFiles) {
        // Selective regeneration: only render files in the onlyFiles set
        const onlySet = new Set(options.onlyFiles);
        const allFiles = globSync('**/*', {
            cwd: templateDir,
            ignore: ignorePatterns,
            dot: true,
            onlyFiles: true
        });
        for (const file of allFiles) {
            if (!onlySet.has(file)) continue;
            const src = path.join(templateDir, file);
            const destFile = file.endsWith('.ejs') ? file.slice(0, -'.ejs'.length) : file;
            const dest = path.join(destDir, destFile);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const content = fs.readFileSync(src, 'utf8');
            let rendered;
            try {
                rendered = ejs.render(content, templateVars, { filename: src });
            } catch (err) {
                const line = err.line ? ` (line ${err.line})` : '';
                throw new Error(`EJS rendering failed for "${file}"${line}: ${err.message}`);
            }
            fs.writeFileSync(dest, rendered);
        }
    } else {
        copyTpl(templateDir, destDir, templateVars, ignorePatterns);
    }

    // Architecture-specific file routing (delete files that don't belong)
    switch (architecture) {
    case 'http':
        _unlinkIfExists(path.join(destDir, 'code/chat_template.jinja'));
        _unlinkIfExists(path.join(destDir, 'code/serve'));
        _unlinkIfExists(path.join(destDir, 'code/serving.properties'));
        _unlinkIfExists(path.join(destDir, 'code/start_server.sh'));

        if (answers.modelServer !== 'flask' && answers.backend !== 'flask') {
            _unlinkIfExists(path.join(destDir, 'code/flask/wsgi.py'));
            _unlinkIfExists(path.join(destDir, 'code/flask/gunicorn_config.py'));
        }

        // Predictor-framework plugin: materialize the selected framework's
        // handler (predictors.d/<framework>/handler.py) into code/model_handler.py.
        _materializePredictorHandler(destDir, templateVars, answers);
        break;

    case 'transformers':
        _unlinkIfExists(path.join(destDir, 'code/model_handler.py'));
        _unlinkIfExists(path.join(destDir, 'code/serve.py'));
        _unlinkIfExists(path.join(destDir, 'code/start_server.py'));
        _unlinkIfExists(path.join(destDir, 'nginx-predictors.conf'));
        _unlinkIfExists(path.join(destDir, 'code/flask/wsgi.py'));
        _unlinkIfExists(path.join(destDir, 'code/flask/gunicorn_config.py'));
        break;

    case 'triton':
        _unlinkIfExists(path.join(destDir, 'code/serve.py'));
        _unlinkIfExists(path.join(destDir, 'code/model_handler.py'));
        _unlinkIfExists(path.join(destDir, 'code/start_server.py'));
        _unlinkIfExists(path.join(destDir, 'nginx-predictors.conf'));
        _unlinkIfExists(path.join(destDir, 'code/flask/wsgi.py'));
        _unlinkIfExists(path.join(destDir, 'code/flask/gunicorn_config.py'));
        _unlinkIfExists(path.join(destDir, 'code/chat_template.jinja'));
        _unlinkIfExists(path.join(destDir, 'code/serve'));
        _unlinkIfExists(path.join(destDir, 'code/serving.properties'));
        _unlinkIfExists(path.join(destDir, 'code/start_server.sh'));

        // Generate Triton-specific files
        _generateTritonFiles(templateDir, destDir, templateVars, answers, tritonBackends);
        break;

    case 'diffusors':
        _unlinkIfExists(path.join(destDir, 'code/model_handler.py'));
        _unlinkIfExists(path.join(destDir, 'code/serve.py'));
        _unlinkIfExists(path.join(destDir, 'code/start_server.py'));
        // The predictor start_server.sh (copied by the bulk copy) is not used by
        // diffusors — the container entrypoint is code/serve. Remove it so the
        // generated project does not ship an unused script.
        _unlinkIfExists(path.join(destDir, 'code/start_server.sh'));
        _unlinkIfExists(path.join(destDir, 'nginx-predictors.conf'));
        _unlinkIfExists(path.join(destDir, 'code/flask/wsgi.py'));
        _unlinkIfExists(path.join(destDir, 'code/flask/gunicorn_config.py'));
        _unlinkIfExists(path.join(destDir, 'code/chat_template.jinja'));
        _unlinkIfExists(path.join(destDir, 'code/serving.properties'));

        // Copy diffusors-specific templates. The diffusors container entrypoint is
        // code/serve (vllm serve --omni + nginx); there is no separate start_server.sh.
        _renderTemplate(path.join(templateDir, 'diffusors/Dockerfile'), path.join(destDir, 'Dockerfile'), templateVars);
        _renderTemplate(path.join(templateDir, 'diffusors/serve'), path.join(destDir, 'code/serve'), templateVars);
        _copyFile(path.join(templateDir, 'diffusors/patch_image_api.py'), path.join(destDir, 'code/patch_image_api.py'));
        break;

    default:
        // Fallback to HTTP behavior
        _unlinkIfExists(path.join(destDir, 'code/chat_template.jinja'));
        _unlinkIfExists(path.join(destDir, 'code/serve'));
        _unlinkIfExists(path.join(destDir, 'code/serving.properties'));
        _unlinkIfExists(path.join(destDir, 'code/start_server.sh'));
        _materializePredictorHandler(destDir, templateVars, answers);
    }

    // nginx-tensorrt.conf: only needed for TensorRT-LLM
    if (answers.modelServer !== 'tensorrt-llm' && answers.backend !== 'tensorrt-llm') {
        _unlinkIfExists(path.join(destDir, 'nginx-tensorrt.conf'));
    }

    // nginx-diffusors.conf: only needed for diffusors architecture
    if (answers.architecture !== 'diffusors') {
        _unlinkIfExists(path.join(destDir, 'nginx-diffusors.conf'));
    }

    // Copy PROJECT_README.md as README.md (overwriting the template README)
    _renderTemplate(path.join(templateDir, 'PROJECT_README.md'), path.join(destDir, 'README.md'), templateVars);

    // Copy do/lib/ Node.js modules (plain copy, no EJS)
    const doLibDir = path.join(destDir, 'do', 'lib');
    fs.mkdirSync(doLibDir, { recursive: true });
    _copyFile(path.join(LIB_DIR, 'manifest-cli.js'), path.join(doLibDir, 'manifest-cli.js'));
    _copyFile(path.join(LIB_DIR, 'asset-manager.js'), path.join(doLibDir, 'asset-manager.js'));
    _copyFile(path.join(LIB_DIR, 'bootstrap-config.js'), path.join(doLibDir, 'bootstrap-config.js'));

    // BL111: ship the eks manifest EJS *source* (unrendered) into the project so
    // do/deploy.d/eks can re-render from the template at deploy time — the render
    // source of truth is the .ejs template resolved against current do/config, not
    // the generate-time-frozen eks/*.yaml that copyTpl also writes (kept only as the
    // envsubst-fallback input).
    //
    // This is ALWAYS done, for every project. The deployment target is a
    // DEPLOY-TIME choice (`do/deploy --target eks`), NOT a generation-time answer —
    // at generation `answers.deploymentTarget` is just the default
    // (realtime-inference). Gating this on `=== 'eks'` therefore meant the .ejs
    // source was NEVER shipped, so every EKS deploy's node+ejs render loop matched
    // zero files and silently applied nothing. Any project can deploy to EKS, so
    // every project carries the .ejs source.
    const eksTemplateDir = path.join(templateDir, 'eks');
    if (fs.existsSync(eksTemplateDir)) {
        const eksDestDir = path.join(destDir, 'eks');
        fs.mkdirSync(eksDestDir, { recursive: true });
        for (const ejsSrc of fs.readdirSync(eksTemplateDir)) {
            if (!ejsSrc.endsWith('.yaml.ejs')) continue;
            // Copy verbatim (NOT EJS-rendered): the deploy-time render owns the
            // <%= %> resolution so instanceType/GPU/model/serve reflect deploy time.
            _copyFile(path.join(eksTemplateDir, ejsSrc), path.join(eksDestDir, ejsSrc));
        }
    }

    // Copy tune catalog to generated project when tune is included
    if (architecture === 'transformers' && answers.deploymentTarget !== 'batch-transform') {
        const tuneCatalogSrc = path.join(GENERATOR_ROOT, 'config', 'tune-catalog.json');
        const tuneCatalogDest = path.join(destDir, 'do', '.tune_catalog.json');
        _copyFile(tuneCatalogSrc, tuneCatalogDest);
    }

    // Generate .gitignore with benchmarks/ when benchmarking is enabled
    if (answers.includeBenchmark) {
        const gitignorePath = path.join(destDir, '.gitignore');
        const gitignoreContent = '# Benchmark results (generated by do/benchmark)\nbenchmarks/\n';
        if (fs.existsSync(gitignorePath)) {
            const existing = fs.readFileSync(gitignorePath, 'utf8');
            if (!existing.includes('benchmarks/')) {
                fs.appendFileSync(gitignorePath, `\n${gitignoreContent}`);
            }
        } else {
            fs.writeFileSync(gitignorePath, gitignoreContent);
        }
    }

    // Add .mlcc/ to .gitignore (staged-assets tracking — account-specific URIs)
    {
        const gitignorePath = path.join(destDir, '.gitignore');
        const mlccIgnore = '# Staged assets tracking (account-specific, generated by do/stage)\n.mlcc/\n';
        if (fs.existsSync(gitignorePath)) {
            const existing = fs.readFileSync(gitignorePath, 'utf8');
            if (!existing.includes('.mlcc/')) {
                fs.appendFileSync(gitignorePath, `\n${mlccIgnore}`);
            }
        } else {
            fs.writeFileSync(gitignorePath, mlccIgnore);
        }
    }

    // Add __pycache__/ and *.pyc to .gitignore (Python helpers leave bytecode behind)
    {
        const gitignorePath = path.join(destDir, '.gitignore');
        const pycacheIgnore = '# Python bytecode (generated by do/ helper scripts)\n__pycache__/\n*.pyc\n';
        if (fs.existsSync(gitignorePath)) {
            const existing = fs.readFileSync(gitignorePath, 'utf8');
            if (!existing.includes('__pycache__')) {
                fs.appendFileSync(gitignorePath, `\n${pycacheIgnore}`);
            }
        } else {
            fs.writeFileSync(gitignorePath, pycacheIgnore);
        }
    }

    // Add .mlcc-generation-params.json to .gitignore
    {
        const gitignorePath = path.join(destDir, '.gitignore');
        const paramsIgnore = '# Generation parameters (local state, not committed)\n.mlcc-generation-params.json\n';
        if (fs.existsSync(gitignorePath)) {
            const existing = fs.readFileSync(gitignorePath, 'utf8');
            if (!existing.includes('.mlcc-generation-params.json')) {
                fs.appendFileSync(gitignorePath, `\n${paramsIgnore}`);
            }
        } else {
            fs.writeFileSync(gitignorePath, paramsIgnore);
        }
    }

    // Write .mlcc-generation-params.json (skip for import and partial update flows)
    if (!options.noGenerationParams && !options.onlyFiles) {
        _writeGenerationParams(destDir, answers);
    }
}

/**
 * Post-generation tasks: set permissions and run sample model training.
 * Replicates the end() phase of the original generator.
 *
 * @param {string} destDir - Path to the generated project directory
 * @param {object} answers - Merged configuration answers
 * @param {object} tritonBackends - Triton backends catalog
 */
export async function postGenerate(destDir, answers, tritonBackends = {}) {
    // Set executable permissions on shell scripts
    _setExecutablePermissions(destDir);

    // Run sample model training if requested
    const architecture = answers.architecture;
    const skipSampleTraining = architecture === 'transformers' ||
        (architecture === 'triton' && !tritonBackends[answers.backend]?.supportsSampleModel);

    if (answers.includeSampleModel && !skipSampleTraining) {
        await _runSampleModelTraining(destDir);
    }
}

// --- Private helpers ---

/**
 * Keys that contain sensitive values and should be redacted in generation params.
 */
const REDACT_KEYS = new Set(['hfToken', 'ngcToken']);

/**
 * Write .mlcc-generation-params.json to the project root.
 * Captures the full answers object for use by `mcc regenerate`.
 *
 * @param {string} destDir - Project destination directory
 * @param {object} answers - Full answers object
 */
function _writeGenerationParams(destDir, answers) {
    const pkgPath = path.join(GENERATOR_ROOT, 'package.json');
    let generatorVersion = '0.0.0';
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        generatorVersion = pkg.version || '0.0.0';
    } catch {
        // Fallback to unknown version
    }

    // Redact sensitive values
    const redactedAnswers = { ...answers };
    for (const key of REDACT_KEYS) {
        if (redactedAnswers[key]) {
            redactedAnswers[key] = '[REDACTED]';
        }
    }

    const params = {
        generatorVersion,
        generatedAt: new Date().toISOString(),
        answers: redactedAnswers,
        bootstrapProfile: answers.bootstrapProfile || 'default',
        catalogVersions: {
            modelServersVersion: new Date().toISOString().split('T')[0],
            modelsVersion: new Date().toISOString().split('T')[0]
        }
    };

    const paramsPath = path.join(destDir, '.mlcc-generation-params.json');
    fs.writeFileSync(paramsPath, `${JSON.stringify(params, null, 2)  }\n`);

    // Write .mlcc-version so `mcc regenerate` shows the correct project version
    const versionPath = path.join(destDir, '.mlcc-version');
    fs.writeFileSync(versionPath, `${generatorVersion}\n`);

    // Copy instances.json to .mlcc/ so do/.benchmark_writer.py can resolve GPU metadata
    // (gpu_count, gpu_type, gpu_memory_gb) at benchmark write time without the MLCC source tree.
    const instancesCatalogSrc = path.join(GENERATOR_ROOT, 'servers', 'lib', 'catalogs', 'instances.json');
    const mlccDir = path.join(destDir, '.mlcc');
    const instancesCatalogDest = path.join(mlccDir, 'instances.json');
    try {
        fs.mkdirSync(mlccDir, { recursive: true });
        fs.copyFileSync(instancesCatalogSrc, instancesCatalogDest);

        // Copy draft-models catalog for do/draft list
        const draftCatalogSrc  = path.join(__dirname, '../servers/lib/catalogs/draft-models.json');
        const draftCatalogDest = path.join(destDir, '.mlcc', 'draft-models.json');
        if (fs.existsSync(draftCatalogSrc)) {
            fs.copyFileSync(draftCatalogSrc, draftCatalogDest);
        }

        // Copy serve-engine plugin manifests to .mlcc/serve.d/ so do/draft and
        // do/deploy can read engine capabilities (supported_algorithms,
        // env_var_prefix, dimension_map) at generation and deploy time. The
        // wrappers themselves are excluded from output by the **/serve.d/**
        // ignore pattern; only the manifest data is copied for the reader.
        const serveDSrc = path.join(GENERATOR_ROOT, 'templates', 'code', 'serve.d');
        const serveDDest = path.join(mlccDir, 'serve.d');
        if (fs.existsSync(serveDSrc)) {
            const schemaSrc = path.join(serveDSrc, 'manifest.schema.json');
            if (fs.existsSync(schemaSrc)) {
                fs.mkdirSync(serveDDest, { recursive: true });
                fs.copyFileSync(schemaSrc, path.join(serveDDest, 'manifest.schema.json'));
            }
            for (const entry of fs.readdirSync(serveDSrc, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const manifestSrc = path.join(serveDSrc, entry.name, 'manifest.json');
                if (fs.existsSync(manifestSrc)) {
                    const engineDest = path.join(serveDDest, entry.name);
                    fs.mkdirSync(engineDest, { recursive: true });
                    fs.copyFileSync(manifestSrc, path.join(engineDest, 'manifest.json'));
                }
            }
        }
    } catch { /* non-fatal */ }
}

/**
 * Converts commander's camelCase options to kebab-case keys.
 * ConfigManager expects kebab-case keys (e.g., 'skip-prompts', 'deployment-config')
 * because ConfigManager uses kebab-case internally. Commander converts --skip-prompts to skipPrompts.
 *
 * @param {object} options - Commander options object (camelCase keys)
 * @returns {object} Options with kebab-case keys
 */
function _toKebabCaseOptions(options) {
    const kebabOptions = {};
    for (const [key, value] of Object.entries(options)) {
        // Convert camelCase to kebab-case
        const kebabKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
        kebabOptions[kebabKey] = value;
    }
    return kebabOptions;
}

/**
 * Creates a lightweight adapter object that satisfies the generator interface
 * expected by ConfigManager and PromptRunner.
 *
 * @param {string|undefined} projectName - Positional project name argument
 * @param {object} options - Commander options object
 * @returns {object} Generator-like adapter
 */
function _createGeneratorAdapter(projectName, options) {
    const args = projectName ? [projectName] : [];
    let _destinationPath = process.cwd();

    const adapter = {
        options,
        args,
        destinationPath(...segments) {
            if (segments.length === 0) return _destinationPath;
            return path.join(_destinationPath, ...segments);
        },
        destinationRoot(newRoot) {
            if (newRoot !== undefined) {
                _destinationPath = path.resolve(newRoot);
            }
            return _destinationPath;
        },
        registryConfigManager: null,
        configManager: null,
        baseConfig: {},
        async prompt(prompts) {
            return runPrompts(prompts);
        }
    };

    return adapter;
}

/**
 * Orders environment variables by priority category for template rendering.
 *
 * @param {object} envVars - Environment variables map
 * @returns {Array<{key: string, value: string}>} Ordered array
 */
function _getOrderedEnvVars(envVars) {
    const entries = Object.entries(envVars);

    const priorities = {
        'LD_LIBRARY_PATH': 1,
        'PATH': 1,
        'CUDA_HOME': 1,
        'CUDA_PATH': 1,
        'CUDA_VISIBLE_DEVICES': 2,
        'NVIDIA_VISIBLE_DEVICES': 2,
        'NVIDIA_DRIVER_CAPABILITIES': 2,
        'VLLM': 3,
        'TENSORRT': 3,
        'SGLANG': 3,
        'TRANSFORMERS': 3,
        'MAX': 4,
        'BATCH': 4,
        'WORKER': 4,
        'THREAD': 4,
        'default': 5
    };

    function getPriority(key) {
        if (priorities[key]) return priorities[key];
        for (const [pattern, priority] of Object.entries(priorities)) {
            if (pattern !== 'default' && key.includes(pattern)) {
                return priority;
            }
        }
        return priorities.default;
    }

    const sorted = entries.sort(([keyA], [keyB]) => {
        const priorityA = getPriority(keyA);
        const priorityB = getPriority(keyB);
        if (priorityA !== priorityB) return priorityA - priorityB;
        return keyA.localeCompare(keyB);
    });

    return sorted.map(([key, value]) => ({ key, value }));
}

/**
 * Materializes the selected predictor framework's handler into the generated
 * project as code/model_handler.py.
 *
 * The HTTP predictor frameworks (sklearn/xgboost/tensorflow) are a hybrid plugin:
 * the per-framework ModelHandler lives in predictors.d/<framework>/handler.py and
 * is rendered (EJS, so `<%= modelFormat %>` in the handler's file-glob resolves)
 * into code/model_handler.py. This is the SOLE source of the generated handler —
 * the former framework-branched templates/code/model_handler.py was removed.
 *
 * @param {string} destDir - Destination project directory
 * @param {object} templateVars - Template variables for EJS (carries modelFormat)
 * @param {object} answers - Configuration answers (answers.engine = framework)
 */
function _materializePredictorHandler(destDir, templateVars, answers) {
    const framework = answers.engine || '';
    if (!framework) {
        // No framework resolved (e.g. an http config without an engine). Nothing
        // to materialize; validation elsewhere surfaces the missing engine.
        return;
    }
    const srcHandler = predictorHandlerPath(framework);
    if (!srcHandler) {
        const available = listPredictorFrameworks().join(', ') || '(none)';
        throw new Error(
            `No predictor handler for framework "${framework}". ` +
            `Available predictor frameworks: ${available}. ` +
            'Add templates/code/predictors.d/<framework>/{manifest.json,handler.py}.'
        );
    }
    _renderTemplate(srcHandler, path.join(destDir, 'code/model_handler.py'), templateVars);
}

/**
 * Generates Triton-specific files (Dockerfile, model repository structure).
 *
 * @param {string} templateDir - Template source directory
 * @param {string} destDir - Destination directory
 * @param {object} templateVars - Template variables for EJS
 * @param {object} answers - Configuration answers
 * @param {object} tritonBackends - Triton backends catalog
 */
function _generateTritonFiles(templateDir, destDir, templateVars, answers, _tritonBackends) {
    const modelName = answers.modelName || 'model';
    const backend = answers.backend;

    // BL119: the Triton templates no longer hardcode a `vllm || tensorrtllm` name
    // list. Derive the LLM-backend predicate from the catalog via the reader and
    // inject it so config.pbtxt / Dockerfile branch on `isLlmBackend` instead.
    // Unknown/legacy backends (not in the catalog) are treated as non-LLM, matching
    // the templates' prior else-branch behavior for anything but vllm/tensorrtllm.
    const isLlmBackend = isTritonBackend(backend) && tritonIsLlm(backend);
    const tritonVars = { ...templateVars, isLlmBackend };

    // Copy Triton Dockerfile
    _renderTemplate(
        path.join(templateDir, 'triton/Dockerfile'),
        path.join(destDir, 'Dockerfile'),
        tritonVars
    );

    // Create model repository directory structure
    const modelRepoPath = path.join(destDir, `model_repository/${modelName}`);
    fs.mkdirSync(path.join(modelRepoPath, '1'), { recursive: true });

    // Copy config.pbtxt
    _renderTemplate(
        path.join(templateDir, 'triton/config.pbtxt'),
        path.join(modelRepoPath, 'config.pbtxt'),
        tritonVars
    );

    // Create version 1 directory with .gitkeep
    fs.writeFileSync(
        path.join(modelRepoPath, '1/.gitkeep'),
        '# Placeholder for model artifacts\n'
    );

    // For triton-python backend: copy model.py and requirements.txt. (The Python
    // backend is the only one with a model.py / requirements.txt overlay — this is
    // genuinely backend-specific, not a catalog-derivable fact, so it stays a
    // backend check per route B.)
    if (backend === 'python') {
        _renderTemplate(
            path.join(templateDir, 'triton/model.py'),
            path.join(modelRepoPath, '1/model.py'),
            tritonVars
        );
        _renderTemplate(
            path.join(templateDir, 'triton/requirements.txt'),
            path.join(destDir, 'triton/requirements.txt'),
            tritonVars
        );
    }
}

/**
 * Renders a single EJS template file to a destination path.
 *
 * @param {string} src - Source template file path
 * @param {string} dest - Destination file path
 * @param {object} vars - Template variables
 */
function _renderTemplate(src, dest, vars) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const content = fs.readFileSync(src, 'utf8');
    const rendered = ejs.render(content, vars, { filename: src });
    fs.writeFileSync(dest, rendered);
}

/**
 * Copies a file without EJS rendering.
 *
 * @param {string} src - Source file path
 * @param {string} dest - Destination file path
 */
function _copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

/**
 * Removes a file if it exists, silently ignoring if it doesn't.
 *
 * @param {string} filePath - Path to the file to remove
 */
function _unlinkIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (e) {
        // Silently continue
    }
}

/**
 * Sets executable permissions on shell scripts in the generated project.
 *
 * @param {string} destDir - Path to the generated project directory
 */
function _setExecutablePermissions(destDir) {
    const defaultScripts = [
        'do/config',
        'do/build',
        'do/push',
        'do/deploy',
        'do/run',
        'do/test',
        'do/logs',
        'do/clean',
        'do/submit',
        'do/register',
        'do/ci',
        'do/manifest',
        'do/benchmark',
        'do/optimize',
        'do/status',
        'do/add-ic',
        'do/adapter',
        'do/tune',
        'do/train',
        'do/stage',
        'do/validate'
    ];

    const shellScripts = defaultScripts;

    shellScripts.forEach(script => {
        const scriptPath = path.join(destDir, script);
        try {
            if (fs.existsSync(scriptPath)) {
                const stats = fs.statSync(scriptPath);
                const newMode = stats.mode | 0o755;
                fs.chmodSync(scriptPath, newMode);
            }
        } catch (error) {
            // Silently continue if chmod fails (e.g., on Windows)
        }
    });
}

/**
 * Runs sample model training script in the generated project.
 * Non-fatal: if training fails, just warns the user.
 *
 * @param {string} destDir - Path to the generated project directory
 */
async function _runSampleModelTraining(destDir) {
    const trainingScriptName = 'train_abalone.py';
    const trainingScript = path.join(destDir, `sample_model/${trainingScriptName}`);
    const sampleModelDir = path.join(destDir, 'sample_model');
    const requirementsFile = path.join(destDir, 'requirements.txt');

    console.log('\n🤖 Training sample model...');
    console.log('This will generate the model file needed for Docker build.');

    try {
        if (!fs.existsSync(trainingScript)) {
            console.log('⚠️  Training script not found, skipping model training');
            return;
        }

        // Install dependencies
        if (fs.existsSync(requirementsFile)) {
            console.log('📦 Installing dependencies from requirements.txt...');
            await _spawnAsync('pip', ['install', '-q', '-r', requirementsFile], { cwd: destDir });
        }

        // Run training script
        await _spawnAsync('python', [trainingScriptName], { cwd: sampleModelDir });
        console.log('✅ Sample model training completed successfully!');
        console.log(`📁 Model file saved in: ${sampleModelDir}`);
    } catch (error) {
        console.log('⚠️  Error during sample model training:', error.message);
        console.log(`Please run manually: python sample_model/${trainingScriptName}`);
    }
}

/**
 * Spawns a child process and returns a promise.
 * Resolves on exit code 0, rejects otherwise.
 *
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} opts - spawn options
 * @returns {Promise<void>}
 */
function _spawnAsync(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { ...opts, stdio: 'inherit' });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} exited with code ${code}`));
            }
        });

        proc.on('error', (error) => {
            reject(error);
        });
    });
}
