// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL079: `mcc hey init` — advisory agent environment provisioning.
 *
 * Verifies:
 *  - init creates a venv at .mlcc/hey-venv/ (env creation mocked) via uv
 *  - init falls back to `python3 -m venv` + pip when uv is absent
 *  - venv_path is written to .mlcc/agent-config.json
 *  - `mcc hey` resolves the venv Python from venv_path
 *
 * Validates: Requirements 5.1, 5.2
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    _initHeyEnvironment,
    _resolveHeyPython,
    _readVenvPath,
    _venvPython,
    HEY_VENV_REL
} from '../../bin/cli.js';

function mkTmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hey-init-'));
}

describe('BL079: mcc hey init', () => {
    let projectDir;
    let originalLog;
    let originalError;

    beforeEach(() => {
        projectDir = mkTmpProject();
        // Silence console output during tests.
        originalLog = console.log;
        originalError = console.error;
        console.log = () => {};
        console.error = () => {};
        console.warn = () => {};
    });

    afterEach(() => {
        console.log = originalLog;
        console.error = originalError;
        try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    describe('5.1 environment creation (mocked)', () => {
        it('uses uv to create the venv and install packages when uv is available', () => {
            const commands = [];
            _initHeyEnvironment(projectDir, {
                exec: (cmd) => commands.push(cmd),
                hasUv: () => true
            });

            const venvDir = path.join(projectDir, HEY_VENV_REL);
            // First command creates the venv with uv.
            assert.ok(
                commands.some(c => c.startsWith('uv venv') && c.includes(venvDir)),
                `expected a "uv venv" command, got: ${JSON.stringify(commands)}`
            );
            // Install uses uv pip install with the requirements file.
            assert.ok(
                commands.some(c => c.startsWith('uv pip install') && c.includes('requirements-agent.txt')),
                `expected a "uv pip install" command, got: ${JSON.stringify(commands)}`
            );
        });

        it('falls back to python3 -m venv + pip when uv is absent', () => {
            const commands = [];
            _initHeyEnvironment(projectDir, {
                exec: (cmd) => commands.push(cmd),
                hasUv: () => false
            });

            const venvDir = path.join(projectDir, HEY_VENV_REL);
            assert.ok(
                commands.some(c => c.startsWith('python3 -m venv') && c.includes(venvDir)),
                `expected a "python3 -m venv" command, got: ${JSON.stringify(commands)}`
            );
            assert.ok(
                commands.some(c => c.includes('install') && c.includes('requirements-agent.txt') && !c.startsWith('uv')),
                `expected a pip install command, got: ${JSON.stringify(commands)}`
            );
            // No uv commands when uv is unavailable.
            assert.ok(!commands.some(c => c.startsWith('uv ')));
        });

        it('writes venv_path into .mlcc/agent-config.json', () => {
            _initHeyEnvironment(projectDir, {
                exec: () => {},
                hasUv: () => true
            });

            const configPath = path.join(projectDir, '.mlcc', 'agent-config.json');
            assert.ok(fs.existsSync(configPath), 'agent-config.json should be created');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.strictEqual(config.venv_path, HEY_VENV_REL);
        });

        it('merges venv_path into an existing agent-config.json', () => {
            const mlccDir = path.join(projectDir, '.mlcc');
            fs.mkdirSync(mlccDir, { recursive: true });
            fs.writeFileSync(
                path.join(mlccDir, 'agent-config.json'),
                JSON.stringify({ permitted_scripts: ['do/test'], confirmation: { mode: 'all' } }),
                'utf8'
            );

            _initHeyEnvironment(projectDir, { exec: () => {}, hasUv: () => false });

            const config = JSON.parse(fs.readFileSync(path.join(mlccDir, 'agent-config.json'), 'utf8'));
            assert.strictEqual(config.venv_path, HEY_VENV_REL);
            // Existing keys preserved.
            assert.deepStrictEqual(config.permitted_scripts, ['do/test']);
            assert.strictEqual(config.confirmation.mode, 'all');
        });

        it('upgrades packages (-U) when the venv already exists', () => {
            // Pre-create the venv python so init detects an existing environment.
            const venvDir = path.join(projectDir, HEY_VENV_REL);
            const venvPy = _venvPython(venvDir);
            fs.mkdirSync(path.dirname(venvPy), { recursive: true });
            fs.writeFileSync(venvPy, '');

            const commands = [];
            _initHeyEnvironment(projectDir, {
                exec: (cmd) => commands.push(cmd),
                hasUv: () => true
            });

            // Should NOT re-create the venv.
            assert.ok(!commands.some(c => c.startsWith('uv venv')));
            // Install should carry the upgrade flag.
            assert.ok(
                commands.some(c => c.includes('pip install -U') || c.includes('install -U')),
                `expected an upgrade install (-U), got: ${JSON.stringify(commands)}`
            );
        });
    });
});

describe('BL079: mcc hey venv activation (Req 5.2)', () => {
    let projectDir;
    let originalWarn;

    beforeEach(() => {
        projectDir = mkTmpProject();
        originalWarn = console.warn;
        console.warn = () => {};
    });

    afterEach(() => {
        console.warn = originalWarn;
        try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('reads venv_path from the config and returns the venv python when it exists', () => {
        const mlccDir = path.join(projectDir, '.mlcc');
        fs.mkdirSync(mlccDir, { recursive: true });
        fs.writeFileSync(
            path.join(mlccDir, 'agent-config.json'),
            JSON.stringify({ venv_path: HEY_VENV_REL }),
            'utf8'
        );

        assert.strictEqual(_readVenvPath(projectDir), HEY_VENV_REL);

        // Create the venv python interpreter so it resolves.
        const venvPy = _venvPython(path.join(projectDir, HEY_VENV_REL));
        fs.mkdirSync(path.dirname(venvPy), { recursive: true });
        fs.writeFileSync(venvPy, '');

        const resolved = _resolveHeyPython(projectDir);
        assert.strictEqual(resolved, venvPy);
    });

    it('falls back to system python3 with a warning when the venv is missing', () => {
        const mlccDir = path.join(projectDir, '.mlcc');
        fs.mkdirSync(mlccDir, { recursive: true });
        fs.writeFileSync(
            path.join(mlccDir, 'agent-config.json'),
            JSON.stringify({ venv_path: HEY_VENV_REL }),
            'utf8'
        );

        let warned = '';
        console.warn = (msg) => { warned = String(msg); };

        const resolved = _resolveHeyPython(projectDir);
        assert.strictEqual(resolved, 'python3');
        assert.ok(warned.includes('mcc hey init'), `expected warning to mention "mcc hey init", got: ${warned}`);
    });

    it('returns system python3 when venv_path is not configured', () => {
        assert.strictEqual(_readVenvPath(projectDir), null);
        assert.strictEqual(_resolveHeyPython(projectDir), 'python3');
    });
});
