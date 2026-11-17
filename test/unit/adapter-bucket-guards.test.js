// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-invariant tests for the training/adapter bucket fix (BL056).
 *
 * These pin behaviour that is expressed in template/source text rather than
 * in a cleanly-callable function:
 *   - templates/do/train    : no dead config.s3Bucket lookup; fail-fast guard.
 *   - templates/do/adapter   : no invented mlcc-adapters-* / sagemaker-* bucket
 *                              fallbacks; fail-fast guards at every resolve site;
 *                              a single reconciled S3 prefix ordering.
 *   - training/stack.ts      : AdaptersBucket construct + export.
 *   - module-manifest.json   : AdaptersBucket in training exports.
 *   - bootstrap-command-handler.js : legacy-migration reverse mapping for
 *                              adapterS3Bucket -> moduleOutputs.training.AdaptersBucket.
 *
 * Source-text assertions are intentionally used here because the invariants
 * are about "the invented fallback must never come back", which a value-based
 * test cannot express once the fallback is removed.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('do/train — training bucket resolution (BL056)', () => {
    const train = read('templates/do/train');

    it('no longer reads the dead config.s3Bucket key', () => {
        assert.ok(!train.includes('cfg.get(\'s3Bucket\''),
            'do/train must not fall back to the never-written config.s3Bucket key');
    });

    it('fails fast pointing at the training module when no bucket is resolved', () => {
        assert.ok(train.includes('bootstrap add-module training'),
            'do/train guard should direct the user to provision the training module');
    });
});

describe('do/adapter — adapter bucket resolution (BL056)', () => {
    const adapter = read('templates/do/adapter');

    it('does not invent an mlcc-adapters-* bucket name anywhere', () => {
        assert.ok(!adapter.includes('mlcc-adapters-${account_id}'),
            'do/adapter must not synthesize an mlcc-adapters-<acct>-<region> bucket');
    });

    it('does not fall back to a sagemaker-* default bucket', () => {
        assert.ok(!adapter.includes('adapter_bucket="sagemaker-${AWS_REGION:-us-east-1}-${account_id}"'),
            'do/adapter must not fall back to the sagemaker-* default bucket');
    });

    it('new adapters are never written to the frozen legacy adapters bucket (bucket consolidation R3.4)', () => {
        const code = adapter.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
        assert.ok(!/s3:\/\/\$\{(ADAPTER_S3_BUCKET|adapter_bucket|s3_bucket)\}/.test(code),
            'do/adapter must not compose an s3:// URI in the legacy adapters bucket');
        assert.ok(code.includes('_require_bucket CORE_S3_BUCKET'), 'canonical writes need the core bucket');
    });

    it('the env-var default resolves to empty (no invented fallback)', () => {
        assert.ok(adapter.includes('ADAPTER_S3_BUCKET="${ADAPTER_S3_BUCKET:-}"'),
            'ADAPTER_S3_BUCKET should default to empty and be supplied by profile.sh');
    });

    it('composes every adapter destination through s3_layout.py (one canonical scheme)', () => {
        assert.ok(adapter.includes('_adapter_promote_canonical'), 'promotion helper');
        assert.ok(adapter.includes('s3_layout.py" adapter-uri'), 'canonical adapter URI from s3_layout');
        assert.ok(!adapter.includes('${PROJECT_NAME}/adapters/${adapter_name}'), 'retired ordering');
        assert.ok(!adapter.includes('adapters/${PROJECT_NAME}/${adapter_name}'), 'retired ordering');
    });
});

describe('training CDK stack — AdaptersBucket (BL056)', () => {
    const stack = read('infra/bootstrap-modules/training/stack.ts');

    // Bucket consolidation R1.2: bucket names are declared ONCE in training/buckets.json
    // and the stack constructs each declared bucket through declaredBucket(). The
    // never-assumed training role that used to carry the adapters-bucket grant was
    // deleted (D4) — every job runs as the core execution role (mlcc-* S3 grant).
    const decl = JSON.parse(read('infra/bootstrap-modules/training/buckets.json'));

    it('declares an AdaptersBucket construct', () => {
        assert.ok(stack.includes('declaredBucket(this, \'AdaptersBucket\''),
            'training stack should create an AdaptersBucket');
    });

    it('uses a distinct adapters bucket name', () => {
        const names = Object.values(decl.buckets).map(b => b.name);
        assert.ok(decl.buckets.AdaptersBucket, 'AdaptersBucket is declared in training/buckets.json');
        assert.strictEqual(new Set(names).size, names.length, 'every training bucket name is distinct');
        assert.match(decl.buckets.AdaptersBucket.name, /\{account\}-\{region\}$/,
            'adapters bucket name is deterministic per account + region');
    });

    it('exports the AdaptersBucket via CfnOutput', () => {
        assert.ok(stack.includes('mlcc-${profileName}-training-AdaptersBucket'),
            'training stack should export AdaptersBucket for denormalization');
    });

    it('no longer carries the unused training role (D4)', () => {
        assert.ok(!stack.includes('new iam.Role(this, \'TrainingRole\''),
            'the never-assumed mlcc-training-role must be deleted');
    });
});

describe('module manifest — training exports AdaptersBucket (BL056)', () => {
    it('lists AdaptersBucket in the training module exports', () => {
        const manifest = JSON.parse(read('infra/bootstrap-modules/module-manifest.json'));
        assert.ok(manifest.modules.training.exports.includes('AdaptersBucket'),
            'training module manifest exports must include AdaptersBucket');
        assert.ok(manifest.modules.training.exports.includes('TrainingBucket'),
            'training module manifest exports must still include TrainingBucket');
    });
});

describe('bootstrap-command-handler — legacy migration reverse mapping (BL056)', () => {
    const handler = read('src/lib/bootstrap-command-handler.js');

    it('migrates a legacy adapterS3Bucket back into moduleOutputs.training.AdaptersBucket', () => {
        assert.ok(
            handler.includes('profileConfig.moduleOutputs.training.AdaptersBucket = profileConfig.adapterS3Bucket'),
            'legacy migration should round-trip adapterS3Bucket into moduleOutputs.training.AdaptersBucket');
    });
});
