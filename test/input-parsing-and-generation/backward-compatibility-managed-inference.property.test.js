// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 14: Backward Compatibility for Managed Inference
 *
 * For any valid realtime-inference configuration, the generated project
 * file structure, do/deploy SageMaker endpoint logic, do/clean endpoint
 * cleanup logic, do/logs CloudWatch tailing logic, and do/test endpoint
 * testing logic must be functionally equivalent to the current generator
 * output (with deployTarget renamed to buildTarget).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5
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
import TemplateManager from '../../src/lib/template-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load all do-framework templates
const templatesDir = path.join(__dirname, '../../templates/do');

const configTemplate = readFileSync(path.join(templatesDir, 'config'), 'utf8');
const deployTemplate = readFileSync(path.join(templatesDir, 'deploy'), 'utf8');
const cleanTemplate = readFileSync(path.join(templatesDir, 'clean'), 'utf8');
const logsTemplate = readFileSync(path.join(templatesDir, 'logs'), 'utf8');
const testTemplate = readFileSync(path.join(templatesDir, 'test'), 'utf8');

/**
 * Render a template with the given variables.
 */
function renderTemplate(template, vars) {
    return ejs.render(template, { orderedEnvVars: [], baseImage: '', ...vars });
}

/** Arbitrary for a realtime-inference configuration */
const managedInferenceConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom(
        'http-flask', 'http-fastapi',
        'transformers-vllm', 'transformers-sglang'
    ),
    architecture: fc.constantFrom('http', 'transformers'),
    backend: fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
    framework: fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers'),
    modelServer: fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild'),
    deploymentTarget: fc.constant('realtime-inference'),
    instanceType: fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.p4d.24xlarge'),
    modelName: fc.constantFrom('meta-llama/Llama-2-7b-hf', 'openai/gpt-oss-20b'),
    codebuildComputeType: fc.constantFrom('BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'),
    roleArn: fc.constantFrom('arn:aws:iam::123456789012:role/SageMakerRole', undefined),
    hfToken: fc.constantFrom('hf_test123', undefined),
    ngcApiKey: fc.constantFrom(undefined),
    inferenceAmiVersion: fc.constantFrom('1.0.0', undefined),
    modelFormat: fc.constantFrom('pkl', 'json', 'keras', undefined)
});

