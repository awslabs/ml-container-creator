# HyperPod Ops Surface — Capability Map

> Generated: 2026-07-16. Authoritative reference for all HyperPod ops script work. Source spec: `.kiro/specs/bl063-hyperpod-ops-surface/`

---

## Summary Table

| Script | Status | Guard Type | HP Implementation |
| --- | --- | --- | --- |
| `do/adapter` | **needs-hp-path** | deployment-existence | vLLM `POST /v1/load_lora_adapter` for hot-load; no rolling update needed |
| `do/add-ic` | **smai-only** | hard-exit | N/A — Inference Components don't exist on K8s |
| `do/benchmark` | **needs-hp-path** | deployment-existence | vLLM `/metrics` Prometheus endpoint + curl loop |
| `do/build` | **works** | none | Docker build — fully target-agnostic |
| `do/ci` | **smai-only** | hard-exit | N/A — Lambda/Step Functions/CodeBuild harness is SMAI-specific |
| `do/clean` | **works** | none | `clean.d/hyperpod-eks` dispatcher already exists |
| `do/config` | **works** | none | Config file — fully target-agnostic |
| `do/deploy` | **works** | none | `deploy.d/hyperpod-eks` dispatcher already exists |
| `do/evaluate` | **future-scope** | none | Post-training eval — E7-G3 scope (K8s Job) |
| `do/export` | **partial** | none | Project export works; endpoint-specific metadata fields inapplicable on HP |
| `do/logs` | **works** | deployment-existence | kubectl logs — already has EJS branch |
| `do/manifest` | **works** | none | Generates K8s manifest — target-agnostic |
| `do/optimize` | **partial** | soft-warning | Athena + Reasoning MCP path works; SageMaker AI Recommendations is SMAI-only |
| `do/push` | **works** | none | ECR push — fully target-agnostic |
| `do/register` | **partial** | none | `--model` (MPG) works everywhere; `--endpoint`/`--ic` are SMAI-only |
| `do/run` | **works** | none | `docker run` locally — fully target-agnostic |
| `do/stage` | **future-scope** | none | S3 staging for Training Jobs; HP uses FSx/EFS via CSI — E7-G3 scope |
| `do/status` | **works** | deployment-existence | kubectl rollout status — already has EJS branch |
| `do/submit` | **future-scope** | none | Submits SageMaker jobs — E7-G3 scope |
| `do/test` | **works** | deployment-existence | Port-forward + curl — already has EJS branch |
| `do/train` | **future-scope** | none | SageMaker Training Jobs — E7-G3 scope (K8s Job path) |
| `do/tune` | **future-scope** | none | SageMaker HPO — E7-G3 scope (K8s Job path) |
| `do/validate` | **works** (partial) | none | Schema validation is target-agnostic; SageMaker API checks skipped on HP |

---

## Guard Types

| Guard Type | Behavior | Exit Code | Source |
| --- | --- | --- | --- |
| **hard-exit** | Script has zero utility on HyperPod. Prints error + alternative, exits immediately. | `1` | `templates/do/add-ic`, `templates/do/ci` |
| **soft-warning** | Parts of the script work. Prints warning for SMAI-only path, continues execution. | continues | Planned for `do/optimize` |
| **deployment-existence** | Verifies an active deployment exists at current `DEPLOYMENT_TARGET` before proceeding. Graceful exit if missing. | `0` | `templates/do/lib/deployment-state.sh` → `_check_active_deployment()` |
| **none** | No guard needed — script is fully target-agnostic or already dispatches internally. | N/A | — |

---

## Per-Script Detail

### do/adapter

**Status**: needs-hp-path **Guard**: deployment-existence (`_check_active_deployment`) **SMAI path**: `UpdateInferenceComponent` — rolling update to swap model artifact on an IC **HyperPod path**: vLLM dynamic LoRA via `POST /v1/load_lora_adapter`. Accepts adapter name + path. Hot-load without pod restart — potentially *better* UX than SMAI (instant, no rolling update). **Open questions**: Does vLLM accept S3 URI directly or require pre-downloaded local path? What `LORA_MODULES` env var format is needed at startup? **Implementation task**: Detect `DEPLOYMENT_TARGET=hyperpod-eks` in `do/adapter`. For `--load-lora`: port-forward to vLLM pod, POST to `/v1/load_lora_adapter` with adapter config from `do/adapters/<name>.conf`. For `--list`: GET `/v1/models` and filter LoRA entries. For `--unload`: POST `/v1/unload_lora_adapter`. File changes: `templates/do/adapter` (add HP branch), possibly new helper `templates/do/lib/python/lora_vllm.py`. **User-facing change**: `do/adapter` detects `DEPLOYMENT_TARGET=hyperpod-eks` and uses vLLM LoRA API instead of UpdateInferenceComponent.

