// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property 11: Dockerfile renders baseImage in correct directive
 *
 * For any non-empty baseImage string: non-transformer Dockerfile contains
 * `FROM <baseImage>`, transformer Dockerfile contains `ARG BASE_IMAGE=<baseImage>`.
 *
 * Feature: transformer-base-image-picker
 * Validates: Requirements 7.1, 7.2
 */

<<<<<<< HEAD
import fc from 'fast-check'
import { describe, it } from 'mocha'
import assert from 'assert'
import ejs from 'ejs'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
=======
import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const dockerfileTemplate = readFileSync(
    path.join(__dirname, '../../generators/app/templates/Dockerfile'),
    'utf8'
<<<<<<< HEAD
)
=======
);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const FAST_PROPERTY_CONFIG = {
    numRuns: 50,
    timeout: 30000,
    verbose: false
<<<<<<< HEAD
}
=======
};
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Minimal template variables needed to render the Dockerfile without errors.
 */
function baseVars(overrides = {}) {
    return {
        projectName: 'test-project',
        buildTimestamp: '2025-01-01T00:00:00Z',
        framework: 'sklearn',
        modelServer: 'flask',
        modelName: 'test-model',
        modelFormat: 'pkl',
        includeSampleModel: false,
        comments: {},
        orderedEnvVars: [],
        hfToken: null,
        chatTemplate: null,
        baseImage: null,
        ...overrides
<<<<<<< HEAD
    }
=======
    };
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
}

// Arbitrary for a valid Docker image reference (org/repo:tag or repo:tag)
const arbBaseImage = fc.tuple(
<<<<<<< HEAD
    fc.stringMatching(/^[a-z][a-z0-9\-]{1,20}$/),
    fc.stringMatching(/^[a-z][a-z0-9\-]{1,20}$/),
    fc.stringMatching(/^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/)
).map(([org, repo, tag]) => `${org}/${repo}:${tag}`)

const TRANSFORMER_MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl']
=======
    fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{1,20}$/),
    fc.stringMatching(/^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/)
).map(([org, repo, tag]) => `${org}/${repo}:${tag}`);

const TRANSFORMER_MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl'];
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

describe('Property 11: Dockerfile renders baseImage in correct directive', () => {

    it('non-transformer Dockerfile contains FROM <baseImage> for any non-empty baseImage', function () {
<<<<<<< HEAD
        this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
        this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        fc.assert(fc.property(
            arbBaseImage,
            fc.constantFrom('sklearn', 'xgboost', 'tensorflow'),
            (baseImage, framework) => {
                const vars = baseVars({
                    framework,
                    baseImage
<<<<<<< HEAD
                })

                const output = ejs.render(dockerfileTemplate, vars)
=======
                });

                const output = ejs.render(dockerfileTemplate, vars);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                assert.ok(
                    output.includes(`FROM ${baseImage}`),
                    `Non-transformer Dockerfile should contain "FROM ${baseImage}" but got:\n${output.slice(0, 500)}`
<<<<<<< HEAD
                )
=======
                );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                // Should NOT contain ARG BASE_IMAGE for non-transformer
                assert.ok(
                    !output.includes('ARG BASE_IMAGE='),
                    'Non-transformer Dockerfile should not contain ARG BASE_IMAGE'
<<<<<<< HEAD
                )

                return true
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })

    it('transformer Dockerfile contains ARG BASE_IMAGE=<baseImage> for any non-empty baseImage', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('transformer Dockerfile contains ARG BASE_IMAGE=<baseImage> for any non-empty baseImage', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        fc.assert(fc.property(
            arbBaseImage,
            fc.constantFrom(...TRANSFORMER_MODEL_SERVERS),
            (baseImage, modelServer) => {
                const vars = baseVars({
                    framework: 'transformers',
                    modelServer,
                    baseImage
<<<<<<< HEAD
                })

                const output = ejs.render(dockerfileTemplate, vars)
=======
                });

                const output = ejs.render(dockerfileTemplate, vars);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                assert.ok(
                    output.includes(`ARG BASE_IMAGE=${baseImage}`),
                    `Transformer Dockerfile should contain "ARG BASE_IMAGE=${baseImage}" but got:\n${output.slice(0, 500)}`
<<<<<<< HEAD
                )
=======
                );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                // Should also contain FROM ${BASE_IMAGE} (the Docker ARG reference)
                assert.ok(
                    output.includes('FROM ${BASE_IMAGE}'),
                    'Transformer Dockerfile should contain FROM ${BASE_IMAGE}'
<<<<<<< HEAD
                )

                return true
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })
})
=======
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
