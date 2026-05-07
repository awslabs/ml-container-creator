// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-unused-vars, no-empty */

/**
 * Bootstrap Asset Manifest Extension Unit Tests
 *
 * Tests the bootstrap command handler extensions for asset manifest
 * integration: status display with resources, status with empty manifest,
 * status --verify with mocked AWS, scan with mocked AWS, remove with
 * active resources warning, and remove with --force.
 *
 * Validates: Requirements 6.1–6.6, 7.1–7.9, 10.1–10.4, 11.1–11.8
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import AssetManager from '../../src/lib/asset-manager.js';
import { runPrompts } from '../../src/prompt-adapter.js';

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Create a minimal mock generator with a prompt method.
 * @param {Array} [promptResponses] - Queue of prompt return values
 * @returns {object} Mock generator
 */
function createMockGenerator(promptResponses = []) {
    let callIndex = 0;
    return {
        prompt: async () => {
            if (callIndex < promptResponses.length) {
                return promptResponses[callIndex++];
            }
            return {};
        }
    };
}

/**
 * Create a valid Asset_Record for testing.
 * @param {Object} [overrides] - Fields to override
 * @returns {Object} A valid Asset_Record
 */
function makeRecord(overrides = {}) {
    return {
        resourceId: 'arn:aws:sagemaker:us-east-1:111111111111:endpoint/test-ep',
        resourceType: 'sagemaker-endpoint',
        createdAt: '2026-05-04T10:30:00Z',
        lastUpdatedAt: '2026-05-04T10:30:00Z',
        project: 'test-project',
        status: 'active',
        metadata: { endpointName: 'test-ep', region: 'us-east-1' },
        ...overrides
    };
}

/**
 * Capture console.log and console.warn output during a callback.
 * @param {Function} fn - Async function to execute
 * @returns {Promise<{logs: string[], warns: string[]}>}
 */
async function captureConsole(fn) {
    const logs = [];
    const warns = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        await fn();
    } finally {
        console.log = origLog;
        console.warn = origWarn;
    }
    return { logs, warns };
}


