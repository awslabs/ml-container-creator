// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BL063 — HyperPod ops surface guards.
 *
 * Tests cover:
 * - do/add-ic: hard exit guard when DEPLOYMENT_TARGET=hyperpod-eks
 * - do/ci: hard exit guard when DEPLOYMENT_TARGET=hyperpod-eks
 * - Guards do NOT fire on managed-inference or unset DEPLOYMENT_TARGET
 * - Guard messages include actionable alternatives
 * - deployment-state.sh shared library structure
 *
 * Feature: BL063 — HyperPod Ops Surface Design
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADD_IC_PATH = resolve(__dirname, '../../templates/do/add-ic');
const CI_PATH = resolve(__dirname, '../../templates/do/ci');
const DEPLOYMENT_STATE_PATH = resolve(__dirname, '../../templates/do/lib/deployment-state.sh');

const ADD_IC_SCRIPT = readFileSync(ADD_IC_PATH, 'utf-8');
const CI_SCRIPT = readFileSync(CI_PATH, 'utf-8');
const DEPLOYMENT_STATE_SCRIPT = readFileSync(DEPLOYMENT_STATE_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function scriptContains(script, pattern) {
    return script.includes(pattern);
}

function scriptMatches(script, regex) {
    return regex.test(script);
}

/**
 * Extract the guard block from a script.
 * Returns text from "HyperPod guard" comment to "exit 1" + "fi".
 */
function extractGuardBlock(script) {
    const guardStart = script.indexOf('HyperPod guard');
    if (guardStart === -1) return '';
    const guardEnd = script.indexOf('fi', guardStart + script.substring(guardStart).indexOf('exit 1'));
    return script.substring(guardStart, guardEnd + 2);
}

// ── do/add-ic guard tests ────────────────────────────────────────────────────

describe('do/add-ic HyperPod guard (BL063)', () => {
    const guard = extractGuardBlock(ADD_IC_SCRIPT);

    describe('guard presence and structure', () => {
        it('contains a HyperPod guard block', () => {
            assert.ok(
                scriptContains(ADD_IC_SCRIPT, 'HyperPod guard'),
                'should have a HyperPod guard comment'
            );
        });

        it('checks DEPLOYMENT_TARGET for hyperpod-eks', () => {
            assert.ok(
                scriptContains(guard, 'DEPLOYMENT_TARGET:-'),
                'should use ${DEPLOYMENT_TARGET:-} pattern for safe unset handling'
            );
            assert.ok(
                scriptContains(guard, 'hyperpod-eks'),
                'should check for hyperpod-eks value'
            );
        });

        it('exits with code 1 (hard failure)', () => {
            assert.ok(
                scriptContains(guard, 'exit 1'),
                'should hard-exit with code 1'
            );
        });

        it('guard appears BEFORE the _usage function', () => {
            const guardPos = ADD_IC_SCRIPT.indexOf('HyperPod guard');
            const usagePos = ADD_IC_SCRIPT.indexOf('_usage()');
            assert.ok(
                guardPos < usagePos,
                'guard must appear before _usage() to prevent any execution on HyperPod'
            );
        });

        it('guard appears AFTER source config', () => {
            const sourcePos = ADD_IC_SCRIPT.indexOf('source "${SCRIPT_DIR}/config"');
            const guardPos = ADD_IC_SCRIPT.indexOf('HyperPod guard');
            assert.ok(
                sourcePos < guardPos,
                'guard must appear after sourcing config (which sets DEPLOYMENT_TARGET)'
            );
        });
    });

    describe('error message content', () => {
        it('includes the ❌ prefix', () => {
            assert.ok(
                scriptContains(guard, '❌'),
                'should use ❌ emoji prefix for error messages'
            );
        });

        it('mentions Inference Components are a SageMaker concept', () => {
            assert.ok(
                scriptContains(guard, 'Inference Components are a SageMaker managed inference concept'),
                'should explain WHY the script is unsupported'
            );
        });

        it('suggests do/adapter --load-lora as alternative', () => {
            assert.ok(
                scriptContains(guard, 'do/adapter --load-lora'),
                'should provide actionable alternative for HyperPod users'
            );
        });
    });

    describe('guard does NOT fire on other targets', () => {
        it('only checks for hyperpod-eks (not managed-inference)', () => {
            // The guard should ONLY fire on hyperpod-eks, not on other targets
            assert.ok(
                scriptMatches(ADD_IC_SCRIPT, /if \[ "\$\{DEPLOYMENT_TARGET:-\}" = "hyperpod-eks" \]/),
                'should use exact equality check for hyperpod-eks only'
            );
        });

        it('does not contain a blanket non-smai guard', () => {
            // Ensure we don't accidentally guard against async-inference or batch-transform
            assert.ok(
                !scriptContains(guard, 'managed-inference'),
                'guard should not reference managed-inference (it should only block hyperpod-eks)'
            );
        });
    });
});

// ── do/ci guard tests ────────────────────────────────────────────────────────

describe('do/ci HyperPod guard (BL063)', () => {
    const guard = extractGuardBlock(CI_SCRIPT);

    describe('guard presence and structure', () => {
        it('contains a HyperPod guard block', () => {
            assert.ok(
                scriptContains(CI_SCRIPT, 'HyperPod guard'),
                'should have a HyperPod guard comment'
            );
        });

        it('checks DEPLOYMENT_TARGET for hyperpod-eks', () => {
            assert.ok(
                scriptContains(guard, 'DEPLOYMENT_TARGET:-'),
                'should use ${DEPLOYMENT_TARGET:-} pattern for safe unset handling'
            );
            assert.ok(
                scriptContains(guard, 'hyperpod-eks'),
                'should check for hyperpod-eks value'
            );
        });

        it('exits with code 1 (hard failure)', () => {
            assert.ok(
                scriptContains(guard, 'exit 1'),
                'should hard-exit with code 1'
            );
        });

        it('guard appears BEFORE the CI_TABLE_NAME assignment', () => {
            const guardPos = CI_SCRIPT.indexOf('HyperPod guard');
            const tablePos = CI_SCRIPT.indexOf('CI_TABLE_NAME=');
            assert.ok(
                guardPos < tablePos,
                'guard must appear before CI infrastructure references'
            );
        });

        it('guard appears AFTER source config', () => {
            const sourcePos = CI_SCRIPT.indexOf('source "${SCRIPT_DIR}/config"');
            const guardPos = CI_SCRIPT.indexOf('HyperPod guard');
            assert.ok(
                sourcePos < guardPos,
                'guard must appear after sourcing config (which sets DEPLOYMENT_TARGET)'
            );
        });
    });

    describe('error message content', () => {
        it('includes the ❌ prefix', () => {
            assert.ok(
                scriptContains(guard, '❌'),
                'should use ❌ emoji prefix for error messages'
            );
        });

        it('mentions Lambda, Step Functions, and CodeBuild', () => {
            assert.ok(
                scriptContains(guard, 'Lambda'),
                'should mention Lambda as part of the CI harness'
            );
            assert.ok(
                scriptContains(guard, 'Step Functions'),
                'should mention Step Functions as part of the CI harness'
            );
            assert.ok(
                scriptContains(guard, 'CodeBuild'),
                'should mention CodeBuild as part of the CI harness'
            );
        });

        it('suggests ArgoCD/Flux as HyperPod CI alternative', () => {
            assert.ok(
                scriptContains(guard, 'ArgoCD') || scriptContains(guard, 'Flux'),
                'should suggest Kubernetes-native CI/CD alternatives'
            );
        });
    });

    describe('guard does NOT fire on other targets', () => {
        it('only checks for hyperpod-eks (not managed-inference)', () => {
            assert.ok(
                scriptMatches(CI_SCRIPT, /if \[ "\$\{DEPLOYMENT_TARGET:-\}" = "hyperpod-eks" \]/),
                'should use exact equality check for hyperpod-eks only'
            );
        });
    });
});

// ── deployment-state.sh shared library tests ─────────────────────────────────

describe('deployment-state.sh shared library (BL063)', () => {
    describe('file existence and structure', () => {
        it('exists at templates/do/lib/deployment-state.sh', () => {
            assert.ok(
                existsSync(DEPLOYMENT_STATE_PATH),
                'deployment-state.sh should exist in templates/do/lib/'
            );
        });

        it('has a shebang line', () => {
            assert.ok(
                DEPLOYMENT_STATE_SCRIPT.startsWith('#!/usr/bin/env bash'),
                'should have #!/usr/bin/env bash shebang'
            );
        });

        it('defines _check_active_deployment function', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, '_check_active_deployment()'),
                'should define _check_active_deployment function'
            );
        });
    });

    describe('HyperPod EKS path', () => {
        it('handles hyperpod-eks target', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'hyperpod-eks)'),
                'should have a case branch for hyperpod-eks'
            );
        });

        it('uses kubectl rollout status for deployment check', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'kubectl rollout status'),
                'should use kubectl rollout status to check deployment existence'
            );
        });

        it('uses 5s timeout for kubectl check', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, '--timeout=5s'),
                'should use a 5-second timeout to avoid hanging'
            );
        });

        it('suggests do/deploy --target hyperpod-eks when no deployment found', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'do/deploy --target hyperpod-eks'),
                'should suggest the correct deploy command for HyperPod'
            );
        });

        it('exits 0 (graceful) when no deployment found', () => {
            // Extract the hyperpod-eks case block
            const hpStart = DEPLOYMENT_STATE_SCRIPT.indexOf('hyperpod-eks)');
            const hpEnd = DEPLOYMENT_STATE_SCRIPT.indexOf(';;', hpStart);
            const hpBlock = DEPLOYMENT_STATE_SCRIPT.substring(hpStart, hpEnd);
            assert.ok(
                hpBlock.includes('exit 0'),
                'should exit 0 (graceful, not error) when no deployment exists'
            );
        });

        it('checks for kubectl availability before running commands', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'command -v kubectl'),
                'should check kubectl is installed before using it'
            );
        });
    });

    describe('managed-inference path', () => {
        it('handles managed-inference target', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'managed-inference'),
                'should have a case branch for managed-inference'
            );
        });

        it('uses aws sagemaker describe-endpoint', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'aws sagemaker describe-endpoint'),
                'should call describe-endpoint for SMAI targets'
            );
        });

        it('checks for InService status', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'InService'),
                'should verify endpoint is InService'
            );
        });

        it('suggests do/deploy --target realtime-inference when not InService', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'do/deploy --target realtime-inference'),
                'should suggest the correct deploy command for SMAI'
            );
        });
    });

    describe('graceful behavior', () => {
        it('uses exit 0 not exit 1 for missing deployments', () => {
            // Count exit codes — all should be exit 0 (graceful)
            const matches = DEPLOYMENT_STATE_SCRIPT.match(/exit [0-9]/g) || [];
            const nonZeroExits = matches.filter(m => m !== 'exit 0');
            assert.strictEqual(
                nonZeroExits.length,
                0,
                `all exits should be exit 0 (graceful, not error) — found: ${  nonZeroExits.join(', ')}`
            );
        });

        it('returns 0 for unknown targets (does not block)', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'return 0'),
                'should return 0 for unknown targets to allow script to proceed'
            );
        });

        it('handles missing aws CLI gracefully', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'command -v aws'),
                'should check if aws CLI exists before using it'
            );
        });
    });

    describe('variable usage', () => {
        it('uses HP_NAMESPACE with fallback to PROJECT_NAME', () => {
            assert.ok(
                scriptMatches(DEPLOYMENT_STATE_SCRIPT, /HP_NAMESPACE:-\$\{PROJECT_NAME/),
                'should fall back HP_NAMESPACE to PROJECT_NAME'
            );
        });

        it('uses ENDPOINT_NAME with fallback to PROJECT_NAME', () => {
            assert.ok(
                scriptMatches(DEPLOYMENT_STATE_SCRIPT, /ENDPOINT_NAME:-\$\{PROJECT_NAME/),
                'should fall back ENDPOINT_NAME to PROJECT_NAME'
            );
        });

        it('uses AWS_REGION with us-east-1 default', () => {
            assert.ok(
                scriptContains(DEPLOYMENT_STATE_SCRIPT, 'AWS_REGION:-us-east-1'),
                'should default AWS_REGION to us-east-1'
            );
        });
    });
});

