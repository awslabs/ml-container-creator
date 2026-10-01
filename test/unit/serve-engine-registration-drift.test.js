// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * serve.d engine ↔ registration-surface conformance (ADR-004 / ADR-006/007/008).
 *
 * WHY THIS EXISTS
 * ---------------
 * A serve-engine plugin's existence (`templates/code/serve.d/<engine>/manifest.json`)
 * is the single source of truth, but to actually reach a user the engine must be
 * registered in several HAND-MAINTAINED surfaces that are NOT derived from the
 * serve.d directory:
 *   1. the `deploymentConfig` enum in `config/parameter-schema-v2.json`
 *      (what `--deployment-config` accepts),
 *   2. `CANONICAL_CONFIGS` in `src/lib/deployment-config-resolver.js`
 *      (which decomposes that config back to the engine name), and
 *   3. the `get_engine_prefix()` shell `case` in `templates/do/register`
 *      (which captures the engine's env vars at deploy time — this runs in the
 *      generated project, which ships only the manifest, not the Node reader,
 *      so it CANNOT read `env_var_prefix` and must duplicate it).
 *
 * Nothing today fails if a new serve.d engine is added but one of these is
 * forgotten: `validate-serve-manifests` and the bl105 parity test only look at
 * the manifests. So the engine would validate, parity-pass, and still be
 * unselectable (missing enum), undecomposable (missing CANONICAL_CONFIGS), or
 * silently record no parameters at deploy time (missing prefix arm → `*)` → "").
 * That is the ADR-006/007/008 silent-drift class. This test makes each gap LOUD.
 *
 * THE INVARIANTS (behavioral, derived — not frozen snapshots)
 * -----------------------------------------------------------
 * For every engine discovered under `serve.d/` (via `listServeEngines`):
 *   A. SOME deploymentConfig enum value decomposes (via the resolver) to a
 *      backend equal to the engine's serve.d directory name.
 *   B. That same config is in CANONICAL_CONFIGS (implied by A, since the resolver
 *      decomposes from CANONICAL_CONFIGS) — asserted explicitly for a clear error.
 *   C. `get_engine_prefix()` in templates/do/register maps the engine to EXACTLY
 *      its manifest `env_var_prefix`.
 * A non-vacuous guard asserts at least one engine was discovered, so the suite
 * cannot silently degrade into asserting nothing.
 */

import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listServeEngines, readEnvVarPrefix } from '../../src/lib/serve-manifest-reader.js';
import DeploymentConfigResolver from '../../src/lib/deployment-config-resolver.js';
import TemplateManager from '../../src/lib/template-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SCHEMA_PATH = resolve(ROOT, 'config', 'parameter-schema-v2.json');
const REGISTER_PATH = resolve(ROOT, 'templates', 'do', 'register');

// Parse the deploymentConfig enum from the parameter schema (the CLI source of truth).
function deploymentConfigEnum() {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const dc = schema.parameters && schema.parameters.deploymentConfig;
    const en = dc && dc.validation && dc.validation.enum;
    assert.ok(Array.isArray(en) && en.length > 0, 'deploymentConfig enum must exist and be non-empty');
    return en;
}

// Parse the get_engine_prefix() shell case map from templates/do/register into
// { engine: prefix } by scanning its `<name>) echo "PREFIX" ;;` arms. We read the
// template text (it is EJS-wrapped shell, but get_engine_prefix is plain shell).
function shellEnginePrefixMap() {
    const text = readFileSync(REGISTER_PATH, 'utf8');
    const fnStart = text.indexOf('get_engine_prefix()');
    assert.ok(fnStart !== -1, 'templates/do/register must define get_engine_prefix()');
    // Bound the scan to the function body (up to the closing `}` of the case/fn).
    const esacIdx = text.indexOf('esac', fnStart);
    assert.ok(esacIdx !== -1, 'get_engine_prefix() must contain a case/esac');
    const body = text.slice(fnStart, esacIdx);

    const map = {};
    // Match arms like:  vllm-omni)    echo "VLLM_OMNI_" ;;
    // Allow multiple patterns per arm (e.g. `a|b)`), splitting on `|`.
    const armRe = /^\s*([a-z0-9|_-]+)\)\s*echo\s*"([^"]*)"\s*;;/gim;
    let m;
    while ((m = armRe.exec(body)) !== null) {
        const patterns = m[1].split('|').map((s) => s.trim());
        const prefix = m[2];
        for (const p of patterns) {
            if (p === '*') continue; // the default arm
            map[p] = prefix;
        }
    }
    return map;
}

