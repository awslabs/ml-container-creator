// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL129 — LIVE override-params fetch smoke test (task 5.4). SKIPPED BY DEFAULT.
 *
 * Feature: v2-w3-01-bl129
 *
 * This hits the PUBLIC jumpstart-cache-prod-<region> S3 object for a real recipe to
 * prove the default (non-injected) fetcher resolves + parses AWS's override-params
 * into a non-empty hyperparameters block. It is network-dependent and account/region
 * sensitive, so it is SKIPPED unless explicitly enabled:
 *
 *   MLCC_LIVE_OVERRIDE_PARAMS=1 AWS_REGION=us-west-2 \
 *     AWS_PROFILE=<a profile with jumpstart-cache-prod read> \
 *     npx mocha test/unit/sync-tune-descriptors-live.test.js
 *
 * The deterministic offline counterpart (test/unit/sync-tune-descriptors.test.js) is
 * the real gate; this is a periodic reachability check only. It is intentionally NOT
 * wired into the default `npm test` run, and NOT in the server runner's
 * NETWORK_DEPENDENT list (that list is servers/** only).
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { syncTuneDescriptors } from '../../scripts/sync-model-families.js';
import {
    mkdtempSync, cpSync, readFileSync, rmSync, existsSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_TUNE_D = path.resolve(__dirname, '../..', 'templates', 'code', 'tune.d');

const LIVE = process.env.MLCC_LIVE_OVERRIDE_PARAMS === '1';

// A real, verified RLAIF override-params object (confirmed live 2026-10-16). If AWS
// bumps the version this URI 404s — update it (that is the point of a reachability
// check). The offline test does not depend on this URI.
const LIVE_RLAIF_URI =
    's3://jumpstart-cache-prod-us-west-2/recipes/verl-grpo-rlaif-qwen-3-8b-lora_override_params_sm_jobs_v2.2.7.json';

(LIVE ? describe : describe.skip)('sync-tune-descriptors LIVE fetch (BL129, opt-in)', () => {
    it('the default fetcher resolves a public override-params object into real knobs', async function () {
        this.timeout(30000);
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'mcc-tuned-live-'));
        cpSync(SRC_TUNE_D, tmp, { recursive: true });
        try {
            const res = await syncTuneDescriptors(
                [{ technique: 'rlaif', peft: 'lora', smtjOverrideParamsS3Uri: LIVE_RLAIF_URI, hpEksOverrideParamsS3Uri: null }],
                { tuneDir: tmp } // no injected fetcher → exercises the real S3 path
            );
            assert.strictEqual(res.synced, 1, 'one descriptor synced from the live object');
            const hp = JSON.parse(readFileSync(path.join(tmp, 'rlaif', 'manifest.json'), 'utf8'))
                .variants.lora.hyperparameters;
            assert.ok(Object.keys(hp).length > 0, 'live object produced real hyperparameters');
            // RLAIF's judge knob is the technique's signature knob.
            assert.ok('judge_model_id' in hp, 'RLAIF judge_model_id surfaced from the live object');
        } finally {
            if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
        }
    });
});
