// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Profile Parser
 *
 * Parses INI-format AWS configuration files (~/.aws/config and
 * ~/.aws/credentials) to extract available profile names. Used by
 * the bootstrap command to present a selectable list of AWS profiles.
 *
 * Parsing rules:
 * - ~/.aws/config uses [profile name] sections (except [default])
 * - ~/.aws/credentials uses [name] sections directly
 * - Profiles from both files are merged and deduplicated
 * - 'default' is always sorted first if present
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export default class AwsProfileParser {
    /**
     * @param {Object} [options] - Optional overrides for testing
     * @param {string} [options.configPath] - Override path to ~/.aws/config
     * @param {string} [options.credentialsPath] - Override path to ~/.aws/credentials
     */
    constructor(options = {}) {
        this._configPath = options.configPath || null
        this._credentialsPath = options.credentialsPath || null
    }

    /**
     * Get all AWS profile names from config and credentials files.
     * Returns a deduplicated array with 'default' sorted first if present.
     *
     * @returns {string[]} Profile names, with 'default' first if it exists
     */
    getProfiles() {
        const configProfiles = this._getProfilesFromConfig()
        const credentialsProfiles = this._getProfilesFromCredentials()

        const allNames = new Set([...configProfiles, ...credentialsProfiles])

        const sorted = [...allNames].sort((a, b) => {
            if (a === 'default') return -1
            if (b === 'default') return 1
            return a.localeCompare(b)
        })

        return sorted
    }

    /**
     * Parse an INI-format file into a Map of section names to key-value objects.
     *
     * @param {string} filePath - Absolute path to the INI file
     * @returns {Map<string, Object>} Map of section names to parsed key-value pairs
     */
    _parseIniFile(filePath) {
        const sections = new Map()

        if (!existsSync(filePath)) {
            return sections
        }

        let content
        try {
            content = readFileSync(filePath, 'utf8')
        } catch {
            return sections
        }

        let currentSection = null
        const lines = content.split(/\r?\n/)

        for (const rawLine of lines) {
            const line = rawLine.trim()

            // Skip empty lines and comments
            if (!line || line.startsWith('#') || line.startsWith(';')) {
                continue
            }

            // Check for section header
            const sectionMatch = line.match(/^\[([^\]]+)\]$/)
            if (sectionMatch) {
                currentSection = sectionMatch[1].trim()
                if (!sections.has(currentSection)) {
                    sections.set(currentSection, {})
                }
                continue
            }

            // Parse key = value pairs
            if (currentSection) {
                const kvMatch = line.match(/^([^=]+?)=(.*)$/)
                if (kvMatch) {
                    const key = kvMatch[1].trim()
                    const value = kvMatch[2].trim()
                    sections.get(currentSection)[key] = value
                }
            }
        }

        return sections
    }

    /**
     * Extract profile names from a parsed INI Map.
     * Handles both config-style ([profile X]) and credentials-style ([X]) sections.
     *
     * @param {Map<string, Object>} parsed - Parsed INI sections
     * @param {boolean} [isConfig=false] - Whether this is a config file (uses [profile X] format)
     * @returns {string[]} Array of profile names
     */
    _extractProfileNames(parsed, isConfig = false) {
        const names = []

        for (const sectionName of parsed.keys()) {
            if (isConfig) {
                // ~/.aws/config uses [profile name] except for [default]
                if (sectionName === 'default') {
                    names.push('default')
                } else if (sectionName.startsWith('profile ')) {
                    const name = sectionName.slice('profile '.length).trim()
                    if (name) {
                        names.push(name)
                    }
                }
            } else {
                // ~/.aws/credentials uses [name] directly
                names.push(sectionName)
            }
        }

        return names
    }

    /**
     * Get the path to the AWS config file.
     *
     * @returns {string} Absolute path to ~/.aws/config
     */
    _getConfigPath() {
        return this._configPath || join(homedir(), '.aws', 'config')
    }

    /**
     * Get the path to the AWS credentials file.
     *
     * @returns {string} Absolute path to ~/.aws/credentials
     */
    _getCredentialsPath() {
        return this._credentialsPath || join(homedir(), '.aws', 'credentials')
    }

    /**
     * Get profile names from the AWS config file.
     *
     * @returns {string[]} Profile names from ~/.aws/config
     * @private
     */
    _getProfilesFromConfig() {
        const configPath = this._getConfigPath()
        const parsed = this._parseIniFile(configPath)
        return this._extractProfileNames(parsed, true)
    }

    /**
     * Get profile names from the AWS credentials file.
     *
     * @returns {string[]} Profile names from ~/.aws/credentials
     * @private
     */
    _getProfilesFromCredentials() {
        const credentialsPath = this._getCredentialsPath()
        const parsed = this._parseIniFile(credentialsPath)
        return this._extractProfileNames(parsed, false)
    }
}
