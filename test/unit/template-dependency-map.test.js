// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'mocha';
import { DEPENDENCY_MAP, getAffectedFiles } from '../../src/lib/template-dependency-map.js';

describe('template-dependency-map', () => {
    it('test_instance_type_affects_expected_files', () => {
        const files = getAffectedFiles(['instanceType']);
        assert.ok(files.includes('do/config'), 'should include do/config');
        assert.ok(files.includes('do/ic/default.conf'), 'should include do/ic/default.conf');
    });

    it('test_deployment_config_affects_dockerfile', () => {
        const files = getAffectedFiles(['deploymentConfig']);
        assert.ok(files.includes('Dockerfile'), 'should include Dockerfile');
        assert.ok(files.includes('do/config'), 'should include do/config');
        assert.ok(files.includes('do/build'), 'should include do/build');
    });

    it('test_unknown_key_empty', () => {
        const files = getAffectedFiles(['nonExistentKey123']);
        assert.deepStrictEqual(files, []);
    });

    it('test_deduplication', () => {
        // Both instanceType and deploymentConfig affect do/config
        const files = getAffectedFiles(['instanceType', 'deploymentConfig']);
        const doConfigCount = files.filter(f => f === 'do/config').length;
        assert.strictEqual(doConfigCount, 1, 'do/config should appear exactly once');
    });

    it('test_sorted', () => {
        const files = getAffectedFiles(['deploymentConfig', 'instanceType']);
        const sorted = [...files].sort();
        assert.deepStrictEqual(files, sorted, 'result should be sorted');
    });

    it('test_empty_input', () => {
        const files = getAffectedFiles([]);
        assert.deepStrictEqual(files, []);
    });

    it('test_dependency_map_has_expected_keys', () => {
        assert.ok('instance_type' in DEPENDENCY_MAP);
        assert.ok('instanceType' in DEPENDENCY_MAP);
        assert.ok('deployment_config' in DEPENDENCY_MAP);
        assert.ok('region' in DEPENDENCY_MAP);
        assert.ok('baseImage' in DEPENDENCY_MAP);
    });
});
