// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 10 (ADR-014 R7, R8.1) — docs/scale-to-zero.md is rendered from the
 * descriptors and the reference data file, not hand-maintained.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS, renderRegion, DOC } from '../../scripts/render-scale-to-zero-docs.js';
import { allDescriptors } from '../../src/lib/target-manifest-reader.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('Wave 10 — docs/scale-to-zero.md matches the descriptors (R7.1, R8.1)', () => {
    const doc = readFileSync(DOC, 'utf8');
    for (const region of REGIONS) {
        it(`the "${region.name}" region is up to date (run node scripts/render-scale-to-zero-docs.js)`, () => {
            assert.ok(doc.includes(renderRegion(region)),
                `docs/scale-to-zero.md "${region.name}" region is stale`);
        });
    }
    it('the matrix has one row per descriptor with its enabled / refused state and reason', () => {
        for (const d of allDescriptors()) {
            const row = doc.split('\n').find((l) => l.startsWith(`| \`${d.target}\` |`));
            assert.ok(row, `matrix row for ${d.target}`);
            assert.ok(row.includes(d.scale_to_zero.enabled ? '| enabled |' : '| refused |'), row);
            if (!d.scale_to_zero.enabled) assert.ok(row.includes(d.scale_to_zero.reason), row);
        }
    });
    it('documents the flags, the IAM actions, cleanup, the ExactCapacity deviation and the async follow-up', () => {
        for (const needle of ['--scale-to-zero', '--scale-max', 'application-autoscaling:RegisterScalableTarget',
            'cloudwatch:PutMetricAlarm', 'iam:CreateServiceLinkedRole', 'ExactCapacity', 'documented, unmeasured',
            'async-inference', 'ADR-014', 'endpoint-auto-scaling-zero-instances.html', 'exits **5**']) {
            assert.ok(doc.includes(needle), needle);
        }
    });
    it('is in the mkdocs nav, linked from deployments.md, and listed in the target-authoring guide', () => {
        assert.match(read('mkdocs.yml'), /scale-to-zero\.md/);
        assert.match(read('docs/deployments.md'), /\(scale-to-zero\.md\)/);
        const authoring = read('docs/architecture/deployment-target-authoring.md');
        assert.match(authoring, /`scale_to_zero` block/);
    });
});
