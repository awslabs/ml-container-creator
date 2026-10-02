// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared do/config parser (src/lib/do-config.js).
 *
 * PATTERN: Spec for the consolidated do/config parser.
 * COLLABORATORS: exercises src/lib/do-config.js (parseDoConfig,
 *   shellVarsToAnswers, SHELL_VAR_TO_ANSWER); writes temp do/config fixtures.
 * DATA-FLOW ROLE: test-only. Feeds do/config text through the parser and
 *   asserts the union of the three prior implementations' behaviors.
 * See: docs/adr/ADR-005-command-handler-contract.md
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    parseDoConfig,
    shellVarsToAnswers,
    SHELL_VAR_TO_ANSWER
} from '../../src/lib/do-config.js';

const tmps = [];
function writeConfig(text) {
    const dir = mkdtempSync(join(tmpdir(), 'mlcc-doconfig-'));
    tmps.push(dir);
    const p = join(dir, 'config');
    writeFileSync(p, text, 'utf8');
    return p;
}

describe('do-config parser', () => {
    afterEach(() => {
        while (tmps.length) rmSync(tmps.pop(), { recursive: true, force: true });
    });

    describe('parseDoConfig', () => {
        it('parses export KEY="value", KEY=\'value\', and bare KEY=value', () => {
            const p = writeConfig([
                'export PROJECT_NAME="my-proj"',
                'export MODEL_NAME=\'meta-llama/Llama-3.1-8B\'',
                'export INSTANCE_TYPE=ml.g5.xlarge',
                '# a comment',
                'not an export line'
            ].join('\n'));
            const cfg = parseDoConfig(p);
            assert.equal(cfg.PROJECT_NAME, 'my-proj');
            assert.equal(cfg.MODEL_NAME, 'meta-llama/Llama-3.1-8B');
            assert.equal(cfg.INSTANCE_TYPE, 'ml.g5.xlarge');
            assert.ok(!('a' in cfg));
        });

        it('returns null when the file does not exist', () => {
            assert.equal(parseDoConfig('/no/such/do/config'), null);
        });

        it('does NOT resolve ${VAR:-default} by default (update/regenerate contract)', () => {
            const p = writeConfig('export INSTANCE_TYPE="${INSTANCE_TYPE:-ml.g6e.12xlarge}"');
            const cfg = parseDoConfig(p);
            assert.equal(cfg.INSTANCE_TYPE, '${INSTANCE_TYPE:-ml.g6e.12xlarge}');
        });

        it('resolves ${VAR:-default} when resolveShellDefaults=true (validate contract)', () => {
            const p = writeConfig('export INSTANCE_TYPE="${INSTANCE_TYPE:-ml.g6e.12xlarge}"');
            const cfg = parseDoConfig(p, { resolveShellDefaults: true });
            assert.equal(cfg.INSTANCE_TYPE, 'ml.g6e.12xlarge');
        });

        it('only captures UPPER_SNAKE export keys', () => {
            const p = writeConfig([
                'export lower_case="x"',
                'export MixedCase="y"',
                'export VALID_KEY="z"'
            ].join('\n'));
            const cfg = parseDoConfig(p);
            assert.deepEqual(Object.keys(cfg), ['VALID_KEY']);
        });
    });

    describe('shellVarsToAnswers', () => {
        it('maps known shell keys to camelCase and drops unknown ones', () => {
            const answers = shellVarsToAnswers({
                INSTANCE_TYPE: 'ml.g5.xlarge',
                MODEL_NAME: 'foo/bar',
                UNKNOWN_KEY: 'ignored'
            });
            assert.equal(answers.instanceType, 'ml.g5.xlarge');
            assert.equal(answers.modelName, 'foo/bar');
            assert.ok(!('UNKNOWN_KEY' in answers));
            assert.equal(Object.keys(answers).length, 2);
        });

        it('includes the regenerate superset keys (GENERATOR_VERSION + per-target status)', () => {
            const answers = shellVarsToAnswers({
                GENERATOR_VERSION: '1.7.2',
                DEPLOYMENT_TARGET_HP_STATUS: 'InService',
                DEPLOYMENT_TARGET_SMAI_STATUS: 'Creating'
            });
            assert.equal(answers.generatorVersion, '1.7.2');
            assert.equal(answers.deploymentTargetHpStatus, 'InService');
            assert.equal(answers.deploymentTargetSmaiStatus, 'Creating');
        });

        it('keeps container_image_uri snake_case (generator answer key)', () => {
            const answers = shellVarsToAnswers({ CONTAINER_IMAGE_URI: 'x.dkr.ecr/y:z' });
            assert.equal(answers.container_image_uri, 'x.dkr.ecr/y:z');
        });

        it('handles null/empty input safely', () => {
            assert.deepEqual(shellVarsToAnswers(null), {});
            assert.deepEqual(shellVarsToAnswers({}), {});
        });
    });

    describe('SHELL_VAR_TO_ANSWER', () => {
        it('is the frozen superset union (contains both update and regenerate keys)', () => {
            // update-era keys
            for (const k of ['PROJECT_NAME', 'INSTANCE_TYPE', 'HF_TOKEN_ARN', 'NGC_TOKEN_ARN']) {
                assert.ok(k in SHELL_VAR_TO_ANSWER, `${k} must be mapped`);
            }
            // regenerate-only superset keys
            for (const k of ['GENERATOR_VERSION', 'DEPLOYMENT_TARGET_BATCH_STATUS']) {
                assert.ok(k in SHELL_VAR_TO_ANSWER, `${k} must be mapped`);
            }
            assert.throws(() => { SHELL_VAR_TO_ANSWER.NEW = 'x'; }, TypeError);
        });
    });
});
