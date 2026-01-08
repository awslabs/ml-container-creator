// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Exclusion Tests
 * 
 * Tests the TemplateManager's file exclusion logic for CodeBuild vs SageMaker deployment targets.
 * This focuses on testing the exclusion patterns themselves, not the actual file generation.
 */

import TemplateManager from '../../generators/app/lib/template-manager.js';
import { setupTestHooks } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Template Exclusion Logic', () => {
    setupTestHooks('Template Exclusion Logic');

    describe('CodeBuild Deployment Target', () => {
        it('should exclude SageMaker-only files when deployTarget is codebuild', () => {
            console.log('\n  🧪 Testing CodeBuild exclusion patterns...');
            
            const answers = {
                framework: 'sklearn',
                modelServer: 'flask',
                deployTarget: 'codebuild',
                includeSampleModel: true,
                includeTesting: true
            };
            
            const templateManager = new TemplateManager(answers);
            const ignorePatterns = templateManager.getIgnorePatterns();
            
            console.log('    📋 Generated ignore patterns:', ignorePatterns);
            
            // Should exclude SageMaker-only files
            const expectedExclusions = [
                '**/deploy/build_and_push.sh'
            ];
            
            expectedExclusions.forEach(pattern => {
                if (!ignorePatterns.includes(pattern)) {
                    throw new Error(`Expected exclusion pattern not found: ${pattern}`);
                }
                console.log(`    ✅ Excludes: ${pattern}`);
            });
            
            // Should NOT exclude CodeBuild files (they should be included)
            const shouldNotExclude = [
                '**/buildspec.yml',
                '**/deploy/submit_build.sh',
                '**/IAM_PERMISSIONS.md'
            ];
            
            shouldNotExclude.forEach(pattern => {
                if (ignorePatterns.includes(pattern)) {
                    throw new Error(`Should not exclude CodeBuild file: ${pattern}`);
                }
                console.log(`    ✅ Includes: ${pattern}`);
            });
            
            console.log('    ✅ CodeBuild exclusion patterns correct');
        });
    });

    describe('SageMaker Deployment Target', () => {
        it('should exclude CodeBuild-only files when deployTarget is sagemaker', () => {
            console.log('\n  🧪 Testing SageMaker exclusion patterns...');
            
            const answers = {
                framework: 'sklearn',
                modelServer: 'flask',
                deployTarget: 'sagemaker',
                includeSampleModel: true,
                includeTesting: true
            };
            
            const templateManager = new TemplateManager(answers);
            const ignorePatterns = templateManager.getIgnorePatterns();
            
            console.log('    📋 Generated ignore patterns:', ignorePatterns);
            
            // Should exclude CodeBuild-only files
            const expectedExclusions = [
                '**/buildspec.yml',
                '**/deploy/submit_build.sh',
                '**/IAM_PERMISSIONS.md'
            ];
            
            expectedExclusions.forEach(pattern => {
                if (!ignorePatterns.includes(pattern)) {
                    throw new Error(`Expected exclusion pattern not found: ${pattern}`);
                }
                console.log(`    ✅ Excludes: ${pattern}`);
            });
            
            // Should NOT exclude SageMaker files (they should be included)
            const shouldNotExclude = [
                '**/deploy/build_and_push.sh'
            ];
            
            shouldNotExclude.forEach(pattern => {
                if (ignorePatterns.includes(pattern)) {
                    throw new Error(`Should not exclude SageMaker file: ${pattern}`);
                }
                console.log(`    ✅ Includes: ${pattern}`);
            });
            
            console.log('    ✅ SageMaker exclusion patterns correct');
        });
    });

    describe('Deployment Target Validation', () => {
        it('should validate supported deployment targets', () => {
            console.log('\n  🧪 Testing deployment target validation...');
            
            // Valid deployment targets should not throw
            const validTargets = ['sagemaker', 'codebuild'];
            
            validTargets.forEach(target => {
                const answers = {
                    framework: 'sklearn',
                    modelServer: 'flask',
                    deployTarget: target,
                    instanceType: 'cpu-optimized',
                    awsRegion: 'us-east-1'
                };
                
                const templateManager = new TemplateManager(answers);
                
                try {
                    templateManager.validate();
                    console.log(`    ✅ Valid target accepted: ${target}`);
                } catch (error) {
                    throw new Error(`Valid deployment target rejected: ${target} - ${error.message}`);
                }
            });
            
            // Invalid deployment target should throw
            const invalidAnswers = {
                framework: 'sklearn',
                modelServer: 'flask',
                deployTarget: 'invalid-target',
                instanceType: 'cpu-optimized',
                awsRegion: 'us-east-1'
            };
            
            const templateManager = new TemplateManager(invalidAnswers);
            
            try {
                templateManager.validate();
                throw new Error('Invalid deployment target should have been rejected');
            } catch (error) {
                if (error.message.includes('invalid-target not implemented yet')) {
                    console.log('    ✅ Invalid target correctly rejected: invalid-target');
                } else {
                    throw error;
                }
            }
            
            console.log('    ✅ Deployment target validation working correctly');
        });
    });

    describe('No Conflicting Patterns', () => {
        it('should not generate conflicting exclusion patterns', () => {
            console.log('\n  🧪 Testing no conflicting exclusion patterns...');
            
            const codebuildAnswers = {
                framework: 'sklearn',
                modelServer: 'flask',
                deployTarget: 'codebuild'
            };
            
            const sagemakerAnswers = {
                framework: 'sklearn',
                modelServer: 'flask',
                deployTarget: 'sagemaker'
            };
            
            const codebuildManager = new TemplateManager(codebuildAnswers);
            const sagemakerManager = new TemplateManager(sagemakerAnswers);
            
            const codebuildPatterns = codebuildManager.getIgnorePatterns();
            const sagemakerPatterns = sagemakerManager.getIgnorePatterns();
            
            console.log('    📋 CodeBuild patterns:', codebuildPatterns);
            console.log('    📋 SageMaker patterns:', sagemakerPatterns);
            
            // CodeBuild should exclude SageMaker files
            const sagemakerOnlyFiles = ['**/deploy/build_and_push.sh'];
            sagemakerOnlyFiles.forEach(file => {
                if (!codebuildPatterns.includes(file)) {
                    throw new Error(`CodeBuild should exclude SageMaker file: ${file}`);
                }
            });
            
            // SageMaker should exclude CodeBuild files
            const codebuildOnlyFiles = ['**/buildspec.yml', '**/deploy/submit_build.sh', '**/IAM_PERMISSIONS.md'];
            codebuildOnlyFiles.forEach(file => {
                if (!sagemakerPatterns.includes(file)) {
                    throw new Error(`SageMaker should exclude CodeBuild file: ${file}`);
                }
            });
            
            // No deployment target should exclude both sets of files
            const allDeploymentFiles = [...sagemakerOnlyFiles, ...codebuildOnlyFiles];
            
            const codebuildExcludesAll = allDeploymentFiles.every(file => codebuildPatterns.includes(file));
            const sagemakerExcludesAll = allDeploymentFiles.every(file => sagemakerPatterns.includes(file));
            
            if (codebuildExcludesAll) {
                throw new Error('CodeBuild should not exclude all deployment files');
            }
            
            if (sagemakerExcludesAll) {
                throw new Error('SageMaker should not exclude all deployment files');
            }
            
            console.log('    ✅ No conflicting exclusion patterns detected');
        });
    });

    describe('CodeBuild Template File Generation', () => {
        it('should generate buildspec.yml with correct content', () => {
            console.log('\n  🧪 Testing buildspec.yml template content...');
            
            const templatePath = path.join(__dirname, '../../generators/app/templates/buildspec.yml');
            
            if (!fs.existsSync(templatePath)) {
                throw new Error('buildspec.yml template file not found');
            }
            
            const content = fs.readFileSync(templatePath, 'utf8');
            
            // Check for required buildspec.yml sections
            const requiredSections = [
                'version: 0.2',
                'phases:',
                'pre_build:',
                'build:',
                'post_build:',
                'artifacts:'
            ];
            
            requiredSections.forEach(section => {
                if (!content.includes(section)) {
                    throw new Error(`buildspec.yml missing required section: ${section}`);
                }
                console.log(`    ✅ Contains section: ${section}`);
            });
            
            // Check for template variables
            const requiredVariables = [
                '<%= awsRegion %>',
                '<%= projectName %>'
            ];
            
            requiredVariables.forEach(variable => {
                if (!content.includes(variable)) {
                    throw new Error(`buildspec.yml missing template variable: ${variable}`);
                }
                console.log(`    ✅ Contains variable: ${variable}`);
            });
            
            // Check for ECR operations
            const ecrOperations = [
                'ecr get-login-password',
                'docker build',
                'docker tag',
                'docker push'
            ];
            
            ecrOperations.forEach(operation => {
                if (!content.includes(operation)) {
                    throw new Error(`buildspec.yml missing ECR operation: ${operation}`);
                }
                console.log(`    ✅ Contains ECR operation: ${operation}`);
            });
            
            console.log('    ✅ buildspec.yml template content correct');
        });

        it('should generate submit_build.sh with required functionality', () => {
            console.log('\n  🧪 Testing submit_build.sh template content...');
            
            const templatePath = path.join(__dirname, '../../generators/app/templates/deploy/submit_build.sh');
            
            if (!fs.existsSync(templatePath)) {
                throw new Error('submit_build.sh template file not found');
            }
            
            const content = fs.readFileSync(templatePath, 'utf8');
            
            // Check for required functionality
            const requiredFunctions = [
                'CodeBuild project creation',
                'IAM service role creation',
                'Build job submission',
                'Build status monitoring'
            ];
            
            const functionChecks = [
                'aws codebuild create-project',
                'aws iam create-role',
                'aws codebuild start-build',
                'aws codebuild batch-get-builds'
            ];
            
            functionChecks.forEach((check, index) => {
                if (!content.includes(check)) {
                    throw new Error(`submit_build.sh missing functionality: ${requiredFunctions[index]} (${check})`);
                }
                console.log(`    ✅ Contains: ${requiredFunctions[index]}`);
            });
            
            // Check for template variables
            const requiredVariables = [
                '<%= projectName %>',
                '<%= codebuildProjectName %>',
                '<%= awsRegion %>',
                '<%= codebuildComputeType %>'
            ];
            
            requiredVariables.forEach(variable => {
                if (!content.includes(variable)) {
                    throw new Error(`submit_build.sh missing template variable: ${variable}`);
                }
                console.log(`    ✅ Contains variable: ${variable}`);
            });
            
            // Check for environment variable support
            const envVarSupport = [
                'ML_CODEBUILD_COMPUTE_TYPE',
                'AWS_REGION',
                'ECR_REPOSITORY_NAME'
            ];
            
            envVarSupport.forEach(envVar => {
                if (!content.includes(envVar)) {
                    throw new Error(`submit_build.sh missing environment variable support: ${envVar}`);
                }
                console.log(`    ✅ Supports env var: ${envVar}`);
            });
            
            console.log('    ✅ submit_build.sh template content correct');
        });

        it('should generate IAM_PERMISSIONS.md with required documentation', () => {
            console.log('\n  🧪 Testing IAM_PERMISSIONS.md template content...');
            
            const templatePath = path.join(__dirname, '../../generators/app/templates/IAM_PERMISSIONS.md');
            
            if (!fs.existsSync(templatePath)) {
                throw new Error('IAM_PERMISSIONS.md template file not found');
            }
            
            const content = fs.readFileSync(templatePath, 'utf8');
            
            // Check for required documentation sections
            const requiredSections = [
                '# IAM Permissions for CodeBuild Deployment',
                '## CodeBuild Service Role Permissions',
                '## User/CI System Permissions',
                '## SageMaker Execution Role Permissions',
                '## Setup Instructions',
                '## Security Best Practices'
            ];
            
            requiredSections.forEach(section => {
                if (!content.includes(section)) {
                    throw new Error(`IAM_PERMISSIONS.md missing section: ${section}`);
                }
                console.log(`    ✅ Contains section: ${section}`);
            });
            
            // Check for required IAM actions
            const requiredActions = [
                'codebuild:CreateProject',
                'ecr:GetAuthorizationToken',
                'iam:CreateRole',
                'sagemaker:CreateModel',
                'logs:CreateLogGroup'
            ];
            
            requiredActions.forEach(action => {
                if (!content.includes(action)) {
                    throw new Error(`IAM_PERMISSIONS.md missing IAM action: ${action}`);
                }
                console.log(`    ✅ Documents action: ${action}`);
            });
            
            // Check for template variables
            const requiredVariables = [
                '<%= projectName %>',
                '<%= codebuildProjectName %>',
                '<%= awsRegion %>'
            ];
            
            requiredVariables.forEach(variable => {
                if (!content.includes(variable)) {
                    throw new Error(`IAM_PERMISSIONS.md missing template variable: ${variable}`);
                }
                console.log(`    ✅ Contains variable: ${variable}`);
            });
            
            console.log('    ✅ IAM_PERMISSIONS.md template content correct');
        });

        it('should modify deploy.sh with correct conditional logic', () => {
            console.log('\n  🧪 Testing deploy.sh CodeBuild integration...');
            
            const templatePath = path.join(__dirname, '../../generators/app/templates/deploy/deploy.sh');
            
            if (!fs.existsSync(templatePath)) {
                throw new Error('deploy.sh template file not found');
            }
            
            const content = fs.readFileSync(templatePath, 'utf8');
            
            // Check for conditional logic
            const conditionalChecks = [
                '<% if (deployTarget === \'codebuild\') { %>',
                '<% } else { %>',
                '<% } %>'
            ];
            
            conditionalChecks.forEach(check => {
                if (!content.includes(check)) {
                    throw new Error(`deploy.sh missing conditional logic: ${check}`);
                }
                console.log(`    ✅ Contains conditional: ${check}`);
            });
            
            // Check for CodeBuild-specific logic
            const codebuildLogic = [
                'CodeBuild deployment - image should already be in ECR',
                'aws ecr describe-images',
                './deploy/submit_build.sh'
            ];
            
            codebuildLogic.forEach(logic => {
                if (!content.includes(logic)) {
                    throw new Error(`deploy.sh missing CodeBuild logic: ${logic}`);
                }
                console.log(`    ✅ Contains CodeBuild logic: ${logic}`);
            });
            
            // Check for SageMaker fallback logic
            const sagemakerLogic = [
                'SageMaker deployment - pull locally built image',
                'docker pull'
            ];
            
            sagemakerLogic.forEach(logic => {
                if (!content.includes(logic)) {
                    throw new Error(`deploy.sh missing SageMaker logic: ${logic}`);
                }
                console.log(`    ✅ Contains SageMaker logic: ${logic}`);
            });
            
            console.log('    ✅ deploy.sh conditional logic correct');
        });
    });
});