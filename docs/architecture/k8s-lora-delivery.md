<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# LoRA delivery and rank fit on Kubernetes (Wave 6.1)

How a LoRA adapter reaches a vLLM pod on `hyperpod-eks` and `eks`, how the serving
`max_lora_rank` is sized, how a rollout gets capacity on a single-node instance group, and
the live validation procedure (with rollback) that gated the design.

Related: [S3 buckets and layout](s3-layout.md) (the canonical adapter home),
[Adding a deployment target](deployment-target-authoring.md) (the `adapter_delivery`
descriptor field).

## 1. Where adapters live (canonical home)

Every servable adapter has ONE home in the core bucket, keyed by the base model it was
trained on (bucket consolidation Option D):

```
s3://<coreS3Bucket>/models/<org>/<base>/.mlcc-adapters/<project>/<name>/            adapter home
s3://<coreS3Bucket>/models/<org>/<base>/.mlcc-adapters/<project>/<name>/v<hash12>/  one adapter version + mlcc-adapter.json
s3://<coreS3Bucket>/models/mlcc-<project>/<name>/                                  full fine-tune + mlcc-model.json
s3://<artifactsS3Bucket>/<project>/tune|train|optimize/...                raw job output (never served as-is)
```

`templates/do/lib/python/s3_layout.py` is the only code that composes these paths
(shell callers use `do/lib/s3-layout.sh`). `<org>/<base>` is the model's Hugging Face id;
a JumpStart/hub id (for example `TUNE_MODEL_ID`) maps through the tune catalog, and an
unmapped id is refused, never guessed. `test/unit/s3-layout-path-drift.test.js` fails if
any other file assembles these paths.

The manifest (`mlcc-adapter.json`) records the source URI, source job, technique, rank
(`r` and `rank_pattern`), target modules, base model (+ revision when known), a content
hash, the `version`, who created it, and when.