// ── Design doc existence test ────────────────────────────────────────────────

describe('BL063 design document', () => {
    const DOC_PATH = resolve(__dirname, '../../.kiro/hyperpod-ops-surface.md');

    it('exists at .kiro/hyperpod-ops-surface.md', () => {
        assert.ok(
            existsSync(DOC_PATH),
            'design document should exist'
        );
    });

    it('contains all 24 scripts in the summary table', () => {
        const doc = readFileSync(DOC_PATH, 'utf-8');
        const expectedScripts = [
            'do/adapter', 'do/add-ic', 'do/benchmark', 'do/build',
            'do/ci', 'do/clean', 'do/config', 'do/deploy',
            'do/evaluate', 'do/export', 'do/logs', 'do/manifest',
            'do/optimize', 'do/push', 'do/register', 'do/run',
            'do/stage', 'do/status', 'do/submit', 'do/test',
            'do/train', 'do/tune', 'do/validate'
        ];
        for (const script of expectedScripts) {
            assert.ok(
                doc.includes(script),
                `design doc should reference ${script}`
            );
        }
    });

    it('contains implementation roadmap section', () => {
        const doc = readFileSync(DOC_PATH, 'utf-8');
        assert.ok(
            doc.includes('## Implementation Roadmap'),
            'should have an implementation roadmap section'
        );
    });

    it('classifies scripts with valid statuses', () => {
        const doc = readFileSync(DOC_PATH, 'utf-8');
        const validStatuses = ['works', 'needs-hp-path', 'smai-only', 'future-scope', 'partial'];
        // Check that at least 3 different statuses appear
        const foundStatuses = validStatuses.filter(s => doc.includes(`**${s}**`));
        assert.ok(
            foundStatuses.length >= 3,
            `should use multiple status types, found: ${foundStatuses.join(', ')}`
        );
    });

    it('documents cross-target patterns', () => {
        const doc = readFileSync(DOC_PATH, 'utf-8');
        assert.ok(
            doc.includes('Cross-Target Patterns'),
            'should document cross-target interaction patterns'
        );
    });
});
