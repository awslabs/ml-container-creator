/**
 * Catalog enum validator.
 * Validates that catalog entries (e.g., model-servers.json) contain valid
 * enum values according to the AWS service model.
 *
 * Unlike other validators that check API payloads, this validator reads
 * catalog files and validates their fields against the service model enums.
 *
 * Requirements: 14.1, 14.2, 14.3
 */
import BaseValidator from './base-validator.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CATALOG_PATH = resolve(__dirname, '../../../servers/lib/catalogs/model-servers.json');

/**
 * Map of catalog field names to their corresponding SageMaker service model shape names.
 */
const CATALOG_ENUM_FIELDS = [
    { field: 'inferenceAmiVersion', shapeName: 'InferenceAmiVersion' }
];

export default class CatalogValidator extends BaseValidator {
    get name() {
        return 'catalog';
    }

    get mode() {
        return 'static';
    }

    /**
     * Validate catalog enum fields against the service model.
     * @param {Object} context - ValidationContext (may be empty for catalog-only validation)
     * @param {Object} options
     * @param {Array} options.serviceModels - Parsed ServiceModelIndex objects
     * @param {string} [options.catalogPath] - Path to model-servers.json (defaults to well-known location)
     * @param {Object} [options.catalogData] - Pre-loaded catalog data (for testing)
     * @returns {Promise<Array>} Array of Finding objects
     */
    async validate(context, options) {
        const findings = [];
        const serviceModels = options.serviceModels || [];

        if (serviceModels.length === 0) {
            return findings;
        }

        // Load catalog data
        let catalogData;
        let catalogFilePath;

        if (options.catalogData) {
            catalogData = options.catalogData;
            catalogFilePath = options.catalogPath || 'servers/lib/catalogs/model-servers.json';
        } else {
            catalogFilePath = options.catalogPath || DEFAULT_CATALOG_PATH;

            if (!existsSync(catalogFilePath)) {
                return findings;
            }

            try {
                catalogData = JSON.parse(readFileSync(catalogFilePath, 'utf8'));
            } catch {
                return findings;
            }
        }

        // Build enum lookup from service models
        const enumMap = this._buildEnumMap(serviceModels);

        // Validate each server group and its entries
        for (const [serverKey, entries] of Object.entries(catalogData)) {
            if (!Array.isArray(entries)) continue;

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const entryKey = `${serverKey}[${i}]`;
                const entryLabel = entry.tag || entry.image || `index ${i}`;

                this._validateEntry(
                    entry, entryKey, entryLabel, catalogFilePath, enumMap, findings
                );
            }
        }

        return findings;
    }

    /**
     * Build a map of field names to their valid enum values from service models.
     * @param {Array} serviceModels - Parsed ServiceModelIndex objects
     * @returns {Map<string, string[]>} field name → valid enum values
     */
    _buildEnumMap(serviceModels) {
        const enumMap = new Map();

        for (const { field, shapeName } of CATALOG_ENUM_FIELDS) {
            for (const model of serviceModels) {
                const shape = model.shapes.get(shapeName);
                if (shape && shape.enum && shape.enum.length > 0) {
                    enumMap.set(field, [...shape.enum]);
                    break;
                }
            }
        }

        return enumMap;
    }

    /**
     * Validate a single catalog entry's enum fields.
     * @param {Object} entry - Catalog entry object
     * @param {string} entryKey - Key identifying the entry (e.g., "vllm[0]")
     * @param {string} entryLabel - Human-readable label for the entry
     * @param {string} catalogFilePath - Path to the catalog file
     * @param {Map<string, string[]>} enumMap - field name → valid enum values
     * @param {Array} findings - Accumulator for findings
     */
    _validateEntry(entry, entryKey, entryLabel, catalogFilePath, enumMap, findings) {
        // Check top-level fields
        for (const [field, validValues] of enumMap) {
            if (entry[field] !== undefined) {
                this._checkEnumValue(
                    entry[field], field, entryKey, catalogFilePath, validValues, findings
                );
            }
        }

        // Check nested defaults object
        if (entry.defaults && typeof entry.defaults === 'object') {
            for (const [field, validValues] of enumMap) {
                if (entry.defaults[field] !== undefined) {
                    this._checkEnumValue(
                        entry.defaults[field], field, entryKey, catalogFilePath, validValues, findings
                    );
                }
            }
        }
    }

    /**
     * Check a single enum value and add a finding if invalid.
     * @param {string} value - The value to check
     * @param {string} fieldName - The field name
     * @param {string} entryKey - The entry key (e.g., "vllm[0]")
     * @param {string} catalogFilePath - Path to the catalog file
     * @param {string[]} validValues - Array of valid enum values
     * @param {Array} findings - Accumulator for findings
     */
    _checkEnumValue(value, fieldName, entryKey, catalogFilePath, validValues, findings) {
        if (typeof value !== 'string') return;

        if (!validValues.includes(value)) {
            findings.push({
                service: 'sagemaker',
                operation: 'catalog-validation',
                fieldPath: `${entryKey}.${fieldName}`,
                invalidValue: value,
                constraint: { type: 'enum', values: validValues },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                catalogFile: catalogFilePath,
                entryKey,
                fieldName,
                remediationHint: `Value "${value}" is not a valid ${fieldName}. Allowed values: ${validValues.join(', ')}. Run \`bootstrap sync-schemas\` to update the enum set.`
            });
        }
    }
}
