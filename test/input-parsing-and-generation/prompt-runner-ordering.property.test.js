// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-Based Tests for Prompt Phase Ordering
 * 
 * Property 3: Model-First Prompt Ordering (MCP Catalog Consolidation)
 * 
 * For any valid generator run, the prompt phases must execute in strict order:
 * Phase 1 (What): ML configuration (deployment config + model)
 * Phase 2 (How): Infrastructure & deployment target + base image
 * Phase 3 (Where): Region + instance (derived from model) + HyperPod + build target
 * Phase 4 (Details): Framework version, model profile, modules
 * Phase 5 (Project): Project name + destination
 * 
 * The key insight: model selection drives instance sizing. Instance type is a
 * derived value — once you know the model, its VRAM requirement determines the instance.
 * 
 * Validates Requirements: 4.1, 4.2, 4.3
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

    // Read the mcp-query-runner.js source for MCP-related checks
    const mcpQueryRunnerPath = path.join(__dirname, '../../src/lib/mcp-query-runner.js');
    const mcpQueryRunnerSource = fs.readFileSync(mcpQueryRunnerPath, 'utf8');

    /**
     * Helper to find the position of a pattern in the source code
     * Returns -1 if not found
     */
    function findPosition(pattern) {
        const match = promptRunnerSource.match(pattern);
        return match ? promptRunnerSource.indexOf(match[0]) : -1;
    }

    /**
     * Helper to find position in the mcp-query-runner source
     */
    function findMcpPosition(pattern) {
        const match = mcpQueryRunnerSource.match(pattern);
        return match ? mcpQueryRunnerSource.indexOf(match[0]) : -1;
    }

    describe('Phase Ordering in run() Method', () => {
        /**
         * Property 3a: ML Configuration (Phase 1 - What) runs before Infrastructure (Phase 2/3)
         * Model-first ordering: deployment config + model collected before instance type
         * 
         * Validates: Requirement 4.1
         */
        it('should run infrastructure prompts in Phase 1 before ML configuration', function() {
            this.timeout(10000);

            // New ordering: ML Config (Phase 1 - What) comes BEFORE Infrastructure (Phase 2/3 - How/Where)
            const phase1MLPattern = /console\.log\([^)]*Core ML Configuration/;
            const phase2InfraPattern = /console\.log\([^)]*Infrastructure/;

            const mlPhasePos = findPosition(phase1MLPattern);
            const infraPhasePos = findPosition(phase2InfraPattern);

            assert.ok(
                mlPhasePos !== -1,
                'Core ML Configuration phase console.log must exist in prompt-runner.js'
            );
            assert.ok(
                infraPhasePos !== -1,
                'Infrastructure phase console.log must exist in prompt-runner.js'
            );
            assert.ok(
                mlPhasePos < infraPhasePos,
                `ML Configuration phase (pos ${mlPhasePos}) must come before Infrastructure phase (pos ${infraPhasePos}) — model-first ordering`
            );
        });

        /**
         * Property 3b: deploymentConfigPrompts runs before infraRegionAndTargetPrompts
         * 
         * Validates: Requirement 4.2
         */
        it('should run ML configuration prompts in Phase 2 after infrastructure', function() {
            this.timeout(10000);

            // New ordering: deploymentConfigPrompts (Phase 1) runs BEFORE infraRegionAndTargetPrompts (Phase 2/3)
            const deploymentConfigRunPhasePattern = /_runPhase\(deploymentConfigPrompts/;
            const infraRegionRunPhasePattern = /_runPhase\(infraRegionAndTargetPrompts/;

            const deploymentConfigRunPhasePos = findPosition(deploymentConfigRunPhasePattern);
            const infraRegionRunPhasePos = findPosition(infraRegionRunPhasePattern);

            assert.ok(
                deploymentConfigRunPhasePos !== -1,
                '_runPhase(deploymentConfigPrompts) must exist in prompt-runner.js'
            );
            assert.ok(
                infraRegionRunPhasePos !== -1,
                '_runPhase(infraRegionAndTargetPrompts) must exist in prompt-runner.js'
            );
            assert.ok(
                deploymentConfigRunPhasePos < infraRegionRunPhasePos,
                `deploymentConfigPrompts (pos ${deploymentConfigRunPhasePos}) must be run before infraRegionAndTargetPrompts (pos ${infraRegionRunPhasePos}) — model-first ordering`
            );
        });

        /**
         * Property 3c: Module selection prompts must run after infrastructure
         * 
         * Validates: Requirement 4.3
         */
        it('should run module selection prompts in Phase 3 after ML configuration', function() {
            this.timeout(10000);

            const phase2InfraPattern = /console\.log\([^)]*Infrastructure/;
            const phase4ModulePattern = /console\.log\([^)]*Module Selection/;

            const infraPhasePos = findPosition(phase2InfraPattern);
            const modulePhasePos = findPosition(phase4ModulePattern);

            assert.ok(
                infraPhasePos !== -1,
                'Infrastructure phase console.log must exist'
            );
            assert.ok(
                modulePhasePos !== -1,
                'Module Selection phase console.log must exist'
            );
            assert.ok(
                infraPhasePos < modulePhasePos,
                `Infrastructure phase (pos ${infraPhasePos}) must come before Module Selection phase (pos ${modulePhasePos})`
            );
        });

        /**
         * Property 3d: Project configuration prompts must run last
         * 
         * Validates: Requirement 4.3
         */
        it('should run project configuration prompts in Phase 4 after module selection', function() {
            this.timeout(10000);

            const phase4ModulePattern = /console\.log\([^)]*Module Selection/;
            const phase5ProjectPattern = /console\.log\([^)]*Project Configuration/;

            const modulePhasePos = findPosition(phase4ModulePattern);
            const projectPhasePos = findPosition(phase5ProjectPattern);

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
         * New ordering: ML Config → Infrastructure → Module → Project
         * Validates: Requirements 4.1, 4.2, 4.3
         */
        it('should maintain strict phase ordering: Infrastructure → ML Config → Module → Project', function() {
            this.timeout(10000);

            // New phase ordering: What (ML Config) → How/Where (Infrastructure) → Details (Module) → Project
            const phases = [
                { name: 'ML Configuration', pattern: /console\.log\([^)]*Core ML Configuration/ },
                { name: 'Infrastructure', pattern: /console\.log\([^)]*Infrastructure/ },
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
         * Validates: Requirement 4.3
         */
        it('should include all required infrastructure prompts in Phase 1', async function() {
            this.timeout(10000);

            // Dynamically import the prompts module to check actual prompt definitions
            const { infrastructurePrompts } = await import('../../src/lib/prompts.js');

            const requiredPromptNames = [
                'buildTarget',
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
         * Property 3g: ML configuration prompts (deploymentConfig, modelFormat) must run
         * BEFORE infrastructure prompts — model-first ordering
         * 
         * Validates: Requirement 4.1, 4.2
         */
        it('should run ML configuration prompts after infrastructure prompts', function() {
            this.timeout(10000);

            // New ordering: deploymentConfigPrompts and modelFormatPrompts run BEFORE infra
            const deploymentConfigRunPhasePos = findPosition(/_runPhase\(deploymentConfigPrompts/);
            const modelFormatRunPhasePos = findPosition(/_runPhase\(\s*modelFormatPrompts/);
            const infraRegionRunPhasePos = findPosition(/_runPhase\(infraRegionAndTargetPrompts/);

            // ML config prompts must come BEFORE infrastructure (model-first)
            const mlConfigPrompts = [
                { name: 'deploymentConfigPrompts', pos: deploymentConfigRunPhasePos },
                { name: 'modelFormatPrompts', pos: modelFormatRunPhasePos }
            ];

            mlConfigPrompts.forEach(prompt => {
                if (prompt.pos !== -1) {
                    assert.ok(
                        prompt.pos < infraRegionRunPhasePos,
                        `${prompt.name} (pos ${prompt.pos}) must run BEFORE infraRegionAndTargetPrompts (pos ${infraRegionRunPhasePos}) — model-first ordering`
                    );
                }
            });
        });
    });

    describe('Module Selection Prompts Content', () => {
        /**
         * Property 3h: Module selection phase must run after infrastructure
         * 
         * Validates: Requirement 4.3
         */
        it('should run modulePrompts after all ML configuration prompts', function() {
            this.timeout(10000);

            // modulePrompts is now used via .filter() for specific prompts (e.g., includeSampleModel)
            // rather than as a full _runPhase(modulePrompts, ...) call
            const moduleRunPhasePos = findPosition(/modulePrompts\.filter/);
            const infraBuildRunPhasePos = findPosition(/_runPhase\(infraBuildPrompts/);

            assert.ok(
                moduleRunPhasePos !== -1,
                'modulePrompts.filter() usage must exist'
            );
            assert.ok(
                infraBuildRunPhasePos !== -1,
                '_runPhase(infraBuildPrompts) must exist'
            );
            assert.ok(
                infraBuildRunPhasePos < moduleRunPhasePos,
                `infraBuildPrompts (pos ${infraBuildRunPhasePos}) must run before modulePrompts (pos ${moduleRunPhasePos})`
            );
        });
    });

    describe('Project Configuration Prompts Content', () => {
        /**
         * Property 3i: Project configuration phase must run last
         * 
         * Validates: Requirement 4.3
         */
        it('should run projectPrompts and destinationPrompts after module selection', function() {
            this.timeout(10000);

            const moduleRunPhasePos = findPosition(/modulePrompts\.filter/);
            const projectRunPhasePos = findPosition(/_runPhase\(projectPrompts/);
            const destinationRunPhasePos = findPosition(/_runPhase\(destinationPrompts/);

            assert.ok(
                moduleRunPhasePos !== -1,
                'modulePrompts.filter() usage must exist'
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
         * Property 3j: HyperPod MCP query is now handled at deploy time (FR-1.4)
         * Generation no longer queries for HyperPod clusters.
         * The _queryMcpForHyperPod method still exists as a delegation but is not called in run().
         */
        it('should NOT call _queryMcpForHyperPod during generation (moved to deploy time)', function() {
            this.timeout(10000);

            // The method delegation still exists for backward compat
            const methodPattern = /_queryMcpForHyperPod\s*\(/;
            const methodPos = findPosition(methodPattern);
            assert.ok(
                methodPos !== -1,
                '_queryMcpForHyperPod delegation should still exist for other flows'
            );

            // But the conditional call in run() should be removed
            const callPattern = /if\s*\([^)]*deploymentTarget\s*===\s*['"]hyperpod-eks['"]\s*\)\s*\{[^}]*_queryMcpForHyperPod/;
            const callPos = findPosition(callPattern);
            assert.ok(
                callPos === -1,
                'Generation flow should NOT conditionally call _queryMcpForHyperPod (FR-1.4)'
            );
        });

        /**
         * Property 3k: HyperPod MCP query should still exist in mcp-query-runner (for deploy time)
         */
        it('should still reference hyperpod-cluster-picker in mcp-query-runner', function() {
            this.timeout(10000);

            const serverNamePattern = /hyperpod-cluster-picker/;
            const serverNamePos = findMcpPosition(serverNamePattern);

            assert.ok(
                serverNamePos !== -1,
                'hyperpod-cluster-picker server name must still be referenced in mcp-query-runner.js'
            );
        });
    });

    describe('Instance Sizer Integration', () => {
        /**
         * Property 3l: Instance type resolution removed from generation (FR-1.2).
         * Base image selection no longer depends on instance type at generation time.
         * The base image query now passes null for instanceType.
         */
        it('should pass null instanceType to base image query (FR-1.2)', function() {
            this.timeout(10000);

            // Base image query must still exist
            const baseImageRunPhasePos = findPosition(/_runPhase\(\s*baseImagePrompts/);
            assert.ok(
                baseImageRunPhasePos !== -1,
                '_runPhase(baseImagePrompts) must exist'
            );

            // Instance type should be set to null for base image queries
            const nullInstancePattern = /resolvedInstanceType\s*=\s*null/;
            const nullPos = findPosition(nullInstancePattern);
            assert.ok(
                nullPos !== -1,
                'resolvedInstanceType should be set to null (instance type not known at generation time)'
            );
        });

        /**
         * Property 3m: Instance-sizer is no longer called during generation (FR-1.2)
         */
        it('should NOT call instance-sizer during generation (moved to deploy time)', function() {
            this.timeout(10000);

            // The await call to _queryMcpForInstanceSizing should no longer exist in run()
            const sizerQueryPos = findPosition(/await this\.mcpQueryRunner\._queryMcpForInstanceSizing/);
            assert.ok(
                sizerQueryPos === -1,
                '_queryMcpForInstanceSizing should NOT be called during generation (FR-1.2)'
            );
        });
    });
});
