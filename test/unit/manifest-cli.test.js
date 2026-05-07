// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest CLI Wrapper Unit Tests
 *
 * Tests argument parsing, add/delete/list dispatch, no-profile warning,
 * missing args usage, and invalid input handling.
 *
 * Validates: Requirements 9.1–9.7
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AssetManager from '../../src/lib/asset-manager.js';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

// We test the exported main function by monkey-patching BootstrapConfig
// and capturing console output.

/**
 * Helper to capture console output during a function call.
 * Returns { stdout, stderr, warns } arrays of logged strings.
 */
function captureOutput(fn) {
    const stdout = [];
    const stderr = [];
    const warns = [];
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;

    console.log = (...args) => stdout.push(args.join(' '));
    console.error = (...args) => stderr.push(args.join(' '));
    console.warn = (...args) => warns.push(args.join(' '));

    try {
        fn();
        return { stdout, stderr, warns };
    } finally {
        console.log = origLog;
        console.error = origError;
        console.warn = origWarn;
    }
}

/**
 * Create a fake argv array simulating: node manifest-cli.js <...args>
 */
function fakeArgv(...args) {
    return ['node', '/path/to/manifest-cli.js', ...args];
}

describe('manifest-cli', () => {
    let tmpDir;
    let configDir;
    let origExitCode;

    // We dynamically import the module to get the main function
    let main;

    before(async () => {
        const mod = await import('../../src/lib/manifest-cli.js');
        main = mod.main;
    });

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'manifest-cli-test-'));
        configDir = join(tmpDir, 'mlcc-config');
        origExitCode = process.exitCode;
        process.exitCode = undefined;
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        process.exitCode = origExitCode;
    });

    /**
     * Set up a bootstrap config with an active profile pointing to our temp dir.
     * Returns the config path so BootstrapConfig can find it.
     */
    function setupBootstrapConfig(profileName = 'test-profile') { // eslint-disable-line no-unused-vars
        const configPath = join(configDir, 'config.json');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(configPath, `${JSON.stringify({
            activeProfile: profileName,
            profiles: {
                [profileName]: {
                    awsProfile: 'default',
                    awsRegion: 'us-east-1',
                    accountId: '111111111111',
                    ecrRepositoryName: 'ml-container-creator'
                }
            }
        }, null, 2)  }\n`);
        return configPath;
    }

    /**
     * Create a main function that uses our test config directory.
     * We do this by monkey-patching BootstrapConfig and AssetManager constructors.
     */
    function runCli(...args) {
        // We need to intercept the BootstrapConfig and AssetManager constructors
        // Since main() creates them internally, we'll use a different approach:
        // We'll create a wrapper that tests the parsing and dispatch logic.
        return captureOutput(() => main(fakeArgv(...args)));
    }

    // ---------------------------------------------------------------
    // No subcommand — prints usage
    // ---------------------------------------------------------------
    describe('no subcommand', () => {
        it('prints usage when no subcommand is provided', () => {
            // Temporarily patch BootstrapConfig to avoid file system access
            const origRead = BootstrapConfig.prototype.read;
            BootstrapConfig.prototype.read = () => null;

            try {
                const { stdout } = runCli();
                assert.ok(stdout.some(l => l.includes('Usage:')), 'should print usage');
                assert.strictEqual(process.exitCode, 1);
            } finally {
                BootstrapConfig.prototype.read = origRead;
            }
        });
    });

    // ---------------------------------------------------------------
    // No active profile — prints warning, exits 0
    // ---------------------------------------------------------------
    describe('no active profile', () => {
        it('prints warning when no active bootstrap profile exists', () => {
            const origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => null;

            try {
                const { warns } = runCli('add', '--type', 'sagemaker-endpoint', '--id', 'arn:test', '--project', 'proj');
                assert.ok(warns.some(w => w.includes('No active bootstrap profile')), 'should warn about missing profile');
                assert.ok(!process.exitCode || process.exitCode === 0, 'should exit with code 0');
            } finally {
                BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
            }
        });

        it('prints warning for delete when no profile exists', () => {
            const origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => null;

            try {
                const { warns } = runCli('delete', '--id', 'arn:test');
                assert.ok(warns.some(w => w.includes('No active bootstrap profile')));
            } finally {
                BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
            }
        });

        it('prints warning for list when no profile exists', () => {
            const origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => null;

            try {
                const { warns } = runCli('list');
                assert.ok(warns.some(w => w.includes('No active bootstrap profile')));
            } finally {
                BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
            }
        });
    });

    // ---------------------------------------------------------------
    // Unknown subcommand
    // ---------------------------------------------------------------
    describe('unknown subcommand', () => {
        it('prints error for unknown subcommand', () => {
            const origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => ({ name: 'test', config: {} });

            // Also need to patch AssetManager to use temp dir
            const origConstructor = AssetManager.prototype.constructor; // eslint-disable-line no-unused-vars

            try {
                const { stderr } = runCli('unknown-cmd');
                assert.ok(stderr.some(l => l.includes('Unknown subcommand')), 'should report unknown subcommand');
                assert.strictEqual(process.exitCode, 1);
            } finally {
                BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
            }
        });
    });

    // ---------------------------------------------------------------
    // add subcommand
    // ---------------------------------------------------------------
    describe('add subcommand', () => {
        let origGetActiveProfile;
        let manifestDir; // eslint-disable-line no-unused-vars

        beforeEach(() => {
            manifestDir = join(tmpDir, 'manifests');
            origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => ({ name: 'test-profile', config: {} });

            // Patch AssetManager to use our temp configDir
            const origManifestPath = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');
            AssetManager._origManifestPath = origManifestPath;
        });

        afterEach(() => {
            BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
        });

        it('prints error when --type is missing', () => {
            const { stderr } = runCli('add', '--id', 'arn:test', '--project', 'proj');
            assert.ok(stderr.some(l => l.includes('--type, --id, and --project are required')));
            assert.strictEqual(process.exitCode, 1);
        });

        it('prints error when --id is missing', () => {
            const { stderr } = runCli('add', '--type', 'sagemaker-endpoint', '--project', 'proj');
            assert.ok(stderr.some(l => l.includes('--type, --id, and --project are required')));
            assert.strictEqual(process.exitCode, 1);
        });

        it('prints error when --project is missing', () => {
            const { stderr } = runCli('add', '--type', 'sagemaker-endpoint', '--id', 'arn:test');
            assert.ok(stderr.some(l => l.includes('--type, --id, and --project are required')));
            assert.strictEqual(process.exitCode, 1);
        });

        it('prints error for invalid resource type', () => {
            const { stderr } = runCli('add', '--type', 'invalid-type', '--id', 'arn:test', '--project', 'proj');
            assert.ok(stderr.some(l => l.includes('Invalid resource type')));
            assert.strictEqual(process.exitCode, 1);
        });

        it('prints error for invalid --meta JSON', () => {
            const { stderr } = runCli('add', '--type', 'sagemaker-endpoint', '--id', 'arn:test', '--project', 'proj', '--meta', '{bad json}');
            assert.ok(stderr.some(l => l.includes('Invalid JSON for --meta')));
            assert.strictEqual(process.exitCode, 1);
        });

        it('successfully adds a resource to the manifest', () => {
            // Override AssetManager to use temp dir
            const origConstructor = AssetManager; // eslint-disable-line no-unused-vars
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath'); // eslint-disable-line no-unused-vars

            // Monkey-patch the constructor to inject configDir
            const origInit = AssetManager.prototype.constructor; // eslint-disable-line no-unused-vars
            const patchedNew = function(profileName, options = {}) { // eslint-disable-line no-unused-vars
                this.profileName = profileName;
                this.configDir = testConfigDir;
            };

            // Instead of patching constructor, let's patch at a higher level
            // We'll directly test that the add command writes to the manifest
            // by patching getActiveProfile and the AssetManager configDir

            // Simpler approach: patch the homedir-based default
            const origConfigDir = AssetManager.prototype.constructor; // eslint-disable-line no-unused-vars
            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                const { stdout } = runCli('add', '--type', 'sagemaker-endpoint', '--id', 'arn:aws:sagemaker:us-east-1:111:endpoint/my-ep', '--project', 'my-project');
                assert.ok(stdout.some(l => l.includes('Added sagemaker-endpoint')));
                assert.ok(!process.exitCode || process.exitCode === 0);

                // Verify the manifest file was created
                const manifestPath = join(testConfigDir, 'manifests', 'test-profile.json');
                const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
                assert.strictEqual(data.resources.length, 1);
                assert.strictEqual(data.resources[0].resourceType, 'sagemaker-endpoint');
                assert.strictEqual(data.resources[0].resourceId, 'arn:aws:sagemaker:us-east-1:111:endpoint/my-ep');
                assert.strictEqual(data.resources[0].project, 'my-project');
                assert.strictEqual(data.resources[0].status, 'active');
                assert.ok(data.resources[0].createdAt);
                assert.ok(data.resources[0].lastUpdatedAt);
                assert.deepStrictEqual(data.resources[0].metadata, {});
            } finally {
                // Restore original manifestPath
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });

        it('adds a resource with --meta JSON', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                const meta = JSON.stringify({ endpointName: 'my-ep', instanceType: 'ml.g5.xlarge' });
                const { stdout } = runCli('add', '--type', 'sagemaker-endpoint', '--id', 'arn:test', '--project', 'proj', '--meta', meta);
                assert.ok(stdout.some(l => l.includes('Added sagemaker-endpoint')));

                const manifestPath = join(testConfigDir, 'manifests', 'test-profile.json');
                const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
                assert.deepStrictEqual(data.resources[0].metadata, {
                    endpointName: 'my-ep',
                    instanceType: 'ml.g5.xlarge'
                });
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });
    });

    // ---------------------------------------------------------------
    // delete subcommand
    // ---------------------------------------------------------------
    describe('delete subcommand', () => {
        let origGetActiveProfile;

        beforeEach(() => {
            origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => ({ name: 'test-profile', config: {} });
        });

        afterEach(() => {
            BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
        });

        it('prints error when --id is missing', () => {
            const { stderr } = runCli('delete');
            assert.ok(stderr.some(l => l.includes('--id is required')));
            assert.strictEqual(process.exitCode, 1);
        });

        it('marks existing resource as deleted', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                // First add a resource
                const manager = new AssetManager('test-profile');
                manager.addResource({
                    resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1',
                    resourceType: 'sagemaker-endpoint',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj',
                    status: 'active',
                    metadata: {}
                });

                // Now delete via CLI
                const { stdout } = runCli('delete', '--id', 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1');
                assert.ok(stdout.some(l => l.includes('Marked as deleted')));

                // Verify status changed
                const resource = manager.getResource('arn:aws:sagemaker:us-east-1:111:endpoint/ep-1');
                assert.strictEqual(resource.status, 'deleted');
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });

        it('reports when resource is not found', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                const { stdout } = runCli('delete', '--id', 'arn:nonexistent');
                assert.ok(stdout.some(l => l.includes('Resource not found')));
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });
    });

    // ---------------------------------------------------------------
    // list subcommand
    // ---------------------------------------------------------------
    describe('list subcommand', () => {
        let origGetActiveProfile;

        beforeEach(() => {
            origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => ({ name: 'test-profile', config: {} });
        });

        afterEach(() => {
            BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
        });

        it('lists all resources from the manifest', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                // Add some resources
                const manager = new AssetManager('test-profile');
                manager.addResource({
                    resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1',
                    resourceType: 'sagemaker-endpoint',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj-a',
                    status: 'active',
                    metadata: {}
                });
                manager.addResource({
                    resourceId: 'arn:aws:sagemaker:us-east-1:111:model/model-1',
                    resourceType: 'sagemaker-model',
                    createdAt: '2026-05-04T11:00:00Z',
                    lastUpdatedAt: '2026-05-04T11:00:00Z',
                    project: 'proj-b',
                    status: 'deleted',
                    metadata: {}
                });

                const { stdout } = runCli('list');
                // Should print table header and rows
                assert.ok(stdout.some(l => l.includes('Type')), 'should print table header');
                assert.ok(stdout.some(l => l.includes('sagemaker-endpoint')), 'should list endpoint');
                assert.ok(stdout.some(l => l.includes('sagemaker-model')), 'should list model');
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });

        it('shows "No resources found" for empty manifest', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                const { stdout } = runCli('list');
                assert.ok(stdout.some(l => l.includes('No resources found')));
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });

        it('filters by --project', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                const manager = new AssetManager('test-profile');
                manager.addResource({
                    resourceId: 'arn:ep-1',
                    resourceType: 'sagemaker-endpoint',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj-a',
                    status: 'active',
                    metadata: {}
                });
                manager.addResource({
                    resourceId: 'arn:ep-2',
                    resourceType: 'sagemaker-endpoint',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj-b',
                    status: 'active',
                    metadata: {}
                });

                const { stdout } = runCli('list', '--project', 'proj-a');
                assert.ok(stdout.some(l => l.includes('proj-a')), 'should show proj-a resources');
                assert.ok(!stdout.some(l => l.includes('proj-b')), 'should not show proj-b resources');
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });

        it('filters by --status', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                const manager = new AssetManager('test-profile');
                manager.addResource({
                    resourceId: 'arn:ep-1',
                    resourceType: 'sagemaker-endpoint',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj',
                    status: 'active',
                    metadata: {}
                });
                manager.addResource({
                    resourceId: 'arn:ep-2',
                    resourceType: 'sagemaker-endpoint',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj',
                    status: 'deleted',
                    metadata: {}
                });

                const { stdout } = runCli('list', '--status', 'active');
                assert.ok(stdout.some(l => l.includes('arn:ep-1')), 'should show active resource');
                assert.ok(!stdout.some(l => l.includes('arn:ep-2')), 'should not show deleted resource');
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });

        it('filters by --type', () => {
            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                const manager = new AssetManager('test-profile');
                manager.addResource({
                    resourceId: 'arn:ep-1',
                    resourceType: 'sagemaker-endpoint',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj',
                    status: 'active',
                    metadata: {}
                });
                manager.addResource({
                    resourceId: 'arn:model-1',
                    resourceType: 'sagemaker-model',
                    createdAt: '2026-05-04T10:00:00Z',
                    lastUpdatedAt: '2026-05-04T10:00:00Z',
                    project: 'proj',
                    status: 'active',
                    metadata: {}
                });

                const { stdout } = runCli('list', '--type', 'sagemaker-model');
                assert.ok(stdout.some(l => l.includes('sagemaker-model')), 'should show model');
                assert.ok(!stdout.some(l => l.includes('sagemaker-endpoint')), 'should not show endpoint');
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
            }
        });
    });

    // ---------------------------------------------------------------
    // Argument parsing
    // ---------------------------------------------------------------
    describe('argument parsing', () => {
        it('handles flags in any order', () => {
            const origGetActiveProfile = BootstrapConfig.prototype.getActiveProfile;
            BootstrapConfig.prototype.getActiveProfile = () => ({ name: 'test-profile', config: {} });

            const testConfigDir = tmpDir;
            const origProto = Object.getOwnPropertyDescriptor(AssetManager.prototype, 'manifestPath');

            Object.defineProperty(AssetManager.prototype, 'manifestPath', {
                get() {
                    return join(testConfigDir, 'manifests', `${this.profileName}.json`);
                },
                configurable: true
            });

            try {
                // Flags in different order: --project first, then --id, then --type
                const { stdout } = runCli('add', '--project', 'my-proj', '--id', 'arn:test-id', '--type', 'ecr-image');
                assert.ok(stdout.some(l => l.includes('Added ecr-image')));

                const manifestPath = join(testConfigDir, 'manifests', 'test-profile.json');
                const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
                assert.strictEqual(data.resources[0].resourceType, 'ecr-image');
                assert.strictEqual(data.resources[0].resourceId, 'arn:test-id');
                assert.strictEqual(data.resources[0].project, 'my-proj');
            } finally {
                Object.defineProperty(AssetManager.prototype, 'manifestPath', origProto);
                BootstrapConfig.prototype.getActiveProfile = origGetActiveProfile;
            }
        });
    });
});
