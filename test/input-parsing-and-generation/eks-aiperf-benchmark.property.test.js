// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Plain-EKS do/benchmark parity via local AIPerf.
 *
 * The eks target has no SageMaker endpoint, so instead of the SageMaker AI
 * Benchmarking service it runs NVIDIA AIPerf LOCALLY against the port-forwarded
 * pod and emits the SAME profile_export.jsonl the existing sweep / aggregator /
 * .benchmark_writer.py / Athena pipeline consumes. These tests cover:
 *   - the `aiperf profile` invocation flag shape (derived, not hardcoded),
 *   - synthetic vs BYOD mutual exclusion,
 *   - the served-model + manifest-derived serving port (not hardcoded 8080),
 *   - the AIPerf-unavailable fail-loud,
 *   - the artifact relocation to the aggregator's expected path,
 *   - the Phase-2 eks kubeconfig branch,
 *   - the eks writer wiring (deployment_target=eks, full metric set via the
 *     shared writer) and the eks metrics_source provenance branch,
 *   - the analytics-verb applicability (read-only ON, --apply degrades).
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.join(__dirname, '../..');

const benchmarkSrc = readFileSync(path.join(REPO, 'templates/do/benchmark'), 'utf8');
const writerSrc = readFileSync(path.join(REPO, 'templates/do/.benchmark_writer.py'), 'utf8');
const DRIVER = path.join(REPO, 'templates/do/lib/python/eks_aiperf.py');

// Resolve the REAL python3 via a NON-login shell and run it by absolute path, so
// a PATH stub elsewhere cannot re-resolve env python3 into recursion. Give every
// child a timeout so a runaway cannot hang mocha.
const PYTHON3 = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();

/** Run the eks_aiperf driver with the given argv + env, returning stdout. */
function runDriver(args, env = {}) {
    return execFileSync(PYTHON3, [DRIVER, ...args], {
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, ...env }
    }).trim();
}

/** Extract the `_run_eks_aiperf_benchmark` function body from the script text. */
function eksFnBody() {
    const idx = benchmarkSrc.indexOf('_run_eks_aiperf_benchmark()');
    assert.ok(idx >= 0, 'benchmark must define _run_eks_aiperf_benchmark()');
    // Slice to the function's closing brace (a column-0 "}") rather than a fixed
    // character window, so growth inside the function (e.g. the Wave 6.1 R7c
    // adapter check) cannot push assertions out of view.
    const end = benchmarkSrc.indexOf('\n}\n', idx);
    return benchmarkSrc.slice(idx, end === -1 ? undefined : end + 2);
}

