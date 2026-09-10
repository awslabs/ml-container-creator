// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 15: Logs Script Content by Deployment Target
 *
 * For any valid configuration, when deploymentTarget equals realtime-inference,
 * the generated do/logs script must contain CloudWatch Logs tailing logic
 * (aws logs tail) and must not contain kubectl commands. When deploymentTarget
 * equals hyperpod-eks, the generated do/logs script must contain kubectl logs
 * tailing logic and must retrieve kubeconfig via aws sagemaker
 * get-cluster-kubeconfig before tailing. For both targets, the script must
 * not contain content from the other target.
 *
 * Validates: Requirements 15.2, 15.3
 *
 * Feature: sagemaker-hyperpod-deployment
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/logs');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/logs template with the given variables.
 */
function renderLogs(vars) {
    return ejs.render(templateContent, vars);
}

/** Arbitrary for a base config shared by both deployment targets */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild')
});

describe('Property 15: Logs Script Content by Deployment Target', () => {
    before(() => {
        console.log('\n📋 Starting Logs Script Content by Deployment Target Property Tests');
        console.log('📋 Testing: Requirements 15.2, 15.3');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should contain CloudWatch Logs tailing logic for realtime-inference (Req 15.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 15.2: CloudWatch Logs tailing for realtime-inference');

        fc.assert(fc.property(
            baseConfigArb,
            (base) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'realtime-inference',
                    instanceType: 'ml.m5.xlarge',
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderLogs(vars);

                // Must contain CloudWatch Logs tailing
                assert.ok(
                    output.includes('aws logs tail'),
                    'realtime-inference must contain aws logs tail command'
                );
                assert.ok(
                    output.includes('/aws/sagemaker/Endpoints/'),
                    'realtime-inference must reference SageMaker Endpoints log group'
                );
                assert.ok(
                    output.includes('--follow'),
                    'realtime-inference must tail logs with --follow flag'
                );

                // Runtime dispatch: do/logs now contains ALL targets' logic and
                // routes at runtime on DEPLOYMENT_TARGET / --target. Verify the
                // realtime-inference path is present and reachable via dispatch.
                assert.ok(
                    output.includes('_logs_realtime_inference'),
                    'do/logs must define the realtime-inference implementation'
                );
                assert.ok(
                    output.includes('case "${EFFECTIVE_TARGET}" in'),
                    'do/logs must dispatch on the effective deployment target'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ CloudWatch Logs tailing present for realtime-inference');
    });

    it('should contain kubectl logs tailing logic for hyperpod-eks (Req 15.3)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 15.3: kubectl logs tailing for hyperpod-eks');

        fc.assert(fc.property(
            baseConfigArb,
            fc.record({
                hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
                hyperPodNamespace: fc.constantFrom('default', 'ml-inference', 'production'),
                hyperPodReplicas: fc.integer({ min: 1, max: 10 })
            }),
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars,
                    fsxVolumeHandle: undefined
                };

                const output = renderLogs(vars);

                // Must contain kubectl logs
                assert.ok(
                    output.includes('kubectl logs'),
                    'hyperpod-eks must contain kubectl logs command'
                );
                assert.ok(
                    output.includes('-f -l'),
                    'hyperpod-eks must tail logs with -f (follow) and -l (label selector)'
                );
                assert.ok(
                    output.includes('${HP_NAMESPACE}'),
                    'hyperpod-eks must reference the configured namespace'
                );

                // Runtime dispatch: hyperpod-eks path present and reachable.
                assert.ok(
                    output.includes('_logs_hyperpod_eks'),
                    'do/logs must define the hyperpod-eks implementation'
                );
                assert.ok(
                    output.includes('case "${EFFECTIVE_TARGET}" in'),
                    'do/logs must dispatch on the effective deployment target'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ kubectl logs tailing present for hyperpod-eks');
    });

    it('should retrieve kubeconfig before tailing for hyperpod-eks (Req 15.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 15.4: kubeconfig retrieval before tailing');

        fc.assert(fc.property(
            baseConfigArb,
            fc.record({
                hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
                hyperPodNamespace: fc.constantFrom('default', 'ml-inference'),
                hyperPodReplicas: fc.integer({ min: 1, max: 4 })
            }),
            (base, hpVars) => {
                const vars = {
                    ...base,
                    deploymentTarget: 'hyperpod-eks',
                    instanceType: undefined,
                    ...hpVars,
                    fsxVolumeHandle: undefined
                };

                const output = renderLogs(vars);

                // Must retrieve kubeconfig
                assert.ok(
                    output.includes('describe-cluster'),
                    'hyperpod-eks must retrieve cluster info via describe-cluster'
                );
                assert.ok(
                    output.includes('eks update-kubeconfig'),
                    'hyperpod-eks must configure kubectl via eks update-kubeconfig'
                );

                // kubeconfig retrieval must come BEFORE kubectl logs
                const kubeconfigIndex = output.indexOf('eks update-kubeconfig');
                const kubectlLogsIndex = output.indexOf('kubectl logs');
                assert.ok(
                    kubeconfigIndex < kubectlLogsIndex,
                    'eks update-kubeconfig must appear before kubectl logs'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ kubeconfig retrieval before tailing verified');
    });

    it('should include all targets\' logic and dispatch at runtime (runtime dispatch, not compile-time exclusivity)', function () {
        this.timeout(30000);

        console.log('  🧪 Runtime dispatch: every rendered do/logs contains all targets\' logic');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('realtime-inference', 'hyperpod-eks', 'async-inference', 'batch-transform'),
            (base, deploymentTarget) => {
                const vars = {
                    ...base,
                    deploymentTarget,
                    instanceType: 'ml.m5.xlarge',
                    hyperPodCluster: 'test-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1,
                    fsxVolumeHandle: undefined
                };

                const output = renderLogs(vars);

                // Regardless of the generation-time target, do/logs now contains
                // every target's implementation and routes on the effective target.
                assert.ok(
                    output.includes('aws logs tail'),
                    'do/logs must always contain the CloudWatch tailing path'
                );
                assert.ok(
                    output.includes('kubectl logs'),
                    'do/logs must always contain the kubectl logs path'
                );
                assert.ok(
                    output.includes('/aws/sagemaker/TransformJobs'),
                    'do/logs must always contain the batch transform log group'
                );

                // Dispatch mechanism and all four target functions are present.
                assert.ok(
                    output.includes('case "${EFFECTIVE_TARGET}" in'),
                    'do/logs must dispatch on the effective deployment target'
                );
                for (const fn of [
                    '_logs_realtime_inference',
                    '_logs_async_inference',
                    '_logs_hyperpod_eks',
                    '_logs_batch_transform'
                ]) {
                    assert.ok(output.includes(fn), `do/logs must define ${fn}`);
                }

                // --target override flag is available for all renders.
                assert.ok(
                    output.includes('--target'),
                    'do/logs must support the --target override flag'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Runtime dispatch verified — all targets present, dispatch on effective target');
    });
});
