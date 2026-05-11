// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property tests verifying recommendedInstanceTypes is absent from catalogs and responses.
 *
 * Feature: mcp-catalog-consolidation, Property 3: No recommendedInstanceTypes in catalogs
 * Feature: mcp-catalog-consolidation, Property 4: No recommendedInstanceTypes in MCP responses
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

import { describe, it } from 'mocha'
import assert from 'assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBaseImage, TRANSFORMER_IMAGE_CATALOG } from '../servers/base-image-picker/index.js'
import { POPULAR_MODELS_CATALOG, resolveModel } from '../servers/model-picker/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CATALOGS_DIR = resolve(__dirname, '../servers/lib/catalogs')

/**
 * Recursively check that a key does not exist at any nesting level.
 */
function assertKeyAbsent(obj, key, path = '') {
    if (Array.isArray(obj)) {
        obj.forEach((item, i) => assertKeyAbsent(item, key, `${path}[${i}]`))
    } else if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
            assert.notStrictEqual(k, key, `Found "${key}" at ${path}.${k}`)
            assertKeyAbsent(v, key, `${path}.${k}`)
        }
    }
}

// ── Property 3: No recommendedInstanceTypes in catalogs ──────────────────────

describe('Feature: mcp-catalog-consolidation, Property 3: No recommendedInstanceTypes in catalogs', function () {
    this.timeout(30000)

    it('model-servers.json has no recommendedInstanceTypes at any nesting level', function () {
        const catalog = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'model-servers.json'), 'utf-8'))
        assertKeyAbsent(catalog, 'recommendedInstanceTypes')
    })

    it('models.json has no recommendedInstanceTypes at any nesting level', function () {
        const catalog = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'models.json'), 'utf-8'))
        assertKeyAbsent(catalog, 'recommendedInstanceTypes')
    })

    it('popular-transformers.json has no recommendedInstanceTypes at any nesting level', function () {
        const catalog = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'popular-transformers.json'), 'utf-8'))
        assertKeyAbsent(catalog, 'recommendedInstanceTypes')
    })

    it('popular-diffusors.json has no recommendedInstanceTypes at any nesting level', function () {
        const catalog = JSON.parse(readFileSync(resolve(CATALOGS_DIR, 'popular-diffusors.json'), 'utf-8'))
        assertKeyAbsent(catalog, 'recommendedInstanceTypes')
    })
})

// ── Property 4: No recommendedInstanceTypes in MCP responses ─────────────────

describe('Feature: mcp-catalog-consolidation, Property 4: No recommendedInstanceTypes in MCP responses', function () {
    this.timeout(30000)

    it('resolveBaseImage response has no recommendedInstanceTypes for vllm', async function () {
        const result = await resolveBaseImage({ framework: 'transformers', modelServer: 'vllm' }, 5)
        assertKeyAbsent(result, 'recommendedInstanceTypes')
    })

    it('resolveBaseImage response has no recommendedInstanceTypes for sglang', async function () {
        const result = await resolveBaseImage({ framework: 'transformers', modelServer: 'sglang' }, 5)
        assertKeyAbsent(result, 'recommendedInstanceTypes')
    })

    it('resolveBaseImage response has no recommendedInstanceTypes for tensorrt-llm', async function () {
        const result = await resolveBaseImage({ framework: 'transformers', modelServer: 'tensorrt-llm' }, 5)
        assertKeyAbsent(result, 'recommendedInstanceTypes')
    })

    it('model-picker catalog entries have no recommendedInstanceTypes', function () {
        assertKeyAbsent(POPULAR_MODELS_CATALOG, 'recommendedInstanceTypes')
    })
})
