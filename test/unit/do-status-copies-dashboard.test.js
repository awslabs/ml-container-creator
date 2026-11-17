// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 9 (R12.2, R12.3) — do/status shows inference-component copies as
 * current/desired and ONE native-dashboard pointer line, run for real under
 * /bin/bash (3.2 on macOS) from the EJS-rendered template, against a stub `aws`
 * that prints the AWS CLI's real pretty-printed JSON ("Key": "value").
 *
 * The pretty-printed form matters: the previous compact-only grep patterns
 * ("Key":"value") never matched real CLI output, so do/status exited 1 under
 * `set -o pipefail` before printing anything.
 */
import { describe, it, afterEach } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ejs from 'ejs';
import { makeSandbox, sandboxEnv, runBash, DO_SRC, ACTIVE_STATUS_CONFIG } from '../helpers/additive-sandbox.js';

const ENDPOINT = JSON.stringify({
    EndpointName: 'ep-1',
    EndpointStatus: 'InService',
    ProductionVariants: [{ VariantName: 'AllTraffic', CurrentInstanceCount: 1, InstanceType: 'ml.g5.xlarge' }]
}, null, 4);
const IC = JSON.stringify({
    InferenceComponentName: 'ic-1',
    InferenceComponentStatus: 'InService',
    Specification: { ComputeResourceRequirements: { NumberOfAcceleratorDevicesRequired: 1 } },
    RuntimeConfig: { DesiredCopyCount: 3, CurrentCopyCount: 1 }
}, null, 4);

describe('Wave 9 — do/status copies + dashboard line (behavioral, bash 3.2)', function () {
    this.timeout(60000);
    let sb;
    afterEach(() => sb && sb.cleanup());

    function setup(enableLora) {
        sb = makeSandbox({ pyHelpers: true });
        const rendered = ejs.render(readFileSync(join(DO_SRC, 'status'), 'utf8'), { enableLora, maxLoras: 4 });
        sb.write('do/status', rendered, 0o755);
        for (const py of ['gpu_metrics.py', 'endpoint_metrics.py']) {
            sb.write(`do/lib/python/${py}`, readFileSync(join(DO_SRC, 'lib/python', py)), 0o644);
        }
        sb.write('do/lib/aws-preflight.sh', readFileSync(join(DO_SRC, 'lib/aws-preflight.sh')), 0o644);
        sb.write('do/config', [ACTIVE_STATUS_CONFIG, 'export DEPLOYMENT_TARGET="realtime-inference"',
            'export ENDPOINT_NAME="ep-1"', 'export INFERENCE_COMPONENT_NAME="ic-1"',
            'export AWS_REGION="us-west-2"', 'export PROJECT_NAME="p"', ''].join('\n'), 0o644);
        sb.write('ep.json', ENDPOINT, 0o644);
        sb.write('ic.json', IC, 0o644);
        sb.write('bin/aws', ['#!/bin/bash',
            'case "$1 $2" in',
            '  "sts get-caller-identity") echo \'{"Account": "000000000000"}\';;',
            `  "sagemaker describe-endpoint") cat "${sb.root}/ep.json";;`,
            `  "sagemaker describe-inference-component") cat "${sb.root}/ic.json";;`,
            '  "sagemaker list-inference-components") echo \'{"InferenceComponents": []}\';;',
            '  *) exit 255;;',
            'esac', ''].join('\n'));
    }
    const status = () => runBash(join(sb.doDir, 'status'), [], sandboxEnv(sb, {
        HOME: join(sb.root, 'home'), AWS_EC2_METADATA_DISABLED: 'true'
    }), { timeout: 50000 });

    for (const enableLora of [false, true]) {
        it(`prints current/desired copies and one dashboard line (enableLora=${enableLora})`, () => {
            setup(enableLora);
            const r = status();
            assert.strictEqual(r.code, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /Endpoint: ep-1 \[InService\]/);
            assert.match(r.stdout, /COPIES \(current\/desired\)/);
            assert.match(r.stdout, /default\s+InService\s+1\s+1\/3/, 'current 1 / desired 3, not Desired alone');
            const dash = r.stdout.split('\n').filter((l) => l.startsWith('Dashboard:'));
            assert.strictEqual(dash.length, 1, 'exactly one dashboard pointer line');
            assert.match(dash[0], /CloudWatch console → Insights → SageMaker AI \(us-west-2, endpoint ep-1\) — readout: \.\/do\/metrics/);
        });
    }
});