---

### do/add-ic

**Status**: smai-only **Guard**: hard-exit (implemented) **Guard location**: `templates/do/add-ic`, lines 20–24 **Error message**:

```
❌ do/add-ic is not supported on HyperPod.
   Inference Components are a SageMaker managed inference concept.
   To load an adapter on HyperPod, use: do/adapter --load-lora

```

**Redirect**: `do/adapter --load-lora`

---

### do/benchmark

**Status**: needs-hp-path **Guard**: deployment-existence (`_check_active_deployment`) **SMAI path**: AIPerf via `InvokeEndpoint` — runs SageMaker benchmarking job **HyperPod path**: Port-forward to vLLM pod, scrape `/metrics` for Prometheus metrics (TTFT, ITL, throughput) + optionally drive inference load via curl loop or k6. Metrics mapping: `vllm:time_to_first_token_seconds` → TTFT, `vllm:inter_token_latency_seconds` → ITL, `vllm:generation_tokens_total` → throughput. **Implementation task**: Add `DEPLOYMENT_TARGET=hyperpod-eks` branch in `do/benchmark`. Steps: (1) port-forward to pod, (2) drive concurrent requests via curl or k6, (3) scrape `/metrics` endpoint at intervals, (4) parse Prometheus output into the same JSON report format that AIPerf produces. `do/benchmark --recommend` (Athena + Reasoning MCP path) works on any target — no guard needed. **User-facing change**: `do/benchmark` on HP uses direct vLLM metrics instead of AIPerf.

---

### do/build

**Status**: works **Guard**: none **Notes**: Docker build is fully target-agnostic. No changes needed.

---

### do/ci

**Status**: smai-only **Guard**: hard-exit (implemented) **Guard location**: `templates/do/ci`, lines 14–19 **Error message**:

```
❌ do/ci is not supported on HyperPod.
   The CI harness uses Lambda, Step Functions, and CodeBuild,
   which are SageMaker managed inference specific.
   For HyperPod CI, use your cluster's native CI/CD pipeline (e.g., ArgoCD, Flux).

```

**Redirect**: Native K8s CI/CD (ArgoCD, Flux, Tekton)

---

### do/clean

**Status**: works **Guard**: none **Notes**: Dispatcher pattern — `clean.d/hyperpod-eks` already handles HP resources (deletes deployment, service, namespace). No changes needed.

---

### do/config

**Status**: works **Guard**: none **Notes**: Reads and displays resolved configuration. Fully target-agnostic.

---

### do/deploy

**Status**: works **Guard**: none **Notes**: Dispatcher pattern — `deploy.d/hyperpod-eks` already handles HP deployment (applies K8s manifest, waits for rollout). No changes needed.

---

### do/evaluate

**Status**: future-scope **Guard**: none **Notes**: Post-training evaluation against model outputs. Currently uses SageMaker Processing Jobs. HyperPod equivalent: K8s Job running the eval script against model served in-cluster. **Epic**: E7-G3 (HyperPod Training & Evaluation)

---

### do/export

**Status**: partial **Guard**: none **SMAI path**: Exports full project config including endpoint names, IC references, scaling policies **HyperPod path**: Core project export (code, config, Dockerfile, K8s manifests) works. Endpoint-specific metadata fields (IC names, endpoint ARNs, scaling config) are inapplicable — should be omitted or marked as SMAI-only in the export archive. **Implementation task**: In `do/export`, when `DEPLOYMENT_TARGET=hyperpod-eks`: skip endpoint/IC metadata sections from the export. Include K8s manifest and HP-specific config instead. Minimal change — conditionally include/exclude sections based on target. **User-facing change**: Export on HP produces a portable archive without SMAI-specific metadata.

---

### do/logs

**Status**: works **Guard**: deployment-existence (`_check_active_deployment`) **Notes**: Already has EJS branch — uses `kubectl logs` with pod selector. No changes needed.

