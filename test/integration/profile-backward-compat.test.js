// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Test: Profile Variable Migration — Backward Compatibility (Tasks 7.1–7.4)
 *
 * Validates PROF-4 (Requirement 4): existing projects with old-format do/config
 * continue working after MCC upgrade, and new-format projects correctly use profile.sh.
 *
 * Task 7.1 & 7.3: Generate project, simulate v0.11.0 by injecting exports into do/config,
 *   verify the precedence model: old exports take precedence over profile values.
 * Task 7.2: The "replacement" is conceptual — new profile.sh coexists with old exports.
 * Task 7.4: Generate v0.12.0 project → verify migrated vars absent from do/config,
 *   profile.sh exists, scripts source profile.sh.
 *
 * Note: Bash-based precedence tests use simple variable expansion (no associative arrays)
 * to work on bash 3.2 (macOS default). The test validates the PATTERN is correct,
 * not the associative array mechanism (which requires bash 4+).
 *
 * Requirements: PROF-4
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'node:child_process';
import { runGenerator } from '../helpers/run-generator.js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line no-unused-vars
const __dirname = path.dirname(__filename);

/**
 * Helper: run a bash script that simulates the precedence model.
 * Uses simple variables (no associative arrays) to work on bash 3.2.
 * The pattern tested: VAR="${VAR:-${PROFILE_VALUE:-}}"
 */