Adapters are content-addressed (BL199). Each promotion writes `v<hash12>/`, the first 12
hex digits of the content hash, under the home. Identical content is the same version
(`unchanged`, nothing copied). New content is a new directory, and existing versions are
never rewritten or deleted automatically. Unversioned homes written before BL199, and
hand copies, stay valid canonical adapters. See
[S3 buckets and layout](s3-layout.md#content-addressed-adapter-versions-bl199).

### Producers

| Producer | What it writes |
|---|---|
| `do/tune` (job completes, or `./do/tune --status` resolves it) | Promotes `checkpoints/hf/` → canonical `tuned-<technique>[-<dataset>]`; `TUNE_ADAPTER_PATH_<T>` records the canonical URI, the raw path stays in `TUNE_OUTPUT_PATH_<T>` / `TUNE_OUTPUT_PATH_LATEST`. A full model goes to `models/mlcc-<project>/<name>/` and `TUNE_MODEL_PATH_<T>`. |
| `do/train` | Same, as `trained-<technique>` (`TRAIN_ADAPTER_PATH_<T>` / `TRAIN_MODEL_PATH_<T>`; raw in `TRAIN_OUTPUT_PATH_<T>`). |
| `do/adapter add --from-hub` | Downloads the repo and publishes the loose PEFT files straight to a canonical version. |
| `do/adapter add` / `update --from-weights` / `--from-registry` / `--from-tune` / `--from-train` | Promotes the source (prefix or `.tar.gz`) to a canonical version before loading. A canonical source (a version or an unversioned home) is used as-is. |
| `do/adapter promote <name> --from-tune <t>` | Backfills a finished job (projects tuned before this change). `--update-config` repoints `TUNE_ADAPTER_PATH_<T>` and keeps the old value in `TUNE_ADAPTER_SOURCE_<T>`. |

A promotion failure in `do/tune` / `do/train` never fails the job: the raw path stays the
recorded value and the output names the `do/adapter promote` command to retry.

## 2. Delivery per target

vLLM loads LoRA adapters from a LOCAL path, and the serving container has no AWS
credentials. The target descriptor (`templates/do/targets.d/<t>/manifest.json`) declares:

```json
"adapter_delivery": { "strategy": "model-prefix", "mount_path": "/opt/ml/model", "subdir": ".mlcc-adapters" }
```

| Target | Model mount | Adapter path in the pod |
|---|---|---|
| `hyperpod-eks` | operator S3 CSI mount of the IEC `modelLocation` (prefetch OFF when LoRA + S3 source) | `/opt/ml/model/.mlcc-adapters/<project>/<name>/v<hash12>` (an unversioned home: `…/<name>`) |
| `eks` | the S3 model mount (`EKS_MODEL_MOUNT=s3`, `STAGED_MODEL_PATH`) | same |
| `realtime-inference` | none — each adapter is its own inference component | the IC's `ArtifactUrl` is the canonical version (`…/<name>/v<hash12>/`) |

The vLLM `lora_name` is always `<name>`. The version only changes the path that is loaded.

`./do/adapter add <name> --from-*` on Kubernetes (`adapter_delivery.py deliver`):

1. Refusals first, from config and the live IEC, before any copy or engine call:
   Hugging Face / model-package source → `./do/stage` and redeploy; IEC still prefetching →
   `./do/deploy --target hyperpod-eks --force`; eks without the S3 mount → `EKS_MODEL_MOUNT=s3`.
2. Rank pre-check against the LIVE limit (pod env → IEC env → engine default).
3. A source that is not canonical is promoted under the canonical home of the adapter's
   base. The promotion picks the version directory from the content hash, so the pod path
   is printed after delivery. The dry-run plan reports `path: ""` and `path_home`.
4. A canonical adapter under THIS deployment's model prefix is loaded by path, with no
   copy. This covers both a version and an unversioned pre-BL199 home.
5. A canonical adapter under a DIFFERENT prefix (for example the same base re-staged
   elsewhere) is copied into this deployment's `.mlcc-adapters/<project>/<name>/v<hash12>/`
   only when the base id (and revision, when both are recorded) match. The copy has the
   same version as its source, and its manifest carries `serving_copy_of`. A different
   base is refused as incompatible.
6. `load_lora_adapter` with the in-pod path on EVERY Running pod, with per-pod results.
   It exits 1 if any pod failed.

`./do/adapter update <name> --from-*` runs the same delivery, then on every Running pod
unloads `<name>` and loads the version's path under the same `lora_name`. New content is
a new version path. The previous version stays intact on S3, so a pod that hasn't been
swapped yet, or a scale-out, never reads half-replaced files. Identical content reloads
the same path.

`./do/adapter remove <name>` unloads from every pod and deletes ONLY the serving copies it
made (every version whose manifest has `serving_copy_of`). Canonical adapters are deleted
only by `./do/clean adapters`, which deletes this project's `.mlcc-adapters/<project>/`
(every version) under every base and `models/mlcc-<project>/`. It never touches base
weights or another project's adapters. `do/stage` only adds objects (`aws s3 sync`
without `--delete`), so re-staging a base keeps its adapters. The realtime container's model sync excludes `.mlcc-adapters/*`.

Cross-project visibility: a pod serving a base sees every project's adapters for that base
on its mount. That is accepted for single-account MLCC; multi-tenancy is a non-goal.

## 3. Rank: techniques drive `max_lora_rank`

- The engine's default and allowed set live once, in the serve manifest
  (`templates/code/serve.d/vllm/manifest.json` `capability_map.lora_max_rank`: default 16,
  allowed 1, 8, 16, 32, 64, 128, 256, 320, 512).
- `do/tune` records `TUNE_LORA_RANK_<TECH>` at submit; deploy derives
  `snap_up(max(adapter_config r / rank_pattern of every recorded adapter, TUNE_LORA_RANK_*, default), allowed)`.
  An explicit `VLLM_MAX_LORA_RANK` wins, with a warning when it is below what the
  recorded adapters need.
