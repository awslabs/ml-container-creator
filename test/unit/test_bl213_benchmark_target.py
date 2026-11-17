# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL213 — benchmark rows are labelled with the target actually benchmarked.

Athena rows for the realtime endpoint sharp-gpt-bot (endpoint + inference
component) carried target=hyperpod-eks: the writer re-read DEPLOYMENT_TARGET from
do/config, where one focus var (and one ENDPOINT_NAME) is shared and overwritten
by every target. The writer now takes do/benchmark's --deployment-target, resolves
aliases through targets.d, and when the run benchmarked an inference component it
labels the row with the target whose descriptor hosts ICs (verbs.add-ic).

The CLI runs use --dry-run (no S3, no live pricing, no AWS call).
"""
import importlib.util
import json
import os
import subprocess
import sys

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
_WRITER = os.path.join(_REPO, 'templates', 'do', '.benchmark_writer.py')
_spec = importlib.util.spec_from_file_location('benchmark_writer_bl213', _WRITER)
bw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bw)
tm = bw._load_helper('target_manifest')

IC_HOSTS = [t for t in tm.list_targets() if (tm.read_manifest(t).get('verbs') or {}).get('add-ic') is True]
REALTIME = tm.resolve_target('realtime')        # canonical name, via the alias in targets.d
HYPERPOD = tm.resolve_target('hyperpod')

# do/config of a project that ran on hyperpod-eks before and serves realtime now:
# every hyperpod var is still present and DEPLOYMENT_TARGET is stale.
STALE_HP = {
    'PROJECT_NAME': 'sharp-gpt-bot', 'MODEL_NAME': 'meta-llama/Llama-3.2-1B-Instruct',
    'INSTANCE_TYPE': 'ml.g5.xlarge', 'DEPLOYMENT_CONFIG': 'transformers-vllm', 'AWS_REGION': 'us-west-2',
    'DEPLOYMENT_TARGET': HYPERPOD, 'DEPLOYMENT_TARGET_HP_STATUS': 'Running',
    'DEPLOYMENT_TARGET_SMAI_STATUS': 'InService', 'HP_CLUSTER_NAME': 'zz-hp', 'HP_NAMESPACE': 'default',
    'HP_INSTANCE_TYPE': 'ml.g5.xlarge', 'HP_GPU_COUNT': '1', 'ENDPOINT_NAME': 'sharp-gpt-bot-endpoint-1',
}


def _dry_run(tmp_path, config, *extra):
    results = tmp_path / 'results.json'
    results.write_text(json.dumps({'metrics': [{
        'concurrency': 2, 'output_token_throughput': 100.0, 'request_throughput': 1.0, 'total_requests': 10,
        'input_sequence_length': 200.0, 'output_sequence_length': 100.0}]}))
    cfg = tmp_path / 'config'
    cfg.write_text('\n'.join(f'export {k}="{v}"' for k, v in config.items()) + '\n')
    env = dict(os.environ, AWS_EC2_METADATA_DISABLED='true')
    out = subprocess.run([sys.executable, _WRITER, 'write', '--results-file', str(results),
                          '--config-file', str(cfg), '--dry-run', *extra],
                         capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0, out.stdout + out.stderr
    doc = json.loads(out.stdout)
    targets = {r['deployment_target'] for r in doc['records']}
    assert len(targets) == 1
    return doc['partition']['target'], targets.pop(), doc['s3_path'], out.stderr


def test_exactly_one_target_hosts_inference_components():
    # The relabel rule needs a unique IC host; fail loudly if descriptors change.
    assert IC_HOSTS == [REALTIME]


def test_realtime_run_with_stale_hyperpod_config_writes_realtime(tmp_path):
    """do/benchmark passes the target it ran plus the IC it benchmarked."""
    part, rec, s3, _ = _dry_run(tmp_path, STALE_HP, '--deployment-target', REALTIME,
                                '--endpoint-name', 'sharp-gpt-bot-endpoint-1', '--ic-name', 'sharp-gpt-bot-default-1')
    assert part == REALTIME and rec == REALTIME and f'/target={REALTIME}/' in s3


def test_ic_benchmark_relabels_a_stale_hyperpod_target(tmp_path):
    """Resume path (--status): only the job's IC is known; the stale config
    DEPLOYMENT_TARGET must not win over the IC the job benchmarked."""
    part, rec, _, err = _dry_run(tmp_path, STALE_HP, '--ic-name', 'sharp-gpt-bot-default-1')
    assert part == REALTIME and rec == REALTIME
    assert 'sharp-gpt-bot-default-1' in err


def test_realtime_config_with_leftover_hp_vars_stays_realtime(tmp_path):
    cfg = dict(STALE_HP, DEPLOYMENT_TARGET=REALTIME)
    part, rec, _, _ = _dry_run(tmp_path, cfg, '--ic-name', 'sharp-gpt-bot-default-1')
    assert part == REALTIME and rec == REALTIME


def test_a_real_hyperpod_run_is_still_labelled_hyperpod(tmp_path):
    cfg = dict(STALE_HP, DEPLOYMENT_TARGET=REALTIME)    # stale the OTHER way round
    part, rec, _, _ = _dry_run(tmp_path, cfg, '--deployment-target', HYPERPOD, '--endpoint-name', 'sharp-gpt-bot')
    assert part == HYPERPOD and rec == HYPERPOD


def test_resolve_benchmarked_target_rules():
    assert bw.resolve_benchmarked_target('hyperpod') == HYPERPOD          # alias -> canonical
    assert bw.resolve_benchmarked_target(HYPERPOD, 'ic-1') == REALTIME   # IC benchmarked
    assert bw.resolve_benchmarked_target(REALTIME, 'ic-1') == REALTIME
    assert bw.resolve_benchmarked_target('', 'ic-1') == REALTIME
    assert bw.resolve_benchmarked_target(HYPERPOD) == HYPERPOD
    assert bw.resolve_benchmarked_target('') == ''
    assert bw.resolve_benchmarked_target(None) == ''
