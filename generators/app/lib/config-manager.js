import path from 'path';
import fs from 'fs-extra';
import UserConfig from './user-config.js';

/**
 * Configuration hierarchy (highest to lowest priority):
 * 1. Command-line arguments
 * 2. .yo-rc.json (project config)
 * 3. Package.json (ml-container-creator field)
 * 4. Global Config (~/.ml-container-creator-rc.json)
 * 5. Generator Defaults
 */

/**
 * ConfigManager - Manages configuration loading and merging
 * Handles configuration from multiple sources with proper precedence
 */
export default class ConfigManager {
  constructor(generator) {
    this.generator = generator;
    this.userConfig = new UserConfig();
    this.globalConfig = new GlobalConfig();
  }

  /**
   * Load all configuration sources
   * @param {Object} parameterMatrix - Valid parameters and their types
   */
  async loadAllConfigs(parameterMatrix) {
    this.parameterMatrix = parameterMatrix;

    // Load configs in order (lowest to highest priority)
    // Each subsequent load will override previous values
    await this._loadGeneratorDefaults();
    await this._loadGlobalConfig();
    await this._loadPackageJsonConfig();
    await this._loadProjectConfig();
    await this._loadCommandLineArgs();
  }

  /**
   * Load generator defaults from prompts
   */
  async _loadGeneratorDefaults() {
    const defaults = {};
    for (const [key, config] of Object.entries(this.parameterMatrix)) {
      if (config.default !== undefined) {
        defaults[key] = config.default;
      }
    }
    this.generator.config.defaults(defaults);
  }

  /**
   * Load global configuration from ~/.ml-container-creator-rc.json
   */
  async _loadGlobalConfig() {
    const globalConfig = await this.globalConfig.load();
    
    // Filter to only valid parameters
    const filtered = {};
    for (const [key, value] of Object.entries(globalConfig)) {
      if (this.parameterMatrix[key]) {
        filtered[key] = value;
      }
    }
    
    // Merge into generator config
    this._mergeConfig(filtered);
  }

  /**
   * Load configuration from package.json
   */
  async _loadPackageJsonConfig() {
    const packageJsonPath = this.generator.destinationPath('package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      if (packageJson['ml-container-creator']) {
        this._mergeConfig(packageJson['ml-container-creator']);
      }
    }
  }

  /**
   * Load project configuration from .yo-rc.json
   */
  async _loadProjectConfig() {
    // Yeoman automatically loads .yo-rc.json
    // We just need to ensure it's merged properly
    const existing = this.generator.config.getAll();
    this._mergeConfig(existing);
  }

  /**
   * Load command-line arguments
   */
  async _loadCommandLineArgs() {
    const options = this.generator.options;
    const filtered = {};
    
    for (const [key, config] of Object.entries(this.parameterMatrix)) {
      if (options[key] !== undefined) {
        filtered[key] = options[key];
      }
    }
    
    this._mergeConfig(filtered);
  }

  /**
   * Merge configuration object into generator config
   * @param {Object} config - Configuration to merge
   */
  _mergeConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (this.parameterMatrix[key]) {
        this.generator.config.set(key, value);
      }
    }
  }

  /**
   * Get current configuration value
   * @param {string} key - Configuration key
   * @returns {*} Configuration value
   */
  get(key) {
    return this.generator.config.get(key);
  }

  /**
   * Set configuration value
   * @param {string} key - Configuration key
   * @param {*} value - Configuration value
   */
  set(key, value) {
    this.generator.config.set(key, value);
  }

  /**
   * Get all configuration
   * @returns {Object} All configuration values
   */
  getAll() {
    return this.generator.config.getAll();
  }
}
