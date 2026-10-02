// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BaseCommandHandler and the command-handler contract.
 *
 * PATTERN: Spec for the command-handler base class + contract.
 * COLLABORATORS: exercises src/lib/base-command-handler.js and the three
 *   migrated handlers (import/update/regenerate).
 * DATA-FLOW ROLE: test-only. Asserts the shared contract (extends base, exposes
 *   handle, gets shared paths, fail() conventions).
 * See: docs/adr/ADR-005-command-handler-contract.md
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import BaseCommandHandler, { GENERATOR_ROOT, TEMPLATE_DIR } from '../../src/lib/base-command-handler.js';
import ImportCommandHandler from '../../src/lib/import-command-handler.js';
import UpdateCommandHandler from '../../src/lib/update-command-handler.js';
import RegenerateCommandHandler from '../../src/lib/regenerate-command-handler.js';

describe('BaseCommandHandler contract', () => {
    it('resolves GENERATOR_ROOT + TEMPLATE_DIR to real directories', () => {
        assert.ok(existsSync(GENERATOR_ROOT), 'GENERATOR_ROOT should exist');
        assert.ok(existsSync(TEMPLATE_DIR), 'TEMPLATE_DIR should exist');
        assert.equal(TEMPLATE_DIR, join(GENERATOR_ROOT, 'templates'));
        assert.ok(existsSync(join(GENERATOR_ROOT, 'package.json')),
            'GENERATOR_ROOT should be the package root');
    });

    it('abstract handle() throws with the class name until overridden', async () => {
        const bare = new BaseCommandHandler();
        await assert.rejects(() => bare.handle(), /BaseCommandHandler must implement async handle/);
    });

    describe('fail() convention', () => {
        it('sets process.exitCode when exit:false (soft failure)', () => {
            const prior = process.exitCode;
            try {
                const h = new BaseCommandHandler();
                h.fail('soft error', { exit: false });
                assert.equal(process.exitCode, 1);
            } finally {
                process.exitCode = prior; // restore so we don't taint the runner
            }
        });
    });

    describe('migrated handlers (import, update, regenerate)', () => {
        const handlers = [
            ['ImportCommandHandler', new ImportCommandHandler({})],
            ['UpdateCommandHandler', new UpdateCommandHandler({})],
            ['RegenerateCommandHandler', new RegenerateCommandHandler({})]
        ];

        for (const [name, instance] of handlers) {
            it(`${name} extends BaseCommandHandler`, () => {
                assert.ok(instance instanceof BaseCommandHandler,
                    `${name} must extend BaseCommandHandler`);
            });
            it(`${name} exposes an async handle()`, () => {
                assert.equal(typeof instance.handle, 'function');
            });
            it(`${name} inherits the shared paths`, () => {
                assert.equal(instance.GENERATOR_ROOT, GENERATOR_ROOT);
                assert.equal(instance.TEMPLATE_DIR, TEMPLATE_DIR);
            });
        }
    });
});
