// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Variable Substitution Property-Based Tests
 * 
 * Tests the correctness properties for template variable substitution in CodeBuild templates.
 * Each property validates universal behavior across many generated inputs.
 * 
 * Feature: codebuild-deployment-target
 */

import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import ejs from 'ejs';
import { setupTestHooks } from './test-utils.js';

describe('Template Variable Substitution - Property-Based Tests', () => {
    before(async () => {
        console.log('\n🚀 Starting Template Variable Substitution Property Tests');
        console.log('📋 Testing: Universal correctness properties for template variable substitution');
        console.log('🔧 Configuration: 100 iterations per property');
        console.log('✅ Property test environment ready\n');
    });

    setupTestHooks('Template Variable Substitution Properties');

    describe('Property 6: Template Variable Substitution', () => {
        it('should properly substitute all template variables in CodeBuild template files', async function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 6: Template Variable Substitution');
            console.log('  📝 For any CodeBuild template files generated, all template variables should be properly substituted with configuration values');
            
            // Feature: codebuild-deployment-target, Property 6: Template Variable Substitution
            await fc.assert(fc.property(
                fc.record({
                    projectName: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-]{2,18}$/),
                    codebuildProjectName: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-_]{4,28}$/),
                    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'),
                    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
                    framework: fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers'),
                    deployTarget: fc.constant('codebuild'),
                    awsRoleArn: fc.oneof(
                        fc.constant(''),
                        fc.constant(null),
                        fc.stringMatching(/^arn:aws:iam::[0-9]{12}:role\/[a-zA-Z0-9+=,.@_-]{1,64}$/)
                    ),
                    instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled')
                }),
                (answers) => {
                    console.log(`    🔍 Testing template substitution: project=${answers.projectName}, region=${answers.awsRegion}, compute=${answers.codebuildComputeType}`);
                    
                    // Test buildspec.yml template substitution
                    const buildspecPath = path.join(process.cwd(), 'generators/app/templates/buildspec.yml');
                    if (fs.existsSync(buildspecPath)) {
                        const buildspecTemplate = fs.readFileSync(buildspecPath, 'utf8');
                        const renderedBuildspec = ejs.render(buildspecTemplate, answers);
                        
                        // Verify no template variables remain
                        const templateVariablePattern = /<%[^%]*%>/g;
                        const remainingVariables = renderedBuildspec.match(templateVariablePattern);
                        
                        if (remainingVariables) {
                            throw new Error(`buildspec.yml contains unsubstituted template variables: ${remainingVariables.join(', ')}`);
                        }
                        
                        // Verify specific substitutions occurred
                        if (!renderedBuildspec.includes(answers.awsRegion)) {
                            throw new Error(`buildspec.yml should contain AWS region: ${answers.awsRegion}`);
                        }
                        
                        if (!renderedBuildspec.includes(answers.projectName)) {
                            throw new Error(`buildspec.yml should contain project name: ${answers.projectName}`);
                        }
                        
                        console.log(`    ✅ buildspec.yml template variables substituted correctly`);
                    }
                    
                    // Test submit_build.sh template substitution
                    const submitBuildPath = path.join(process.cwd(), 'generators/app/templates/deploy/submit_build.sh');
                    if (fs.existsSync(submitBuildPath)) {
                        const submitBuildTemplate = fs.readFileSync(submitBuildPath, 'utf8');
                        const renderedSubmitBuild = ejs.render(submitBuildTemplate, answers);
                        
                        // Verify no template variables remain
                        const templateVariablePattern = /<%[^%]*%>/g;
                        const remainingVariables = renderedSubmitBuild.match(templateVariablePattern);
                        
                        if (remainingVariables) {
                            throw new Error(`submit_build.sh contains unsubstituted template variables: ${remainingVariables.join(', ')}`);
                        }
                        
                        // Verify specific substitutions occurred
                        const requiredSubstitutions = [
                            answers.projectName,
                            answers.codebuildProjectName,
                            answers.awsRegion,
                            answers.codebuildComputeType
                        ];
                        
                        requiredSubstitutions.forEach(substitution => {
                            if (!renderedSubmitBuild.includes(substitution)) {
                                throw new Error(`submit_build.sh should contain substitution: ${substitution}`);
                            }
                        });
                        
                        console.log(`    ✅ submit_build.sh template variables substituted correctly`);
                    }
                    
                    // Test IAM_PERMISSIONS.md template substitution
                    const iamPermissionsPath = path.join(process.cwd(), 'generators/app/templates/IAM_PERMISSIONS.md');
                    if (fs.existsSync(iamPermissionsPath)) {
                        const iamPermissionsTemplate = fs.readFileSync(iamPermissionsPath, 'utf8');
                        const renderedIamPermissions = ejs.render(iamPermissionsTemplate, answers);
                        
                        // Verify no template variables remain
                        const templateVariablePattern = /<%[^%]*%>/g;
                        const remainingVariables = renderedIamPermissions.match(templateVariablePattern);
                        
                        if (remainingVariables) {
                            throw new Error(`IAM_PERMISSIONS.md contains unsubstituted template variables: ${remainingVariables.join(', ')}`);
                        }
                        
                        // Verify specific substitutions occurred
                        const requiredSubstitutions = [
                            answers.projectName,
                            answers.codebuildProjectName,
                            answers.awsRegion
                        ];
                        
                        requiredSubstitutions.forEach(substitution => {
                            if (!renderedIamPermissions.includes(substitution)) {
                                throw new Error(`IAM_PERMISSIONS.md should contain substitution: ${substitution}`);
                            }
                        });
                        
                        console.log(`    ✅ IAM_PERMISSIONS.md template variables substituted correctly`);
                    }
                    
                    // Test deploy.sh template substitution with CodeBuild conditional
                    const deployPath = path.join(process.cwd(), 'generators/app/templates/deploy/deploy.sh');
                    if (fs.existsSync(deployPath)) {
                        const deployTemplate = fs.readFileSync(deployPath, 'utf8');
                        const renderedDeploy = ejs.render(deployTemplate, answers);
                        
                        // Verify no template variables remain
                        const templateVariablePattern = /<%[^%]*%>/g;
                        const remainingVariables = renderedDeploy.match(templateVariablePattern);
                        
                        if (remainingVariables) {
                            throw new Error(`deploy.sh contains unsubstituted template variables: ${remainingVariables.join(', ')}`);
                        }
                        
                        // For CodeBuild deployment, should contain CodeBuild-specific logic
                        if (answers.deployTarget === 'codebuild') {
                            if (!renderedDeploy.includes('CodeBuild deployment - image should already be in ECR')) {
                                throw new Error(`deploy.sh should contain CodeBuild-specific logic for deployTarget=codebuild`);
                            }
                            
                            if (!renderedDeploy.includes('./deploy/submit_build.sh')) {
                                throw new Error(`deploy.sh should reference submit_build.sh for CodeBuild deployment`);
                            }
                            
                            // Should NOT contain SageMaker-specific logic
                            if (renderedDeploy.includes('SageMaker deployment - pull locally built image')) {
                                throw new Error(`deploy.sh should not contain SageMaker logic for CodeBuild deployment`);
                            }
                        }
                        
                        console.log(`    ✅ deploy.sh template variables and conditionals substituted correctly`);
                    }
                    
                    console.log(`    ✅ All CodeBuild template variables substituted correctly`);
                    return true;
                }
            ), { 
                numRuns: 100,
                verbose: false
            });
            
            console.log('  ✅ Property 6 validated: Template variable substitution working correctly');
        });

        it('should handle special characters and edge cases in template variables', async function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 6b: Special Characters in Template Variables');
            console.log('  📝 For any template variables containing special characters, substitution should handle them correctly');
            
            // Feature: codebuild-deployment-target, Property 6: Template Variable Substitution (edge cases)
            await fc.assert(fc.property(
                fc.record({
                    projectName: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-]{2,13}$/),
                    codebuildProjectName: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-_]{4,23}$/),
                    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
                    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
                    framework: fc.constantFrom('sklearn', 'transformers'),
                    deployTarget: fc.constant('codebuild'),
                    awsRoleArn: fc.oneof(
                        fc.constant(''),
                        fc.constant(null),
                        fc.stringMatching(/^arn:aws:iam::[0-9]{12}:role\/[a-zA-Z0-9+=,.@_-]{1,64}$/)
                    ),
                    instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled')
                }),
                (answers) => {
                    console.log(`    🔍 Testing edge case substitution: project=${answers.projectName}, codebuildProject=${answers.codebuildProjectName}`);
                    
                    // Test that project names with hyphens work correctly
                    const buildspecPath = path.join(process.cwd(), 'generators/app/templates/buildspec.yml');
                    if (fs.existsSync(buildspecPath)) {
                        const buildspecTemplate = fs.readFileSync(buildspecPath, 'utf8');
                        
                        try {
                            const renderedBuildspec = ejs.render(buildspecTemplate, answers);
                            
                            // Should not throw errors and should contain the project name
                            if (!renderedBuildspec.includes(answers.projectName)) {
                                throw new Error(`Project name with special characters not substituted: ${answers.projectName}`);
                            }
                            
                            // Should be valid YAML (basic check - no template syntax remaining)
                            if (renderedBuildspec.includes('<%') || renderedBuildspec.includes('%>')) {
                                throw new Error(`Template syntax remaining in rendered buildspec.yml`);
                            }
                            
                            console.log(`    ✅ Special characters handled correctly in buildspec.yml`);
                            
                        } catch (error) {
                            throw new Error(`Template rendering failed for project name "${answers.projectName}": ${error.message}`);
                        }
                    }
                    
                    // Test submit_build.sh with special characters
                    const submitBuildPath = path.join(process.cwd(), 'generators/app/templates/deploy/submit_build.sh');
                    if (fs.existsSync(submitBuildPath)) {
                        const submitBuildTemplate = fs.readFileSync(submitBuildPath, 'utf8');
                        
                        try {
                            const renderedSubmitBuild = ejs.render(submitBuildTemplate, answers);
                            
                            // Should contain both project names
                            if (!renderedSubmitBuild.includes(answers.projectName)) {
                                throw new Error(`Project name not substituted in submit_build.sh: ${answers.projectName}`);
                            }
                            
                            if (!renderedSubmitBuild.includes(answers.codebuildProjectName)) {
                                throw new Error(`CodeBuild project name not substituted: ${answers.codebuildProjectName}`);
                            }
                            
                            // Should be valid shell script (basic check)
                            if (!renderedSubmitBuild.includes('#!/bin/bash')) {
                                throw new Error(`submit_build.sh should start with shebang`);
                            }
                            
                            console.log(`    ✅ Special characters handled correctly in submit_build.sh`);
                            
                        } catch (error) {
                            throw new Error(`Template rendering failed for CodeBuild project name "${answers.codebuildProjectName}": ${error.message}`);
                        }
                    }
                    
                    console.log(`    ✅ Edge case template substitution working correctly`);
                    return true;
                }
            ), { 
                numRuns: 100,
                verbose: false
            });
            
            console.log('  ✅ Property 6b validated: Special character handling in template substitution working correctly');
        });

        it('should maintain template structure integrity after variable substitution', async function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 6c: Template Structure Integrity');
            console.log('  📝 For any template variable substitution, the overall template structure should remain intact');
            
            // Feature: codebuild-deployment-target, Property 6: Template Variable Substitution (structure integrity)
            await fc.assert(fc.property(
                fc.record({
                    projectName: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-]{3,10}$/),
                    codebuildProjectName: fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9\-_]{5,18}$/),
                    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'),
                    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
                    framework: fc.constantFrom('sklearn', 'xgboost', 'tensorflow'),
                    deployTarget: fc.constant('codebuild'),
                    awsRoleArn: fc.oneof(
                        fc.constant(''),
                        fc.constant(null),
                        fc.stringMatching(/^arn:aws:iam::[0-9]{12}:role\/[a-zA-Z0-9+=,.@_-]{1,64}$/)
                    ),
                    instanceType: fc.constantFrom('cpu-optimized', 'gpu-enabled')
                }),
                (answers) => {
                    console.log(`    🔍 Testing structure integrity: project=${answers.projectName}, region=${answers.awsRegion}`);
                    
                    // Test buildspec.yml structure integrity
                    const buildspecPath = path.join(process.cwd(), 'generators/app/templates/buildspec.yml');
                    if (fs.existsSync(buildspecPath)) {
                        const buildspecTemplate = fs.readFileSync(buildspecPath, 'utf8');
                        const renderedBuildspec = ejs.render(buildspecTemplate, answers);
                        
                        // Should maintain YAML structure
                        const requiredYamlStructure = [
                            'version: 0.2',
                            'phases:',
                            'pre_build:',
                            'commands:',
                            'build:',
                            'post_build:',
                            'artifacts:'
                        ];
                        
                        requiredYamlStructure.forEach(structure => {
                            if (!renderedBuildspec.includes(structure)) {
                                throw new Error(`buildspec.yml missing required YAML structure: ${structure}`);
                            }
                        });
                        
                        // Should maintain proper indentation (basic check)
                        const lines = renderedBuildspec.split('\n');
                        const indentedLines = lines.filter(line => line.startsWith('  ') || line.startsWith('    '));
                        
                        if (indentedLines.length === 0) {
                            throw new Error(`buildspec.yml should have properly indented YAML content`);
                        }
                        
                        console.log(`    ✅ buildspec.yml structure integrity maintained`);
                    }
                    
                    // Test submit_build.sh structure integrity
                    const submitBuildPath = path.join(process.cwd(), 'generators/app/templates/deploy/submit_build.sh');
                    if (fs.existsSync(submitBuildPath)) {
                        const submitBuildTemplate = fs.readFileSync(submitBuildPath, 'utf8');
                        const renderedSubmitBuild = ejs.render(submitBuildTemplate, answers);
                        
                        // Should maintain shell script structure
                        const requiredShellStructure = [
                            '#!/bin/bash',
                            'set -e',
                            'aws codebuild create-project',
                            'aws codebuild start-build',
                            'aws codebuild batch-get-builds'
                        ];
                        
                        requiredShellStructure.forEach(structure => {
                            if (!renderedSubmitBuild.includes(structure)) {
                                throw new Error(`submit_build.sh missing required shell structure: ${structure}`);
                            }
                        });
                        
                        // Should maintain proper variable assignments
                        const variableAssignments = [
                            'PROJECT_NAME=',
                            'CODEBUILD_PROJECT_NAME=',
                            'AWS_REGION=',
                            'COMPUTE_TYPE='
                        ];
                        
                        variableAssignments.forEach(assignment => {
                            if (!renderedSubmitBuild.includes(assignment)) {
                                throw new Error(`submit_build.sh missing variable assignment: ${assignment}`);
                            }
                        });
                        
                        console.log(`    ✅ submit_build.sh structure integrity maintained`);
                    }
                    
                    // Test IAM_PERMISSIONS.md structure integrity
                    const iamPermissionsPath = path.join(process.cwd(), 'generators/app/templates/IAM_PERMISSIONS.md');
                    if (fs.existsSync(iamPermissionsPath)) {
                        const iamPermissionsTemplate = fs.readFileSync(iamPermissionsPath, 'utf8');
                        const renderedIamPermissions = ejs.render(iamPermissionsTemplate, answers);
                        
                        // Should maintain Markdown structure
                        const requiredMarkdownStructure = [
                            '# IAM Permissions for CodeBuild Deployment',
                            '## CodeBuild Service Role Permissions',
                            '## User/CI System Permissions',
                            '```json',
                            '"Version": "2012-10-17"'
                        ];
                        
                        requiredMarkdownStructure.forEach(structure => {
                            if (!renderedIamPermissions.includes(structure)) {
                                throw new Error(`IAM_PERMISSIONS.md missing required Markdown structure: ${structure}`);
                            }
                        });
                        
                        console.log(`    ✅ IAM_PERMISSIONS.md structure integrity maintained`);
                    }
                    
                    console.log(`    ✅ All template structure integrity maintained after substitution`);
                    return true;
                }
            ), { 
                numRuns: 100,
                verbose: false
            });
            
            console.log('  ✅ Property 6c validated: Template structure integrity maintained after substitution');
        });
    });

    after(() => {
        console.log('\n📊 Template Variable Substitution Property Tests completed');
        console.log('✅ All universal correctness properties validated');
    });
});