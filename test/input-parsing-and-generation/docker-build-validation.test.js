// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Docker Build Validation Tests (Optional)
 * 
 * Optional tests that validate Docker builds for generated projects.
 * These tests are opt-in via the DOCKER_BUILD_TESTS environment variable.
 * 
 * Usage:
 *   DOCKER_BUILD_TESTS=true npm test -- docker-build-validation.test.js
 * 
 * Requirements: 10.11, 10.12, 10.13
 * 
 * Note: These tests use the new CLI-based runner with deployment-config flags.
 * The generator supports both the new deploymentConfig format and the legacy
 * separate framework/modelServer format.
 */

import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';
import { describe, it, before } from 'mocha';
import assert from 'assert';

// Check if Docker build tests are enabled
const DOCKER_BUILD_TESTS_ENABLED = process.env.DOCKER_BUILD_TESTS === 'true';

describe('Docker Build Validation (Optional)', () => {
    
    before(() => {
        if (!DOCKER_BUILD_TESTS_ENABLED) {
            console.log('\n⏭️  Docker Build Tests are disabled');
            console.log('   To enable: DOCKER_BUILD_TESTS=true npm test -- docker-build-validation.test.js');
            console.log('   Requirements: Docker must be installed and running\n');
        } else {
            console.log('\n🚀 Starting Docker Build Validation Tests');
            console.log('📋 Testing: Docker builds for generated projects');
            console.log('⚠️  Note: These tests require Docker to be installed and running');
            console.log('✅ Test environment ready\n');
            
            // Verify Docker is available
            try {
                execSync('docker --version', { stdio: 'ignore' });
            } catch (error) {
                throw new Error('Docker is not available. Please install Docker to run these tests.');
            }
        }
    });

    /**
     * Helper function to build Docker image and log results
     */
    function buildDockerImage(projectDir, imageName) {
        const startTime = Date.now();
        let buildSuccess = false;
        let imageSize = null;
        
        // Build Docker image
        execSync(
            `docker build -t ${imageName} .`,
            {
                cwd: projectDir,
                encoding: 'utf-8',
                stdio: 'pipe'
            }
        );
        
        buildSuccess = true;
        
        // Get image size
        const inspectOutput = execSync(
            `docker inspect ${imageName} --format='{{.Size}}'`,
            { encoding: 'utf-8' }
        );
        imageSize = parseInt(inspectOutput.trim());
        
        const buildTime = Date.now() - startTime;
        
        // Log build results
        const result = {
            success: buildSuccess,
            buildTime,
            imageSize,
            imageName,
            timestamp: new Date().toISOString()
        };
        
        // Write build log
        const logDir = path.join(projectDir, 'build-logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logFile = path.join(logDir, 'docker-build.json');
        fs.writeFileSync(logFile, JSON.stringify(result, null, 2));
        
        console.log('\n   📊 Build Results:');
        console.log(`      Status: ${buildSuccess ? '✅ Success' : '❌ Failed'}`);
        console.log(`      Build Time: ${(buildTime / 1000).toFixed(2)}s`);
        if (imageSize) {
            console.log(`      Image Size: ${(imageSize / 1024 / 1024).toFixed(2)} MB`);
        }
        console.log(`      Log: ${logFile}`);
        
        return result;
    }

    /**
     * Helper function to cleanup Docker image
     */
    function cleanupDockerImage(imageName) {
        try {
            execSync(`docker rmi ${imageName}`, { stdio: 'ignore' });
        } catch (error) {
            // Ignore cleanup errors
        }
    }

    describe('sklearn Docker Build', () => {
        
        (DOCKER_BUILD_TESTS_ENABLED ? it : it.skip)('should build Docker image for sklearn project', function() {
            this.timeout(300000); // 5 minutes for Docker build
            
            console.log('\n  🧪 Testing Docker build for sklearn project...');
            console.log('  📝 Validates: Requirements 10.11, 10.12, 10.13');
            
            const imageName = 'test-sklearn-build';
            let result;
            
            try {
                // Generate project
                result = runGenerator({
                    'deployment-config': 'http-flask',
                    'model-format': 'pkl',
                    'include-sample': false,
                    'include-testing': false,
                    'build-target': 'codebuild',
                    'instance-type': 'ml.m5.large',
                    'region': 'us-east-1',
                    'project-name': 'test-sklearn-docker'
                });
                
                const projectDir = result.dir;
                
                // Build Docker image
                const buildResult = buildDockerImage(projectDir, imageName);
                
                // Assert build succeeded
                assert.ok(buildResult.success, 'Docker build should succeed');
                assert.ok(buildResult.buildTime > 0, 'Build time should be recorded');
                assert.ok(buildResult.imageSize > 0, 'Image size should be recorded');
                
                console.log('   ✅ sklearn Docker build successful');
                
            } finally {
                // Cleanup
                cleanupDockerImage(imageName);
                if (result) {
                    result.cleanup();
                }
            }
        });
    });

    describe('transformers Docker Build', () => {
        
        (DOCKER_BUILD_TESTS_ENABLED ? it : it.skip)('should build Docker image for transformers project with vLLM', function() {
            this.timeout(300000); // 5 minutes for Docker build
            
            console.log('\n  🧪 Testing Docker build for transformers/vLLM project...');
            console.log('  📝 Validates: Requirements 10.11, 10.12, 10.13');
            
            const imageName = 'test-vllm-build';
            let result;
            
            try {
                // Generate project
                result = runGenerator({
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'openai/gpt-oss-20b',
                    'include-sample': false,
                    'include-testing': false,
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1',
                    'project-name': 'test-vllm-docker'
                });
                
                const projectDir = result.dir;
                
                // Build Docker image
                const buildResult = buildDockerImage(projectDir, imageName);
                
                // Assert build succeeded
                assert.ok(buildResult.success, 'Docker build should succeed');
                assert.ok(buildResult.buildTime > 0, 'Build time should be recorded');
                assert.ok(buildResult.imageSize > 0, 'Image size should be recorded');
                
                console.log('   ✅ transformers/vLLM Docker build successful');
                
            } finally {
                // Cleanup
                cleanupDockerImage(imageName);
                if (result) {
                    result.cleanup();
                }
            }
        });
    });

    describe('Build Log Format', () => {
        
        (DOCKER_BUILD_TESTS_ENABLED ? it : it.skip)('should create build log with required fields', function() {
            this.timeout(300000); // 5 minutes for Docker build
            
            console.log('\n  🧪 Testing build log format...');
            console.log('  📝 Validates: Requirements 10.12');
            
            const imageName = 'test-log-format';
            let result;
            
            try {
                // Generate project
                result = runGenerator({
                    'deployment-config': 'http-flask',
                    'model-format': 'json',
                    'include-sample': false,
                    'include-testing': false,
                    'build-target': 'codebuild',
                    'instance-type': 'ml.m5.large',
                    'region': 'us-east-1',
                    'project-name': 'test-log-format-docker'
                });
                
                const projectDir = result.dir;
                
                // Build Docker image
                buildDockerImage(projectDir, imageName);
                
                // Read build log
                const logFile = path.join(projectDir, 'build-logs', 'docker-build.json');
                assert.ok(fs.existsSync(logFile), 'Build log file should exist');
                
                const logContent = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
                
                // Verify required fields
                assert.ok(typeof logContent.success === 'boolean', 'Log should have success field');
                assert.ok(typeof logContent.buildTime === 'number', 'Log should have buildTime field');
                assert.ok(logContent.imageName, 'Log should have imageName field');
                assert.ok(logContent.timestamp, 'Log should have timestamp field');
                
                if (logContent.success) {
                    assert.ok(typeof logContent.imageSize === 'number', 'Log should have imageSize field for successful builds');
                }
                
                console.log('   ✅ Build log format is correct');
                
            } finally {
                // Cleanup
                cleanupDockerImage(imageName);
                if (result) {
                    result.cleanup();
                }
            }
        });
    });

    describe('Build Failure Handling', () => {
        
        (DOCKER_BUILD_TESTS_ENABLED ? it : it.skip)('should handle and log build failures gracefully', function() {
            this.timeout(300000); // 5 minutes for Docker build
            
            console.log('\n  🧪 Testing build failure handling...');
            console.log('  📝 Validates: Requirements 10.12');
            
            const imageName = 'test-build-failure';
            let result;
            
            try {
                // Generate project
                result = runGenerator({
                    'deployment-config': 'http-flask',
                    'model-format': 'pkl',
                    'include-sample': false,
                    'include-testing': false,
                    'build-target': 'codebuild',
                    'instance-type': 'ml.m5.large',
                    'region': 'us-east-1',
                    'project-name': 'test-failure-docker'
                });
                
                const projectDir = result.dir;
                
                // Corrupt Dockerfile to cause build failure
                const dockerfilePath = path.join(projectDir, 'Dockerfile');
                fs.writeFileSync(dockerfilePath, 'INVALID DOCKERFILE CONTENT\n');
                
                // Attempt to build Docker image
                const buildResult = buildDockerImage(projectDir, imageName);
                
                // Assert build failed
                assert.strictEqual(buildResult.success, false, 'Build should fail with invalid Dockerfile');
                
                // Verify log was created even for failure
                const logFile = path.join(projectDir, 'build-logs', 'docker-build.json');
                assert.ok(fs.existsSync(logFile), 'Build log should exist even for failures');
                
                const logContent = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
                assert.strictEqual(logContent.success, false, 'Log should indicate failure');
                
                console.log('   ✅ Build failure handled gracefully');
                
            } finally {
                // Cleanup (image won't exist, but try anyway)
                cleanupDockerImage(imageName);
                if (result) {
                    result.cleanup();
                }
            }
        });
    });
});
