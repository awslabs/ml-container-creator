# The `do/` Script Contract

This guide covers everything you need to know to add a new `do/` script to MLCC — whether you're a human contributor or a coding agent. Every `do/` script in MLCC is governed by a machine-readable contract that controls runtime behavior, advisory agent suggestions, and developer ecosystem consistency.

---

## Why a contract system?

MLCC runs in two contexts: as a CLI tool operated by a developer, and as a project managed by a coding agent (Kiro, Claude Code, or the `mcc hey` advisory agent). The contract system serves both:

**For developers**: Scripts fail fast with actionable messages instead of cryptic AWS errors.

**For coding agents**: The advisory agent can reason about which scripts to suggest without reading 2000 lines of bash. When planning a goal like "deploy and benchmark this model," the agent reads contracts to determine sequencing — it won't suggest `do/benchmark` until it knows a deployment is active.

**For future script authors**: The contract header is the checklist you fill in. The enforcement is automatic.

---

## Anatomy of a `do/` script

Every `do/` script begins with this structure:

```bash
#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# do/myscript — One-line description of what this script does.
#
# @mlcc-script
# type: model-centric
# guard: none
# lifecycle: publish
# targets: all

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/script-contract.sh"   # auto-enforces declared guard
source "${SCRIPT_DIR}/config"
source "${SCRIPT_DIR}/lib/profile.sh"
```

The `@mlcc-script` block is the contract. `source lib/script-contract.sh` is the enforcer. Together, they replace all manual guard logic.

---

## The four contract fields

### `type`

What the script primarily operates on.

| Value | Use when… |
|---|---|
| `model-centric` | The script works regardless of whether anything is deployed. It operates on model artifacts, project files, or AWS registries. |
| `deployment-centric` | The script needs a live deployment to do anything useful. Without one, there's nothing to test, benchmark, or clean up. |
| `hybrid` | The script's *default* invocation is model-centric, but specific flags escalate to requiring a deployment. Use `_require_guard` inline for those flags. |

**Rule of thumb**: If you'd run it before `do/deploy`, it's `model-centric`. If it only makes sense after, it's `deployment-centric`.

---

### `guard`

The minimum precondition that must exist before the script runs. `script-contract.sh` enforces this automatically on source.

| Value | What must exist |
|---|---|
| `none` | Nothing — script always runs in a valid project directory |
| `artifact-ready` | Container image has been built and pushed to ECR (`ECR_IMAGE_URI` is set) |
| `model-staged` | Model weights are in S3 (`STAGED_MODEL_PATH` is set) |
| `deployment-active` | `DEPLOYMENT_TARGET_*_STATUS` equals `InService` for the current target |
| `training-infra` | Training bootstrap module is provisioned (S3 + IAM for SageMaker Training Jobs) |

**Picking the right guard**: Match the guard to your script's *minimum* viable precondition, not every possible use case. `do/benchmark` declares `deployment-active` because it can't do anything without a deployment — even though it also needs model weights, those are implied by having a running deployment.

---

### `lifecycle`

Where in the project lifecycle this script is intended to run. Used by the advisory agent for sequencing and goal planning. Not enforced at runtime.

| Value | Typical order | Examples |
|---|---|---|
| `configuration` | First | `do/config` |
| `build` | Early | `do/build`, `do/submit` |
| `local-test` | After build | `do/run` |
| `pre-deploy` | Before deploy | `do/validate` |
| `publish` | Before deploy | `do/push`, `do/stage`, `do/register` |
| `deploy` | Core action | `do/deploy` |
| `monitor` | After deploy | `do/status`, `do/logs`, `do/test` |
| `post-deploy` | Ongoing | `do/benchmark`, `do/optimize`, `do/adapter` |
| `teardown` | End of life | `do/clean` |
| `training` | Parallel track | `do/tune`, `do/train` |
| `ci` | Automation | `do/ci` |
| `metadata` | Any time | `do/manifest`, `do/export` |

---

### `targets`

Which deployment targets this script applies to. Use `all` for scripts that work the same way regardless of target.

**Values**: `all` or a comma-separated list from: `realtime-inference`, `async-inference`, `batch-transform`, `hyperpod-eks`

**When to restrict targets**: Only restrict when the script genuinely cannot run on a target — not just when the current implementation doesn't support it yet. `do/add-ic` is `realtime-inference` only because Inference Components don't exist on HyperPod by design. `do/benchmark` is `all` even though the HyperPod implementation is still pending — restrict only by intent, not by shipping state.

---

## Writing a new `do/` script

### Step 1: Define the contract

Answer these four questions:

1. **What does my script operate on?** → `type`
2. **What must exist before it runs?** → `guard`
3. **When in the lifecycle does it fit?** → `lifecycle`
4. **Which targets does it apply to?** → `targets`

Example: `do/draft` (speculative decoding configuration)
```
- type: deployment-centric   (configures a live deployment)
- guard: deployment-active   (requires a running endpoint/cluster)
- lifecycle: post-deploy     (runs after deploy, before benchmark)
- targets: realtime-inference, hyperpod-eks   (async/batch don't support speculative decoding)
```

### Step 2: Start from the template

```bash
#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# do/draft — Configure speculative decoding for an active deployment.
#
# @mlcc-script
# type: deployment-centric
# guard: deployment-active
# lifecycle: post-deploy
# targets: realtime-inference, hyperpod-eks

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/script-contract.sh"
source "${SCRIPT_DIR}/config"
source "${SCRIPT_DIR}/lib/profile.sh"

# Your script logic here
```

That's it. The guard fires automatically when the script is sourced — no manual check needed.

### Step 3: Handle flag escalations for `hybrid` scripts

If your script has a default model-centric path but also accepts flags that require a deployment:

