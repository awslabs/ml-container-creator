// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 10 (ADR-014 R2.2-R2.4, R8.2) — do/deploy --scale-to-zero / --scale-max
 * validation and refusals, run against the REAL templates/do/deploy under
 * /bin/bash (3.2 on macOS) in a sandbox project with a stub `aws` that logs every
 * call. The disabled targets are found by iterating the descriptors (no target
 * literals), so a descriptor flip changes what this test expects.
 */
import { describe, it, afterEach } from 'mocha';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSandbox, sandboxEnv, runBash, loadDescriptors, DO_SRC } from '../helpers/additive-sandbox.js';

const descriptors = loadDescriptors();
const disabled = descriptors.filter((d) => !d.scale_to_zero.enabled);
const enabled = descriptors.filter((d) => d.scale_to_zero.enabled);

describe('Wave 10 — do/deploy scale-to-zero flags (behavioral, bash 3.2)', function () {
    this.timeout(60000);
    let sb;
    afterEach(() => sb && sb.cleanup());

    function setup(target, extra = []) {
        sb = makeSandbox({ scripts: ['deploy'], pyHelpers: true });
        sb.write('do/config', [
            'export PROJECT_NAME="stz-test"',
            `export DEPLOYMENT_TARGET="${target}"`,
            'export INSTANCE_TYPE="ml.g5.xlarge"',
            // A generated do/config always exports AWS_REGION. Pin it here so the
            // dry-run plan does not depend on the ambient env (another test in
            // the same mocha worker may delete process.env.AWS_REGION).
            'export AWS_REGION="us-east-1"',
            ...extra,
            ''
        ].join('\n'), 0o644);
        // The driver must never run on a refusal; record it if it does.
        for (const d of descriptors) {
            sb.write(`do/${d.deploy_script}`, '#!/bin/bash\necho DRIVER_RAN >> "${SCRIPT_DIR}/../driver.log"\n');
        }
        sb.write('bin/aws', `#!/bin/bash\necho "aws $*" >> "${sb.root}/calls.log"\nexit 0\n`);
    }
    const calls = () => (existsSync(join(sb.root, 'calls.log')) ? readFileSync(join(sb.root, 'calls.log'), 'utf8') : '');
    const driverRan = () => existsSync(join(sb.root, 'driver.log'));
    const config = () => readFileSync(join(sb.doDir, 'config'), 'utf8');
    const deploy = (args) => runBash(join(sb.doDir, 'deploy'), args, sandboxEnv(sb, { HOME: sb.root }), { timeout: 50000 });

    it('at least one target refuses and one accepts (sanity on the descriptor set)', () => {
        assert.ok(disabled.length >= 1 && enabled.length >= 1);
    });

    for (const d of disabled) {
        for (const args of [['--scale-to-zero', 'on'], ['--scale-to-zero', 'off'], ['--scale-max', '2']]) {
            it(`${d.target}: ${args.join(' ')} exits 3 with the descriptor reason, before any AWS call`, () => {
                setup(d.target);
                const r = deploy(args);
                assert.strictEqual(r.code, 3, r.stdout + r.stderr);
                assert.ok(r.stdout.includes(d.scale_to_zero.reason), `reason not printed:\n${r.stdout}`);
                assert.strictEqual(calls(), '', 'no aws call');
                assert.ok(!driverRan(), 'deploy driver must not run');
                assert.ok(!/SCALE_TO_ZERO/.test(config()), 'nothing persisted');
            });
        }
    }

    for (const [args, what] of [
        [['--scale-to-zero', 'yes'], /--scale-to-zero must be 'on' or 'off'/],
        [['--scale-to-zero', 'ON'], /--scale-to-zero must be 'on' or 'off'/],
        [['--scale-max', '0'], /--scale-max must be an integer from 1 to 20/],
        [['--scale-max', '21'], /--scale-max must be an integer from 1 to 20/],
        [['--scale-max', '1.5'], /--scale-max must be an integer from 1 to 20/],
        [['--scale-max', 'two'], /--scale-max must be an integer from 1 to 20/]
    ]) {
        it(`a bad value (${args.join(' ')}) exits 1 before any AWS call, on every target`, () => {
            for (const d of descriptors) {
                setup(d.target);
                const r = deploy(args);
                assert.strictEqual(r.code, 1, `${d.target}: ${r.stdout}${r.stderr}`);
                assert.match(r.stderr, what);
                assert.strictEqual(calls(), '', `${d.target}: no aws call`);
                sb.cleanup();
            }
            sb = null;
        });
    }

    for (const d of enabled) {
        for (const [extra, what] of [
            [['export CAPACITY_RESERVATION_ARN="arn:aws:sagemaker:us-east-1:111122223333:ml-reservation/x"'], /CAPACITY_RESERVATION_ARN is set/],
            [['export INSTANCE_POOLS=\'[{"InstanceType":"ml.g5.xlarge","Priority":1}]\''], /INSTANCE_POOLS is set/],
            [['export ENDPOINT_STRATEGY="existing"'], /ENDPOINT_STRATEGY is 'existing'/],
            [['export ENDPOINT_EXTERNAL=true', 'export ENDPOINT_NAME="someone-elses-ep"'], /ENDPOINT_STRATEGY is/]
        ]) {
            it(`${d.target}: --scale-to-zero on is refused (exit 3) when ${extra[0].replace(/^export /, '').split('=')[0]} is set`, () => {
                setup(d.target, extra);
                const r = deploy(['--scale-to-zero', 'on']);
                assert.strictEqual(r.code, 3, r.stdout + r.stderr);
                assert.match(r.stdout, what);
                assert.strictEqual(calls(), '', 'no aws call');
                assert.ok(!driverRan());
            });
        }
        it(`${d.target}: --scale-to-zero off is not refused by those settings (turning it off is always allowed)`, () => {
            setup(d.target, ['export CAPACITY_RESERVATION_ARN="arn:aws:sagemaker:us-east-1:111122223333:ml-reservation/x"']);
            const r = deploy(['--scale-to-zero', 'off', '--dry-run']);
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
        });
        it(`${d.target}: --dry-run with the flags writes nothing to do/config`, () => {
            setup(d.target);
            const r = deploy(['--scale-to-zero', 'on', '--scale-max', '3', '--dry-run']);
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /SCALE_TO_ZERO=true/);
            assert.match(r.stdout, /SCALE_MAX_CAPACITY=3/);
            assert.ok(!/SCALE_TO_ZERO/.test(config()), 'dry run must not persist');
            // R9.1: the planned calls print, and no AWS call is made.
            assert.match(r.stdout, /Scale-to-zero plan/);
            assert.match(r.stdout, /register-scalable-target/);
            assert.match(r.stdout, /ExactCapacity/);
            assert.match(r.stdout, /put-metric-alarm/);
            assert.strictEqual(calls(), '', 'no aws call in a dry run');
        });
        it(`${d.target}: a dry run without the flags prints no scale-to-zero plan (off by default)`, () => {
            setup(d.target);
            const r = deploy(['--dry-run']);
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.ok(!/scale-to-zero|SCALE_TO_ZERO/i.test(r.stdout), r.stdout);
        });
    }
});

