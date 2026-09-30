/**
 * Local ESLint plugin for ML Container Creator custom rules.
 */
'use strict';

const noHardcodedNumruns = require('./no-hardcoded-numruns.cjs');
const requireModuleHeader = require('./require-module-header.cjs');

module.exports = {
    rules: {
        'no-hardcoded-numruns': noHardcodedNumruns,
        'require-module-header': requireModuleHeader
    }
};
