// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Subcommand Property-Based Tests
 *
 * Property 17: Unknown subcommand handling
 *
 * Feature: deployment-registry
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import RegistryCommandHandler from '../../src/lib/registry-command-handler.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_SUBCOMMANDS = ['list', 'get', 'remove', 'replay', 'export', 'import', 'search', 'log'];

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random string that is NOT one of the valid registry subcommands.
 * Includes alphanumeric strings, strings with special characters, and empty-ish strings.
 */
const arbUnknownSubcommand = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => {
        const trimmed = s.trim();
        return trimmed.length > 0 && !VALID_SUBCOMMANDS.includes(trimmed.toLowerCase());
    });

// ── Property 17: Unknown subcommand handling ─────────────────────────────────

describe('Feature: deployment-registry, Property 17: Unknown subcommand handling', () => {

    let originalLog;
    let logOutput;

    beforeEach(() => {
        originalLog = console.log;
        logOutput = [];
        console.log = (...args) => {
            logOutput.push(args.join(' '));
        };
    });

    afterEach(() => {
        console.log = originalLog;
    });

    /**
     * Validates: Requirements 1.3
     *
     * For any string that is not one of the valid registry subcommands
     * (list, get, remove, replay, export, import, search, log), the
     * Registry_Command_Handler should display an error and help text
     * without throwing an unhandled exception.
     */
    it('unknown subcommands display error and help text without throwing', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        const handler = new RegistryCommandHandler();

        fc.assert(fc.property(
            arbUnknownSubcommand,
            (unknownCmd) => {
                logOutput = [];

                // Should not throw
                handler.handle([unknownCmd], {});

                const combined = logOutput.join('\n');

                // Should display an error message mentioning the unknown subcommand
                const hasError = combined.includes('Unknown registry subcommand');
                assert.ok(
                    hasError,
                    `Expected error message for unknown subcommand "${unknownCmd}", got: ${combined.slice(0, 200)}`
                );

                // Should display help text (usage info with subcommand names)
                const hasHelp = combined.includes('USAGE') || combined.includes('SUBCOMMANDS');
                assert.ok(
                    hasHelp,
                    `Expected help text for unknown subcommand "${unknownCmd}", got: ${combined.slice(0, 200)}`
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
