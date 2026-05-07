// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Runner Replacement for yeoman-test
 *
 * Provides subprocess-based and in-memory generator execution for tests,
 * replacing yeoman-test helpers with a simpler, Yeoman-free interface.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'bin/cli.js');

/**
 * Creates a result object with assertion helpers for a generated project directory.
 *
 * @param {string} dir - Path to the generated project directory
 * @returns {object} Result object with assertion helpers
 */
function createResult(dir) {
    return {
        /** Absolute path to the generated project directory */
        dir,

        /**
         * Returns the absolute path to a file within the generated project.
         * @param {string} relativePath - Relative path within the project
         * @returns {string} Absolute path
         */
        file(relativePath) {
            return path.join(dir, relativePath);
        },

        /**
         * Asserts that a file exists in the generated project.
         * @param {string} relativePath - Relative path within the project
         * @throws {Error} If the file does not exist
         */
        assertFile(relativePath) {
            const fullPath = path.join(dir, relativePath);
            if (!fs.existsSync(fullPath)) {
                throw new Error(
                    `Expected file to exist: ${relativePath}\n  Full path: ${fullPath}`
                );
            }
        },

        /**
         * Asserts that a file exists and contains the specified content.
         * @param {string} relativePath - Relative path within the project
         * @param {string|RegExp} content - String or regex to match against file content
         * @throws {Error} If the file does not exist or does not contain the content
         */
        assertFileContent(relativePath, content) {
            const fullPath = path.join(dir, relativePath);
            if (!fs.existsSync(fullPath)) {
                throw new Error(
                    `Expected file to exist: ${relativePath}\n  Full path: ${fullPath}`
                );
            }
            const fileContent = fs.readFileSync(fullPath, 'utf8');
            if (content instanceof RegExp) {
                if (!content.test(fileContent)) {
                    throw new Error(
                        `Expected file ${relativePath} to match ${content}\n  Actual content (first 500 chars): ${fileContent.substring(0, 500)}`
                    );
                }
            } else {
                if (!fileContent.includes(content)) {
                    throw new Error(
                        `Expected file ${relativePath} to contain: "${content}"\n  Actual content (first 500 chars): ${fileContent.substring(0, 500)}`
                    );
                }
            }
        },

        /**
         * Asserts that a file does NOT exist in the generated project.
         * @param {string} relativePath - Relative path within the project
         * @throws {Error} If the file exists
         */
        assertNoFile(relativePath) {
            const fullPath = path.join(dir, relativePath);
            if (fs.existsSync(fullPath)) {
                throw new Error(
                    `Expected file NOT to exist: ${relativePath}\n  Full path: ${fullPath}`
                );
            }
        },

        /**
         * Removes the temporary project directory.
         */
        cleanup() {
            if (dir && fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    };
}

/**
 * Converts an options object to CLI flags.
 * Boolean true values become --flag, string/number values become --flag=value.
 *
 * @param {object} options - Options object (kebab-case or camelCase keys)
 * @returns {string[]} Array of CLI flag strings
 */
function optionsToFlags(options) {
    const flags = [];
    for (const [key, value] of Object.entries(options)) {
        // Convert camelCase to kebab-case
        const flag = key.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (value === true) {
            flags.push(`--${flag}`);
        } else if (value === false) {
            // Skip false booleans
            continue;
        } else if (Array.isArray(value)) {
            // Repeatable options: --flag=val1 --flag=val2
            for (const item of value) {
                flags.push(`--${flag}=${item}`);
            }
        } else if (value !== undefined && value !== null) {
            flags.push(`--${flag}=${value}`);
        }
    }
    return flags;
}

/**
 * Creates a unique temporary directory for test output.
 *
 * @param {string} [prefix='mlcc-test-'] - Prefix for the temp directory name
 * @returns {string} Absolute path to the created temp directory
 */
function createTempDir(prefix = 'mlcc-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Runs the generator CLI in a subprocess within a temporary directory.
 *
 * @param {object} [options={}] - CLI options to pass to the generator
 * @param {object} [execOptions={}] - Additional execution options
 * @param {string} [execOptions.projectName] - Positional project name argument
 * @param {number} [execOptions.timeout=60000] - Subprocess timeout in ms
 * @param {object} [execOptions.env] - Additional environment variables
 * @returns {object} Result object with dir, file(), assertFile(), assertFileContent(), assertNoFile(), cleanup()
 */
export function runGenerator(options = {}, execOptions = {}) {
    const {
        projectName,
        timeout = 60000,
        env: extraEnv = {}
    } = execOptions;

    const tempDir = createTempDir();

    // Build CLI arguments
    const args = [];
    if (projectName) {
        args.push(projectName);
    }

    // Always include --skip-prompts and --force behavior
    const mergedOptions = {
        'skip-prompts': true,
        ...options
    };

    // If no project-dir specified, set it to the temp directory
    if (!mergedOptions['project-dir'] && !mergedOptions['projectDir']) {
        mergedOptions['project-dir'] = tempDir;
    }

    args.push(...optionsToFlags(mergedOptions));

    // Build environment
    const env = {
        ...process.env,
        VALIDATE_ENV_VARS: 'false',
        ...extraEnv
    };

    try {
        execFileSync(process.execPath, [CLI_PATH, ...args], {
            cwd: tempDir,
            env,
            timeout,
            stdio: 'pipe'
        });
    } catch (error) {
        // Attach output to the error for debugging
        const stdout = error.stdout ? error.stdout.toString() : '';
        const stderr = error.stderr ? error.stderr.toString() : '';
        const wrappedError = new Error(
            `Generator CLI failed:\n  Command: node ${CLI_PATH} ${args.join(' ')}\n  Exit code: ${error.status}\n  stdout: ${stdout.substring(0, 1000)}\n  stderr: ${stderr.substring(0, 1000)}`
        );
        wrappedError.stdout = stdout;
        wrappedError.stderr = stderr;
        wrappedError.exitCode = error.status;
        // Clean up on failure
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw wrappedError;
    }

    // Determine the actual output directory
    // The generator may create a subdirectory named after the project
    const outputDir = mergedOptions['project-dir'] || mergedOptions['projectDir'] || tempDir;

    return createResult(outputDir);
}

/**
 * Runs the generator CLI using a JSON configuration file.
 *
 * @param {string} configPath - Absolute path to the JSON configuration file
 * @param {object} [execOptions={}] - Additional execution options
 * @param {number} [execOptions.timeout=60000] - Subprocess timeout in ms
 * @param {object} [execOptions.env] - Additional environment variables
 * @returns {object} Result object with dir, file(), assertFile(), assertFileContent(), assertNoFile(), cleanup()
 */
export function runGeneratorWithConfig(configPath, execOptions = {}) {
    const {
        timeout = 60000,
        env: extraEnv = {}
    } = execOptions;

    // Read the config to determine the output directory
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const tempDir = createTempDir();

    const args = [
        `--config=${configPath}`,
        '--skip-prompts'
    ];

    // If config doesn't specify project-dir, use temp dir
    if (!config['project-dir'] && !config.projectDir) {
        args.push(`--project-dir=${tempDir}`);
    }

    const env = {
        ...process.env,
        VALIDATE_ENV_VARS: 'false',
        ...extraEnv
    };

    try {
        execFileSync(process.execPath, [CLI_PATH, ...args], {
            cwd: tempDir,
            env,
            timeout,
            stdio: 'pipe'
        });
    } catch (error) {
        const stdout = error.stdout ? error.stdout.toString() : '';
        const stderr = error.stderr ? error.stderr.toString() : '';
        const wrappedError = new Error(
            `Generator CLI (config mode) failed:\n  Config: ${configPath}\n  Exit code: ${error.status}\n  stdout: ${stdout.substring(0, 1000)}\n  stderr: ${stderr.substring(0, 1000)}`
        );
        wrappedError.stdout = stdout;
        wrappedError.stderr = stderr;
        wrappedError.exitCode = error.status;
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw wrappedError;
    }

    const outputDir = config['project-dir'] || config.projectDir || tempDir;

    return createResult(outputDir);
}

/**
 * Runs the generator in-memory by importing src/app.js directly.
 * Faster than subprocess but requires the module interface to be stable.
 *
 * @param {object} [options={}] - CLI options to pass to the generator
 * @param {object} [execOptions={}] - Additional execution options
 * @param {string} [execOptions.projectName] - Positional project name argument
 * @param {object} [execOptions.env] - Additional environment variables to set during execution
 * @returns {Promise<object>} Result object with dir, file(), assertFile(), assertFileContent(), assertNoFile(), cleanup()
 */
export async function runGeneratorInMemory(options = {}, execOptions = {}) {
    const {
        projectName,
        env: extraEnv = {}
    } = execOptions;

    const tempDir = createTempDir();

    // Set environment variables for the duration of the run
    const originalEnv = {};
    const envOverrides = {
        VALIDATE_ENV_VARS: 'false',
        ...extraEnv
    };

    for (const [key, value] of Object.entries(envOverrides)) {
        originalEnv[key] = process.env[key];
        process.env[key] = value;
    }

    // Merge options with defaults
    const mergedOptions = {
        'skip-prompts': true,
        ...options
    };

    if (!mergedOptions['project-dir'] && !mergedOptions['projectDir']) {
        mergedOptions['project-dir'] = tempDir;
    }

    try {
        // Dynamic import to avoid module caching issues
        const { run } = await import('../../src/app.js');
        await run(projectName, mergedOptions);
    } catch (error) {
        // Restore environment
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        // Clean up on failure
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw error;
    }

    // Restore environment
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    const outputDir = mergedOptions['project-dir'] || mergedOptions['projectDir'] || tempDir;

    return createResult(outputDir);
}

// Export helpers for use in tests
export { createResult, optionsToFlags, createTempDir };

export default {
    runGenerator,
    runGeneratorWithConfig,
    runGeneratorInMemory,
    createResult,
    optionsToFlags,
    createTempDir
};
