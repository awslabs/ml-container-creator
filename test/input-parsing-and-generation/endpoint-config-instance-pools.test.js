// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for INSTANCE_POOLS support in do/lib/endpoint-config.sh
 *
 * Validates Requirements: 6.1, 6.2, 6.5, 6.6
 *
 * These tests verify the shell script content contains the correct
 * branching logic for instance pools vs single instance type, and
 * that the generated JSON is valid when sourced in bash.
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
 * Returns stdout. Cleans up the temp file after.
 */
function runBashTest(scriptContent, tmpName) {
    const tmpDir = path.join(__dirname, '../../.kiro/tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpScript = path.join(tmpDir, tmpName);
    writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
    try {
        return execSync(`bash "${tmpScript}"`, { encoding: 'utf8', timeout: 5000 });
    } finally {
        try { unlinkSync(tmpScript); } catch (e) { /* ignore */ }
    }
}

/**
 * Helper: extract the JSON line from bash output (starts with '[')
 */
function extractVariantJson(output) {
    const lines = output.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('['));
    assert.ok(jsonLine, 'Must output variant JSON starting with [');
    return JSON.parse(jsonLine);
}

describe('do/lib/endpoint-config.sh — INSTANCE_POOLS support', () => {
    it('contains INSTANCE_POOLS branch that uses InstancePools array (Req 6.1, 6.2)', () => {
        assert.ok(
            endpointConfigContent.includes('InstancePools'),
            'endpoint-config.sh must reference InstancePools when INSTANCE_POOLS is set'
        );
        assert.ok(
            endpointConfigContent.includes('${INSTANCE_POOLS}'),
            'endpoint-config.sh must pass INSTANCE_POOLS variable value into InstancePools field'
        );
    });

    it('sets VariantInstanceProvisionTimeoutInSeconds from POOL_TIMEOUT with default 1200 (Req 6.5)', () => {
        assert.ok(
            endpointConfigContent.includes('VariantInstanceProvisionTimeoutInSeconds'),
            'endpoint-config.sh must include VariantInstanceProvisionTimeoutInSeconds'
        );
        assert.ok(
            endpointConfigContent.includes('${POOL_TIMEOUT:-1200}'),
            'endpoint-config.sh must use POOL_TIMEOUT with default 1200'
        );
    });

    it('sets RoutingConfig to LEAST_OUTSTANDING_REQUESTS when pools active (Req 6.6)', () => {
        assert.ok(
            endpointConfigContent.includes('RoutingConfig'),
            'endpoint-config.sh must include RoutingConfig when pools are active'
        );
        assert.ok(
            endpointConfigContent.includes('LEAST_OUTSTANDING_REQUESTS'),
            'endpoint-config.sh must set RoutingStrategy to LEAST_OUTSTANDING_REQUESTS'
        );
    });

    it('sets InitialInstanceCount from POOL_INSTANCE_COUNT with default 1 (Req 6.1)', () => {
        assert.ok(
            endpointConfigContent.includes('${POOL_INSTANCE_COUNT:-1}'),
            'endpoint-config.sh must use POOL_INSTANCE_COUNT with default 1 for pools path'
        );
    });

    it('omits InstanceType when INSTANCE_POOLS is set (mutually exclusive) (Req 6.1)', () => {
        // Extract the pools branch content (between the if INSTANCE_POOLS and else)
        const poolsBranchMatch = endpointConfigContent.match(
            /if \[ -n "\$\{INSTANCE_POOLS:-\}" \]; then\n([\s\S]*?)\n {4}else/
        );
        assert.ok(poolsBranchMatch, 'Must have an INSTANCE_POOLS branch');
        const poolsBranch = poolsBranchMatch[1];

        // The pools branch should NOT contain InstanceType in the variant JSON construction
        assert.ok(
            !poolsBranch.includes('"InstanceType"'),
            'Pools branch must NOT include InstanceType field (mutually exclusive)'
        );
    });

    it('standard path still uses InstanceType when INSTANCE_POOLS is not set', () => {
        // The else branch should use InstanceType
        const elseBranchMatch = endpointConfigContent.match(
            /else\n([\s\S]*?)\n {4}fi/
        );
        assert.ok(elseBranchMatch, 'Must have an else branch for standard path');
        const elseBranch = elseBranchMatch[1];

        assert.ok(
            elseBranch.includes('InstanceType'),
            'Standard path must include InstanceType'
        );
        assert.ok(
            elseBranch.includes('${INSTANCE_TYPE}'),
            'Standard path must use INSTANCE_TYPE variable'
        );
    });

    it('produces valid JSON for pools path with custom POOL_TIMEOUT and POOL_INSTANCE_COUNT', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.g6.12xlarge","Priority":2}]'
export POOL_TIMEOUT=600
export POOL_INSTANCE_COUNT=2

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
        const result = runBashTest(scriptContent, 'test-pools-custom.sh');
        const parsed = extractVariantJson(result);

        assert.ok(Array.isArray(parsed), 'Variant must be an array');
        assert.strictEqual(parsed.length, 1, 'Must have exactly one variant');

        const variant = parsed[0];
        assert.strictEqual(variant.VariantName, 'AllTraffic');
        assert.ok(!('InstanceType' in variant), 'Must NOT have InstanceType when pools are set');
        assert.deepStrictEqual(variant.InstancePools, [
            { InstanceType: 'ml.g6e.48xlarge', Priority: 1 },
            { InstanceType: 'ml.g6.12xlarge', Priority: 2 }
        ]);
        assert.strictEqual(variant.InitialInstanceCount, 2);
        assert.strictEqual(variant.VariantInstanceProvisionTimeoutInSeconds, 600);
        assert.deepStrictEqual(variant.RoutingConfig, { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' });
    });

    it('produces valid JSON for standard path (no pools)', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_TYPE="ml.g5.xlarge"

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
        const result = runBashTest(scriptContent, 'test-standard-path.sh');
        const parsed = extractVariantJson(result);

        assert.ok(Array.isArray(parsed), 'Variant must be an array');
        assert.strictEqual(parsed.length, 1, 'Must have exactly one variant');

        const variant = parsed[0];
        assert.strictEqual(variant.VariantName, 'AllTraffic');
        assert.strictEqual(variant.InstanceType, 'ml.g5.xlarge');
        assert.strictEqual(variant.InitialInstanceCount, 1);
        assert.ok(!('InstancePools' in variant), 'Must NOT have InstancePools when using single type');
        assert.ok(!('RoutingConfig' in variant), 'Must NOT have RoutingConfig when using single type');
        assert.ok(!('VariantInstanceProvisionTimeoutInSeconds' in variant), 'Must NOT have timeout when using single type');
    });

    it('uses default POOL_TIMEOUT=1200 and POOL_INSTANCE_COUNT=1 when not set', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1}]'

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
        const result = runBashTest(scriptContent, 'test-pools-defaults.sh');
        const parsed = extractVariantJson(result);
        const variant = parsed[0];

        assert.strictEqual(variant.InitialInstanceCount, 1, 'Default InitialInstanceCount should be 1');
        assert.strictEqual(variant.VariantInstanceProvisionTimeoutInSeconds, 1200, 'Default timeout should be 1200');
    });

    it('pools path includes INFERENCE_AMI_VERSION when set', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1}]'
