// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test for the local ESLint rule `require-module-header`.
 *
 * PATTERN: RuleTester spec for a custom ESLint rule.
 * COLLABORATORS: exercises eslint-rules/require-module-header.cjs via ESLint's
 *   RuleTester; run by mocha under test/unit.
 * DATA-FLOW ROLE: test-only. Feeds valid/invalid source strings to the rule and
 *   asserts the reported messageIds.
 * See: docs/architecture/module-header-convention.md
 */

import { createRequire } from 'node:module';
import { RuleTester } from 'eslint';
import { describe, it } from 'mocha';

const require = createRequire(import.meta.url);
const rule = require('../../eslint-rules/require-module-header.cjs');

const ruleTester = new RuleTester({
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
});

const CONFORMING_HEADER = `
/**
 * Example module.
 *
 * PATTERN: Factory for widgets.
 * COLLABORATORS: called by src/app.js; reads config/foo.json.
 * DATA-FLOW ROLE: consumes a name, produces a widget.
 * See: docs/adr/ADR-002-consolidation-program.md
 */
export const x = 1;
`;

describe('eslint rule: require-module-header', () => {
    it('accepts a conforming header and flags missing/absent fields', () => {
        ruleTester.run('require-module-header', rule, {
            valid: [
                // Full header with all four labels.
                { code: CONFORMING_HEADER },
                // "DATA-FLOW:" (without "ROLE") is also accepted.
                {
                    code: `
/**
 * PATTERN: Strategy.
 * COLLABORATORS: registry.js.
 * DATA-FLOW: in -> out.
 * See: docs/architecture/system-overview.md
 */
export default {};
`
                }
            ],
            invalid: [
                // No leading comment at all.
                {
                    code: 'export const y = 2;\n',
                    errors: [{ messageId: 'noHeader' }]
                },
                // Header present but missing COLLABORATORS and See:.
                {
                    code: `
/**
 * PATTERN: Factory.
 * DATA-FLOW ROLE: in -> out.
 */
export const z = 3;
`,
                    errors: [
                        { messageId: 'missingHeader' },
                        { messageId: 'missingHeader' }
                    ]
                },
                // See: present but not pointing at an ADR/architecture doc.
                {
                    code: `
/**
 * PATTERN: Factory.
 * COLLABORATORS: a.js.
 * DATA-FLOW ROLE: in -> out.
 * See: some random note
 */
export const w = 4;
`,
                    errors: [{ messageId: 'missingHeader' }]
                }
            ]
        });
    });
});
