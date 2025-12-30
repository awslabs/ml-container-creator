// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Test Utilities for Input Parsing and Generation Tests
 * 
 * This module provides common utilities, constants, and helper functions
 * used across all modular test files in the input-parsing-and-generation suite.
 */

import assert from 'yeoman-assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration constants
export const FRAMEWORKS = {
    sklearn: { formats: ['pkl', 'joblib'], servers: ['flask', 'fastapi'], hasSample: true },
    xgboost: { formats: ['json', 'model', 'ubj'], servers: ['flask', 'fastapi'], hasSample: true },
    tensorflow: { formats: ['keras', 'h5', 'SavedModel'], servers: ['flask', 'fastapi'], hasSample: true },
    transformers: { formats: [], servers: ['vllm', 'sglang'], hasSample: false }
};

export const REQUIRED_FILES = ['Dockerfile', 'deploy/build_and_push.sh', 'deploy/deploy.sh'];
export const TRADITIONAL_ML_FILES = ['requirements.txt', 'code/model_handler.py', 'code/serve.py'];
export const TRANSFORMER_FILES = ['code/serve', 'deploy/upload_to_s3.sh'];
export const SAMPLE_MODEL_FILES = ['sample_model/train_abalone.py', 'sample_model/test_inference.py'];

// Global test counter for numbering
let globalTestCounter = 0;

/**
 * Get the next test number
 */
export function getNextTestNumber() {
    return ++globalTestCounter;
}

/**
 * Reset test counter (for use in before hooks)
 */
export function resetTestCounter() {
    globalTestCounter = 0;
}

/**
 * Get the generator path for tests
 */
export function getGeneratorPath() {
    return path.join(__dirname, '../../generators/app');
}

/**
 * Create a temporary configuration file
 */
export function createTempConfig(dir, filename, config) {
    const configPath = path.join(dir, filename);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`    📁 Created config file: ${filename} with:`, JSON.stringify(config, null, 2));
    return configPath;
}

/**
 * Validate that expected files exist
 */
export function validateFiles(expectedFiles, context = '') {
    console.log(`    🔍 Checking ${expectedFiles.length} expected files${context ? ` for ${context}` : ''}...`);
    const results = [];
    
    expectedFiles.forEach(file => {
        try {
            assert.file([file]);
            console.log(`    ✅ Found: ${file}`);
            results.push({ file, status: 'found' });
        } catch (error) {
            console.log(`    ❌ Missing: ${file}`);
            results.push({ file, status: 'missing', error });
        }
    });
    
    const missing = results.filter(r => r.status === 'missing');
    if (missing.length > 0) {
        console.log(`    📊 Summary: ${results.length - missing.length}/${results.length} files found`);
        throw new Error(`Expected files not found${context ? ` in ${context}` : ''}: ${missing.map(m => m.file).join(', ')}`);
    }
    
    console.log(`    📊 Summary: All ${results.length} expected files found`);
}

/**
 * Validate file content matches pattern
 */
export function validateFileContent(file, pattern, context = '') {
    console.log(`    🔍 Checking content in ${file}${context ? ` for ${context}` : ''}...`);
    
    try {
        if (!fs.existsSync(file)) {
            throw new Error(`File ${file} does not exist`);
        }
        
        const content = fs.readFileSync(file, 'utf8');
        const patternStr = pattern instanceof RegExp ? pattern.source : pattern;
        
        if (pattern instanceof RegExp) {
            if (!pattern.test(content)) {
                throw new Error(`Pattern /${patternStr}/ not found in content`);
            }
        } else {
            if (!content.includes(pattern)) {
                throw new Error(`String "${pattern}" not found in content`);
            }
        }
        
        console.log(`    ✅ Content match in ${file}: ${patternStr}`);
    } catch (error) {
        console.log(`    ❌ Content validation failed in ${file}: ${error.message}`);
        
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf8');
            console.log(`    📄 File size: ${content.length} characters`);
            console.log(`    📄 Content preview: ${content.substring(0, 300)}...`);
            
            // Show lines that might contain the pattern
            const lines = content.split('\n');
            const patternStr = pattern instanceof RegExp ? pattern.source : pattern;
            console.log(`    🔍 Looking for pattern: ${patternStr}`);
            
            const matchingLines = lines.filter(line => {
                if (pattern instanceof RegExp) {
                    return pattern.test(line);
                }
                return line.includes(pattern);
            });
            
            if (matchingLines.length > 0) {
                console.log(`    📄 Found ${matchingLines.length} matching lines:`, matchingLines.slice(0, 3));
            } else {
                console.log('    📄 No matching lines found. First 5 lines:', lines.slice(0, 5));
            }
        }
        
        throw new Error(`Content validation failed for ${file}${context ? ` in ${context}` : ''}: ${error.message}`);
    }
}

