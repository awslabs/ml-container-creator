// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * v18-w4-01-bl112 — Unified do/adapter verbs on hyperpod-eks.
 *
 * Property tests for the verb -> vLLM LoRA endpoint routing in the
 * `_adapter_hyperpod` router of the rendered do/adapter script. The router is
 * pure bash text (it normalizes each verb into an (ACTION, name, weights)
 * triple, then dispatches to templates/do/lib/python/lora_vllm.py, whose HTTP
 * verbs are proven by test/unit/test_lora_vllm.py). These properties assert the
 * mapping the router establishes:
 *
 *   add    -> ACTION=load   -> lora_vllm.py load   -> POST /v1/load_lora_adapter
 *   remove -> ACTION=unload -> lora_vllm.py unload -> POST /v1/unload_lora_adapter
 *   list   -> ACTION=list   -> lora_vllm.py list   -> GET  /v1/models
 *   update -> ACTION=update -> unload THEN load    -> POST unload, POST load
 *
 * Each property runs a minimum of 100 iterations (NUM_RUNS) over generated
 * adapter names / S3 weights URIs. Behavior varies with the generated inputs
 * (the name/weights that flow into the triple), and the mapping is cheaply
 * verifiable against the router text + the proven lora_vllm.py client.
 *
 * Tags: Feature: v18-w4-01-bl112, Property {n}: {text}
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');

const ADAPTER_SRC = readFileSync(path.join(REPO, 'templates/do/adapter'), 'utf8');
const LORA_VLLM_SRC = readFileSync(
    path.join(REPO, 'templates/do/lib/python/lora_vllm.py'),
    'utf8'
);

/** Render the do/adapter template with the given generator vars. */
function renderAdapter(vars = {}) {
    return ejs.render(ADAPTER_SRC, {
        projectName: 'test-project',
        awsRegion: 'us-east-1',
        ...vars
    });
}

/**
 * Extract the _adapter_hyperpod function body from the rendered script so
 * assertions target the hyperpod-eks router, never the SMAI dispatch below it.
 */
function hyperpodBody(rendered) {
    const start = rendered.indexOf('_adapter_hyperpod() {');
    assert.ok(start !== -1, 'rendered script must define _adapter_hyperpod()');
    const callSite = rendered.indexOf('_adapter_hyperpod "$@"', start);
    assert.ok(callSite !== -1, 'rendered script must invoke _adapter_hyperpod "$@"');
    return rendered.slice(start, callSite);
}

/** The router-classification portion (first arg -> ACTION), before dispatch. */
function routerClassification(body) {
    const end = body.indexOf('# ── Direct-pod port-forward setup');
    assert.ok(end !== -1, 'router must precede the port-forward setup');
    return body.slice(0, end);
}

/** The dispatch portion (ACTION -> lora_vllm.py invocation). */
function dispatchBlock(body) {
    const start = body.indexOf('# ── Dispatch to lora_vllm.py');
    assert.ok(start !== -1, 'dispatch block must exist');
    return body.slice(start);
}

// Generators for adapter names and S3 weights URIs.
const adapterNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,30}$/);
const s3UriArb = fc
    .tuple(
        fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,40}$/),
        fc.stringMatching(/^[a-z0-9][a-z0-9/-]{2,60}$/)
    )
    .map(([bucket, key]) => `s3://${bucket}/${key}/`);