---

### do/manifest

**Status**: works **Guard**: none **Notes**: Generates K8s deployment manifest. Target-agnostic (the manifest *is* the HP artifact).

---

### do/optimize

**Status**: partial **Guard**: soft-warning (for AI Recommendations path only) **SMAI path**: SageMaker AI Recommendations — full optimization analysis via managed service **HyperPod path**: `do/benchmark --recommend` (Athena query + Reasoning MCP) works on any target. AI Recommendations path should display warning when `DEPLOYMENT_TARGET=hyperpod-eks`:

```
⚠️  SageMaker AI Recommendations is not available on HyperPod.
   Using do/benchmark --recommend for configuration suggestions.

```

**Implementation task**: In `do/optimize`, detect `DEPLOYMENT_TARGET=hyperpod-eks`. If the user invokes the AI Recommendations path: print warning, suggest `do/benchmark --recommend` as alternative. If the user invokes the Athena/recommend path: proceed normally (no guard). Script does NOT exit — it redirects. **User-facing change**: `do/optimize` on HP warns about AI Recommendations and falls through to the portable recommend path.

---

### do/push

**Status**: works **Guard**: none **Notes**: ECR push is target-agnostic. Same image goes to SMAI or HP.

---

### do/register

**Status**: partial **Guard**: none (subcommand-level routing) **SMAI path**: `--model` registers in MPG (Model Package Group). `--endpoint` / `--ic` registers deployment metadata. **HyperPod path**: `do/register --model` works everywhere — MPG is independent of deployment target. `do/register --endpoint` and `do/register --ic` are SMAI-only — should error on HP:

```
❌ do/register --endpoint is not supported on HyperPod.
   Endpoints are a SageMaker managed inference concept.
   To register the model artifact, use: do/register --model

```

**Implementation task**: In `do/register`, after parsing subcommand: if `--endpoint` or `--ic` and `DEPLOYMENT_TARGET=hyperpod-eks` → hard-exit with error. `--model` path unchanged. File: `templates/do/register`. **User-facing change**: `do/register --model` works on HP; `--endpoint`/`--ic` give clear error with redirect.

---

### do/run

**Status**: works **Guard**: none **Notes**: Runs the container locally via `docker run`. Mounts model directory, resolves GPU flags, handles secrets. Purely local — fully target-agnostic. No SageMaker or K8s APIs involved.

---

### do/stage

**Status**: future-scope **Guard**: none **Notes**: Downloads model artifacts from HuggingFace to S3 for SageMaker Training Jobs. HyperPod training uses FSx/EFS volumes mounted via CSI drivers — different staging mechanism needed. **Epic**: E7-G3 (HyperPod Training)

---

### do/status

**Status**: works **Guard**: deployment-existence (`_check_active_deployment`) **Notes**: Already has EJS branch — uses `kubectl rollout status`. No changes needed.

---

### do/submit

**Status**: future-scope **Guard**: none **Notes**: Submits remote build/training to SageMaker (CodeBuild for builds, Training Jobs for training). HyperPod equivalent: K8s Job submission via kubectl. **Epic**: E7-G3

---

### do/test

**Status**: works **Guard**: deployment-existence (`_check_active_deployment`) **Notes**: Already has EJS branch — port-forwards to pod and runs curl-based inference test. No changes needed.

---

### do/train

**Status**: future-scope **Guard**: none **Notes**: Launches SageMaker Training Jobs. HyperPod equivalent: K8s Job with training container, FSx mount for data, GPU node selector. **Epic**: E7-G3

---

### do/tune

**Status**: future-scope **Guard**: none **Notes**: SageMaker Hyperparameter Optimization. HyperPod equivalent: K8s CronJob or Argo Workflows for HPO sweeps. **Epic**: E7-G3

---

### do/validate

**Status**: works (partial) **Guard**: none **Notes**: Schema-driven validation using Node.js `validate-runner.js`. Validates project structure and configuration against AWS service models. The validation logic is target-agnostic (checks config file schema, Dockerfile structure, manifest validity). No SageMaker API calls at runtime — it reads local files only. Any SageMaker-specific schema checks (e.g., endpoint config fields) are naturally skipped when those config sections don't exist in an HP project.

---

## Cross-Target Patterns

