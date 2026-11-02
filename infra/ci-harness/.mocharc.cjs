// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Local mocha config for the CI harness CDK app (BL219). Its presence stops
// mocha from walking up to the repo-root .mocharc.cjs, whose
// require: ['test/setup-env.js'] does not resolve from this directory.
// CDK synth (NodejsFunction bundling via esbuild) takes well over mocha's 2 s
// default, so the timeout is raised.
module.exports = {
    require: ['ts-node/register'],
    spec: ['test/**/*.test.ts'],
    timeout: 120000,
    exit: true,
    reporter: 'spec'
};
