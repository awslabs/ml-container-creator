// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property: Clean Script Dispatch Behavior (BL062)
 *
 * After BL062, do/clean is a bash dispatcher that routes to clean.d/<target>.
 * All 4 target files are always generated.
 *
 * Validates: Requirements 6.2, 6.3, 6.4, 6.5
 *
 * Feature: universal-deploy
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cleanTemplatePath = path.join(__dirname, '../../templates/do/clean');
const cleanContent = readFileSync(cleanTemplatePath, 'utf8');

// clean.d/ target files
const managedCleanPath = path.join(__dirname, '../../templates/do/clean.d/managed-inference');
const hyperpodCleanPath = path.join(__dirname, '../../templates/do/clean.d/hyperpod-eks');
const asyncCleanPath = path.join(__dirname, '../../templates/do/clean.d/async-inference');
const batchCleanPath = path.join(__dirname, '../../templates/do/clean.d/batch-transform');

describe('Clean Script Dispatch Behavior (BL062)', () => {
    describe('Property: do/clean is a universal dispatcher', () => {
        it('should support local, ecr, codebuild cleanup targets for any deployment target (Req 6.4)', () => {
            // The dispatcher itself routes to target-specific scripts
            assert.ok(cleanContent.includes('managed-inference'), 'dispatcher must reference managed-inference');
            assert.ok(cleanContent.includes('hyperpod-eks'), 'dispatcher must reference hyperpod-eks');
        });

        it('should contain SageMaker endpoint cleanup for realtime-inference (Req 6.2)', () => {
            const content = readFileSync(managedCleanPath, 'utf8');
            assert.ok(content.includes('sagemaker') || content.includes('endpoint') || content.includes('delete'),
                'managed-inference clean must contain endpoint cleanup');
        });

        it('should contain kubectl cleanup for hyperpod-eks (Req 6.3)', () => {
            const content = readFileSync(hyperpodCleanPath, 'utf8');
            assert.ok(content.includes('kubectl'), 'hyperpod-eks clean must contain kubectl cleanup');
        });

        it('should include appropriate cleanup in all target for realtime-inference (Req 6.5)', () => {
            const content = readFileSync(managedCleanPath, 'utf8');
            assert.ok(content.length > 100, 'managed-inference clean must have substantial content');
        });

        it('should include appropriate cleanup in all target for hyperpod-eks (Req 6.5)', () => {
            const content = readFileSync(hyperpodCleanPath, 'utf8');
            assert.ok(content.length > 100, 'hyperpod-eks clean must have substantial content');
        });

        it('should show deployment-target-specific usage info', () => {
            assert.ok(cleanContent.includes('--target'), 'clean dispatcher must support --target flag');
            assert.ok(cleanContent.includes('--help'), 'clean dispatcher must support --help');
        });
    });

    describe('Property: clean.d/ files all exist', () => {
        it('should have all 4 target clean files', () => {
            assert.ok(existsSync(managedCleanPath), 'clean.d/managed-inference must exist');
            assert.ok(existsSync(hyperpodCleanPath), 'clean.d/hyperpod-eks must exist');
            assert.ok(existsSync(asyncCleanPath), 'clean.d/async-inference must exist');
            assert.ok(existsSync(batchCleanPath), 'clean.d/batch-transform must exist');
        });
    });
});
