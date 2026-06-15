// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for generator integration with do/stage and supporting files.
 *
 * Verifies that template files exist with correct content and that the generator
 * (src/app.js) references them correctly. These tests validate the template layer
 * without running a full MCC generation.
 *
 * Feature: s3-model-loading
 * Validates: Requirements 4.1, 4.2, 4.4, 4.5
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES_DIR = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '../../templates');
const SRC_DIR = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '../../src');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Generator stage integration (Requirements 4.1, 4.2, 4.4, 4.5)', () => {

    describe('do/stage template exists and is correctly structured', () => {

        it('templates/do/stage exists and is a file', () => {
            const stagePath = path.join(TEMPLATES_DIR, 'do/stage');
            assert.ok(fs.existsSync(stagePath), `Expected ${stagePath} to exist`);
            const stat = fs.statSync(stagePath);
            assert.ok(stat.isFile(), 'do/stage should be a file');
        });

        it('templates/do/stage first line is #!/bin/bash (shebang)', () => {
            const stagePath = path.join(TEMPLATES_DIR, 'do/stage');
            const content = fs.readFileSync(stagePath, 'utf8');
            const firstLine = content.split('\n')[0];
            assert.equal(firstLine, '#!/bin/bash', 'First line must be the bash shebang');
        });

        it('templates/do/stage sources do/config', () => {
            const stagePath = path.join(TEMPLATES_DIR, 'do/stage');
            const content = fs.readFileSync(stagePath, 'utf8');
            assert.ok(
                content.includes('source "${SCRIPT_DIR}/config"'),
                'do/stage must source do/config via ${SCRIPT_DIR}/config'
            );
        });

        it('templates/do/stage sources do/lib/profile.sh', () => {
            const stagePath = path.join(TEMPLATES_DIR, 'do/stage');
            const content = fs.readFileSync(stagePath, 'utf8');
            assert.ok(
                content.includes('source "${SCRIPT_DIR}/lib/profile.sh"'),
                'do/stage must source do/lib/profile.sh'
            );
        });

        it('templates/do/stage sources do/lib/staged-assets.sh', () => {
            const stagePath = path.join(TEMPLATES_DIR, 'do/stage');
            const content = fs.readFileSync(stagePath, 'utf8');
            assert.ok(
                content.includes('source "${SCRIPT_DIR}/lib/staged-assets.sh"'),
                'do/stage must source do/lib/staged-assets.sh'
            );
        });

        it('templates/do/stage is server-agnostic (no model server conditionals)', () => {
            const stagePath = path.join(TEMPLATES_DIR, 'do/stage');
            const content = fs.readFileSync(stagePath, 'utf8');
            assert.ok(
                !content.includes('<% if (modelServer'),
                'do/stage must not contain model server conditionals — it should work for all servers'
            );
        });
    });

    describe('do/lib/staged-assets.sh template exists and provides required functions', () => {

        it('templates/do/lib/staged-assets.sh exists', () => {
            const libPath = path.join(TEMPLATES_DIR, 'do/lib/staged-assets.sh');
            assert.ok(fs.existsSync(libPath), `Expected ${libPath} to exist`);
        });

        it('templates/do/lib/staged-assets.sh contains staged_assets_read_model_uri', () => {
            const libPath = path.join(TEMPLATES_DIR, 'do/lib/staged-assets.sh');
            const content = fs.readFileSync(libPath, 'utf8');
            assert.ok(
                content.includes('staged_assets_read_model_uri'),
                'staged-assets.sh must define staged_assets_read_model_uri function'
            );
        });

        it('templates/do/lib/staged-assets.sh contains staged_assets_write_model', () => {
            const libPath = path.join(TEMPLATES_DIR, 'do/lib/staged-assets.sh');
            const content = fs.readFileSync(libPath, 'utf8');
            assert.ok(
                content.includes('staged_assets_write_model'),
                'staged-assets.sh must define staged_assets_write_model function'
            );
        });
    });

    describe('Generator (src/app.js) adds .mlcc/ to .gitignore', () => {

        it('src/app.js contains .mlcc/ reference for gitignore integration', () => {
            const appPath = path.join(SRC_DIR, 'app.js');
            const content = fs.readFileSync(appPath, 'utf8');
            assert.ok(
                content.includes('.mlcc/'),
                'src/app.js must reference .mlcc/ for gitignore integration'
            );
        });
    });

    describe('do/README.md documents the stage lifecycle', () => {

        it('templates/do/README.md contains stage documentation', () => {
            const readmePath = path.join(TEMPLATES_DIR, 'do/README.md');
            assert.ok(fs.existsSync(readmePath), `Expected ${readmePath} to exist`);
            const content = fs.readFileSync(readmePath, 'utf8');
            assert.ok(
                content.includes('stage'),
                'do/README.md must document the stage lifecycle step'
            );
        });
    });
});