/**
 * Validate that files do NOT exist
 */
export function validateNoFiles(unexpectedFiles, context = '') {
    console.log(`    🔍 Checking ${unexpectedFiles.length} files should NOT exist${context ? ` for ${context}` : ''}...`);
    const found = [];
    
    unexpectedFiles.forEach(file => {
        try {
            assert.noFile([file]);
            console.log(`    ✅ Correctly absent: ${file}`);
        } catch (error) {
            console.log(`    ❌ Unexpectedly found: ${file}`);
            found.push(file);
        }
    });
    
    if (found.length > 0) {
        console.log(`    📊 Summary: ${found.length} unexpected files found`);
        throw new Error(`Files should not exist${context ? ` in ${context}` : ''}: ${found.join(', ')}`);
    }
    
    console.log(`    📊 Summary: All ${unexpectedFiles.length} files correctly absent`);
}

/**
 * Debug current state for troubleshooting
 */
export function debugCurrentState(context = '') {
    console.log(`\n    🔍 DEBUG: Current state${context ? ` for ${context}` : ''}:`);
    console.log(`    📁 Working directory: ${process.cwd()}`);
    
    try {
        const files = fs.readdirSync('.');
        console.log(`    📄 Files in current directory (${files.length} total):`, files.slice(0, 10));
        if (files.length > 10) {
            console.log(`    📄 ... and ${files.length - 10} more files`);
        }
        
        // Show content of key files if they exist
        ['Dockerfile', 'requirements.txt', 'package.json'].forEach(file => {
            if (fs.existsSync(file)) {
                const content = fs.readFileSync(file, 'utf8');
                console.log(`    📄 ${file} content (first 200 chars): ${content.substring(0, 200)}...`);
            }
        });
        
        // Check for common directories
        ['code', 'deploy', 'test', 'sample_model'].forEach(dir => {
            if (fs.existsSync(dir)) {
                try {
                    const dirFiles = fs.readdirSync(dir);
                    console.log(`    📁 ${dir}/ contains: ${dirFiles.join(', ')}`);
                } catch (error) {
                    console.log(`    📁 ${dir}/ exists but cannot read contents`);
                }
            }
        });
    } catch (error) {
        console.log(`    ❌ Error reading directory: ${error.message}`);
    }
}

/**
 * Clean up environment variables between tests
 */
export function cleanupEnvironmentVariables() {
    const envVarsToClean = [
        // Legacy variables that should no longer be used
        'ML_PROJECT_NAME', 'ML_DESTINATION_DIR', 'ML_FRAMEWORK', 'ML_MODEL_FORMAT',
        'ML_MODEL_SERVER', 'ML_INCLUDE_SAMPLE_MODEL', 'ML_INCLUDE_TESTING',
        'ML_TEST_TYPES', 'ML_DEPLOY_TARGET', 'ML_AWS_REGION',
        // Currently supported variables
        'ML_INSTANCE_TYPE', 'AWS_REGION', 'AWS_ROLE', 'ML_CONTAINER_CREATOR_CONFIG'
    ];
    
    envVarsToClean.forEach(envVar => {
        if (process.env[envVar]) {
            delete process.env[envVar];
        }
    });
}

/**
 * Setup test hooks for consistent numbering and cleanup
 */
export function setupTestHooks(suiteName) {
    let testCounter = 0;

    beforeEach(function() {
        testCounter++;
        
        console.log(`\n🧪 Test #${testCounter}: ${this.currentTest.title}`);
        console.log(`📍 Test Suite: ${suiteName}`);
        
        cleanupEnvironmentVariables();
    });

    afterEach(function() {
        if (this.currentTest.state === 'failed') {
            console.log(`❌ Test #${testCounter} FAILED: ${this.currentTest.title}`);
            console.log(`📍 Suite: ${suiteName}`);
            debugCurrentState(`test #${testCounter} failure`);
        } else {
            console.log(`✅ Test #${testCounter} PASSED: ${this.currentTest.title}`);
        }
    });

    after(() => {
        console.log(`\n📊 ${suiteName} suite completed: ${testCounter} tests run`);
    });
}