describe('serve.d engine ↔ registration surfaces conformance', () => {
    let engines;
    let enumValues;
    let resolver;
    let shellMap;

    before(() => {
        engines = listServeEngines();
        enumValues = deploymentConfigEnum();
        resolver = new DeploymentConfigResolver();
        shellMap = shellEnginePrefixMap();
    });

    it('discovers at least one serve.d engine (guards against a vacuous suite)', () => {
        assert.ok(engines.length > 0, 'expected at least one serve.d/<engine>/manifest.json');
    });

    it('every serve.d engine is selectable via some deploymentConfig enum value', () => {
        for (const engine of engines) {
            // Find an enum value that decomposes to this engine's backend.
            const match = enumValues.find((dc) => {
                try {
                    return resolver.decompose(dc).backend === engine;
                } catch {
                    return false;
                }
            });
            assert.ok(
                match,
                `serve.d engine "${engine}" has no deploymentConfig enum value that decomposes to backend "${engine}". ` +
                `Add e.g. "transformers-${engine}" to config/parameter-schema-v2.json deploymentConfig.enum (and run codegen).`
            );
        }
    });

    it('every serve.d engine decomposes from CANONICAL_CONFIGS to its own name', () => {
        for (const engine of engines) {
            const configs = resolver.getAllConfigs();
            const match = configs.find((dc) => resolver.decompose(dc).backend === engine);
            assert.ok(
                match,
                `serve.d engine "${engine}" is absent from CANONICAL_CONFIGS in ` +
                'src/lib/deployment-config-resolver.js. Add its deployment-config entry.'
            );
        }
    });

    it('TemplateManager.validate() accepts every serve.d engine deployment-config', () => {
        // template-manager.js keeps its OWN hardcoded deploymentConfigs allow-list
        // (src/lib/template-manager.js validate()). A serve.d engine missing from it
        // passes the manifest validator and the resolver but fails at generation with
        // "not implemented yet for deploymentConfig" — a seam only an end-to-end
        // generate catches. This asserts that allow-list agrees with serve.d.
        for (const engine of engines) {
            const dc = enumValues.find((c) => {
                try {
                    return resolver.decompose(c).backend === engine;
                } catch {
                    return false;
                }
            });
            if (!dc) continue; // covered by the enum test above
            const tm = new TemplateManager({
                deploymentConfig: dc,
                // a GPU instance so a GPU-requiring engine does not throw for a
                // different reason; we only care about the deploymentConfig check.
                instanceType: 'ml.g5.xlarge'
            });
            try {
                tm.validate();
            } catch (err) {
                assert.ok(
                    !/not implemented yet for deploymentConfig/.test(err.message),
                    `TemplateManager.validate() rejects "${dc}" as unimplemented — add it to the ` +
                    'deploymentConfigs allow-list in src/lib/template-manager.js validate().'
                );
                // Any OTHER validation error (missing fields, etc.) is irrelevant here.
            }
        }
    });

    it('get_engine_prefix() in templates/do/register matches each engine manifest env_var_prefix', () => {
        for (const engine of engines) {
            const manifestPrefix = readEnvVarPrefix(engine);
            assert.ok(
                manifestPrefix,
                `serve.d engine "${engine}" manifest has no env_var_prefix (schema requires it)`
            );
            const shellPrefix = shellMap[engine];
            assert.ok(
                shellPrefix !== undefined,
                `serve.d engine "${engine}" has no arm in get_engine_prefix() (templates/do/register). ` +
                `Add: ${engine}) echo "${manifestPrefix}" ;;  — without it, do/register records no parameters for the engine.`
            );
            assert.strictEqual(
                shellPrefix,
                manifestPrefix,
                `get_engine_prefix() maps "${engine}" to "${shellPrefix}" but its manifest env_var_prefix is "${manifestPrefix}". ` +
                'These must agree or deploy-time parameter capture drifts from the real container vars.'
            );
        }
    });
});
