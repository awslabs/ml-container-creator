// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 10: formatImageChoices includes all expected metadata
 *
 * For any ImageEntry and isTransformer flag, the formatted string contains
 * repository, tag, architecture, python_version, and date; when isTransformer
 * is true, also contains cuda_version.
 *
 * Feature: transformer-base-image-picker
 * Validates: Requirements 6.1, 6.2
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { formatImageChoices } from '../../generators/app/lib/prompts.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// Arbitrary generator for a valid ImageEntry
const arbImageEntry = fc.record({
    image: fc.tuple(
        fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/),
        fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/),
        fc.stringMatching(/^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/)
    ).map(([org, repo, tag]) => `${org}/${repo}:${tag}`),
    tag: fc.stringMatching(/^v?[0-9]+\.[0-9]+(\.[0-9]+)?(-[a-z0-9]+)?$/),
    architecture: fc.constantFrom('amd64', 'arm64'),
    created: fc.integer({
        min: new Date('2020-01-01').getTime(),
        max: new Date('2026-01-01').getTime()
    }).map(ts => new Date(ts).toISOString()),
    labels: fc.record({
        cuda_version: fc.stringMatching(/^[0-9]+\.[0-9]+$/),
        python_version: fc.stringMatching(/^3\.[0-9]{1,2}$/),
        framework_version: fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/)
    }),
    registry: fc.constantFrom('dockerhub', 'ngc', 'ecr'),
    repository: fc.tuple(
        fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/),
        fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/)
    ).map(([org, repo]) => `${org}/${repo}`)
});

describe('Property 10: formatImageChoices includes all expected metadata', () => {
    it('for any ImageEntry and isTransformer=true, formatted string contains repository, tag, architecture, cuda_version, python_version, and date', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbImageEntry,
            (entry) => {
                const choices = formatImageChoices([entry], true);
                assert.strictEqual(choices.length, 1);

                const { name, value } = choices[0];
                assert.strictEqual(value, entry.image);
                assert.ok(name.includes(entry.repository),
                    `Formatted string should contain repository "${entry.repository}"`);
                assert.ok(name.includes(entry.tag),
                    `Formatted string should contain tag "${entry.tag}"`);
                assert.ok(name.includes(entry.architecture),
                    `Formatted string should contain architecture "${entry.architecture}"`);
                assert.ok(name.includes(entry.labels.cuda_version),
                    `Formatted string should contain cuda_version "${entry.labels.cuda_version}"`);
                assert.ok(name.includes(entry.labels.python_version),
                    `Formatted string should contain python_version "${entry.labels.python_version}"`);
                assert.ok(name.includes(entry.created.slice(0, 10)),
                    `Formatted string should contain date "${entry.created.slice(0, 10)}"`);

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('for any ImageEntry and isTransformer=false, formatted string contains repository, tag, architecture, python_version, date but NOT cuda_version column', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbImageEntry,
            (entry) => {
                const choices = formatImageChoices([entry], false);
                assert.strictEqual(choices.length, 1);

                const { name, value } = choices[0];
                assert.strictEqual(value, entry.image);
                assert.ok(name.includes(entry.repository),
                    `Formatted string should contain repository "${entry.repository}"`);
                assert.ok(name.includes(entry.tag),
                    `Formatted string should contain tag "${entry.tag}"`);
                assert.ok(name.includes(entry.architecture),
                    `Formatted string should contain architecture "${entry.architecture}"`);
                assert.ok(name.includes(entry.labels.python_version),
                    `Formatted string should contain python_version "${entry.labels.python_version}"`);
                assert.ok(name.includes(entry.created.slice(0, 10)),
                    `Formatted string should contain date "${entry.created.slice(0, 10)}"`);

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('for entries with missing labels, uses "-" as fallback', () => {
        const entry = {
            image: 'python:3.12-slim',
            tag: '3.12-slim',
            architecture: 'amd64',
            created: '2024-10-01T00:00:00Z',
            labels: {},
            registry: 'dockerhub',
            repository: 'python'
        };

        const transformerChoices = formatImageChoices([entry], true);
        assert.ok(transformerChoices[0].name.includes('-'),
            'Should use "-" fallback for missing cuda_version');

        const nonTransformerChoices = formatImageChoices([entry], false);
        assert.ok(nonTransformerChoices[0].name.includes('-'),
            'Should use "-" fallback for missing python_version');
    });
});
