// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Namespace Metadata Unit Tests
 *
 * Verifies concrete acceptance criteria for the npm namespace rename:
 * - Root package.json name and private field
 * - CI workflow generator invocation and validation step
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('Namespace Metadata', () => {
    describe('Root package.json', () => {
        const rootPkg = JSON.parse(
            readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')
        );

        it('has name @aws/ml-container-creator (Req 1.1)', () => {
            assert.strictEqual(rootPkg.name, '@aws/ml-container-creator');
        });

        it('does not have "private": true (Req 1.2)', () => {
            assert.notStrictEqual(rootPkg.private, true,
                'Root package.json must not have "private": true');
        });
    });

    describe('CI workflow (.github/workflows/ci.yml)', () => {
        const ciYaml = readFileSync(
            resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8'
        );

        it('contains ml-container-creator invocation (Req 7.1, 7.2)', () => {
            assert.ok(
                ciYaml.includes('ml-container-creator'),
                'CI workflow must reference ml-container-creator'
            );
        });

        it('contains node scripts/validate-namespaces.js step (Req 8.7, 9.5)', () => {
            assert.ok(
                ciYaml.includes('node scripts/validate-namespaces.js'),
                'CI workflow must include the namespace validation step'
            );
        });
    });
});