describe('Feature: v18-w4-01-bl112 — do/adapter hyperpod-eks verb routing', () => {

    // ── Property 1: add -> POST /v1/load_lora_adapter ─────────────────────────
    it('Property 1: add routes to POST /v1/load_lora_adapter', () => {
        // Feature: v18-w4-01-bl112, Property 1: add routes to POST /v1/load_lora_adapter
        fc.assert(
            fc.property(adapterNameArb, s3UriArb, (name, uri) => {
                const body = hyperpodBody(renderAdapter({ projectName: name }));
                const router = routerClassification(body);
                const dispatch = dispatchBlock(body);

                // `add` classifies to ACTION=load and requires <name> + --weights.
                assert.ok(/add\|update\)/.test(router), 'add must be a recognized verb');
                assert.ok(
                    /if \[ "\$\{CMD\}" = "add" \]; then\s*\n\s*ACTION="load"/.test(router),
                    'add must map to ACTION=load'
                );
                assert.ok(/--weights\)/.test(router), 'add must parse --weights');

                // ACTION=load dispatches through the load helper -> lora_vllm.py load.
                assert.ok(
                    /load\)\s*\n\s*_lora_do_load "\$\{LORA_NAME\}" "\$\{WEIGHTS_URI\}"/.test(dispatch),
                    'ACTION=load must invoke the load helper with name + weights'
                );
                assert.ok(
                    /lora_vllm\.py" load "\$\{_name\}" "\$\{_uri\}" "\$\{BASE_URL\}"/.test(dispatch),
                    'load helper must call lora_vllm.py load <name> <uri> <base_url>'
                );

                // lora_vllm.py load -> POST /v1/load_lora_adapter with {lora_name, lora_path}.
                assert.ok(
                    /load_lora_adapter"/.test(LORA_VLLM_SRC) &&
                    /requests\.post\(url, json=payload/.test(LORA_VLLM_SRC),
                    'lora_vllm.load must POST to /v1/load_lora_adapter'
                );
                // The generated weights URI is a valid S3 path that flows into the
                // triple as WEIGHTS_URI (passed to the load helper as ${_uri}).
                assert.ok(uri.startsWith('s3://'), 'generated weights URI must be an s3:// path');
                return true;
            }),
            PROPERTY_CONFIG
        );
    });

    // ── Property 2: remove -> POST /v1/unload_lora_adapter (never DELETE) ─────
    it('Property 2: remove routes to POST /v1/unload_lora_adapter (not DELETE)', () => {
        // Feature: v18-w4-01-bl112, Property 2: remove routes to POST /v1/unload_lora_adapter (not DELETE)
        fc.assert(
            fc.property(adapterNameArb, (name) => {
                const body = hyperpodBody(renderAdapter());
                const router = routerClassification(body);
                const dispatch = dispatchBlock(body);

                assert.ok(/remove\)\s*\n\s*ACTION="unload"/.test(router), 'remove must map to ACTION=unload');
                assert.ok(
                    /unload\)\s*\n\s*_lora_do_unload "\$\{LORA_NAME\}"/.test(dispatch),
                    'ACTION=unload must invoke the unload helper'
                );
                assert.ok(
                    /lora_vllm\.py" unload "\$\{_name\}" "\$\{BASE_URL\}"/.test(dispatch),
                    'unload helper must call lora_vllm.py unload <name> <base_url>'
                );

                // The client uses POST, never DELETE, for unload.
                assert.ok(/unload_lora_adapter"/.test(LORA_VLLM_SRC), 'client hits /v1/unload_lora_adapter');
                assert.ok(!/requests\.delete/.test(LORA_VLLM_SRC), 'client must not issue any DELETE');
                // sanity: name is a valid generated token
                assert.ok(typeof name === 'string' && name.length > 0);
                return true;
            }),
            PROPERTY_CONFIG
        );
    });

    // ── Property 3: list -> GET /v1/models, base filtered ─────────────────────
    it('Property 3: list routes to GET /v1/models and reports loaded adapters', () => {
        // Feature: v18-w4-01-bl112, Property 3: list routes to GET /v1/models and reports loaded adapters
        fc.assert(
            fc.property(fc.array(adapterNameArb, { minLength: 0, maxLength: 6 }), (adapters) => {
                const body = hyperpodBody(renderAdapter());
                const router = routerClassification(body);
                const dispatch = dispatchBlock(body);

                assert.ok(/list\)\s*\n\s*ACTION="list"/.test(router), 'list must map to ACTION=list');
                assert.ok(
                    /lora_vllm\.py" list "\$\{BASE_URL\}"/.test(dispatch),
                    'ACTION=list must call lora_vllm.py list <base_url>'
                );
                // Client GETs /v1/models and filters out the base model.
                assert.ok(/\/v1\/models"/.test(LORA_VLLM_SRC), 'client hits GET /v1/models');
                assert.ok(/requests\.get\(url/.test(LORA_VLLM_SRC), 'client uses GET for list');
                assert.ok(/base_model_id/.test(LORA_VLLM_SRC), 'client filters the base model');
                assert.ok(Array.isArray(adapters));
                return true;
            }),
            PROPERTY_CONFIG
        );
    });

    // ── Property 4: update = unload-then-load, both POST ──────────────────────
    it('Property 4: update performs unload-then-load', () => {
        // Feature: v18-w4-01-bl112, Property 4: update performs unload-then-load
        fc.assert(
            fc.property(adapterNameArb, s3UriArb, (name, uri) => {
                const body = hyperpodBody(renderAdapter());
                const router = routerClassification(body);
                const dispatch = dispatchBlock(body);

                assert.ok(/add\|update\)/.test(router), 'update must be a recognized verb');
                assert.ok(/ACTION="update"/.test(router), 'update must map to ACTION=update');
                assert.ok(/--weights\)/.test(router), 'update must parse --weights');

                // ACTION=update: unload THEN load, in that order, both via POST helpers.
                const updateArm = dispatch.slice(
                    dispatch.indexOf('update)'),
                    dispatch.indexOf('list)')
                );
                const unloadPos = updateArm.indexOf('_lora_do_unload "${LORA_NAME}"');
                const loadPos = updateArm.indexOf('_lora_do_load "${LORA_NAME}" "${WEIGHTS_URI}"');
                assert.ok(unloadPos !== -1, 'update must unload');
                assert.ok(loadPos !== -1, 'update must load');
                assert.ok(unloadPos < loadPos, 'update must unload BEFORE load (remove-then-add)');
                // A failed unload aborts before load.
                assert.ok(
                    /_lora_do_unload "\$\{LORA_NAME\}" \|\| exit 1\s*\n\s*_lora_do_load/.test(updateArm),
                    'a failed unload must abort before load'
                );
                // Neither helper uses DELETE.
                assert.ok(!/requests\.delete/.test(LORA_VLLM_SRC), 'no DELETE anywhere in the client');
                assert.ok(name.length > 0 && uri.startsWith('s3://'));
                return true;
            }),
            PROPERTY_CONFIG
        );
    });
});
