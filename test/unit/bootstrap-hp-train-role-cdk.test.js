// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 11 (R3.1, R3.2): CDK assertion tests for the HyperPod training Pod Identity
 * role. Runs infra/bootstrap-modules/test/hp-train-role.assertions.ts through ts-node
 * (offline synth: trust, exact action/resource set, no forbidden services, output),
 * then checks the profile wiring: the HpTrainRoleArn output becomes the flat profile
 * key hpTrainRoleArn, and do/lib/profile.sh exports it as MLCC_HP_TRAIN_ROLE_ARN.
 */
import { describe, it, before } from 'mocha';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import { requireBootstrapModulesDeps } from '../helpers/bootstrap-modules-deps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const MODULES_ROOT = resolve(REPO, 'infra/bootstrap-modules');

describe('Wave 11 — HpTrainRole (training bootstrap module) CDK assertions + profile wiring', function () {
    this.timeout(180000);
    const tsNodeRegister = resolve(MODULES_ROOT, 'node_modules/ts-node/register/index.js');
    let result;
    before(function () {
        requireBootstrapModulesDeps(this); // skip locally without deps; fail in CI (BL238)
        const out = execFileSync(process.execPath, ['-r', tsNodeRegister, 'test/hp-train-role.assertions.ts'], {
            cwd: MODULES_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' }
        });
        const line = out.trim().split('\n').reverse().find(l => l.startsWith('{"ok"'));
        assert.ok(line, `assertion script printed no summary:\n${out}`);
        result = JSON.parse(line);
    });

    it('trust, exact permissions, forbidden-service and output assertions pass', () => {
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.statements, 5);
    });

    it('the HpTrainRoleArn module output is denormalized to profile hpTrainRoleArn', () => {
        const profile = { moduleOutputs: { training: { HpTrainRoleArn: 'arn:aws:iam::111111111111:role/zz-sentinel' } } };
        new BootstrapCommandHandler()._denormalizeModuleOutputs(profile);
        assert.strictEqual(profile.hpTrainRoleArn, 'arn:aws:iam::111111111111:role/zz-sentinel');
    });

    it('do/lib/profile.sh exports MLCC_HP_TRAIN_ROLE_ARN from the profile key', () => {
        const dir = mkdtempSync(join(tmpdir(), 'w11-profile-'));
        try {
            mkdirSync(join(dir, 'lib'));
            const body = [
                'set -u',
                '_PROFILE_hpTrainRoleArn="arn:aws:iam::111111111111:role/zz-sentinel"',
                `MLCC_PROFILE_SH="${join(REPO, 'templates/do/lib/profile.sh')}"`,
                // Only the mapping block is exercised: extract it so the test needs
                // no bootstrap profile file on disk.
                'eval "$(sed -n \'/^MLCC_HP_TRAIN_ROLE_ARN=/,/export MLCC_HP_TRAIN_ROLE_ARN/p\' "$MLCC_PROFILE_SH")"',
                'bash -c \'echo "ROLE=${MLCC_HP_TRAIN_ROLE_ARN:-}"\''
            ].join('\n');
            writeFileSync(join(dir, 't.sh'), body);
            const r = spawnSync('/bin/bash', [join(dir, 't.sh')], { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            assert.match(r.stdout, /ROLE=arn:aws:iam::111111111111:role\/zz-sentinel/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
