import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'yeoman-assert';
import helpers from 'yeoman-test';
import { readFileSync, statSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('End-to-End Validation: All Deployment Configurations', function() {
    // Increase timeout for multiple project generations
    this.timeout(120000);

    const validDeploymentConfigs = [
        'sklearn-flask',
        'sklearn-fastapi',
        'xgboost-flask',
        'xgboost-fastapi',
        'tensorflow-flask',
        'tensorflow-fastapi',
        'transformers-vllm',
        'transformers-sglang',
        'transformers-tensorrt-llm',
        'transformers-lmi',
        'transformers-djl'
    ];

    const basePrompts = {
        projectName: 'test-e2e-project',
        destinationDir: '.',
        includeSampleModel: false,
        includeTesting: false,
        deployTarget: 'sagemaker',
        instanceType: 'ml.m5.xlarge',
        awsRegion: 'us-east-1',
        awsRoleArn: ''
    };

    validDeploymentConfigs.forEach(deploymentConfig => {
        describe(`Configuration: ${deploymentConfig}`, () => {
            let runResult;
            const [framework, modelServer] = deploymentConfig.split('-');

            before(async () => {
                const prompts = {
                    ...basePrompts,
                    deploymentConfig
                };

                // Add framework-specific prompts
                if (framework === 'transformers') {
                    prompts.modelName = 'meta-llama/Llama-2-7b-chat-hf';
                    prompts.modelProfile = null;
                    prompts.hfToken = '';
                } else {
                    prompts.modelFormat = framework === 'sklearn' ? 'pkl' : 'json';
                }

                runResult = await helpers
                    .run(path.join(__dirname, '../../generators/app'))
                    .withOptions({ offline: true })
                    .withPrompts(prompts);
            });

            it('should generate all core files', () => {
                assert.file([
                    'Dockerfile',
                    'requirements.txt',
                    'README.md',
                    'MIGRATION.md'
                ]);
            });

            it('should generate all do scripts', () => {
                assert.file([
                    'do/config',
                    'do/build',
                    'do/push',
                    'do/deploy',
                    'do/run',
                    'do/test',
                    'do/clean',
                    'do/README.md'
                ]);
            });

            it('should generate legacy wrapper scripts', () => {
                assert.file([
                    'deploy/build_and_push.sh',
                    'deploy/deploy.sh'
                ]);
            });

            it('should make all do scripts executable', () => {
                const scripts = ['build', 'push', 'deploy', 'run', 'test', 'clean'];
                scripts.forEach(script => {
                    const scriptPath = path.join(runResult.cwd, 'do', script);
                    const stats = statSync(scriptPath);
                    const isExecutable = (stats.mode & 0o111) !== 0;
                    assert.ok(isExecutable, `do/${script} should be executable`);
                });
            });

            it('should populate do/config with correct values', () => {
                const configPath = path.join(runResult.cwd, 'do/config');

                // Check required variables
                assert.fileContent(configPath, /export PROJECT_NAME="test-e2e-project"/);
                assert.fileContent(configPath, new RegExp(`export DEPLOYMENT_CONFIG="${deploymentConfig}"`));
                assert.fileContent(configPath, new RegExp(`export FRAMEWORK="${framework}"`));
                assert.fileContent(configPath, new RegExp(`export MODEL_SERVER="${modelServer}"`));
                assert.fileContent(configPath, /export AWS_REGION="us-east-1"/);
                assert.fileContent(configPath, /export ECR_REPOSITORY_NAME/);
                assert.fileContent(configPath, /export INSTANCE_TYPE="ml\.m5\.xlarge"/);
            });

            it('should have all do scripts source config', () => {
                const scripts = ['build', 'push', 'deploy', 'run', 'test', 'clean'];
                scripts.forEach(script => {
                    const scriptPath = path.join(runResult.cwd, 'do', script);
                    const content = readFileSync(scriptPath, 'utf8');
                    const sourcesConfig = /source.*do\/config|source.*\$\{SCRIPT_DIR\}\/config/.test(content);
                    assert.ok(sourcesConfig, `do/${script} should source do/config`);
                });
            });

            it('should have all do scripts use set -e', () => {
                const scripts = ['build', 'push', 'deploy', 'run', 'test', 'clean'];
                scripts.forEach(script => {
                    const scriptPath = path.join(runResult.cwd, 'do', script);
                    assert.fileContent(scriptPath, /set -e/);
                });
            });

            it('should have do scripts contain conditional branching', () => {
                const scriptsWithBranching = ['build', 'deploy', 'run'];
                scriptsWithBranching.forEach(script => {
                    const scriptPath = path.join(runResult.cwd, 'do', script);
                    const content = readFileSync(scriptPath, 'utf8');
                    const hasBranching = /case.*in|if.*then/.test(content);
                    assert.ok(hasBranching, `do/${script} should contain conditional branching`);
                });
            });

            it('should have do scripts use emoji output formatting', () => {
                const scripts = ['build', 'push', 'deploy', 'run', 'test', 'clean'];
                // Check for common emoji patterns used in scripts
                const emojiPatterns = [
                    /🚀/, /✅/, /❌/, /⚠️/, /ℹ️/, /🔍/, /🏗️/, /📦/, /🧪/, /🧹/
                ];
                
                scripts.forEach(script => {
                    const scriptPath = path.join(runResult.cwd, 'do', script);
                    const content = readFileSync(scriptPath, 'utf8');
                    const hasEmoji = emojiPatterns.some(pattern => pattern.test(content));
                    assert.ok(hasEmoji, `do/${script} should use emoji formatting`);
                });
            });

            it('should have AWS scripts validate credentials', () => {
                const awsScripts = ['push', 'deploy'];
                awsScripts.forEach(script => {
                    const scriptPath = path.join(runResult.cwd, 'do', script);
                    const content = readFileSync(scriptPath, 'utf8');
                    const validatesCredentials = /aws sts get-caller-identity/.test(content);
                    assert.ok(validatesCredentials, `do/${script} should validate AWS credentials`);
                });
            });

            it('should have legacy wrappers contain deprecation warnings', () => {
                const wrappers = ['deploy/build_and_push.sh', 'deploy/deploy.sh'];
                wrappers.forEach(wrapper => {
                    const wrapperPath = path.join(runResult.cwd, wrapper);
                    const content = readFileSync(wrapperPath, 'utf8');
                    assert.ok(/WARNING.*deprecated/i.test(content), `${wrapper} should have deprecation warning`);
                    assert.ok(/do\//.test(content), `${wrapper} should reference do/ scripts`);
                });
            });

            it('should have documentation reference do-framework commands', () => {
                const docs = ['README.md', 'do/README.md', 'MIGRATION.md'];
                docs.forEach(doc => {
                    const docPath = path.join(runResult.cwd, doc);
                    const content = readFileSync(docPath, 'utf8');
                    assert.ok(/\.\/do\//.test(content), `${doc} should reference do/ commands`);
                });
            });

            it('should generate all necessary template files', () => {
                // Core files
                assert.file(['Dockerfile', 'requirements.txt']);
                
                // Code files (all should be present regardless of config)
                assert.file([
                    'code/model_handler.py',
                    'code/serve.py',
                    'code/serve'
                ]);
            });
        });
    });

    describe('CodeBuild deployment target', () => {
        let runResult;

        before(async () => {
            runResult = await helpers
                .run(path.join(__dirname, '../../generators/app'))
                .withOptions({ offline: true })
                .withPrompts({
                    ...basePrompts,
                    deploymentConfig: 'transformers-vllm',
                    deployTarget: 'codebuild',
                    codebuildComputeType: 'BUILD_GENERAL1_LARGE',
                    modelName: 'meta-llama/Llama-2-7b-chat-hf',
                    modelProfile: null,
                    hfToken: ''
                });
        });

        it('should generate do/submit script for CodeBuild', () => {
            assert.file('do/submit');
        });

        it('should make do/submit executable', () => {
            const scriptPath = path.join(runResult.cwd, 'do/submit');
            const stats = statSync(scriptPath);
            const isExecutable = (stats.mode & 0o111) !== 0;
            assert.ok(isExecutable, 'do/submit should be executable');
        });

        it('should generate legacy submit_build.sh wrapper', () => {
            assert.file('deploy/submit_build.sh');
        });

        it('should have do/config contain CodeBuild variables', () => {
            assert.fileContent('do/config', /export CODEBUILD_COMPUTE_TYPE/);
            assert.fileContent('do/config', /export CODEBUILD_PROJECT_NAME/);
        });
    });
});
