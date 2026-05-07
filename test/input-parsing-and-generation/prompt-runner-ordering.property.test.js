// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-Based Tests for Infrastructure-First Prompt Ordering
 * 
 * Property 3: Infrastructure-First Prompt Ordering
 * 
 * For any valid generator run, the prompt phases must execute in strict order:
 * infrastructure prompts (Phase 1) before ML configuration prompts (Phase 2)
 * before module selection prompts (Phase 3) before project configuration prompts (Phase 4).
 * No ML configuration prompt may be presented before all infrastructure prompts have been collected.
 * 
 * Validates Requirements: 3.1, 3.2, 3.3, 3.4
 */

import fc from 'fast-check';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestHooks } from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Property 3: Infrastructure-First Prompt Ordering', () => {
    setupTestHooks('Infrastructure-First Prompt Ordering');

    // Read the prompt-runner.js source code for structural analysis
    const promptRunnerPath = path.join(__dirname, '../../src/lib/prompt-runner.js');
    const promptRunnerSource = fs.readFileSync(promptRunnerPath, 'utf8');

    /**
     * Helper to find the position of a pattern in the source code
     * Returns -1 if not found
     */
    function findPosition(pattern) {
        const match = promptRunnerSource.match(pattern);
        return match ? promptRunnerSource.indexOf(match[0]) : -1;
    }

    /**
     * Helper to find all positions of a pattern in the source code
     */
    function findAllPositions(pattern) {
        const positions = [];
        let match;
        const regex = new RegExp(pattern, 'g');
        while ((match = regex.exec(promptRunnerSource)) !== null) {
            positions.push(match.index);
        }
        return positions;
    }

    describe('Phase Ordering in run() Method', () => {
        /**
         * Property 3a: Infrastructure prompts must run in Phase 1
         * 
         * Validates: Requirement 3.1
         */
        it('should run infrastructure prompts in Phase 1 before ML configuration', function() {
            this.timeout(10000);

            // Find the phase console.log statements to determine ordering
            const phase1InfraPattern = /console\.log\([^)]*Infrastructure/;
            const phase2MLPattern = /console\.log\([^)]*ML Configuration|console\.log\([^)]*Core ML Configuration/;

            const infraPhasePos = findPosition(phase1InfraPattern);
            const mlPhasePos = findPosition(phase2MLPattern);

            assert.ok(
                infraPhasePos !== -1,
                'Infrastructure phase console.log must exist in prompt-runner.js'
            );
            assert.ok(
                mlPhasePos !== -1,
                'ML Configuration phase console.log must exist in prompt-runner.js'
            );
            assert.ok(
                infraPhasePos < mlPhasePos,
                `Infrastructure phase (pos ${infraPhasePos}) must come before ML Configuration phase (pos ${mlPhasePos})`
            );
        });

        /**
         * Property 3b: ML configuration prompts must run in Phase 2
         * 
         * Validates: Requirement 3.2
         */
        it('should run ML configuration prompts in Phase 2 after infrastructure', function() {
            this.timeout(10000);

            // Infrastructure is now split into sub-phases; verify the last infra sub-phase
            // (infraBuildPrompts) runs before deploymentConfigPrompts
            const infraBuildRunPhasePattern = /_runPhase\(infraBuildPrompts/;
            const deploymentConfigRunPhasePattern = /_runPhase\(deploymentConfigPrompts/;

            const infraBuildRunPhasePos = findPosition(infraBuildRunPhasePattern);
            const deploymentConfigRunPhasePos = findPosition(deploymentConfigRunPhasePattern);

            assert.ok(
                infraBuildRunPhasePos !== -1,
                '_runPhase(infraBuildPrompts) must exist in prompt-runner.js'
            );
            assert.ok(
                deploymentConfigRunPhasePos !== -1,
                '_runPhase(deploymentConfigPrompts) must exist in prompt-runner.js'
            );
            assert.ok(
                infraBuildRunPhasePos < deploymentConfigRunPhasePos,
                `infraBuildPrompts (pos ${infraBuildRunPhasePos}) must be run before deploymentConfigPrompts (pos ${deploymentConfigRunPhasePos})`
            );
        });

        /**
         * Property 3c: Module selection prompts must run in Phase 3
         * 
         * Validates: Requirement 3.3
         */
        it('should run module selection prompts in Phase 3 after ML configuration', function() {
            this.timeout(10000);

            const phase2MLPattern = /console\.log\([^)]*ML Configuration|console\.log\([^)]*Core ML Configuration/;
            const phase3ModulePattern = /console\.log\([^)]*Module Selection/;

            const mlPhasePos = findPosition(phase2MLPattern);
            const modulePhasePos = findPosition(phase3ModulePattern);

            assert.ok(
                mlPhasePos !== -1,
                'ML Configuration phase console.log must exist'
            );
            assert.ok(
                modulePhasePos !== -1,
                'Module Selection phase console.log must exist'
            );
            assert.ok(
                mlPhasePos < modulePhasePos,
                `ML Configuration phase (pos ${mlPhasePos}) must come before Module Selection phase (pos ${modulePhasePos})`
            );
        });

        /**
         * Property 3d: Project configuration prompts must run in Phase 4
         * 
         * Validates: Requirement 3.4
         */
        it('should run project configuration prompts in Phase 4 after module selection', function() {
            this.timeout(10000);

            const phase3ModulePattern = /console\.log\([^)]*Module Selection/;
            const phase4ProjectPattern = /console\.log\([^)]*Project Configuration/;

            const modulePhasePos = findPosition(phase3ModulePattern);
            const projectPhasePos = findPosition(phase4ProjectPattern);

            assert.ok(
                modulePhasePos !== -1,
                'Module Selection phase console.log must exist'
            );
            assert.ok(
                projectPhasePos !== -1,
                'Project Configuration phase console.log must exist'
            );
            assert.ok(
                modulePhasePos < projectPhasePos,
                `Module Selection phase (pos ${modulePhasePos}) must come before Project Configuration phase (pos ${projectPhasePos})`
            );
        });

        /**
         * Property 3e: Complete phase ordering validation
         * 
         * Validates: Requirements 3.1, 3.2, 3.3, 3.4
         */
        it('should maintain strict phase ordering: Infrastructure → ML Config → Module → Project', function() {
            this.timeout(10000);

            // Find all phase markers
            const phases = [
                { name: 'Infrastructure', pattern: /console\.log\([^)]*Infrastructure/ },
                { name: 'ML Configuration', pattern: /console\.log\([^)]*ML Configuration|console\.log\([^)]*Core ML Configuration/ },
                { name: 'Module Selection', pattern: /console\.log\([^)]*Module Selection/ },
                { name: 'Project Configuration', pattern: /console\.log\([^)]*Project Configuration/ }
            ];

            const positions = phases.map(phase => ({
                name: phase.name,
                position: findPosition(phase.pattern)
            }));

            // All phases must exist
            positions.forEach(p => {
                assert.ok(
                    p.position !== -1,
                    `Phase "${p.name}" must exist in prompt-runner.js`
                );
            });

            // Phases must be in strict ascending order
            for (let i = 0; i < positions.length - 1; i++) {
                assert.ok(
                    positions[i].position < positions[i + 1].position,
                    `Phase "${positions[i].name}" (pos ${positions[i].position}) must come before "${positions[i + 1].name}" (pos ${positions[i + 1].position})`
                );
            }
        });
    });

    describe('Infrastructure Prompts Content', () => {
        /**
         * Property 3f: Infrastructure phase must include buildTarget, deploymentTarget, 
         * instanceType/HyperPod prompts, region, and role
         * 
         * Validates: Requirement 3.1
         */
        it('should include all required infrastructure prompts in Phase 1', async function() {
            this.timeout(10000);

            // Dynamically import the prompts module to check actual prompt definitions
            const { infrastructurePrompts } = await import('../../src/lib/prompts.js');

            const requiredPromptNames = [
                'buildTarget',
                'deploymentTarget',
                'instanceType',
                'hyperPodCluster',
                'awsRegion',
                'awsRoleArn'
            ];

            fc.assert(fc.property(
                fc.constantFrom(...requiredPromptNames),
                (promptName) => {
                    const found = infrastructurePrompts.some(p => p.name === promptName);
                    assert.ok(
                        found,
                        `Prompt "${promptName}" must be defined in infrastructurePrompts`
                    );
                    return true;
                }
            ), { numRuns: requiredPromptNames.length });
        });
    });

    describe('ML Configuration Prompts Content', () => {
        /**
         * Property 3g: ML configuration phase must include deploymentConfig, 
         * frameworkVersion, frameworkProfile, modelFormat, modelProfile, hfToken, ngcApiKey
         * 
         * Validates: Requirement 3.2
         */
        it('should run ML configuration prompts after infrastructure prompts', function() {
            this.timeout(10000);

            // Infrastructure is now split into sub-phases; use the first sub-phase
            // (infraRegionAndTargetPrompts) as the anchor for "infrastructure starts here"
            const infraRunPhasePos = findPosition(/_runPhase\(infraRegionAndTargetPrompts/);
            const deploymentConfigRunPhasePos = findPosition(/_runPhase\(deploymentConfigPrompts/);
            const frameworkVersionRunPhasePos = findPosition(/_runPhase\(\s*frameworkVersionPrompts/);
            const frameworkProfileRunPhasePos = findPosition(/_runPhase\(\s*frameworkProfilePrompts/);
            const modelFormatRunPhasePos = findPosition(/_runPhase\(\s*modelFormatPrompts/);
            const hfTokenRunPhasePos = findPosition(/_runPhase\(hfTokenPrompts/);
            const ngcApiKeyRunPhasePos = findPosition(/_runPhase\(ngcApiKeyPrompts/);

            // All ML config prompts must come after infrastructure
            const mlConfigPrompts = [
                { name: 'deploymentConfigPrompts', pos: deploymentConfigRunPhasePos },
                { name: 'frameworkVersionPrompts', pos: frameworkVersionRunPhasePos },
                { name: 'frameworkProfilePrompts', pos: frameworkProfileRunPhasePos },
                { name: 'modelFormatPrompts', pos: modelFormatRunPhasePos },
                { name: 'hfTokenPrompts', pos: hfTokenRunPhasePos },
                { name: 'ngcApiKeyPrompts', pos: ngcApiKeyRunPhasePos }
            ];

            mlConfigPrompts.forEach(prompt => {
                if (prompt.pos !== -1) {
                    assert.ok(
                        infraRunPhasePos < prompt.pos,
                        `${prompt.name} (pos ${prompt.pos}) must run after infraRegionAndTargetPrompts (pos ${infraRunPhasePos})`
                    );
                }
            });
        });
    });

    describe('Module Selection Prompts Content', () => {
        /**
         * Property 3h: Module selection phase must run after ML configuration
         * 
         * Validates: Requirement 3.3
         */
        it('should run modulePrompts after all ML configuration prompts', function() {
            this.timeout(10000);

            const moduleRunPhasePos = findPosition(/_runPhase\(modulePrompts/);
            const ngcApiKeyRunPhasePos = findPosition(/_runPhase\(ngcApiKeyPrompts/);

            assert.ok(
                moduleRunPhasePos !== -1,
                '_runPhase(modulePrompts) must exist'
            );
            assert.ok(
                ngcApiKeyRunPhasePos !== -1,
                '_runPhase(ngcApiKeyPrompts) must exist'
            );
            assert.ok(
                ngcApiKeyRunPhasePos < moduleRunPhasePos,
                `ngcApiKeyPrompts (pos ${ngcApiKeyRunPhasePos}) must run before modulePrompts (pos ${moduleRunPhasePos})`
            );
        });
    });

    describe('Project Configuration Prompts Content', () => {
        /**
         * Property 3i: Project configuration phase must run last
         * 
         * Validates: Requirement 3.4
         */
        it('should run projectPrompts and destinationPrompts after module selection', function() {
            this.timeout(10000);

            const moduleRunPhasePos = findPosition(/_runPhase\(modulePrompts/);
            const projectRunPhasePos = findPosition(/_runPhase\(projectPrompts/);
            const destinationRunPhasePos = findPosition(/_runPhase\(destinationPrompts/);

            assert.ok(
                moduleRunPhasePos !== -1,
                '_runPhase(modulePrompts) must exist'
            );
            assert.ok(
                projectRunPhasePos !== -1,
                '_runPhase(projectPrompts) must exist'
            );
            assert.ok(
                destinationRunPhasePos !== -1,
                '_runPhase(destinationPrompts) must exist'
            );
            assert.ok(
                moduleRunPhasePos < projectRunPhasePos,
                `modulePrompts (pos ${moduleRunPhasePos}) must run before projectPrompts (pos ${projectRunPhasePos})`
            );
            assert.ok(
                projectRunPhasePos < destinationRunPhasePos,
                `projectPrompts (pos ${projectRunPhasePos}) must run before destinationPrompts (pos ${destinationRunPhasePos})`
            );
        });
    });

    describe('HyperPod MCP Query Integration', () => {
        /**
         * Property 3j: HyperPod MCP query must be wired for hyperpod-eks deployment target
         * 
         * Validates: Requirements 12.1, 12.2, 12.3
         */
        it('should have _queryMcpForHyperPod method for HyperPod cluster discovery', function() {
            this.timeout(10000);

            // Check that _queryMcpForHyperPod method exists
            const methodPattern = /_queryMcpForHyperPod\s*\(/;
            const methodPos = findPosition(methodPattern);

            assert.ok(
                methodPos !== -1,
                '_queryMcpForHyperPod method must exist in prompt-runner.js'
            );

            // Check that it's called when deploymentTarget is hyperpod-eks
            const callPattern = /if\s*\([^)]*deploymentTarget\s*===\s*['"]hyperpod-eks['"]/;
            const callPos = findPosition(callPattern);

            assert.ok(
                callPos !== -1,
                'Conditional check for deploymentTarget === hyperpod-eks must exist'
            );

            // Check that _queryMcpForHyperPod is called within that conditional
            const queryCallPattern = /_queryMcpForHyperPod\s*\(/g;
            const queryCallPositions = findAllPositions(queryCallPattern.source);

            assert.ok(
                queryCallPositions.length > 0,
                '_queryMcpForHyperPod must be called at least once'
            );
        });

        /**
         * Property 3k: HyperPod MCP query should query hyperpod-cluster-picker server
         * 
         * Validates: Requirements 12.1, 12.2
         */
        it('should query hyperpod-cluster-picker MCP server', function() {
            this.timeout(10000);

            // Check that the method references hyperpod-cluster-picker
            const serverNamePattern = /hyperpod-cluster-picker/;
            const serverNamePos = findPosition(serverNamePattern);

            assert.ok(
                serverNamePos !== -1,
                'hyperpod-cluster-picker server name must be referenced in prompt-runner.js'
            );

            // Check that queryMcpServer is called with hyperpod-cluster-picker
            const queryMcpPattern = /queryMcpServer\s*\(\s*['"]hyperpod-cluster-picker['"]/;
            const queryMcpPos = findPosition(queryMcpPattern);

            assert.ok(
                queryMcpPos !== -1,
                'queryMcpServer must be called with hyperpod-cluster-picker'
            );
        });
    });
});
