/**
 * Registry Loader
 *
 * Loads configuration data from catalog JSON files and transforms them
 * into the shapes expected by consumer modules (Configuration_Manager,
 * Configuration_Matcher, Prompt_Runner, Validation_Engine, Template_Engine).
 *
 * This is the adapter layer between catalog JSON (single source of truth)
 * and the generator's internal data shapes. No MCP runtime dependency.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Catalog file paths relative to this module
const CATALOG_PATHS = {
    modelServers: resolve(__dirname, '../../../servers/base-image-picker/catalogs/model-servers.json'),
    tritonBackends: resolve(__dirname, '../../../servers/base-image-picker/catalogs/triton-backends.json'),
    instances: resolve(__dirname, '../../../servers/instance-recommender/catalogs/instances.json'),
    popularTransformers: resolve(__dirname, '../../../servers/model-picker/catalogs/popular-transformers.json'),
    popularDiffusors: resolve(__dirname, '../../../servers/model-picker/catalogs/popular-diffusors.json'),
}

class RegistryLoader {
    constructor() {
        this._catalogCache = {}
    }

    /**
     * Load and parse a JSON catalog file with caching.
     * Returns null on failure (missing file, invalid JSON).
     */
    _loadCatalog(catalogPath) {
        if (this._catalogCache[catalogPath] !== undefined) {
            return this._catalogCache[catalogPath]
        }
        try {
            const raw = readFileSync(catalogPath, 'utf8')
            const data = JSON.parse(raw)
            this._catalogCache[catalogPath] = data
            return data
        } catch (error) {
            console.warn(`Failed to load catalog ${catalogPath}: ${error.message}`)
            this._catalogCache[catalogPath] = null
            return null
        }
    }

    /**
     * Load framework registry from model-servers.json catalog.
     *
     * Transforms catalog Image_Entry arrays into the shape:
     *   { frameworkName: { version: FrameworkConfig } }
     *
     * Where FrameworkConfig = {
     *   baseImage, accelerator, envVars, inferenceAmiVersion,
     *   recommendedInstanceTypes, validationLevel, profiles, notes
     * }
     *
     * @returns {Object} Framework registry or empty object on failure
     */
    async loadFrameworkRegistry() {
        try {
            const catalog = this._loadCatalog(CATALOG_PATHS.modelServers)
            if (!catalog) return {}

            const registry = {}
            for (const [frameworkName, entries] of Object.entries(catalog)) {
                if (!Array.isArray(entries)) continue
                registry[frameworkName] = {}

                for (const entry of entries) {
                    const version = entry.labels?.framework_version
                    if (!version) continue

                    registry[frameworkName][version] = {
                        baseImage: entry.image,
                        accelerator: entry.accelerator || { type: 'cpu', version: null, versionRange: { min: null, max: null } },
                        envVars: entry.defaults?.envVars || {},
                        inferenceAmiVersion: entry.defaults?.inferenceAmiVersion || '',
                        recommendedInstanceTypes: entry.defaults?.recommendedInstanceTypes || [],
                        validationLevel: entry.validationLevel || 'untested',
                        profiles: entry.profiles || {},
                        notes: entry.notes || '',
                    }
                }
            }
            return registry
        } catch (error) {
            console.warn(`Failed to load framework registry: ${error.message}`)
            return {}
        }
    }

    /**
     * Load model registry from popular-transformers.json and popular-diffusors.json.
     *
     * Merges both catalogs into a single object with the shape:
     *   { modelIdOrPattern: ModelConfig }
     *
     * Where ModelConfig = {
     *   family, chatTemplate, requiresTemplate, validationLevel,
     *   frameworkCompatibility, profiles, notes
     * }
     *
     * Maps catalog snake_case keys to camelCase:
     *   chat_template → chatTemplate
     *   framework_compatibility → frameworkCompatibility
     *   validation_level → validationLevel
     *
     * @returns {Object} Model registry or empty object on failure
     */
    async loadModelRegistry() {
        try {
            const transformers = this._loadCatalog(CATALOG_PATHS.popularTransformers) || {}
            const diffusors = this._loadCatalog(CATALOG_PATHS.popularDiffusors) || {}

            const registry = {}
            const allModels = { ...transformers, ...diffusors }

            for (const [modelId, entry] of Object.entries(allModels)) {
                registry[modelId] = {
                    family: entry.family || '',
                    chatTemplate: entry.chat_template ?? null,
                    requiresTemplate: entry.chat_template != null && entry.chat_template !== '',
                    validationLevel: entry.validation_level || 'experimental',
                    frameworkCompatibility: entry.framework_compatibility || {},
                    profiles: entry.profiles || {},
                    notes: entry.notes || '',
                }
            }
            return registry
        } catch (error) {
            console.warn(`Failed to load model registry: ${error.message}`)
            return {}
        }
    }

    /**
     * Load instance accelerator mapping from instances.json catalog.
     *
     * Transforms catalog entries into the shape:
     *   { instanceType: { family, accelerator: { type, hardware, architecture, versions, default }, memory, vcpus, notes } }
     *
     * @returns {Object} Instance accelerator mapping or empty object on failure
     */
    async loadInstanceAcceleratorMapping() {
        try {
            const catalog = this._loadCatalog(CATALOG_PATHS.instances)
            if (!catalog || !catalog.catalog) return {}

            const mapping = {}
            for (const [instanceType, entry] of Object.entries(catalog.catalog)) {
                mapping[instanceType] = {
                    family: entry.family || '',
                    accelerator: {
                        type: entry.acceleratorType || 'cpu',
                        hardware: entry.hardware || 'None',
                        architecture: entry.gpuArchitecture || 'None',
                        versions: entry.cudaVersions || null,
                        default: entry.defaultCudaVersion || null,
                    },
                    memory: entry.memGb ? `${entry.memGb} GB` : '0 GB',
                    vcpus: entry.vcpus || 0,
                    notes: entry.notes || '',
                }
            }
            return mapping
        } catch (error) {
            console.warn(`Failed to load instance accelerator mapping: ${error.message}`)
            return {}
        }
    }

    /**
     * Load Triton backend metadata from triton-backends.json catalog.
     *
     * Returns the catalog data directly since its shape already matches
     * what consumers expect.
     *
     * @returns {Object} Triton backends or empty object on failure
     */
    async loadTritonBackends() {
        try {
            const catalog = this._loadCatalog(CATALOG_PATHS.tritonBackends)
            return catalog || {}
        } catch (error) {
            console.warn(`Failed to load triton backends: ${error.message}`)
            return {}
        }
    }
}

export default RegistryLoader
