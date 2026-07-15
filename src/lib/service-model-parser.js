/* eslint-disable eqeqeq */
/**
 * Parses AWS service-2.json files into a queryable in-memory index.
 * Extracts operations, shapes, enums, constraints, and metadata.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */
export default class ServiceModelParser {
    /**
     * Parse a service-2.json file into an indexed representation.
     * Supports two formats:
     *   - Legacy REST-JSON (aws-sdk-js v2 style): { metadata, operations, shapes }
     *   - Smithy 2.0 (aws-sdk-js v3 style): { smithy, shapes } where each shape has a "type" field
     * @param {Object} rawModel - Parsed JSON content of service-2.json
     * @returns {Object} ServiceModelIndex with metadata, operations (Map), and shapes (Map)
     */
    parse(rawModel) {
        // Detect Smithy 2.0 format
        if (rawModel.smithy && rawModel.shapes && !rawModel.operations) {
            return this._parseSmithyModel(rawModel);
        }
        // Legacy format
        return this._parseLegacyModel(rawModel);
    }

    /**
     * Parse Smithy 2.0 format (aws-sdk-js v3 / GitHub aws-models).
     * Shape keys are fully-qualified: "com.amazonaws.sagemaker#CreateEndpointConfig"
     * Operations have type "operation"; structures have type "structure".
     */
    _parseSmithyModel(rawModel) {
        const shapes = rawModel.shapes || {};
        const metadata = { serviceId: 'unknown', protocol: 'smithy' };
        const operations = new Map();
        const shapesMap = new Map();

        // First pass: index all shapes by short name (strip namespace prefix)
        for (const [fqn, shape] of Object.entries(shapes)) {
            const shortName = fqn.includes('#') ? fqn.split('#')[1] : fqn;
            if (shape.type === 'operation') {
                const inputTarget = shape.input?.target;
                const outputTarget = shape.output?.target;
                const inputShort = inputTarget
                    ? (inputTarget.includes('#') ? inputTarget.split('#')[1] : inputTarget)
                    : null;
                const outputShort = outputTarget
                    ? (outputTarget.includes('#') ? outputTarget.split('#')[1] : outputTarget)
                    : null;
                operations.set(shortName, {
                    input: inputShort,
                    output: outputShort,
                    errors: (shape.errors || []).map(e => {
                        const t = e.target || '';
                        return t.includes('#') ? t.split('#')[1] : t;
                    })
                });
            } else {
                // structure, string, integer, list, map, enum, etc.
                const members = shape.members
                    ? new Map(Object.entries(shape.members).map(([k, v]) => {
                        const memberTarget = v.target || '';
                        const memberShort = memberTarget.includes('#')
                            ? memberTarget.split('#')[1] : memberTarget;
                        return [k, { shape: memberShort }];
                    }))
                    : new Map();
                // Extract enum values from traits or direct enum field
                const enumValues = shape.enums
                    ? Object.keys(shape.enums)
                    : (shape.traits?.['smithy.api#enum']
                        ? shape.traits['smithy.api#enum'].map(e => e.value)
                        : null);
                shapesMap.set(shortName, {
                    type: shape.type === 'enum' ? 'string' : (shape.type || 'structure'),
                    required: shape.required || [],
                    members,
                    enum: enumValues,
                    min: shape.traits?.['smithy.api#length']?.min ?? null,
                    max: shape.traits?.['smithy.api#length']?.max ?? null,
                    pattern: shape.traits?.['smithy.api#pattern'] ?? null,
                    member: shape.member
                        ? { shape: shape.member.target?.split('#')[1] || shape.member.target }
                        : null,
                    key: null,
                    value: null
                });
            }
        }

        return { metadata, operations, shapes: shapesMap };
    }

    /**
     * Parse legacy REST-JSON format (aws-sdk-js v2 style).
     */
    _parseLegacyModel(rawModel) {
        const metadata = rawModel.metadata || {};
        const operations = new Map();
        const shapes = new Map();

        if (rawModel.operations) {
            for (const [name, op] of Object.entries(rawModel.operations)) {
                operations.set(name, {
                    input: op.input ? op.input.shape : null,
                    output: op.output ? op.output.shape : null,
                    errors: (op.errors || []).map(e => e.shape)
                });
            }
        }

        if (rawModel.shapes) {
            for (const [name, shape] of Object.entries(rawModel.shapes)) {
                shapes.set(name, {
                    type: shape.type,
                    required: shape.required || [],
                    members: shape.members ? new Map(Object.entries(shape.members)) : new Map(),
                    enum: shape.enum || null,
                    min: shape.min != null ? shape.min : null,
                    max: shape.max != null ? shape.max : null,
                    pattern: shape.pattern || null,
                    member: shape.member || null,
                    key: shape.key || null,
                    value: shape.value || null
                });
            }
        }

        return { metadata, operations, shapes };
    }

    /**
     * Get the input shape for an API operation.
     * @param {Object} index - Parsed model index (ServiceModelIndex)
     * @param {string} operationName - e.g., 'CreateEndpointConfig'
     * @returns {Object|null} The resolved input shape definition, or null if not found
     */
    getOperationInputShape(index, operationName) {
        const op = index.operations.get(operationName);
        if (!op || !op.input) return null;
        return this.resolveShape(index, op.input);
    }

    /**
     * Resolve a shape reference to its full definition.
     * @param {Object} index - Parsed model index
     * @param {string} shapeName - Shape name from the model
     * @returns {Object|null} ShapeDefinition or null if not found
     */
    resolveShape(index, shapeName) {
        return index.shapes.get(shapeName) || null;
    }

    /**
     * Extract all enum values for a given shape.
     * @param {Object} index - Parsed model index
     * @param {string} shapeName - Shape name
     * @returns {Array<string>|null} Enum values or null if not an enum shape
     */
    getEnumValues(index, shapeName) {
        const shape = index.shapes.get(shapeName);
        if (!shape) return null;
        return shape.enum || null;
    }

    /**
     * Get statistics about the parsed model.
     * @param {Object} index - Parsed model index
     * @returns {{ shapeCount: number, enumCount: number, operationCount: number }}
     */
    getStats(index) {
        let enumCount = 0;
        for (const [, shape] of index.shapes) {
            if (shape.enum && shape.enum.length > 0) {
                enumCount++;
            }
        }

        return {
            shapeCount: index.shapes.size,
            enumCount,
            operationCount: index.operations.size
        };
    }
}
