/**
 * Configuration Manager
 * 
 * Orchestrates configuration loading, matching, and merging for the multi-registry system.
 * Handles framework configurations, model-specific overrides, and HuggingFace API integration.
 * 
 * Requirements: 1.7, 2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8
 */

import RegistryLoader from './registry-loader.js';
import ConfigurationMatcher from './configuration-matcher.js';
import ValidationEngine from './validation-engine.js';
import HuggingFaceClient from './huggingface-client.js';

export default class ConfigurationManager {
    constructor(options = {}) {
        this.registryLoader = new RegistryLoader();
        this.validationEngine = new ValidationEngine();
        this.hfClient = new HuggingFaceClient({
            timeout: options.hfTimeout || 5000,
            offline: options.offline || false
        });
        
        // Registries (loaded on demand)
        this.frameworkRegistry = null;
        this.modelRegistry = null;
        this.instanceMapping = null;
        
        // Configuration matcher (initialized after registries load)
        this.configMatcher = null;
        
        // Validation options
        this.validateEnvVars = options.validateEnvVars ?? true;
    }
    
    /**
     * Load all registries from disk
     * Gracefully handles missing or invalid registries by using empty objects
     * 
     * Requirements: 1.7, 2.8
     */
    async loadRegistries() {
        this.frameworkRegistry = await this.registryLoader.loadFrameworkRegistry();
        this.modelRegistry = await this.registryLoader.loadModelRegistry();
        this.instanceMapping = await this.registryLoader.loadInstanceAcceleratorMapping();
        
        // Initialize configuration matcher with loaded registries
        this.configMatcher = new ConfigurationMatcher(
            this.frameworkRegistry,
            this.modelRegistry
        );
    }
    
    /**
     * Find best matching configuration for user selections
     * Orchestrates matching across framework, model, and HuggingFace sources
     * 
     * @param {Object} userSelections - User's configuration choices
     * @param {string} userSelections.framework - Framework name (e.g., "vllm")
     * @param {string} userSelections.version - Framework version (e.g., "0.3.0")
     * @param {string} [userSelections.modelId] - Optional model ID
     * @param {string} [userSelections.frameworkProfile] - Optional framework profile name
     * @param {string} [userSelections.modelProfile] - Optional model profile name
     * @returns {Promise<Object>} Matched configuration profile
     * 
     * Requirements: 2.1, 2.2, 2.3, 5.1, 5.2, 5.3, 12.1, 12.2
     */
    async matchConfiguration(userSelections) {
        // Ensure registries are loaded
        if (!this.configMatcher) {
            await this.loadRegistries();
        }
        
        // Match framework configuration
        const frameworkConfig = this.configMatcher.matchFramework(
            userSelections.framework,
            userSelections.version
        );
        
        // Get framework profile if specified
        let frameworkProfile = null;
        if (userSelections.frameworkProfile && frameworkConfig?.profiles) {
            frameworkProfile = frameworkConfig.profiles[userSelections.frameworkProfile];
        }
        
        // Match model configuration (if model ID provided)
        let modelConfig = null;
        let hfData = null;
        
        if (userSelections.modelId) {
            // Try HuggingFace API first
            hfData = await this._fetchHuggingFaceData(userSelections.modelId);
            
            // Check model registry for overrides
            modelConfig = this.configMatcher.matchModel(userSelections.modelId);
        }
        
        // Get model profile if specified
        let modelProfile = null;
        if (userSelections.modelProfile && modelConfig?.profiles) {
            modelProfile = modelConfig.profiles[userSelections.modelProfile];
        }
        
        // Merge all configurations
        return this.mergeConfigurations({
            frameworkConfig,
            frameworkProfile,
            hfData,
            modelConfig,
            modelProfile,
            userSelections
        });
    }
    
