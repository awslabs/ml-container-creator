// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for _validate_instance_pools() in do/lib/endpoint-config.sh
 *
 * Validates Requirements: 6.1, 6.2
 *
 * Tests verify:
 * - Pools whose families share an AWS-listed InferenceAmiVersion pass
 *   (BL209: derived from fleet-drivers.json ami_versions default/override
 *   families, copied from
 *   https://docs.aws.amazon.com/sagemaker/latest/dg/inference-gpu-drivers.html —
 *   e.g. g6e + g4dn and p4d + p5 both list gpu-3-1 / gpu-4-1 as overrides, so
 *   the old hand-coded "generation" rejection of those pools was wrong)
 * - Mixed CUDA/Neuron types are rejected (g6e + inf2)
 * - Unknown instance types produce a warning but don't block
 * - Error messages are clear and actionable
 * - BL209: ml.g7.* and ml.p6-b200.* are recognised; a Blackwell pool gets an
 *   AMI with driver >= 570; a stale INFERENCE_AMI_VERSION is warned about
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const endpointConfigPath = path.join(__dirname, '../../templates/do/lib/endpoint-config.sh');
const endpointConfigContent = readFileSync(endpointConfigPath, 'utf8');

/**
 * Helper: write a bash test script to disk and execute it.
 * Returns { stdout, stderr, exitCode }.
 */