describe('Plain-EKS AIPerf benchmark', () => {
    // ── The aiperf profile invocation flag shape (derived) ───────────────────
    describe('aiperf profile invocation flag map', () => {
        it('synthetic run maps the SageMaker workload spec 1:1 to aiperf flags', () => {
            const out = runDriver(
                ['build-command', '--local-port', '18080', '--artifact-dir', '/tmp/art'],
                {
                    MODEL_NAME: 's3://bucket/model/',
                    HF_MODEL_ID: 'Qwen/Qwen3-0.6B',
                    BENCHMARK_CONCURRENCY: '4',
                    BENCHMARK_REQUEST_COUNT: '50',
                    BENCHMARK_STREAMING: 'true',
                    BENCHMARK_INPUT_TOKENS_MEAN: '100',
                    BENCHMARK_OUTPUT_TOKENS_MEAN: '200',
                    VLLM_TRUST_REMOTE_CODE: 'true',
                    BENCHMARK_DATASET_LOCAL_FILE: ''
                }
            );
            const cmd = out.split('\n');
            assert.strictEqual(cmd[0], 'aiperf');
            assert.strictEqual(cmd[1], 'profile');
            const flat = cmd.join(' ');
            assert.ok(flat.includes('--url localhost:18080'), 'uses the port-forward url');
            assert.ok(flat.includes('--endpoint-type chat'), 'drives the OpenAI chat API');
            assert.ok(flat.includes('--endpoint /v1/chat/completions'), 'chat completions route');
            assert.ok(flat.includes('--model /opt/ml/model'), 's3 model → /opt/ml/model');
            assert.ok(flat.includes('--tokenizer Qwen/Qwen3-0.6B'), 'tokenizer is HF_MODEL_ID');
            assert.ok(flat.includes('--tokenizer-trust-remote-code'), 'trust-remote-code forwarded');
            assert.ok(flat.includes('--streaming'), 'streaming enabled');
            assert.ok(flat.includes('--concurrency 4'), 'concurrency from config');
            assert.ok(flat.includes('--request-count 50'), 'request count from config');
            assert.ok(flat.includes('--artifact-directory /tmp/art'), 'artifact dir points at pipeline path');
        });

        it('omits --tokenizer-trust-remote-code and --streaming when off', () => {
            const out = runDriver(
                ['build-command', '--local-port', '18080', '--artifact-dir', '/tmp/art'],
                {
                    MODEL_NAME: 'Qwen/Qwen3-0.6B',
                    HF_MODEL_ID: 'Qwen/Qwen3-0.6B',
                    BENCHMARK_STREAMING: 'false',
                    VLLM_TRUST_REMOTE_CODE: 'false',
                    BENCHMARK_DATASET_LOCAL_FILE: ''
                }
            );
            assert.ok(!out.includes('--tokenizer-trust-remote-code'));
            assert.ok(!out.split('\n').includes('--streaming'));
            // HF model (not s3) → served under its own name.
            assert.ok(out.includes('Qwen/Qwen3-0.6B'));
        });
    });

    // ── Synthetic vs BYOD mutual exclusion (R3) ──────────────────────────────
    describe('synthetic vs BYOD mutual exclusion', () => {
        it('BYOD uses --input-file + single_turn and OMITS synthetic token means', () => {
            const out = runDriver(
                ['build-command', '--local-port', '19090', '--artifact-dir', '/tmp/art'],
                {
                    MODEL_NAME: 's3://b/m/',
                    HF_MODEL_ID: 'Qwen/Qwen3-0.6B',
                    BENCHMARK_CONCURRENCY: '8',
                    BENCHMARK_STREAMING: 'false',
                    BENCHMARK_DATASET_LOCAL_FILE: '/tmp/ds.jsonl'
                }
            );
            assert.ok(out.includes('--custom-dataset-type\nsingle_turn') || out.includes('single_turn'),
                'BYOD sets custom-dataset-type single_turn');
            assert.ok(out.includes('--input-file\n/tmp/ds.jsonl') || out.includes('/tmp/ds.jsonl'),
                'BYOD passes --input-file');
            assert.ok(!out.includes('--synthetic-input-tokens-mean'),
                'synthetic input-tokens-mean omitted on BYOD');
            assert.ok(!out.includes('--output-tokens-mean'),
                'synthetic output-tokens-mean omitted on BYOD');
        });

        it('synthetic includes both token means and no --input-file', () => {
            const out = runDriver(
                ['build-command', '--local-port', '18080', '--artifact-dir', '/tmp/art'],
                {
                    MODEL_NAME: 'Qwen/Qwen3-0.6B',
                    HF_MODEL_ID: 'Qwen/Qwen3-0.6B',
                    BENCHMARK_INPUT_TOKENS_MEAN: '550',
                    BENCHMARK_OUTPUT_TOKENS_MEAN: '150',
                    BENCHMARK_DATASET_LOCAL_FILE: ''
                }
            );
            assert.ok(out.includes('--synthetic-input-tokens-mean'));
            assert.ok(out.includes('--output-tokens-mean'));
            assert.ok(!out.includes('--input-file'));
        });
    });

    // ── Served-model + manifest-derived endpoint (R4, not hardcoded) ─────────
    describe('served-model + manifest-derived port', () => {
        it('derives the serving port from serve.d/<engine>/manifest.json, not a literal', () => {
            // vllm + sglang both declare metrics_endpoint.port=8080 in their manifest;
            // the value is DERIVED, not hardcoded in the eks path.
            const vllmPort = runDriver(['serving-port', 'vllm']);
            assert.ok(/^\d+$/.test(vllmPort), 'port is numeric');
            const manifest = JSON.parse(
                readFileSync(path.join(REPO, 'templates/code/serve.d/vllm/manifest.json'), 'utf8'));
            assert.strictEqual(Number(vllmPort), manifest.metrics_endpoint.port,
                'derived port must equal the manifest port');
        });

        it('served-model is /opt/ml/model for s3/registry sources, else MODEL_NAME', () => {
            assert.strictEqual(runDriver(['served-model'], { MODEL_NAME: 's3://b/m/' }), '/opt/ml/model');
            assert.strictEqual(runDriver(['served-model'], { MODEL_NAME: '/opt/ml/model' }), '/opt/ml/model');
            assert.strictEqual(runDriver(['served-model'], { MODEL_NAME: 'meta-llama/Llama-3.1-8B' }),
                'meta-llama/Llama-3.1-8B');
        });

        it('the eks benchmark path does NOT hardcode :8080 / :8080:8080 for the serving port', () => {
            const body = eksFnBody();
            assert.ok(body.includes('serving-port'),
                'eks path must derive the serving port via eks_aiperf.py serving-port');
            // The port-forward target must use the derived remote port, not a hardcoded :8080.
            assert.ok(/_EKS_LOCAL_PORT\}:\$\{_EKS_REMOTE_PORT\}/.test(body),
                'port-forward must map to the manifest-derived remote port');
        });
    });

    // ── AIPerf unavailable → fail loud (R6, OQ-2) ────────────────────────────
    describe('AIPerf-unavailable fail-loud', () => {
        it('the eks path checks for aiperf and fails loud with install guidance', () => {
            const body = eksFnBody();
            assert.ok(/command -v aiperf/.test(body),
                'must probe for aiperf on PATH');
            assert.ok(/pip install aiperf/.test(body),
                'must give pip install aiperf guidance');
            // Fail loud (exit), never silent fallback to a curl loop.
            const probeIdx = body.indexOf('command -v aiperf');
            const probeBlock = body.slice(probeIdx, probeIdx + 500);
            assert.ok(/exit 1/.test(probeBlock), 'missing aiperf must exit non-zero');
            assert.ok(!/curl .*seq /.test(body), 'must not retain the old sequential curl loop');
        });
    });

    // ── Artifact relocation (R2) ─────────────────────────────────────────────
    describe('artifact relocation', () => {
        it('relocates profile_export.jsonl to output/ for the aggregator', () => {
            const tmp = mkdtempSync(path.join(os.tmpdir(), 'eks-aiperf-reloc-'));
            try {
                const artDir = path.join(tmp, 'aiperf');
                const runDir = path.join(artDir, 'run-xyz');
                mkdirSync(runDir, { recursive: true });
                writeFileSync(path.join(runDir, 'profile_export.jsonl'), '{"metadata":{},"metrics":{}}\n');
                const dest = path.join(tmp, 'output', 'profile_export.jsonl');
                const printed = runDriver(['relocate', artDir, dest]);
                assert.strictEqual(printed, dest);
                assert.ok(existsSync(dest), 'relocated file must exist at the aggregator path');
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });

        it('relocation fails loud when aiperf produced no per-request jsonl', () => {
            const tmp = mkdtempSync(path.join(os.tmpdir(), 'eks-aiperf-reloc-miss-'));
            try {
                const artDir = path.join(tmp, 'aiperf');
                mkdirSync(artDir, { recursive: true });
                let threw = false;
                try {
                    execFileSync(PYTHON3, [DRIVER, 'relocate', artDir, path.join(tmp, 'o.jsonl')],
                        { encoding: 'utf8', timeout: 20000 });
                } catch (e) {
                    threw = true;
                    assert.strictEqual(e.status, 1, 'non-zero exit on missing jsonl');
                }
                assert.ok(threw, 'relocate must fail when no jsonl exists');
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });
    });

    // ── Phase-2 eks kubeconfig branch (R5) ───────────────────────────────────
    describe('Phase-2 eks kubeconfig branch', () => {
        it('_phase2_start_poller resolves plain-eks via aws eks update-kubeconfig, not describe-cluster', () => {
            const idx = benchmarkSrc.indexOf('_phase2_start_poller()');
            assert.ok(idx >= 0, 'poller function must exist');
            const fn = benchmarkSrc.slice(idx, idx + 4000);
            // Must branch on eks and NOT use the HyperPod describe-cluster API there.
            assert.ok(/DEPLOYMENT_TARGET:-\}" = "eks"/.test(fn),
                'poller must have an eks branch');
            const eksBranchIdx = fn.indexOf('"eks"');
            const eksBranch = fn.slice(eksBranchIdx, eksBranchIdx + 400);
            assert.ok(!/describe-cluster/.test(eksBranch),
                'the eks poller branch must not call aws sagemaker describe-cluster');
            assert.ok(/aws eks update-kubeconfig/.test(fn),
                'poller must use aws eks update-kubeconfig');
        });
    });

    // ── Shared writer wiring + no SageMaker service (R2, R6) ─────────────────
    describe('shared writer wiring', () => {
        it('eks path feeds the SHARED .benchmark_writer.py and never calls the SageMaker service', () => {
            const body = eksFnBody();
            assert.ok(/\.benchmark_writer\.py" write/.test(body),
                'eks path must call the shared benchmark writer');
            assert.ok(/--config-file/.test(body),
                'writer gets --config-file so deployment_target=eks flows from do/config');
            // No SageMaker benchmarking service calls on the eks path.
            assert.ok(!/create-ai-workload-config/.test(body),
                'eks path must not create-ai-workload-config');
            assert.ok(!/create-ai-benchmark-job/.test(body),
                'eks path must not create-ai-benchmark-job');
        });

        it('eks path writes output/profile_export.jsonl and the /tmp marker for the sweep', () => {
            const body = eksFnBody();
            assert.ok(/output\/profile_export\.jsonl/.test(body),
                'produces output/profile_export.jsonl the aggregator reads');
            assert.ok(/\.mlcc-benchmark-latest-\$\{PROJECT_NAME\}/.test(body),
                'sets the multi-level marker');
        });

        it('.benchmark_writer.py labels an eks run engine_metrics_only (derived from the descriptor)', () => {
            // Wave 9: provenance is keyed by the descriptor's observability block,
            // not a per-target branch — eks declares store none + fallback
            // engine-scrape, and a scrape-only row is engine_metrics_only.
            const eks = JSON.parse(readFileSync(path.join(REPO, 'templates/do/targets.d/eks/manifest.json'), 'utf8'));
            assert.strictEqual(eks.observability.store, 'none');
            assert.strictEqual(eks.observability.fallback, 'engine-scrape');
            assert.ok(/_SCRAPE_PROVENANCE = 'engine_metrics_only'/.test(writerSrc),
                'scrape-only provenance must be engine_metrics_only');
            assert.ok(/obs\.get\('fallback'\) == 'engine-scrape'/.test(writerSrc),
                'the writer must read the scrape fallback from the descriptor');
        });
    });

    // ── OQ-3 analytics-verb applicability ────────────────────────────────────
    describe('analytics-verb applicability (OQ-3)', () => {
        it('--recommend --apply degrades on eks with a clear message (no do/ic write)', () => {
            const idx = benchmarkSrc.indexOf('ARG_RECOMMEND_APPLY}" = "true"');
            assert.ok(idx >= 0, 'recommend --apply handler must exist');
            const block = benchmarkSrc.slice(idx, idx + 900);
            assert.ok(/DEPLOYMENT_TARGET:-\}" = "eks"/.test(block),
                '--apply must gate on eks');
            assert.ok(/--apply does not apply on the eks target/.test(block),
                'eks --apply must print a clear degrade message');
        });
    });
});
