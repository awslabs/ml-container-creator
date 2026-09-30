<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-009: Serve-engine capability versioning (BL129)

## Status

Accepted — implemented.

## Context

Serve-engine capabilities are declared as data in
`templates/code/serve.d/<engine>/manifest.json` (ADR-004): `supported_algorithms`,
`algorithm_map`, `env_var_prefix`, `dimension_map`, `metrics_endpoint`. Consumers
(`do/draft`, `do/deploy.d/hyperpod-eks`, `.optimize_engine.py`) read those fields
rather than hardcoding per-engine knowledge.

But those fields describe **one** version of the engine — the latest one MLCC
targets. In reality an engine's capabilities change by version: vLLM gained MTP
speculative decoding at 0.8.0 and DSpark later; a user deploying an older base
image cannot use an algorithm the manifest advertises. Before this change that
knowledge lived only as **prose** in the wrappers (`vllm.ejs` comments about
"vLLM v0.21+"), invisible to the validators. So `do/draft` would accept an
algorithm the deployed engine version doesn't actually support, and the failure
surfaced only at runtime on the cluster.

Meanwhile the base-image catalog (`servers/lib/catalogs/model-servers.json`)
already recorded `labels.framework_version` per image — the exact engine version
a deployment runs — but **no code read it**. The version knowledge and the
capability knowledge existed in the repo but were never connected.

## Decision

Make the serve manifest the single source of truth for **version-gated**
capabilities, engine-agnostically, and close the loop from the base image through
to the speculative-decoding consumers.

### 1. Two optional, engine-agnostic manifest fields

- `min_version` (semver): the lowest engine version MLCC gates against.
- `version_features`: `[{ since: <semver>, adds: { supported_algorithms: [...] } }]`
  — each entry's `adds` applies only when the detected engine version ≥ `since`.

Both are optional and available to **every** engine. An engine with no
version-specific behavior omits them; its effective capability set then equals
its flat set at every version. The flat `supported_algorithms` remains the
latest/default view (backward compatible); `version_features` records *when* each
of those entries became available. Each `adds.supported_algorithms` value must be
a subset of the flat list.

### 2. The effective capability set

Consumers resolve an *effective* `supported_algorithms` for a detected version =
the flat list minus any algorithm whose gating `since` is above that version.
Implemented once per runtime and mirrored:

- `serve_manifest.py` (Python, deploy/config-time): `effective_supported_algorithms`,
  `min_version`, `is_version_supported`, plus one-shot CLI ops for bash callers.
- `src/lib/serve-manifest-reader.js` (Node, generation-time): identical semantics.

### 3. Version source = the base image (static), not a runtime probe

`engine_version_from_base_image(engine, base_image)` resolves the version from
`do/config`'s `BASE_IMAGE`:
1. `model-servers.json` `labels.framework_version` for the matching image/tag; else
2. the version parsed from the image tag (custom/override images); else
3. `null`.

This is the base-image catalog's first consumer. A static, generation-time source
was chosen over a runtime probe (`vllm --version`) because the version is already
known at configure/deploy time and a probe would only work against a running
container.

### 4. Consumers (the loop)

- `do/draft` validates `--algorithm` against the effective set for the version
  resolved from `BASE_IMAGE`; a gated-out algorithm is rejected with an
  upgrade-the-base-image hint.
- `do/deploy.d/hyperpod-eks` re-checks `HP_SPECULATIVE_ALGORITHM` against the
  effective set for the deployed image before the `algorithm_map` translation
  (defense-in-depth: the base image may have changed since `do/draft` ran).

### 5. Fail-open

An unresolvable version (custom image, unparseable tag, `latest`) yields the full
flat set — version gating is an enhancement, never a new gate. MLCC never blocks
a user over a version it cannot read. `min_version` is surfaced for messaging;
it does not itself remove algorithms from the effective set.

## Consequences

- **Positive:** engine version becomes first-class, single-sourced data; the
  base-image catalog's `framework_version` finally has a consumer; `do/draft`
  rejects unsupported algorithms at configure time with an actionable message
  instead of failing on the cluster. Adding "algorithm X lands in engine vN" is a
  one-line manifest edit that every consumer picks up — no code change, no
  `if engine == …`.
- **Cost:** two readers (Python + Node) must stay in sync; a cross-runtime parity
  test guards this. The base image → version bridge crosses a module boundary
  (`serve_manifest.py` reading the base-image catalog), mitigated by keeping it
  behind one resolver with a tag-parse fallback and fail-open on any miss.
- **Scope held to `supported_algorithms`:** only speculative-decoding algorithms
  are version-gated in v1. The `adds` object is shaped to admit more gated fields
  later (e.g. env-var handling) without a schema break.
- **Risk:** low. Fields are optional and additive; the four shipped manifests
  stay schema-valid; only vLLM opts in. Behavior is preserved for every engine
  that declares no `version_features`, and unresolvable versions fail open to the
  prior behavior.

## References

- `docs/architecture/serve-engine-plugin-authoring.md` §b — the how-to (now IMPLEMENTED)
- `templates/code/serve.d/manifest.schema.json` — the `min_version` / `version_features` schema
- `templates/do/lib/python/serve_manifest.py`, `src/lib/serve-manifest-reader.js` — the readers
- ADR-004 — serve-engine plugin parity (the manifest-as-source-of-truth principle this extends)
