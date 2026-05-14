// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for lifecycle scripts with multi-IC support.
 *
 * Validates: Requirement 7.3
 * - do/test rendered template contains IC name lookup from do/ic/*.conf
 * - do/clean rendered template iterates do/ic/*.conf for endpoint cleanup
 * - do/clean respects ENDPOINT_EXTERNAL flag (no endpoint deletion)
 * - do/status rendered template contains DescribeEndpoint and DescribeInferenceComponent calls
 * - do/status excluded from async/batch/hyperpod output
 * - do/status included in real-time output
 * - do/benchmark --ic <name> uses correct IC in benchmark target JSON
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load templates
const testTemplatePath = path.join(__dirname, '../../templates/do/test');
const cleanTemplatePath = path.join(__dirname, '../../templates/do/clean');
const statusTemplatePath = path.join(__dirname, '../../templates/do/status');
const benchmarkTemplatePath = path.join(__dirname, '../../templates/do/benchmark');
const appJsPath = path.join(__dirname, '../../src/app.js');

const testTemplateContent = readFileSync(testTemplatePath, 'utf8');
const cleanTemplateContent = readFileSync(cleanTemplatePath, 'utf8');
const benchmarkTemplateContent = readFileSync(benchmarkTemplatePath, 'utf8');
const appJsContent = readFileSync(appJsPath, 'utf8');

// do/status is a plain bash script (no EJS conditionals), read it directly
const statusTemplateContent = existsSync(statusTemplatePath)
    ? readFileSync(statusTemplatePath, 'utf8')
    : null;

/** Render do/test template */
function renderTest(vars) {
    return ejs.render(testTemplateContent, vars);
}

/** Render do/clean template */
function renderClean(vars) {
    return ejs.render(cleanTemplateContent, vars);
}

/** Base template variables for realtime-inference */
const realtimeVars = {
    projectName: 'test-project',
    deploymentTarget: 'realtime-inference',
    instanceType: 'ml.g6e.48xlarge',
    awsRegion: 'us-east-1',
    framework: 'transformers',
    modelServer: 'vllm',
    modelName: 'meta-llama/Llama-2-7b-hf',
    buildTarget: 'codebuild'
};

