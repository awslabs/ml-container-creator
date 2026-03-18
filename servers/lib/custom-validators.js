// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom value validation patterns for MCP servers.
 * Each server defines a regex pattern and validation function
 * for user-provided custom values.
 */

export const CUSTOM_VALIDATORS = {
    'base-image-picker': {
        pattern: /^[a-zA-Z0-9][a-zA-Z0-9._\-\/]*(:[a-zA-Z0-9._\-]+)?$/,
        validate(value) {
            if (!value || value.trim() === '') return 'Value is required'
            if (!this.pattern.test(value.trim())) return 'Invalid image format. Expected: [registry/]repository[:tag]'
            return true
        },
        errorMessage: 'Invalid image format. Expected: [registry/]repository[:tag]'
    },
    'instance-recommender': {
        pattern: /^ml\.[a-z0-9]+\.[a-z0-9]+$/,
        validate(value) {
            if (!value || value.trim() === '') return 'Value is required'
            if (!this.pattern.test(value.trim())) return 'Invalid instance type. Expected: ml.<family>.<size>'
            return true
        },
        errorMessage: 'Invalid instance type. Expected: ml.<family>.<size>'
    },
    'region-picker': {
        pattern: /^[a-z]{2,4}-[a-z]+-\d+$/,
        validate(value) {
            if (!value || value.trim() === '') return 'Value is required'
            if (!this.pattern.test(value.trim())) return 'Invalid region code. Expected: <partition>-<geo>-<number>'
            return true
        },
        errorMessage: 'Invalid region code. Expected: <partition>-<geo>-<number>'
    },
    'hyperpod-cluster-picker': {
        pattern: /^.+$/,
        validate(value) {
            if (!value || value.trim() === '') return 'Cluster name is required'
            return true
        },
        errorMessage: 'Cluster name is required'
    }
}
