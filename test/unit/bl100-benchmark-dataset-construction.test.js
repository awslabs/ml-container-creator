// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mocha wrapper for the BL100 functional shell test.
 *
 * bl100-benchmark-dataset-construction.test.sh slices the real workload-spec /
 * DatasetConfig construction block out of templates/do/benchmark and checks the
 * JSON it emits. mocha only discovers *.test.js, so without this wrapper the
 * shell test ran nowhere (repo rule: no orphan tests). Running it under
 * /bin/bash also exercises the fragment on macOS's default bash 3.2, which the
 * do/ scripts must support.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'bl100-benchmark-dataset-construction.test.sh');
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

describe('BL100 do/benchmark dataset construction (shell functional test)', () => {
    it('passes every construction check', () => {
        const res = spawnSync(BASH, [SCRIPT], { encoding: 'utf8', timeout: 60000 });
        const output = `${res.stdout || ''}${res.stderr || ''}`;
        assert.equal(res.error, undefined, `could not run the shell test: ${res.error}`);
        assert.equal(res.status, 0, `shell test failed:\n${output}`);
        assert.match(output, /BL100 do\/benchmark construction: \d+ passed, 0 failed/);
    });
});
