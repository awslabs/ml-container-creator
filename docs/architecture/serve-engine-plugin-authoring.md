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
> **Not the same as predictors.** This guide is for LLM/transformer *serve
> engines* (vLLM, SGLang, llama.cpp, …), whose base image contains the server and
> whose contract reduces to pure manifest data. The HTTP *predictor* frameworks
> (sklearn/xgboost/tensorflow) are a different, hybrid plugin — a data descriptor
> plus a handler.py of imperative code — documented in
> [Predictor-Framework Plugins](predictor-framework-plugins.md). Don't conflate the
> two.
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
  `code/serve`. For a *translating* engine it sources its env-var prefix from the
  manifest
  (`PREFIX="<%= (typeof envVarPrefix !== 'undefined' && envVarPrefix) ? envVarPrefix : 'ENGINE_' %>"`)
  and execs the server. For a *container-owns-entrypoint* engine (lmi, djl,
  llama-cpp) it instead validates inputs and hands off to the base image's own
  entrypoint — no env→flag translation, no `exec` (see §d step 4).

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

2. **Declare it in every engine's `manifest.json`.** If `required`, EVERY engine
   with a `serve.d/<engine>/manifest.json` must gain the field, or the validator
   and the parity test fail. Do not hand-count the engines — the set is whatever
   `serve.d/` currently holds (today vllm, sglang, tensorrt-llm, lmi, vllm-omni;
   the parity test discovers them dynamically). For a capability an engine lacks,
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

3. **A feature unique to one engine (or implemented differently): declare it in
   `engine_features`.** [IMPLEMENTED] When a capability exists on *one* engine
   and the others simply don't have it — or have it in a shape with no shared
   analog — it goes in the manifest's optional `engine_features` map. This is the
   general home for "this engine can do X and vLLM cannot." Each entry is the
   feature declared as DATA — its controlling env var, type, allowed values, and
   default — so a consumer reads it generically (`engineFeature(engine, name)` /
   `serve_manifest.py engine_features <engine>`) and NEVER branches on the engine
   name. An engine without the feature simply does not list it; the reader
   returns `{}` / `null`, which *is* the deviation.

   Two shipped worked examples (the deviations themselves):

   ```jsonc
   // serve.d/sglang/manifest.json — a boolean toggle vLLM has no analog for
   "engine_features": {
     "radix_attention": {
       "env_var": "SGLANG_ENABLE_RADIX_CACHE",   // the real SGLang toggle
       "type": "boolean", "default": "false",
       "description": "RadixAttention: automatic KV-cache reuse across requests
         sharing a prefix. vLLM has block-level prefix caching, not this."
     }
   }
   ```
   ```jsonc
   // serve.d/lmi/manifest.json — an enum knob only a meta-engine has
   "engine_features": {
     "rolling_batch_backend": {
       "env_var": "OPTION_ROLLING_BATCH",
       "type": "enum", "values": ["auto", "vllm", "tensorrt-llm", "lmi-dist"],
       "default": "auto",
       "description": "LMI delegates serving to a chosen backend. vLLM/SGLang ARE
         a single engine and expose no equivalent 'choose your backend' knob."
     }
   }
   ```

   vLLM, TensorRT-LLM, and vLLM-Omni declare NO `engine_features` — which is how a
   reader (or a reader of the docs) sees that RadixAttention and the pluggable
   backend are genuinely engine-specific, not shared capabilities. The schema
   (`manifest.schema.json`) enforces each entry's shape (`env_var` uppercase,
   `type` ∈ {boolean, enum, int, string}, `values` for enums, a `description`);
   the BL105 tests assert the shapes and the shipped deviations, and the drift
   tests assert cross-engine invariants (an enum's `default` is one of its
   `values`; a feature's `env_var` starts with the engine's `env_var_prefix`).

   **To add your own:** declare the feature in `engine_features` (one entry, real
   env var), run `npm run validate:serve-manifests`, and add a data-driven test
   that reads it back via the generic reader and asserts the engines *without* it
   return `{}`/`null`.

   **You get the user-facing wiring for free.** Because the generator resolves
   `engine_features` generically, a newly-declared feature is *immediately*
   available end-to-end with no extra code: the `--engine-feature NAME=VALUE`
   CLI flag accepts it (validated against your declaration — unknown name / bad
   enum / non-boolean are rejected), the interactive flow prompts for it with a
   widget derived from its `type` (boolean→confirm, enum→pick-list of `values`),
   and `resolveEngineFeatureVars()` emits `env_var=value` into `orderedEnvVars` →
   `do/config`. The seam is `src/app.js` (resolve/emit) and
   `src/lib/prompts/model-prompts.js` (`buildEngineFeaturePrompts`); both read the
   manifest, so you add nothing there. (This is the config-only "Option A" wiring;
   if a future feature must become a parsed CLI *flag* on the server binary rather
   than an env var, that is a separate, deliberate extension — see the note below.)
   If some *other* consumer needs to ACT on the feature, read it from
   `engine_features` there too — never add an `if engine == ...`.