```bash
# @mlcc-script
# type: hybrid
# guard: none         ← base case: no deployment required
# lifecycle: publish
# targets: all

source "${SCRIPT_DIR}/lib/script-contract.sh"
# ...

# Parse flags
WITH_DEPLOYMENT=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --with-endpoint)
            _require_guard deployment-active   # ← explicit escalation for this flag
            WITH_DEPLOYMENT=true ;;
    esac
    shift
done
```

`_require_guard` uses the same guard functions and exit code as the auto-enforcer. It's safe to call multiple times (stackable).

### Step 4: Add target-restriction guards for `target-restricted` scripts

If your script doesn't apply to all targets, add a target check near the top:

```bash
source "${SCRIPT_DIR}/lib/script-contract.sh"
# ...

# Restrict to supported targets
case "${DEPLOYMENT_TARGET:-}" in
    realtime-inference|hyperpod-eks) ;;   # supported
    *)
        echo "❌ do/draft is not supported on ${DEPLOYMENT_TARGET:-<unset>}."
        echo "   Speculative decoding requires: realtime-inference or hyperpod-eks."
        exit 1 ;;
esac
```

This is separate from the `targets` field in the annotation — the annotation is for the agent planner, the runtime check is for user-facing error messages.

### Step 5: Write tests

Every new `do/` script needs at minimum:

```javascript
// Contract enforcement test
it('exits with code 3 when guard is not met', () => {
    // Set environment to violate the guard
    // Run the script
    // Assert exit code === 3 and message contains guard name
});

// Happy path test
it('succeeds when guard is satisfied', () => {
    // Set environment to satisfy the guard
    // Run the script with minimal required config
    // Assert success
});
```

---

## The guard library reference

All guard functions live in `do/lib/script-contract.sh`.

### Auto-enforcement (always active)

Sourcing `script-contract.sh` reads the `# guard:` annotation from the calling script and calls the corresponding guard function automatically. No code needed.

### `_require_guard <guard-name>`

Explicit guard enforcement for flag-escalation paths. Same exit code and message format as auto-enforcement.

```bash
_require_guard deployment-active
_require_guard model-staged
_require_guard training-infra
```

### `_guard_met <guard-name>`

Non-enforcing guard query. Returns 0 (true) if the guard condition is met, 1 (false) if not. Use for conditional logic rather than enforcement.

```bash
if _guard_met deployment-active; then
    echo "Deployment found — including endpoint metrics"
else
    echo "No deployment — registering model artifact only"
fi
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General error |
| `2` | Usage / argument error |
| `3` | **Contract violation** — guard not met or target not supported |

Exit code 3 is reserved for contract violations. CI systems and the advisory agent use it to distinguish "script failed" from "script couldn't start because preconditions weren't met."

---

## Contract consistency rules

The `agent-knowledge` MCP server validates contracts when indexing your project. It flags these inconsistencies:

| Issue | Warning |
|---|---|
| `type: model-centric` with `guard: deployment-active` | Unusual — model-centric scripts don't typically need deployments |
| `type: deployment-centric` with `guard: none` | Unusual — deployment-centric scripts typically need a deployment check |
| `targets` list includes a target the script hard-exits on | Inconsistent — annotation says it supports a target but runtime rejects it |
| Missing any required field | Required field absent — contract incomplete |

Warnings don't prevent the script from running. They surface in `agent-knowledge query_knowledge topic:script_reference` output.

---

## Current script registry

The authoritative classification of all 23 `do/` scripts:

| Script | Type | Guard | Lifecycle | Targets |
|---|---|---|---|---|
| `do/build` | model-centric | none | build | all |
| `do/push` | model-centric | none | publish | all |
| `do/run` | model-centric | none | local-test | all |
| `do/validate` | model-centric | none | pre-deploy | all |
| `do/stage` | model-centric | none | publish | all |
| `do/manifest` | model-centric | none | metadata | all |
| `do/export` | model-centric | none | metadata | all |
| `do/submit` | model-centric | none | build | all |
| `do/train` | model-centric | training-infra | training | all |
| `do/tune` | model-centric | training-infra | training | all |
| `do/config` | model-centric | none | configuration | all |
| `do/ci` | model-centric | none | ci | realtime-inference |
| `do/deploy` | deployment-centric | none | deploy | all |
| `do/test` | deployment-centric | deployment-active | monitor | all |
| `do/logs` | deployment-centric | deployment-active | monitor | all |
| `do/status` | deployment-centric | deployment-active | monitor | all |
| `do/clean` | deployment-centric | deployment-active | teardown | all |
| `do/benchmark` | deployment-centric | deployment-active | post-deploy | all |
| `do/optimize` | deployment-centric | deployment-active | post-deploy | realtime-inference, hyperpod-eks |
| `do/adapter` | deployment-centric | deployment-active | post-deploy | realtime-inference, hyperpod-eks |
| `do/add-ic` | deployment-centric | deployment-active | post-deploy | realtime-inference |
| `do/evaluate` | deployment-centric | deployment-active | post-deploy | all |
| `do/register` | hybrid | none | publish | all |

> **Note on `do/deploy`**: Despite being `deployment-centric` in scope, its `guard` is `none` because it *creates* the deployment — it can't check for something it's about to create. The guard is `none` for this reason only.

---

## Adding to `ADDING_FEATURES.md`

When documenting a new `do/` script in `ADDING_FEATURES.md`, reference this contract in your entry:

```markdown
### Adding do/myscript

1. Create `templates/do/myscript` using the standard header template.
2. Fill in the `@mlcc-script` contract — see [do-script-contract.md](do-script-contract.md) for field definitions.
3. Add `myscript` to the `scripts` section of `templates/do/README.md`.
4. Add contract tests in `test/unit/do-script-contracts.test.js`.
```