describe('Lifecycle Scripts Multi-IC (Requirement 7.3)', () => {

    // ================================================================
    // do/test — IC name lookup from do/ic/*.conf
    // ================================================================
    describe('do/test: IC name lookup from do/ic/*.conf', () => {

        it('should parse IC_ARG from first positional argument', () => {
            const output = renderTest(realtimeVars);
            assert.ok(
                output.includes('IC_ARG="${1:-}"'),
                'do/test must parse IC_ARG from first positional argument'
            );
        });

        it('should look up IC config file from do/ic/<name>.conf when IC_ARG is provided', () => {
            const output = renderTest(realtimeVars);
            assert.ok(
                output.includes('ic/${IC_ARG}.conf'),
                'do/test must reference do/ic/<IC_ARG>.conf for explicit IC argument'
            );
        });

        it('should source IC config to get IC_DEPLOYED_NAME', () => {
            const output = renderTest(realtimeVars);
            assert.ok(
                output.includes('IC_DEPLOYED_NAME'),
                'do/test must reference IC_DEPLOYED_NAME from IC config'
            );
        });

        it('should error when IC has not been deployed yet', () => {
            const output = renderTest(realtimeVars);
            assert.ok(
                output.includes('has not been deployed yet'),
                'do/test must show error when IC_DEPLOYED_NAME is empty'
            );
        });

        it('should iterate do/ic/*.conf when no IC argument and do/ic/ exists', () => {
            const output = renderTest(realtimeVars);
            assert.ok(
                output.includes('/ic/*.conf'),
                'do/test must iterate do/ic/*.conf when no IC argument provided'
            );
        });

        it('should use first IC alphabetically when no argument provided', () => {
            const output = renderTest(realtimeVars);
            // The template iterates and breaks after finding the first deployed IC
            assert.ok(
                output.includes('break'),
                'do/test must break after finding first deployed IC (alphabetical order)'
            );
        });

        it('should fall back to INFERENCE_COMPONENT_NAME for legacy (no do/ic/) path', () => {
            const output = renderTest(realtimeVars);
            assert.ok(
                output.includes('INFERENCE_COMPONENT_NAME'),
                'do/test must fall back to INFERENCE_COMPONENT_NAME for legacy path'
            );
        });

        it('should pass --inference-component-name to invoke-endpoint', () => {
            const output = renderTest(realtimeVars);
            assert.ok(
                output.includes('--inference-component-name'),
                'do/test must pass --inference-component-name to invoke-endpoint'
            );
        });
    });

    // ================================================================
    // do/clean — multi-IC iteration for endpoint cleanup
    // ================================================================
    describe('do/clean: iterates do/ic/*.conf for endpoint cleanup', () => {

        it('should iterate do/ic/*.conf in clean_endpoint function', () => {
            const output = renderClean(realtimeVars);
            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            assert.ok(
                cleanEndpointBlock.includes('ic/*.conf'),
                'clean_endpoint must iterate do/ic/*.conf files'
            );
        });

        it('should look up IC_DEPLOYED_NAME from each conf file', () => {
            const output = renderClean(realtimeVars);
            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            assert.ok(
                cleanEndpointBlock.includes('IC_DEPLOYED_NAME'),
                'clean_endpoint must look up IC_DEPLOYED_NAME from conf files'
            );
        });

        it('should call delete-inference-component for each IC', () => {
            const output = renderClean(realtimeVars);
            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            assert.ok(
                cleanEndpointBlock.includes('delete-inference-component'),
                'clean_endpoint must call delete-inference-component'
            );
        });

        it('should delete ICs before deleting the endpoint', () => {
            const output = renderClean(realtimeVars);
            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            const icDeletionPos = cleanEndpointBlock.indexOf('delete-inference-component');
            const endpointDeletionPos = cleanEndpointBlock.lastIndexOf('delete-endpoint');

            assert.ok(icDeletionPos > 0, 'Must have IC deletion logic');
            assert.ok(endpointDeletionPos > 0, 'Must have endpoint deletion logic');
            assert.ok(
                icDeletionPos < endpointDeletionPos,
                'IC deletion must come before endpoint deletion'
            );
        });

        it('should wait for IC deletion to complete', () => {
            const output = renderClean(realtimeVars);
            const cleanEndpointStart = output.indexOf('clean_endpoint()');
            const cleanEndpointEnd = output.indexOf('SageMaker resources cleaned');
            const cleanEndpointBlock = output.substring(cleanEndpointStart, cleanEndpointEnd);

            assert.ok(
                cleanEndpointBlock.includes('wait inference-component-deleted'),
                'clean_endpoint must wait for IC deletion'
            );
        });
    });

    // ================================================================
    // do/clean — ENDPOINT_EXTERNAL flag
    // ================================================================
    describe('do/clean: respects ENDPOINT_EXTERNAL flag (no endpoint deletion)', () => {

        it('should check ENDPOINT_EXTERNAL variable', () => {
            const output = renderClean(realtimeVars);
            assert.ok(
                output.includes('ENDPOINT_EXTERNAL'),
                'do/clean must check ENDPOINT_EXTERNAL variable'
            );
        });

        it('should print warning about external endpoint', () => {
            const output = renderClean(realtimeVars);
            assert.ok(
                output.includes('Endpoint is external — only removing inference components'),
                'do/clean must print external endpoint warning'
            );
        });

        it('should NOT delete endpoint when ENDPOINT_EXTERNAL=true', () => {
            const output = renderClean(realtimeVars);
            const externalStart = output.indexOf('Endpoint is external');
            const externalEnd = output.indexOf('External endpoint cleanup complete');
            const externalBlock = output.substring(externalStart, externalEnd);

            // Should not contain delete-endpoint (without -component suffix)
            const deleteEndpointCalls = externalBlock.match(/sagemaker delete-endpoint[^-]/g);
            assert.ok(
                !deleteEndpointCalls,
                'External endpoint path must NOT call delete-endpoint'
            );
        });

        it('should NOT delete endpoint config when ENDPOINT_EXTERNAL=true', () => {
            const output = renderClean(realtimeVars);
            const externalStart = output.indexOf('Endpoint is external');
            const externalEnd = output.indexOf('External endpoint cleanup complete');
            const externalBlock = output.substring(externalStart, externalEnd);

            assert.ok(
                !externalBlock.includes('delete-endpoint-config'),
                'External endpoint path must NOT call delete-endpoint-config'
            );
        });

        it('should still delete inference components when ENDPOINT_EXTERNAL=true', () => {
            const output = renderClean(realtimeVars);
            const externalStart = output.indexOf('Endpoint is external');
            const externalEnd = output.indexOf('External endpoint cleanup complete');
            const externalBlock = output.substring(externalStart, externalEnd);

            assert.ok(
                externalBlock.includes('delete-inference-component'),
                'External endpoint path must still delete inference components'
            );
        });

        it('should iterate do/ic/*.conf in external endpoint path', () => {
            const output = renderClean(realtimeVars);
            const externalStart = output.indexOf('Endpoint is external');
            const externalEnd = output.indexOf('External endpoint cleanup complete');
            const externalBlock = output.substring(externalStart, externalEnd);

            assert.ok(
                externalBlock.includes('ic/*.conf'),
                'External endpoint path must iterate do/ic/*.conf'
            );
        });
    });

    // ================================================================
    // do/status — DescribeEndpoint and DescribeInferenceComponent
    // ================================================================
    describe('do/status: contains DescribeEndpoint and DescribeInferenceComponent calls', () => {

        it('should exist as a template file', () => {
            assert.ok(
                statusTemplateContent !== null,
                'templates/do/status must exist'
            );
        });

        it('should contain describe-endpoint call', () => {
            assert.ok(
                statusTemplateContent.includes('describe-endpoint'),
                'do/status must contain describe-endpoint API call'
            );
        });

        it('should contain describe-inference-component call', () => {
            assert.ok(
                statusTemplateContent.includes('describe-inference-component'),
                'do/status must contain describe-inference-component API call'
            );
        });

        it('should iterate do/ic/*.conf for multi-IC status', () => {
            assert.ok(
                statusTemplateContent.includes('ic/*.conf'),
                'do/status must iterate do/ic/*.conf for multi-IC status'
            );
        });

        it('should display endpoint name and status', () => {
            assert.ok(
                statusTemplateContent.includes('ENDPOINT_NAME') ||
                statusTemplateContent.includes('${ENDPOINT_NAME'),
                'do/status must display endpoint name'
            );
            assert.ok(
                statusTemplateContent.includes('EndpointStatus'),
                'do/status must display endpoint status'
            );
        });

        it('should display IC status with GPU count', () => {
            assert.ok(
                statusTemplateContent.includes('NumberOfAcceleratorDevicesRequired') ||
                statusTemplateContent.includes('ic_gpu_count'),
                'do/status must display GPU count for each IC'
            );
        });

        it('should display IC copy count', () => {
            assert.ok(
                statusTemplateContent.includes('CopyCount') ||
                statusTemplateContent.includes('ic_copy_count'),
                'do/status must display copy count for each IC'
            );
        });

        it('should handle ENDPOINT_EXTERNAL marker', () => {
            assert.ok(
                statusTemplateContent.includes('ENDPOINT_EXTERNAL'),
                'do/status must handle ENDPOINT_EXTERNAL flag'
            );
            assert.ok(
                statusTemplateContent.includes('external'),
                'do/status must show (external) marker for external endpoints'
            );
        });

        it('should handle legacy single-IC path (no do/ic/ directory)', () => {
            assert.ok(
                statusTemplateContent.includes('INFERENCE_COMPONENT_NAME'),
                'do/status must handle legacy INFERENCE_COMPONENT_NAME from config'
            );
        });

        it('should display total GPU usage summary', () => {
            assert.ok(
                statusTemplateContent.includes('TOTAL_GPU') ||
                statusTemplateContent.includes('Total GPU usage'),
                'do/status must display total GPU usage'
            );
        });
    });

    // ================================================================
    // do/status — instance pools display (Requirement 6.2)
    // ================================================================
    describe('do/status: instance pools display', () => {

        it('should detect InstancePools in the DescribeEndpoint response', () => {
            assert.ok(
                statusTemplateContent.includes('InstancePools'),
                'do/status must check for InstancePools in endpoint response'
            );
        });

        it('should set HAS_INSTANCE_POOLS flag based on response content', () => {
            assert.ok(
                statusTemplateContent.includes('HAS_INSTANCE_POOLS=false'),
                'do/status must initialize HAS_INSTANCE_POOLS to false'
            );
            assert.ok(
                statusTemplateContent.includes('HAS_INSTANCE_POOLS=true'),
                'do/status must set HAS_INSTANCE_POOLS to true when pools detected'
            );
        });

        it('should display "Instance Pools:" header when pools are active', () => {
            assert.ok(
                statusTemplateContent.includes('echo "Instance Pools:"'),
                'do/status must display "Instance Pools:" header when pools detected'
            );
        });

        it('should extract Priority from pool entries', () => {
            assert.ok(
                statusTemplateContent.includes('"Priority"'),
                'do/status must extract Priority from pool entries'
            );
            assert.ok(
                statusTemplateContent.includes('pool_priorities'),
                'do/status must store pool priorities in a variable'
            );
        });

        it('should extract InstanceType from pool entries', () => {
            assert.ok(
                statusTemplateContent.includes('pool_types'),
                'do/status must store pool instance types in a variable'
            );
        });

        it('should extract CurrentInstanceCount from pool entries', () => {
            assert.ok(
                statusTemplateContent.includes('pool_instance_counts'),
                'do/status must store pool instance counts in a variable'
            );
        });

        it('should mark pools with instances > 0 as active', () => {
            assert.ok(
                statusTemplateContent.includes('← active'),
                'do/status must mark active pools with "← active" indicator'
            );
        });

        it('should display per-pool priority, instance type, and count', () => {
            assert.ok(
                statusTemplateContent.includes('Priority %s'),
                'do/status must display priority number for each pool'
            );
            assert.ok(
                statusTemplateContent.includes('instances)'),
                'do/status must display instance count for each pool'
            );
        });

        it('should fall back to single instance type display when no pools', () => {
            // The else branch should still show the standard single instance type line
            assert.ok(
                statusTemplateContent.includes('# Standard single instance type path'),
                'do/status must have a standard single instance type path comment'
            );
            // Verify the else branch contains EP_INSTANCE_TYPE display
            const elseBlock = statusTemplateContent.substring(
                statusTemplateContent.indexOf('# Standard single instance type path'),
                statusTemplateContent.indexOf('fi', statusTemplateContent.indexOf('# Standard single instance type path'))
            );
            assert.ok(
                elseBlock.includes('EP_INSTANCE_TYPE'),
                'do/status must fall back to single instance type display when no pools'
            );
        });
    });

    // ================================================================
    // do/status — excluded from async/batch/hyperpod
    // ================================================================
    describe('do/status: excluded from async/batch/hyperpod output', () => {

        it('should be excluded for hyperpod-eks via ignore patterns in app.js', () => {
            // Check that app.js has ignore pattern for do/status when hyperpod-eks
            assert.ok(
                appJsContent.includes("'**/do/status'"),
                'app.js must have ignore pattern for do/status'
            );

            // Verify it's in the hyperpod-eks block
            const hyperpodBlock = appJsContent.substring(
                appJsContent.indexOf("deploymentTarget === 'hyperpod-eks'"),
                appJsContent.indexOf('}', appJsContent.indexOf("'**/do/status'", appJsContent.indexOf("deploymentTarget === 'hyperpod-eks'")))
            );
            assert.ok(
                hyperpodBlock.includes("'**/do/status'"),
                'do/status must be in hyperpod-eks ignore patterns'
            );
        });

        it('should be excluded for async-inference via ignore patterns in app.js', () => {
            // Find the async/batch block
            const asyncBatchBlock = appJsContent.substring(
                appJsContent.indexOf("async-inference") > 0
                    ? appJsContent.indexOf("async-inference")
                    : 0,
                appJsContent.indexOf('}', appJsContent.lastIndexOf("'**/do/status'"))
            );
            assert.ok(
                asyncBatchBlock.includes("'**/do/status'"),
                'do/status must be in async-inference ignore patterns'
            );
        });

        it('should be excluded for batch-transform via ignore patterns in app.js', () => {
            // The async and batch share the same ignore block
            const ignoreBlock = appJsContent.substring(
                appJsContent.indexOf("async-inference' || answers.deploymentTarget === 'batch-transform'"),
                appJsContent.indexOf('}', appJsContent.indexOf("async-inference' || answers.deploymentTarget === 'batch-transform'") + 50)
            );
            assert.ok(
                ignoreBlock.includes("'**/do/status'"),
                'do/status must be in batch-transform ignore patterns (shared with async)'
            );
        });
    });

    // ================================================================
    // do/status — included in real-time output
    // ================================================================
    describe('do/status: included in real-time output', () => {

        it('should NOT be excluded for realtime-inference in app.js ignore patterns', () => {
            // The realtime-inference path should NOT have do/status in its ignore patterns
            // The only blocks that ignore do/status are hyperpod-eks and async/batch
            // Verify that the realtime-inference specific block (if any) does not ignore do/status

            // Find the block that checks for non-hyperpod (which is the only realtime-specific block)
            const nonHyperpodBlock = appJsContent.substring(
                appJsContent.indexOf("deploymentTarget !== 'hyperpod-eks'"),
                appJsContent.indexOf('}', appJsContent.indexOf("deploymentTarget !== 'hyperpod-eks'"))
            );

            assert.ok(
                !nonHyperpodBlock.includes("'**/do/status'"),
                'realtime-inference must NOT exclude do/status'
            );
        });

        it('should be in the executable permissions list in app.js', () => {
            assert.ok(
                appJsContent.includes("'do/status'"),
                'do/status must be in the executable permissions list in app.js'
            );
        });

        it('do/status template should be a valid bash script', () => {
            assert.ok(
                statusTemplateContent.startsWith('#!/bin/bash'),
                'do/status must start with bash shebang'
            );
        });

        it('do/status template should source do/config', () => {
            assert.ok(
                statusTemplateContent.includes('source "${SCRIPT_DIR}/config"'),
                'do/status must source do/config'
            );
        });
    });

    // ================================================================
    // do/benchmark --ic <name> — correct IC in benchmark target JSON
    // ================================================================
    describe('do/benchmark --ic <name>: uses correct IC in benchmark target JSON', () => {

        it('should parse --ic flag from arguments', () => {
            assert.ok(
                benchmarkTemplateContent.includes('--ic)'),
                'do/benchmark must parse --ic flag'
            );
            assert.ok(
                benchmarkTemplateContent.includes('IC_ARG'),
                'do/benchmark must store IC argument in IC_ARG variable'
            );
        });

        it('should look up IC config from do/ic/<name>.conf when --ic is provided', () => {
            assert.ok(
                benchmarkTemplateContent.includes('ic/${IC_ARG}.conf'),
                'do/benchmark must reference do/ic/<IC_ARG>.conf'
            );
        });

        it('should source IC config to get IC_DEPLOYED_NAME', () => {
            assert.ok(
                benchmarkTemplateContent.includes('IC_DEPLOYED_NAME'),
                'do/benchmark must use IC_DEPLOYED_NAME from IC config'
            );
        });

        it('should error when IC has not been deployed', () => {
            assert.ok(
                benchmarkTemplateContent.includes('has not been deployed yet'),
                'do/benchmark must error when IC_DEPLOYED_NAME is empty'
            );
        });

        it('should use IC_NAME in the benchmark target JSON', () => {
            assert.ok(
                benchmarkTemplateContent.includes('${IC_NAME}'),
                'do/benchmark must use IC_NAME variable in benchmark target'
            );
            assert.ok(
                benchmarkTemplateContent.includes('InferenceComponents'),
                'do/benchmark target must include InferenceComponents array'
            );
        });

        it('should construct BENCHMARK_TARGET with endpoint and IC identifier', () => {
            assert.ok(
                benchmarkTemplateContent.includes('BENCHMARK_TARGET='),
                'do/benchmark must construct BENCHMARK_TARGET variable'
            );
            // Verify the target JSON structure includes both endpoint and IC
            // The template uses escaped quotes: \"Endpoint\", \"Identifier\", etc.
            assert.ok(
                benchmarkTemplateContent.includes('\\"Endpoint\\"') &&
                benchmarkTemplateContent.includes('\\"Identifier\\"') &&
                benchmarkTemplateContent.includes('\\"InferenceComponents\\"'),
                'BENCHMARK_TARGET must contain Endpoint.Identifier and InferenceComponents'
            );
        });

        it('should pass BENCHMARK_TARGET to create-ai-benchmark-job', () => {
            assert.ok(
                benchmarkTemplateContent.includes('--benchmark-target "${BENCHMARK_TARGET}"'),
                'do/benchmark must pass BENCHMARK_TARGET to create-ai-benchmark-job'
            );
        });

        it('should fall back to first IC in do/ic/ when no --ic argument', () => {
            assert.ok(
                benchmarkTemplateContent.includes('/ic/*.conf'),
                'do/benchmark must iterate do/ic/*.conf when no --ic argument'
            );
        });

        it('should fall back to INFERENCE_COMPONENT_NAME for legacy path', () => {
            assert.ok(
                benchmarkTemplateContent.includes('INFERENCE_COMPONENT_NAME'),
                'do/benchmark must fall back to INFERENCE_COMPONENT_NAME for legacy path'
            );
        });
    });
});
