// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared fast-check arbitraries for MLCC property tests.
 *
 * PATTERN: Single-source-of-truth test generators. Domain value lists
 *   (deploymentConfig, deploymentTarget, framework, modelServer, modelFormat)
 *   are derived at import time from `config/parameter-schema-v2.json` — the same
 *   schema that drives the CLI and codegen — so property tests track the schema
 *   automatically instead of re-declaring enum literals inline.
 * COLLABORATORS: imported by test/property/**.property.test.js (replacing
 *   per-file `fc.constantFrom(...)` blocks); pairs with
 *   test/helpers/property-config.js (run counts/timeouts). Reads the schema via
 *   config/parameter-schema-v2.json.
 * DATA-FLOW ROLE: test-only. Produces fast-check Arbitrary instances and the
 *   raw value arrays behind them, consumed by property test generators.
 * See: docs/dev/test-inventory.md (R1), docs/architecture/module-header-convention.md
 *
 * Usage — full domain:
 *   import { arb } from '../helpers/arbitraries.js';
 *   fc.record({ deploymentTarget: arb.deploymentTarget() });
 *
 * Usage — intentional subset (preserve a test's narrower domain):
 *   import { arb, VALUES, subset } from '../helpers/arbitraries.js';
 *   fc.record({ deploymentTarget: subset(VALUES.deploymentTarget, ['realtime-inference', 'async-inference']) });
 *   // or simply: fc.constantFrom('realtime-inference', 'async-inference')
 *
 * The `VALUES` object exposes the canonical arrays so a test can slice/filter
 * them (e.g. exclude batch-transform) while still failing loudly if a value it
 * names is no longer in the schema (see `subset`).
 */

import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../../config/parameter-schema-v2.json');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

/**
 * Read a parameter's validation.enum from the schema, throwing if absent so a
 * schema change that removes an enum surfaces here rather than silently
 * degrading the arbitrary to `undefined`.
 * @param {string} param
 * @returns {string[]}
 */
function schemaEnum(param) {
    const p = schema.parameters?.[param];
    const values = p?.validation?.enum;
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error(
            `arbitraries.js: parameter "${param}" has no validation.enum in ` +
            'parameter-schema-v2.json. Update this helper if the schema shape changed.'
        );
    }
    return [...values];
}

/**
 * Canonical value arrays. Schema-backed lists come straight from the schema.
 * `architecture` and `awsRegion` are NOT bounded enums in the schema
 * (architecture is derived from deploymentConfig; awsRegion is MCP/unbounded),
 * so their canonical test lists are defined here explicitly and documented as
 * the test-domain source of truth for those two fields.
 */
export const VALUES = Object.freeze({
    // Schema-derived (single source of truth = parameter-schema-v2.json)
    deploymentConfig: schemaEnum('deploymentConfig'),
    deploymentTarget: schemaEnum('deploymentTarget'),
    framework: schemaEnum('framework'),
    modelServer: schemaEnum('modelServer'),
    modelFormat: schemaEnum('modelFormat'),

    // Test-domain lists for fields with no bounded schema enum.
    // architecture is the prefix of deploymentConfig; keep in sync with the
    // architecture routing switch in src/app.js writeProject().
    architecture: ['http', 'transformers', 'triton', 'diffusors'],
    // A representative, stable region sample for tests that need a region value.
    awsRegion: ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1']
});

/**
 * Build a `fc.constantFrom` from an explicit subset of a canonical array,
 * asserting every requested value is actually in the canonical list. This lets
 * a test narrow the domain (e.g. exclude batch-transform) while still failing
 * loudly if it names a value the schema no longer contains.
 * @param {string[]} canonical - one of the VALUES arrays
 * @param {string[]} wanted - the subset to draw from
 * @returns {import('fast-check').Arbitrary<string>}
 */
export function subset(canonical, wanted) {
    const missing = wanted.filter(v => !canonical.includes(v));
    if (missing.length > 0) {
        throw new Error(
            `arbitraries.js subset(): value(s) not in canonical list: ${missing.join(', ')}. ` +
            'The schema/test-domain list may have changed.'
        );
    }
    return fc.constantFrom(...wanted);
}

/**
 * Full-domain arbitraries. Each returns a fresh Arbitrary over the entire
 * canonical value list for that field.
 */
export const arb = Object.freeze({
    deploymentConfig: () => fc.constantFrom(...VALUES.deploymentConfig),
    deploymentTarget: () => fc.constantFrom(...VALUES.deploymentTarget),
    framework: () => fc.constantFrom(...VALUES.framework),
    modelServer: () => fc.constantFrom(...VALUES.modelServer),
    modelFormat: () => fc.constantFrom(...VALUES.modelFormat),
    architecture: () => fc.constantFrom(...VALUES.architecture),
    awsRegion: () => fc.constantFrom(...VALUES.awsRegion)
});

/**
 * Convenience derived slices for common test domains. These are still backed by
 * the schema `framework` enum, so they fail loudly (via schemaEnum) if the
 * schema changes.
 *
 * NOTE ON "modelServer" vs serve.d ENGINES: the schema `modelServer` enum
 * (VALUES.modelServer = flask/fastapi/vllm/sglang) is the CLI parameter's value
 * space. Several tests use a BROADER, different list of *serve.d engine names*
 * (e.g. vllm/sglang/tensorrt-llm/lmi/djl) for base-image routing or engine
 * plumbing — that is NOT the same concept and must NOT be replaced with
 * VALUES.modelServer. Keep such engine lists local to the test (or source them
 * from serve.d manifests once Wave 3 lands), and use VALUES.modelServer only
 * where the schema parameter is meant.
 */
export const NON_TRANSFORMER_FRAMEWORKS = Object.freeze(
    VALUES.framework.filter(f => f !== 'transformers'));

