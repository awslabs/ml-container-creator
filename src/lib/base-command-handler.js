// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BaseCommandHandler — shared base for `mcc <command>` handler classes.
 *
 * PATTERN: Template-Method base class. Captures what every command handler
 *   genuinely shares — the generator-root / template-dir resolution and the
 *   error/exit conventions — while leaving each command's handle() signature to
 *   the subcommand (see ADR-005 for why handle() is intentionally not uniform).
 * COLLABORATORS: subclassed by src/lib/{import,update,regenerate}-command-handler.js
 *   (the handlers that share the GENERATOR_ROOT/TEMPLATE_DIR block); instantiated
 *   and invoked by bin/cli.js. Peers (bootstrap, mcp, prove, secrets,
 *   architecture) may adopt it incrementally.
 * DATA-FLOW ROLE: no data of its own — provides GENERATOR_ROOT/TEMPLATE_DIR
 *   paths and a fail() helper to subclasses whose handle() does the work.
 * See: docs/adr/ADR-005-command-handler-contract.md,
 *   docs/architecture/command-handlers.md
 */

import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';

// All command handlers live in src/lib/, so the generator root is two levels up
// and the templates dir is a sibling of src/. Computed once here instead of
// being copy-pasted into every handler's module header.
const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATOR_ROOT = resolve(__dirname, '..', '..');
const TEMPLATE_DIR = join(GENERATOR_ROOT, 'templates');

export default class BaseCommandHandler {
    constructor() {
        /** Absolute path to the MLCC generator package root. */
        this.GENERATOR_ROOT = GENERATOR_ROOT;
        /** Absolute path to the templates/ directory. */
        this.TEMPLATE_DIR = TEMPLATE_DIR;
    }

    /**
     * Execute the command. Subclasses MUST override this. The signature is
     * intentionally left to the subclass — `mcc import` takes an endpoint ARN,
     * `mcc update`/`regenerate` take no args, others take (args, options) — see
     * ADR-005. Callers (bin/cli.js) construct the handler and call handle(...).
     */
    async handle() {
        throw new Error(
            `${this.constructor.name} must implement async handle(...)`
        );
    }

    /**
     * Standard failure convention: print an error and stop. By default this
     * exits the process (exit code 1), matching the import/update/regenerate
     * handlers whose failures are fatal to the CLI invocation. Pass
     * { exit: false } to set process.exitCode instead of hard-exiting (for
     * handlers that continue doing cleanup after a soft failure).
     *
     * @param {string} message - The user-facing error message (already formatted).
     * @param {object} [opts]
     * @param {boolean} [opts.exit=true] - Hard-exit vs. set exitCode.
     */
    fail(message, { exit = true } = {}) {
        console.error(message);
        if (exit) {
            process.exit(1);
        } else {
            process.exitCode = 1;
        }
    }
}

// Exported for handlers/tests that want the paths without subclassing.
export { GENERATOR_ROOT, TEMPLATE_DIR };
