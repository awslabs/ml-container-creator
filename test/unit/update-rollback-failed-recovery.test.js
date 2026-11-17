// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL143 Group A — UPDATE_ROLLBACK_FAILED recovery (offline).
 *
 * Exercises the pure recovery state machine in module-runner.cjs with an injected
 * command runner (no live AWS): continue-update-rollback → re-check → skip-retry →
 * throw-with-exact-command. Also covers parseStuckResources and the command builder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const RUNNER = resolve(__dirname, '../../infra/bootstrap-modules/module-runner.cjs');

const {
    recoverUpdateRollbackFailed,
    parseStuckResources,
    buildContinueRollbackCommand
} = require(RUNNER);

/**
 * Build an injected runCmd that returns a scripted StackStatus for describe-stacks and
 * runs a scripted handler for continue-update-rollback.
 * @param {object} cfg
 * @param {string[]} cfg.statuses - StackStatus returned by successive describe-stacks
 * @param {(argv, call) => void} [cfg.onContinue] - throws to simulate CFN rejecting
 */
function makeRunCmd({ statuses, onContinue }) {
    let describeCall = 0;
    let continueCall = 0;
    const calls = [];
    const runCmd = (argv) => {
        calls.push(argv);
        if (argv[1] === 'describe-stacks') {
            const status = statuses[Math.min(describeCall, statuses.length - 1)];
            describeCall += 1;
            return JSON.stringify({ Stacks: [{ StackStatus: status }] });
        }
        if (argv[1] === 'continue-update-rollback') {
            const idx = continueCall;
            continueCall += 1;
            if (onContinue) onContinue(argv, idx); // may throw
            return '';
        }
        throw new Error(`unexpected argv: ${argv.join(' ')}`);
    };
    return { runCmd, calls: () => calls };
}

describe('BL143 recoverUpdateRollbackFailed', () => {
    const base = { stackName: 'mlcc-p-eks-cluster', region: 'us-west-2' };

    it('bare continue-update-rollback recovers → proceeds', () => {
        // After continue, describe reports UPDATE_ROLLBACK_COMPLETE.
        const { runCmd, calls } = makeRunCmd({ statuses: ['UPDATE_ROLLBACK_COMPLETE'] });
        const result = recoverUpdateRollbackFailed({ ...base, runCmd });
        assert.equal(result.recovered, true);
        assert.equal(result.action, 'continue-update-rollback');
        // Exactly one continue, no --resources-to-skip.
        const continues = calls().filter(c => c[1] === 'continue-update-rollback');
        assert.equal(continues.length, 1);
        assert.ok(!continues[0].includes('--resources-to-skip'));
    });

    it('first continue names stuck resources → retries with --resources-to-skip → recovers', () => {
        const { runCmd, calls } = makeRunCmd({
            // describe after the SKIP attempt reports success
            statuses: ['UPDATE_ROLLBACK_COMPLETE'],
            onContinue: (argv, callIdx) => {
                if (callIdx === 0) {
                    const e = new Error('Resource [MyStuckResource] cannot be rolled back');
                    throw e;
                }
                // second call (with skip) succeeds
            }
        });
        const result = recoverUpdateRollbackFailed({ ...base, runCmd });
        assert.equal(result.recovered, true);
        assert.match(result.action, /resources-to-skip/);
        const skipCall = calls().find(c => c.includes('--resources-to-skip'));
        assert.ok(skipCall, 'a skip retry was issued');
        assert.ok(skipCall.includes('MyStuckResource'), 'parsed logical id forwarded');
    });

    it('unrecoverable → throws with the EXACT manual command (incl. parsed skip ids)', () => {
        const { runCmd } = makeRunCmd({
            statuses: ['UPDATE_ROLLBACK_FAILED'], // never recovers
            onContinue: () => { throw new Error('resource(s): StuckA, StuckB could not be rolled back'); }
        });
        assert.throws(
            () => recoverUpdateRollbackFailed({ ...base, awsProfile: 'dev', runCmd }),
            (err) => {
                assert.match(err.message, /continue-update-rollback/);
                assert.match(err.message, /--stack-name mlcc-p-eks-cluster/);
                assert.match(err.message, /--region us-west-2/);
                assert.match(err.message, /--resources-to-skip StuckA StuckB/);
                assert.match(err.message, /--profile dev/);
                return true;
            }
        );
    });

    it('unrecoverable with unparseable error → still throws a runnable command (no skip)', () => {
        const { runCmd } = makeRunCmd({
            statuses: ['UPDATE_ROLLBACK_FAILED'],
            onContinue: () => { throw new Error('something opaque'); }
        });
        assert.throws(
            () => recoverUpdateRollbackFailed({ ...base, runCmd }),
            (err) => {
                assert.match(err.message, /continue-update-rollback --stack-name mlcc-p-eks-cluster/);
                assert.ok(!/--resources-to-skip/.test(err.message), 'no skip clause when nothing parsed');
                return true;
            }
        );
    });

    it('stack vanished after continue (describe returns no stack) counts as recovered', () => {
        const runCmd = (argv) => {
            if (argv[1] === 'describe-stacks') return JSON.stringify({ Stacks: [] });
            if (argv[1] === 'continue-update-rollback') return '';
            throw new Error('unexpected');
        };
        const result = recoverUpdateRollbackFailed({ ...base, runCmd });
        assert.equal(result.recovered, true);
    });
});

describe('BL143 parseStuckResources', () => {
    it('parses a bracketed list', () => {
        assert.deepEqual(parseStuckResources('Resource [Alpha, Beta] cannot be rolled back'),
            ['Alpha', 'Beta']);
    });
    it('parses a colon-delimited list after "resource"', () => {
        assert.deepEqual(parseStuckResources('The following resource(s): Gamma, Delta failed'),
            ['Gamma', 'Delta']);
    });
    it('returns [] on unparseable / empty input', () => {
        assert.deepEqual(parseStuckResources('no ids here'), []);
        assert.deepEqual(parseStuckResources(''), []);
        assert.deepEqual(parseStuckResources(undefined), []);
    });
});

describe('BL143 buildContinueRollbackCommand', () => {
    it('builds base command', () => {
        assert.equal(
            buildContinueRollbackCommand('s', 'us-west-2'),
            'aws cloudformation continue-update-rollback --stack-name s --region us-west-2'
        );
    });
    it('includes skip ids and profile when provided', () => {
        assert.equal(
            buildContinueRollbackCommand('s', 'us-west-2', 'dev', ['A', 'B']),
            'aws cloudformation continue-update-rollback --stack-name s --region us-west-2 --resources-to-skip A B --profile dev'
        );
    });
});
