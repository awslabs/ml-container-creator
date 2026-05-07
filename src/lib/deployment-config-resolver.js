/**
 * DeploymentConfigResolver
 *
 * Decomposes a flat deployment-config string into a structured
 * { architecture, backend, engine } triple. This is the single source
 * of truth for all valid deployment-config values, replacing the
 * scattered split('-') logic that was previously in ConfigManager,
 * PromptRunner, and index.js.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

/**
 * Canonical mapping from deployment-config strings to structured parts.
 * 2 http + 5 transformers + 7 triton + 1 diffusors = 15 total configs.
 */
const CANONICAL_CONFIGS = new Map([
    // HTTP architecture (2)
    ['http-flask',              { architecture: 'http',         backend: 'flask',         engine: null }],
    ['http-fastapi',            { architecture: 'http',         backend: 'fastapi',       engine: null }],

    // Transformers architecture (5)
    ['transformers-vllm',       { architecture: 'transformers', backend: 'vllm',          engine: null }],
    ['transformers-sglang',     { architecture: 'transformers', backend: 'sglang',        engine: null }],
    ['transformers-tensorrt-llm', { architecture: 'transformers', backend: 'tensorrt-llm', engine: null }],
    ['transformers-lmi',        { architecture: 'transformers', backend: 'lmi',           engine: null }],
    ['transformers-djl',        { architecture: 'transformers', backend: 'djl',           engine: null }],

    // Triton architecture (7)
    ['triton-fil',              { architecture: 'triton',       backend: 'fil',           engine: null }],
    ['triton-onnxruntime',      { architecture: 'triton',       backend: 'onnxruntime',   engine: null }],
    ['triton-tensorflow',       { architecture: 'triton',       backend: 'tensorflow',    engine: null }],
    ['triton-pytorch',          { architecture: 'triton',       backend: 'pytorch',       engine: null }],
    ['triton-vllm',             { architecture: 'triton',       backend: 'vllm',          engine: null }],
    ['triton-tensorrtllm',      { architecture: 'triton',       backend: 'tensorrtllm',   engine: null }],
    ['triton-python',           { architecture: 'triton',       backend: 'python',        engine: null }],

    // Diffusors architecture (1)
    ['diffusors-vllm-omni',     { architecture: 'diffusors',    backend: 'vllm-omni',     engine: null }]
]);

export default class DeploymentConfigResolver {
    /**
     * Decompose a deployment-config string into its constituent parts.
     *
     * @param {string} deploymentConfig - e.g. 'http-flask', 'transformers-vllm', 'triton-fil'
     * @returns {{ architecture: string, backend: string, engine: string|null }}
     * @throws {Error} if the deployment-config is not one of the 15 canonical values
     */
    decompose(deploymentConfig) {
        const parts = CANONICAL_CONFIGS.get(deploymentConfig);
        if (!parts) {
            const valid = this.getAllConfigs().join(', ');
            throw new Error(
                `Unsupported deployment-config: ${deploymentConfig}. Valid configs: ${valid}`
            );
        }
        return { ...parts };
    }

    /**
     * Compose a deployment-config string from structured parts.
     * Inverse of decompose().
     *
     * @param {{ architecture: string, backend: string, engine?: string }} parts
     * @returns {string}
     */
    compose(parts) {
        return `${parts.architecture}-${parts.backend}`;
    }

    /**
     * Get all 15 valid deployment-config strings.
     *
     * @returns {string[]}
     */
    getAllConfigs() {
        return [...CANONICAL_CONFIGS.keys()];
    }

    /**
     * Get valid deployment-config strings for a given architecture.
     *
     * @param {string} architecture - 'http' | 'transformers' | 'triton' | 'diffusors'
     * @returns {string[]}
     */
    getConfigsForArchitecture(architecture) {
        return this.getAllConfigs().filter(
            (dc) => CANONICAL_CONFIGS.get(dc).architecture === architecture
        );
    }

    /**
     * Check if a deployment-config string is valid.
     * Old-format strings (e.g. 'sklearn-flask') return false.
     *
     * @param {string} deploymentConfig
     * @returns {boolean}
     */
    isValid(deploymentConfig) {
        return CANONICAL_CONFIGS.has(deploymentConfig);
    }
}
