/**
 * JSON Schema for Instance Accelerator Mapping
 * 
 * Defines the structure and validation rules for instance accelerator mapping entries.
 */

export default {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    patternProperties: {
        '^ml\\.[a-z0-9]+\\.[a-z0-9]+$': {  // instance type pattern
            type: 'object',
            required: [
                'family',
                'accelerator',
                'memory',
                'vcpus'
            ],
            properties: {
                family: {
                    type: 'string',
                    minLength: 1
                },
                accelerator: {
                    type: 'object',
                    required: ['type', 'hardware', 'architecture'],
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['cuda', 'neuron', 'cpu', 'rocm']
                        },
                        hardware: {
                            type: 'string',
                            minLength: 1
                        },
                        architecture: {
                            type: 'string',
                            minLength: 1
                        },
                        versions: {
                            type: ['array', 'null'],
                            items: {
                                type: 'string'
                            }
                        },
                        default: {
                            type: ['string', 'null']
                        }
                    }
                },
                memory: {
                    type: 'string',
                    pattern: '^[0-9]+ (GB|TB)$'
                },
                vcpus: {
                    type: 'number',
                    minimum: 1
                },
                notes: {
                    type: 'string'
                }
            }
        }
    }
};