**Anti-pattern:** a consumer (do-script, resolver, `app.js`) branching on the
engine name to decide behavior. That knowledge belongs in the manifest as data
(a shared field's value, or an `engine_features` entry); the consumer should be
engine-agnostic and read the data.

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

   **Two wrapper patterns — pick the one that matches your container.** Before
   writing the `.ejs`, decide which kind of engine you have:
   - **Translating wrapper (vllm, sglang, tensorrt-llm).** The base image is a
     bare server. Your `.ejs` reads the engine's prefixed env vars, converts them
     to `--flags` (the `--help`-introspection whitelist loop), and ends with
     `exec <server> "${SERVER_ARGS[@]}"`. The generated Dockerfile sets
     `ENTRYPOINT [ "/usr/bin/serve" ]` so your wrapper is PID 1.
   - **Container-owns-entrypoint (lmi, djl, llama-cpp).** The base image (e.g. an
     AWS DLC) already owns its entrypoint and maps its own env vars to args
     internally. Your `.ejs` must NOT translate env→flags and must NOT `exec` a
     server — that would double-map and fight the DLC. It takes an **early
     dispatch branch** (like `lmi`/`djl`), validates inputs, logs the effective
     config, and `exit 0`s to hand off; the generated Dockerfile for these engines
     **does NOT emit an `ENTRYPOINT`** (see §e step 5), so the base image's own
     entrypoint runs. The engine's `env_var_prefix` is whatever the container
     literally reads (e.g. llama.cpp's AWS DLC reads `SM_LLAMA_CPP_*`), so a
     `--server-env` value passes through verbatim with no stripping.
   Getting this wrong is a silent runtime failure, not a generation error — a
   translating wrapper on a DLC double-maps; a hand-off wrapper on a bare server
   never starts the server.

5. **Base images / instance sizing.** If the engine needs specific base images,
   add them to `servers/lib/catalogs/model-servers.json` (the base-image-picker
   catalog); the picker routes by `modelServer` generically.

6. **Deploy-time prefix map (`templates/do/register`).** `get_engine_prefix()` is
   a **hand-maintained shell `case`** that duplicates each engine's
   `env_var_prefix` so the generated `do/register` can capture the engine's env
   vars into the deployment-parameter record. It is NOT derived from the manifest
   (it runs in the generated project, which only ships the manifest, not the Node
   reader), so a new engine MUST be added here too — add a
   `<engine>) echo "<PREFIX>_" ;;` arm matching the manifest `env_var_prefix`.
   Miss it and the `*)` arm returns `""`: `do/register` silently records no
   parameters for the engine (the ADR-006/007/008 drift class).

7. **Generation-time validation allow-list (`src/lib/template-manager.js`).**
   `validate()` keeps its OWN hardcoded `supportedOptions.deploymentConfigs`
   array (and a fallback `backends` list for the architecture+backend path). A new
   engine MUST be added to both, or generation throws
   `⚠️  transformers-<engine> not implemented yet for deploymentConfig` — even
   though the manifest, enum, and resolver are all correct. This surface is NOT
   caught by `validate-serve-manifests` or the bl105 parity test; it surfaces only
   at an actual generate (which is why step 8 runs one). The registration drift
   test now also asserts `TemplateManager.validate()` accepts every `serve.d`
   engine, so a forgotten entry fails loudly.

8. **Register + validate.** `scripts/validate-serve-manifests.js` and the
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
   - **Declare the engine's REAL capabilities — do not under-declare (§g.4).**
     "Declare absence explicitly" (ADR-004) means an *honest* `false`/`[]`/`{}`
     for what the engine genuinely lacks — NOT a lazy all-empty stub for an
     engine that actually has config dimensions or a metrics endpoint. If the
     engine has benchmark-tunable knobs (tensor-parallel degree, dtype, batch
     size), declare them in `dimension_map`; an empty `dimension_map` means
     `serveEngineRuntimeVarsUnion` contributes nothing for it and `mcc
     regenerate` will not preserve those vars.
   - **Check the `env_var_prefix` against the schema pattern BEFORE writing it
     (§g.1).** The pattern is `^[A-Z][A-Z0-9_]*_$`: leading uppercase letter,
     trailing underscore, interior underscores allowed for compound names
     (`VLLM_OMNI_`). A prefix that fails the pattern (lowercase, no trailing
     underscore) fails `validate-serve-manifests`. Use the engine's REAL prefix
     — the one its container actually reads — never a prettier invented one.
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
   non-default branch (most translating engines fall through the default `else`;
   a container-owns-entrypoint engine needs an early branch like `lmi`/`djl` —
   see §d step 4). For a **container-owns-entrypoint** engine, also add a branch
   in `templates/Dockerfile` that sets the engine's `ENV` but emits **NO**
   `ENTRYPOINT` (so the base image's own entrypoint runs), mirroring the
   `lmi`/`djl`/`llama-cpp` arms. A translating engine keeps the default
   `ENTRYPOINT [ "/usr/bin/serve" ]`.
6. **Add base images** to `servers/lib/catalogs/model-servers.json` if needed,
   and add a default `ARG BASE_IMAGE` arm for `foo` in `templates/Dockerfile`.
7. **Finish the registration surfaces (§d steps 1, 2, 6, 7).** Beyond the enum
   (step 4): `CANONICAL_CONFIGS` in `deployment-config-resolver.js`, the
   `get_engine_prefix()` shell map in `templates/do/register`, and the
   `TemplateManager.validate()` allow-list in `src/lib/template-manager.js`. The
   registration drift test checks all of these; the end-to-end generate (below)
   is the backstop.
8. **Verify:**
   - `npm run validate:serve-manifests` → every engine (now including `foo`) valid.
   - `npx mocha test/unit/bl105-serve-manifest.test.js` → the parity test must
     actually **cover** `foo`, not merely tolerate it. The parity/T4 loops are
     **data-driven** (they iterate `ALL_ENGINES` discovered from `serve.d/`), so
     a new engine is asserted automatically. If you find a test that *discovers*
     engines dynamically but then only *asserts* a hardcoded subset, fix it to
     iterate the discovered set — otherwise your plugin is silently uncovered
     (§g.3).
   - `npx mocha test/unit/serve-engine-registration-drift.test.js` → the
     registration drift guard. It discovers every engine under `serve.d/` and
     asserts each is registered in the hand-maintained surfaces it can check
     statically: the `deploymentConfig` enum, `CANONICAL_CONFIGS`, the
     `get_engine_prefix()` shell map in `templates/do/register` (prefix must equal
     the manifest `env_var_prefix`), and the `TemplateManager.validate()`
     allow-list. A new engine missing from any one fails here with the exact
     surface and the line to add — this is what makes steps 6 and 7 safe to not
     forget.
   - `npm run lint` and — **required, not optional** — an end-to-end generation
     smoke test:
     `node bin/cli.js <name> --project-dir /tmp/<name> --deployment-config=transformers-foo --model-name=... --deployment-target=realtime-inference --instance-type=... --build-target=codebuild --region=us-east-1 --skip-prompts`.
     Only a real generate exercises every seam; the `TemplateManager` allow-list
     (step 7) was discovered this way, because no unit test or validator covered
     it. Inspect the generated `Dockerfile` (`FROM`, `ENTRYPOINT`, engine `ENV`)
     and `code/serve` before trusting the plugin.
9. **Document** the engine in
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
- `npm run codegen` rewrites a `Generated: <timestamp>` comment into
  `src/lib/generated/*` on every run, so `git status` shows those files as
  modified even when the real content is unchanged. When you changed ONLY things
  that do not feed codegen, the diff is pure timestamp churn and trusting the
  `codegen-target-guard: no change` / `codegen-deploy-flags: no change` lines is
  enough. **But do NOT reflexively `git checkout -- src/lib/generated/`**: if you
  added a new CLI option / enum value to `parameter-schema-v2.json` (which adding
  a `transformers-<engine>` config does), the regenerated `cli-options.js` carries
  that change, and discarding it silently reverts your new flag — the generator
  then rejects it as an unknown option, a break only an end-to-end generation test
  catches. After a schema change, KEEP the regenerated files; only discard when
  the schema was untouched and the diff is solely the timestamp line.
- The serve-engine `env_var_prefix` is a **load-bearing contract** read by
  `engine-prefix-resolver.js`, `serveEngineRuntimeVarsUnion`, and several tests.
  Do NOT "correct" an existing engine's prefix as a drive-by — changing it is a
  cross-cutting change with its own blast radius (§g.1). Flag the inconsistency
  and decide it deliberately.

---

## f. SGLang — a worked reference plugin [IMPLEMENTED]

> **Read this if you are building a new plugin and want a complete, shipping
> example to copy.** SGLang exercises every seam above: manifest parity, a
> real *version-gated* capability, engine-specific data (uppercase enums),
> the MCP catalog, and the version-drift guard. Everything below points at code
> that ships today — clone the shape, don't reinvent it.

### f.1 What SGLang declares (the manifest)

`templates/code/serve.d/sglang/manifest.json` is at full parity with vLLM and
adds version gating:

```jsonc
{
  "engine": "sglang",
  "env_var_prefix": "SGLANG_",
  "speculative_decoding": true,
  "supported_algorithms": ["eagle3", "eagle2", "eagle", "draft-model", "mtp"],
  "algorithm_map": {                    // engine-specific DATA in a shared field (see §c.1)
    "eagle3": "EAGLE3", "eagle2": "EAGLE", "eagle": "EAGLE",
    "draft-model": "STANDALONE", "mtp": "MTP"    // SGLang's enums are UPPERCASE (vLLM's are lowercase)
  },
  "hot_reload": true,
  "metrics_endpoint": { "path": "/metrics", "port": 8080, "format": "prometheus" },
  "dimension_map": {                    // benchmark dimension → SGLang's own key names
    "quantization": "QUANTIZATION", "tensor_parallel_degree": "TP_SIZE",
    "max_model_len": "CONTEXT_LENGTH", "kv_cache_dtype": "KV_CACHE_DTYPE"
  },
  "min_version": "0.4.0",               // BL129 gating (see §b)
  "version_features": [
    { "since": "0.4.0", "adds": { "supported_algorithms": ["mtp"] } }   // MTP/NEXTN gated to >= 0.4.0
  ]
}
```

Two things make this a *reference*, not just a config:
- **`algorithm_map` proves the "shared field, engine-specific value" rule** (§c.1):
  the same MLCC name (`draft-model`) maps to SGLang's `STANDALONE` while vLLM
  maps it to `draft_model`. No consumer branches on the engine — they read the map.
- **`version_features` gates a real capability** (§b): `mtp` (SGLang's NEXTN
  speculative decoding) is only offered when the deployed image is `>= 0.4.0`.
  The catalog currently ships `0.5.17`–`0.5.19`, all above the gate, so every
  shipped image gets the full set; an older custom image correctly loses `mtp`.

### f.2 The full loop, for SGLang specifically

Nothing in the loop is SGLang-specific code — SGLang rides the engine-agnostic
machinery from §b and §d:

1. **CLI/UI in:** the user selects `--deployment-config=transformers-sglang`
   (enum in `config/parameter-schema-v2.json`);
   `deployment-config-resolver.js` decomposes it to `{ backend: 'sglang' }`.
2. **Version resolved from the base image:**
   `serve_manifest.py engine_version sglang <BASE_IMAGE>` →
   e.g. `lmsysorg/sglang:v0.5.19` resolves to `0.5.19` (catalog
   `labels.framework_version`, else tag parse, else `null` = fail-open).
3. **`do/draft` validates** `--algorithm` against
   `effective_supported_algorithms(sglang, <version>)`; a gated-out `mtp` on an
   old image is rejected with an "upgrade the base image" hint.
4. **`do/deploy.d/hyperpod-eks` re-checks** `HP_SPECULATIVE_ALGORITHM` against
   the effective set (defense-in-depth), then translates via `algorithm_map`
   (`mtp` → `MTP`) into `SGLANG_SPECULATIVE_ALGORITHM`.

If you build a plugin and this loop doesn't work end-to-end, one of the seams in
§d is unwired — check the enum, the resolver split, and the serve dispatch first.

### f.3 Updating the MCPs and QoL scripts (do NOT skip this)

A plugin isn't "done" when the manifest validates — the version-gating loop is
only as good as the catalog it reads. Two MCP/QoL touch-points:

- **`sync-serving-versions.js` (QoL — MANUAL, not CI).** This script discovers
  the latest image tags per engine and updates
  `servers/lib/catalogs/model-servers.json` (`labels.framework_version`, pruning
  to the newest three). It is **not run in CI** — it makes live DockerHub/NGC
  calls, so a maintainer runs it on demand (`ml-container-creator bootstrap
  sync-serving-versions`, or `node scripts/sync-serving-versions.js`), reviews the
  diff, and commits the catalog change. New engine versions do **not** appear on
  merge; they appear when a human runs the sync.
  - **Required change for a NEW engine:** add a `SERVER_SOURCES` entry
    (`<engine>: { registry, namespace, repository, imagePrefix }`) — without it,
    the sync never discovers your engine's versions. The map already lists
    `vllm`/`sglang` → DockerHub and `tensorrt-llm` → NGC; copy the nearest.
  - **Known gap:** the script updates the *catalog* but does **not** touch serve.d
    manifests. So when a new engine version introduces a gated capability, *you*
    edit the manifest's `version_features` by hand — the sync will not do it.

- **`validate-servers.js` (CI gate for the catalog).** This is the CI step
  ("Validate MCP servers") that validates the MCP picker servers and their
  catalogs — including `model-servers.json` — against
  `servers/lib/schemas/*.schema.json`. It is distinct from
  `validate-serve-manifests.js` (which gates the serve.d plugin manifests,
  including `engine_features`). Both run on every PR. So a malformed catalog
  entry you add for a new engine fails here, and a malformed manifest fails
  there — you do not need to wire either into CI, but you DO need your additions
  to pass both.

- **The version-drift guard** (`test/unit/serve-manifest-catalog-version-drift.test.js`).
  Because that gap is manual, a conformance test makes drift **loud**: every
  manifest `min_version` / `version_features[].since` must be valid semver **and
  must not exceed the newest catalog `framework_version`** for that engine (a gate
  no shipped image can reach is dead config). When you add a gated capability,
  set its `since` at or below a shipped version — or bump the catalog first
  (run `sync-serving-versions.js`), then add the gate. The test fails with the
  exact engine, gate, and newest-shipped version when they drift apart.

- **The engine-feature env-var drift guard**
  (`test/unit/engine-features-catalog-envvar-drift.test.js`). An
  `engine_features[].env_var` is spelled in two human-updated places — the serve
  manifest and the catalog's `defaults`/`profiles` example configs (refreshed by
  the manual sync above). This conformance test makes a rename on one side loud:
  where both files reference the same feature, the env var must match verbatim,
  and a near-miss (e.g. `OPTION_ROLLING_BATCH` vs a typo'd `OPTION_ROLLING_BACKEND`
  while the catalog keeps the real one) is flagged as drift, not accepted. When
  you add a feature whose env var also appears in a catalog profile, keep the two
  identical; a feature with no catalog example is fine and never fails here.

- **`base-image-picker` (MCP).** The picker surfaces the engine version as a
  first-class output: `get_base_images` returns `baseImageVersion` in both
  `values` and `choices`, index-aligned with `baseImage` (sourced from each
  entry's `labels.framework_version`). A consumer that needs the version for the
  BL129 loop can read it straight from the picker instead of digging into
  `metadata.baseImage[i].labels`. If you add an engine to the picker's dynamic
  `--discover` endpoints, its dynamic entries have empty `labels`, so
  `baseImageVersion` is `null` for them until the static catalog carries the
  version — that is expected, not a bug.

### f.4 Tests that prove it (copy these shapes)

- `test/unit/bl107-sglang-plugin.test.js` — the plugin's own suite. Its BL129
  block is **data-driven**: it reads the gate boundary out of the manifest,
  checks that the gated algorithm is removed just below the gate and present at
  it, that a `null` version fails open to the full set, and that the newest
  *catalog* image reaches every capability — no frozen version literals, so a
  legitimate version bump doesn't break it.
- `test/unit/serve-manifest-catalog-version-drift.test.js` — the version-drift
  guard above (manifest gates ≤ newest catalog version).
- `test/unit/engine-features-catalog-envvar-drift.test.js` — the engine-feature
  env-var drift guard above (manifest `engine_features` env vars ↔ catalog
  profile env vars agree where they overlap).
- `test/unit/bl105-serve-manifest.test.js` + `test/unit/test_bl105_serve_manifest.py`
  — the `engine_features` describe blocks: schema accept/reject shapes, the
  shipped SGLang/LMI deviations, and that vLLM declares none (data-driven).
- `test/unit/engine-feature-generation.test.js` — the `--engine-feature`
  end-to-end: resolve → validate → emit into `do/config`, plus the engine-gated
  prompt widgets.
- `servers/base-image-picker/test.js` — asserts `baseImageVersion` is present
  and index-aligned, again derived from catalog metadata, not pinned strings.

The rule from the derive-don't-hardcode guidance: **assert the behavior
(reachability, alignment, gating), never a pinned version string** — catalogs
bump constantly and a pinned literal fails on every legitimate change.

---

## g. Lessons from building plugins (gotchas that bit us)

> These are concrete traps hit while actually adding plugins (SGLang, vLLM-Omni,
> and the LMI re-examination). Each one cost a debugging loop; read them before
> you start so they cost you none. They generalize the checklist above — when a
> lesson and the checklist disagree, the lesson is the hard-won refinement.

### g.1 The `env_var_prefix` pattern — and why you don't invent prefixes

The schema pattern is `^[A-Z][A-Z0-9_]*_$`: a leading uppercase letter, a
trailing underscore, and interior underscores allowed in between. It was
originally `^[A-Z][A-Z0-9]*_$` (no interior underscore) because every early
engine had a single-token prefix (`VLLM_`, `SGLANG_`, `LMI_`, `TRTLLM_`). The
**first compound-named engine** (vLLM-Omni, real prefix `VLLM_OMNI_`) did not
match and failed `validate-serve-manifests` — the pattern was widened to admit
it.

Two durable rules fall out of this:
- **Use the engine's REAL prefix**, the one its container actually reads at
  runtime — never a prettier invented one. vLLM-Omni's `templates/diffusors/serve`
  genuinely reads `VLLM_OMNI_*`; renaming it to a tidy `OMNI_` would have made
  the manifest lie about the engine.
- **The prefix is a load-bearing contract, not a label.** It is read by
  `engine-prefix-resolver.js` (and its `ENGINE_PREFIX_ALIASES` table for
  serve.d-less aliases like `djl`/`vllm-omni`), by `serveEngineRuntimeVarsUnion`
  (which composes `prefix + dimension_map` suffixes for `mcc regenerate`), and
  pinned in several prefix tests. If you discover an *existing* engine's declared
  prefix disagrees with what its container actually uses, that is a real finding
  — but **flag it and decide it deliberately**, don't flip it mid-plugin. (This
  is exactly the LMI `LMI_`-vs-`OPTION_` situation; see §g.5.)

### g.2 Not every engine is a transformers speculative engine

The `serve.d/` plugin system grew up around transformers LLM engines, so the
checklist's language (`transformers-<engine>`, speculative algorithms, the
`--help`-introspection loop) reads as if every engine is one. It is not:
- **Architecture matters.** An engine belongs to an *architecture*
  (`transformers`, `diffusors`, `triton`, `http`), and the
  deployment-config is `<architecture>-<engine>` — e.g. `diffusors-vllm-omni`,
  not `transformers-vllm-omni`. The resolver's `CANONICAL_CONFIGS` map is the
  source of truth for that pairing.
- **The runtime serve path can be separate.** `templates/code/serve` dispatches
  to `serve.d/<engine>/<engine>` ONLY for the transformers engines (plus the
  `lmi`/`djl` early-branch). The `diffusors` architecture renders a *different*
  serve script entirely (`templates/diffusors/serve`), selected by architecture
  in `app.js`. So for a non-transformers engine, the `serve.d/` plugin's job is
  to give the **manifest readers** (`serve_manifest.py`,
  `serve-manifest-reader.js`, consumed by benchmark/optimize/regenerate) honest
  capability data — the `.ejs` wrapper may not be on the live dispatch at all.
  Say so in the wrapper header and treat wiring the dispatch as a separate,
  explicit change (§d.4), not a silent side effect.
- **Non-speculative is a first-class answer.** A diffusion or classifier engine
  declares `speculative_decoding: false` with empty `supported_algorithms` /
  `algorithm_map` and simply omits `version_features`. That is complete, not a
  stub.

### g.3 Data-driven tests, or your plugin is silently uncovered

A test that **discovers** engines dynamically but then **asserts** against a
hardcoded list gives false confidence: the new engine is discovered, ignored,
and the suite stays green while covering nothing. The BL105 parity suite had
exactly this shape — it `readdirSync`'d `serve.d/` (with a comment "so a future
manifest-less engine fails") but every assertion looped a literal
`['vllm','sglang','lmi','tensorrt-llm']`. Adding vLLM-Omni passed trivially while
testing it not at all.

Fix the pattern, don't work around it: derive one `ALL_ENGINES` set from
`serve.d/` and iterate THAT in every per-engine assertion; derive subsets by
reading the manifests (e.g. "non-speculative engines" =
`ALL_ENGINES.filter(e => !loadManifest(e).speculative_decoding)`), never by
pinning names. Keep a single explicit "the known engines are all present" check
so a *missing* expected engine still fails loudly. This is the same
derive-don't-hardcode rule that bit the "ungated engine" tests when SGLang gained
`version_features`: a test that pins one engine as its example rots the moment
the catalog changes under it.

### g.4 Don't under-declare a real engine

"Declare absence explicitly" is about honesty, and honesty cuts both ways. An
all-empty manifest (`speculative_decoding:false`, `[]`, `{}`, no
`metrics_endpoint`, no `dimension_map`) is correct ONLY for an engine that truly
has none of those. For an engine that *does* have benchmark-tunable dimensions, a
bare manifest is an **under-declaration** — it validates, it passes parity, and
it quietly makes `serveEngineRuntimeVarsUnion` contribute nothing, so `mcc
regenerate` silently drops that engine's tunable vars. When you adopt or revisit
a plugin, check the base-image catalog for the engine's real `defaults.envVars` /
`profiles` and map the genuine config knobs into `dimension_map`. (This is the
LMI improvement in §g.5.)

### g.5 Worked re-examination: LMI was under-declared

LMI/DJL shipped a minimal parity stub (`LMI_` prefix, everything else empty) and
a wrapper that only reads `serving.properties`. Two findings came out of
revisiting it against the catalog:
- **It was under-declared.** The catalog's LMI entries set
  `OPTION_TENSOR_PARALLEL_DEGREE`, `OPTION_MAX_MODEL_LEN`, `OPTION_QUANTIZE`
  (confirmed in the DJL LMI vLLM-backend docs) — genuine benchmark-tunable knobs
  that belong in `dimension_map` (§g.4). Declaring them makes
  `serveEngineRuntimeVarsUnion` preserve LMI's tunable vars through `mcc
  regenerate`, same as vLLM/SGLang. (`kv_cache_dtype` is deliberately NOT mapped
  — DJL has no such option; mapping it would emit a key the container ignores.)
- **A prefix inconsistency surfaced, was flagged, and was then corrected
  deliberately.** The manifest/`engine-prefix-resolver` declared `LMI_`, but the
  real DJL container reads `OPTION_*` (and `template-variable-resolver.js`
  already maps `lmi → OPTION_TENSOR_PARALLEL_DEGREE`). This is a cross-cutting
  change — it touches `engine-prefix-resolver`, the `--server-env` prefixing it
  drives, and several pinned prefix tests (§g.1) — so it was raised as an
  explicit decision *before* changing it, not flipped as a drive-by. Once
  approved, the fix set `env_var_prefix: "OPTION_"`, populated `dimension_map`
  with the real option suffixes, and updated every pinned test to assert the
  correct `OPTION_` contract (rather than papering over them). The lesson: when a
  declared prefix disagrees with the runtime, the runtime wins — but the
  reconciliation is a deliberate, test-updating change, not a silent edit.

> **One capability intentionally left for a follow-up.** The same DJL docs show
> LMI *does* support speculative decoding through its vLLM backend
> (`OPTION_SPECULATIVE_CONFIG='{"method":"eagle3",…}'`, the same consolidated-JSON
> API as vLLM). Declaring that (`speculative_decoding: true` + algorithms +
> wrapper assembly + the hyperpod-eks `_spec_enum` path) is a larger, separate
> change than this prefix/`dimension_map` correction, so it was flagged rather
> than bundled in. Scoping discipline (§g.5) is itself a lesson: fix the thing you
> set out to fix; record the adjacent opportunity instead of absorbing it.

> **TensorRT-LLM — the scope line, honored then closed (BL125).** TRT-LLM's
> manifest once declared `speculative_decoding: false` as a SCOPE statement: the
> engine supports EAGLE3, MTP, draft/target, and NGram, but configures them
> through a structured `speculative_config` block (a YAML passed via
> `--extra_llm_api_options`), NOT the flat `TRTLLM_*` env→flag conversion the
> wrapper performs for ordinary args. The v1.8 pass refused to set
> `speculative_decoding: true` until the wrapper could actually emit that config
> — declaring algorithms ahead of the wiring would have been the mirror image of
> the LMI under-declaration above. BL125 did the wiring: the wrapper
> (`serve.d/tensorrt-llm/tensorrt-llm.ejs`) now assembles the `speculative_config`
> YAML from `TRTLLM_SPECULATIVE_*` and appends `--extra_llm_api_options`, so the
> manifest honestly declares `speculative_decoding: true` with
> `supported_algorithms`/`algorithm_map` (`eagle3→Eagle`, `draft-model→DraftTarget`,
> `ngram→NGram`, `mtp→MTP`). Note TRT-LLM is a SageMaker-endpoint engine: its
> speculative env vars arrive via `--server-env` injection, NOT the HyperPod CRD
> `_spec_enum` path (which stays vLLM/SGLang-scoped by product design). The rule,
> stated plainly and still true: `speculative_decoding` reflects what MLCC's
> wrapper can CONFIGURE, not what the upstream engine can merely do — set it
> `true` only once (and as soon as) the wiring exists.

---

## Where this leads

Items (a) through (f) are all supported by the system as it stands today —
including (b) version gating, shipped in BL129 (see
[ADR-009](../adr/ADR-009-serve-engine-capability-versioning.md)), and the SGLang
reference plugin (f). Section (g) collects the lessons from actually building
plugins — read it first. When the next engine's capabilities need to diverge by
version, follow §b and §f: declare the gate in the manifest, let the
engine-agnostic readers derive the effective set, and add the drift guard entry
in the same commit so the catalog↔manifest contract can't silently rot.
