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
     * @param {Object} rawModel - Parsed JSON content of service-2.json
     * @returns {Object} ServiceModelIndex with metadata, operations (Map), and shapes (Map)
     */
    parse(rawModel) {
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
