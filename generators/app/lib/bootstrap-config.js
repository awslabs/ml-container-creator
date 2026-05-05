// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Configuration
 *
 * Handles reading, writing, and managing the bootstrap configuration file
 * at ~/.ml-container-creator/config.json. Supports named profiles for
 * multiple AWS environment configurations.
 *
 * Config file format:
 * {
 *   "activeProfile": "default",
 *   "profiles": {
 *     "default": {
 *       "awsProfile": "default",
 *       "awsRegion": "us-east-1",
 *       "accountId": "111111111111",
 *       "roleArn": "arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role",
 *       "ecrRepositoryName": "ml-container-creator",
 *       "asyncS3Bucket": "...",
 *       "batchS3Bucket": "...",
 *       "ciInfraProvisioned": false,
 *       "ciTableName": "mlcc-ci-table"
 *     }
 *   }
 * }
 *
 * Optional CI fields (added by bootstrap --ci):
 *   - ciInfraProvisioned (boolean): Whether CI harness infrastructure has been deployed. Defaults to false.
 *   - ciTableName (string): Name of the DynamoDB CI table. Defaults to "mlcc-ci-table".
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export default class BootstrapConfig {
    /**
     * @param {string} [configPath] - Absolute path to the config JSON file.
     *   Defaults to ~/.ml-container-creator/config.json
     */
    constructor(configPath) {
        this.configPath = configPath || join(homedir(), '.ml-container-creator', 'config.json')
    }

    /**
     * Read the config file and return the parsed config object.
     *
     * @returns {{ activeProfile: string, profiles: Object }|null} The config object, or null if file doesn't exist
     */
    read() {
        if (!existsSync(this.configPath)) {
            return null
        }

        const raw = readFileSync(this.configPath, 'utf8')
        return JSON.parse(raw)
    }

    /**
     * Write a config object to the config file.
     * Creates the parent directory if it doesn't exist.
     * Uses 2-space indentation and a trailing newline.
     *
     * @param {Object} config - The config object to write
     */
    write(config) {
        const dir = dirname(this.configPath)
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n')
    }

    /**
     * Check whether the config file exists.
     *
     * @returns {boolean} true if the config file exists
     */
    exists() {
        return existsSync(this.configPath)
    }

    /**
     * Get the active profile name and its config.
     *
     * @returns {{ name: string, config: Object }|null} The active profile, or null if no active profile
     */
    getActiveProfile() {
        const config = this.read()
        if (!config || !config.activeProfile || !config.profiles) {
            return null
        }

        const profileConfig = config.profiles[config.activeProfile]
        if (!profileConfig) {
            return null
        }

        return { name: config.activeProfile, config: profileConfig }
    }

    /**
     * Get a specific profile's config by name.
     *
     * @param {string} name - The profile name
     * @returns {Object|null} The profile config object, or null if not found
     */
    getProfile(name) {
        const config = this.read()
        if (!config || !config.profiles) {
            return null
        }

        return config.profiles[name] || null
    }

    /**
     * Get a specific profile's config with CI defaults applied.
     * Ensures profiles created before CI integration still work by
     * providing graceful defaults for missing CI fields.
     *
     * @param {string} name - The profile name
     * @returns {Object|null} The profile config with CI defaults, or null if not found
     */
    getProfileWithDefaults(name) {
        const profile = this.getProfile(name)
        if (!profile) {
            return null
        }

        return {
            ciInfraProvisioned: false,
            ciTableName: 'mlcc-ci-table',
            ...profile
        }
    }

    /**
     * Get the active profile with CI defaults applied.
     * Ensures profiles created before CI integration still work by
     * providing graceful defaults for missing CI fields.
     *
     * @returns {{ name: string, config: Object }|null} The active profile with CI defaults, or null
     */
    getActiveProfileWithDefaults() {
        const active = this.getActiveProfile()
        if (!active) {
            return null
        }

        return {
            name: active.name,
            config: {
                ciInfraProvisioned: false,
                ciTableName: 'mlcc-ci-table',
                ...active.config
            }
        }
    }

    /**
     * Create or update a profile in the config.
     * Sets the given profile as the active profile and writes the config.
     *
     * @param {string} name - The profile name
     * @param {Object} profileData - The profile configuration data
     */
    setProfile(name, profileData) {
        let config = this.read()
        if (!config) {
            config = { activeProfile: null, profiles: {} }
        }
        if (!config.profiles) {
            config.profiles = {}
        }

        config.profiles[name] = profileData
        config.activeProfile = name
        this.write(config)
    }

    /**
     * Remove a profile from the config.
     * If the removed profile was active, sets activeProfile to the first
     * remaining profile or null if no profiles remain.
     *
     * @param {string} name - The profile name to remove
     * @returns {boolean} true if the profile was removed, false if not found
     */
    removeProfile(name) {
        const config = this.read()
        if (!config || !config.profiles || !config.profiles[name]) {
            return false
        }

        delete config.profiles[name]

        if (config.activeProfile === name) {
            const remaining = Object.keys(config.profiles)
            config.activeProfile = remaining.length > 0 ? remaining[0] : null
        }

        this.write(config)
        return true
    }

    /**
     * List all profile names in the config.
     *
     * @returns {string[]} Array of profile name strings
     */
    listProfiles() {
        const config = this.read()
        if (!config || !config.profiles) {
            return []
        }

        return Object.keys(config.profiles)
    }

    /**
     * Set the active profile by name and write the config.
     *
     * @param {string} name - The profile name to set as active
     */
    setActiveProfile(name) {
        const config = this.read()
        if (!config) {
            return
        }

        config.activeProfile = name
        this.write(config)
    }
}
