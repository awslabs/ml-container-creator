/**
 * JSON Schema for Deployment Entry
 *
 * Defines the structure and validation rules for deployment registry entries.
 * Each entry captures the full configuration state and outcome of a single
 * ML model deployment.
 */

export default {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: [
        'id',
        'timestamp',
        'status',
        'deployment',
        'model',
        'infrastructure',
        'configuration',
        'outcome',
        'metadata'
    ],
    properties: {
        id: {
            type: 'string',
            pattern: '^[0-9a-f]{8}$'
        },
        timestamp: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$'
        },
        status: {
            type: 'string',
            enum: ['success', 'partial', 'failed']
        },
        deployment: {
            type: 'object',
            required: ['deploymentConfig', 'architecture', 'backend'],
            properties: {
                deploymentConfig: {
                    type: 'string',
                    minLength: 1
                },
                architecture: {
                    type: 'string',
                    enum: ['http', 'transformers', 'triton', 'diffusors']
                },
                backend: {
                    type: 'string',
                    minLength: 1
                },
                baseImage: {
                    type: ['string', 'null']
                },
                deploymentTarget: {
                    type: ['string', 'null']
                },
                buildTarget: {
                    type: ['string', 'null']
                },
                icList: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['name'],
                        properties: {
                            name: { type: 'string', minLength: 1 },
                            image: { type: 'string' },
                            gpuCount: { type: 'integer', minimum: 0 },
                            copyCount: { type: 'integer', minimum: 1 },
                            isAdapter: { type: 'boolean' },
                            baseIcName: { type: 'string' },
                            artifactUrl: { type: 'string' }
                        }
                    }
                }
            }
        },
        model: {
            type: 'object',
            required: ['modelName'],
            properties: {
                modelName: {
                    type: ['string', 'null']
                },
                modelFormat: {
                    type: ['string', 'null']
                }
            }
        },
        infrastructure: {
            type: 'object',
            properties: {
                instanceType: {
                    type: ['string', 'null']
                },
                region: {
                    type: ['string', 'null']
                },
                roleArn: {
                    type: ['string', 'null']
                }
            }
        },
        configuration: {
            type: 'object',
            required: ['parameters'],
            properties: {
                parameters: {
                    type: 'object'
                }
            }
        },
        outcome: {
            type: 'object',
            properties: {
                notes: {
                    type: ['string', 'null']
                }
            }
        },
        metadata: {
            type: 'object',
            required: ['generatorVersion', 'source'],
            properties: {
                generatorVersion: {
                    type: 'string',
                    minLength: 1
                },
                source: {
                    type: 'string',
                    enum: ['local', 'imported', 'community']
                },
                importedFrom: {
                    type: ['string', 'null']
                }
            }
        }
    }
};
