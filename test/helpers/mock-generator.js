// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock Generator Helper
 * 
 * Provides minimal mock generator objects for unit testing ConfigManager
 * and other generator components without running the full CLI.
 * 
 * Post-Yeoman interface: only `options`, `args`, `destDir`, and `templateDir`
 * are exposed. The old Yeoman-specific mocks (destinationRoot, destinationPath,
 * env, config, fs) have been removed since no tests depend on them.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates a mock generator object with minimal required properties.
 * @param {Object} options - Options to pass to the generator
 * @param {Array} args - Positional arguments to pass to the generator
 * @param {string} destDir - Destination directory for generated output
 * @returns {Object} Mock generator object
 */
export function createMockGenerator(options = {}, args = [], destDir = process.cwd()) {
    return {
        options,
        args,
        destDir,
        templateDir: path.resolve(__dirname, '../../templates')
    };
}

/**
 * Creates a mock generator with specific CLI options
 * @param {Object} cliOptions - CLI options to set
 * @returns {Object} Mock generator object
 */
export function createMockGeneratorWithOptions(cliOptions) {
    return createMockGenerator(cliOptions, []);
}

/**
 * Creates a mock generator with positional arguments
 * @param {Array} args - Positional arguments
 * @returns {Object} Mock generator object
 */
export function createMockGeneratorWithArgs(args) {
    return createMockGenerator({}, args);
}

/**
 * Creates a mock generator with environment variables set
 * @param {Object} envVars - Environment variables to set
 * @returns {Object} Mock generator object with env vars set
 */
export function createMockGeneratorWithEnv(envVars) {
    // Set environment variables
    Object.entries(envVars).forEach(([key, value]) => {
        process.env[key] = value;
    });
    
    return createMockGenerator({}, []);
}

/**
 * Cleans up environment variables after test
 * @param {Array<string>} envVarNames - Names of environment variables to clean up
 */
export function cleanupEnvVars(envVarNames) {
    envVarNames.forEach(name => {
        delete process.env[name];
    });
}

/**
 * Creates a mock generator with a custom destination directory
 * @param {string} destDir - Custom destination directory
 * @returns {Object} Mock generator object
 */
export function createMockGeneratorWithDestination(destDir) {
    return createMockGenerator({}, [], destDir);
}

export default {
    createMockGenerator,
    createMockGeneratorWithOptions,
    createMockGeneratorWithArgs,
    createMockGeneratorWithEnv,
    cleanupEnvVars,
    createMockGeneratorWithDestination
};
