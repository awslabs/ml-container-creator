/**
 * Community Reports Validator Strategy
 * 
 * Validates environment variables against community-contributed reports.
 * Provides warnings for flags reported as problematic by the community.
 * 
 * Requirements: 13.10, 13.16, 13.17
 */
export default class CommunityReportsValidator {
    /**
     * Create a new CommunityReportsValidator.
     * 
     * @param {Object} communityReports - Community reports registry
     */
    constructor(communityReports = {}) {
        this.communityReports = communityReports;
        this.name = 'community-reports';
    }
    
    /**
     * Validate environment variables against community reports.
     * 
     * @param {string} framework - Framework name
     * @param {string} version - Framework version
     * @param {Object} envVars - Environment variables to validate
     * @returns {Object} ValidationResult
     * @returns {Array<Object>} ValidationResult.warnings - Warning messages
     * @returns {Array<Object>} ValidationResult.errors - Error messages
     */
    async validate(framework, version, envVars) {
        const warnings = [];
        const errors = [];
        
        // Get community reports for this framework
        const reports = this.getCommunityReports(framework, version);
        
        if (!reports || reports.length === 0) {
            // No community reports available
            return { warnings, errors };
        }
        
        // Check each environment variable against community reports
        for (const [key] of Object.entries(envVars)) {
            const relevantReports = reports.filter(report => 
                report.variable === key || report.pattern && new RegExp(report.pattern).test(key)
            );
            
            for (const report of relevantReports) {
                if (report.severity === 'error') {
                    errors.push({
                        key,
                        message: `Community report: ${report.message} (reported by ${report.reporter || 'community'})`
                    });
                } else {
                    warnings.push({
                        key,
                        message: `Community report: ${report.message} (reported by ${report.reporter || 'community'})`
                    });
                }
            }
        }
        
        return { warnings, errors };
    }
    
    /**
     * Get community reports for a framework version.
     * 
     * @param {string} framework - Framework name
     * @param {string} version - Framework version
     * @returns {Array|null} Community reports
     * @private
     */
    getCommunityReports(framework, version) {
        if (!this.communityReports[framework]) {
            return null;
        }
        
        // Try exact version match first
        if (this.communityReports[framework][version]) {
            return this.communityReports[framework][version];
        }
        
        // Try to find reports for all versions
        if (this.communityReports[framework].all) {
            return this.communityReports[framework].all;
        }
        
        return null;
    }
}
