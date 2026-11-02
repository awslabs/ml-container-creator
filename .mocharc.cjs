// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Mocha config. `ignore` is DERIVED from scripts/run-node-tests.js: files
// written against node:test register with Node's runner, not mocha's, so mocha
// would report 0 tests for them and swallow their failures. They run via
// `npm run test:node` instead (BL194). Do not hand-maintain this list.
const { discoverNodeTests } = require('./scripts/run-node-tests.js');

module.exports = {
    require: ['test/setup-env.js'],
    ignore: discoverNodeTests()
};
