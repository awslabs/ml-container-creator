/**
 * Structured validation report that categorizes findings by severity and source.
 * Supports text (color-coded) and JSON output formats.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */
export default class ValidationReport {
    constructor() {
        this.schemaErrors = [];
        this.crossCuttingErrors = [];
        this.advisoryFindings = [];
        this.warnings = [];
        this.metadata = {};
    }

    /**
     * Add a finding to the appropriate category based on finding.source.
     * Smart-mode findings are labeled advisory unless confidence is 'definitive' and severity is 'error'.
     * @param {Object} finding - A Finding object with source, severity, confidence, etc.
     */
    addFinding(finding) {
        const source = finding.source || '';

        if (source === 'cross-cutting') {
            this.crossCuttingErrors.push(finding);
        } else if (source === 'smart-mode' || source.startsWith('smart:')) {
            // Smart-mode findings are advisory UNLESS confidence is definitive AND severity is error
            if (finding.confidence === 'definitive' && finding.severity === 'error') {
                this.schemaErrors.push(finding);
            } else {
                this.advisoryFindings.push(finding);
            }
        } else if (finding.confidence === 'medium' || finding.confidence === 'low') {
            this.advisoryFindings.push(finding);
        } else if (finding.severity === 'warning') {
            this.warnings.push(finding);
        } else {
            this.schemaErrors.push(finding);
        }
    }

    /**
     * Render report as formatted text with color-coded severity grouping by operation.
     * @returns {string}
     */
    toText() {
        const lines = [];

        const groupByOperation = (findings) => {
            const groups = {};
            for (const f of findings) {
                const key = f.operation || 'general';
                if (!groups[key]) groups[key] = [];
                groups[key].push(f);
            }
            return groups;
        };

        if (this.schemaErrors.length > 0) {
            lines.push('\x1b[31m── Schema Errors ──\x1b[0m');
            const groups = groupByOperation(this.schemaErrors);
            for (const [op, findings] of Object.entries(groups)) {
                lines.push(`  ${op}:`);
                for (const f of findings) {
                    lines.push(`    \x1b[31m✗\x1b[0m ${f.fieldPath}: ${f.invalidValue} (${f.remediationHint || ''})`);
                }
            }
        }

        if (this.crossCuttingErrors.length > 0) {
            lines.push('\x1b[31m── Cross-Cutting Errors ──\x1b[0m');
            const groups = groupByOperation(this.crossCuttingErrors);
            for (const [op, findings] of Object.entries(groups)) {
                lines.push(`  ${op}:`);
                for (const f of findings) {
                    lines.push(`    \x1b[31m✗\x1b[0m ${f.fieldPath}: ${f.remediationHint || ''}`);
                }
            }
        }

        if (this.advisoryFindings.length > 0) {
            lines.push('\x1b[36m── Advisory Findings ──\x1b[0m');
            const groups = groupByOperation(this.advisoryFindings);
            for (const [op, findings] of Object.entries(groups)) {
                lines.push(`  ${op}:`);
                for (const f of findings) {
                    lines.push(`    \x1b[36mℹ\x1b[0m ${f.fieldPath}: ${f.remediationHint || ''}`);
                }
            }
        }

        if (this.warnings.length > 0) {
            lines.push('\x1b[33m── Warnings ──\x1b[0m');
            for (const f of this.warnings) {
                lines.push(`  \x1b[33m⚠\x1b[0m ${f.fieldPath || f.operation || ''}: ${f.remediationHint || ''}`);
            }
        }

        const summary = this.getSummary();
        lines.push('');
        lines.push(`Summary: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.advisory} advisory, ${summary.fieldsValidated} fields validated`);

        return lines.join('\n');
    }

    /**
     * Render report as JSON with full structured object.
     * @returns {Object}
     */
    toJSON() {
        return {
            schemaErrors: this.schemaErrors,
            crossCuttingErrors: this.crossCuttingErrors,
            advisoryFindings: this.advisoryFindings,
            warnings: this.warnings,
            metadata: this.metadata,
            summary: this.getSummary()
        };
    }

    /**
     * Get summary counts.
     * @returns {{ errors: number, warnings: number, advisory: number, fieldsValidated: number }}
     */
    getSummary() {
        return {
            errors: this.schemaErrors.length + this.crossCuttingErrors.length,
            warnings: this.warnings.length,
            advisory: this.advisoryFindings.length,
            fieldsValidated: this.metadata.fieldsValidated || 0
        };
    }
}
