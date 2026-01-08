// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Global Configuration Manager
 * 
 * Manages user-level global configuration stored in home directory.
 * This provides defaults that persist across all project generations.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const GLOBAL_CONFIG_FILENAME = '.ml-container-creator-rc.json';

export default class GlobalConfig {
    constructor() {
        this.configPath = path.join(os.homedir(), GLOBAL_CONFIG_FILENAME);
        this.config = null;
    }

    /**
     * Checks if global config file exists
     * @returns {boolean}
     */
    exists() {
        return fs.existsSync(this.configPath);
    }

    /**
     * Loads global configuration from home directory
     * @returns {Object|null} Global configuration or null if not found
     */
    load() {
        if (!this.exists()) {
            return null;
        }

        try {
            const content = fs.readFileSync(this.configPath, 'utf8');
            this.config = JSON.parse(content);
            return this.config;
        } catch (error) {
            console.warn(`⚠️  Failed to load global config from ${this.configPath}: ${error.message}`);
            return null;
        }
    }

    /**
     * Saves global configuration to home directory
     * @param {Object} config - Configuration object to save
     * @returns {boolean} True if successful
     */
    save(config) {
        try {
            const content = JSON.stringify(config, null, 2);
            fs.writeFileSync(this.configPath, content, 'utf8');
            this.config = config;
            return true;
        } catch (error) {
            console.error(`❌ Failed to save global config to ${this.configPath}: ${error.message}`);
            return false;
        }
    }

    /**
     * Gets a specific value from global config
     * @param {string} key - Configuration key
     * @returns {*} Configuration value or undefined
     */
    get(key) {
        if (!this.config) {
            this.load();
        }
        return this.config ? this.config[key] : undefined;
    }

    /**
     * Sets a specific value in global config
     * @param {string} key - Configuration key
     * @param {*} value - Configuration value
     */
    set(key, value) {
        if (!this.config) {
            this.config = {};
        }
        this.config[key] = value;
    }

    /**
     * Gets the path to the global config file
     * @returns {string}
     */
    getPath() {
        return this.configPath;
    }
}
