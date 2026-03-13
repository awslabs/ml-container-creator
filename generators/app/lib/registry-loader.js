/**
 * Registry Loader
 * 
 * Loads and validates registry files with schema validation.
 * Handles missing files gracefully by returning empty objects.
 */

import Ajv from 'ajv';
import frameworkRegistrySchema from '../config/schemas/framework-registry-schema.js';
import modelRegistrySchema from '../config/schemas/model-registry-schema.js';
import instanceAcceleratorMappingSchema from '../config/schemas/instance-accelerator-mapping-schema.js';

class RegistryLoader {
    constructor() {
        this.ajv = new Ajv({ allErrors: true, strict: false });
    }

    /**
     * Load framework registry with schema validation
     * @returns {Object} Framework registry or empty object if load fails
     */
    async loadFrameworkRegistry() {
        try {
            const registry = await import('../config/registries/frameworks.js');
            const data = registry.default || registry;
            
            this.validateSchema(data, frameworkRegistrySchema, 'Framework Registry');
            return data;
        } catch (error) {
            console.warn(`Failed to load framework registry: ${error.message}`);
            return {};
        }
    }

    /**
     * Load model registry with schema validation
     * @returns {Object} Model registry or empty object if load fails
     */
    async loadModelRegistry() {
        try {
            const registry = await import('../config/registries/models.js');
            const data = registry.default || registry;
            
            this.validateSchema(data, modelRegistrySchema, 'Model Registry');
            return data;
        } catch (error) {
            console.warn(`Failed to load model registry: ${error.message}`);
            return {};
        }
    }

    /**
     * Load instance accelerator mapping with schema validation
     * @returns {Object} Instance accelerator mapping or empty object if load fails
     */
    async loadInstanceAcceleratorMapping() {
        try {
            const registry = await import('../config/registries/instance-accelerator-mapping.js');
            const data = registry.default || registry;
            
            this.validateSchema(data, instanceAcceleratorMappingSchema, 'Instance Accelerator Mapping');
            return data;
        } catch (error) {
            console.warn(`Failed to load instance accelerator mapping: ${error.message}`);
            return {};
        }
    }

    /**
     * Validate registry data against JSON schema
     * @param {Object} data - Registry data to validate
     * @param {Object} schema - JSON schema to validate against
     * @param {string} registryName - Name of registry for error messages
     * @throws {Error} If validation fails
     */
    validateSchema(data, schema, registryName) {
        const validate = this.ajv.compile(schema);
        const valid = validate(data);
        
        if (!valid) {
            const errors = validate.errors
                .map(err => `${err.instancePath} ${err.message}`)
                .join(', ');
            throw new Error(`${registryName} validation failed: ${errors}`);
        }
    }
}

export default RegistryLoader;
