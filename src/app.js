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
import ConfigurationManager from './lib/configuration-manager.js';
import RegistryLoader from './lib/registry-loader.js';
import { resolvePrefixedEnvVars } from './lib/engine-prefix-resolver.js';
import ejs from 'ejs';

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

        registryConfigManager = new ConfigurationManager({
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
        answers = configManager.getFinalConfiguration();

        // Infer modelSource from model name prefix if not set
        const modelName = answers.modelName;
        if (!answers.modelSource && modelName) {
            if (modelName.startsWith('s3://')) {
                answers.modelSource = 's3';
                if (!answers.artifactUri) {
                    answers.artifactUri = modelName;
                }
            } else if (modelName.startsWith('jumpstart://')) {
                answers.modelSource = 'jumpstart';
            } else if (modelName.startsWith('jumpstart-hub://')) {
                answers.modelSource = 'jumpstart-hub';
            } else if (modelName.startsWith('registry://')) {
                answers.modelSource = 'registry';
            }
        }

        // Warn about unsupported model sources
        if (answers.modelSource === 'jumpstart-hub') {
            console.log('\n   ⚠️  JumpStart Private Hub models are not yet fully supported.');
            console.log('   The generated project will not be able to download model artifacts at runtime.');
            console.log('   This feature is tracked for a future release.');
            console.log('   Falling back to HuggingFace source.\n');
            answers.modelSource = 'huggingface';
            delete answers.artifactUri;
        }

        // Note about registry model requirements
        if (answers.modelSource === 'registry') {
            console.log('\n   ℹ️  Registry model: the container will resolve the artifact URI at startup');
            console.log('   via DescribeModelPackage. Ensure the model package has a valid');
            console.log('   InferenceSpecification with ModelDataUrl or S3DataSource.');
            console.log('   If your model package lacks an InferenceSpecification, use the S3 path');
            console.log('   directly instead: --model-name="s3://bucket/path/model.tar.gz"\n');
        }
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

    // --- Phase: Writing ---
    const destDir = path.resolve(answers.destinationDir);
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
 */
export async function writeProject(templateDir, destDir, answers, registryConfigManager = null, tritonBackends = {}, configManager = null) {
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

    // Prepare template variables
    const templateVars = {
        ...answers,
        comments,
        orderedEnvVars,
        serverEnvVars: prefixedServerEnvVars
    };

    // Build ignore patterns
    const ignorePatterns = [];

    if (answers.deploymentTarget !== 'hyperpod-eks') {
        ignorePatterns.push('**/hyperpod/**');
    }

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

    // Always exclude triton and diffusors source directories
    ignorePatterns.push('**/triton/**');
    ignorePatterns.push('**/diffusors/**');

    // For triton and diffusors, exclude the default Dockerfile
    if (architecture === 'triton' || architecture === 'diffusors') {
        ignorePatterns.push('**/Dockerfile');
    }

    // Copy all templates with EJS rendering
    copyTpl(templateDir, destDir, templateVars, ignorePatterns);

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
        _unlinkIfExists(path.join(destDir, 'nginx-predictors.conf'));
        _unlinkIfExists(path.join(destDir, 'code/flask/wsgi.py'));
        _unlinkIfExists(path.join(destDir, 'code/flask/gunicorn_config.py'));
        _unlinkIfExists(path.join(destDir, 'code/chat_template.jinja'));
        _unlinkIfExists(path.join(destDir, 'code/serving.properties'));

        // Copy diffusors-specific templates
        _renderTemplate(path.join(templateDir, 'diffusors/Dockerfile'), path.join(destDir, 'Dockerfile'), templateVars);
        _renderTemplate(path.join(templateDir, 'diffusors/serve'), path.join(destDir, 'code/serve'), templateVars);
        _renderTemplate(path.join(templateDir, 'diffusors/start_server.sh'), path.join(destDir, 'code/start_server.sh'), templateVars);
        _copyFile(path.join(templateDir, 'diffusors/patch_image_api.py'), path.join(destDir, 'code/patch_image_api.py'));
        break;

    default:
        // Fallback to HTTP behavior
        _unlinkIfExists(path.join(destDir, 'code/chat_template.jinja'));
        _unlinkIfExists(path.join(destDir, 'code/serve'));
        _unlinkIfExists(path.join(destDir, 'code/serving.properties'));
        _unlinkIfExists(path.join(destDir, 'code/start_server.sh'));
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
 * Ensures all template variables have proper defaults to prevent
 * "undefined" errors in EJS templates. Also enriches answers with
 * registry data (env var merging, HuggingFace data, Triton base image).
 *
 * @param {object} answers - Answers object to fill defaults into
 * @param {object|null} registryConfigManager - Registry configuration manager (or null)
 */
async function _ensureTemplateVariables(answers, registryConfigManager = null) {
    const defaults = {
        chatTemplate: null,
        chatTemplateSource: null,
        hfToken: null,
        ngcApiKey: null,
        envVars: {},
        inferenceAmiVersion: null,
        accelerator: null,
        frameworkVersion: null,
        validationLevel: 'unknown',
        configSources: [],
        recommendedInstanceTypes: [],
        roleArn: null,
        deploymentConfig: '',
        architecture: null,
        backend: null,
        engine: null,
        codebuildComputeType: null,
        codebuildProjectName: null,
        modelName: null,
        modelFormat: null,
        includeSampleModel: false,
        includeTesting: true,
        testTypes: [],
        buildTimestamp: new Date().toISOString(),
        buildTarget: 'codebuild',
        deploymentTarget: 'managed-inference',
        hyperPodCluster: null,
        hyperPodNamespace: 'default',
        hyperPodReplicas: 1,
        fsxVolumeHandle: null,
        baseImage: null,
        modelSource: 'huggingface',
        artifactUri: '',
        modelLoadStrategy: 'runtime'
    };

    Object.entries(defaults).forEach(([key, value]) => {
        if (answers[key] === undefined) {
            answers[key] = value;
        }
    });

    // Backward compatibility: populate framework and modelServer from architecture/backend
    if (!answers.framework && answers.architecture) {
        answers.framework = answers.architecture;
    }
    if (!answers.modelServer && answers.backend) {
        answers.modelServer = answers.backend;
    }

    // Always include testing with all available test types
    answers.includeTesting = true;
    if (!answers.testTypes || answers.testTypes.length === 0) {
        if (answers.architecture === 'transformers' || answers.framework === 'transformers') {
            answers.testTypes = ['hosted-model-endpoint'];
        } else {
            answers.testTypes = ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        }
    }

    // Merge catalog env vars into answers.envVars with correct precedence
    await _mergeEnvVarsWithPrecedence(answers, registryConfigManager);

    // For Triton architecture, set default base image fallback
    if (answers.architecture === 'triton' && !answers.baseImage) {
        // Try to look up base image from framework registry using deployment-config key
        const tritonRegistryKey = answers.deploymentConfig;
        if (tritonRegistryKey && registryConfigManager?.frameworkRegistry) {
            const tritonFrameworkConfig = registryConfigManager.frameworkRegistry[tritonRegistryKey];
            if (tritonFrameworkConfig) {
                const versions = Object.keys(tritonFrameworkConfig).sort((a, b) =>
                    b.localeCompare(a, undefined, { numeric: true })
                );
                if (versions.length > 0) {
                    const latestConfig = tritonFrameworkConfig[versions[0]];
                    if (latestConfig.baseImage) {
                        answers.baseImage = latestConfig.baseImage;
                    }
                    if (latestConfig.inferenceAmiVersion && !answers.inferenceAmiVersion) {
                        answers.inferenceAmiVersion = latestConfig.inferenceAmiVersion;
                    }
                    if (latestConfig.accelerator) {
                        answers.accelerator = latestConfig.accelerator;
                    }
                }
            }
        }
        // Final fallback: hardcoded default Triton base image
        if (!answers.baseImage) {
            answers.baseImage = 'nvcr.io/nvidia/tritonserver:24.08-py3';
        }
    }

    // For transformer models, enrich with HuggingFace data and non-envVar metadata
    if (answers.framework === 'transformers' && answers.modelName && registryConfigManager) {
        try {
            // Fetch HuggingFace data for model-specific info
            const hfData = await registryConfigManager._fetchHuggingFaceData(answers.modelName);

            // Merge chatTemplate if available and not already set
            if (hfData && hfData.chatTemplate && !answers.chatTemplate) {
                answers.chatTemplate = hfData.chatTemplate;
                answers.chatTemplateSource = 'HuggingFace_Hub_API';
            }

            // Check Model Registry for chatTemplate overrides
            if (registryConfigManager.modelRegistry) {
                const modelConfig = _findModelConfig(answers.modelName, registryConfigManager);

                if (modelConfig && modelConfig.chatTemplate) {
                    answers.chatTemplate = modelConfig.chatTemplate;
                    answers.chatTemplateSource = 'Model_Registry';
                }
            }

            // Set framework-level metadata (non-envVar fields)
            if (answers.frameworkVersion && registryConfigManager.frameworkRegistry) {
                const frameworkConfig = registryConfigManager.frameworkRegistry[answers.framework]?.[answers.frameworkVersion];

                if (frameworkConfig) {
                    if (frameworkConfig.inferenceAmiVersion && !answers.inferenceAmiVersion) {
                        answers.inferenceAmiVersion = frameworkConfig.inferenceAmiVersion;
                    }
                    if (frameworkConfig.accelerator) {
                        answers.accelerator = frameworkConfig.accelerator;
                    }
                }
            }
        } catch (error) {
            // Silently continue - defaults are already set
        }
    }
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
 * Validates environment variables using the registry system.
 * Displays errors and warnings to the user.
 *
 * @param {object} answers - Configuration answers
 * @param {object} registryConfigManager - Registry configuration manager
 */
async function _validateEnvironmentVariables(answers, registryConfigManager) {
    // Get framework configuration
    // For Triton configs, look up using deploymentConfig key (e.g. 'triton-fil')
    let frameworkConfig;
    if (answers.architecture === 'triton' && answers.deploymentConfig) {
        const tritonEntry = registryConfigManager.frameworkRegistry?.[answers.deploymentConfig];
        if (tritonEntry) {
            const versions = Object.keys(tritonEntry);
            if (versions.length > 0) {
                frameworkConfig = tritonEntry[versions[0]];
            }
        }
    }
    if (!frameworkConfig) {
        frameworkConfig = registryConfigManager.frameworkRegistry?.[answers.framework]?.[answers.frameworkVersion];
    }

    if (!frameworkConfig || !frameworkConfig.envVars) {
        return; // No env vars to validate
    }

    console.log('\n🔍 Validating environment variables...');

    // Validate environment variables
    const validationResult = registryConfigManager.validateEnvironmentVariables(
        frameworkConfig.envVars,
        frameworkConfig
    );

    // Display validation results
    if (validationResult.errors && validationResult.errors.length > 0) {
        console.log('\n❌ Environment Variable Validation Errors:');
        validationResult.errors.forEach(error => {
            console.log(`   • ${error.key}: ${error.message}`);
        });
    }

    if (validationResult.warnings && validationResult.warnings.length > 0) {
        console.log('\n⚠️  Environment Variable Validation Warnings:');
        validationResult.warnings.forEach(warning => {
            console.log(`   • ${warning.key ? `${warning.key}: ` : ''}${warning.message}`);
        });
    }

    if (validationResult.strategiesUsed && validationResult.strategiesUsed.length > 0) {
        console.log(`\n✅ Validation methods used: ${validationResult.strategiesUsed.join(', ')}`);
    }

    if (!validationResult.errors || validationResult.errors.length === 0) {
        if (!validationResult.warnings || validationResult.warnings.length === 0) {
            console.log('   ✅ All environment variables validated successfully');
        }
    }

    // In non-interactive mode (skip-prompts), throw on errors
    if (validationResult.errors && validationResult.errors.length > 0) {
        throw new Error('Environment variable validation failed. Please fix the errors and try again.');
    }
}

/**
 * Merges environment variables from all catalog sources with correct precedence.
 * Precedence (lowest → highest):
 *   1. catalog defaults (Image_Entry defaults.envVars)
 *   2. framework profile (Image_Entry profiles[selectedProfile].envVars)
 *   3. model entry (model catalog entry envVars)
 *   4. model profile (model catalog entry profiles[selectedProfile].envVars)
 *   5. CLI overrides (existing answers.envVars from user CLI input)
 *
 * @param {object} answers - Configuration answers
 * @param {object|null} registryConfigManager - Registry configuration manager
 */
async function _mergeEnvVarsWithPrecedence(answers, registryConfigManager) {
    if (!registryConfigManager) return;

    // Capture CLI-provided env vars before merging (highest precedence)
    const cliEnvVars = { ...answers.envVars };

    // Resolve the framework config for the selected framework + version
    const frameworkName = answers.framework || answers.deploymentConfig;
    const frameworkVersion = answers.frameworkVersion;
    let frameworkConfig = null;

    if (frameworkName && registryConfigManager.frameworkRegistry) {
        const frameworkVersions = registryConfigManager.frameworkRegistry[frameworkName];
        if (frameworkVersions) {
            if (frameworkVersion && frameworkVersions[frameworkVersion]) {
                frameworkConfig = frameworkVersions[frameworkVersion];
            } else {
                // Fall back to latest version for Triton and other non-versioned lookups
                const versions = Object.keys(frameworkVersions).sort((a, b) =>
                    b.localeCompare(a, undefined, { numeric: true })
                );
                if (versions.length > 0) {
                    frameworkConfig = frameworkVersions[versions[0]];
                }
            }
        }
    }

    // Resolve the model config (exact match or pattern match)
    let modelConfig = null;
    if (answers.modelName && registryConfigManager.modelRegistry) {
        modelConfig = _findModelConfig(answers.modelName, registryConfigManager);
    }

    // Layer 1: catalog defaults (Image_Entry defaults.envVars)
    const catalogDefaults = frameworkConfig?.envVars || {};

    // Layer 2: framework profile envVars
    let frameworkProfileEnvVars = {};
    if (answers.frameworkProfile && frameworkConfig?.profiles) {
        const profile = frameworkConfig.profiles[answers.frameworkProfile];
        if (profile?.envVars) {
            frameworkProfileEnvVars = profile.envVars;
        }
    }

    // Layer 3: model entry envVars
    const modelEntryEnvVars = modelConfig?.envVars || {};

    // Layer 4: model profile envVars
    let modelProfileEnvVars = {};
    if (answers.modelProfile && modelConfig?.profiles) {
        const profile = modelConfig.profiles[answers.modelProfile];
        if (profile?.envVars) {
            modelProfileEnvVars = profile.envVars;
        }
    }

    // Layer 5: CLI overrides (captured above)

    // Merge in precedence order: each layer overrides the previous
    answers.envVars = {
        ...catalogDefaults,
        ...frameworkProfileEnvVars,
        ...modelEntryEnvVars,
        ...modelProfileEnvVars,
        ...cliEnvVars
    };
}

/**
 * Finds model configuration by exact match or glob-pattern match.
 *
 * @param {string} modelName - Model ID to look up
 * @param {object} registryConfigManager - Registry configuration manager
 * @returns {object|null} Model configuration or null
 */
function _findModelConfig(modelName, registryConfigManager) {
    if (!registryConfigManager?.modelRegistry) return null;

    // Exact match first
    const exact = registryConfigManager.modelRegistry[modelName];
    if (exact) return exact;

    // Pattern matching with glob-style wildcards
    for (const [pattern, config] of Object.entries(registryConfigManager.modelRegistry)) {
        if (pattern.includes('*')) {
            const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
            if (regex.test(modelName)) {
                return config;
            }
        }
    }

    return null;
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

    // Copy Triton Dockerfile
    _renderTemplate(
        path.join(templateDir, 'triton/Dockerfile'),
        path.join(destDir, 'Dockerfile'),
        templateVars
    );

    // Create model repository directory structure
    const modelRepoPath = path.join(destDir, `model_repository/${modelName}`);
    fs.mkdirSync(path.join(modelRepoPath, '1'), { recursive: true });

    // Copy config.pbtxt
    _renderTemplate(
        path.join(templateDir, 'triton/config.pbtxt'),
        path.join(modelRepoPath, 'config.pbtxt'),
        templateVars
    );

    // Create version 1 directory with .gitkeep
    fs.writeFileSync(
        path.join(modelRepoPath, '1/.gitkeep'),
        '# Placeholder for model artifacts\n'
    );

    // For triton-python backend: copy model.py and requirements.txt
    if (backend === 'python') {
        _renderTemplate(
            path.join(templateDir, 'triton/model.py'),
            path.join(modelRepoPath, '1/model.py'),
            templateVars
        );
        _renderTemplate(
            path.join(templateDir, 'triton/requirements.txt'),
            path.join(destDir, 'triton/requirements.txt'),
            templateVars
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
    const shellScripts = [
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
        'do/manifest'
    ];

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
