// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL144 — sync-model-families mtrl-retention unit test (task 2.2).
 *
 * `parseRecipes()` historically dropped `mtrl` recipes (validTechniques excluded it), so
 * an `mtrl` key could never reach the tune catalog and BL144's D6 unimplemented-technique
 * warning was unreachable from real synced data. This test drives the public
 * syncModelFamilies() seam with a mock SageMaker client returning an `mtrl` recipe and
 * asserts the technique is RETAINED in the written catalog entry.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncModelFamilies } from '../../scripts/sync-model-families.js';

/**
 * A mock SageMaker client. Branches on the command's input shape:
 *   - HubContentName present → DescribeHubContent
 *   - otherwise             → ListHubContents
 */
function makeMockClient(hubContentDocument, modelName = 'huggingface-reasoning-qwen3-32b') {
    return {
        async send(command) {
            const input = command.input || {};
            if (input.HubContentName) {
                return {
                    HubContentName: modelName,
                    HubContentDisplayName: 'Qwen3-32B',
                    HubContentDocument: JSON.stringify(hubContentDocument)
                };
            }
            // ListHubContents: only return the model for the first prefix query so we
            // don't emit duplicates across the six KNOWN_PREFIXES iterations.
            if (input.NameContains && modelName.startsWith(input.NameContains)) {
                return {
                    HubContentSummaries: [{ HubContentName: modelName, HubContentStatus: 'Available' }],
                    NextToken: undefined
                };
            }
            return { HubContentSummaries: [], NextToken: undefined };
        }
    };
}

describe('sync-model-families mtrl retention (BL144)', () => {
    let tmpDir;
    let catalogPath;

    beforeEach(() => {
        tmpDir = path.join(os.tmpdir(), `mcc-sync-mtrl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        catalogPath = path.join(tmpDir, 'tune-catalog.json');
    });

    afterEach(() => {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('retains an mtrl recipe in the written catalog (reachability for D6)', async () => {
        const doc = {
            HuggingFaceModelId: 'Qwen/Qwen3-32B',
            RecipeCollection: [
                { CustomizationTechnique: 'sft' },
                { CustomizationTechnique: 'mtrl' }
            ]
        };

        const result = await syncModelFamilies({
            client: makeMockClient(doc),
            catalogPath,
            // registryPath points nowhere → benchmark eligibility is an empty set (fine).
            registryPath: path.join(tmpDir, 'no-registry')
        });

        assert.ok(result.total >= 1, 'at least one model written');

        const written = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const entry = written.models['huggingface-reasoning-qwen3-32b'];
        assert.ok(entry, 'model entry written');
        const techniques = Object.keys(entry.techniques).sort();
        assert.ok(techniques.includes('mtrl'), `mtrl retained (got: ${techniques.join(',')})`);
        assert.ok(techniques.includes('sft'), 'sft retained alongside mtrl');
    });

    it('still drops a genuinely unknown technique', async () => {
        const doc = {
            HuggingFaceModelId: 'Qwen/Qwen3-32B',
            RecipeCollection: [
                { CustomizationTechnique: 'sft' },
                { CustomizationTechnique: 'bogus-technique' }
            ]
        };

        await syncModelFamilies({
            client: makeMockClient(doc),
            catalogPath,
            registryPath: path.join(tmpDir, 'no-registry')
        });

        const written = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const entry = written.models['huggingface-reasoning-qwen3-32b'];
        const techniques = Object.keys(entry.techniques);
        assert.ok(!techniques.includes('bogus-technique'), 'unknown technique dropped');
        assert.deepStrictEqual(techniques.sort(), ['sft']);
    });

    it('extracts huggingFaceId from the `HuggingfaceId` field (huggingface-vlm-* schema)', async () => {
        // The vlm family exposes the id under `HuggingfaceId` (capital H, lowercase f),
        // not `HuggingFaceModelId`/`ModelId`. Without this casing in the fallback chain,
        // Qwen 3.6 / Gemma 4 synced with an EMPTY huggingFaceId and the picker skipped
        // them. Guards against that regression.
        const doc = {
            HuggingfaceId: 'Qwen/Qwen3.6-27B',
            Provider: 'Qwen',
            RecipeCollection: [
                { CustomizationTechnique: 'sft' },
                { CustomizationTechnique: 'mtrl' }
            ]
        };

        await syncModelFamilies({
            client: makeMockClient(doc, 'huggingface-vlm-qwen3-6-27b'),
            catalogPath,
            registryPath: path.join(tmpDir, 'no-registry')
        });

        const written = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const entry = written.models['huggingface-vlm-qwen3-6-27b'];
        assert.ok(entry, 'vlm model entry written');
        assert.strictEqual(entry.huggingFaceId, 'Qwen/Qwen3.6-27B', 'HuggingfaceId resolved');
        assert.ok(Object.keys(entry.techniques).includes('mtrl'), 'mtrl retained');
    });

    it('uses the hub-document `Provider` field (not name-prefix "unknown")', async () => {
        // huggingface-vlm-* / nvidia names are NOT in deriveProvider's prefix map, so
        // without reading doc.Provider they fell to "unknown" → the "── Unknown ──"
        // picker group. The hub document carries the real maker.
        const doc = {
            HuggingfaceId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16',
            Provider: 'nvidia',
            RecipeCollection: [{ CustomizationTechnique: 'sft' }]
        };

        await syncModelFamilies({
            client: makeMockClient(doc, 'huggingface-vlm-nemotron-3-nano-30b'),
            catalogPath,
            registryPath: path.join(tmpDir, 'no-registry')
        });

        const written = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const entry = written.models['huggingface-vlm-nemotron-3-nano-30b'];
        assert.strictEqual(entry.provider, 'nvidia', 'provider taken from hub document');
    });

    it('falls back to name-prefix provider when the hub doc omits Provider', async () => {
        const doc = {
            HuggingFaceModelId: 'Qwen/Qwen3-32B',
            RecipeCollection: [{ CustomizationTechnique: 'sft' }]
        };
        await syncModelFamilies({
            client: makeMockClient(doc, 'huggingface-reasoning-qwen3-32b'),
            catalogPath,
            registryPath: path.join(tmpDir, 'no-registry')
        });
        const written = JSON.parse(readFileSync(catalogPath, 'utf8'));
        // deriveProvider maps huggingface-reasoning-qwen → 'alibaba'.
        assert.strictEqual(written.models['huggingface-reasoning-qwen3-32b'].provider, 'alibaba');
    });
});