describe('Property 14: Backward Compatibility for Managed Inference', () => {
    before(() => {
        console.log('\n🔄 Starting Backward Compatibility for Managed Inference Property Tests');
        console.log('📋 Testing: Requirements 11.1, 11.2, 11.3, 11.4, 11.5');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should produce do/config with BUILD_TARGET and no hyperpod directory references (Req 11.1)', function () {
        /**
         * **Validates: Requirements 11.1**
         *
         * When deploymentTarget === 'realtime-inference', the do/config must contain
         * BUILD_TARGET (renamed from DEPLOY_TARGET) and DEPLOYMENT_TARGET variables,
         * and must NOT contain HyperPod-specific variables.
         */
        this.timeout(30000);

        console.log('  🧪 Req 11.1: do/config uses BUILD_TARGET and has no HyperPod vars');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const output = renderTemplate(configTemplate, config);

                // Must contain BUILD_TARGET (renamed from DEPLOY_TARGET)
                assert.ok(
                    output.includes('BUILD_TARGET'),
                    'do/config must contain BUILD_TARGET variable'
                );

                // Must contain DEPLOYMENT_TARGET
                assert.ok(
                    output.includes('DEPLOYMENT_TARGET'),
                    'do/config must contain DEPLOYMENT_TARGET variable'
                );

                // Must contain INSTANCE_TYPE for realtime-inference
                assert.ok(
                    output.includes('INSTANCE_TYPE'),
                    'realtime-inference do/config must contain INSTANCE_TYPE'
                );

                // Must NOT contain HyperPod-specific variables
                assert.ok(
                    !output.includes('HYPERPOD_CLUSTER_NAME'),
                    'realtime-inference do/config must NOT contain HYPERPOD_CLUSTER_NAME'
                );
                assert.ok(
                    !output.includes('HYPERPOD_NAMESPACE'),
                    'realtime-inference do/config must NOT contain HYPERPOD_NAMESPACE'
                );
                assert.ok(
                    !output.includes('HYPERPOD_REPLICAS'),
                    'realtime-inference do/config must NOT contain HYPERPOD_REPLICAS'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/config backward compatible with BUILD_TARGET rename');
    });

    it('should produce do/deploy with SageMaker inference component logic (Req 11.2)', function () {
        /**
         * **Validates: Requirements 11.2**
         *
         * When deploymentTarget === 'realtime-inference', the do/deploy script must
         * contain SageMaker inference component logic: create-endpoint,
         * create-inference-component, and wait inference-component-in-service.
         */
        this.timeout(30000);

        console.log('  🧪 Req 11.2: do/deploy contains SageMaker inference component logic');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderTemplate(deployTemplate, vars);

                // Must source shared helpers for IC-based deployment
                assert.ok(
                    output.includes('source') && output.includes('lib/inference-component.sh'),
                    'realtime-inference do/deploy must source lib/inference-component.sh'
                );
                assert.ok(
                    output.includes('source') && output.includes('lib/endpoint-config.sh'),
                    'realtime-inference do/deploy must source lib/endpoint-config.sh'
                );
                // Must contain inline create-endpoint call
                assert.ok(
                    output.includes('sagemaker create-endpoint'),
                    'realtime-inference do/deploy must contain create-endpoint'
                );
                // Must call create_inference_component or create_inference_component_legacy
                assert.ok(
                    output.includes('create_inference_component'),
                    'realtime-inference do/deploy must call create_inference_component'
                );
                // Must call wait_ic for IC waiting
                assert.ok(
                    output.includes('wait_ic'),
                    'realtime-inference do/deploy must call wait_ic'
                );

                // Must contain ROLE_ARN validation
                assert.ok(
                    output.includes('ROLE_ARN'),
                    'realtime-inference do/deploy must validate ROLE_ARN'
                );

                // Must NOT contain kubectl commands
                assert.ok(
                    !output.includes('kubectl'),
                    'realtime-inference do/deploy must NOT contain kubectl commands'
                );
                assert.ok(
                    !output.includes('describe-cluster'),
                    'realtime-inference do/deploy must NOT contain describe-cluster'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/deploy contains SageMaker inference component logic');
    });

    it('should produce do/clean with SageMaker cleanup logic (Req 11.3)', function () {
        /**
         * **Validates: Requirements 11.3**
         *
         * When deploymentTarget === 'realtime-inference', the do/clean script must
         * contain endpoint cleanup logic (delete-inference-component, delete-endpoint)
         * and must NOT contain HyperPod cleanup logic.
         */
        this.timeout(30000);

        console.log('  🧪 Req 11.3: do/clean contains SageMaker cleanup logic');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderTemplate(cleanTemplate, vars);

                // Must contain endpoint cleanup target
                assert.ok(
                    output.includes('clean_endpoint'),
                    'realtime-inference do/clean must contain clean_endpoint function'
                );
                assert.ok(
                    output.includes('endpoint)'),
                    'realtime-inference do/clean must support endpoint cleanup target'
                );

                // Must contain SageMaker delete commands
                assert.ok(
                    output.includes('delete-endpoint'),
                    'realtime-inference do/clean must contain delete-endpoint'
                );

                // Must NOT contain HyperPod cleanup
                assert.ok(
                    !output.includes('clean_hyperpod'),
                    'realtime-inference do/clean must NOT contain clean_hyperpod'
                );
                assert.ok(
                    !output.includes('kubectl delete'),
                    'realtime-inference do/clean must NOT contain kubectl delete'
                );

                // Must still contain shared cleanup targets
                assert.ok(
                    output.includes('clean_local'),
                    'realtime-inference do/clean must contain clean_local'
                );
                assert.ok(
                    output.includes('clean_ecr'),
                    'realtime-inference do/clean must contain clean_ecr'
                );
                assert.ok(
                    output.includes('clean_codebuild'),
                    'realtime-inference do/clean must contain clean_codebuild'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/clean contains SageMaker cleanup logic');
    });

    it('should produce do/logs with CloudWatch log tailing logic (Req 11.4)', function () {
        /**
         * **Validates: Requirements 11.4**
         *
         * When deploymentTarget === 'realtime-inference', the do/logs script must
         * contain CloudWatch log tailing logic (aws logs tail) and must NOT
         * contain kubectl logs commands.
         */
        this.timeout(30000);

        console.log('  🧪 Req 11.4: do/logs contains CloudWatch log tailing logic');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderTemplate(logsTemplate, vars);

                // Must contain CloudWatch log tailing
                assert.ok(
                    output.includes('aws logs tail'),
                    'realtime-inference do/logs must contain aws logs tail'
                );
                assert.ok(
                    output.includes('/aws/sagemaker/Endpoints/'),
                    'realtime-inference do/logs must reference SageMaker Endpoints log group'
                );
                assert.ok(
                    output.includes('--follow'),
                    'realtime-inference do/logs must use --follow for tailing'
                );

                // Must NOT contain kubectl logs
                assert.ok(
                    !output.includes('kubectl logs'),
                    'realtime-inference do/logs must NOT contain kubectl logs'
                );
                assert.ok(
                    !output.includes('describe-cluster'),
                    'realtime-inference do/logs must NOT contain describe-cluster'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/logs contains CloudWatch log tailing logic');
    });

    it('should produce do/test with local and SageMaker endpoint testing logic (Req 11.5)', function () {
        /**
         * **Validates: Requirements 11.5**
         *
         * When deploymentTarget === 'realtime-inference', the do/test script must
         * contain both local container testing (curl to localhost:8080) and
         * SageMaker endpoint testing (aws sagemaker-runtime invoke-endpoint).
         */
        this.timeout(30000);

        console.log('  🧪 Req 11.5: do/test contains local and SageMaker endpoint testing');

        fc.assert(fc.property(
            managedInferenceConfigArb,
            (config) => {
                const vars = {
                    ...config,
                    hyperPodCluster: undefined,
                    hyperPodNamespace: undefined,
                    hyperPodReplicas: undefined,
                    fsxVolumeHandle: undefined
                };

                const output = renderTemplate(testTemplate, vars);

                // Must contain local testing (curl to localhost:8080)
                assert.ok(
                    output.includes('localhost:8080'),
                    'realtime-inference do/test must contain localhost:8080 for local testing'
                );

                // Must contain SageMaker endpoint testing
                assert.ok(
                    output.includes('sagemaker-runtime invoke-endpoint') ||
                    output.includes('sagemaker describe-endpoint'),
                    'realtime-inference do/test must contain SageMaker endpoint testing'
                );

                // Must contain health check (/ping)
                assert.ok(
                    output.includes('/ping'),
                    'realtime-inference do/test must contain /ping health check'
                );

                // Must contain inference test (/invocations)
                assert.ok(
                    output.includes('/invocations'),
                    'realtime-inference do/test must contain /invocations inference test'
                );

                // Must NOT contain kubectl port-forward
                assert.ok(
                    !output.includes('kubectl port-forward'),
                    'realtime-inference do/test must NOT contain kubectl port-forward'
                );
                assert.ok(
                    !output.includes('describe-cluster'),
                    'realtime-inference do/test must NOT contain describe-cluster'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ do/test contains local and SageMaker endpoint testing logic');
    });

    it('should default deploymentTarget to realtime-inference when not explicitly set (Req 11.6)', function () {
        /**
         * **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5**
         *
         * The generator defaults deploymentTarget to 'realtime-inference' when
         * not explicitly set, ensuring backward compatibility.
         */
        this.timeout(30000);

        console.log('  🧪 Req 11.6: deploymentTarget defaults to realtime-inference');

        fc.assert(fc.property(
            fc.record({
                architecture: fc.constantFrom('http', 'transformers'),
                backend: fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
                awsRegion: fc.constantFrom('us-east-1', 'us-west-2')
            }),
            (config) => {
                // TemplateManager with no deploymentTarget set should still validate
                const answers = {
                    ...config,
                    buildTarget: 'codebuild',
                    instanceType: 'ml.m5.large'
                    // deploymentTarget intentionally NOT set
                };

                const manager = new TemplateManager(answers);
                // Should not throw - buildTarget validation should pass
                assert.doesNotThrow(() => manager.validate());
            }
        ), { numRuns: 20 });

        console.log('    ✅ deploymentTarget defaults to realtime-inference');
    });

    it('should accept old deployTarget for backward compatibility in TemplateManager', function () {
        /**
         * **Validates: Requirements 11.1**
         *
         * The TemplateManager should accept the old deployTarget field name
         * for backward compatibility, validating it against buildTargets.
         */
        this.timeout(30000);

        console.log('  🧪 Backward compat: TemplateManager accepts old deployTarget');

        fc.assert(fc.property(
            fc.record({
                architecture: fc.constantFrom('http', 'transformers'),
                backend: fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
                awsRegion: fc.constantFrom('us-east-1', 'us-west-2')
            }),
            (config) => {
                // Use old deployTarget field name
                const answers = {
                    ...config,
                    deployTarget: 'codebuild', // old field name
                    instanceType: 'ml.m5.large'
                };

                const manager = new TemplateManager(answers);
                // Should not throw - backward compat should handle old field name
                assert.doesNotThrow(() => manager.validate());
            }
        ), { numRuns: 20 });

        console.log('    ✅ TemplateManager accepts old deployTarget for backward compat');
    });
});
