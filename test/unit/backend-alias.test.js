// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL084: --backend alias for --deployment-config
 *
 * Verifies that the hand-added `--backend` CLI alias resolves into
 * `deploymentConfig`, produces byte-identical generated output, shares the
 * same choices enum, and handles conflicts / invalid values consistently.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { describe, it, after } from 'mocha';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGenerator } from '../helpers/run-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'bin/cli.js');

/** Run the CLI allowing non-zero exit; capture output + exit code. */
function runCliSafe(args = [], { timeout = 30000 } = {}) {
    const env = { ...process.env, VALIDATE_ENV_VARS: 'false' };
    try {
        const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
            cwd: PROJECT_ROOT, env, timeout, stdio: 'pipe', encoding: 'utf8'
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (error) {
        return {
            stdout: error.stdout || '',
            stderr: error.stderr || '',
            exitCode: error.status ?? 1
        };
    }
}

describe('BL084: --backend alias for --deployment-config', () => {
    const results = [];
    after(() => {
        for (const r of results) {
            try { r.cleanup(); } catch { /* ignore */ }
        }
    });

    // Normalize non-deterministic / input-dependent lines so we compare the
    // parts that MUST be identical between --backend and --deployment-config.
    function normalize(cfg) {
        return cfg
            .replace(/^# Generated: .*$/m, '# Generated: <TS>')
            .replace(/^export PROJECT_NAME=.*$/m, 'export PROJECT_NAME="<NAME>"');
    }

    describe('5.1/5.2 equivalence — generated do/config matches', function () {
        // Each test spawns two generator subprocesses (~1.5s each); raise the
        // Mocha per-test timeout above the 2s default to avoid flaky timeouts.
        this.timeout(60000);
        it('5.1 --backend transformers-vllm equals --deployment-config transformers-vllm', () => {
            const viaBackend = runGenerator(
                { backend: 'transformers-vllm', 'model-name': 'test-model', 'region': 'us-east-1' },
                { projectName: 'proj-equiv', timeout: 60000 }
            );
            results.push(viaBackend);
            const viaCanonical = runGenerator(
                { 'deployment-config': 'transformers-vllm', 'model-name': 'test-model', 'region': 'us-east-1' },
                { projectName: 'proj-equiv', timeout: 60000 }
            );
            results.push(viaCanonical);

            const cfgBackend = normalize(fs.readFileSync(viaBackend.file('do/config'), 'utf8'));
            const cfgCanonical = normalize(fs.readFileSync(viaCanonical.file('do/config'), 'utf8'));
            assert.strictEqual(
                cfgBackend, cfgCanonical,
                'do/config generated via --backend should match --deployment-config (modulo timestamp/name)'
            );
            assert.match(cfgBackend, /DEPLOYMENT_CONFIG="transformers-vllm"/);
        });

        it('5.2 --backend http-flask works (different architecture prefix)', () => {
            const viaBackend = runGenerator(
                { backend: 'http-flask', 'model-name': 'test-model', 'model-format': 'pkl', 'region': 'us-east-1' },
                { projectName: 'proj-flask', timeout: 60000 }
            );
            results.push(viaBackend);
            const viaCanonical = runGenerator(
                { 'deployment-config': 'http-flask', 'model-name': 'test-model', 'model-format': 'pkl', 'region': 'us-east-1' },
                { projectName: 'proj-flask', timeout: 60000 }
            );
            results.push(viaCanonical);

            const cfgBackend = normalize(fs.readFileSync(viaBackend.file('do/config'), 'utf8'));
            const cfgCanonical = normalize(fs.readFileSync(viaCanonical.file('do/config'), 'utf8'));
            assert.strictEqual(cfgBackend, cfgCanonical, 'http-flask do/config should match (modulo timestamp/name)');
            assert.match(cfgBackend, /DEPLOYMENT_CONFIG="http-flask"/);
        });
    });

    describe('5.3/5.4 conflict handling', () => {
        it('5.3 --backend X + --deployment-config Y (different) exits 1 with conflict message', () => {
            const { stderr, exitCode } = runCliSafe([
                'myproj', '--backend', 'transformers-vllm', '--deployment-config', 'triton-fil'
            ]);
            assert.strictEqual(exitCode, 1, 'should exit with status 1 on conflict');
            assert.match(
                stderr,
                /--backend and --deployment-config cannot both be specified with different values/
            );
        });

        it('5.4 --backend X + --deployment-config X (same value) is accepted (no conflict error)', () => {
            // Generate into a temp dir so we do not leave a project in the repo root.
            const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-backend-alias-'));
            results.push({ cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) });
            const { stderr } = runCliSafe([
                'myproj', '--backend', 'transformers-vllm', '--deployment-config', 'transformers-vllm',
                '--skip-prompts', '--model-name', 'test-model', '--project-dir', outDir
            ], { timeout: 60000 });
            assert.ok(
                !/cannot both be specified with different values/.test(stderr),
                'same-value combination must not trigger the conflict error'
            );
        });
    });

    describe('5.5 validation — shared choices enum', () => {
        it('5.5 --backend bogus-value is rejected by the shared choices enum', () => {
            const { stderr, exitCode } = runCliSafe(['myproj', '--backend', 'bogus-value']);
            assert.notStrictEqual(exitCode, 0, 'invalid --backend value should fail');
            assert.match(stderr, /argument 'bogus-value' is invalid|Allowed choices are/);
        });
    });

    describe('help text and grouping', () => {
        it('mcc --help lists --backend with the alias description', () => {
            const out = execFileSync(process.execPath, [CLI_PATH, '--help'], {
                cwd: PROJECT_ROOT, encoding: 'utf8'
            });
            assert.match(out, /--backend <config>/);
            assert.match(out, /Alias for --deployment-config/);
        });
    });
});
