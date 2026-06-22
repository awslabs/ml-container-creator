/**
 * Constraint tests for IC_ENV_* deploy-time environment variable injection.
 *
 * Tests the shell script logic by running bash scripts that replicate the
 * _collect_ic_env_vars function behavior:
 * - 17 vars → only 16 used with warning (AC-3.3)
 * - Key/value > 1024 chars → skipped with warning (AC-3.4)
 * - IC_ENV_FOO=bar produces correct Environment field
 *
 * Requirements: US-3 (AC-3.3, AC-3.4, AC-3.7)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Creates a temporary bash script that replicates the IC_ENV collection logic
 * from inference-component.sh, then runs it with the given env vars.
 */
function runIcEnvTest(envVars) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ic-env-test-'));
    const scriptPath = join(tmpDir, 'test.sh');

    const script = `#!/bin/bash
IC_ENV_OVERRIDE=""
ic_env_count=0
WARNINGS=""
SKIPPED=""

while IFS='=' read -r full_key value; do
    [ -z "\${full_key}" ] && continue

    stripped_key="\${full_key#IC_ENV_}"

    if [ \${#stripped_key} -gt 1024 ]; then
        SKIPPED="\${SKIPPED}KEY_\${stripped_key:0:20};"
        WARNINGS="\${WARNINGS}KEY_TOO_LONG;"
        continue
    fi

    if [ \${#value} -gt 1024 ]; then
        SKIPPED="\${SKIPPED}VAL_\${stripped_key};"
        WARNINGS="\${WARNINGS}VAL_TOO_LONG;"
        continue
    fi

    ic_env_count=$((ic_env_count + 1))

    if [ \${ic_env_count} -gt 16 ]; then
        WARNINGS="\${WARNINGS}EXCEEDED_16;"
        break
    fi

    if [ -n "\${IC_ENV_OVERRIDE}" ]; then
        IC_ENV_OVERRIDE="\${IC_ENV_OVERRIDE},"
    fi
    IC_ENV_OVERRIDE="\${IC_ENV_OVERRIDE}\\"\${stripped_key}\\":\\"\${value}\\""
done < <(env | grep "^IC_ENV_" | sort)

echo "OVERRIDE=\${IC_ENV_OVERRIDE}"
echo "COUNT=\${ic_env_count}"
echo "WARNINGS=\${WARNINGS}"
echo "SKIPPED=\${SKIPPED}"
`;

    writeFileSync(scriptPath, script, { mode: 0o755 });

    try {
        const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: '/bin/bash' };
        Object.assign(cleanEnv, envVars);

        const result = execSync(`bash "${scriptPath}"`, {
            encoding: 'utf-8',
            env: cleanEnv,
            timeout: 10000
        }).trim();

        const lines = result.split('\n');
        const parsed = {};
        for (const line of lines) {
            const eqIdx = line.indexOf('=');
            if (eqIdx > 0) {
                parsed[line.substring(0, eqIdx)] = line.substring(eqIdx + 1);
            }
        }
        return parsed;
    } finally {
        try { unlinkSync(scriptPath); } catch { /* ignore */ }
    }
}

