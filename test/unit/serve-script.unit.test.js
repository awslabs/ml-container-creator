// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Example-based unit tests for the serve script template.
 *
 * Tests cover:
 * - download_model_from_s3 function: aws s3 cp, aws s3 sync, tar extraction,
 *   logging (URI, destination, duration), non-zero exit on failure
 * - Old prefix-stripping block is removed from rendered output
 * - jumpstart / jumpstart-hub / registry without URI produce error exit
 * - Pre-existing artifacts at /opt/ml/model skip download
 *
 * Feature: model-server-loading-adapter
 * Validates: Requirements 3.3, 4.2, 5.2, 6.2, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVE_TEMPLATE_PATH = resolve(__dirname, '../../templates/code/serve');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf-8');

// ── Helper: render serve template with defaults ──────────────────────────────

function renderServe(overrides = {}) {
    const vars = {
        modelServer: 'vllm',
        modelSource: 'huggingface',
        modelName: 'meta-llama/Llama-2-7b-hf',
        artifactUri: '',
        modelLoadStrategy: 'runtime',
        ...overrides
    };
    return ejs.render(SERVE_TEMPLATE, vars, { filename: SERVE_TEMPLATE_PATH });
}

// ── download_model_from_s3 tests ─────────────────────────────────────────────

describe('Feature: model-server-loading-adapter — serve script example-based tests', () => {

    describe('download_model_from_s3 function (Req 12.1–12.6)', () => {

        const s3Rendered = renderServe({
            modelSource: 's3',
            modelServer: 'vllm',
            artifactUri: 's3://my-bucket/my-model/'
        });

        it('contains aws s3 cp for single-file and tarball downloads', () => {
            // **Validates: Requirements 12.2, 12.4**
            assert.ok(
                s3Rendered.includes('aws s3 cp'),
                'download_model_from_s3 must use aws s3 cp for file downloads'
            );
        });

        it('contains aws s3 sync for directory prefix downloads', () => {
            // **Validates: Requirements 12.3**
            assert.ok(
                s3Rendered.includes('aws s3 sync'),
                'download_model_from_s3 must use aws s3 sync for directory downloads'
            );
        });

        it('contains tar extraction for .tar.gz files', () => {
            // **Validates: Requirements 12.4**
            assert.ok(
                s3Rendered.includes('*.tar.gz'),
                'download_model_from_s3 must handle .tar.gz tarballs'
            );
            assert.ok(
                s3Rendered.includes('tar -xzf'),
                'download_model_from_s3 must extract tarballs with tar -xzf'
            );
        });

        it('contains tar extraction for .tgz files', () => {
            // **Validates: Requirements 12.4**
            assert.ok(
                s3Rendered.includes('*.tgz'),
                'download_model_from_s3 must handle .tgz tarballs'
            );
        });

        it('logs the S3 URI and destination path', () => {
            // **Validates: Requirements 12.6**
            assert.ok(
                s3Rendered.includes('Downloading model from ${s3_uri} to ${dest_path}'),
                'download_model_from_s3 must log the URI and destination'
            );
        });

        it('logs download duration', () => {
            // **Validates: Requirements 12.6**
            assert.ok(
                s3Rendered.includes('${duration}s'),
                'download_model_from_s3 must log the download duration'
            );
            assert.ok(
                s3Rendered.includes('Download complete:'),
                'download_model_from_s3 must log completion message'
            );
        });

        it('returns non-zero exit code on failure', () => {
            // **Validates: Requirements 12.5**
            assert.ok(
                s3Rendered.includes('return 1'),
                'download_model_from_s3 must return 1 on failure'
            );
            // Check multiple failure paths exist
            const returnOneCount = (s3Rendered.match(/return 1/g) || []).length;
            assert.ok(
                returnOneCount >= 3,
                `download_model_from_s3 must have multiple failure paths (found ${returnOneCount})`
            );
        });

        it('logs errors to stderr', () => {
            // **Validates: Requirements 12.5**
            assert.ok(
                s3Rendered.includes('>&2'),
                'download_model_from_s3 must log errors to stderr'
            );
        });

        // ── Regression: aws progress must not pollute the captured model path ──
        // resolve_model() returns the model path on STDOUT via $(...), and that
        // value is exported into the engine's model env var (e.g. SGLANG_MODEL_PATH).
        // `aws s3 cp/sync` write their progress meter to STDOUT; if it leaks, the
        // env var becomes a multi-KB blob and every subsequent execve fails with
        // E2BIG ("Argument list too long"), bricking server startup. Two guards
        // must both be present:
        //   1) every `aws s3 cp/sync` silences progress at the source, and
        //   2) resolve_model redirects the downloader's stdout to stderr so only
        //      the deliberate path echo survives the capture.
        it('suppresses aws progress on every s3 cp/sync (E2BIG regression)', () => {
            // Match real invocations only (anchored at line start after indent),
            // not prose in comments that happens to mention `aws s3 cp/sync`.
            const awsCmds = s3Rendered.match(/^\s*(?:if ! )?aws s3 (?:cp|sync) [^\n]*/gm) || [];
            assert.ok(awsCmds.length >= 3, `expected cp + sync + tarball cp (found ${awsCmds.length})`);
            for (const cmd of awsCmds) {
                assert.ok(
                    cmd.includes('--no-progress') && cmd.includes('--only-show-errors'),
                    `aws s3 call must silence progress to avoid polluting the captured model path: ${cmd}`
                );
            }
        });

        it('redirects the downloader stdout to stderr in resolve_model (E2BIG regression)', () => {
            assert.ok(
                /download_model_from_s3 "\$MODEL_ARTIFACT_URI" "\$LOCAL_MODEL_PATH" 1>&2/.test(s3Rendered),
                'resolve_model must call download_model_from_s3 with stdout redirected to stderr (1>&2) so aws output cannot leak into the captured model path'
            );
        });
    });

    // ── Old prefix-stripping block removal ───────────────────────────────────

    describe('old prefix-stripping block is removed (Req 11.4)', () => {

        const servers = ['vllm', 'sglang', 'tensorrt-llm'];
        const sources = ['huggingface', 's3', 'jumpstart', 'jumpstart-hub', 'registry'];

        for (const modelServer of servers) {
            for (const modelSource of sources) {
                it(`${modelSource}+${modelServer}: no jumpstart:// prefix-stripping regex`, () => {
                    const rendered = renderServe({
                        modelSource,
                        modelServer,
                        artifactUri: 's3://bucket/model/'
                    });
                    assert.ok(
                        !rendered.includes('jumpstart://*'),
                        'Rendered output must NOT contain old jumpstart://* prefix-stripping pattern'
                    );
                    assert.ok(
                        !rendered.includes('registry://*'),
                        'Rendered output must NOT contain old registry://* prefix-stripping pattern'
                    );
                    assert.ok(
                        !rendered.includes('jumpstart-hub://*'),
                        'Rendered output must NOT contain old jumpstart-hub://* prefix-stripping pattern'
                    );
                });
            }
        }
    });

    // ── Error exits for sources without URI ──────────────────────────────────

    describe('jumpstart without URI and no local artifacts produces error exit (Req 4.2)', () => {

        for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm']) {
            it(`${modelServer}: jumpstart without artifactUri contains error exit`, () => {
                const rendered = renderServe({
                    modelSource: 'jumpstart',
                    modelServer,
                    artifactUri: ''
                });
                assert.ok(
                    rendered.includes('exit 1'),
                    'jumpstart without URI must contain exit 1'
                );
                assert.ok(
                    rendered.includes('requires artifact URI or pre-mounted artifacts'),
                    'jumpstart without URI must contain descriptive error message'
                );
            });
        }
    });

    describe('jumpstart-hub without URI produces error exit (Req 5.2)', () => {

        for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm']) {
            it(`${modelServer}: jumpstart-hub without artifactUri contains error exit`, () => {
                const rendered = renderServe({
                    modelSource: 'jumpstart-hub',
                    modelServer,
                    artifactUri: ''
                });
                assert.ok(
                    rendered.includes('exit 1'),
                    'jumpstart-hub without URI must contain exit 1'
                );
                assert.ok(
                    rendered.includes('requires artifact URI or pre-mounted artifacts'),
                    'jumpstart-hub without URI must contain descriptive error message'
                );
            });
        }
    });

    describe('registry without URI produces error exit (Req 6.2)', () => {

        for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm']) {
            it(`${modelServer}: registry without artifactUri contains error exit`, () => {
                const rendered = renderServe({
                    modelSource: 'registry',
                    modelServer,
                    artifactUri: ''
                });
                assert.ok(
                    rendered.includes('exit 1'),
                    'registry without URI must contain exit 1'
                );
                assert.ok(
                    rendered.includes('requires artifact URI or pre-mounted artifacts'),
                    'registry without URI must contain descriptive error message'
                );
            });
        }
    });

    // ── Pre-existing artifacts skip download ─────────────────────────────────

    describe('pre-existing artifacts at /opt/ml/model skip download (Req 3.5)', () => {

        for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm']) {
            for (const modelSource of ['s3', 'jumpstart', 'jumpstart-hub', 'registry']) {
                it(`${modelSource}+${modelServer}: checks /opt/ml/model before downloading`, () => {
                    const rendered = renderServe({
                        modelSource,
                        modelServer,
                        artifactUri: 's3://bucket/model/'
                    });
                    // The resolve_model function checks for pre-mounted artifacts
                    // via a non-empty-directory test on LOCAL_MODEL_PATH. Assert the
                    // BEHAVIOR (an emptiness check against the model dir) rather than
                    // a specific implementation string: the check uses a
                    // listing-free `find ... -print -quit` instead of expanding the
                    // directory with `ls -A`, so a huge model dir (K3 + its
                    // .cache/huggingface tree) is not inflated into a giant shell
                    // word.
                    assert.ok(
                        /find "\$LOCAL_MODEL_PATH" -mindepth 1 -print -quit/.test(rendered),
                        'Must check if LOCAL_MODEL_PATH has existing artifacts without expanding the listing'
                    );
                    assert.ok(
                        rendered.includes('Using pre-mounted model artifacts'),
                        'Must log message about using pre-mounted artifacts'
                    );
                });
            }
        }
    });

    // ── download_model_from_s3 is defined only for non-HF sources ────────────

    describe('download_model_from_s3 function presence (Req 12.1)', () => {

        it('huggingface source STILL defines download_model_from_s3 for a wrapper engine (ADR-010)', () => {
            // ADR-010: the download function is modelSource-INDEPENDENT for
            // wrapper-path engines. A huggingface-generated project can be staged
            // to S3 at deploy time (do/stage → MODEL_SOURCE=s3), and
            // resolve_model()'s always-emitted s3 branch calls this function —
            // gating its definition caused a `download_model_from_s3: command not
            // found` crash. It is inert unless MODEL_SOURCE=s3 at runtime.
            const rendered = renderServe({
                modelSource: 'huggingface',
                modelServer: 'vllm'
            });
            assert.ok(
                rendered.includes('download_model_from_s3()'),
                'Wrapper engine must define download_model_from_s3 regardless of generate-time source'
            );
        });

        for (const modelSource of ['s3', 'jumpstart', 'jumpstart-hub', 'registry']) {
            it(`${modelSource} source defines download_model_from_s3 for vllm`, () => {
                const rendered = renderServe({
                    modelSource,
                    modelServer: 'vllm',
                    artifactUri: 's3://bucket/model/'
                });
                assert.ok(
                    rendered.includes('download_model_from_s3()'),
                    `${modelSource} source must define download_model_from_s3 function`
                );
            });
        }
    });
});