function runBashTest(scriptContent, tmpName) {
    const tmpDir = path.join(__dirname, '../../.kiro/tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpScript = path.join(tmpDir, tmpName);
    writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
    try {
        const stdout = execSync(`bash "${tmpScript}" 2>&1`, { encoding: 'utf8', timeout: 5000 });
        return { stdout, exitCode: 0 };
    } catch (err) {
        return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
    } finally {
        try { unlinkSync(tmpScript); } catch (e) { /* ignore */ }
    }
}

describe('do/lib/endpoint-config.sh — _validate_instance_pools()', () => {

    it('contains _validate_instance_pools function definition', () => {
        assert.ok(
            endpointConfigContent.includes('_validate_instance_pools()'),
            'endpoint-config.sh must define _validate_instance_pools function'
        );
    });

    it('calls _validate_instance_pools from create_endpoint_config when INSTANCE_POOLS is set', () => {
        // Check that the pools branch calls _validate_instance_pools
        assert.ok(
            endpointConfigContent.includes('_validate_instance_pools'),
            'endpoint-config.sh must call _validate_instance_pools'
        );
        // Verify it's called within the INSTANCE_POOLS branch
        const poolsBranchMatch = endpointConfigContent.match(
            /if \[ -n "\$\{INSTANCE_POOLS:-\}" \]; then\n([\s\S]*?)\n {4}else/
        );
        assert.ok(poolsBranchMatch, 'Must have an INSTANCE_POOLS branch');
        assert.ok(
            poolsBranchMatch[1].includes('_validate_instance_pools'),
            '_validate_instance_pools must be called within the INSTANCE_POOLS branch'
        );
    });

    it('allows same-generation CUDA 12 instances (g6 + g6e) (Req 6.1)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.g6.12xlarge","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-valid-same-gen.sh');
        assert.strictEqual(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'), 'Same-generation instances should pass validation');
    });

    it('allows same-generation CUDA 11 instances (g4dn + g5 + p3) (Req 6.1)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g4dn.12xlarge","Priority":1},{"InstanceType":"ml.g5.48xlarge","Priority":2},{"InstanceType":"ml.p3.16xlarge","Priority":3}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-valid-cuda11.sh');
        assert.strictEqual(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'), 'Same-generation cuda-11 instances should pass');
    });

    it('allows same-generation CUDA 12 instances (g6e + p5) (Req 6.1)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.p5.48xlarge","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-valid-cuda12.sh');
        assert.strictEqual(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'), 'g6e + p5 (both cuda-12) should pass');
    });

    it('allows same-generation neuron instances (inf2 + trn1) (Req 6.2)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.inf2.xlarge","Priority":1},{"InstanceType":"ml.trn1.2xlarge","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-valid-neuron.sh');
        assert.strictEqual(result.exitCode, 0, `Expected exit 0 but got ${result.exitCode}. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'), 'Same-generation neuron instances should pass');
    });

    it('allows g6e + g4dn: AWS lists shared override AMIs for both families (BL209)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.g4dn.12xlarge","Priority":2}]'
source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-allow-g6e-g4dn.sh');
        assert.strictEqual(result.exitCode, 0, `g6e + g4dn share AWS-listed AMIs. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'));
        assert.ok(!result.stdout.includes('Cannot mix'));
    });

    it('rejects mixed CUDA/Neuron types: g6e (cuda-12) + inf2 (neuron) (Req 6.2)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.inf2.xlarge","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "SHOULD_NOT_REACH"
`;
        const result = runBashTest(scriptContent, 'test-pool-reject-cuda-neuron.sh');
        assert.notStrictEqual(result.exitCode, 0, 'Mixed CUDA/Neuron must exit with error');
        assert.ok(
            result.stdout.includes('Cannot mix'),
            `Error message must contain "Cannot mix". Got: ${result.stdout}`
        );
    });

    it('allows p4d + p5: AWS lists shared override AMIs for both families (BL209)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.p4d.24xlarge","Priority":1},{"InstanceType":"ml.p5.48xlarge","Priority":2}]'
source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-allow-p4d-p5.sh');
        assert.strictEqual(result.exitCode, 0, `p4d + p5 share AWS-listed AMIs. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'));
    });

    it('warns but allows unknown instance types (Req 6.1)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.x99.unknown","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-unknown-type.sh');
        assert.strictEqual(result.exitCode, 0, `Unknown types should not block. Output: ${result.stdout}`);
        assert.ok(
            result.stdout.includes('Unknown instance type'),
            'Must warn about unknown instance type'
        );
        assert.ok(result.stdout.includes('PASS'), 'Must allow deployment to proceed');
    });

    it('allows pool with only unknown instance types', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.x99.large","Priority":1},{"InstanceType":"ml.z42.xlarge","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-all-unknown.sh');
        assert.strictEqual(result.exitCode, 0, `All-unknown pool should pass. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'), 'Must allow deployment with all unknown types');
    });

    it('handles empty INSTANCE_POOLS gracefully', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-empty.sh');
        assert.strictEqual(result.exitCode, 0, `Empty pool should pass. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'), 'Empty pool must not error');
    });

    it('handles single instance in pool (always valid)', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
        const result = runBashTest(scriptContent, 'test-pool-single.sh');
        assert.strictEqual(result.exitCode, 0, `Single instance pool should pass. Output: ${result.stdout}`);
        assert.ok(result.stdout.includes('PASS'), 'Single instance pool must pass');
    });

    it('error message includes both conflicting instance types', () => {
        const scriptContent = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.inf2.xlarge","Priority":2}]'
source "${endpointConfigPath}"
_validate_instance_pools
`;
        const result = runBashTest(scriptContent, 'test-pool-error-msg.sh');
        assert.notStrictEqual(result.exitCode, 0);
        assert.ok(
            result.stdout.includes('ml.g6e.48xlarge') && result.stdout.includes('ml.inf2.xlarge'),
            `Error must name both conflicting types. Got: ${result.stdout}`
        );
        assert.ok(result.stdout.includes('different CUDA/AMI requirements'), 'Error must mention CUDA/AMI requirements');
        assert.ok(result.stdout.includes('docs.aws.amazon.com'), 'Error must point at the AWS AMI table');
    });

    it('validation is called during create_endpoint_config with pools', () => {
        // This test verifies that _validate_instance_pools is actually invoked
        // by create_endpoint_config when INSTANCE_POOLS is set with mixed types.
        // The create_endpoint_config call should fail before reaching the AWS CLI call.
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.inf2.xlarge","Priority":2}]'
aws() {
    echo "AWS_CALLED"
    return 0
}
export -f aws

source "${endpointConfigPath}"
create_endpoint_config
echo "SHOULD_NOT_REACH"
`;
        const result = runBashTest(scriptContent, 'test-pool-validation-in-create.sh');
        assert.notStrictEqual(result.exitCode, 0, 'create_endpoint_config must fail for mixed pools');
        assert.ok(
            result.stdout.includes('Cannot mix'),
            'Must show validation error'
        );
        assert.ok(
            !result.stdout.includes('AWS_CALLED'),
            'Must not call AWS CLI when validation fails'
        );
        assert.ok(
            !result.stdout.includes('SHOULD_NOT_REACH'),
            'Must exit before completing'
        );
    });

    it('validation passes and create_endpoint_config proceeds for valid pools', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.g6.12xlarge","Priority":2}]'

aws() {
    local capture_next=false
    for arg in "$@"; do
        if [ "$capture_next" = true ]; then
            echo "$arg"
            return 0
        fi
        if [ "$arg" = "--production-variants" ]; then
            capture_next=true
        fi
    done
    return 0
}
export -f aws

source "${endpointConfigPath}"
create_endpoint_config 2>/dev/null
`;
        const result = runBashTest(scriptContent, 'test-pool-validation-passes.sh');
        assert.strictEqual(result.exitCode, 0, `Valid pools should proceed. Output: ${result.stdout}`);
        // Should contain the variant JSON output (from the mocked aws command)
        assert.ok(
            result.stdout.includes('InstancePools'),
            'Must proceed to build variant JSON after validation passes'
        );
    });
});

// ── BL209: data-derived pool / AMI validation for Blackwell families ─────────
const CATALOGS = path.join(__dirname, '../../servers/lib/catalogs');
const fleet = JSON.parse(readFileSync(path.join(CATALOGS, 'fleet-drivers.json'), 'utf8'));
const instanceCatalog = JSON.parse(readFileSync(path.join(CATALOGS, 'instances.json'), 'utf8')).catalog;
const typeOf = (family) => Object.keys(instanceCatalog).find(t => instanceCatalog[t].family === family);
const amiNames = Object.keys(fleet.ami_versions).filter(n => !n.startsWith('_'));
const allowedFor = (family) => amiNames.filter(n => [
    ...(fleet.ami_versions[n].default_families || []),
    ...(fleet.ami_versions[n].override_families || [])
].includes(family));
const driverMajor = (ami) => Number(String(fleet.ami_versions[ami].driver).split('.')[0]);
const AWS_MOCK = `aws() {
    local capture_next=false
    for arg in "$@"; do
        if [ "$capture_next" = true ]; then
            echo "$arg"
            return 0
        fi
        if [ "$arg" = "--production-variants" ]; then
            capture_next=true
        fi
    done
    return 0
}
export -f aws`;
const variantOf = (stdout) => JSON.parse(stdout.split('\n').find(l => l.startsWith('[{')));

describe('do/lib/endpoint-config.sh — BL209 AMI checks for ml.g7.* / ml.p6-b200.*', () => {
    const G7 = typeOf('g7');
    const P6 = typeOf('p6-b200');
    const G5 = typeOf('g5');
    const NON_GPU = Object.keys(fleet.instance_families).find(f => fleet.instance_families[f] === null);
    const STALE = amiNames.find(n => !allowedFor('g7').includes(n));

    it('derives ml.g7.* / ml.p6-b200.* / ml.g5.* types from instances.json', () => {
        assert.ok(G7 && P6 && G5 && NON_GPU && STALE);
    });

    it('no longer hand-codes an instance-generation map', () => {
        assert.ok(!endpointConfigContent.includes('GENERATION_MAP'), 'GENERATION_MAP must be gone (derive from fleet-drivers.json)');
    });

    for (const [label, a, b] of [['g7 + g5', () => G7, () => G5], ['p6-b200 + g5', () => P6, () => G5]]) {
        it(`${label} pool: recognised, and the variant gets one AMI both families allow (driver >= 570)`, () => {
            const pools = JSON.stringify([{ InstanceType: a(), Priority: 1 }, { InstanceType: b(), Priority: 2 }]);
            const script = `set -euo pipefail
export PROJECT_NAME="t"
export AWS_REGION="us-east-1"
export INSTANCE_POOLS='${pools}'
${AWS_MOCK}
source "${endpointConfigPath}"
create_endpoint_config
`;
            const result = runBashTest(script, `test-bl209-pool-${label.replace(/\W+/g, '-')}.sh`);
            assert.strictEqual(result.exitCode, 0, result.stdout);
            assert.ok(!result.stdout.includes('Unknown instance type'), `Blackwell type must be known: ${result.stdout}`);
            const ami = variantOf(result.stdout)[0].InferenceAmiVersion;
            assert.ok(ami, `pool must carry a shared AMI: ${result.stdout}`);
            assert.ok(allowedFor(parseFam(a())).includes(ami) && allowedFor(parseFam(b())).includes(ami));
            assert.ok(driverMajor(ami) >= 570);
        });
    }

    it('p6-b200 + a non-GPU family is rejected', () => {
        const script = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"${P6}","Priority":1},{"InstanceType":"ml.${NON_GPU}.xlarge","Priority":2}]'
source "${endpointConfigPath}"
_validate_instance_pools
echo "SHOULD_NOT_REACH"
`;
        const result = runBashTest(script, 'test-bl209-p6-nongpu.sh');
        assert.notStrictEqual(result.exitCode, 0);
        assert.ok(result.stdout.includes('Cannot mix') && result.stdout.includes(P6), result.stdout);
        assert.ok(!result.stdout.includes('SHOULD_NOT_REACH'));
    });

    it('single ml.g7.* with a stale INFERENCE_AMI_VERSION: loud warning, value kept', () => {
        const script = `set -euo pipefail
export PROJECT_NAME="t"
export AWS_REGION="us-east-1"
export INSTANCE_TYPE="${G7}"
export INFERENCE_AMI_VERSION="${STALE}"
${AWS_MOCK}
source "${endpointConfigPath}"
create_endpoint_config
`;
        const result = runBashTest(script, 'test-bl209-g7-stale.sh');
        assert.strictEqual(result.exitCode, 0, result.stdout);
        assert.ok(result.stdout.includes('WARNING') && result.stdout.includes('not listed by AWS for g7'), result.stdout);
        assert.strictEqual(variantOf(result.stdout)[0].InferenceAmiVersion, STALE);
    });

    it('single ml.p6-b200.* with an AWS-listed INFERENCE_AMI_VERSION: no warning', () => {
        const listed = allowedFor('p6-b200')[0];
        const script = `set -euo pipefail
export PROJECT_NAME="t"
export AWS_REGION="us-east-1"
export INSTANCE_TYPE="${P6}"
export INFERENCE_AMI_VERSION="${listed}"
${AWS_MOCK}
source "${endpointConfigPath}"
create_endpoint_config
`;
        const result = runBashTest(script, 'test-bl209-p6-listed.sh');
        assert.strictEqual(result.exitCode, 0, result.stdout);
        assert.ok(!result.stdout.includes('WARNING'), result.stdout);
        assert.strictEqual(variantOf(result.stdout)[0].InferenceAmiVersion, listed);
    });
});

function parseFam(type) {
    const m = /^ml\.([a-z0-9][a-z0-9-]*)\./.exec(type);
    return m ? m[1] : null;
}
