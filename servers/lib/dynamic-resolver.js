// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DynamicResolver — abstract base class for all dynamic data resolvers.
 *
 * Subclasses implement `fetch()` to retrieve data from an external source
 * (registry API, AWS API, etc.) and `supportedKeys()` to declare which
 * identifiers they handle.
 *
 * Concrete implementations:
 *   - ImageResolver (base-image-picker) — fetches container images
 *   - ClusterResolver (hyperpod-cluster-picker) — fetches HyperPod clusters
 */
class DynamicResolver {
    /**
     * Fetch data for a given key.
     *
     * @param {string} key - The identifier to resolve (e.g., framework name, cluster filter)
     * @param {object} [options] - Resolver-specific options (limit, timeout, etc.)
     * @returns {Promise<{items: object[], defaultItem: *|null}>}
     */
    async fetch(key, _options = {}) {
        throw new Error('fetch() must be implemented by subclass');
    }

    /**
     * Returns the list of keys this resolver can handle.
     * @returns {string[]}
     */
    supportedKeys() {
        throw new Error('supportedKeys() must be implemented by subclass');
    }
}

export { DynamicResolver };