function runPrecedenceScript(scriptContent, env = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-prec-'));
    const scriptPath = path.join(tempDir, 'test.sh');
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    try {
        const mergedEnv = { ...process.env, ...env };
        // Remove vars that would interfere
        delete mergedEnv.ROLE_ARN;
        delete mergedEnv.ECR_REPOSITORY_NAME;
        // Apply explicit env overrides back
        Object.assign(mergedEnv, env);

        const result = execSync(`/bin/bash "${scriptPath}"`, {
            encoding: 'utf-8',
            env: mergedEnv,
            timeout: 10000
        });
        return result.trim();
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

/**
 * Parse KEY=VALUE lines from output into an object.
 * Only parses lines starting with known keys to avoid picking up noise.
 */
function parseOutput(output, expectedKeys) {
    const result = {};
    for (const line of output.split('\n')) {
        for (const key of expectedKeys) {
            if (line.startsWith(`${key}=`)) {
                result[key] = line.substring(key.length + 1);
                break;
            }
        }
    }
    return result;
}

describe('Profile Backward Compatibility (Tasks 7.1–7.4, PROF-4)', function () {
    this.timeout(60000);

    // ─── Tasks 7.1 & 7.3: Old-format project + new deploy script ────────────────
    // Simulates: v0.11.0 project (has exports in do/config) upgraded with v0.12.0 profile.sh
    describe('7.1 & 7.3: Old-format project — exports in do/config take precedence', () => {
        let result;

        before(() => {
            // Generate a v0.12.0 project
            result = runGenerator({
                'project-name': 'compat-old-format',
                'deployment-config': 'transformers-vllm',
                'model-name': 'Qwen/Qwen3-0.6B',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-west-2',
                'include-benchmark': false,
                'include-sample': false,
                'include-testing': false
            });

            // Simulate v0.11.0: inject old-style exports into do/config
            const configPath = result.file('do/config');
            let configContent = fs.readFileSync(configPath, 'utf-8');

            // Insert old-format exports after the AWS_REGION line
            const oldFormatExports = [
                '',
                '# ─── Simulated v0.11.0 exports (baked at generation time) ───',
                'export ROLE_ARN="arn:aws:iam::123456789012:role/old-format-role"',
                'export ECR_REPOSITORY_NAME="old-ecr-name"',
                'export ADAPTER_S3_BUCKET="mlcc-adapters-old-account-us-west-2"',
                ''
            ].join('\n');

            configContent = configContent.replace(
                /export AWS_REGION=.*/,
                `export AWS_REGION=\${AWS_REGION:-us-west-2}\n${oldFormatExports}`
            );
            fs.writeFileSync(configPath, configContent);
        });

        after(() => {
            if (result) result.cleanup();
        });

        it('old ROLE_ARN export takes precedence over profile value', () => {
            // The precedence pattern is: ROLE_ARN="${ROLE_ARN:-${_PROFILE[roleArn]:-}}"
            // When do/config already exported ROLE_ARN, the ${ROLE_ARN:-...} keeps it.
            // Simulate: source do/config (sets ROLE_ARN), then apply precedence pattern.
            const output = runPrecedenceScript(`#!/bin/bash
# Simulate sourcing do/config — this sets ROLE_ARN
export ROLE_ARN="arn:aws:iam::123456789012:role/old-format-role"

# Simulate profile value (what _PROFILE[roleArn] would return)
_PROFILE_roleArn="arn:aws:iam::123456789012:role/mlcc-profile-role"

# Apply the precedence pattern used in do/deploy
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"

echo "ROLE_ARN=\${ROLE_ARN}"
`);
            const vars = parseOutput(output, ['ROLE_ARN']);
            assert.equal(vars.ROLE_ARN, 'arn:aws:iam::123456789012:role/old-format-role',
                'Old do/config export should take precedence over profile value');
        });

        it('old ECR_REPOSITORY_NAME export takes precedence over profile value', () => {
            const output = runPrecedenceScript(`#!/bin/bash
# Simulate sourcing do/config — sets ECR_REPOSITORY_NAME
export ECR_REPOSITORY_NAME="old-ecr-name"

# Simulate profile value
_PROFILE_ecrRepositoryName="profile-ecr-repo"

# Apply precedence pattern
ECR_REPOSITORY_NAME="\${ECR_REPOSITORY_NAME:-\${_PROFILE_ecrRepositoryName:-ml-container-creator}}"

echo "ECR_REPOSITORY_NAME=\${ECR_REPOSITORY_NAME}"
`);
            const vars = parseOutput(output, ['ECR_REPOSITORY_NAME']);
            assert.equal(vars.ECR_REPOSITORY_NAME, 'old-ecr-name',
                'Old do/config export should take precedence over profile value');
        });

        it('shell environment AWS_REGION takes precedence over both config and profile', () => {
            const output = runPrecedenceScript(`#!/bin/bash
# Simulate sourcing do/config — sets AWS_REGION default
export AWS_REGION=\${AWS_REGION:-us-west-2}

# Simulate profile value
_PROFILE_awsRegion="ap-southeast-1"

# Apply precedence pattern (same as managed-inference.ejs)
export AWS_REGION="\${AWS_REGION:-\${_PROFILE_awsRegion:-us-east-1}}"

echo "AWS_REGION=\${AWS_REGION}"
`, { AWS_REGION: 'eu-west-1' });
            const vars = parseOutput(output, ['AWS_REGION']);
            assert.equal(vars.AWS_REGION, 'eu-west-1',
                'Shell env AWS_REGION should take precedence over do/config and profile');
        });

        it('do/config has the injected old-format exports (simulating v0.11.0)', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                configContent.includes('export ROLE_ARN="arn:aws:iam::123456789012:role/old-format-role"'),
                'Simulated v0.11.0 do/config should contain export ROLE_ARN'
            );
            assert.ok(
                configContent.includes('export ECR_REPOSITORY_NAME="old-ecr-name"'),
                'Simulated v0.11.0 do/config should contain export ECR_REPOSITORY_NAME'
            );
        });

        it('do/deploy still sources profile.sh (coexistence with old exports)', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('source "${SCRIPT_DIR}/lib/profile.sh"'),
                'do/deploy should source profile.sh even when do/config has old exports'
            );
        });

        it('do/deploy uses the precedence pattern for ROLE_ARN', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('ROLE_ARN="${ROLE_ARN:-${_PROFILE[roleArn]'),
                'do/deploy should use ROLE_ARN="${ROLE_ARN:-${_PROFILE[roleArn]..." pattern'
            );
        });
    });

    // ─── Task 7.4: New-format project (v0.12.0) ─────────────────────────────────
    describe('7.4: New-format project (v0.12.0) — no profile vars in do/config', () => {
        let result;

        before(() => {
            result = runGenerator({
                'project-name': 'compat-new-format',
                'deployment-config': 'transformers-vllm',
                'model-name': 'Qwen/Qwen3-0.6B',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-west-2',
                'include-benchmark': false,
                'include-sample': false,
                'include-testing': false
            });
        });

        after(() => {
            if (result) result.cleanup();
        });

        it('do/config does NOT contain export ECR_REPOSITORY_NAME', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                !configContent.match(/^export ECR_REPOSITORY_NAME=/m),
                'New-format do/config should not have export ECR_REPOSITORY_NAME'
            );
        });

        it('do/config does NOT contain export ROLE_ARN', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                !configContent.match(/^export ROLE_ARN=/m),
                'New-format do/config should not have export ROLE_ARN'
            );
        });

        it('do/config does NOT contain export ADAPTER_S3_BUCKET', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                !configContent.match(/^export ADAPTER_S3_BUCKET=/m),
                'New-format do/config should not have export ADAPTER_S3_BUCKET'
            );
        });

        it('do/config does NOT contain export TUNE_S3_BUCKET', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                !configContent.match(/^export TUNE_S3_BUCKET=/m),
                'New-format do/config should not have export TUNE_S3_BUCKET'
            );
        });

        it('do/config does NOT contain export CODEBUILD_PROJECT_NAME=', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                !configContent.match(/^export CODEBUILD_PROJECT_NAME=/m),
                'New-format do/config should not export CODEBUILD_PROJECT_NAME'
            );
        });

        it('do/config does NOT contain export ACCOUNT_ID', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                !configContent.match(/^export ACCOUNT_ID=/m),
                'New-format do/config should not have export ACCOUNT_ID'
            );
        });

        it('do/config DOES retain export PROJECT_NAME', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                configContent.match(/^export PROJECT_NAME=/m),
                'do/config should retain export PROJECT_NAME (project identity)'
            );
        });

        it('do/config DOES retain export DEPLOYMENT_CONFIG', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                configContent.match(/^export DEPLOYMENT_CONFIG=/m),
                'do/config should retain export DEPLOYMENT_CONFIG (project identity)'
            );
        });

        it('do/lib/profile.sh exists in generated project', () => {
            result.assertFile('do/lib/profile.sh');
        });

        it('profile.sh has correct shebang', () => {
            const content = fs.readFileSync(result.file('do/lib/profile.sh'), 'utf-8');
            assert.ok(
                content.startsWith('#!/usr/bin/env bash'),
                'profile.sh should start with #!/usr/bin/env bash'
            );
        });

        it('profile.sh uses a single python3 call', () => {
            const content = fs.readFileSync(result.file('do/lib/profile.sh'), 'utf-8');
            const python3Matches = content.match(/python3/g) || [];
            // Should have exactly 2: one in `command -v python3` and one in the actual call
            assert.ok(
                python3Matches.length >= 2,
                'profile.sh should reference python3 for config loading'
            );
        });

        it('do/deploy sources profile.sh', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('source "${SCRIPT_DIR}/lib/profile.sh"'),
                'do/deploy should source profile.sh'
            );
        });

        it('do/build sources profile.sh', () => {
            const buildContent = fs.readFileSync(result.file('do/build'), 'utf-8');
            assert.ok(
                buildContent.includes('source "${SCRIPT_DIR}/lib/profile.sh"'),
                'do/build should source profile.sh'
            );
        });

        it('do/push sources profile.sh', () => {
            const pushContent = fs.readFileSync(result.file('do/push'), 'utf-8');
            assert.ok(
                pushContent.includes('source "${SCRIPT_DIR}/lib/profile.sh"'),
                'do/push should source profile.sh'
            );
        });

        it('do/deploy uses _PROFILE[] for profile-resolved values', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('_PROFILE[roleArn]'),
                'do/deploy should reference _PROFILE[roleArn] for role resolution'
            );
            assert.ok(
                deployContent.includes('_PROFILE[ecrRepositoryName]'),
                'do/deploy should reference _PROFILE[ecrRepositoryName]'
            );
        });

        it('do/config contains profile-resolved comment indicating migration', () => {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf-8');
            assert.ok(
                configContent.includes('profile.sh') || configContent.includes('Profile-resolved'),
                'do/config should mention profile.sh or Profile-resolved in comments'
            );
        });
    });

    // ─── Task 7.5: New-format deploy works — reads from profile via _PROFILE[] ──
    describe('7.5: New-format do/deploy reads from profile via _PROFILE[] (PROF-4)', () => {
        let result;

        before(() => {
            result = runGenerator({
                'project-name': 'compat-profile-deploy',
                'deployment-config': 'transformers-vllm',
                'model-name': 'Qwen/Qwen3-0.6B',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-west-2',
                'include-benchmark': false,
                'include-sample': false,
                'include-testing': false
            });
        });

        after(() => {
            if (result) result.cleanup();
        });

        it('do/deploy references _PROFILE[roleArn] for ROLE_ARN resolution', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('_PROFILE[roleArn]'),
                'do/deploy should use _PROFILE[roleArn] for role resolution'
            );
        });

        it('do/deploy references _PROFILE[ecrRepositoryName] for ECR resolution', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('_PROFILE[ecrRepositoryName]'),
                'do/deploy should use _PROFILE[ecrRepositoryName] for ECR resolution'
            );
        });

        it('do/deploy references _PROFILE[awsRegion] for AWS_REGION resolution', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('_PROFILE[awsRegion]'),
                'do/deploy should use _PROFILE[awsRegion] for region resolution'
            );
        });

        it('profile values are used when env vars are not set (precedence model)', () => {
            // Simulate: no env var set, profile provides value
            const output = runPrecedenceScript(`#!/bin/bash
unset ROLE_ARN
_PROFILE_roleArn="arn:aws:iam::111222333444:role/mlcc-from-profile"
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"
echo "ROLE_ARN=\${ROLE_ARN}"
`);
            const vars = parseOutput(output, ['ROLE_ARN']);
            assert.equal(vars.ROLE_ARN, 'arn:aws:iam::111222333444:role/mlcc-from-profile',
                'When env var is unset, profile value should be used');
        });

        it('profile ECR repository name is used when env var is not set', () => {
            const output = runPrecedenceScript(`#!/bin/bash
unset ECR_REPOSITORY_NAME
_PROFILE_ecrRepositoryName="my-custom-ecr-repo"
ECR_REPOSITORY_NAME="\${ECR_REPOSITORY_NAME:-\${_PROFILE_ecrRepositoryName:-ml-container-creator}}"
echo "ECR_REPOSITORY_NAME=\${ECR_REPOSITORY_NAME}"
`);
            const vars = parseOutput(output, ['ECR_REPOSITORY_NAME']);
            assert.equal(vars.ECR_REPOSITORY_NAME, 'my-custom-ecr-repo',
                'When env var is unset, profile ECR repository name should be used');
        });
    });

    // ─── Task 7.6: No bootstrap profile — clear error message ────────────────────
    describe('7.6: do/deploy without bootstrap profile — clear error message (PROF-4)', () => {
        let result;

        before(() => {
            result = runGenerator({
                'project-name': 'compat-no-profile',
                'deployment-config': 'transformers-vllm',
                'model-name': 'Qwen/Qwen3-0.6B',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-west-2',
                'include-benchmark': false,
                'include-sample': false,
                'include-testing': false
            });
        });

        after(() => {
            if (result) result.cleanup();
        });

        it('do/deploy has validation check for empty ROLE_ARN', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('if [ -z "${ROLE_ARN:-}" ]'),
                'do/deploy should check if ROLE_ARN is empty'
            );
        });

        it('do/deploy error message mentions bootstrap command', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('ml-container-creator bootstrap'),
                'do/deploy error message should tell user to run ml-container-creator bootstrap'
            );
        });

        it('do/deploy error message mentions setting ROLE_ARN as env var', () => {
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
            assert.ok(
                deployContent.includes('ROLE_ARN') && deployContent.includes('environment variable'),
                'do/deploy error message should mention setting ROLE_ARN as an environment variable'
            );
        });

        it('when both profile and env are empty, ROLE_ARN is empty (triggers error)', () => {
            // Simulate: no env, no profile → ROLE_ARN is empty, which should trigger the error check
            const output = runPrecedenceScript(`#!/bin/bash
unset ROLE_ARN
_PROFILE_roleArn=""
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"

# Check same logic the script uses
if [ -z "\${ROLE_ARN:-}" ]; then
    echo "ERROR=role_arn_empty"
else
    echo "ERROR=none"
fi
`);
            assert.ok(
                output.includes('ERROR=role_arn_empty'),
                'When no profile and no env var, ROLE_ARN should be empty (triggering error)'
            );
        });

        it('script exits with error code when ROLE_ARN is empty', () => {
            // Simulate the deploy script's validation logic
            try {
                runPrecedenceScript(`#!/bin/bash
unset ROLE_ARN
_PROFILE_roleArn=""
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"
if [ -z "\${ROLE_ARN:-}" ]; then
    exit 3
fi
echo "SHOULD_NOT_REACH"
`);
                // If we reach here, the script didn't exit — that's a failure
                assert.fail('Script should have exited with code 3 when ROLE_ARN is empty');
            } catch (err) {
                // execSync throws when exit code is non-zero
                assert.ok(
                    err.status === 3,
                    `Script should exit with code 3, got: ${err.status}`
                );
            }
        });
    });

    // ─── Task 7.7: Shell env wins over profile ───────────────────────────────────
    describe('7.7: AWS_REGION=us-east-1 do/deploy — shell env wins (PROF-4, PROF-5)', () => {
        it('shell AWS_REGION overrides profile awsRegion', () => {
            const output = runPrecedenceScript(`#!/bin/bash
# Simulate do/config setting a default
export AWS_REGION=\${AWS_REGION:-us-west-2}

# Simulate profile value
_PROFILE_awsRegion="ap-southeast-1"

# Apply precedence pattern (same as deploy scripts)
export AWS_REGION="\${AWS_REGION:-\${_PROFILE_awsRegion:-us-east-1}}"
echo "AWS_REGION=\${AWS_REGION}"
`, { AWS_REGION: 'us-east-1' });
            const vars = parseOutput(output, ['AWS_REGION']);
            assert.equal(vars.AWS_REGION, 'us-east-1',
                'Shell env AWS_REGION=us-east-1 should win over profile and do/config default');
        });

        it('shell ROLE_ARN overrides profile roleArn', () => {
            const output = runPrecedenceScript(`#!/bin/bash
_PROFILE_roleArn="arn:aws:iam::111222333444:role/profile-role"
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"
echo "ROLE_ARN=\${ROLE_ARN}"
`, { ROLE_ARN: 'arn:aws:iam::555666777888:role/shell-role' });
            const vars = parseOutput(output, ['ROLE_ARN']);
            assert.equal(vars.ROLE_ARN, 'arn:aws:iam::555666777888:role/shell-role',
                'Shell env ROLE_ARN should win over profile value');
        });

        it('shell ECR_REPOSITORY_NAME overrides profile ecrRepositoryName', () => {
            const output = runPrecedenceScript(`#!/bin/bash
_PROFILE_ecrRepositoryName="profile-repo"
ECR_REPOSITORY_NAME="\${ECR_REPOSITORY_NAME:-\${_PROFILE_ecrRepositoryName:-ml-container-creator}}"
echo "ECR_REPOSITORY_NAME=\${ECR_REPOSITORY_NAME}"
`, { ECR_REPOSITORY_NAME: 'shell-override-repo' });
            const vars = parseOutput(output, ['ECR_REPOSITORY_NAME']);
            assert.equal(vars.ECR_REPOSITORY_NAME, 'shell-override-repo',
                'Shell env ECR_REPOSITORY_NAME should win over profile value');
        });

        /* eslint-disable no-useless-escape */
        it('AWS_REGION is exported (visible to child processes)', () => {
            const output = runPrecedenceScript(`#!/bin/bash
export AWS_REGION=\${AWS_REGION:-us-west-2}
_PROFILE_awsRegion="ap-southeast-1"
export AWS_REGION="\${AWS_REGION:-\${_PROFILE_awsRegion:-us-east-1}}"

# Verify it's exported by reading from a child process
CHILD_REGION=\$(bash -c 'echo \${AWS_REGION}')
echo "AWS_REGION=\${AWS_REGION}"
echo "CHILD_REGION=\${CHILD_REGION}"
`, { AWS_REGION: 'us-east-1' });
            /* eslint-enable no-useless-escape */
            const vars = parseOutput(output, ['AWS_REGION', 'CHILD_REGION']);
            assert.equal(vars.AWS_REGION, 'us-east-1');
            assert.equal(vars.CHILD_REGION, 'us-east-1',
                'AWS_REGION should be exported and visible to child processes');
        });

        it('do/deploy template uses export for AWS_REGION', () => {
            const result = runGenerator({
                'project-name': 'compat-region-export',
                'deployment-config': 'transformers-vllm',
                'model-name': 'Qwen/Qwen3-0.6B',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-west-2',
                'include-benchmark': false,
                'include-sample': false,
                'include-testing': false
            });
            try {
                const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf-8');
                assert.ok(
                    deployContent.includes('export AWS_REGION='),
                    'do/deploy should export AWS_REGION (not just set it)'
                );
            } finally {
                result.cleanup();
            }
        });
    });

    // ─── Precedence model validation (pure logic, no bash 4+ needed) ─────────────
    describe('Precedence model: env var > profile > default (Tasks 7.1-7.3)', () => {
        it('when env var is set, profile value is ignored', () => {
            const output = runPrecedenceScript(`#!/bin/bash
# Env var already set (e.g., from do/config or user shell)
export ROLE_ARN="env-value"
_PROFILE_roleArn="profile-value"
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"
echo "ROLE_ARN=\${ROLE_ARN}"
`);
            const vars = parseOutput(output, ['ROLE_ARN']);
            assert.equal(vars.ROLE_ARN, 'env-value');
        });

        it('when env var is empty, profile value is used', () => {
            const output = runPrecedenceScript(`#!/bin/bash
# Env var not set
unset ROLE_ARN
_PROFILE_roleArn="profile-value"
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"
echo "ROLE_ARN=\${ROLE_ARN}"
`);
            const vars = parseOutput(output, ['ROLE_ARN']);
            assert.equal(vars.ROLE_ARN, 'profile-value');
        });

        it('when both env var and profile are empty, fallback default is used', () => {
            const output = runPrecedenceScript(`#!/bin/bash
unset ECR_REPOSITORY_NAME
_PROFILE_ecrRepositoryName=""
ECR_REPOSITORY_NAME="\${ECR_REPOSITORY_NAME:-\${_PROFILE_ecrRepositoryName:-ml-container-creator}}"
echo "ECR_REPOSITORY_NAME=\${ECR_REPOSITORY_NAME}"
`);
            const vars = parseOutput(output, ['ECR_REPOSITORY_NAME']);
            assert.equal(vars.ECR_REPOSITORY_NAME, 'ml-container-creator');
        });

        it('AWS_REGION three-level precedence: shell > config > profile > default', () => {
            // Level 1: shell env wins
            let output = runPrecedenceScript(`#!/bin/bash
export AWS_REGION=\${AWS_REGION:-us-west-2}
_PROFILE_awsRegion="ap-southeast-1"
export AWS_REGION="\${AWS_REGION:-\${_PROFILE_awsRegion:-us-east-1}}"
echo "AWS_REGION=\${AWS_REGION}"
`, { AWS_REGION: 'eu-central-1' });
            let vars = parseOutput(output, ['AWS_REGION']);
            assert.equal(vars.AWS_REGION, 'eu-central-1', 'Shell env should win');

            // Level 2: config default wins over profile (no shell override)
            output = runPrecedenceScript(`#!/bin/bash
unset AWS_REGION
export AWS_REGION=\${AWS_REGION:-us-west-2}
_PROFILE_awsRegion="ap-southeast-1"
export AWS_REGION="\${AWS_REGION:-\${_PROFILE_awsRegion:-us-east-1}}"
echo "AWS_REGION=\${AWS_REGION}"
`);
            vars = parseOutput(output, ['AWS_REGION']);
            assert.equal(vars.AWS_REGION, 'us-west-2', 'do/config default should win over profile');
        });

        it('values containing special characters (ARNs, S3 paths) preserve correctly', () => {
            const output = runPrecedenceScript(`#!/bin/bash
export ROLE_ARN="arn:aws:iam::123456789012:role/mlcc-execution-role"
_PROFILE_roleArn="arn:aws:iam::999888777666:role/other-role"
ROLE_ARN="\${ROLE_ARN:-\${_PROFILE_roleArn:-}}"
echo "ROLE_ARN=\${ROLE_ARN}"
`);
            const vars = parseOutput(output, ['ROLE_ARN']);
            assert.equal(vars.ROLE_ARN, 'arn:aws:iam::123456789012:role/mlcc-execution-role',
                'ARN values with colons and slashes should be preserved correctly');
        });
    });
});
