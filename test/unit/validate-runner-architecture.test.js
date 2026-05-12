// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: do/validate emits advisory finding for incompatible model architecture pairing.
 *
 * Validates: Requirement 5.1-5.5 (do/validate integration)
 * Acceptance Checklist: `do/validate` emits warning finding for incompatible pairing
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../../src/lib/validate-runner.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempRegistry() {
    const tempDir = path.join(os.tmpdir(), `mlcc-arch-val-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

function cleanupTempRegistry(tempDir) {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function writeManifest(registryPath) {
    const manifest = {
        lastSynced: new Date().toISOString(),
        services: {
            sagemaker: { shapeCount: 10, enumCount: 2, version: '2017-07-24' }
        },
        source: 'https://github.com/aws/aws-sdk-js-v3/tree/main/codegen/sdk-codegen/aws-models'
    };
    writeFileSync(path.join(registryPath, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

function writeServiceModel(registryPath, serviceName, model) {
    const serviceDir = path.join(registryPath, serviceName);
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(path.join(serviceDir, 'service-2.json'), JSON.stringify(model), 'utf8');
}

function createMinimalServiceModel() {
    return {
        metadata: { apiVersion: '2017-07-24' },
        operations: {},
        shapes: {}
    };
}

/**
 * Capture console output and intercept process.exit.
 */
async function captureRunOutput(fn) {
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalExit = process.exit;

    let exitCode = null;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));
    process.exit = (code) => { exitCode = code; };

    try {
        const result = await fn();
        return { result, logs, exitCode };
    } finally {
        console.log = originalLog;
        console.error = originalError;
        console.warn = originalWarn;
        process.exit = originalExit;
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Validate Runner - Architecture Compatibility', () => {
    let tempRegistry;
    let originalFetch;

    beforeEach(() => {
        tempRegistry = createTempRegistry();
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        cleanupTempRegistry(tempRegistry);
        globalThis.fetch = originalFetch;
    });

    it('emits advisory finding for incompatible model architecture pairing', async () => {
        writeManifest(tempRegistry);
        writeServiceModel(tempRegistry, 'sagemaker', createMinimalServiceModel());

        // Mock fetch to return a config.json with an unsupported model_type
        globalThis.fetch = async (url) => {
            if (url.includes('config.json')) {
                return {
                    ok: true,
                    json: async () => ({ model_type: 'totally_unsupported_arch' }),
                    text: async () => JSON.stringify({ model_type: 'totally_unsupported_arch' })
                };
            }
            return { ok: false, status: 404 };
        };

        const config = {
            INSTANCE_TYPE: 'ml.g5.xlarge',
            DEPLOYMENT_TARGET: 'realtime-inference',
            MODEL_NAME: 'test-org/test-model',
            BASE_IMAGE: 'vllm/vllm-openai:v0.10.1',
            MODEL_SERVER: 'vllm'
        };

        const { logs, exitCode } = await captureRunOutput(async () => {
            return run({
                config,
                format: 'json',
                registryPath: tempRegistry
            });
        });

        const output = logs.join('\n');
        const report = JSON.parse(output);

        // Architecture finding should be in advisoryFindings (source=cross-cutting, confidence=medium)
        assert.ok(report.advisoryFindings.length > 0,
            'Should have advisory findings for incompatible architecture');

        const archFinding = report.advisoryFindings.find(f =>
            f.fieldPath === 'MODEL_NAME' &&
            f.constraint?.type === 'architecture-compatibility'
        );

        assert.ok(archFinding, 'Should have an architecture-compatibility advisory finding');
        assert.strictEqual(archFinding.invalidValue, 'totally_unsupported_arch');
        assert.strictEqual(archFinding.severity, 'warning');
        assert.strictEqual(archFinding.confidence, 'medium');
        assert.strictEqual(archFinding.constraint.server, 'vllm');
        assert.strictEqual(archFinding.constraint.version, '0.10.1');
        assert.ok(archFinding.remediationHint.includes('totally_unsupported_arch'),
            'Remediation hint should mention the unsupported model type');
        assert.ok(archFinding.remediationHint.includes('vllm'),
            'Remediation hint should mention the server');

        // Should still exit 0 (advisory findings don't block)
        assert.strictEqual(exitCode, 0, 'Advisory findings should not block (exit 0)');
    });

    it('emits no finding for compatible model architecture pairing', async () => {
        writeManifest(tempRegistry);
        writeServiceModel(tempRegistry, 'sagemaker', createMinimalServiceModel());

        // Mock fetch to return a config.json with a supported model_type (llama is in vLLM catalog)
        globalThis.fetch = async (url) => {
            if (url.includes('config.json')) {
                return {
                    ok: true,
                    json: async () => ({ model_type: 'llama' }),
                    text: async () => JSON.stringify({ model_type: 'llama' })
                };
            }
            return { ok: false, status: 404 };
        };

        const config = {
            INSTANCE_TYPE: 'ml.g5.xlarge',
            DEPLOYMENT_TARGET: 'realtime-inference',
            MODEL_NAME: 'meta-llama/Llama-2-7b',
            BASE_IMAGE: 'vllm/vllm-openai:v0.10.1',
            MODEL_SERVER: 'vllm'
        };

        const { logs, exitCode } = await captureRunOutput(async () => {
            return run({
                config,
                format: 'json',
                registryPath: tempRegistry
            });
        });

        const output = logs.join('\n');
        const report = JSON.parse(output);

        // No architecture finding should be present
        const archFinding = report.advisoryFindings.find(f =>
            f.fieldPath === 'MODEL_NAME' &&
            f.constraint?.type === 'architecture-compatibility'
        );

        assert.strictEqual(archFinding, undefined,
            'Should NOT have architecture-compatibility finding for compatible model');
        assert.strictEqual(exitCode, 0);
    });

    it('skips architecture check when MODEL_NAME is not in config', async () => {
        writeManifest(tempRegistry);
        writeServiceModel(tempRegistry, 'sagemaker', createMinimalServiceModel());

        // fetch should not be called for architecture check
        let fetchCalled = false;
        globalThis.fetch = async () => {
            fetchCalled = true;
            return { ok: false, status: 404 };
        };

        const config = {
            INSTANCE_TYPE: 'ml.g5.xlarge',
            DEPLOYMENT_TARGET: 'realtime-inference',
            BASE_IMAGE: 'vllm/vllm-openai:v0.10.1',
            MODEL_SERVER: 'vllm'
            // No MODEL_NAME
        };

        const { logs, exitCode } = await captureRunOutput(async () => {
            return run({
                config,
                format: 'json',
                registryPath: tempRegistry
            });
        });

        const output = logs.join('\n');
        const report = JSON.parse(output);

        const archFinding = report.advisoryFindings.find(f =>
            f.constraint?.type === 'architecture-compatibility'
        );

        assert.strictEqual(archFinding, undefined,
            'Should NOT check architecture when MODEL_NAME is absent');
        assert.strictEqual(fetchCalled, false,
            'Should not call fetch when MODEL_NAME is absent');
        assert.strictEqual(exitCode, 0);
    });

    it('gracefully skips when HuggingFace fetch fails', async () => {
        writeManifest(tempRegistry);
        writeServiceModel(tempRegistry, 'sagemaker', createMinimalServiceModel());

        // Mock fetch to fail
        globalThis.fetch = async () => {
            throw new Error('Network error');
        };

        const config = {
            INSTANCE_TYPE: 'ml.g5.xlarge',
            DEPLOYMENT_TARGET: 'realtime-inference',
            MODEL_NAME: 'test-org/test-model',
            BASE_IMAGE: 'vllm/vllm-openai:v0.10.1',
            MODEL_SERVER: 'vllm'
        };

        const { logs, exitCode } = await captureRunOutput(async () => {
            return run({
                config,
                format: 'json',
                registryPath: tempRegistry
            });
        });

        const output = logs.join('\n');
        const report = JSON.parse(output);

        // Should gracefully degrade — no architecture finding, no crash
        const archFinding = report.advisoryFindings.find(f =>
            f.constraint?.type === 'architecture-compatibility'
        );

        assert.strictEqual(archFinding, undefined,
            'Should not emit finding when HuggingFace fetch fails');
        assert.strictEqual(exitCode, 0, 'Should still pass when fetch fails');
    });

    it('includes architecture finding in text output', async () => {
        writeManifest(tempRegistry);
        writeServiceModel(tempRegistry, 'sagemaker', createMinimalServiceModel());

        // Mock fetch to return unsupported model_type
        globalThis.fetch = async (url) => {
            if (url.includes('config.json')) {
                return {
                    ok: true,
                    json: async () => ({ model_type: 'nonexistent_model_arch' }),
                    text: async () => JSON.stringify({ model_type: 'nonexistent_model_arch' })
                };
            }
            return { ok: false, status: 404 };
        };

        const config = {
            INSTANCE_TYPE: 'ml.g5.xlarge',
            DEPLOYMENT_TARGET: 'realtime-inference',
            MODEL_NAME: 'test-org/unsupported-model',
            BASE_IMAGE: 'vllm/vllm-openai:v0.10.1',
            MODEL_SERVER: 'vllm'
        };

        const { logs, exitCode } = await captureRunOutput(async () => {
            return run({
                config,
                format: 'text',
                registryPath: tempRegistry
            });
        });

        const output = logs.join('\n');

        // Text output should mention the advisory finding
        assert.ok(output.includes('Advisory Findings') || output.includes('advisory'),
            'Text output should mention advisory findings');
        assert.ok(output.includes('MODEL_NAME'),
            'Text output should reference MODEL_NAME field');
        assert.strictEqual(exitCode, 0, 'Advisory findings should not block');
    });
});