    /**
     * Merge configurations with correct priority order
     * Priority (highest to lowest): model profile → model config → HF data → framework profile → framework base
     * 
     * @param {Object} configs - Configuration sources
     * @param {Object} configs.frameworkConfig - Base framework configuration
     * @param {Object} [configs.frameworkProfile] - Framework profile configuration
     * @param {Object} [configs.hfData] - HuggingFace API data
     * @param {Object} [configs.modelConfig] - Model registry configuration
     * @param {Object} [configs.modelProfile] - Model profile configuration
     * @param {Object} configs.userSelections - User selections
     * @returns {Object} Merged configuration profile
     * 
     * Requirements: 1.7, 5.3, 12.6, 12.13
     */
    mergeConfigurations(configs) {
        const {
            frameworkConfig,
            frameworkProfile,
            hfData,
            modelConfig,
            modelProfile,
            userSelections
        } = configs;
        
        // Start with empty configuration (graceful degradation)
        const merged = {
            // User selections (always preserved)
            framework: userSelections?.framework || null,
            version: userSelections?.version || null,
            modelId: userSelections?.modelId || null,
            
            // Configuration fields (will be populated if sources available)
            baseImage: null,
            accelerator: null,
            envVars: {},
            inferenceAmiVersion: null,
            chatTemplate: null,
            recommendedInstanceTypes: [],
            
            // Metadata
            configSources: [],
            validationLevel: 'unknown',
            matchType: null,
            generatedAt: new Date().toISOString()
        };
        
        // Apply configurations in priority order (lowest to highest)
        
        // 1. Framework base configuration
        if (frameworkConfig) {
            this._applyFrameworkConfig(merged, frameworkConfig);
            merged.configSources.push('Framework_Registry');
            merged.validationLevel = frameworkConfig.validationLevel || 'unknown';
            merged.matchType = frameworkConfig.matchType;
        }
        
        // 2. Framework profile
        if (frameworkProfile) {
            this._applyProfileConfig(merged, frameworkProfile);
            merged.configSources.push('Framework_Profile');
        }
        
        // 3. HuggingFace API data
        if (hfData) {
            this._applyHuggingFaceData(merged, hfData);
            merged.configSources.push('HuggingFace_Hub_API');
        }
        
        // 4. Model registry configuration
        if (modelConfig) {
            this._applyModelConfig(merged, modelConfig);
            merged.configSources.push('Model_Registry');
            // Model registry can override validation level
            if (modelConfig.validationLevel) {
                merged.validationLevel = modelConfig.validationLevel;
            }
        }
        
        // 5. Model profile (highest priority)
        if (modelProfile) {
            this._applyProfileConfig(merged, modelProfile);
            merged.configSources.push('Model_Profile');
        }
        
        // If no sources provided configuration, mark as default
        if (merged.configSources.length === 0) {
            merged.configSources.push('Default');
        }
        
        return merged;
    }
    
    /**
     * Validate instance type against framework requirements
     * 
     * @param {string} instanceType - Instance type to validate
     * @param {Object} frameworkConfig - Framework configuration with accelerator requirements
     * @returns {Object} Validation result
     * @returns {boolean} result.compatible - Whether instance is compatible
     * @returns {string} [result.error] - Error message if incompatible
     * @returns {string} [result.warning] - Warning message if issues detected
     * @returns {string} [result.info] - Informational message
     * @returns {Array<string>} [result.recommendations] - Recommended instance types
     * 
     * Requirements: 4.1, 4.2, 4.7, 4.8, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15
     */
    validateInstanceType(instanceType, frameworkConfig) {
        // Ensure registries are loaded
        if (!this.instanceMapping) {
            return {
                compatible: true,
                warning: 'Instance accelerator mapping not loaded. Proceeding without validation.'
            };
        }
        
        // Get instance configuration
        const instanceConfig = this.instanceMapping[instanceType];
        
        if (!instanceConfig) {
            return {
                compatible: true,
                warning: `No accelerator data for ${instanceType}. Proceeding with best-effort validation.`
            };
        }
        
        // Validate accelerator compatibility
        if (!frameworkConfig?.accelerator) {
            return {
                compatible: true,
                info: 'No accelerator requirements specified for framework.'
            };
        }
        
        const validation = this.validationEngine.validateAcceleratorCompatibility(
            frameworkConfig,
            instanceConfig
        );
        
        // Add recommendations if incompatible
        if (!validation.compatible && frameworkConfig.accelerator) {
            const recommendations = this.validationEngine.getRecommendedInstanceTypes(
                frameworkConfig,
                this.instanceMapping
            );
            validation.recommendations = recommendations.map(r => r.instanceType);
        }
        
        return validation;
    }
    
