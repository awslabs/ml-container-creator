// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// CDK assertion tests for the core bootstrap stack's execution-role secrets
// grants (BL212). do/deploy passes HF_TOKEN_ARN / NGC_API_KEY_ARN to the
// serving container, which resolves the secret at startup AS THIS ROLE, so the
// role must be able to read MLCC-named secrets, and only those.
//
// Run: npm test   (from infra/bootstrap-modules)
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MlccCoreStack } from '../core/stack';

const ACCOUNT = '123456789012';

function synth(): Template {
    const app = new cdk.App();
    const stack = new MlccCoreStack(app, 'TestCore', {
        env: { account: ACCOUNT, region: 'us-west-2' },
        profileName: 'test',
    });
    return Template.fromStack(stack);
}

interface Statement {
    Sid?: string;
    Effect: string;
    Action: string | string[];
    Resource: string | string[];
    Condition?: Record<string, Record<string, string | string[]>>;
}

function statements(template: Template): Statement[] {
    const policies = template.findResources('AWS::IAM::Policy');
    const out: Statement[] = [];
    for (const p of Object.values(policies)) {
        out.push(...(p.Properties.PolicyDocument.Statement as Statement[]));
    }
    return out;
}

function asList(v: string | string[]): string[] {
    return Array.isArray(v) ? v : [v];
}

const MLCC_SECRET_ARNS = [
    `arn:aws:secretsmanager:*:${ACCOUNT}:secret:mlcc/*`,
    `arn:aws:secretsmanager:*:${ACCOUNT}:secret:ml-container-creator/*`,
    `arn:aws:secretsmanager:*:${ACCOUNT}:secret:mlcc-hf-token-*`,
];

test('execution role can GetSecretValue on MLCC-named secrets', () => {
    synth().hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
            Statement: Match.arrayWith([
                Match.objectLike({
                    Sid: 'SecretsManagerRead',
                    Effect: 'Allow',
                    Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
                    Resource: Match.arrayEquals(MLCC_SECRET_ARNS),
                }),
            ]),
        },
    });
});

test('GetSecretValue is never granted on a wildcard resource', () => {
    for (const s of statements(synth())) {
        const actions = asList(s.Action);
        if (!actions.some(a => a === 'secretsmanager:GetSecretValue' || a === 'secretsmanager:*' || a === '*')) {
            continue;
        }
        for (const r of asList(s.Resource)) {
            assert.notStrictEqual(r, '*', `statement ${s.Sid} grants GetSecretValue on "*"`);
            assert.match(r, /:secret:(mlcc\/|ml-container-creator\/|mlcc-hf-token-)/,
                `statement ${s.Sid} grants GetSecretValue outside MLCC secret names: ${r}`);
        }
    }
});

test('kms:Decrypt is scoped to Secrets Manager calls for MLCC secrets', () => {
    const kms = statements(synth()).filter(s => asList(s.Action).includes('kms:Decrypt'));
    assert.strictEqual(kms.length, 1, 'expected exactly one kms:Decrypt statement');
    const [s] = kms;
    assert.strictEqual(s.Sid, 'SecretsManagerKmsDecrypt');
    assert.ok(s.Condition, 'kms:Decrypt must be conditioned');
    const like = s.Condition.StringLike;
    assert.strictEqual(like['kms:ViaService'], 'secretsmanager.*.amazonaws.com');
    assert.deepStrictEqual(asList(like['kms:EncryptionContext:SecretARN']), MLCC_SECRET_ARNS);
});
