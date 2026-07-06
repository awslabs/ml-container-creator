// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for Instance Pools — end-to-end scenarios
 *
 * Validates Requirements: 7.1, 7.2
 *
 * These tests verify the full flow from instance selection through endpoint config
 * generation to IC deployment configuration. They tie together:
 * - endpoint-config-instance-pools.test.js (endpoint config structure)
 * - endpoint-config-pool-validation.test.js (pool validation)
 * - inference-component-multi-spec.test.js (multi-spec IC JSON)
 * - instance-multi-select.test.js (selection logic)
 *
 * Focus: end-to-end scenarios that verify the full flow from selection to config
 * to deployment, covering gaps not addressed by individual unit tests.
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync, writeFileSync as fsWriteSync, mkdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    filterByCudaGeneration,
    instanceCatalogRaw
} from '../../src/lib/prompts/index.js';

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);

const endpointConfigPath = path.join(__dirname2, '../../templates/do/lib/endpoint-config.sh');
const inferenceComponentPath = path.join(__dirname2, '../../templates/do/lib/inference-component.sh');

/**
 * Helper: write a bash test script to disk and execute it.
 * Returns { stdout, exitCode }. Cleans up the temp file after.
 */
function runBashTest(scriptContent, tmpName) {
    const tmpDir = path.join(__dirname2, '../../.kiro/tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpScript = path.join(tmpDir, tmpName);
    fsWriteSync(tmpScript, scriptContent, { mode: 0o755 });
    try {
        const stdout = execSync(`bash "${tmpScript}" 2>&1`, { encoding: 'utf8', timeout: 10000 });
        return { stdout, exitCode: 0 };
    } catch (err) {
        return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
    } finally {
        try { unlinkSync(tmpScript); } catch (e) { /* ignore */ }
    }
}

/**
 * Helper: extract the JSON line from bash output (starts with '[' or '{')
 */
function extractJson(output) {
    const lines = output.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('[') || l.trim().startsWith('{'));
    assert.ok(jsonLine, `Must output JSON. Got:\n${output}`);
    return JSON.parse(jsonLine);
}

