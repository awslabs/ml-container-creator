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

    it('guards every resolve site with the training-module message', () => {
        const matches = adapter.split('Adapter staging requires the \'training\' module').length - 1;
        assert.ok(matches >= 4,
            `expected >=4 training-module guards (one per resolve site), found ${matches}`);
    });

    it('the env-var default resolves to empty (no invented fallback)', () => {
        assert.ok(adapter.includes('ADAPTER_S3_BUCKET="${ADAPTER_S3_BUCKET:-}"'),
            'ADAPTER_S3_BUCKET should default to empty and be supplied by profile.sh');
    });

    it('uses a single reconciled S3 prefix ordering: adapters/${PROJECT_NAME}/${adapter_name}', () => {
        // The correct/majority ordering.
        const good = (adapter.match(/adapters\/\$\{PROJECT_NAME\}\/\$\{adapter_name\}/g) || []).length;
        assert.ok(good >= 3, `expected >=3 uses of the reconciled prefix, found ${good}`);
        // The outlier ordering must be gone.
        assert.ok(!adapter.includes('${PROJECT_NAME}/adapters/${adapter_name}'),
            'the ${PROJECT_NAME}/adapters/${adapter_name} outlier ordering must be reconciled away');
    });
});

describe('training CDK stack — AdaptersBucket (BL056)', () => {
    const stack = read('infra/bootstrap-modules/training/stack.ts');

    it('declares an AdaptersBucket construct', () => {
        assert.ok(stack.includes('new s3.Bucket(this, \'AdaptersBucket\''),
            'training stack should create an AdaptersBucket');
    });

    it('uses a distinct adapters bucket name', () => {
        assert.ok(stack.includes('mlcc-training-adapters-${this.account}-${this.region}'),
            'adapters bucket should have a distinct, deterministic name');
    });

    it('exports the AdaptersBucket via CfnOutput', () => {
        assert.ok(stack.includes('mlcc-${profileName}-training-AdaptersBucket'),
            'training stack should export AdaptersBucket for denormalization');
    });

    it('grants the training role access to the adapters bucket', () => {
        assert.ok(stack.includes('adaptersBucket.bucketArn'),
            'training role IAM policy should include the adapters bucket ARN');
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
