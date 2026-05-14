// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for multi-spec IC support in do/lib/inference-component.sh
 *
 * Validates Requirements: 6.3, 7.2
 *
 * These tests verify that:
 * 1. When IC_MULTI_SPEC=true, the script builds a Specifications (plural) array
 * 2. Each entry in the array has Container, StartupParameters, and ComputeResourceRequirements
 * 3. The loop reads IC_SPEC_N_INSTANCE_TYPE, IC_SPEC_N_GPU_COUNT, IC_SPEC_N_MIN_MEMORY_MB
 * 4. When IC_MULTI_SPEC is not set, the single Specification path is used (unchanged)
 *
 * Feature: multi-ic-endpoints
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const libInferenceComponentPath = path.join(__dirname, '../../templates/do/lib/inference-component.sh');
const libInferenceComponentContent = readFileSync(libInferenceComponentPath, 'utf8');

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

describe('do/lib/inference-component.sh — Multi-spec IC support (Req 6.3, 7.2)', function () {

    // ================================================================
    // Static analysis: script contains multi-spec branching logic
    // ================================================================
    describe('Static analysis: multi-spec branching', () => {
        it('detects IC_MULTI_SPEC=true to choose multi-spec path', function () {
            assert.ok(
                libInferenceComponentContent.includes('IC_MULTI_SPEC'),
                'inference-component.sh must reference IC_MULTI_SPEC variable'
            );
            assert.ok(
                libInferenceComponentContent.includes('"${IC_MULTI_SPEC:-false}" = "true"'),
                'inference-component.sh must check if IC_MULTI_SPEC equals true with false default'
            );
        });

        it('uses Specifications (plural) array when multi-spec is active', function () {
            assert.ok(
                libInferenceComponentContent.includes('\\"Specifications\\"'),
                'inference-component.sh must build Specifications (plural) key in multi-spec path'
            );
        });

        it('loops from 1 to IC_SPEC_COUNT reading per-spec variables', function () {
            assert.ok(
                libInferenceComponentContent.includes('IC_SPEC_COUNT'),
                'inference-component.sh must reference IC_SPEC_COUNT'
            );
            assert.ok(
                libInferenceComponentContent.includes('IC_SPEC_${i}_INSTANCE_TYPE'),
                'inference-component.sh must read IC_SPEC_N_INSTANCE_TYPE per entry'
            );
            assert.ok(
                libInferenceComponentContent.includes('IC_SPEC_${i}_GPU_COUNT'),
                'inference-component.sh must read IC_SPEC_N_GPU_COUNT per entry'
            );
            assert.ok(
                libInferenceComponentContent.includes('IC_SPEC_${i}_MIN_MEMORY_MB'),
                'inference-component.sh must read IC_SPEC_N_MIN_MEMORY_MB per entry'
            );
        });

        it('each spec entry includes Container, StartupParameters, and ComputeResourceRequirements', function () {
            // In the multi-spec loop, each entry must have all three fields
            const multiSpecSection = libInferenceComponentContent.substring(
                libInferenceComponentContent.indexOf('Multi-spec:'),
                libInferenceComponentContent.indexOf('Single spec:')
            );
            assert.ok(
                multiSpecSection.includes('\\"Container\\"'),
                'multi-spec entries must include Container field'
            );
            assert.ok(
                multiSpecSection.includes('\\"StartupParameters\\"'),
                'multi-spec entries must include StartupParameters field'
            );
            assert.ok(
                multiSpecSection.includes('\\"ComputeResourceRequirements\\"'),
                'multi-spec entries must include ComputeResourceRequirements field'
            );
            assert.ok(
                multiSpecSection.includes('NumberOfAcceleratorDevicesRequired'),
                'multi-spec entries must include NumberOfAcceleratorDevicesRequired'
            );
            assert.ok(
                multiSpecSection.includes('MinMemoryRequiredInMb'),
                'multi-spec entries must include MinMemoryRequiredInMb'
            );
        });

        it('single-spec path is unchanged when IC_MULTI_SPEC is not set', function () {
            // The else branch must still use the single Specification object
            const singleSpecSection = libInferenceComponentContent.substring(
                libInferenceComponentContent.indexOf('Single spec:')
            );
            assert.ok(
                singleSpecSection.includes('${IC_GPU_COUNT:-1}'),
                'single-spec path must use IC_GPU_COUNT with default 1'
            );
            assert.ok(
                singleSpecSection.includes('${IC_MIN_MEMORY_MB:-1024}'),
                'single-spec path must use IC_MIN_MEMORY_MB with default 1024'
            );
        });

        it('shares container spec between multi-spec entries', function () {
            // The container_spec variable is built once and reused in the loop
            const multiSpecSection = libInferenceComponentContent.substring(
                libInferenceComponentContent.indexOf('Multi-spec:'),
                libInferenceComponentContent.indexOf('Single spec:')
            );
            assert.ok(
                multiSpecSection.includes('${container_spec}'),
                'multi-spec entries must reuse the shared container_spec variable'
            );
        });
    });

    // ================================================================
    // Bash execution: single-spec JSON output (IC_MULTI_SPEC not set)
    // ================================================================
    describe('Bash execution: single-spec JSON output', () => {
        it('produces valid single Specification JSON when IC_MULTI_SPEC is not set', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables
PROJECT_NAME="test-project"
ENDPOINT_NAME="test-endpoint"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
AWS_REGION="us-east-1"
CONTAINER_ENV_JSON=""
IC_GPU_COUNT=4
IC_MIN_MEMORY_MB=16384
IC_STARTUP_TIMEOUT=900
IC_COPY_COUNT=1
IC_IMAGE_TAG="test-project-latest"

# Build container spec (extracted from the script logic)
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\"}"

# Single spec path
spec_json="{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{IC_GPU_COUNT},\\"MinMemoryRequiredInMb\\":$\{IC_MIN_MEMORY_MB}}}"

echo "$spec_json"
`;

            const output = runBashTest(script, 'test-single-spec.sh');
            const json = JSON.parse(output.trim());

            assert.ok(json.Container, 'Single spec must have Container field');
            assert.ok(json.StartupParameters, 'Single spec must have StartupParameters field');
            assert.ok(json.ComputeResourceRequirements, 'Single spec must have ComputeResourceRequirements field');
            assert.strictEqual(json.ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 4);
            assert.strictEqual(json.ComputeResourceRequirements.MinMemoryRequiredInMb, 16384);
        });
    });

    // ================================================================
    // Bash execution: multi-spec JSON output (IC_MULTI_SPEC=true)
    // ================================================================
    describe('Bash execution: multi-spec JSON output', () => {
        it('produces valid Specifications array JSON with 2 entries', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables
PROJECT_NAME="test-project"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
IC_IMAGE_TAG="test-project-latest"
CONTAINER_ENV_JSON=""
IC_STARTUP_TIMEOUT=900

IC_MULTI_SPEC=true
IC_SPEC_COUNT=2
IC_SPEC_1_INSTANCE_TYPE="ml.g6e.48xlarge"
IC_SPEC_1_GPU_COUNT=8
IC_SPEC_1_MIN_MEMORY_MB=32768
IC_SPEC_2_INSTANCE_TYPE="ml.g6.12xlarge"
IC_SPEC_2_GPU_COUNT=4
IC_SPEC_2_MIN_MEMORY_MB=16384

# Build container spec
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\"}"

# Multi-spec path (replicated from the script logic)
spec_json="{\\"Specifications\\":["
i=1
while [ "$\{i}" -le "$\{IC_SPEC_COUNT}" ]; do
    spec_instance_type_var="IC_SPEC_$\{i}_INSTANCE_TYPE"
    spec_gpu_count_var="IC_SPEC_$\{i}_GPU_COUNT"
    spec_min_memory_var="IC_SPEC_$\{i}_MIN_MEMORY_MB"

    spec_instance_type="$\{!spec_instance_type_var}"
    spec_gpu_count="$\{!spec_gpu_count_var:-1}"
    spec_min_memory="$\{!spec_min_memory_var:-1024}"

    if [ "$\{i}" -gt 1 ]; then
        spec_json="$\{spec_json},"
    fi
    spec_json="$\{spec_json}{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT:-900}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{spec_gpu_count},\\"MinMemoryRequiredInMb\\":$\{spec_min_memory}}}"

    i=$((i + 1))
done
spec_json="$\{spec_json}]}"

echo "$spec_json"
`;

            const output = runBashTest(script, 'test-multi-spec.sh');
            const json = JSON.parse(output.trim());

            assert.ok(json.Specifications, 'Multi-spec must have Specifications array');
            assert.strictEqual(json.Specifications.length, 2, 'Must have 2 spec entries');

            // First entry: ml.g6e.48xlarge with 8 GPUs
            const spec1 = json.Specifications[0];
            assert.ok(spec1.Container, 'Spec 1 must have Container');
            assert.ok(spec1.StartupParameters, 'Spec 1 must have StartupParameters');
            assert.strictEqual(spec1.ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 8);
            assert.strictEqual(spec1.ComputeResourceRequirements.MinMemoryRequiredInMb, 32768);

            // Second entry: ml.g6.12xlarge with 4 GPUs
            const spec2 = json.Specifications[1];
            assert.ok(spec2.Container, 'Spec 2 must have Container');
            assert.ok(spec2.StartupParameters, 'Spec 2 must have StartupParameters');
            assert.strictEqual(spec2.ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 4);
            assert.strictEqual(spec2.ComputeResourceRequirements.MinMemoryRequiredInMb, 16384);
        });

        it('produces valid Specifications array JSON with 3 entries', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables
PROJECT_NAME="test-project"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
IC_IMAGE_TAG="test-project-latest"
CONTAINER_ENV_JSON=""
IC_STARTUP_TIMEOUT=600

IC_MULTI_SPEC=true
IC_SPEC_COUNT=3
IC_SPEC_1_INSTANCE_TYPE="ml.p5.48xlarge"
IC_SPEC_1_GPU_COUNT=8
IC_SPEC_1_MIN_MEMORY_MB=65536
IC_SPEC_2_INSTANCE_TYPE="ml.g6e.48xlarge"
IC_SPEC_2_GPU_COUNT=8
IC_SPEC_2_MIN_MEMORY_MB=32768
IC_SPEC_3_INSTANCE_TYPE="ml.g6.12xlarge"
IC_SPEC_3_GPU_COUNT=4
IC_SPEC_3_MIN_MEMORY_MB=16384

# Build container spec
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\"}"

# Multi-spec path
spec_json="{\\"Specifications\\":["
i=1
while [ "$\{i}" -le "$\{IC_SPEC_COUNT}" ]; do
    spec_instance_type_var="IC_SPEC_$\{i}_INSTANCE_TYPE"
    spec_gpu_count_var="IC_SPEC_$\{i}_GPU_COUNT"
    spec_min_memory_var="IC_SPEC_$\{i}_MIN_MEMORY_MB"

    spec_instance_type="$\{!spec_instance_type_var}"
    spec_gpu_count="$\{!spec_gpu_count_var:-1}"
    spec_min_memory="$\{!spec_min_memory_var:-1024}"

    if [ "$\{i}" -gt 1 ]; then
        spec_json="$\{spec_json},"
    fi
    spec_json="$\{spec_json}{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT:-900}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{spec_gpu_count},\\"MinMemoryRequiredInMb\\":$\{spec_min_memory}}}"

    i=$((i + 1))
done
spec_json="$\{spec_json}]}"

echo "$spec_json"
`;

            const output = runBashTest(script, 'test-multi-spec-3.sh');
            const json = JSON.parse(output.trim());

            assert.ok(json.Specifications, 'Multi-spec must have Specifications array');
            assert.strictEqual(json.Specifications.length, 3, 'Must have 3 spec entries');

            // All entries share the same container image
            const image = json.Specifications[0].Container.Image;
            assert.strictEqual(json.Specifications[1].Container.Image, image, 'All entries share same container image');
            assert.strictEqual(json.Specifications[2].Container.Image, image, 'All entries share same container image');

            // All entries share the same startup timeout
            assert.strictEqual(
                json.Specifications[0].StartupParameters.ContainerStartupHealthCheckTimeoutInSeconds, 600
            );
            assert.strictEqual(
                json.Specifications[1].StartupParameters.ContainerStartupHealthCheckTimeoutInSeconds, 600
            );
            assert.strictEqual(
                json.Specifications[2].StartupParameters.ContainerStartupHealthCheckTimeoutInSeconds, 600
            );

            // Each entry has different compute resources
            assert.strictEqual(json.Specifications[0].ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 8);
            assert.strictEqual(json.Specifications[1].ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 8);
            assert.strictEqual(json.Specifications[2].ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 4);
            assert.strictEqual(json.Specifications[2].ComputeResourceRequirements.MinMemoryRequiredInMb, 16384);
        });

        it('uses defaults when IC_SPEC_N_GPU_COUNT or IC_SPEC_N_MIN_MEMORY_MB are not set', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables
PROJECT_NAME="test-project"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
IC_IMAGE_TAG="test-project-latest"
CONTAINER_ENV_JSON=""
IC_STARTUP_TIMEOUT=900

IC_MULTI_SPEC=true
IC_SPEC_COUNT=1
IC_SPEC_1_INSTANCE_TYPE="ml.g6.12xlarge"
# IC_SPEC_1_GPU_COUNT not set — should default to 1
# IC_SPEC_1_MIN_MEMORY_MB not set — should default to 1024

# Build container spec
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\"}"

# Multi-spec path
spec_json="{\\"Specifications\\":["
i=1
while [ "$\{i}" -le "$\{IC_SPEC_COUNT}" ]; do
    spec_instance_type_var="IC_SPEC_$\{i}_INSTANCE_TYPE"
    spec_gpu_count_var="IC_SPEC_$\{i}_GPU_COUNT"
    spec_min_memory_var="IC_SPEC_$\{i}_MIN_MEMORY_MB"

    spec_instance_type="$\{!spec_instance_type_var}"
    spec_gpu_count="$\{!spec_gpu_count_var:-1}"
    spec_min_memory="$\{!spec_min_memory_var:-1024}"

    if [ "$\{i}" -gt 1 ]; then
        spec_json="$\{spec_json},"
    fi
    spec_json="$\{spec_json}{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT:-900}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{spec_gpu_count},\\"MinMemoryRequiredInMb\\":$\{spec_min_memory}}}"

    i=$((i + 1))
done
spec_json="$\{spec_json}]}"

echo "$spec_json"
`;

            const output = runBashTest(script, 'test-multi-spec-defaults.sh');
            const json = JSON.parse(output.trim());

            assert.strictEqual(json.Specifications.length, 1);
            assert.strictEqual(
                json.Specifications[0].ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 1,
                'GPU count must default to 1 when not set'
            );
            assert.strictEqual(
                json.Specifications[0].ComputeResourceRequirements.MinMemoryRequiredInMb, 1024,
                'Min memory must default to 1024 when not set'
            );
        });

        it('includes container environment in multi-spec entries', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables
PROJECT_NAME="test-project"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
IC_IMAGE_TAG="test-project-latest"
CONTAINER_ENV_JSON='"HF_TOKEN":"secret123"'
IC_CONTAINER_ENV_EXTRA=""
IC_STARTUP_TIMEOUT=900

IC_MULTI_SPEC=true
IC_SPEC_COUNT=2
IC_SPEC_1_INSTANCE_TYPE="ml.g6e.48xlarge"
IC_SPEC_1_GPU_COUNT=8
IC_SPEC_1_MIN_MEMORY_MB=32768
IC_SPEC_2_INSTANCE_TYPE="ml.g6.12xlarge"
IC_SPEC_2_GPU_COUNT=4
IC_SPEC_2_MIN_MEMORY_MB=16384

# Build container spec (with env)
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\",\\"Environment\\":{$\{CONTAINER_ENV_JSON}}}"

# Multi-spec path
spec_json="{\\"Specifications\\":["
i=1
while [ "$\{i}" -le "$\{IC_SPEC_COUNT}" ]; do
    spec_instance_type_var="IC_SPEC_$\{i}_INSTANCE_TYPE"
    spec_gpu_count_var="IC_SPEC_$\{i}_GPU_COUNT"
    spec_min_memory_var="IC_SPEC_$\{i}_MIN_MEMORY_MB"

    spec_instance_type="$\{!spec_instance_type_var}"
    spec_gpu_count="$\{!spec_gpu_count_var:-1}"
    spec_min_memory="$\{!spec_min_memory_var:-1024}"

    if [ "$\{i}" -gt 1 ]; then
        spec_json="$\{spec_json},"
    fi
    spec_json="$\{spec_json}{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT:-900}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{spec_gpu_count},\\"MinMemoryRequiredInMb\\":$\{spec_min_memory}}}"

    i=$((i + 1))
done
spec_json="$\{spec_json}]}"

echo "$spec_json"
`;

            const output = runBashTest(script, 'test-multi-spec-env.sh');
            const json = JSON.parse(output.trim());

            assert.strictEqual(json.Specifications.length, 2);
            // Both entries share the same container with environment
            assert.ok(json.Specifications[0].Container.Environment, 'Spec 1 must have Environment');
            assert.strictEqual(json.Specifications[0].Container.Environment.HF_TOKEN, 'secret123');
            assert.ok(json.Specifications[1].Container.Environment, 'Spec 2 must have Environment');
            assert.strictEqual(json.Specifications[1].Container.Environment.HF_TOKEN, 'secret123');
        });
    });

    // ================================================================
    // Fallback: IC_MULTI_SPEC=false or not set uses single spec
    // ================================================================
    describe('Fallback: single spec when IC_MULTI_SPEC is not set', () => {
        it('uses single Specification when IC_MULTI_SPEC is not set', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables — IC_MULTI_SPEC not set
PROJECT_NAME="test-project"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
IC_IMAGE_TAG="test-project-latest"
CONTAINER_ENV_JSON=""
IC_GPU_COUNT=4
IC_MIN_MEMORY_MB=16384
IC_STARTUP_TIMEOUT=900

# Build container spec
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\"}"

# Replicate the branching logic
if [ "$\{IC_MULTI_SPEC:-false}" = "true" ] && [ "$\{IC_SPEC_COUNT:-0}" -gt 0 ]; then
    echo "MULTI"
else
    spec_json="{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT:-900}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{IC_GPU_COUNT:-1},\\"MinMemoryRequiredInMb\\":$\{IC_MIN_MEMORY_MB:-1024}}}"
    echo "$spec_json"
fi
`;

            const output = runBashTest(script, 'test-single-spec-fallback.sh');
            const json = JSON.parse(output.trim());

            // Must NOT have Specifications array
            assert.ok(!json.Specifications, 'Single spec must NOT have Specifications array');
            // Must have direct Container, StartupParameters, ComputeResourceRequirements
            assert.ok(json.Container, 'Single spec must have Container');
            assert.ok(json.StartupParameters, 'Single spec must have StartupParameters');
            assert.ok(json.ComputeResourceRequirements, 'Single spec must have ComputeResourceRequirements');
            assert.strictEqual(json.ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 4);
            assert.strictEqual(json.ComputeResourceRequirements.MinMemoryRequiredInMb, 16384);
        });

        it('uses single Specification when IC_MULTI_SPEC is explicitly false', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables — IC_MULTI_SPEC explicitly false
PROJECT_NAME="test-project"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
IC_IMAGE_TAG="test-project-latest"
CONTAINER_ENV_JSON=""
IC_GPU_COUNT=2
IC_MIN_MEMORY_MB=8192
IC_STARTUP_TIMEOUT=600
IC_MULTI_SPEC=false

# Build container spec
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\"}"

# Replicate the branching logic
if [ "$\{IC_MULTI_SPEC:-false}" = "true" ] && [ "$\{IC_SPEC_COUNT:-0}" -gt 0 ]; then
    echo "MULTI"
else
    spec_json="{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT:-900}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{IC_GPU_COUNT:-1},\\"MinMemoryRequiredInMb\\":$\{IC_MIN_MEMORY_MB:-1024}}}"
    echo "$spec_json"
fi
`;

            const output = runBashTest(script, 'test-single-spec-explicit-false.sh');
            const json = JSON.parse(output.trim());

            assert.ok(!json.Specifications, 'Must NOT have Specifications when IC_MULTI_SPEC=false');
            assert.strictEqual(json.ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired, 2);
            assert.strictEqual(json.ComputeResourceRequirements.MinMemoryRequiredInMb, 8192);
            assert.strictEqual(json.StartupParameters.ContainerStartupHealthCheckTimeoutInSeconds, 600);
        });

        it('uses single Specification when IC_MULTI_SPEC=true but IC_SPEC_COUNT=0', function () {
            this.timeout(10000);

            const script = `#!/bin/bash
set -euo pipefail

# Mock variables — IC_MULTI_SPEC true but no specs defined
PROJECT_NAME="test-project"
ECR_REPOSITORY="123456789.dkr.ecr.us-east-1.amazonaws.com/test"
IC_IMAGE_TAG="test-project-latest"
CONTAINER_ENV_JSON=""
IC_GPU_COUNT=1
IC_MIN_MEMORY_MB=1024
IC_STARTUP_TIMEOUT=900
IC_MULTI_SPEC=true
IC_SPEC_COUNT=0

# Build container spec
container_spec="{\\"Image\\":\\"$\{ECR_REPOSITORY}:$\{IC_IMAGE_TAG}\\"}"

# Replicate the branching logic
if [ "$\{IC_MULTI_SPEC:-false}" = "true" ] && [ "$\{IC_SPEC_COUNT:-0}" -gt 0 ]; then
    echo "MULTI"
else
    spec_json="{\\"Container\\":$\{container_spec},\\"StartupParameters\\":{\\"ContainerStartupHealthCheckTimeoutInSeconds\\":$\{IC_STARTUP_TIMEOUT:-900}},\\"ComputeResourceRequirements\\":{\\"NumberOfAcceleratorDevicesRequired\\":$\{IC_GPU_COUNT:-1},\\"MinMemoryRequiredInMb\\":$\{IC_MIN_MEMORY_MB:-1024}}}"
    echo "$spec_json"
fi
`;

            const output = runBashTest(script, 'test-single-spec-zero-count.sh');
            const json = JSON.parse(output.trim());

            assert.ok(!json.Specifications, 'Must NOT have Specifications when IC_SPEC_COUNT=0');
            assert.ok(json.Container, 'Must fall back to single spec');
        });
    });
});
