// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Test Utilities for Input Parsing and Generation Tests
 * 
 * This module provides common utilities, constants, and helper functions
 * used across all modular test files in the input-parsing-and-generation suite.
 */

// eslint-disable-next-line no-unused-vars
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line no-unused-vars
const __dirname = path.dirname(__filename);

// Test configuration constants
export const FRAMEWORKS = {
    sklearn: { formats: ['pkl', 'joblib'], servers: ['flask', 'fastapi'], hasSample: true },
    xgboost: { formats: ['json', 'model', 'ubj'], servers: ['flask', 'fastapi'], hasSample: true },
    tensorflow: { formats: ['keras', 'h5', 'SavedModel'], servers: ['flask', 'fastapi'], hasSample: true },
    transformers: { formats: [], servers: ['vllm', 'sglang', 'tensorrt-llm'], hasSample: false }
};

export const REQUIRED_FILES = ['Dockerfile'];
export const TRADITIONAL_ML_FILES = ['requirements.txt', 'code/model_handler.py', 'code/serve.py'];
export const TRANSFORMER_FILES = ['code/serve'];
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
    expectedFiles.forEach(file => {
        const fullPath = path.resolve(file);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`Expected file not found${context ? ` in ${context}` : ''}: ${file}`);
        }
    });
}

/**
 * Validate file content matches pattern
 */
export function validateFileContent(file, pattern, context = '') {
    try {
        if (!fs.existsSync(file)) {
            throw new Error(`File ${file} does not exist`);
        }
        
        const content = fs.readFileSync(file, 'utf8');
        
        if (pattern instanceof RegExp) {
            if (!pattern.test(content)) {
                throw new Error(`Pattern /${pattern.source}/ not found in ${file}`);
            }
        } else {
            if (!content.includes(pattern)) {
                throw new Error(`String "${pattern}" not found in ${file}`);
            }
        }
    } catch (error) {
        throw new Error(`Content validation failed for ${file}${context ? ` in ${context}` : ''}: ${error.message}`);
    }
}

/**
 * Validate that files do NOT exist
 */
export function validateNoFiles(unexpectedFiles, context = '') {
    const found = [];
    
    unexpectedFiles.forEach(file => {
        const fullPath = path.resolve(file);
        if (fs.existsSync(fullPath)) {
            found.push(file);
        }
    });
    
    if (found.length > 0) {
        throw new Error(`Files should not exist${context ? ` in ${context}` : ''}: ${found.join(', ')}`);
    }
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
export function setupTestHooks() {
    let testCounter = 0;

    beforeEach(() => {
        testCounter++;
        cleanupEnvironmentVariables();
    });

    afterEach(function() {
        if (this.currentTest.state === 'failed') {
            debugCurrentState(`test #${testCounter} failure`);
        }
    });
}