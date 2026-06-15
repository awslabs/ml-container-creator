/**
 * Local ESLint plugin for ML Container Creator custom rules.
 */
'use strict';

const noHardcodedNumruns = require('./no-hardcoded-numruns.cjs');

module.exports = {
    rules: {
        'no-hardcoded-numruns': noHardcodedNumruns
    }
};
