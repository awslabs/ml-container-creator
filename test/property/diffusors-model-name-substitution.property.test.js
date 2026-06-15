// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Diffusors Model Name Substitution Property-Based Tests
 *
 * Property 6: Model Name Substitution in Serve Command
 * Validates: Requirement 10.3
 *
 * Verifies that the diffusors Dockerfile template correctly substitutes
 * the modelName template variable into the VLLM_MODEL environment variable.
 *
 * Feature: vllm-omni-diffusors
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Path to the diffusors Dockerfile template.
 */
const DOCKERFILE_TEMPLATE_PATH = path.resolve(
    __dirname,
    '../../templates/diffusors/Dockerfile'
);

/**
 * Raw Dockerfile template content, loaded once.
 */
let dockerfileTemplate;

/**
 * Generates a valid HuggingFace model name in org/model-name format.
 * Org: starts with a letter, followed by lowercase alphanumeric and hyphens (1-39 chars).
 * Model: starts with a letter, followed by alphanumeric, hyphens, underscores, dots (1-60 chars).
 */
const hfModelNameArb = fc.tuple(
    // org segment: starts with a letter, then lowercase alphanumeric/hyphens
    fc.stringMatching(/^[a-z][a-z0-9-]{0,38}$/),
    // model segment: starts with a letter, then alphanumeric/hyphens/underscores/dots
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,59}$/)
).map(([org, model]) => `${org}/${model}`);

/**
 * Renders the Dockerfile template by substituting EJS-style `<%= varName %>`
 * placeholders with the provided template variables.
 *
 * This is a minimal EJS renderer sufficient for verifying variable substitution
 * without pulling in the full EJS library. It handles:
 * - `<%= varName %>` output tags (replaced with value)
 * - `<% ... %>` control tags (stripped)
 *
 * @param {string} template - Raw EJS template string
 * @param {Object} vars - Template variables
 * @returns {string} Rendered template
 */
function renderTemplate(template, vars) {
    // Replace output tags: <%= varName %>
    let rendered = template.replace(/<%=\s*([^%]+?)\s*%>/g, (_match, expr) => {
        const trimmed = expr.trim();
        // Handle simple property access like "modelName", "projectName"
        // and dot-notation like "comments.acceleratorInfo"
        const parts = trimmed.split('.');
        let value = vars;
        for (const part of parts) {
            if (value === null || value === undefined) return '';
            value = value[part];
        }
        return value !== null && value !== undefined ? String(value) : '';
    });

    // Strip control flow tags: <% ... %>
    rendered = rendered.replace(/<%[\s\S]*?%>/g, '');

    return rendered;
}

// ── Property 6: Model Name Substitution in Serve Command ────────────────────

describe('Diffusors Model Name Substitution Property-Based Tests', () => {

    before(() => {
        console.log('\n🚀 Starting Diffusors Model Name Substitution Property Tests');
        console.log('📋 Testing: Model name substitution in Dockerfile template');
        console.log(`🔧 Configuration: ${PROPERTY_CONFIG.numRuns} iterations per property\n`);

        // Load the template once
        dockerfileTemplate = fs.readFileSync(DOCKERFILE_TEMPLATE_PATH, 'utf-8');
    });

    /**
     * Property 6: Model Name Substitution in Serve Command
     *
     * **Validates: Requirement 10.3**
     *
     * For any valid HuggingFace model name (org/model-name format),
     * the rendered Dockerfile must contain ENV VLLM_MODEL="<modelName>"
     * with the exact model name substituted.
     */
    describe('Property 6: Model Name Substitution in Serve Command', () => {

        it('the Dockerfile template file exists and contains the modelName placeholder', () => {
            assert.ok(
                fs.existsSync(DOCKERFILE_TEMPLATE_PATH),
                `Dockerfile template not found at ${DOCKERFILE_TEMPLATE_PATH}`
            );
            assert.ok(
                dockerfileTemplate.includes('<%= modelName %>'),
                'Dockerfile template must contain <%= modelName %> placeholder'
            );
            assert.ok(
                dockerfileTemplate.includes('VLLM_MODEL'),
                'Dockerfile template must reference VLLM_MODEL environment variable'
            );
        });

        it('any valid HuggingFace model name is correctly substituted into VLLM_MODEL', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                hfModelNameArb,
                (modelName) => {
                    const rendered = renderTemplate(dockerfileTemplate, {
                        modelName,
                        projectName: 'test-project',
                        buildTimestamp: '20250101-000000',
                        hfToken: null,
                        comments: null,
                        orderedEnvVars: []
                    });

                    // The rendered Dockerfile must contain the exact VLLM_MODEL assignment
                    const expectedEnvLine = `ENV VLLM_MODEL="${modelName}"`;
                    assert.ok(
                        rendered.includes(expectedEnvLine),
                        `Rendered Dockerfile must contain '${expectedEnvLine}', but it was not found.\n` +
                        `Model name: '${modelName}'`
                    );

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('model names with special characters (dots, underscores, hyphens) are preserved exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            // Generate model names that specifically include dots, underscores, and hyphens
            const specialCharModelArb = fc.tuple(
                fc.constantFrom(
                    'stabilityai', 'black-forest-labs', 'runwayml', 'CompVis',
                    'meta-llama', 'org_with.dots'
                ),
                fc.constantFrom(
                    'stable-diffusion-3.5-medium', 'FLUX.1-dev', 'sd_xl_base_1.0',
                    'model-v2.1_fp16', 'DiT-XL-2-256'
                )
            ).map(([org, model]) => `${org}/${model}`);

            fc.assert(fc.property(
                specialCharModelArb,
                (modelName) => {
                    const rendered = renderTemplate(dockerfileTemplate, {
                        modelName,
                        projectName: 'test-project',
                        buildTimestamp: '20250101-000000',
                        hfToken: null,
                        comments: null,
                        orderedEnvVars: []
                    });

                    const expectedEnvLine = `ENV VLLM_MODEL="${modelName}"`;
                    assert.ok(
                        rendered.includes(expectedEnvLine),
                        `Special-char model name '${modelName}' must be preserved exactly in VLLM_MODEL`
                    );

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('model name appears exactly once in the VLLM_MODEL assignment', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                hfModelNameArb,
                (modelName) => {
                    const rendered = renderTemplate(dockerfileTemplate, {
                        modelName,
                        projectName: 'test-project',
                        buildTimestamp: '20250101-000000',
                        hfToken: null,
                        comments: null,
                        orderedEnvVars: []
                    });

                    // Count occurrences of the VLLM_MODEL env line
                    const envPattern = `ENV VLLM_MODEL="${modelName}"`;
                    const occurrences = rendered.split(envPattern).length - 1;

                    assert.strictEqual(
                        occurrences,
                        1,
                        `Expected exactly 1 occurrence of '${envPattern}', found ${occurrences}`
                    );

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});
