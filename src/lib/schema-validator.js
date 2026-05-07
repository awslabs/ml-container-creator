/**
 * Schema Validator
 * 
 * Validates registry data against JSON schemas without external dependencies.
 * Uses a simple validation approach suitable for the registry structure.
 */

export default class SchemaValidator {
    /**
     * Validate data against a schema
     * @param {Object} data - Data to validate
     * @param {Object} schema - JSON schema
     * @returns {Object} - { valid: boolean, errors: string[] }
     */
    validate(data, schema) {
        const errors = [];
        
        try {
            this._validateType(data, schema, '', errors);
        } catch (error) {
            errors.push(`Validation error: ${error.message}`);
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
    
    _validateType(data, schema, path, errors) {
        // Handle type validation
        if (schema.type) {
            const types = Array.isArray(schema.type) ? schema.type : [schema.type];
            const dataType = this._getType(data);
            
            if (!types.includes(dataType)) {
                errors.push(`${path || 'root'}: Expected type ${types.join(' or ')}, got ${dataType}`);
                return;
            }
        }
        
        // Handle enum validation
        if (schema.enum && !schema.enum.includes(data)) {
            errors.push(`${path || 'root'}: Value must be one of ${schema.enum.join(', ')}`);
            return;
        }
        
        // Handle object validation
        if (this._getType(data) === 'object' && schema.type === 'object') {
            this._validateObject(data, schema, path, errors);
        }
        
        // Handle array validation
        if (this._getType(data) === 'array' && schema.type === 'array') {
            this._validateArray(data, schema, path, errors);
        }
        
        // Handle string validation
        if (this._getType(data) === 'string' && schema.type === 'string') {
            this._validateString(data, schema, path, errors);
        }
        
        // Handle number validation
        if (this._getType(data) === 'number' && schema.type === 'number') {
            this._validateNumber(data, schema, path, errors);
        }
    }
    
    _validateObject(data, schema, path, errors) {
        // Check required properties
        if (schema.required) {
            for (const requiredProp of schema.required) {
                if (!(requiredProp in data)) {
                    errors.push(`${path || 'root'}: Missing required property '${requiredProp}'`);
                }
            }
        }
        
        // Validate properties
        if (schema.properties) {
            for (const [key, value] of Object.entries(data)) {
                if (schema.properties[key]) {
                    this._validateType(value, schema.properties[key], `${path}.${key}`, errors);
                }
            }
        }
        
        // Validate patternProperties
        if (schema.patternProperties) {
            for (const [key, value] of Object.entries(data)) {
                for (const [pattern, propSchema] of Object.entries(schema.patternProperties)) {
                    const regex = new RegExp(pattern);
                    if (regex.test(key)) {
                        this._validateType(value, propSchema, `${path}.${key}`, errors);
                    }
                }
            }
        }
    }
    
    _validateArray(data, schema, path, errors) {
        // Check minItems
        if (schema.minItems !== undefined && data.length < schema.minItems) {
            errors.push(`${path || 'root'}: Array must have at least ${schema.minItems} items`);
        }
        
        // Check maxItems
        if (schema.maxItems !== undefined && data.length > schema.maxItems) {
            errors.push(`${path || 'root'}: Array must have at most ${schema.maxItems} items`);
        }
        
        // Validate items
        if (schema.items) {
            data.forEach((item, index) => {
                this._validateType(item, schema.items, `${path}[${index}]`, errors);
            });
        }
    }
    
    _validateString(data, schema, path, errors) {
        // Check minLength
        if (schema.minLength !== undefined && data.length < schema.minLength) {
            errors.push(`${path || 'root'}: String must be at least ${schema.minLength} characters`);
        }
        
        // Check maxLength
        if (schema.maxLength !== undefined && data.length > schema.maxLength) {
            errors.push(`${path || 'root'}: String must be at most ${schema.maxLength} characters`);
        }
        
        // Check pattern
        if (schema.pattern) {
            const regex = new RegExp(schema.pattern);
            if (!regex.test(data)) {
                errors.push(`${path || 'root'}: String does not match pattern ${schema.pattern}`);
            }
        }
    }
    
    _validateNumber(data, schema, path, errors) {
        // Check minimum
        if (schema.minimum !== undefined && data < schema.minimum) {
            errors.push(`${path || 'root'}: Number must be at least ${schema.minimum}`);
        }
        
        // Check maximum
        if (schema.maximum !== undefined && data > schema.maximum) {
            errors.push(`${path || 'root'}: Number must be at most ${schema.maximum}`);
        }
    }
    
    _getType(value) {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;
    }
}