describe('Wave 10 — scale-to-zero wiring (static)', () => {
    const lib = readFileSync(join(DO_SRC, 'lib/scale-to-zero.sh'), 'utf8');
    const drv = readFileSync(join(DO_SRC, 'deploy.d/realtime-inference'), 'utf8');
    it('every do/manifest type the lib records is a VALID_RESOURCE_TYPE', async () => {
        const { VALID_RESOURCE_TYPES } = await import('../../src/lib/asset-manager.js');
        const types = [...lib.matchAll(/_stz_record ([a-z-]+) /g)].map((m) => m[1]);
        assert.ok(types.length >= 3, types.join(','));
        for (const t of types) assert.ok(VALID_RESOURCE_TYPES.includes(t), t);
    });
    it('the lib dispatches on the descriptor mechanism, never on a target name', () => {
        const code = lib.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        for (const d of descriptors) {
            assert.ok(!code.includes(d.target), `scale-to-zero.sh must not name target ${d.target}`);
        }
        assert.match(code, /case "\$\{STZ_MECHANISM\}" in/);
    });
    it('deploy.d/realtime-inference sets up scaling after the ICs are InService and before "Deployment complete"', () => {
        const setup = drv.indexOf('stz_setup "${_STZ_TARGET}"');
        assert.ok(setup > drv.lastIndexOf('wait_ic "${IC_DEPLOYED_NAME}"'), 'after the last IC wait');
        assert.ok(setup < drv.indexOf('echo "✅ Deployment complete!"'));
        assert.match(drv, /exit 5\n/, 'a setup failure exits 5 (endpoint up), not 4');
    });
    it('do/add-ic prints the not-registered notice before deploying the new IC (R3.3)', () => {
        const addIc = readFileSync(join(DO_SRC, 'add-ic'), 'utf8');
        assert.ok(addIc.indexOf('stz_add_ic_notice') < addIc.indexOf('exec "${SCRIPT_DIR}/deploy" --ic'));
    });
});