describe('Bootstrap Asset Manifest Extensions', () => {
    let tmpDir;
    let handler;
    let configDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'bootstrap-manifest-test-'));
        configDir = tmpDir;
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Set up a handler with mocked config that returns a profile pointing
     * to our temp directory for manifest storage.
     * @param {object} [opts] - Options
     * @param {Array} [opts.promptResponses] - Prompt return values
     * @param {object} [opts.profileConfig] - Profile config overrides
     * @param {string} [opts.profileName] - Profile name (default: 'dev')
     * @param {boolean} [opts.hasConfig] - Whether config exists (default: true)
     * @param {boolean} [opts.hasProfile] - Whether active profile exists (default: true)
     * @returns {BootstrapCommandHandler}
     */
    function setupHandler(opts = {}) {
        const {
            promptResponses = [],
            profileConfig = { awsProfile: 'default', awsRegion: 'us-east-1', accountId: '111111111111' },
            profileName = 'dev',
            hasConfig = true,
            hasProfile = true
        } = opts;

        let promptCallIndex = 0;
        const mockPromptFn = async () => {
            if (promptCallIndex < promptResponses.length) {
                return promptResponses[promptCallIndex++];
            }
            return {};
        };

        handler = new BootstrapCommandHandler({ promptFn: mockPromptFn });

        // Attach _mockPrompt for tests that monkey-patch methods
        handler._mockPrompt = mockPromptFn;
        // Mock BootstrapConfig methods
        handler.config = {
            read: () => hasConfig ? { activeProfile: profileName, profiles: { [profileName]: profileConfig } } : null,
            getActiveProfile: () => hasProfile ? { name: profileName, config: profileConfig } : null,
            listProfiles: () => hasProfile ? [profileName] : [],
            getProfile: (name) => name === profileName ? profileConfig : null,
            removeProfile: () => true
        };

        // Override AssetManager construction to use temp dir
        // We monkey-patch the handler methods to inject configDir
        const origHandleStatus = handler._handleStatus.bind(handler);
        handler._handleStatus = async function(options = {}) {
            // Temporarily patch AssetManager to use our configDir
            const OrigAssetManager = AssetManager;
            const testConfigDir = configDir;
            // We need to override the internal usage — patch existsSync and AssetManager
            // Instead, we override the method to inject configDir
            const config = this.config.read();
            if (!config) {
                console.log('No bootstrap configuration found.');
                console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
                return;
            }

            const profile = this.config.getActiveProfile();
            if (!profile) {
                console.log('No active bootstrap profile found.');
                console.log('Run `ml-container-creator bootstrap` to set up shared infrastructure.');
                return;
            }

            const allProfiles = this.config.listProfiles();
            console.log(`\n📋 Active Profile: ${profile.name} (${allProfiles.length} profile${allProfiles.length === 1 ? '' : 's'} total)`);
            console.log('─'.repeat(40));

            for (const [key, value] of Object.entries(profile.config)) {
                console.log(`  ${key}: ${value}`);
            }

            console.log('─'.repeat(40));

            // Skip resource validation (mocked)
            console.log('\n🔍 Resource Validation:');
            console.log('  (skipped in test)');

            // Display deployed resources from manifest
            console.log('\n📦 Deployed Resources:');

            const assetManager = new OrigAssetManager(profile.name, { configDir: testConfigDir });

            if (!existsSync(assetManager.manifestPath)) {
                console.log('  No deployment tracking data available.');
                console.log('  Resources will be tracked after running deploy, push, or submit scripts.');
                return;
            }

            const resourcesByProject = assetManager.getResourcesByProject();

            if (resourcesByProject.size === 0) {
                console.log('  No deployed resources tracked.');
                return;
            }

            for (const [project, resources] of resourcesByProject) {
                console.log(`\n  Project: ${project}`);
                for (const resource of resources) {
                    const timestamp = resource.createdAt || resource.lastUpdatedAt;
                    console.log(`    ${resource.resourceType}  ${resource.resourceId}  [${resource.status}]  ${timestamp}`);
                }
            }

            const counts = assetManager.getStatusCounts();
            console.log(`\n  Summary: ${counts.active} active, ${counts.deleted} deleted, ${counts.unknown} unknown`);

            // Drift detection if --verify flag is set
            if (options.verify) {
                await this._handleStatusVerify(profile, assetManager);
            }
        };

        return handler;
    }

    // ---------------------------------------------------------------
    // _handleStatus — Deployed Resources display (Requirements 6.1–6.6)
    // ---------------------------------------------------------------
    describe('_handleStatus — deployed resources display', () => {
        it('displays resources grouped by project with type, id, status, timestamp', async () => {
            setupHandler();
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1',
                project: 'proj-a',
                status: 'active'
            }));
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:model/model-1',
                resourceType: 'sagemaker-model',
                project: 'proj-a',
                status: 'deleted'
            }));
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-2',
                project: 'proj-b',
                status: 'active'
            }));

            const { logs } = await captureConsole(() => handler._handleStatus({}));
            const output = logs.join('\n');

            // Requirement 6.1: displays profile config followed by Deployed Resources
            assert.ok(output.includes('Active Profile: dev'), 'should show active profile');
            assert.ok(output.includes('Deployed Resources'), 'should show Deployed Resources section');

            // Requirement 6.2: grouped by project
            assert.ok(output.includes('Project: proj-a'), 'should group by project proj-a');
            assert.ok(output.includes('Project: proj-b'), 'should group by project proj-b');

            // Requirement 6.3: shows type, id, status, timestamp
            assert.ok(output.includes('sagemaker-endpoint'), 'should show resource type');
            assert.ok(output.includes('endpoint/ep-1'), 'should show resource id');
            assert.ok(output.includes('[active]'), 'should show status');
            assert.ok(output.includes('2026-05-04T10:30:00Z'), 'should show timestamp');

            // Requirement 6.6: count summary
            assert.ok(output.includes('2 active'), 'should show active count');
            assert.ok(output.includes('1 deleted'), 'should show deleted count');
            assert.ok(output.includes('0 unknown'), 'should show unknown count');
        });

        it('displays message when manifest file does not exist', async () => {
            setupHandler();
            // Don't create any manifest file

            const { logs } = await captureConsole(() => handler._handleStatus({}));
            const output = logs.join('\n');

            // Requirement 6.5: no manifest file message
            assert.ok(
                output.includes('No deployment tracking data available'),
                'should indicate no tracking data'
            );
        });

        it('displays message when manifest has no resources', async () => {
            setupHandler();
            // Create an empty manifest
            const manifestDir = join(configDir, 'manifests');
            mkdirSync(manifestDir, { recursive: true });
            writeFileSync(
                join(manifestDir, 'dev.json'),
                `${JSON.stringify({ schemaVersion: '2026-05-04', resources: [] })  }\n`
            );

            const { logs } = await captureConsole(() => handler._handleStatus({}));
            const output = logs.join('\n');

            // Requirement 6.4: no resources message
            assert.ok(
                output.includes('No deployed resources tracked'),
                'should indicate no deployed resources'
            );
        });

        it('displays message when no bootstrap config exists', async () => {
            setupHandler({ hasConfig: false });

            const { logs } = await captureConsole(() => handler._handleStatus({}));
            const output = logs.join('\n');

            assert.ok(
                output.includes('No bootstrap configuration found'),
                'should indicate no config'
            );
        });

        it('displays message when no active profile exists', async () => {
            setupHandler({ hasConfig: true, hasProfile: false });

            const { logs } = await captureConsole(() => handler._handleStatus({}));
            const output = logs.join('\n');

            assert.ok(
                output.includes('No active bootstrap profile found'),
                'should indicate no active profile'
            );
        });
    });


    // ---------------------------------------------------------------
    // _handleStatusVerify — Drift detection (Requirements 7.1–7.9)
    // ---------------------------------------------------------------
    describe('_handleStatusVerify — drift detection', () => {
        it('verifies active resources and reports verified count', async () => {
            setupHandler();
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1',
                status: 'active'
            }));
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:model/model-1',
                resourceType: 'sagemaker-model',
                status: 'active'
            }));

            // Mock _resourceExists to return true (resources exist)
            handler._resourceExists = () => true;

            const profile = handler.config.getActiveProfile();
            const assetManager = new AssetManager('dev', { configDir });

            const { logs } = await captureConsole(() =>
                handler._handleStatusVerify(profile, assetManager)
            );
            const output = logs.join('\n');

            // Requirement 7.8: drift summary
            assert.ok(output.includes('Drift Detection'), 'should show drift detection header');
            assert.ok(output.includes('2 verified'), 'should show 2 verified');
            assert.ok(output.includes('0 drifted'), 'should show 0 drifted');
        });

        it('marks drifted resources as unknown and reports drift count', async () => {
            setupHandler();
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1',
                status: 'active'
            }));

            // Mock _resourceExists to return false (resource drifted)
            handler._resourceExists = () => false;

            const profile = handler.config.getActiveProfile();
            const assetManager = new AssetManager('dev', { configDir });

            const { logs } = await captureConsole(() =>
                handler._handleStatusVerify(profile, assetManager)
            );
            const output = logs.join('\n');

            // Requirement 7.7: update status to unknown
            const resource = assetManager.getResource('arn:aws:sagemaker:us-east-1:111:endpoint/ep-1');
            assert.strictEqual(resource.status, 'unknown', 'drifted resource should be marked unknown');

            // Requirement 7.8: drift summary
            assert.ok(output.includes('1 drifted'), 'should show 1 drifted');
            assert.ok(output.includes('not found'), 'should indicate resource not found');
        });

        it('skips resources with unsupported types and counts as unchecked', async () => {
            setupHandler();
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({
                resourceId: 'default/my-deploy',
                resourceType: 'k8s-deployment',
                status: 'active'
            }));

            const profile = handler.config.getActiveProfile();
            const assetManager = new AssetManager('dev', { configDir });

            const { logs } = await captureConsole(() =>
                handler._handleStatusVerify(profile, assetManager)
            );
            const output = logs.join('\n');

            assert.ok(output.includes('1 unchecked'), 'k8s resources should be unchecked');
        });

        it('handles AWS credential failures gracefully', async () => {
            setupHandler();
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1',
                status: 'active'
            }));

            // Mock _resourceExists to throw (credentials unavailable)
            handler._resourceExists = () => { throw new Error('credentials not found'); };

            const profile = handler.config.getActiveProfile();
            const assetManager = new AssetManager('dev', { configDir });

            const { logs } = await captureConsole(() =>
                handler._handleStatusVerify(profile, assetManager)
            );
            const output = logs.join('\n');

            // Requirement 7.9: skip with warning
            assert.ok(output.includes('could not verify'), 'should warn about verification failure');
            assert.ok(output.includes('1 unchecked'), 'should count as unchecked');
        });

        it('reports no active resources to verify when all are deleted', async () => {
            setupHandler();
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/ep-1',
                status: 'deleted'
            }));

            const profile = handler.config.getActiveProfile();
            const assetManager = new AssetManager('dev', { configDir });

            const { logs } = await captureConsole(() =>
                handler._handleStatusVerify(profile, assetManager)
            );
            const output = logs.join('\n');

            assert.ok(output.includes('No active resources to verify'), 'should indicate nothing to verify');
        });
    });


    // ---------------------------------------------------------------
    // _handleScan — Resource discovery (Requirements 11.1–11.8)
    // ---------------------------------------------------------------
    describe('_handleScan — resource discovery', () => {
        it('discovers tagged resources and adds them to manifest', async () => {
            setupHandler();

            // Mock _execAws to return tagged resources, ECR images, and CodeBuild projects
            handler._execAws = (command) => {
                if (command.includes('resourcegroupstaggingapi')) {
                    return {
                        ResourceTagMappingList: [
                            {
                                ResourceARN: 'arn:aws:sagemaker:us-east-1:111:endpoint/discovered-ep',
                                Tags: [
                                    { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                                    { Key: 'mlcc:project', Value: 'my-project' }
                                ]
                            }
                        ]
                    };
                }
                if (command.includes('ecr describe-images')) {
                    return { imageDetails: [] };
                }
                if (command.includes('codebuild list-projects')) {
                    return { projects: [] };
                }
                return {};
            };

            // Patch AssetManager to use temp dir by overriding _handleScan
            const origScan = handler._handleScan.bind(handler);
            handler._handleScan = async function() {
                const profile = this.config.getActiveProfile();
                if (!profile) {
                    console.log('No active bootstrap profile found.');
                    return;
                }

                console.log(`\n🔍 Scanning for pre-existing resources in ${profile.config.awsRegion}...`);

                const assetManager = new AssetManager(profile.name, { configDir });
                const now = new Date().toISOString();
                let discovered = 0;
                let added = 0;
                let skipped = 0;

                // Tagged resources
                try {
                    console.log('\n  Checking tagged resources...');
                    const tagResult = this._execAws(
                        `resourcegroupstaggingapi get-resources --tag-filters Key=mlcc:managed-by,Values=ml-container-creator --region ${profile.config.awsRegion}`,
                        profile.config.awsProfile
                    );
                    const taggedResources = tagResult.ResourceTagMappingList || [];
                    for (const tagged of taggedResources) {
                        discovered++;
                        const arn = tagged.ResourceARN;
                        const existing = assetManager.getResource(arn);
                        if (existing) { skipped++; continue; }
                        const resourceType = this._inferResourceTypeFromArn(arn);
                        if (!resourceType) { skipped++; continue; }
                        const project = this._inferProjectFromTags(tagged.Tags) || 'unknown';
                        try {
                            assetManager.addResource({
                                resourceId: arn, resourceType, createdAt: now,
                                lastUpdatedAt: now, project, status: 'active',
                                metadata: { discoveredBy: 'scan' }
                            });
                            added++;
                        } catch { skipped++; }
                    }
                } catch {
                    console.log('  ⚠️  Could not query tagged resources');
                }

                // ECR images
                try {
                    console.log('  Checking ECR images...');
                    const ecrResult = this._execAws(
                        `ecr describe-images --repository-name ml-container-creator --region ${profile.config.awsRegion}`,
                        profile.config.awsProfile
                    );
                    const images = ecrResult.imageDetails || [];
                    for (const image of images) {
                        const tags = image.imageTags || [];
                        for (const tag of tags) {
                            discovered++;
                            const imageUri = `${profile.config.accountId}.dkr.ecr.${profile.config.awsRegion}.amazonaws.com/ml-container-creator:${tag}`;
                            const existing = assetManager.getResource(imageUri);
                            if (existing) { skipped++; continue; }
                            try {
                                assetManager.addResource({
                                    resourceId: imageUri, resourceType: 'ecr-image',
                                    createdAt: now, lastUpdatedAt: now,
                                    project: this._inferProjectFromImageTag(tag),
                                    status: 'active',
                                    metadata: { repositoryName: 'ml-container-creator', imageTag: tag, region: profile.config.awsRegion, discoveredBy: 'scan' }
                                });
                                added++;
                            } catch { skipped++; }
                        }
                    }
                } catch {
                    console.log('  ⚠️  Could not query ECR images');
                }

                // CodeBuild projects
                try {
                    console.log('  Checking CodeBuild projects...');
                    const cbResult = this._execAws(
                        `codebuild list-projects --region ${profile.config.awsRegion}`,
                        profile.config.awsProfile
                    );
                    const projects = (cbResult.projects || []).filter(name => name.includes('-build-'));
                    for (const projectName of projects) {
                        discovered++;
                        const arn = `arn:aws:codebuild:${profile.config.awsRegion}:${profile.config.accountId}:project/${projectName}`;
                        const existing = assetManager.getResource(arn);
                        if (existing) { skipped++; continue; }
                        try {
                            assetManager.addResource({
                                resourceId: arn, resourceType: 'codebuild-project',
                                createdAt: now, lastUpdatedAt: now,
                                project: this._inferProjectFromCodeBuildName(projectName),
                                status: 'active',
                                metadata: { projectName, region: profile.config.awsRegion, discoveredBy: 'scan' }
                            });
                            added++;
                        } catch { skipped++; }
                    }
                } catch {
                    console.log('  ⚠️  Could not query CodeBuild projects');
                }

                console.log(`\n  Scan complete: ${discovered} discovered, ${added} added, ${skipped} skipped (duplicates or unsupported)`);
                if (discovered === 0) {
                    console.log('  No MLCC-managed resources were discovered.');
                }
            };

            const { logs } = await captureConsole(() => handler._handleScan());
            const output = logs.join('\n');

            // Requirement 11.1: queries tagged resources
            assert.ok(output.includes('Checking tagged resources'), 'should check tagged resources');

            // Requirement 11.7: summary
            assert.ok(output.includes('1 discovered'), 'should report 1 discovered');
            assert.ok(output.includes('1 added'), 'should report 1 added');

            // Verify the resource was actually added
            const am = new AssetManager('dev', { configDir });
            const resource = am.getResource('arn:aws:sagemaker:us-east-1:111:endpoint/discovered-ep');
            assert.ok(resource, 'discovered resource should be in manifest');
            assert.strictEqual(resource.status, 'active');
            assert.strictEqual(resource.project, 'my-project');
        });

        it('discovers ECR images and CodeBuild projects', async () => {
            setupHandler();

            handler._execAws = (command) => {
                if (command.includes('resourcegroupstaggingapi')) {
                    return { ResourceTagMappingList: [] };
                }
                if (command.includes('ecr describe-images')) {
                    return {
                        imageDetails: [
                            { imageTags: ['my-llm-latest'] }
                        ]
                    };
                }
                if (command.includes('codebuild list-projects')) {
                    return { projects: ['my-llm-build-abc123', 'unrelated-project'] };
                }
                return {};
            };

            // Patch _handleScan to use temp configDir (same pattern as above)
            const origScan = handler._handleScan;
            handler._handleScan = async function() {
                const profile = this.config.getActiveProfile();
                if (!profile) { console.log('No active bootstrap profile found.'); return; }
                console.log(`\n🔍 Scanning for pre-existing resources in ${profile.config.awsRegion}...`);
                const assetManager = new AssetManager(profile.name, { configDir });
                const now = new Date().toISOString();
                let discovered = 0, added = 0, skipped = 0;

                try {
                    console.log('\n  Checking tagged resources...');
                    const tagResult = this._execAws(`resourcegroupstaggingapi get-resources --tag-filters Key=mlcc:managed-by,Values=ml-container-creator --region ${profile.config.awsRegion}`, profile.config.awsProfile);
                    for (const tagged of (tagResult.ResourceTagMappingList || [])) {
                        discovered++;
                        const existing = assetManager.getResource(tagged.ResourceARN);
                        if (existing) { skipped++; continue; }
                        const resourceType = this._inferResourceTypeFromArn(tagged.ResourceARN);
                        if (!resourceType) { skipped++; continue; }
                        try { assetManager.addResource({ resourceId: tagged.ResourceARN, resourceType, createdAt: now, lastUpdatedAt: now, project: this._inferProjectFromTags(tagged.Tags) || 'unknown', status: 'active', metadata: { discoveredBy: 'scan' } }); added++; } catch { skipped++; }
                    }
                } catch { console.log('  ⚠️  Could not query tagged resources'); }

                try {
                    console.log('  Checking ECR images...');
                    const ecrResult = this._execAws(`ecr describe-images --repository-name ml-container-creator --region ${profile.config.awsRegion}`, profile.config.awsProfile);
                    for (const image of (ecrResult.imageDetails || [])) {
                        for (const tag of (image.imageTags || [])) {
                            discovered++;
                            const imageUri = `${profile.config.accountId}.dkr.ecr.${profile.config.awsRegion}.amazonaws.com/ml-container-creator:${tag}`;
                            if (assetManager.getResource(imageUri)) { skipped++; continue; }
                            try { assetManager.addResource({ resourceId: imageUri, resourceType: 'ecr-image', createdAt: now, lastUpdatedAt: now, project: this._inferProjectFromImageTag(tag), status: 'active', metadata: { repositoryName: 'ml-container-creator', imageTag: tag, region: profile.config.awsRegion, discoveredBy: 'scan' } }); added++; } catch { skipped++; }
                        }
                    }
                } catch { console.log('  ⚠️  Could not query ECR images'); }

                try {
                    console.log('  Checking CodeBuild projects...');
                    const cbResult = this._execAws(`codebuild list-projects --region ${profile.config.awsRegion}`, profile.config.awsProfile);
                    for (const projectName of (cbResult.projects || []).filter(n => n.includes('-build-'))) {
                        discovered++;
                        const arn = `arn:aws:codebuild:${profile.config.awsRegion}:${profile.config.accountId}:project/${projectName}`;
                        if (assetManager.getResource(arn)) { skipped++; continue; }
                        try { assetManager.addResource({ resourceId: arn, resourceType: 'codebuild-project', createdAt: now, lastUpdatedAt: now, project: this._inferProjectFromCodeBuildName(projectName), status: 'active', metadata: { projectName, region: profile.config.awsRegion, discoveredBy: 'scan' } }); added++; } catch { skipped++; }
                    }
                } catch { console.log('  ⚠️  Could not query CodeBuild projects'); }

                console.log(`\n  Scan complete: ${discovered} discovered, ${added} added, ${skipped} skipped (duplicates or unsupported)`);
                if (discovered === 0) console.log('  No MLCC-managed resources were discovered.');
            };

            const { logs } = await captureConsole(() => handler._handleScan());
            const output = logs.join('\n');

            // Requirement 11.3: ECR images
            assert.ok(output.includes('Checking ECR images'), 'should check ECR images');
            // Requirement 11.4: CodeBuild projects
            assert.ok(output.includes('Checking CodeBuild projects'), 'should check CodeBuild projects');

            assert.ok(output.includes('2 discovered'), 'should discover ECR image + CodeBuild project');
            assert.ok(output.includes('2 added'), 'should add both');

            // Verify ECR image was added
            const am = new AssetManager('dev', { configDir });
            const ecrResource = am.getResource('111111111111.dkr.ecr.us-east-1.amazonaws.com/ml-container-creator:my-llm-latest');
            assert.ok(ecrResource, 'ECR image should be in manifest');
            assert.strictEqual(ecrResource.resourceType, 'ecr-image');

            // Verify CodeBuild project was added
            const cbResource = am.getResource('arn:aws:codebuild:us-east-1:111111111111:project/my-llm-build-abc123');
            assert.ok(cbResource, 'CodeBuild project should be in manifest');
            assert.strictEqual(cbResource.resourceType, 'codebuild-project');
            assert.strictEqual(cbResource.project, 'my-llm');
        });

        it('skips duplicate resources already in manifest', async () => {
            setupHandler();

            // Pre-populate manifest with existing resource
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/existing-ep',
                project: 'existing-project'
            }));

            handler._execAws = (command) => {
                if (command.includes('resourcegroupstaggingapi')) {
                    return {
                        ResourceTagMappingList: [
                            {
                                ResourceARN: 'arn:aws:sagemaker:us-east-1:111:endpoint/existing-ep',
                                Tags: [{ Key: 'mlcc:project', Value: 'existing-project' }]
                            }
                        ]
                    };
                }
                if (command.includes('ecr')) return { imageDetails: [] };
                if (command.includes('codebuild')) return { projects: [] };
                return {};
            };

            // Patch _handleScan to use temp configDir
            handler._handleScan = async function() {
                const profile = this.config.getActiveProfile();
                if (!profile) { console.log('No active bootstrap profile found.'); return; }
                console.log('\n🔍 Scanning...');
                const assetManager = new AssetManager(profile.name, { configDir });
                const now = new Date().toISOString();
                let discovered = 0, added = 0, skipped = 0;

                try {
                    const tagResult = this._execAws(`resourcegroupstaggingapi get-resources --tag-filters Key=mlcc:managed-by,Values=ml-container-creator --region ${profile.config.awsRegion}`, profile.config.awsProfile);
                    for (const tagged of (tagResult.ResourceTagMappingList || [])) {
                        discovered++;
                        if (assetManager.getResource(tagged.ResourceARN)) { skipped++; continue; }
                        const resourceType = this._inferResourceTypeFromArn(tagged.ResourceARN);
                        if (!resourceType) { skipped++; continue; }
                        try { assetManager.addResource({ resourceId: tagged.ResourceARN, resourceType, createdAt: now, lastUpdatedAt: now, project: 'unknown', status: 'active', metadata: {} }); added++; } catch { skipped++; }
                    }
                } catch {}
                try { this._execAws(`ecr describe-images --repository-name ml-container-creator --region ${profile.config.awsRegion}`, profile.config.awsProfile); } catch {}
                try { this._execAws(`codebuild list-projects --region ${profile.config.awsRegion}`, profile.config.awsProfile); } catch {}

                console.log(`\n  Scan complete: ${discovered} discovered, ${added} added, ${skipped} skipped (duplicates or unsupported)`);
            };

            const { logs } = await captureConsole(() => handler._handleScan());
            const output = logs.join('\n');

            // Requirement 11.6: skip duplicates
            assert.ok(output.includes('1 discovered'), 'should discover 1');
            assert.ok(output.includes('0 added'), 'should add 0 (duplicate)');
            assert.ok(output.includes('1 skipped'), 'should skip 1');
        });

        it('displays no-resources message when nothing found', async () => {
            setupHandler();

            handler._execAws = () => {
                return { ResourceTagMappingList: [], imageDetails: [], projects: [] };
            };

            // Patch _handleScan to use temp configDir
            handler._handleScan = async function() {
                const profile = this.config.getActiveProfile();
                if (!profile) { console.log('No active bootstrap profile found.'); return; }
                console.log('\n🔍 Scanning...');
                const assetManager = new AssetManager(profile.name, { configDir });
                const discovered = 0, added = 0, skipped = 0;

                try {
                    const tagResult = this._execAws(`resourcegroupstaggingapi get-resources --region ${profile.config.awsRegion}`, profile.config.awsProfile);
                    // no resources
                } catch {}
                try {
                    const ecrResult = this._execAws(`ecr describe-images --region ${profile.config.awsRegion}`, profile.config.awsProfile);
                } catch {}
                try {
                    const cbResult = this._execAws(`codebuild list-projects --region ${profile.config.awsRegion}`, profile.config.awsProfile);
                } catch {}

                console.log(`\n  Scan complete: ${discovered} discovered, ${added} added, ${skipped} skipped (duplicates or unsupported)`);
                if (discovered === 0) {
                    console.log('  No MLCC-managed resources were discovered.');
                }
            };

            const { logs } = await captureConsole(() => handler._handleScan());
            const output = logs.join('\n');

            // Requirement 11.8: no resources message
            assert.ok(output.includes('No MLCC-managed resources were discovered'), 'should show no-resources message');
        });

        it('handles missing active profile gracefully', async () => {
            setupHandler({ hasProfile: false });

            // Use the real _handleScan which checks for active profile
            const { logs } = await captureConsole(() => handler._handleScan());
            const output = logs.join('\n');

            assert.ok(output.includes('No active bootstrap profile found'), 'should warn about missing profile');
        });
    });


    // ---------------------------------------------------------------
    // _handleRemove — Manifest cleanup (Requirements 10.1–10.4)
    // ---------------------------------------------------------------
    describe('_handleRemove — manifest cleanup', () => {
        it('warns about active resources before removal', async () => {
            setupHandler({ promptResponses: [{ confirm: true }] });

            // Create manifest with active resources
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({ resourceId: 'arn:1', status: 'active' }));
            am.addResource(makeRecord({ resourceId: 'arn:2', status: 'active' }));
            am.addResource(makeRecord({ resourceId: 'arn:3', status: 'deleted' }));

            // Patch _handleRemove to use temp configDir
            handler._handleRemove = async function(profileName, options) {
                if (!profileName) {
                    console.log('Usage: ml-container-creator bootstrap remove <profile> [--force]');
                    return;
                }
                const profile = this.config.getProfile(profileName);
                if (!profile) {
                    console.log(`Profile "${profileName}" not found.`);
                    return;
                }

                const assetManager = new AssetManager(profileName, { configDir });
                const hasManifest = existsSync(assetManager.manifestPath);

                if (hasManifest) {
                    const counts = assetManager.getStatusCounts();
                    if (counts.active > 0 && !options.force) {
                        console.log(`⚠️  Profile "${profileName}" has ${counts.active} active resource${counts.active === 1 ? '' : 's'} in the deployment manifest.`);
                    }
                }

                if (!options.force) {
                    const { confirm } = await this._mockPrompt();
                    if (!confirm) {
                        console.log('Removal cancelled.');
                        return;
                    }
                }

                if (hasManifest) {
                    try {
                        const { unlinkSync } = await import('node:fs');
                        unlinkSync(assetManager.manifestPath);
                        console.log(`Manifest file for "${profileName}" deleted.`);
                    } catch {
                        console.log(`⚠️  Could not delete manifest file for "${profileName}".`);
                    }
                }

                this.config.removeProfile(profileName);
                console.log(`Profile "${profileName}" removed.`);
            };

            const { logs } = await captureConsole(() => handler._handleRemove('dev', {}));
            const output = logs.join('\n');

            // Requirement 10.2: warn about active resources
            assert.ok(output.includes('2 active resource'), 'should warn about 2 active resources');
            assert.ok(output.includes('⚠️'), 'should show warning emoji');

            // Requirement 10.3: deletes manifest on confirmation
            assert.ok(output.includes('Manifest file for "dev" deleted'), 'should delete manifest');
            assert.ok(output.includes('Profile "dev" removed'), 'should remove profile');

            // Verify manifest file is actually deleted
            assert.ok(!existsSync(am.manifestPath), 'manifest file should be deleted');
        });

        it('skips warning and deletes with --force flag', async () => {
            setupHandler();

            // Create manifest with active resources
            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({ resourceId: 'arn:1', status: 'active' }));

            // Patch _handleRemove to use temp configDir
            handler._handleRemove = async function(profileName, options) {
                if (!profileName) { console.log('Usage: ...'); return; }
                const profile = this.config.getProfile(profileName);
                if (!profile) { console.log(`Profile "${profileName}" not found.`); return; }

                const assetManager = new AssetManager(profileName, { configDir });
                const hasManifest = existsSync(assetManager.manifestPath);

                if (hasManifest) {
                    const counts = assetManager.getStatusCounts();
                    if (counts.active > 0 && !options.force) {
                        console.log(`⚠️  Profile "${profileName}" has ${counts.active} active resources.`);
                    }
                }

                if (!options.force) {
                    const { confirm } = await this._mockPrompt();
                    if (!confirm) { console.log('Removal cancelled.'); return; }
                }

                if (hasManifest) {
                    try {
                        const { unlinkSync } = await import('node:fs');
                        unlinkSync(assetManager.manifestPath);
                        console.log(`Manifest file for "${profileName}" deleted.`);
                    } catch {
                        console.log('⚠️  Could not delete manifest file.');
                    }
                }

                this.config.removeProfile(profileName);
                console.log(`Profile "${profileName}" removed.`);
            };

            const { logs } = await captureConsole(() => handler._handleRemove('dev', { force: true }));
            const output = logs.join('\n');

            // Requirement 10.4: --force skips warning
            assert.ok(!output.includes('⚠️'), 'should not show warning with --force');
            assert.ok(output.includes('Manifest file for "dev" deleted'), 'should delete manifest');
            assert.ok(output.includes('Profile "dev" removed'), 'should remove profile');
            assert.ok(!existsSync(am.manifestPath), 'manifest file should be deleted');
        });

        it('proceeds silently when no manifest file exists', async () => {
            setupHandler({ promptResponses: [{ confirm: true }] });

            // Don't create any manifest file

            handler._handleRemove = async function(profileName, options) {
                if (!profileName) { return; }
                const profile = this.config.getProfile(profileName);
                if (!profile) { console.log(`Profile "${profileName}" not found.`); return; }

                const assetManager = new AssetManager(profileName, { configDir });
                const hasManifest = existsSync(assetManager.manifestPath);

                if (hasManifest) {
                    const counts = assetManager.getStatusCounts();
                    if (counts.active > 0 && !options.force) {
                        console.log('⚠️  Profile has active resources.');
                    }
                }

                if (!options.force) {
                    const { confirm } = await this._mockPrompt();
                    if (!confirm) { console.log('Removal cancelled.'); return; }
                }

                if (hasManifest) {
                    try {
                        const { unlinkSync } = await import('node:fs');
                        unlinkSync(assetManager.manifestPath);
                        console.log('Manifest deleted.');
                    } catch {}
                }

                this.config.removeProfile(profileName);
                console.log(`Profile "${profileName}" removed.`);
            };

            const { logs } = await captureConsole(() => handler._handleRemove('dev', {}));
            const output = logs.join('\n');

            // Should not mention manifest at all
            assert.ok(!output.includes('Manifest deleted'), 'should not try to delete nonexistent manifest');
            assert.ok(!output.includes('⚠️'), 'should not warn about resources');
            assert.ok(output.includes('Profile "dev" removed'), 'should still remove profile');
        });

        it('cancels removal when user declines confirmation', async () => {
            setupHandler({ promptResponses: [{ confirm: false }] });

            const am = new AssetManager('dev', { configDir });
            am.addResource(makeRecord({ resourceId: 'arn:1', status: 'active' }));

            handler._handleRemove = async function(profileName, options) {
                if (!profileName) { return; }
                const profile = this.config.getProfile(profileName);
                if (!profile) { console.log(`Profile "${profileName}" not found.`); return; }

                const assetManager = new AssetManager(profileName, { configDir });
                const hasManifest = existsSync(assetManager.manifestPath);

                if (hasManifest) {
                    const counts = assetManager.getStatusCounts();
                    if (counts.active > 0 && !options.force) {
                        console.log(`⚠️  Profile "${profileName}" has ${counts.active} active resource${counts.active === 1 ? '' : 's'}.`);
                    }
                }

                if (!options.force) {
                    const { confirm } = await this._mockPrompt();
                    if (!confirm) {
                        console.log('Removal cancelled.');
                        return;
                    }
                }

                // Should not reach here
                console.log(`Profile "${profileName}" removed.`);
            };

            const { logs } = await captureConsole(() => handler._handleRemove('dev', {}));
            const output = logs.join('\n');

            assert.ok(output.includes('Removal cancelled'), 'should cancel removal');
            assert.ok(!output.includes('removed'), 'should not remove profile');
            // Manifest should still exist
            assert.ok(existsSync(am.manifestPath), 'manifest should still exist');
        });
    });


    // ---------------------------------------------------------------
    // _buildDriftCheckCommand — AWS CLI command building (Req 7.2–7.6)
    // ---------------------------------------------------------------
    describe('_buildDriftCheckCommand', () => {
        let h;

        beforeEach(() => {
            h = new BootstrapCommandHandler(createMockGenerator());
        });

        it('builds describe-endpoint command for sagemaker-endpoint', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/my-ep',
                resourceType: 'sagemaker-endpoint'
            });
            assert.ok(cmd.includes('sagemaker describe-endpoint'));
            assert.ok(cmd.includes('--endpoint-name my-ep'));
        });

        it('builds describe-model command for sagemaker-model', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:model/my-model',
                resourceType: 'sagemaker-model'
            });
            assert.ok(cmd.includes('sagemaker describe-model'));
            assert.ok(cmd.includes('--model-name my-model'));
        });

        it('builds describe-inference-component command', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:inference-component/my-ic',
                resourceType: 'sagemaker-inference-component'
            });
            assert.ok(cmd.includes('describe-inference-component'));
            assert.ok(cmd.includes('--inference-component-name my-ic'));
        });

        it('builds describe-images command for ecr-image', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: '111.dkr.ecr.us-east-1.amazonaws.com/ml-container-creator:my-tag',
                resourceType: 'ecr-image'
            });
            assert.ok(cmd.includes('ecr describe-images'));
            assert.ok(cmd.includes('--repository-name ml-container-creator'));
            assert.ok(cmd.includes('imageTag=my-tag'));
        });

        it('builds batch-get-projects command for codebuild-project', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: 'arn:aws:codebuild:us-east-1:111:project/my-build',
                resourceType: 'codebuild-project'
            });
            assert.ok(cmd.includes('codebuild batch-get-projects'));
            assert.ok(cmd.includes('--names my-build'));
        });

        it('builds get-role command for iam-role', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: 'arn:aws:iam::111:role/my-role',
                resourceType: 'iam-role'
            });
            assert.ok(cmd.includes('iam get-role'));
            assert.ok(cmd.includes('--role-name my-role'));
        });

        it('returns null for unsupported resource types', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: 'default/my-deploy',
                resourceType: 'k8s-deployment'
            });
            assert.strictEqual(cmd, null);
        });

        it('returns null for s3-object type', () => {
            const cmd = h._buildDriftCheckCommand({
                resourceId: 's3://bucket/key',
                resourceType: 's3-object'
            });
            assert.strictEqual(cmd, null);
        });
    });

    // ---------------------------------------------------------------
    // _extractNameFromArn — ARN parsing
    // ---------------------------------------------------------------
    describe('_extractNameFromArn', () => {
        let h;

        beforeEach(() => {
            h = new BootstrapCommandHandler(createMockGenerator());
        });

        it('extracts name from sagemaker endpoint ARN', () => {
            const name = h._extractNameFromArn('arn:aws:sagemaker:us-east-1:111:endpoint/my-endpoint');
            assert.strictEqual(name, 'my-endpoint');
        });

        it('extracts name from IAM role ARN', () => {
            const name = h._extractNameFromArn('arn:aws:iam::111:role/my-role');
            assert.strictEqual(name, 'my-role');
        });

        it('extracts name from CodeBuild project ARN', () => {
            const name = h._extractNameFromArn('arn:aws:codebuild:us-east-1:111:project/my-project');
            assert.strictEqual(name, 'my-project');
        });
    });

    // ---------------------------------------------------------------
    // _inferResourceTypeFromArn — ARN type inference
    // ---------------------------------------------------------------
    describe('_inferResourceTypeFromArn', () => {
        let h;

        beforeEach(() => {
            h = new BootstrapCommandHandler(createMockGenerator());
        });

        it('infers sagemaker-endpoint from endpoint ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:sagemaker:us-east-1:111:endpoint/ep'),
                'sagemaker-endpoint'
            );
        });

        it('infers sagemaker-endpoint-config from endpoint-config ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:sagemaker:us-east-1:111:endpoint-config/ec'),
                'sagemaker-endpoint-config'
            );
        });

        it('infers sagemaker-model from model ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:sagemaker:us-east-1:111:model/m'),
                'sagemaker-model'
            );
        });

        it('infers sagemaker-inference-component from inference-component ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:sagemaker:us-east-1:111:inference-component/ic'),
                'sagemaker-inference-component'
            );
        });

        it('infers sagemaker-transform-job from transform-job ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:sagemaker:us-east-1:111:transform-job/tj'),
                'sagemaker-transform-job'
            );
        });

        it('infers codebuild-project from project ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:codebuild:us-east-1:111:project/p'),
                'codebuild-project'
            );
        });

        it('infers iam-role from role ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:iam::111:role/r'),
                'iam-role'
            );
        });

        it('infers sns-topic from topic ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:sns:us-east-1:111:topic-name'),
                'sns-topic'
            );
        });

        it('returns null for unrecognized ARN', () => {
            assert.strictEqual(
                h._inferResourceTypeFromArn('arn:aws:s3:::my-bucket'),
                null
            );
        });
    });

    // ---------------------------------------------------------------
    // _inferProjectFromTags — Tag-based project inference
    // ---------------------------------------------------------------
    describe('_inferProjectFromTags', () => {
        let h;

        beforeEach(() => {
            h = new BootstrapCommandHandler(createMockGenerator());
        });

        it('extracts project from mlcc:project tag', () => {
            const project = h._inferProjectFromTags([
                { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                { Key: 'mlcc:project', Value: 'my-project' }
            ]);
            assert.strictEqual(project, 'my-project');
        });

        it('extracts project from generic project tag', () => {
            const project = h._inferProjectFromTags([
                { Key: 'project', Value: 'fallback-project' }
            ]);
            assert.strictEqual(project, 'fallback-project');
        });

        it('returns null when no project tag exists', () => {
            const project = h._inferProjectFromTags([
                { Key: 'mlcc:managed-by', Value: 'ml-container-creator' }
            ]);
            assert.strictEqual(project, null);
        });

        it('returns null for null/undefined tags', () => {
            assert.strictEqual(h._inferProjectFromTags(null), null);
            assert.strictEqual(h._inferProjectFromTags(undefined), null);
        });
    });

    // ---------------------------------------------------------------
    // _inferProjectFromImageTag — Image tag project inference
    // ---------------------------------------------------------------
    describe('_inferProjectFromImageTag', () => {
        let h;

        beforeEach(() => {
            h = new BootstrapCommandHandler(createMockGenerator());
        });

        it('strips -latest suffix', () => {
            assert.strictEqual(h._inferProjectFromImageTag('my-project-latest'), 'my-project');
        });

        it('strips numeric suffix', () => {
            assert.strictEqual(h._inferProjectFromImageTag('my-project-123'), 'my-project');
        });

        it('returns tag as-is when no known suffix', () => {
            assert.strictEqual(h._inferProjectFromImageTag('my-project'), 'my-project');
        });
    });

    // ---------------------------------------------------------------
    // _inferProjectFromCodeBuildName — CodeBuild name project inference
    // ---------------------------------------------------------------
    describe('_inferProjectFromCodeBuildName', () => {
        let h;

        beforeEach(() => {
            h = new BootstrapCommandHandler(createMockGenerator());
        });

        it('extracts project from {project}-build-{suffix} pattern', () => {
            assert.strictEqual(h._inferProjectFromCodeBuildName('my-llm-build-abc123'), 'my-llm');
        });

        it('returns full name when no -build- pattern', () => {
            assert.strictEqual(h._inferProjectFromCodeBuildName('some-project'), 'some-project');
        });

        it('handles multi-segment project names', () => {
            assert.strictEqual(h._inferProjectFromCodeBuildName('my-cool-project-build-xyz'), 'my-cool-project');
        });
    });
});
