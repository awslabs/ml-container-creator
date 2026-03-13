/**
 * Configuration Exporter
 * 
 * Handles prompting users to export configurations for community contribution
 * and saving exported configurations to files.
 * 
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import fs from 'fs';
import path from 'path';

export default class ConfigurationExporter {
    constructor(generator) {
        this.generator = generator;
    }
    
    /**
     * Detect if configuration should be offered for export
     * Offers export for experimental or unknown configurations
     * 
     * @param {Object} config - Configuration profile
     * @returns {boolean} Whether to offer export
     * 
     * Requirements: 7.1
     */
    shouldOfferExport(config) {
        if (!config) return false;
        
        const validationLevel = config.validationLevel || 'unknown';
        
        // Offer export for experimental or unknown configurations
        return validationLevel === 'experimental' || validationLevel === 'unknown';
    }
    
    /**
     * Prompt user to export configuration
     * Captures testing notes and deployment results
     * 
     * @param {Object} config - Configuration profile to export
     * @returns {Promise<Object|null>} Export data or null if user declined
     * 
     * Requirements: 7.1, 7.2, 7.3, 7.4
     */
    async promptForExport(config) {
        if (!this.shouldOfferExport(config)) {
            return null;
        }
        
        this.generator.log('\n📤 Configuration Export');
        this.generator.log('━'.repeat(50));
        this.generator.log(`This configuration has validation level: ${config.validationLevel || 'unknown'}`);
        this.generator.log('If you successfully deploy and test this configuration, please consider');
        this.generator.log('sharing it with the community to help others!');
        this.generator.log('');
        
        // Ask if user wants to export
        const { wantsToExport } = await this.generator.prompt([
            {
                type: 'confirm',
                name: 'wantsToExport',
                message: 'Would you like to export this configuration for community contribution?',
                default: false
            }
        ]);
        
        if (!wantsToExport) {
            this.generator.log('Skipping export. You can always export later after testing.');
            return null;
        }
        
        // Collect testing information
        const exportData = await this.generator.prompt([
            {
                type: 'input',
                name: 'instanceType',
                message: 'What instance type did you use (or plan to use) for testing?',
                default: config.recommendedInstanceTypes?.[0] || 'ml.g5.xlarge',
                validate: (input) => {
                    if (!input || input.trim() === '') {
                        return 'Instance type is required';
                    }
                    return true;
                }
            },
            {
                type: 'confirm',
                name: 'deploymentSuccess',
                message: 'Did the deployment succeed?',
                default: false
            },
            {
                type: 'confirm',
                name: 'inferenceSuccess',
                message: 'Did inference work correctly?',
                default: false,
                when: (answers) => answers.deploymentSuccess
            },
            {
                type: 'input',
                name: 'testingNotes',
                message: 'Any notes about your testing experience? (optional)',
                default: ''
            },
            {
                type: 'input',
                name: 'testerName',
                message: 'Your name or GitHub handle (optional, for attribution):',
                default: 'Anonymous'
            }
        ]);
        
        return exportData;
    }
    
    /**
     * Save exported configuration to file
     * Creates a file in the project directory with export instructions
     * 
     * @param {Object} exportResult - Result from ConfigurationManager.exportConfiguration()
     * @param {string} destinationPath - Destination directory path
     * 
     * Requirements: 7.2, 7.3, 7.5, 7.6
     */
    saveExportToFile(exportResult, destinationPath) {
        const { registryType, configEntry, submissionInstructions, metadata } = exportResult;
        
        // Create export filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const filename = `config-export-${registryType}-${timestamp}.md`;
        const filepath = path.join(destinationPath, filename);
        
        // Create export file content
        const content = `${submissionInstructions}

## Export Metadata

\`\`\`json
${JSON.stringify(metadata, null, 2)}
\`\`\`

## Configuration Entry (JSON)

\`\`\`json
${JSON.stringify(configEntry, null, 2)}
\`\`\`
`;
        
        // Write file
        fs.writeFileSync(filepath, content, 'utf-8');
        
        return filename;
    }
    
    /**
     * Display export success message
     * 
     * @param {string} filename - Name of exported file
     */
    displayExportSuccess(filename) {
        this.generator.log('');
        this.generator.log('✅ Configuration exported successfully!');
        this.generator.log(`📄 Export saved to: ${filename}`);
        this.generator.log('');
        this.generator.log('Next steps:');
        this.generator.log('1. Review the export file');
        this.generator.log('2. Test your deployment');
        this.generator.log('3. Submit via GitHub issue or pull request');
        this.generator.log('4. Help the community! 🎉');
        this.generator.log('');
    }
    
    /**
     * Complete export workflow
     * Prompts user, exports configuration, and saves to file
     * 
     * @param {Object} config - Configuration profile
     * @param {Object} configurationManager - ConfigurationManager instance
     * @param {string} destinationPath - Destination directory path
     * @returns {Promise<boolean>} Whether export was completed
     * 
     * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
     */
    async exportWorkflow(config, configurationManager, destinationPath) {
        // Prompt for export
        const exportData = await this.promptForExport(config);
        
        if (!exportData) {
            return false;
        }
        
        // Export configuration
        const exportResult = configurationManager.exportConfiguration(config, exportData);
        
        // Save to file
        const filename = this.saveExportToFile(exportResult, destinationPath);
        
        // Display success message
        this.displayExportSuccess(filename);
        
        return true;
    }
}
