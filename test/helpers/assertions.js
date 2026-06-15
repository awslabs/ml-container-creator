import { strict as assert } from 'node:assert';

/**
 * Assert content is valid-ish bash (non-empty string).
 * Checks that the content is a non-empty string, which is the minimum
 * requirement for bash script content.
 * @param {string} content - The bash script content to validate
 * @throws {AssertionError} If content is empty or not a string
 */
export function assertValidBash(content) {
    assert.equal(typeof content, 'string', 'Content must be a string');
    assert.ok(content.trim().length > 0, 'Content must not be empty');
}

/**
 * Assert content has no unresolved EJS tags.
 * Checks for leftover <% or %> sequences that indicate incomplete rendering.
 * @param {string} content - The rendered content to check
 * @throws {AssertionError} If unresolved EJS tags are found
 */
export function assertNoEjsTags(content) {
    assert.ok(!content.includes('<%'), `Found unresolved EJS opening tag in: ${content.substring(0, 100)}...`);
    assert.ok(!content.includes('%>'), `Found unresolved EJS closing tag in: ${content.substring(0, 100)}...`);
}

/**
 * Assert content has no undefined/null string representations.
 * Checks for "undefined" or "null" literals that indicate missing template variables.
 * @param {string} content - The rendered content to check
 * @throws {AssertionError} If undefined or null string representations are found
 */
export function assertNoUndefined(content) {
    assert.ok(!content.includes('undefined'), `Found "undefined" in content: ${content.substring(0, 100)}...`);
    assert.ok(!content.includes('null'), `Found "null" in content: ${content.substring(0, 100)}...`);
}

/**
 * Assert a bash export line exists with a non-empty value.
 * Looks for a pattern like: export VAR_NAME="value" or export VAR_NAME=value
 * @param {string} content - The bash script content
 * @param {string} varName - The variable name to look for in export statements
 * @throws {AssertionError} If the export line is not found or has an empty value
 */
export function assertExportExists(content, varName) {
    const pattern = new RegExp(`export\\s+${varName}=.+`);
    assert.ok(pattern.test(content), `Expected export ${varName}=<value> in content`);
}
