import ValidationReport from './validation-report.js';
import EnumValidator from './validators/enum-validator.js';
import TypeValidator from './validators/type-validator.js';
import RequiredFieldValidator from './validators/required-field-validator.js';
import CrossCuttingChecker from './cross-cutting-checker.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Core validation orchestrator.
 * Loads service models, runs static and smart validators, and produces a report.
 *
 * Requirements: 12.1, 12.2, 12.5, 15.4, 15.5
 */
export default class SchemaValidationEngine {
    /**
     * @param {Object} options
     * @param {string} options.registryPath - Path to schema registry
     * @param {boolean} options.ignoreStaleness - Suppress staleness warnings
     * @param {boolean} options.smartMode - Enable smart-mode validators
     */
    constructor(options = {}) {
        this.registryPath = options.registryPath || null;
        this.ignoreStaleness = options.ignoreStaleness || false;
        this.smartMode = options.smartMode || false;
        this.validators = [];
        this.serviceModels = options.serviceModels || [];
        this.instanceCatalog = options.instanceCatalog || null;
        this.crossCuttingChecker = new CrossCuttingChecker();

        // Auto-register built-in validators
        this.registerValidator(new EnumValidator());
        this.registerValidator(new TypeValidator());
        this.registerValidator(new RequiredFieldValidator());
    }

    /**
     * Run full validation pipeline.
     * Orchestrate: load models → run static validators → run smart validators (if enabled) → return report.
     * @param {Object} context - ValidationContext from PayloadBuilder
     * @returns {Promise<ValidationReport>}
     */
    async validate(context) {
        const report = new ValidationReport();

        // Run static validators (mode === 'static' or 'both')
        const staticValidators = this.validators.filter(
            v => v.mode === 'static' || v.mode === 'both'
        );

        const priorFindings = [];

        for (const validator of staticValidators) {
            try {
                const findings = await validator.validate(context, {
                    priorFindings: [...priorFindings],
                    serviceModels: this.serviceModels
                });
                for (const finding of findings) {
                    report.addFinding(finding);
                    priorFindings.push(finding);
                }
            } catch (err) {
                report.warnings.push({
                    source: 'engine',
                    severity: 'warning',
                    operation: '',
                    fieldPath: '',
                    remediationHint: `Plugin "${validator.name}" threw an error: ${err.message}`
                });
            }
        }

        // Run cross-cutting checks after schema validators
        if (this.instanceCatalog) {
            try {
                const crossCuttingFindings = this.crossCuttingChecker.check(context, this.instanceCatalog);
                for (const finding of crossCuttingFindings) {
                    report.addFinding(finding);
                    priorFindings.push(finding);
                }
            } catch (err) {
                report.warnings.push({
                    source: 'engine',
                    severity: 'warning',
                    operation: '',
                    fieldPath: '',
                    remediationHint: `Cross-cutting checker threw an error: ${err.message}`
                });
            }
        }

        // Run smart validators if enabled (mode === 'smart' or 'both')
        if (this.smartMode) {
            const smartValidators = this.validators.filter(
                v => v.mode === 'smart' || v.mode === 'both'
            );

            for (const validator of smartValidators) {
                // Skip validators already run in static pass (mode === 'both')
                if (validator.mode === 'both' && staticValidators.includes(validator)) {
                    continue;
                }

                try {
                    const findings = await validator.validate(context, {
                        priorFindings: [...priorFindings],
                        serviceModels: this.serviceModels
                    });
                    for (const finding of findings) {
                        report.addFinding(finding);
                        priorFindings.push(finding);
                    }
                } catch (err) {
                    report.warnings.push({
                        source: 'engine',
                        severity: 'warning',
                        operation: '',
                        fieldPath: '',
                        remediationHint: `Smart plugin "${validator.name}" threw an error: ${err.message}`
                    });
                }
            }
        }

        return report;
    }

    /**
     * Register a custom validator plugin.
     * @param {Object} validator - A BaseValidator instance
     */
    registerValidator(validator) {
        this.validators.push(validator);
    }

    /**
     * Check schema registry staleness.
     * @returns {{ stale: boolean, lastSynced: string|null, daysSinceSync: number, registryMissing?: boolean }}
     */
    checkStaleness() {
        if (!this.registryPath) {
            return {
                stale: false,
                lastSynced: null,
                daysSinceSync: 0,
                registryMissing: true
            };
        }

        let manifest;
        try {
            const manifestPath = path.join(this.registryPath, 'manifest.json');

            if (!existsSync(manifestPath)) {
                return {
                    stale: false,
                    lastSynced: null,
                    daysSinceSync: 0,
                    registryMissing: true
                };
            }

            manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
            return {
                stale: false,
                lastSynced: null,
                daysSinceSync: 0,
                registryMissing: true
            };
        }

        if (!manifest || !manifest.lastSynced) {
            return {
                stale: false,
                lastSynced: null,
                daysSinceSync: 0,
                registryMissing: true
            };
        }

        const lastSynced = manifest.lastSynced;
        const syncDate = new Date(lastSynced);
        const now = new Date();
        const daysSinceSync = Math.floor((now - syncDate) / (1000 * 60 * 60 * 24));
        const stale = daysSinceSync > 30;

        if (stale && !this.ignoreStaleness) {
            console.log(`⚠️  Schema registry is ${daysSinceSync} days old. Run \`ml-container-creator bootstrap sync-schemas\` to update.`);
        }

        return { stale, lastSynced, daysSinceSync };
    }
}