describe('IC_ENV_* Constraint Validation (US-3)', () => {

    describe('IC_ENV_FOO=bar produces correct Environment (AC-3.7)', () => {

        it('single IC_ENV_FOO=bar produces "FOO":"bar" in override', () => {
            const result = runIcEnvTest({ IC_ENV_FOO: 'bar' });

            assert.ok(
                result.OVERRIDE.includes('"FOO":"bar"'),
                `Expected "FOO":"bar" in override, got: ${result.OVERRIDE}`
            );
            assert.strictEqual(result.COUNT, '1');
        });

        it('multiple IC_ENV vars produce correct JSON key-value pairs', () => {
            const result = runIcEnvTest({
                IC_ENV_ALPHA: 'one',
                IC_ENV_BETA: 'two'
            });

            assert.ok(
                result.OVERRIDE.includes('"ALPHA":"one"'),
                `Expected "ALPHA":"one" in override, got: ${result.OVERRIDE}`
            );
            assert.ok(
                result.OVERRIDE.includes('"BETA":"two"'),
                `Expected "BETA":"two" in override, got: ${result.OVERRIDE}`
            );
            assert.strictEqual(result.COUNT, '2');
        });

        it('IC_ENV vars are comma-separated', () => {
            const result = runIcEnvTest({
                IC_ENV_A: '1',
                IC_ENV_B: '2'
            });

            assert.ok(
                result.OVERRIDE.includes(','),
                `Expected comma-separated entries, got: ${result.OVERRIDE}`
            );
        });
    });

    describe('17 vars → only 16 used (AC-3.3)', () => {

        it('17 IC_ENV vars results in warning and only first 16 used', () => {
            const envVars = {};
            for (let i = 1; i <= 17; i++) {
                envVars[`IC_ENV_VAR_${String(i).padStart(2, '0')}`] = `value${i}`;
            }

            const result = runIcEnvTest(envVars);

            // Count should be 17 (the break happens after incrementing)
            assert.strictEqual(result.COUNT, '17',
                `Expected count=17 (count increments before break check), got: ${result.COUNT}`);
            // Warning should indicate exceeded 16
            assert.ok(
                result.WARNINGS.includes('EXCEEDED_16'),
                `Expected EXCEEDED_16 warning, got: ${result.WARNINGS}`
            );
            // Only 16 entries should appear in the override (commas = entries - 1)
            const commaCount = (result.OVERRIDE.match(/,/g) || []).length;
            assert.strictEqual(commaCount, 15,
                `Expected 15 commas (16 entries), got: ${commaCount}`);
        });

        it('16 IC_ENV vars does NOT trigger warning', () => {
            const envVars = {};
            for (let i = 1; i <= 16; i++) {
                envVars[`IC_ENV_VAR_${String(i).padStart(2, '0')}`] = `value${i}`;
            }

            const result = runIcEnvTest(envVars);

            assert.strictEqual(result.COUNT, '16');
            assert.ok(
                !result.WARNINGS.includes('EXCEEDED_16'),
                'Expected no EXCEEDED_16 warning for exactly 16 vars'
            );
        });
    });

    describe('Key/value > 1024 chars → skipped (AC-3.4)', () => {

        it('value exceeding 1024 chars is skipped', () => {
            const longValue = 'x'.repeat(1025);
            const result = runIcEnvTest({
                IC_ENV_LONG_VAL: longValue,
                IC_ENV_GOOD_VAR: 'ok'
            });

            // LONG_VAL should be skipped
            assert.ok(
                result.SKIPPED.includes('VAL_LONG_VAL'),
                `Expected LONG_VAL to be skipped, got SKIPPED: ${result.SKIPPED}`
            );
            assert.ok(
                result.WARNINGS.includes('VAL_TOO_LONG'),
                `Expected VAL_TOO_LONG warning, got: ${result.WARNINGS}`
            );
            // Only GOOD_VAR should be counted
            assert.strictEqual(result.COUNT, '1',
                `Expected count=1 (only GOOD_VAR), got: ${result.COUNT}`);
            assert.ok(
                result.OVERRIDE.includes('"GOOD_VAR":"ok"'),
                `Expected GOOD_VAR in override, got: ${result.OVERRIDE}`
            );
        });

        it('key exceeding 1024 chars is skipped', () => {
            const longKey = 'K'.repeat(1025);
            const result = runIcEnvTest({
                [`IC_ENV_${longKey}`]: 'value',
                IC_ENV_SHORT: 'ok'
            });

            // The long-key var should be skipped
            assert.ok(
                result.WARNINGS.includes('KEY_TOO_LONG'),
                `Expected KEY_TOO_LONG warning, got: ${result.WARNINGS}`
            );
            // SHORT should still be counted
            assert.strictEqual(result.COUNT, '1',
                `Expected count=1 (only SHORT), got: ${result.COUNT}`);
            assert.ok(
                result.OVERRIDE.includes('"SHORT":"ok"'),
                `Expected SHORT in override, got: ${result.OVERRIDE}`
            );
        });
    });
});
