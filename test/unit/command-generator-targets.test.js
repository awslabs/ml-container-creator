// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Command Generator widget: deployment targets are DERIVED, not hardcoded (ADR-008).
 *
 * scripts/sync-command-generator.js writes docs/data/cli-manifest.json
 * `deploymentTargets` from templates/do/targets.d/<target>/manifest.json, and the
 * widget (docs/js/command-generator.js) reads them from that manifest. These checks
 * fail loudly when a target is added or removed without re-running the sync, or
 * when a per-target list (or the deprecated --deployment-target flag) creeps back
 * into the widget.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listTargets } from '../../src/lib/target-manifest-reader.js';
import { deriveDeploymentTargets } from '../../scripts/sync-command-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('Command Generator deployment targets (derived from targets.d)', () => {
    it('sync script derives exactly the targets.d descriptor set', () => {
        const derived = deriveDeploymentTargets().map(t => t.id);
        assert.deepStrictEqual(derived, listTargets());
        assert.ok(derived.length > 0, 'expected at least one target descriptor');
    });

    it('committed docs/data/cli-manifest.json matches the descriptors', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'cli-manifest.json'), 'utf8'));
        const ids = (manifest.deploymentTargets || []).map(t => t.id);
        assert.deepStrictEqual(ids, listTargets(),
            'docs/data/cli-manifest.json is stale: run `node scripts/sync-command-generator.js`');
    });

    it('widget has no hardcoded target list and never emits --deployment-target', () => {
        const src = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'command-generator.js'), 'utf8');
        assert.ok(!src.includes('--deployment-target'), 'widget must not emit the deprecated --deployment-target flag');
        assert.ok(!/DEPLOYMENT_TARGETS\s*=\s*\[/.test(src), 'widget must read targets from cli-manifest.json');
        assert.ok(src.includes('cli-manifest.json'), 'widget must load docs/data/cli-manifest.json');
        assert.ok(src.includes('./do/deploy --target'), 'widget must select the target at deploy time');
    });
});
