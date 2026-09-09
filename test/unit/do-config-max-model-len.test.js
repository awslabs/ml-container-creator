// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL046: do/config IC_ENV_VLLM_MAX_MODEL_LEN sizer-computed default
 *
 * Verifies that the rendered do/config uses the instance-sizer's computed
 * maximum context length (sizerMaxModelLen) as the default for
 * IC_ENV_VLLM_MAX_MODEL_LEN when available, falling back to 4096 otherwise,
 * and that a single authoritative line is emitted on the capped path where
 * the value already flows through icEnvVars.
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/config');

/**
 * Render the real templates/do/config with a minimal, overridable var set.
 * Any extra keys in `answers` (e.g. sizerMaxModelLen) pass through via spread.
 */
function renderConfig(answers = {}) {
    const templateContent = readFileSync(templatePath, 'utf8');
    return ejs.render(templateContent, {
        orderedEnvVars: [],
        baseImage: '',
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        ngcApiKey: undefined,
        icCpuCount: undefined,
        icMemorySize: undefined,
        icGpuCount: 1,
        icCopyCount: undefined,
        icModelWeight: undefined,
        endpointInitialInstanceCount: undefined,
        endpointDataCapturePercent: undefined,
        endpointVariantName: undefined,
        endpointVolumeSize: undefined,
        modelEnvVars: {},
        serverEnvVars: {},
        icEnvVars: {},
        asyncMaxConcurrentInvocations: undefined,
        asyncSnsSuccessTopic: undefined,
        asyncSnsErrorTopic: undefined,
        batchInstanceCount: undefined,
        batchSplitType: 'Line',
        batchStrategy: 'SingleRecord',
        batchJoinSource: 'None',
        batchMaxConcurrentTransforms: undefined,
        batchMaxPayloadInMB: undefined,
        hyperPodCluster: '',
        hyperPodNamespace: 'default',
        hyperPodReplicas: 1,
        fsxVolumeHandle: undefined,
        instancePools: undefined,
        capacityReservationArn: undefined,
        deploy_mode: undefined,
        existingEndpointName: undefined,
        enableLora: undefined,
        hfToken: undefined,
        hfTokenArn: undefined,
        ngcTokenArn: undefined,
        modelName: 'test-model',
        tuneSupported: undefined,
        tuneModelId: undefined,
        container_image_uri: undefined,
        modelFormat: undefined,
        includeBenchmark: undefined,
        benchmarkConcurrency: undefined,
        benchmarkInputTokensMean: undefined,
        benchmarkOutputTokensMean: undefined,
        benchmarkStreaming: undefined,
        benchmarkRequestCount: undefined,
        benchmarkS3OutputPath: undefined,
        ciBenchmarkResultsBucket: undefined,
        ...answers
    });
}

function countMaxModelLenExports(rendered) {
    return (rendered.match(/^export IC_ENV_VLLM_MAX_MODEL_LEN=/gm) || []).length;
}

describe('BL046: do/config IC_ENV_VLLM_MAX_MODEL_LEN sizer default', () => {
    // Sanity: the template must render with no unresolved EJS in any case.
    before(() => {
        const out = renderConfig();
        assert.ok(!out.includes('<%'), 'rendered do/config should contain no unresolved EJS');
    });

    it('3.1 uses sizerMaxModelLen when set and NOT already in icEnvVars (realtime branch)', () => {
        const out = renderConfig({
            deploymentTarget: 'realtime-inference',
            modelServer: 'vllm',
            icEnvVars: {},
            sizerMaxModelLen: 8192
        });
        assert.match(out, /export IC_ENV_VLLM_MAX_MODEL_LEN=\$\{IC_ENV_VLLM_MAX_MODEL_LEN:-8192\}/);
        assert.ok(!out.includes(':-4096}'), 'should not fall back to 4096 when sizer value is present');
    });

    it('3.1 uses sizerMaxModelLen on the hyperpod branch when icEnvVars is populated but lacks max_model_len', () => {
        const out = renderConfig({
            deploymentTarget: 'hyperpod-eks',
            modelServer: 'vllm',
            // icEnvVars populated (triggers the outer block) but WITHOUT a max_model_len key
            icEnvVars: { SOME_OTHER_VAR: 'x' },
            sizerMaxModelLen: 16384
        });
        assert.match(out, /export IC_ENV_VLLM_MAX_MODEL_LEN=\$\{IC_ENV_VLLM_MAX_MODEL_LEN:-16384\}/);
    });

    it('3.2 falls back to 4096 when sizerMaxModelLen is absent', () => {
        const out = renderConfig({
            deploymentTarget: 'realtime-inference',
            modelServer: 'vllm',
            icEnvVars: {}
            // sizerMaxModelLen intentionally omitted
        });
        assert.match(out, /export IC_ENV_VLLM_MAX_MODEL_LEN=\$\{IC_ENV_VLLM_MAX_MODEL_LEN:-4096\}/);
    });

    it('3.2 produces literal integers only — no unresolved EJS in the default', () => {
        const out = renderConfig({ modelServer: 'sglang', sizerMaxModelLen: 32768, icEnvVars: {} });
        assert.match(out, /:-32768\}/);
        assert.ok(!out.includes('sizerMaxModelLen'), 'EJS expression must be evaluated, not emitted verbatim');
    });

    it('3.3 capped path (realtime): single authoritative line, no duplicate', () => {
        // On the capped path the value flows through icEnvVars. Because the
        // realtime block is the else-if of the icEnvVars-populated block, a
        // populated icEnvVars routes through the hyperpod-style block instead.
        const out = renderConfig({
            deploymentTarget: 'realtime-inference',
            modelServer: 'vllm',
            icEnvVars: { VLLM_MAX_MODEL_LEN: '8192' },
            sizerMaxModelLen: 8192
        });
        const count = countMaxModelLenExports(out);
        assert.strictEqual(count, 1, `expected exactly one IC_ENV_VLLM_MAX_MODEL_LEN export, got ${count}`);
        assert.match(out, /export IC_ENV_VLLM_MAX_MODEL_LEN=\$\{IC_ENV_VLLM_MAX_MODEL_LEN:-8192\}/);
    });

    it('3.3 capped path (hyperpod): single authoritative line, no duplicate', () => {
        // On the sglang capped path the authoritative value flows through the
        // icEnvVars block as IC_ENV_SGLANG_MAX_MODEL_LEN. The VLLM fallback line
        // is correctly suppressed by the guard, so there is no conflicting duplicate.
        const out = renderConfig({
            deploymentTarget: 'hyperpod-eks',
            modelServer: 'sglang',
            icEnvVars: { SGLANG_MAX_MODEL_LEN: '8192' },
            sizerMaxModelLen: 8192
        });
        // Authoritative line comes from the icEnvVars block.
        assert.match(out, /export IC_ENV_SGLANG_MAX_MODEL_LEN=\$\{IC_ENV_SGLANG_MAX_MODEL_LEN:-8192\}/);
        // Exactly one SGLANG max-model-len export, and no VLLM fallback duplicate.
        const sglangCount = (out.match(/^export IC_ENV_SGLANG_MAX_MODEL_LEN=/gm) || []).length;
        assert.strictEqual(sglangCount, 1, `expected exactly one IC_ENV_SGLANG_MAX_MODEL_LEN export, got ${sglangCount}`);
        assert.strictEqual(countMaxModelLenExports(out), 0, 'VLLM fallback line must be suppressed on the capped sglang path');
    });
});
