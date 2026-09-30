<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Serve-Engine Plugin Authoring Guide

> **Audience.** Human or AI maintainers extending MLCC's serve-engine plugin
> system. This is the *how-to* companion to
> [serve-engine-plugins.md](serve-engine-plugins.md) (the *what/where*) and
> [ADR-004](../adr/ADR-004-serve-engine-plugin-parity.md) (the *why*).
>
> **Ground rule (ADR-004).** The `serve.d/<engine>/manifest.json` is the single
> source of truth for an engine's capabilities. Every new feature you add should
> be **declared in the manifest as data** and **consumed** by the wrapper /
> do-scripts — never hardcoded per-engine in code. If you find yourself writing
> `if engine == 'vllm'` in a consumer, that knowledge belongs in the manifest.
>
> **Status legend.** Sections marked **[IMPLEMENTED]** describe the system as it
> exists today. Sections marked **[PROPOSED]** describe a design not yet built;
> they are the recommended path and call out exactly what would need to change.

---

## 0. Anatomy of a plugin (recap)

A serve-engine plugin is a directory `templates/code/serve.d/<engine>/` with:

- **`manifest.json`** — capabilities as data (schema:
  `templates/code/serve.d/manifest.schema.json`). Required fields: `engine`,
  `env_var_prefix`, `speculative_decoding`, `supported_algorithms`,
  `algorithm_map`, `hot_reload`. Optional: `metrics_endpoint`, `dimension_map`.
- **`<engine>.ejs`** — the runtime wrapper rendered into the generated project's
  `code/serve`. It sources its env-var prefix from the manifest
  (`PREFIX="<%= (typeof envVarPrefix !== 'undefined' && envVarPrefix) ? envVarPrefix : 'ENGINE_' %>"`)
  and execs the server.

Readers of the manifest:
- Node, generation-time: `src/lib/serve-manifest-reader.js` (`readEnvVarPrefix`)
  → injected into the render context as `envVarPrefix` by `src/app.js`; and
  `src/lib/engine-prefix-resolver.js` (server-env prefixing).
- Python, deploy-time: `templates/do/lib/python/serve_manifest.py` (all fields +
  a CLI `serve_manifest.py <field> <engine>`), consumed by `do/draft`,
  `do/deploy.d/hyperpod-eks`, `.optimize_engine.py`, `do/benchmark`.

---

## a. Extending a plugin to offer new feature support [IMPLEMENTED pattern]

Adding a capability follows one repeatable loop: **declare it in the schema →
declare it in each engine's manifest → consume it from data**.

1. **Add the field to the manifest schema**
   (`templates/code/serve.d/manifest.schema.json`). Decide whether it is
   `required` (every engine must declare it — forces an explicit value, the
   ADR-004 preference) or optional (absence is meaningful, e.g. `metrics_endpoint`).
   Give it a `description` — the schema is documentation.

2. **Declare it in every engine's `manifest.json`.** If `required`, all four
   engines (`vllm`, `sglang`, `lmi`, `tensorrt-llm`) must gain the field, or the
   validator and the parity test fail. For a capability an engine lacks,
   **declare its absence explicitly** (e.g. `speculative_decoding: false` with
   empty `supported_algorithms`) rather than omitting the field — this is the
   core ADR-004 rule.

3. **Consume the field from data** in the wrapper and/or the do-scripts:
   - Node/render-time: add a reader in `src/lib/serve-manifest-reader.js` (mirror
     `readEnvVarPrefix`) and inject it into `templateVars` in `src/app.js`.
   - Python/deploy-time: add an accessor + a `_FIELD_PRINTERS` entry in
     `templates/do/lib/python/serve_manifest.py`, then read it from the do-script
     (bash: `python3 "${SCRIPT_DIR}/lib/python/serve_manifest.py" <field> "${MODEL_SERVER}"`).

