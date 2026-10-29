// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard for the root-mocha wrappers that run infra/bootstrap-modules/test/*.assertions.ts
 * (test/unit/bootstrap-*-cdk.test.js). Those need infra/bootstrap-modules/node_modules
 * (ts-node + aws-cdk-lib), which the root `npm install` does not provide.
 *
 * Locally a missing install skips (a fresh checkout should not fail `npm test`).
 * In CI (CI=true, set by GitHub Actions) it FAILS: .github/workflows/ci.yml runs
 * `npm ci` in infra/bootstrap-modules before the root tests, so a missing install
 * there means the workflow regressed and the assertions would silently not run (BL238).
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MODULES_ROOT = resolve(__dirname, '../../infra/bootstrap-modules');
export const TS_NODE_REGISTER = resolve(MODULES_ROOT, 'node_modules/ts-node/register/index.js');

/** True when infra/bootstrap-modules has ts-node and aws-cdk-lib installed. */
export function haveBootstrapModulesDeps() {
    return existsSync(TS_NODE_REGISTER) && existsSync(resolve(MODULES_ROOT, 'node_modules/aws-cdk-lib'));
}

/**
 * Call from a mocha `before(function () { ... })` hook. Returns normally when the deps
 * are installed; otherwise skips (local) or throws (CI).
 * @param {Mocha.Context} ctx - the hook's `this`
 */
export function requireBootstrapModulesDeps(ctx) {
    if (haveBootstrapModulesDeps()) return;
    if (process.env.CI) {
        throw new Error('❌ infra/bootstrap-modules/node_modules is missing in CI: run `npm ci` in '
            + 'infra/bootstrap-modules before the root tests (see .github/workflows/ci.yml)');
    }
    ctx.skip(); // local: deps not installed (npm ci in infra/bootstrap-modules)
}