### Runtime detection

All target-aware scripts use:

```bash
if [ "${DEPLOYMENT_TARGET:-}" = "hyperpod-eks" ]; then
    # HyperPod path
fi

```

`DEPLOYMENT_TARGET` is set in `do/config` and defaults to `managed-inference` if unset.

### Deployment existence check

Scripts that operate against a live deployment source the shared library:

```bash
source "${SCRIPT_DIR}/lib/deployment-state.sh"
_check_active_deployment

```

Behavior:

- **HyperPod**: `kubectl rollout status deployment/$deploy_name -n $namespace --timeout=5s`
- **Managed/Realtime inference**: `aws sagemaker describe-endpoint` → check for `InService`
- **Async inference**: same, with `-async` suffix on endpoint name
- **Missing deployment**: prints `⚠️` warning + "Deploy first: ./do/deploy --target " + `exit 0` (graceful)

### `do/deploy --target` as focus command

If a deployment at the target is already InService, `do/deploy --target <mode>` skips the full deploy, confirms the active deployment, and writes `DEPLOYMENT_TARGET=<mode>` back to `do/config` so all subsequent `do/` scripts default to that target. This enables flipping between an active SMAI endpoint and an active HyperPod cluster with a single command.

---

## Implementation Roadmap

Ordered by priority and dependency. Effort estimates assume implementation + tests.

| # | Script | Work | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| 1 | `do/adapter --load-lora` | vLLM LoRA API integration (port-forward + POST) | ~1 day | Confirm vLLM LoRA endpoint format |
| 2 | `do/benchmark` HP path | vLLM `/metrics` scraping + load driver | ~1.5 days | Port-forward pattern from do/test |
| 3 | `do/register --model` guard | Subcommand-level routing; `--endpoint`/`--ic` error on HP | ~0.5 day | None |
| 4 | `do/optimize` soft-warning | Detect HP + AI Recommendations path → warn + redirect | ~0.5 day | None |
| 5 | `do/export` HP filtering | Conditionally omit SMAI metadata from export | ~0.5 day | None |
| 6 | `do/validate` HP awareness | Ensure SMAI-only schema checks gracefully skip on HP | ~0.25 day | Verify current behavior |

**Total estimated effort**: ~4.25 days

### Future scope (E7-G3 — HyperPod Training & Evaluation)

| Script | HP mechanism | Notes |
| --- | --- | --- |
| `do/train` | K8s Job with training container | FSx/EFS for data, GPU node selector |
| `do/tune` | K8s Job sweeps (Argo Workflows) | HPO coordinator needed |
| `do/stage` | FSx/EFS volume provisioning via CSI | Different from S3 staging |
| `do/submit` | kubectl apply -f job.yaml | K8s Job submission |
| `do/evaluate` | K8s Job for eval script | Post-training, in-cluster |

---

## HyperPod-Specific Script Candidates

Ops that make sense on HyperPod but have no SMAI equivalent:

| Candidate | Proposal | Rationale |
| --- | --- | --- |
| `do/scale` | **propose** | Scale HyperPod instance group via `UpdateCluster`. UX: `do/scale --replicas 3`. Clear value for pod autoscaling. |
| `do/kubectl` | **decline** | Thin wrapper adds little value over `kubectl` directly. Users already have kubeconfig configured. |
| `do/pods` | **decline** | `kubectl get pods -n $NS` is simple enough. Adding a script for one command is over-engineering. |

---

## Appendix: Guard Implementation Reference

### Hard-exit pattern (add-ic, ci)

```bash
# ── HyperPod guard ────────────────────────────────────────────────────────────
if [ "${DEPLOYMENT_TARGET:-}" = "hyperpod-eks" ]; then
    echo "❌ do/<script> is not supported on HyperPod."
    echo "   <reason>"
    echo "   <alternative>"
    exit 1
fi

```

### Deployment-existence pattern (test, logs, benchmark, adapter, optimize, status)

```bash
source "${SCRIPT_DIR}/lib/deployment-state.sh"
_check_active_deployment

```

### Soft-warning pattern (optimize)

```bash
if [ "${DEPLOYMENT_TARGET:-}" = "hyperpod-eks" ]; then
    echo "⚠️  <feature> is not available on HyperPod."
    echo "   <alternative>"
    # continues execution — does not exit
fi

```

