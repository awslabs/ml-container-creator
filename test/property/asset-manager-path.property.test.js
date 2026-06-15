// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AssetManager Path Derivation Property-Based Tests
 *
 * Property 3: Path derivation from profile name
 *
 * Path SHALL be `{configDir}/manifests/{profileName}.json`
 *
 * Feature: deployment-registry, Property 3: Path derivation from profile name
 *
 * **Validates: Requirements 1.1, 8.7**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { join } from 'node:path';
import { homedir } from 'node:os';
import AssetManager from '../../src/lib/asset-manager.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

const arbProfileName = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,29}$/)
    .filter(s => s.length >= 1);

const arbConfigDir = fc.stringMatching(/^\/[a-zA-Z0-9/_-]{1,40}$/);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 3: Path derivation from profile name', () => {

    /**
     * **Validates: Requirements 1.1, 8.7**
     */
    it('manifest path is {configDir}/manifests/{profileName}.json', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileName,
            arbConfigDir,
            (profileName, configDir) => {
                const manager = new AssetManager(profileName, { configDir });

                const expected = join(configDir, 'manifests', `${profileName}.json`);
                assert.strictEqual(
                    manager.manifestPath,
                    expected,
                    'Path should be {configDir}/manifests/{profileName}.json'
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * **Validates: Requirements 1.1, 8.7**
     */
    it('default configDir is ~/.ml-container-creator', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileName,
            (profileName) => {
                const manager = new AssetManager(profileName);

                const expected = join(homedir(), '.ml-container-creator', 'manifests', `${profileName}.json`);
                assert.strictEqual(
                    manager.manifestPath,
                    expected,
                    'Default path should use ~/.ml-container-creator'
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});