    /**
     * Validate environment variables using validation engine
     * 
     * @param {Object} envVars - Environment variables to validate
     * @param {Object} frameworkConfig - Framework configuration
     * @returns {Object} Validation result
     * @returns {Array<Object>} result.errors - Validation errors
     * @returns {Array<Object>} result.warnings - Validation warnings
     * @returns {Array<string>} result.strategiesUsed - Validation strategies used
     * 
     * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8
     */
    validateEnvironmentVariables(envVars, frameworkConfig) {
        return this.validationEngine.validateEnvironmentVariables(
            envVars,
            frameworkConfig,
            {
                enabled: this.validateEnvVars,
                useKnownFlags: true,
                useCommunityReports: true,
                useDockerIntrospection: false
            }
        );
    }
    
    /**
     * Fetch model data from HuggingFace Hub API
     * Gracefully handles failures by returning null
     * 
     * @param {string} modelId - Model ID
     * @returns {Promise<Object|null>} Model data or null
     * @private
     */
    async _fetchHuggingFaceData(modelId) {
        try {
            // Fetch metadata
            const metadata = await this.hfClient.fetchModelMetadata(modelId);
            
            // Fetch tokenizer config for chat template
            const tokenizerConfig = await this.hfClient.fetchTokenizerConfig(modelId);
            
            // Fetch model config for architecture
            const modelConfig = await this.hfClient.fetchModelConfig(modelId);
            
            // Combine data
            if (!metadata && !tokenizerConfig && !modelConfig) {
                return null;
            }
            
            return {
                metadata,
                tokenizerConfig,
                modelConfig,
                chatTemplate: tokenizerConfig?.chat_template || null
            };
        } catch (error) {
            // Graceful fallback
            return null;
        }
    }
    
    /**
     * Apply framework configuration to merged config
     * @private
     */
    _applyFrameworkConfig(merged, frameworkConfig) {
        if (frameworkConfig.baseImage) {
            merged.baseImage = frameworkConfig.baseImage;
        }
        if (frameworkConfig.accelerator) {
            merged.accelerator = { ...frameworkConfig.accelerator };
        }
        if (frameworkConfig.envVars) {
            merged.envVars = { ...merged.envVars, ...frameworkConfig.envVars };
        }
        if (frameworkConfig.inferenceAmiVersion) {
            merged.inferenceAmiVersion = frameworkConfig.inferenceAmiVersion;
        }
        if (frameworkConfig.recommendedInstanceTypes) {
            merged.recommendedInstanceTypes = [...frameworkConfig.recommendedInstanceTypes];
        }
    }
    
    /**
     * Apply profile configuration to merged config
     * @private
     */
    _applyProfileConfig(merged, profileConfig) {
        if (profileConfig.envVars) {
            merged.envVars = { ...merged.envVars, ...profileConfig.envVars };
        }
        if (profileConfig.recommendedInstanceTypes) {
            merged.recommendedInstanceTypes = [...profileConfig.recommendedInstanceTypes];
        }
    }
    
    /**
     * Apply HuggingFace data to merged config
     * @private
     */
    _applyHuggingFaceData(merged, hfData) {
        if (hfData.chatTemplate) {
            merged.chatTemplate = hfData.chatTemplate;
        }
    }
    
    /**
     * Apply model configuration to merged config
     * @private
     */
    _applyModelConfig(merged, modelConfig) {
        if (modelConfig.chatTemplate) {
            merged.chatTemplate = modelConfig.chatTemplate;
        }
        if (modelConfig.envVars) {
            merged.envVars = { ...merged.envVars, ...modelConfig.envVars };
        }
        if (modelConfig.recommendedInstanceTypes) {
            merged.recommendedInstanceTypes = [...modelConfig.recommendedInstanceTypes];
        }
    }
    