- Memory cap: LoRA buffer bytes per GPU = `max_loras × rank × dtype_bytes × Σ_layers Σ_modules (in_local + out_local)`
  (column/row-parallel splits by TP) must be ≤ 10% of (per-GPU memory × utilization −
  per-GPU weights). Above the cap deploy refuses, naming the adapters and the numbers.
- `do/adapter add` refuses an adapter whose rank exceeds the live limit and prints the fix
  (raise the limit, `./do/deploy --target <t> --force`).

## 4. Rollout capacity: `--surge-node` (hyperpod-eks)

A changed pod template on a single-node instance group whose node's GPUs are all taken by
the serving pod cannot schedule a surge pod. `./do/deploy --target hyperpod-eks --force`
detects that BEFORE applying and stops (status unchanged), printing the command and the
cost note. It never scales replicas or a group to zero.

`./do/deploy --target hyperpod-eks --force --surge-node`: raise the group's count by 1
(`UpdateCluster`), wait for the node, apply, wait for the new pod Ready and the old pod
gone, then restore the count by removing the vacated node. A trap restores the count on any
exit after the increase; capacity errors are printed verbatim. When nothing in the pod
template changed (`kubectl diff` is empty) there is no rollout at all.

Cold start with prefetch off (measured, BL193): model load ~513 s and pod ready ~15 min,
versus 3 s model load with prefetch. Prefetch is turned off only for LoRA + S3 source.

## 5. Bootstrap `eks` module (R5)

The `aws-mountpoint-s3-csi-driver` add-on's `ServiceAccountRoleArn` is the module's
`S3CsiRole`. The role reads (`s3:GetObject`, `s3:ListBucket`, `s3:GetBucketLocation`) the
core models bucket and the training / adapters buckets, and its TLS statement names MLCC's
real TLS bucket (rendered from `hyperpod/stacks/buckets.json`; the old `hyperpod-tls-*`
pattern never matched it). The add-on version is unchanged (the v1→v2 bump is separate).

Expected `cdk diff` for `mlcc-<profile>-eks-cluster` (verified by synthesizing `main` and
this change offline): exactly two resources modified, none added, removed or replaced —

```
[~] AWS::EKS::Addon  S3CsiDriverAddon                 ServiceAccountRoleArn (update, no interruption)
[~] AWS::IAM::Policy S3CsiRoleDefaultPolicyE2B11437   PolicyDocument
```

Run `ml-container-creator bootstrap update --module eks --dry-run` before applying and
stop if the diff shows anything else. `test/unit/bootstrap-eks-s3csi-cdk.test.js` asserts
the attachment, the grants, the TLS name, the unchanged logical ID, and the unchanged
add-on version.

## 6. Live validation procedure (R0) and rollback

Owner-run, on the live project, before building on the H5 assumptions (done 2026-10-23,
evidence in the validation report):

1. Back up the project's `do/`; record the live IEC:
   `kubectl get inferenceendpointconfig <project> -n <ns> -o yaml > iec-before.yaml`.
2. Add one node of the serving instance type to the instance group (count +1); wait Ready.
3. Apply a hand-edited IEC with `prefetchEnabled: false` and `VLLM_MAX_LORA_RANK=64`.
4. Check A1 (the mount is the `modelLocation` prefix), A2 (objects written after start are
   visible), A3 (the base loads with `.mlcc-adapters/` present), A4 (`load_lora_adapter` by
   local path for r32 and r64, then a chat request with `"model": "<adapter>"`), and the
   regressions (`./do/test`, a short `./do/benchmark`, `./do/adapter list` / `remove`).
5. Rollback: `kubectl apply -f iec-before.yaml`, wait for the pod, then restore the group
   count (remove the node that no longer hosts the serving pod — never the last Ready one).
6. Record the results; any failed assumption stops the design (fallback: a sidecar).
