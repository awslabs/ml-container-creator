/**
 * JSON Schema for Framework Registry
 * 
 * Defines the structure and validation rules for framework registry entries.
 */

export default {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    patternProperties: {
        '^[a-z0-9-]+$': {  // framework name
            type: 'object',
            patternProperties: {
                '^[0-9]+\\.[0-9]+\\.[0-9]+$': {  // version (semver)
                    type: 'object',
                    required: [
                        'baseImage',
                        'accelerator',
                        'envVars',
                        'inferenceAmiVersion',
                        'recommendedInstanceTypes',
                        'validationLevel'
                    ],
                    properties: {
                        baseImage: {
                            type: 'string',
                            minLength: 1
                        },
                        accelerator: {
                            type: 'object',
                            required: ['type'],
                            properties: {
                                type: {
                                    type: 'string',
                                    enum: ['cuda', 'neuron', 'cpu', 'rocm']
                                },
                                version: {
                                    type: ['string', 'null']
                                },
                                versionRange: {
                                    type: 'object',
                                    properties: {
                                        min: { type: 'string' },
                                        max: { type: 'string' }
                                    }
                                }
                            }
                        },
                        envVars: {
                            type: 'object',
                            patternProperties: {
                                '^[A-Z_][A-Z0-9_]*$': {  // Environment variable names
                                    type: 'string'
                                }
                            }
                        },
                        inferenceAmiVersion: {
                            type: 'string',
                            minLength: 1
                        },
                        recommendedInstanceTypes: {
                            type: 'array',
                            items: {
                                type: 'string',
                                pattern: '^ml\\.[a-z0-9]+\\.[a-z0-9]+$'
                            },
                            minItems: 1
                        },
                        validationLevel: {
                            type: 'string',
                            enum: ['tested', 'community-validated', 'experimental', 'unknown']
                        },
                        profiles: {
                            type: 'object',
                            patternProperties: {
                                '^[a-z0-9-]+$': {  // profile name
                                    type: 'object',
                                    required: ['displayName', 'description'],
                                    properties: {
                                        displayName: { type: 'string' },
                                        description: { type: 'string' },
                                        envVars: {
                                            type: 'object',
                                            patternProperties: {
                                                '^[A-Z_][A-Z0-9_]*$': { type: 'string' }
                                            }
                                        },
                                        recommendedInstanceTypes: {
                                            type: 'array',
                                            items: { type: 'string' }
                                        },
                                        notes: { type: 'string' }
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
        }
    }
};
