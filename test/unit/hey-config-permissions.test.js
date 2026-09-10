// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `mcc hey config permissions` — permission editor helpers.
 *
 * Verifies:
 *  - reading current classes from .mlcc/agent-config.json (snake_case + camelCase)
 *  - per-script defaults when unset
 *  - merge-writing script_classes while preserving other config keys
 *  - table rendering and permission badges
 *  - config dispatch for unknown/missing subcommands
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    HEY_KNOWN_SCRIPTS,
    PERMISSION_CLASSES,
    _readScriptClasses,
    _writeScriptClasses,
    _renderPermissionTable,
    _permissionBadge,
    _runHeyConfig
} from '../../bin/cli.js';

function mkTmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hey-perms-'));
}

function writeConfig(projectDir, obj) {
    const mlccDir = path.join(projectDir, '.mlcc');
    fs.mkdirSync(mlccDir, { recursive: true });
    fs.writeFileSync(path.join(mlccDir, 'agent-config.json'), JSON.stringify(obj), 'utf8');
}

function readConfig(projectDir) {
    return JSON.parse(fs.readFileSync(path.join(projectDir, '.mlcc', 'agent-config.json'), 'utf8'));
}

describe('mcc hey config permissions — constants', () => {
    it('exposes 20 known scripts and 3 permission classes', () => {
        assert.strictEqual(HEY_KNOWN_SCRIPTS.length, 20);
        assert.deepStrictEqual(PERMISSION_CLASSES, ['confirm', 'auto', 'denied']);
    });

    it('lists do/stage first (matches spec ordering)', () => {
        assert.strictEqual(HEY_KNOWN_SCRIPTS[0], 'do/stage');
    });
});

describe('_readScriptClasses', () => {
    let projectDir;
    beforeEach(() => { projectDir = mkTmpProject(); });
    afterEach(() => { try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('returns per-script defaults when no config exists', () => {
        const classes = _readScriptClasses(projectDir);
        assert.strictEqual(classes['do/test'], 'auto');    // curated auto default
        assert.strictEqual(classes['do/status'], 'auto');
        assert.strictEqual(classes['do/deploy'], 'confirm'); // everything else confirm
        assert.strictEqual(classes['do/stage'], 'confirm');
    });

    it('reads snake_case script_classes', () => {
        writeConfig(projectDir, {
            confirmation: { script_classes: { 'do/deploy': 'auto', 'do/test': 'denied' } }
        });
        const classes = _readScriptClasses(projectDir);
        assert.strictEqual(classes['do/deploy'], 'auto');
        assert.strictEqual(classes['do/test'], 'denied');
    });

    it('reads legacy camelCase scriptClasses', () => {
        writeConfig(projectDir, {
            confirmation: { scriptClasses: { 'do/build': 'denied' } }
        });
        const classes = _readScriptClasses(projectDir);
        assert.strictEqual(classes['do/build'], 'denied');
    });

    it('ignores invalid class values, falling back to defaults', () => {
        writeConfig(projectDir, {
            confirmation: { script_classes: { 'do/deploy': 'bogus' } }
        });
        const classes = _readScriptClasses(projectDir);
        assert.strictEqual(classes['do/deploy'], 'confirm');
    });

    it('tolerates malformed JSON', () => {
        const mlccDir = path.join(projectDir, '.mlcc');
        fs.mkdirSync(mlccDir, { recursive: true });
        fs.writeFileSync(path.join(mlccDir, 'agent-config.json'), '{ not json', 'utf8');
        const classes = _readScriptClasses(projectDir);
        assert.strictEqual(classes['do/test'], 'auto');
    });
});

describe('_writeScriptClasses', () => {
    let projectDir;
    beforeEach(() => { projectDir = mkTmpProject(); });
    afterEach(() => { try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('creates the config with confirmation.script_classes', () => {
        _writeScriptClasses(projectDir, { 'do/deploy': 'auto' });
        const config = readConfig(projectDir);
        assert.strictEqual(config.confirmation.script_classes['do/deploy'], 'auto');
    });

    it('preserves unrelated keys and merges script_classes', () => {
        writeConfig(projectDir, {
            venv_path: '.mlcc/hey-venv',
            confirmation: { mode: 'default', script_classes: { 'do/test': 'auto' } }
        });
        _writeScriptClasses(projectDir, { 'do/deploy': 'denied' });
        const config = readConfig(projectDir);
        assert.strictEqual(config.venv_path, '.mlcc/hey-venv');
        assert.strictEqual(config.confirmation.mode, 'default');
        assert.strictEqual(config.confirmation.script_classes['do/test'], 'auto');
        assert.strictEqual(config.confirmation.script_classes['do/deploy'], 'denied');
    });

    it('drops legacy camelCase scriptClasses key', () => {
        writeConfig(projectDir, {
            confirmation: { scriptClasses: { 'do/build': 'denied' } }
        });
        _writeScriptClasses(projectDir, { 'do/build': 'auto' });
        const config = readConfig(projectDir);
        assert.ok(!('scriptClasses' in config.confirmation));
        assert.strictEqual(config.confirmation.script_classes['do/build'], 'auto');
    });

    it('round-trips through _readScriptClasses', () => {
        const edited = _readScriptClasses(projectDir);
        edited['do/deploy'] = 'denied';
        edited['do/build'] = 'auto';
        _writeScriptClasses(projectDir, edited);
        const reread = _readScriptClasses(projectDir);
        assert.strictEqual(reread['do/deploy'], 'denied');
        assert.strictEqual(reread['do/build'], 'auto');
    });
});

describe('_permissionBadge / _renderPermissionTable', () => {
    it('colors badges green/yellow/red', () => {
        assert.ok(_permissionBadge('auto').includes('\x1b[32m'));    // green
        assert.ok(_permissionBadge('confirm').includes('\x1b[33m')); // yellow
        assert.ok(_permissionBadge('denied').includes('\x1b[31m'));  // red
    });

    it('renders a row per script and marks the cursor', () => {
        const classes = {};
        for (const s of HEY_KNOWN_SCRIPTS) classes[s] = 'confirm';
        const out = _renderPermissionTable(HEY_KNOWN_SCRIPTS, classes, 2, '.mlcc/agent-config.json');
        assert.ok(out.includes('❯'), 'should include the cursor pointer');
        for (const s of HEY_KNOWN_SCRIPTS) {
            assert.ok(out.includes(s), `output should mention ${s}`);
        }
        assert.ok(out.includes('SPACE cycle'), 'should include the key legend');
    });
});

describe('_runHeyConfig dispatch', () => {
    let projectDir;
    let originalError;
    beforeEach(() => {
        projectDir = mkTmpProject();
        originalError = console.error;
        console.error = () => {};
        process.exitCode = 0;
    });
    afterEach(() => {
        console.error = originalError;
        process.exitCode = 0;
        try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('sets a non-zero exit code for an unknown subcommand', async () => {
        await _runHeyConfig(['bogus'], projectDir);
        assert.strictEqual(process.exitCode, 1);
    });

    it('sets a non-zero exit code when no subcommand is given', async () => {
        await _runHeyConfig([], projectDir);
        assert.strictEqual(process.exitCode, 1);
    });
});
