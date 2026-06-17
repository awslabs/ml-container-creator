// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile Loader Unit Tests
 *
 * Tests that templates/do/lib/profile.sh correctly loads bootstrap profile
 * values into _PROFILE_<key> variables and handles missing/invalid configs.
 *
 * Requirements: PROF-1
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROFILE_SH = join(__dirname, '..', '..', 'templates', 'do', 'lib', 'profile.sh');

/**
 * Helper: write a bash test script to a temp file and execute it.
 * Uses the same set -e / set -u context that real do/ scripts use.
 */
function runProfileLoader(homeDir, extraScript = '') {
    const scriptPath = join(homeDir, '_test_runner.sh');
    const scriptContent = `#!/usr/bin/env bash
set -e
set -o pipefail
export HOME="${homeDir}"
source "${PROFILE_SH}"
${extraScript}
`;
    writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    const result = execSync(`bash "${scriptPath}"`, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: homeDir },
        timeout: 10000
    });
    return result;
}

describe('profile.sh — missing config.json', () => {
    it('should not crash when ~/.ml-container-creator/config.json does not exist', () => {
        const tempHome = mkdtempSync(join(tmpdir(), 'profile-test-'));

        // No config.json created — directory doesn't even have .ml-container-creator/
        const output = runProfileLoader(tempHome, 'echo "EXIT_OK"');
        assert.ok(output.includes('EXIT_OK'), 'Script should complete without crashing');
    });

    it('should have no _PROFILE_ variables set when config is missing', () => {
        const tempHome = mkdtempSync(join(tmpdir(), 'profile-test-'));

        const output = runProfileLoader(tempHome, 'echo "VARS=$(env | grep -c "^_PROFILE_" || echo 0)"');
        assert.ok(output.includes('VARS=0'), `Expected 0 _PROFILE_ vars, got: ${output.trim()}`);
    });

    it('should not crash when .ml-container-creator directory exists but config.json is missing', () => {
        const tempHome = mkdtempSync(join(tmpdir(), 'profile-test-'));
        mkdirSync(join(tempHome, '.ml-container-creator'), { recursive: true });

        const output = runProfileLoader(tempHome, 'echo "EXIT_OK"');
        assert.ok(output.includes('EXIT_OK'), 'Script should complete without crashing');
    });

    it('should have empty _PROFILE_ values when config.json is missing', () => {
        const tempHome = mkdtempSync(join(tmpdir(), 'profile-test-'));
        mkdirSync(join(tempHome, '.ml-container-creator'), { recursive: true });

        const output = runProfileLoader(tempHome, `
echo "REGION=\${_PROFILE_awsRegion:-EMPTY}"
echo "ACCOUNT=\${_PROFILE_accountId:-EMPTY}"
echo "ROLE=\${_PROFILE_roleArn:-EMPTY}"
echo "ECR=\${_PROFILE_ecrRepositoryName:-EMPTY}"
`);
        assert.ok(output.includes('REGION=EMPTY'), `awsRegion should be empty, got: ${output}`);
        assert.ok(output.includes('ACCOUNT=EMPTY'), `accountId should be empty, got: ${output}`);
        assert.ok(output.includes('ROLE=EMPTY'), `roleArn should be empty, got: ${output}`);
        assert.ok(output.includes('ECR=EMPTY'), `ecrRepositoryName should be empty, got: ${output}`);
    });

    it('should not crash when config.json is an empty file', () => {
        const tempHome = mkdtempSync(join(tmpdir(), 'profile-test-'));
        const configDir = join(tempHome, '.ml-container-creator');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), '');

        const output = runProfileLoader(tempHome, 'echo "EXIT_OK"');
        assert.ok(output.includes('EXIT_OK'), 'Script should complete without crashing');
    });

    it('should not crash when config.json contains invalid JSON', () => {
        const tempHome = mkdtempSync(join(tmpdir(), 'profile-test-'));
        const configDir = join(tempHome, '.ml-container-creator');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), 'not valid json {{{');

        const output = runProfileLoader(tempHome, 'echo "EXIT_OK"');
        assert.ok(output.includes('EXIT_OK'), 'Script should complete without crashing');
    });

    it('should load values from a valid config.json', () => {
        const tempHome = mkdtempSync(join(tmpdir(), 'profile-test-'));
        const configDir = join(tempHome, '.ml-container-creator');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            activeProfile: 'test',
            profiles: {
                test: {
                    awsRegion: 'us-west-2',
                    accountId: '123456789012',
                    roleArn: 'arn:aws:iam::123456789012:role/test-role',
                    ecrRepositoryName: 'my-ecr-repo'
                }
            }
        }));

        const output = runProfileLoader(tempHome, `
echo "REGION=\${_PROFILE_awsRegion:-EMPTY}"
echo "ACCOUNT=\${_PROFILE_accountId:-EMPTY}"
echo "ROLE=\${_PROFILE_roleArn:-EMPTY}"
echo "ECR=\${_PROFILE_ecrRepositoryName:-EMPTY}"
`);
        assert.ok(output.includes('REGION=us-west-2'), `awsRegion should be us-west-2, got: ${output}`);
        assert.ok(output.includes('ACCOUNT=123456789012'), `accountId should be 123456789012, got: ${output}`);
        assert.ok(output.includes('ROLE=arn:aws:iam::123456789012:role/test-role'), `roleArn should be the ARN, got: ${output}`);
        assert.ok(output.includes('ECR=my-ecr-repo'), `ecrRepositoryName should be my-ecr-repo, got: ${output}`);
    });
});