4. **Add tests** that assert the consumer reads the field from the manifest
   (change the manifest value in a test and prove the output changes with no code
   edit) and that the schema rejects a malformed value.

**Worked example (already in the tree): `metrics_endpoint`.** Optional object
`{path, port, format}`; `serve_manifest.py metrics_endpoint <engine>` returns it
(or exit 5 when absent); `do/benchmark`'s phase-2 poller reads it and silently
skips polling when an engine declares none. That is the template to copy.

---

## b. Versioning capabilities within a plugin [IMPLEMENTED]

> **Shipped in BL129 (see [ADR-009](../adr/ADR-009-serve-engine-capability-versioning.md)).**
> The manifest carries two optional, engine-agnostic version fields; consumers
> resolve an *effective* capability set for the deployed engine version, which is
> derived from the base image. Fail-open throughout: a version MLCC cannot read
> never blocks a user.

**The fields: `min_version` + `version_features`.** Keep the flat top-level
fields (they describe the engine's *latest/default* behavior) and add version
gating as additive data. Both fields are optional — an engine with no
version-specific behavior omits them and its effective set equals its flat set at
every version. Example (the shipped vLLM manifest):

```jsonc
{
  "engine": "vllm",
  "env_var_prefix": "VLLM_",
  "speculative_decoding": true,
  "supported_algorithms": ["eagle3", "eagle2", "eagle", "draft-model", "ngram", "mtp", "dspark"],
  "algorithm_map": { "eagle3": "eagle3", "draft-model": "draft_model" },
  "hot_reload": true,

  "min_version": "0.6.0",              // lowest version MLCC gates against
  "version_features": [
    { "since": "0.8.0",  "adds": { "supported_algorithms": ["mtp"] } },     // mtp available from >= 0.8.0
    { "since": "0.10.2", "adds": { "supported_algorithms": ["dspark"] } }   // dspark from >= 0.10.2
  ]
}
```

Each `adds.supported_algorithms` value MUST be a subset of the flat
`supported_algorithms` (the flat list is the newest truth; `version_features`
records *when* each entry landed). The schema enforces the field shapes; the
subset invariant is asserted by the BL105/BL129 tests.

**The effective capability set.** For a detected engine version, the effective
`supported_algorithms` = the flat list minus any algorithm whose gating
`version_features[].since` is *above* that version. So at vLLM 0.8.5 the effective
set includes `mtp` but not `dspark`; at 0.10.2+ it includes both.

**Where the version comes from — the base image (not a runtime probe).** The
engine version is resolved statically from the deployment's `BASE_IMAGE` in
`do/config`:
1. the base-image catalog (`servers/lib/catalogs/model-servers.json`) records
   `labels.framework_version` per image entry — the authoritative image and
   version map (this is that field's first consumer); else
2. the version is parsed from the image tag (`vllm/vllm-openai:v0.29.0` becomes
   `0.29.0`) for custom/override images not in the catalog; else
3. `null` gives **fail-open** (no gating applied).

**Readers (both runtimes, single source of truth).**
- Python, deploy/config-time: `serve_manifest.py` —
  `effective_supported_algorithms(engine, version)`,
  `engine_version_from_base_image(engine, base_image)`, `min_version`,
  `is_version_supported`, plus one-shot CLI ops
  (`serve_manifest.py engine_version <engine> <base_image>`,
  `serve_manifest.py effective_supported_algorithms <engine> [version]`).
- Node, generation-time: `src/lib/serve-manifest-reader.js` mirrors the same
  functions with identical semantics.

**Consumers (the full loop).**
- `do/draft` resolves the engine version from `BASE_IMAGE` and validates
  `--algorithm` against the *effective* set. A gated-out algorithm is rejected
  with an "available on a newer version — upgrade base image" hint. The
  `--help` algorithm list shows the effective set for the active engine's version.
- `do/deploy.d/hyperpod-eks` re-checks the configured `HP_SPECULATIVE_ALGORITHM`
  against the effective set for the deployed image (defense-in-depth: the base
  image may have changed since `do/draft` ran) before the `algorithm_map`
  translation.

**Why this shape:**
- The flat fields stay valid as the "latest/default" view, so existing consumers
  keep working unchanged (backward compatible; the three engines that declare no
  `version_features` are unaffected).
- Gating is *additive data*, not code: adding "algorithm X lands in engine vN"
  edits the manifest, and every consumer that resolves the effective set picks it
  up — engine-agnostic, no `if engine == ...` anywhere.
- `min_version` gives a single, honest "we don't support below this" statement,
  replacing scattered prose in the wrappers.

**Fail-open is the rule.** An unresolvable version (custom image, unparseable
tag, `latest`) yields the full flat set — version gating is an enhancement, never
a new gate. MLCC never blocks a user over a version it cannot read.

**Do NOT** encode versions by forking the plugin directory (`vllm-0.8/`) or by
`if version >= ...` in the wrapper — both reintroduce the per-engine hardcoding
ADR-004 eliminates. **Do NOT** add a runtime `vllm --version` probe as the version
source; the base-image catalog is the static, generation-time source of truth.

---

## c. Adding plugin-specific features [IMPLEMENTED pattern]

Some capabilities are meaningful to only one engine (e.g. SGLang's
`--speculative-eagle-topk`, vLLM's consolidated `--speculative-config` JSON).
Two mechanisms keep these honest:

1. **Engine-specific *data* in a shared field.** `algorithm_map` already does
   this: the same MLCC name (`draft-model`) maps to `draft_model` for vLLM and
   `STANDALONE` for SGLang. The *field* is shared; the *value* is engine-specific
   data. Prefer this whenever a feature is "same concept, different name/shape."

2. **Engine-specific *strategy* in the wrapper, declared as intent.** When two
   engines genuinely implement a feature differently (vLLM builds one
   `--speculative-config` JSON blob; SGLang emits discrete `--speculative-*`
   flags), the *strategy* lives in that engine's `<engine>.ejs`. This is
   legitimate: the wrapper is the engine-specific layer. The rule is that the
   **inputs** to the strategy (prefix, which algorithms, mapped names) come from
   the manifest; only the **emission shape** is hardcoded in the wrapper.

If a feature is truly unique to one engine and has no cross-engine analog, it is
fine for only that engine's manifest to declare it (an optional schema field) and
only that engine's wrapper to consume it. Document it in the field's schema
`description`.

**Anti-pattern:** a consumer (do-script, resolver, `app.js`) branching on the
engine name to decide behavior. That knowledge belongs in the manifest as data;
the consumer should be engine-agnostic and read the data.

---

## d. Wiring a new plugin to app.js / the CLI / the generator [IMPLEMENTED]

A serve engine is exposed to users through the `deploymentConfig` value
`transformers-<engine>` (or a new architecture prefix). The full wiring path:

1. **Schema (source of truth for the CLI).** Add `transformers-<engine>` to the
   `deploymentConfig.validation.enum` in `config/parameter-schema-v2.json`. Run
   `npm run codegen` — this regenerates `src/lib/generated/cli-options.js` (so
   `--deployment-config` accepts it) and the parameter matrix. Never hand-edit
   the generated files.

2. **Deployment-config decomposition.** `src/lib/deployment-config-resolver.js`
   decomposes `transformers-<engine>` → `{ architecture: 'transformers',
   backend/engine: '<engine>' }`. Confirm the split yields your engine name as
   `modelServer`/`backend`. If your engine uses a novel pattern, extend the
   resolver's canonical map (it exists specifically to consolidate `split('-')`
   logic).

3. **Generator routing (`src/app.js writeProject`).** Architecture routing
   (the `switch (architecture)`), file include/exclude `ignorePatterns`, and
   `templateVars.envVarPrefix = readEnvVarPrefix(engine)` already handle any
   engine generically once the manifest exists — you usually change nothing here.
   If your engine needs unique files included/excluded, add a targeted
   `ignorePatterns` rule keyed off `answers`, not the engine literal where
   avoidable.

4. **Top-level serve dispatch (`templates/code/serve`).** This EJS template
   selects the wrapper: `<%- include('serve.d/' + modelServer + '/' + modelServer) %>`.
   Ensure your engine name matches the directory, and if it belongs to a
   non-default engine class (like the `lmi`/`djl` early-branch), add it to the
   relevant dispatch condition. **This is the one remaining place with
   engine-name literals** — keep it minimal.

5. **Base images / instance sizing.** If the engine needs specific base images,
   add them to `servers/lib/catalogs/model-servers.json` (the base-image-picker
   catalog); the picker routes by `modelServer` generically.

6. **Register + validate.** `scripts/validate-serve-manifests.js` and the
   parity test (`test/unit/bl105-serve-manifest.test.js`) will now gate the
   engine's manifest. `scripts/schema-template-coverage.js` checks schema↔template
   coverage. Run the full serve suite before committing.

---

## e. Writing a brand-new plugin — end-to-end checklist [IMPLEMENTED]

To add an engine `foo` served as `transformers-foo`:

1. **Create the plugin directory** `templates/code/serve.d/foo/`.
2. **Write `manifest.json`** conforming to the schema:
   ```json
   {
     "engine": "foo",
     "env_var_prefix": "FOO_",
     "speculative_decoding": false,
     "supported_algorithms": [],
     "algorithm_map": {},
     "hot_reload": false
   }
   ```
   Add `metrics_endpoint` / `dimension_map` only if the engine exposes them.
   Set `speculative_decoding: true` + populate `supported_algorithms` /
   `algorithm_map` only if it truly supports speculative decoding.
3. **Write `foo.ejs`** — source the prefix from the manifest (never hardcode a
   bare `PREFIX="FOO_"`):
   ```bash
   PREFIX="<%= (typeof envVarPrefix !== 'undefined' && envVarPrefix) ? envVarPrefix : 'FOO_' %>"
   ```
   Follow `sglang.ejs`/`vllm.ejs` for the env→CLI translation loop and the
   `--help`-introspection whitelist pattern.
4. **Add `transformers-foo`** to `deploymentConfig.validation.enum` in
   `config/parameter-schema-v2.json`; run `npm run codegen`.
5. **Wire the serve dispatch** in `templates/code/serve` if `foo` needs a
   non-default branch (most engines fall through the default `else`).
6. **Add base images** to `servers/lib/catalogs/model-servers.json` if needed.
7. **Verify:**
   - `node scripts/validate-serve-manifests.js` → 5/5 valid.
   - `npx mocha test/unit/bl105-serve-manifest.test.js` → parity test discovers
     `foo` and passes.
   - `npm run lint` and a generation smoke test for `--deployment-config=transformers-foo`.
8. **Document** the engine in
   [serve-engine-plugins.md](serve-engine-plugins.md) (the engine table + matrix).

### Gotchas
- The `<engine>.ejs` prefix MUST use the `<%= envVarPrefix || 'FOO_' %>` form so
  the rendered wrapper is byte-identical whether or not the render context
  supplies `envVarPrefix`.
- Never put the `*/` sequence inside a JS block-comment header when writing
  reader code — it closes the comment.
- `app.js` only copies a serve.d directory's `manifest.json` to the generated
  project's `.mlcc/serve.d/` — the `.ejs` wrapper is rendered, not copied. A
  manifest-less engine copies nothing and breaks deploy-time readers, which is
  why every engine must have a manifest (ADR-004 parity).

---

## Where this leads

Items (a), (c), (d), (e) are supported by the system as it stands today. Item
(b), versioning, is the next ADR to write when an engine's capabilities need to
diverge by version — the design above is the recommended starting point and is
deliberately additive so it does not disturb the four current manifests.
