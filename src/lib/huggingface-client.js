/**
 * HuggingFace Hub API Client
 * 
 * Fetches model metadata from HuggingFace Hub API with graceful error handling.
 * Uses Node.js built-in fetch API (available in Node 18+).
 * 
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.8, 11.10, 11.12
 */

export default class HuggingFaceClient {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || 'https://huggingface.co';
        this.timeout = options.timeout || 5000;
        this.offline = options.offline || false;
    }

    /**
     * Fetch model metadata from HuggingFace Hub API
     * @param {string} modelId - Model ID (e.g., "meta-llama/Llama-2-7b-chat-hf")
     * @returns {Promise<Object|null>} Model metadata or null on failure
     */
    async fetchModelMetadata(modelId) {
        if (this.offline) {
            return null;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(
                `${this.baseUrl}/api/models/${modelId}`,
                { signal: controller.signal }
            );

            clearTimeout(timeoutId);

            if (!response.ok) {
                // Handle rate limits
                if (response.status === 429) {
                    console.warn('HuggingFace API rate limit reached');
                    return null;
                }
                // Handle not found
                if (response.status === 404) {
                    return null;
                }
                // Other errors
                return null;
            }

            return await response.json();
        } catch (error) {
            // Handle timeout
            if (error.name === 'AbortError') {
                console.warn(`HuggingFace API timeout after ${this.timeout}ms`);
                return null;
            }
            // Handle network errors
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                console.warn('HuggingFace API network error');
                return null;
            }
            // Other errors - graceful fallback
            return null;
        }
    }

    /**
     * Fetch tokenizer config for chat template detection
     * @param {string} modelId - Model ID
     * @returns {Promise<Object|null>} Tokenizer config or null on failure
     */
    async fetchTokenizerConfig(modelId) {
        if (this.offline) {
            return null;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(
                `${this.baseUrl}/${modelId}/resolve/main/tokenizer_config.json`,
                { signal: controller.signal }
            );

            clearTimeout(timeoutId);

            if (!response.ok) {
                // Handle rate limits
                if (response.status === 429) {
                    console.warn('HuggingFace API rate limit reached');
                    return null;
                }
                // Handle not found
                if (response.status === 404) {
                    return null;
                }
                // Other errors
                return null;
            }

            return await response.json();
        } catch (error) {
            // Handle timeout
            if (error.name === 'AbortError') {
                console.warn(`HuggingFace API timeout after ${this.timeout}ms`);
                return null;
            }
            // Handle network errors
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                console.warn('HuggingFace API network error');
                return null;
            }
            // Other errors - graceful fallback
            return null;
        }
    }

    /**
     * Fetch model config for model architecture
     * @param {string} modelId - Model ID
     * @returns {Promise<Object|null>} Model config or null on failure
     */
    async fetchModelConfig(modelId) {
        if (this.offline) {
            return null;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(
                `${this.baseUrl}/${modelId}/resolve/main/config.json`,
                { signal: controller.signal }
            );

            clearTimeout(timeoutId);

            if (!response.ok) {
                // Handle rate limits
                if (response.status === 429) {
                    console.warn('HuggingFace API rate limit reached');
                    return null;
                }
                // Handle not found
                if (response.status === 404) {
                    return null;
                }
                // Other errors
                return null;
            }

            return await response.json();
        } catch (error) {
            // Handle timeout
            if (error.name === 'AbortError') {
                console.warn(`HuggingFace API timeout after ${this.timeout}ms`);
                return null;
            }
            // Handle network errors
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                console.warn('HuggingFace API network error');
                return null;
            }
            // Other errors - graceful fallback
            return null;
        }
    }
}