    /**
     * Export configuration for community contribution
     * Creates a shareable configuration entry in the correct format for the appropriate registry
     * 
     * @param {Object} config - Configuration profile to export
     * @param {Object} options - Export options
     * @param {string} [options.testingNotes] - User's testing notes
     * @param {string} [options.instanceType] - Instance type used for testing
     * @param {boolean} [options.deploymentSuccess] - Whether deployment was successful
     * @param {boolean} [options.inferenceSuccess] - Whether inference worked correctly
     * @param {string} [options.testerName] - Name/handle of tester (optional)
     * @returns {Object} Export result with configuration entry and submission instructions
     * @returns {string} result.registryType - "framework" or "model"
     * @returns {Object} result.configEntry - Configuration entry in registry format
     * @returns {string} result.submissionInstructions - Instructions for submitting
     * @returns {Object} result.metadata - Export metadata
     * 
     * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
     */
    exportConfiguration(config, options = {}) {
        const {
            testingNotes = '',
            instanceType = null,
            deploymentSuccess = false,
            inferenceSuccess = false,
            testerName = 'Anonymous'
        } = options;
        
        // Determine registry type based on configuration
        const registryType = this._determineRegistryType(config);
        
        // Create configuration entry
        const configEntry = this._createConfigEntry(config, {
            testingNotes,
            instanceType,
            deploymentSuccess,
            inferenceSuccess,
            testerName
        });
        
        // Generate submission instructions
        const submissionInstructions = this._generateSubmissionInstructions(
            registryType,
            config,
            configEntry
        );
        
        // Create metadata
        const metadata = {
            generatorVersion: this._getGeneratorVersion(),
            exportedAt: new Date().toISOString(),
            configSource: config.configSources?.join(', ') || 'Unknown',
            validationLevel: config.validationLevel || 'experimental',
            testerName,
            instanceType,
            deploymentSuccess,
            inferenceSuccess
        };
        
        return {
            registryType,
            configEntry,
            submissionInstructions,
            metadata
        };
    }
    
    /**
     * Determine which registry type this configuration should be exported to
     * @private
     */
    _determineRegistryType(config) {
        // If model ID is present and model-specific overrides exist, export to Model_Registry
        if (config.modelId && (config.chatTemplate || config.configSources?.includes('Model_Registry'))) {
            return 'model';
        }
        
        // Otherwise, export to Framework_Registry
        return 'framework';
    }
    
    /**
     * Create configuration entry in registry format
     * @private
     */
    _createConfigEntry(config, testingInfo) {
        if (this._determineRegistryType(config) === 'framework') {
            return this._createFrameworkEntry(config, testingInfo);
        } else {
            return this._createModelEntry(config, testingInfo);
        }
    }
    
    /**
     * Create Framework_Registry entry
     * @private
     */
    _createFrameworkEntry(config, testingInfo) {
        const entry = {
            [config.version]: {
                baseImage: config.baseImage || 'REPLACE_WITH_BASE_IMAGE',
                accelerator: config.accelerator || {
                    type: 'cuda',
                    version: '12.1',
                    versionRange: {
                        min: '12.0',
                        max: '12.2'
                    }
                },
                envVars: config.envVars || {},
                inferenceAmiVersion: config.inferenceAmiVersion || 'REPLACE_WITH_AMI_VERSION',
                recommendedInstanceTypes: config.recommendedInstanceTypes?.length > 0 
                    ? config.recommendedInstanceTypes 
                    : (testingInfo.instanceType ? [testingInfo.instanceType] : ['ml.g5.xlarge']),
                validationLevel: this._determineValidationLevel(testingInfo),
                notes: this._createTestingNotes(testingInfo)
            }
        };
        
        return entry;
    }
    
    /**
     * Create Model_Registry entry
     * @private
     */
    _createModelEntry(config, testingInfo) {
        const entry = {
            [config.modelId]: {
                family: this._extractModelFamily(config.modelId),
                chatTemplate: config.chatTemplate || null,
                requiresTemplate: !!config.chatTemplate,
                validationLevel: this._determineValidationLevel(testingInfo),
                frameworkCompatibility: {
                    [config.framework]: `>=${config.version}`
                },
                notes: this._createTestingNotes(testingInfo)
            }
        };
        
        // Add environment variables if present
        if (config.envVars && Object.keys(config.envVars).length > 0) {
            entry[config.modelId].envVars = config.envVars;
        }
        
        // Add recommended instance types if present
        if (config.recommendedInstanceTypes?.length > 0) {
            entry[config.modelId].recommendedInstanceTypes = config.recommendedInstanceTypes;
        } else if (testingInfo.instanceType) {
            entry[config.modelId].recommendedInstanceTypes = [testingInfo.instanceType];
        }
        
        return entry;
    }
    
    /**
     * Determine validation level based on testing results
     * @private
     */
    _determineValidationLevel(testingInfo) {
        const { deploymentSuccess, inferenceSuccess } = testingInfo;
        
        if (deploymentSuccess && inferenceSuccess) {
            return 'community-validated';
        } else if (deploymentSuccess) {
            return 'experimental';
        } else {
            return 'unknown';
        }
    }
    
