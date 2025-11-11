// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const Generator = require('yeoman-generator').default || require('yeoman-generator');

module.exports = class extends Generator {

    // Implementation status tracking
    SUPPORTED_OPTIONS = {
        frameworks: ['sklearn', 'xgboost', 'tensorflow', 'transformers'],
        modelServer: ['flask', 'fast-api', 'vllm', 'sglang'],
        deployment: ['sagemaker'],
        testTypes: ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'],
        instanceTypes: ['cpu-optimized'],
        // inputFormats: ['application/json'],
        awsRegions: ['us-east-1']
    };

    async prompting() {

        const buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        
        // Phase 1: Project Configuration
        console.log('\n📋 Project Configuration')
        const projectNameAnswer = await this.prompt([
            {
                type: 'input',
                name: 'projectName',
                message: 'What is the Project Name?',
                default: 'ml-container-creator'
            }
        ]);
        const destinationAnswer = await this.prompt([
            {
                type: 'input',
                name: 'destinationDir',
                message: 'Where will the output directory be?',
                default: `./${projectNameAnswer.projectName}-${buildTimestamp}`
            }
        ]);
        const projectAnswers = { ...projectNameAnswer, ...destinationAnswer };

        // Phase 2: Core Configuration
        console.log('\n🔧 Core Configuration');
        const coreAnswers = await this.prompt([
            {
                type: 'list',
                name: 'framework',
                message: 'Which ML framework are you using?',
                choices: ['sklearn', 'xgboost', 'tensorflow', 'transformers'],
                when: answers => answers.framework !== 'transformers'
            },
            {
                type: 'list',
                name: 'modelFormat',
                message: 'In which format is your model serialized?',
                choices: (answers) => {
                    if (answers.framework === 'xgboost') {
                        return ['json', 'model', 'ubj'];
                    }
                    if (answers.framework === 'sklearn') {
                        return ['pkl', 'joblib'];
                    }
                    if (answers.framework === 'tensorflow') {
                        return ['keras', 'h5', 'SavedModel']
                    }
                },
                when: answers => answers.framework !== 'transformers',
            },
            {
                type: 'list',
                name: 'modelServer',
                message: 'Which model server are you serving with?',
                choices: (answers) => {
                    if (answers.framework !== 'transformers') {
                        return ['flask', 'fastapi']
                    }
                    if (answers.framework === 'transformers') {
                        return ['vllm', 'sglang']
                    }
                }
            },
            // {
            //     type: 'list',
            //     name: 'model',
            //     message: 'Which model are you deploying?',
            //     choices: (answers) => {
            //         if (answers.modelServer === 'vllm' || answers.modelServer === 'sglang') {
            //             return ['openai/gpt-oss-20b', 'meta-llama/Llama-3.2-3B-Instruct'];
            //         }
            //     },
            //     when: answers => answers.framework === 'transformers',
            // },
        ]);

        // Phase 3: Module Selection
        console.log('\n📦 Module Selection');
        const moduleAnswers = await this.prompt([
            {
                type: 'confirm',
                name: 'includeSampleModel',
                message: 'Include sample Abalone classifier?',
                default: false,
                when: () => coreAnswers.framework !== 'transformers'
            },
            {
                type: 'confirm',
                name: 'includeTesting',
                message: 'Include test suite?',
                default: true,
            },
            {
                type: 'checkbox',
                name: 'testTypes',
                message: 'Test type?',
                choices: (answers) => {
                    if (coreAnswers.framework === 'transformers') {
                        return ['hosted-model-endpoint'];
                    }
                    return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
                },
                when: answers => answers.includeTesting,
                default: (answers) => {
                    if (coreAnswers.framework === 'transformers') {
                        return ['hosted-model-endpoint'];
                    }
                    return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
                }
            }
        ]);

        if (coreAnswers.framework === 'transformers') {
            moduleAnswers.includeSampleModel = false;
        }

        // Phase 4: Infrastructure & Performance
        console.log('\n💪 Infrastructure & Performance');
        const infraAnswers = await this.prompt([
            {
                type: 'list',
                name: 'deployTarget',
                message: 'Deployment target?',
                choices: ['sagemaker'],
                default: 'sagemaker'
            },
            {
                type: 'list',
                name: 'instanceType',
                message: 'Instance type?',
                choices: (answers) => {
                    if (coreAnswers.framework !== 'transformers') {
                        return ['cpu-optimized', 'gpu-enabled']
                    }
                    if (coreAnswers.framework === 'transformers') {
                        return ['gpu-enabled']
                    }
                },
                default: 'cpu-optimized'
            },
            {
                type: 'list',
                name: 'awsRegion',
                message: 'Target AWS region?',
                choices: ['us-east-1'],
                default: 'us-east-1'
            },
        ]);

        // Phase 6: Manual Deployment
        console.log('\n🚀 Manual Deployment');
        console.log('\n☁️ The following steps assume authentication to an AWS account.');
        console.log('\n💰 The following commands will incur charges to your AWS account.')
        console.log('\t ./build_and_push.sh -- Builds the image and pushes to ECR.')
        console.log('\t ./deploy.sh -- Deploys the image to a SageMaker AI Managed Inference Endpoint.')
        console.log('\t\t deploy.sh needs a valid IAM Role ARN as a parameter.')

        // Combine all answers
        this.answers = {
            ...projectAnswers,
            ...coreAnswers,
            ...moduleAnswers,
            ...infraAnswers,
            buildTimestamp
        };
    }

    writing() {
        // Set destination directory
        this.destinationRoot(this.answers.destinationDir);

        // Validate and fallback unsupported options
        // this._validateAnswers();

        // let testing = true
        const ignorePatterns = []
        if (this.answers.framework === 'transformers')  {
            ignorePatterns.push('**/code/model_handler.py');
            ignorePatterns.push('**/code/start_server.py');
            ignorePatterns.push('**/code/serve.py');
            ignorePatterns.push('**/nginx.conf**');
            ignorePatterns.push('**/requirements.txt**');
            ignorePatterns.push('**/test/test_local_image.sh');
            ignorePatterns.push('**/test/test_model_handler.py');
        } else {
            ignorePatterns.push('**/code/serve');
            ignorePatterns.push('**/deploy/upload_to_s3.sh');
        }
        if (this.answers.modelServer !== 'flask') {
            ignorePatterns.push('**/code/flask/**');
        }
        if (!this.answers.includeSampleModel) {
            ignorePatterns.push('**/sample_model/**');
        }
        if (!this.answers.includeTesting) {
            ignorePatterns.push('**/test/**');
        }

        // Copy templates with user answers
        this.fs.copyTpl(
            this.templatePath('**/*'),
            this.destinationPath(),
            this.answers,
            {},
            { globOptions: { ignore: ignorePatterns } } );
    }

    _validateAnswers() {
        const {
            framework,
            modelServer,
            deployTarget,
            authType,
            testTypes,
            instanceType,
            // inputFormat,
        } = this.answers;

        // Framework validation
        if (!this.SUPPORTED_OPTIONS.frameworks.includes(framework)) {
            this.env.error(`⚠️  ${framework} not implemented yet.`);
        }

        // Model Server validation
        if (!this.SUPPORTED_OPTIONS.modelServer.includes(modelServer)) {
            this.env.error(`⚠️  ${modelServer} not implemented yet.`);
        }

        // Deployment validation
        if (!this.SUPPORTED_OPTIONS.deployment.includes(deployTarget)) {
            this.env.error(`⚠️  ${deployTarget} deployment not implemented yet.`);
        }

        // Auth validation
        if (!this.SUPPORTED_OPTIONS.auth.includes(authType)) {
            this.env.error(`⚠️  ${authType} authentication not implemented yet. Using api-key.`);
        }

        // Test type validation
        if (testTypes && !this.SUPPORTED_OPTIONS.testTypes.includes(testTypes)) {
            this.env.error(`⚠️  ${testTypes} tests not implemented yet.`);
        }

        // Instance type validation
        if (!this.SUPPORTED_OPTIONS.instanceTypes.includes(instanceType)) {
            this.env.error(`⚠️  ${instanceType} instances not implemented yet.`);
        }
    }
};
