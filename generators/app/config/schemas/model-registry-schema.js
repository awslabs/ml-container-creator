/**
 * JSON Schema for Model Registry
 * 
 * Defines the structure and validation rules for model registry entries.
 */

export default {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    patternProperties: {
        '.*': {  // model ID or pattern (can include wildcards)
            type: 'object',
            required: [
                'family',
                'chatTemplate',
                'requiresTemplate',
                'validationLevel',
                'frameworkCompatibility'
            ],
            properties: {
                family: {
                    type: 'string',
                    minLength: 1
                },
                chatTemplate: {
                    type: ['string', 'null']
                },
                requiresTemplate: {
                    type: 'boolean'
                },
                validationLevel: {
                    type: 'string',
                    enum: ['tested', 'community-validated', 'experimental']
                },
                frameworkCompatibility: {
                    type: 'object',
                    patternProperties: {
                        '^[a-z0-9-]+$': {  // framework name
                            type: 'string'  // version range
                        }
                    }
                },
                profiles: {
                    type: 'object',
                    patternProperties: {
                        '^[a-z0-9-]+$': {  // profile name
                            type: 'object',
                            required: ['displayName', 'envVars'],
                            properties: {
                                displayName: { type: 'string' },
                                envVars: {
                                    type: 'object',
                                    patternProperties: {
                                        '^[A-Z_][A-Z0-9_]*$': { type: 'string' }
                                    }
                                },
                                recommendedInstanceTypes: {
                                    type: 'array',
                                    items: { type: 'string' }
                                }
                            }
                        }
                    }
                },
                notes: {
                    type: 'string'
                }
            }
        }
    }
};