    /**
     * Create testing notes from testing info
     * @private
     */
    _createTestingNotes(testingInfo) {
        const { testingNotes, instanceType, deploymentSuccess, inferenceSuccess, testerName } = testingInfo;
        
        const notes = [];
        
        if (testingNotes) {
            notes.push(testingNotes);
        }
        
        if (instanceType) {
            notes.push(`Tested on ${instanceType}`);
        }
        
        if (deploymentSuccess && inferenceSuccess) {
            notes.push('✓ Deployment and inference successful');
        } else if (deploymentSuccess) {
            notes.push('✓ Deployment successful, inference not tested');
        }
        
        if (testerName && testerName !== 'Anonymous') {
            notes.push(`Tested by: ${testerName}`);
        }
        
        notes.push(`Exported: ${new Date().toISOString().split('T')[0]}`);
        
        return notes.join('. ');
    }
    
    /**
     * Extract model family from model ID
     * @private
     */
    _extractModelFamily(modelId) {
        if (!modelId) return 'unknown';
        
        // Extract family from model ID (e.g., "meta-llama/Llama-2-7b-chat-hf" -> "llama-2")
        const parts = modelId.toLowerCase().split('/');
        const modelName = parts[parts.length - 1];
        
        // Common patterns
        if (modelName.includes('llama-2')) return 'llama-2';
        if (modelName.includes('llama-3')) return 'llama-3';
        if (modelName.includes('llama')) return 'llama';
        if (modelName.includes('mistral')) return 'mistral';
        if (modelName.includes('mixtral')) return 'mixtral';
        if (modelName.includes('gemma')) return 'gemma';
        if (modelName.includes('phi')) return 'phi';
        if (modelName.includes('qwen')) return 'qwen';
        
        // Default: use first part of model name
        return modelName.split('-')[0];
    }
    
    /**
     * Generate submission instructions
     * @private
     */
    _generateSubmissionInstructions(registryType, config, configEntry) {
        const registryFile = registryType === 'framework' 
            ? 'servers/lib/catalogs/model-servers.json'
            : 'servers/lib/catalogs/popular-transformers.json';
        
        const registryName = registryType === 'framework' 
            ? 'Framework_Catalog'
            : 'Model_Catalog';
        
        const key = registryType === 'framework' 
            ? config.framework
            : config.modelId;
        
        return `
# Configuration Export for Community Contribution

Thank you for testing this configuration! Your contribution helps the community.

## Configuration Details

- **Registry Type**: ${registryName}
- **${registryType === 'framework' ? 'Framework' : 'Model'}**: ${key}
- **Validation Level**: ${config.validationLevel || 'experimental'}
- **Tested On**: ${new Date().toISOString().split('T')[0]}

## Submission Instructions

### Option 1: GitHub Issue (Recommended)

1. Go to: https://github.com/YOUR_REPO/issues/new
2. Title: "[Config] Add ${registryType === 'framework' ? `${config.framework  } ${  config.version}` : config.modelId}"
3. Paste the configuration entry below
4. Add any additional context about your testing

### Option 2: Pull Request

1. Fork the repository
2. Edit: \`${registryFile}\`
3. Add the configuration entry to the appropriate section
4. Submit a pull request with title: "Add ${registryType === 'framework' ? `${config.framework  } ${  config.version}` : config.modelId} configuration"

## Configuration Entry

Add this to \`${registryFile}\`:

\`\`\`javascript
${JSON.stringify(configEntry, null, 2)}
\`\`\`

## Testing Information

- **Instance Type**: ${config.recommendedInstanceTypes?.[0] || 'Not specified'}
- **Accelerator**: ${config.accelerator?.type || 'Not specified'} ${config.accelerator?.version || ''}
- **Base Image**: ${config.baseImage || 'Not specified'}
- **AMI Version**: ${config.inferenceAmiVersion || 'Not specified'}

## Notes

${config.notes || 'No additional notes'}

---

Generated by ML Container Creator v${this._getGeneratorVersion()}
`.trim();
    }
    
    /**
     * Get generator version
     * @private
     */
    _getGeneratorVersion() {
        // In a real implementation, this would read from package.json
        // For now, return a placeholder
        return '1.0.0';
    }
}