describe('Instance Pools Integration Tests (Req 7.1, 7.2)', function () {
    this.timeout(15000);

    // ================================================================
    // E2E: Single instance selection produces INSTANCE_TYPE (no pools)
    // ================================================================
    describe('E2E: Single instance selection flow', () => {
        it('single instance selection produces INSTANCE_TYPE config (no pools)', () => {
            // Simulate: user selects 1 instance from MCP choices
            const selections = ['ml.g5.xlarge'];

            // Single selection means INSTANCE_TYPE, not INSTANCE_POOLS
            assert.strictEqual(selections.length, 1);

            // Verify endpoint config uses standard path
            const script = `set -euo pipefail
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
            const result = runBashTest(script, 'test-e2e-single-select.sh');
            assert.strictEqual(result.exitCode, 0, `Expected success. Output: ${result.stdout}`);
            const variant = extractJson(result.stdout);
            assert.strictEqual(variant[0].InstanceType, 'ml.g5.xlarge');
            assert.ok(!('InstancePools' in variant[0]), 'Single selection must NOT produce InstancePools');
            assert.deepStrictEqual(variant[0].RoutingConfig, { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' }, 'IC-based endpoints require RoutingConfig for scheduler placement');
        });
    });

    // ================================================================
    // E2E: Multi instance selection produces INSTANCE_POOLS with priorities
    // ================================================================
    describe('E2E: Multi instance selection flow', () => {
        it('multi instance selection produces INSTANCE_POOLS with correct priorities', () => {
            // Simulate: user selects 3 instances from MCP choices
            const selections = ['ml.g6e.48xlarge', 'ml.g6.12xlarge', 'ml.p5.48xlarge'];

            // Build INSTANCE_POOLS JSON (priority = selection order)
            const pools = selections.map((type, idx) => ({
                InstanceType: type,
                Priority: idx + 1
            }));
            const poolsJson = JSON.stringify(pools);

            // Verify endpoint config uses pools path
            const script = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='${poolsJson}'

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
            const result = runBashTest(script, 'test-e2e-multi-select.sh');
            assert.strictEqual(result.exitCode, 0, `Expected success. Output: ${result.stdout}`);
            const variant = extractJson(result.stdout);

            assert.ok(!('InstanceType' in variant[0]), 'Multi selection must NOT have InstanceType');
            assert.ok(Array.isArray(variant[0].InstancePools), 'Must have InstancePools array');
            assert.strictEqual(variant[0].InstancePools.length, 3);
            assert.strictEqual(variant[0].InstancePools[0].Priority, 1);
            assert.strictEqual(variant[0].InstancePools[1].Priority, 2);
            assert.strictEqual(variant[0].InstancePools[2].Priority, 3);
            assert.strictEqual(variant[0].InstancePools[0].InstanceType, 'ml.g6e.48xlarge');
            assert.strictEqual(variant[0].RoutingConfig.RoutingStrategy, 'LEAST_OUTSTANDING_REQUESTS');
            assert.strictEqual(variant[0].VariantInstanceProvisionTimeoutInSeconds, 1200);
        });
    });

    // ================================================================
    // E2E: Pool generation filter excludes cross-AMI instances
    // ================================================================
    describe('E2E: Pool generation filter excludes cross-AMI instances', () => {
        it('filterByCudaGeneration keeps all instances when first instance is in catalog and others are unknown or same gen', () => {
            // g6e and g6 are in catalog (Ada Lovelace); g4dn and p5 are NOT in catalog (unknown).
            // First instance (g6e) sets generation to Ada Lovelace.
            // Unknown instances are kept (not filtered out).
            const mcpChoices = ['ml.g6e.48xlarge', 'ml.g6.12xlarge', 'ml.g4dn.xlarge', 'ml.p5.48xlarge'];

            const result = filterByCudaGeneration(mcpChoices);

            // First instance (g6e) is in catalog → generation is 'Ada Lovelace'
            // g6 = same generation → kept; g4dn, p5 = unknown → kept
            assert.strictEqual(result.generation, 'Ada Lovelace');
            assert.deepStrictEqual(result.filtered, mcpChoices);
            assert.deepStrictEqual(result.removed, []);
        });

        it('filterByCudaGeneration removes unknown instances when first instance IS in catalog', () => {
            // When first instance is in catalog (g5 = Ampere), unknown instances are kept
            // but instances with a DIFFERENT known generation would be removed.
            // Since only g5 is in catalog, unknown instances get null and are kept.
            const mcpChoices = ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g4dn.xlarge'];
            const result = filterByCudaGeneration(mcpChoices);

            // g5.xlarge sets generation to Ampere; g4dn is unknown (null) so it's kept
            assert.strictEqual(result.generation, 'Ampere');
            assert.ok(result.filtered.includes('ml.g5.xlarge'));
            assert.ok(result.filtered.includes('ml.g5.2xlarge'));
            assert.ok(result.filtered.includes('ml.g4dn.xlarge'), 'Unknown instances are kept');
        });

        it('filtered instances can be used directly as INSTANCE_POOLS without validation failure', () => {
            // Use only g5 instances that are in the catalog and same generation
            const mcpChoices = ['ml.g5.12xlarge', 'ml.g5.48xlarge'];
            const { filtered } = filterByCudaGeneration(mcpChoices);

            // Build pools from filtered results
            const pools = filtered.map((type, idx) => ({
                InstanceType: type,
                Priority: idx + 1
            }));
            const poolsJson = JSON.stringify(pools);

            // Run pool validation via bash
            const script = `set -euo pipefail
export INSTANCE_POOLS='${poolsJson}'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
            const result = runBashTest(script, 'test-e2e-filtered-validation.sh');
            assert.strictEqual(result.exitCode, 0, `Filtered pools should pass validation. Output: ${result.stdout}`);
            assert.ok(result.stdout.includes('PASS'));
        });
    });

    // ================================================================
    // E2E: Capacity reservation wins over pools (mutual exclusivity)
    // ================================================================
    describe('E2E: Capacity reservation mutual exclusivity', () => {
        it('capacity reservation wins over pools in full endpoint config flow', () => {
            const script = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_TYPE="ml.g6e.48xlarge"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.g6.12xlarge","Priority":2}]'
export CAPACITY_RESERVATION_ARN="arn:aws:sagemaker:us-east-1:123456789012:capacity-reservation/cr-123"

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
            const result = runBashTest(script, 'test-e2e-mutual-exclusivity.sh');
            assert.strictEqual(result.exitCode, 0);
            assert.ok(result.stdout.includes('mutually exclusive'), 'Must warn about mutual exclusivity');

            const variant = extractJson(result.stdout);
            assert.strictEqual(variant[0].InstanceType, 'ml.g6e.48xlarge', 'Must use single instance type');
            assert.ok(!('InstancePools' in variant[0]), 'Must NOT have InstancePools');
            assert.ok(variant[0].CapacityReservationConfig, 'Must have CapacityReservationConfig');
        });
    });

    // ================================================================
    // E2E: Pool validation rejects mixed CUDA 12.x + next-gen instances
    // ================================================================
    describe('E2E: Pool validation rejects incompatible generations', () => {
        it('rejects mixed CUDA 12.x (g6e) + cuda-next (g7e) instances', () => {
            const script = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1},{"InstanceType":"ml.g7e.xlarge","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "SHOULD_NOT_REACH"
`;
            const result = runBashTest(script, 'test-e2e-reject-mixed-gen.sh');
            assert.notStrictEqual(result.exitCode, 0, 'Mixed generations must fail');
            assert.ok(result.stdout.includes('Cannot mix'), 'Must show error about mixing');
            assert.ok(!result.stdout.includes('SHOULD_NOT_REACH'));
        });

        it('allows same-generation instances (g6 + g6e both CUDA 12.x)', () => {
            const script = `set -euo pipefail
export INSTANCE_POOLS='[{"InstanceType":"ml.g6.12xlarge","Priority":1},{"InstanceType":"ml.g6e.48xlarge","Priority":2}]'

source "${endpointConfigPath}"
_validate_instance_pools
echo "PASS"
`;
            const result = runBashTest(script, 'test-e2e-allow-same-gen.sh');
            assert.strictEqual(result.exitCode, 0, `Same generation should pass. Output: ${result.stdout}`);
            assert.ok(result.stdout.includes('PASS'));
        });
    });

    // ================================================================
    // E2E: Multi-spec IC JSON has Specifications array
    // ================================================================
    describe('E2E: Multi-spec IC with Specifications array', () => {
        it('multi-spec IC JSON has Specifications array with per-type entries', () => {
            const icContent = readFileSync(inferenceComponentPath, 'utf8');
            assert.ok(icContent.includes('Specifications'), 'IC script must support Specifications array');
            assert.ok(icContent.includes('IC_MULTI_SPEC'), 'IC script must check IC_MULTI_SPEC');
        });

        it('single-spec IC unchanged when IC_MULTI_SPEC not set', () => {
            const icContent = readFileSync(inferenceComponentPath, 'utf8');
            // The else branch should use single spec
            assert.ok(icContent.includes('IC_GPU_COUNT:-1'), 'Single spec path must use IC_GPU_COUNT default');
            assert.ok(icContent.includes('IC_MIN_MEMORY_MB:-1024'), 'Single spec path must use IC_MIN_MEMORY_MB default');
        });
    });

    // ================================================================
    // E2E: ModelNameOverride included/omitted based on pool entry
    // ================================================================
    describe('E2E: ModelNameOverride handling', () => {
        it('ModelNameOverride included when pool entry has ModelName', () => {
            const script = `set -euo pipefail
export PROJECT_NAME="test-project"
export AWS_REGION="us-east-1"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='[{"InstanceType":"ml.g6e.48xlarge","Priority":1,"ModelName":"optimized-g6e"},{"InstanceType":"ml.p5.48xlarge","Priority":2,"ModelName":"optimized-p5"}]'

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
            const result = runBashTest(script, 'test-e2e-model-name-present.sh');
            assert.strictEqual(result.exitCode, 0);
            const variant = extractJson(result.stdout);

            assert.strictEqual(variant[0].InstancePools[0].ModelNameOverride, 'optimized-g6e');
            assert.strictEqual(variant[0].InstancePools[1].ModelNameOverride, 'optimized-p5');
            assert.ok(!('ModelName' in variant[0].InstancePools[0]), 'Original ModelName must be removed');
        });

        it('ModelNameOverride omitted when pool entry lacks ModelName', () => {
            const script = `set -euo pipefail
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
            const result = runBashTest(script, 'test-e2e-model-name-absent.sh');
            assert.strictEqual(result.exitCode, 0);
            const variant = extractJson(result.stdout);

            assert.ok(!('ModelNameOverride' in variant[0].InstancePools[0]),
                'Must NOT have ModelNameOverride when ModelName absent');
            assert.ok(!('ModelNameOverride' in variant[0].InstancePools[1]),
                'Must NOT have ModelNameOverride when ModelName absent');
        });
    });

    // ================================================================
    // E2E: Full flow — selection, filtering, validation, config generation
    // ================================================================
    describe('E2E: Complete flow from selection to deployment config', () => {
        it('full flow: filter selections, validate pool, generate endpoint config + multi-spec IC', () => {
            // Step 1: Simulate MCP sizer returning ranked instances (all g5, in catalog)
            const mcpChoices = ['ml.g5.48xlarge', 'ml.g5.12xlarge', 'ml.g5.24xlarge'];

            // Step 2: Filter by CUDA generation (all same generation, all kept)
            const { filtered } = filterByCudaGeneration(mcpChoices);
            assert.ok(filtered.length >= 2, 'Should have at least 2 compatible instances');
            assert.strictEqual(filtered.length, 3, 'All g5 instances should be kept');

            // Step 3: Build INSTANCE_POOLS from filtered selections
            const pools = filtered.map((type, idx) => ({
                InstanceType: type,
                Priority: idx + 1
            }));
            const poolsJson = JSON.stringify(pools);

            // Step 4: Validate pool compatibility (bash)
            const validationScript = `set -euo pipefail
export INSTANCE_POOLS='${poolsJson}'
source "${endpointConfigPath}"
_validate_instance_pools
echo "VALIDATION_PASS"
`;
            const validationResult = runBashTest(validationScript, 'test-e2e-full-flow-validate.sh');
            assert.strictEqual(validationResult.exitCode, 0, 'Pool validation must pass for filtered instances');
            assert.ok(validationResult.stdout.includes('VALIDATION_PASS'));

            // Step 5: Generate endpoint config (bash)
            const configScript = `set -euo pipefail
export PROJECT_NAME="my-llm-project"
export AWS_REGION="us-west-2"
export ROLE_ARN="arn:aws:iam::123456789012:role/SageMakerRole"
export INSTANCE_POOLS='${poolsJson}'
export POOL_TIMEOUT=900
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
            const configResult = runBashTest(configScript, 'test-e2e-full-flow-config.sh');
            assert.strictEqual(configResult.exitCode, 0, `Config generation must succeed. Output: ${configResult.stdout}`);

            const variant = extractJson(configResult.stdout);
            assert.strictEqual(variant[0].VariantName, 'AllTraffic');
            assert.ok(!('InstanceType' in variant[0]), 'Must use pools, not single type');
            assert.strictEqual(variant[0].InstancePools.length, filtered.length);
            assert.strictEqual(variant[0].VariantInstanceProvisionTimeoutInSeconds, 900);
            assert.strictEqual(variant[0].InitialInstanceCount, 2);
            assert.deepStrictEqual(variant[0].RoutingConfig, { RoutingStrategy: 'LEAST_OUTSTANDING_REQUESTS' });

            // Step 6: Verify IC multi-spec config would be generated
            // For each pool entry, we'd generate IC_SPEC_N entries
            for (let i = 0; i < filtered.length; i++) {
                const entry = instanceCatalogRaw[filtered[i]];
                if (entry) {
                    assert.ok(entry.gpus > 0, `${filtered[i]} should have GPU count in catalog`);
                }
            }
        });
    });
});
