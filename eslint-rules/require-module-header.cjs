/**
 * ESLint rule: require-module-header
 *
 * Enforces the module-header docblock convention (see
 * docs/architecture/module-header-convention.md). A pattern-participating
 * module must carry a leading comment that names the four fields:
 *   PATTERN, COLLABORATORS, DATA-FLOW ROLE (or DATA-FLOW), and a See: reference.
 *
 * The rule inspects only the leading comment block(s) of the file (comments
 * before the first statement), so a mention of these words deep in the code
 * does not satisfy it. It reports one warning per missing label, on line 1.
 *
 * It is intentionally lenient about formatting: it concatenates the leading
 * comments and looks for each label token, so JS block comments, line comments,
 * and JSDoc all work. Scope (which files this applies to) is controlled by the
 * `.eslintrc.cjs` `overrides` glob, not by the rule itself.
 */
'use strict';

const REQUIRED = [
    { id: 'pattern', label: 'PATTERN', test: (t) => /\bPATTERN\b\s*:/i.test(t) },
    { id: 'collaborators', label: 'COLLABORATORS', test: (t) => /\bCOLLABORATORS\b\s*:/i.test(t) },
    {
        id: 'dataflow',
        label: 'DATA-FLOW ROLE',
        // Accept "DATA-FLOW ROLE:" or just "DATA-FLOW:"
        test: (t) => /\bDATA[- ]FLOW(?:\s+ROLE)?\b\s*:/i.test(t)
    },
    {
        id: 'see',
        label: 'See: (ADR or architecture doc)',
        // Require a See: that points at an adr/ or architecture/ doc.
        test: (t) => /\bSee\s*:/i.test(t) && /(adr\/ADR-|architecture\/|\.md)/i.test(t)
    }
];

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description:
                'Require a module-header docblock (PATTERN / COLLABORATORS / DATA-FLOW ROLE / See:) on pattern-participating modules',
            category: 'Best Practices',
            recommended: false
        },
        messages: {
            missingHeader:
                'Module header is missing the "{{label}}" field. See docs/architecture/module-header-convention.md.',
            noHeader:
                'Module is missing its header docblock (PATTERN / COLLABORATORS / DATA-FLOW ROLE / See:). See docs/architecture/module-header-convention.md.'
        },
        schema: []
    },
    create(context) {
        const sourceCode = context.sourceCode || context.getSourceCode();

        return {
            Program(node) {
                // Gather leading comments: all comments that appear before the
                // first program statement (or all comments if the file is empty
                // of statements).
                const allComments = sourceCode.getAllComments();
                const firstStmt = node.body[0];
                const cutoff = firstStmt ? firstStmt.range[0] : Infinity;
                const leading = allComments
                    .filter((c) => c.range[1] <= cutoff)
                    .map((c) => c.value)
                    .join('\n');

                const loc = { line: 1, column: 0 };

                if (!leading.trim()) {
                    context.report({ loc, messageId: 'noHeader' });
                    return;
                }

                for (const field of REQUIRED) {
                    if (!field.test(leading)) {
                        context.report({
                            loc,
                            messageId: 'missingHeader',
                            data: { label: field.label }
                        });
                    }
                }
            }
        };
    }
};
