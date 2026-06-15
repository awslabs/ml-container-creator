/**
 * ESLint rule: no-hardcoded-numruns
 *
 * Disallows hardcoded numeric literals for `numRuns` in property test files.
 * Tests must use the shared constant from ../helpers/property-config.js.
 *
 * Allowed patterns:
 *   numRuns: NUM_RUNS
 *   numRuns: PROPERTY_CONFIG.numRuns
 *   numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10)
 *
 * Disallowed patterns:
 *   numRuns: 100
 *   numRuns: 200
 */
'use strict';

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow hardcoded numRuns values in property tests',
            category: 'Best Practices'
        },
        messages: {
            hardcodedNumRuns: 'Do not hardcode numRuns. Import NUM_RUNS from ../helpers/property-config.js and use numRuns: NUM_RUNS'
        },
        schema: []
    },
    create(context) {
        return {
            Property(node) {
                // Match property key "numRuns" (identifier or string literal)
                const keyName = node.key.type === 'Identifier'
                    ? node.key.name
                    : (node.key.type === 'Literal' ? node.key.value : null);

                if (keyName !== 'numRuns') {
                    return;
                }

                // Flag numeric literals (e.g., numRuns: 100)
                if (node.value.type === 'Literal' && typeof node.value.value === 'number') {
                    context.report({ node: node.value, messageId: 'hardcodedNumRuns' });
                }
            }
        };
    }
};