export INFERENCE_AMI_VERSION="al2-ami-sagemaker-inference-gpu-2"

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
        const result = runBashTest(scriptContent, 'test-pools-ami.sh');
        const parsed = extractVariantJson(result);
        const variant = parsed[0];

        assert.strictEqual(variant.InferenceAmiVersion, 'al2-ami-sagemaker-inference-gpu-2',
            'AMI version should be included in pools path');
    });

    it('capacity reservation wins over instance pools — mutual exclusivity (Req 6.1)', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_TYPE="ml.g6e.48xlarge"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.g6.12xlarge","Priority":2}]'
export CAPACITY_RESERVATION_ARN="arn:aws:sagemaker:us-east-1:123456789012:inference-component/my-reservation"

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
create_endpoint_config
`;
        const result = runBashTest(scriptContent, 'test-mutual-exclusivity.sh');

        // Should print the warning
        assert.ok(
            result.includes('Capacity reservations and instance pools are mutually exclusive'),
            'Must print mutual exclusivity warning when both are set'
        );

        // Should use the standard (single instance type) path with capacity reservation
        const parsed = extractVariantJson(result);
        const variant = parsed[0];

        assert.strictEqual(variant.InstanceType, 'ml.g6e.48xlarge',
            'Must use INSTANCE_TYPE (single type path) when capacity reservation wins');
        assert.ok(!('InstancePools' in variant),
            'Must NOT have InstancePools when capacity reservation is set');
        assert.ok('CapacityReservationConfig' in variant,
            'Must include CapacityReservationConfig when CAPACITY_RESERVATION_ARN is set');
        assert.strictEqual(
            variant.CapacityReservationConfig.MlReservationArn,
            'arn:aws:sagemaker:us-east-1:123456789012:inference-component/my-reservation',
            'Must use the correct capacity reservation ARN'
        );
    });

    it('does not print warning when only INSTANCE_POOLS is set (no CAPACITY_RESERVATION_ARN)', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1}]'

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
create_endpoint_config
`;
        const result = runBashTest(scriptContent, 'test-no-warning-pools-only.sh');

        assert.ok(
            !result.includes('Capacity reservations and instance pools are mutually exclusive'),
            'Must NOT print mutual exclusivity warning when only INSTANCE_POOLS is set'
        );

        // Should use pools path
        const parsed = extractVariantJson(result);
        const variant = parsed[0];
        assert.ok('InstancePools' in variant, 'Must use InstancePools when only pools are set');
    });

    it('does not print warning when only CAPACITY_RESERVATION_ARN is set (no INSTANCE_POOLS)', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_TYPE="ml.g6e.48xlarge"
export CAPACITY_RESERVATION_ARN="arn:aws:sagemaker:us-east-1:123456789012:inference-component/my-reservation"

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
create_endpoint_config
`;
        const result = runBashTest(scriptContent, 'test-no-warning-reservation-only.sh');

        assert.ok(
            !result.includes('Capacity reservations and instance pools are mutually exclusive'),
            'Must NOT print mutual exclusivity warning when only CAPACITY_RESERVATION_ARN is set'
        );

        // Should use standard path with capacity reservation
        const parsed = extractVariantJson(result);
        const variant = parsed[0];
        assert.ok('CapacityReservationConfig' in variant, 'Must include CapacityReservationConfig');
        assert.ok(!('InstancePools' in variant), 'Must NOT have InstancePools');
    });

    it('transforms ModelName to ModelNameOverride when pool entries include ModelName (Req 6.4)', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1,"ModelName":"my-model-g6e"},{"InstanceType":"ml.p5.48xlarge","Priority":2,"ModelName":"my-model-p5"}]'

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
create_endpoint_config
`;
        const result = runBashTest(scriptContent, 'test-model-name-override.sh');
        const parsed = extractVariantJson(result);
        const variant = parsed[0];

        // ModelName should be transformed to ModelNameOverride in each pool entry
        assert.ok(Array.isArray(variant.InstancePools), 'Must have InstancePools array');
        assert.strictEqual(variant.InstancePools.length, 2, 'Must have 2 pool entries');

        assert.strictEqual(variant.InstancePools[0].ModelNameOverride, 'my-model-g6e',
            'First pool entry must have ModelNameOverride');
        assert.strictEqual(variant.InstancePools[1].ModelNameOverride, 'my-model-p5',
            'Second pool entry must have ModelNameOverride');

        // Original ModelName key should NOT be present
        assert.ok(!('ModelName' in variant.InstancePools[0]),
            'First pool entry must NOT have original ModelName key');
        assert.ok(!('ModelName' in variant.InstancePools[1]),
            'Second pool entry must NOT have original ModelName key');

        // Should print the ModelNameOverride detection message
        assert.ok(result.includes('ModelNameOverride: per-pool model names detected'),
            'Must print ModelNameOverride detection message');
    });

    it('omits ModelNameOverride when pool entries do not include ModelName (Req 6.4)', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.p5.48xlarge","Priority":2}]'

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
create_endpoint_config
`;
        const result = runBashTest(scriptContent, 'test-no-model-name-override.sh');
        const parsed = extractVariantJson(result);
        const variant = parsed[0];

        // No ModelNameOverride should be present
        assert.ok(Array.isArray(variant.InstancePools), 'Must have InstancePools array');
        assert.ok(!('ModelNameOverride' in variant.InstancePools[0]),
            'First pool entry must NOT have ModelNameOverride when ModelName absent');
        assert.ok(!('ModelNameOverride' in variant.InstancePools[1]),
            'Second pool entry must NOT have ModelNameOverride when ModelName absent');

        // Should NOT print the ModelNameOverride detection message
        assert.ok(!result.includes('ModelNameOverride: per-pool model names detected'),
            'Must NOT print ModelNameOverride message when no ModelName in pools');
    });

    it('handles mixed pool entries — some with ModelName, some without (Req 6.4)', () => {
        const scriptContent = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1,"ModelName":"my-model-g6e"},{"InstanceType":"ml.p5.48xlarge","Priority":2}]'

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
create_endpoint_config
`;
        const result = runBashTest(scriptContent, 'test-mixed-model-name.sh');
        const parsed = extractVariantJson(result);
        const variant = parsed[0];

        assert.ok(Array.isArray(variant.InstancePools), 'Must have InstancePools array');
        assert.strictEqual(variant.InstancePools.length, 2, 'Must have 2 pool entries');

        // First entry had ModelName → should be transformed to ModelNameOverride
        assert.strictEqual(variant.InstancePools[0].ModelNameOverride, 'my-model-g6e',
            'First pool entry must have ModelNameOverride (had ModelName)');
        assert.ok(!('ModelName' in variant.InstancePools[0]),
            'First pool entry must NOT retain original ModelName key');

        // Second entry had no ModelName → should not have ModelNameOverride
        assert.ok(!('ModelNameOverride' in variant.InstancePools[1]),
            'Second pool entry must NOT have ModelNameOverride (no ModelName in input)');
    });
});
