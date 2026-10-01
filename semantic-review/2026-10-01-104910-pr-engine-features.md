# SGLang/LMI engine_features + `--engine-feature` wiring and the LMI `OPTION_` prefix flip

Adds an optional `engine_features` map to serve-plugin manifests (SGLang `radix_attention`, LMI `rolling_batch_backend`), a schema for it, Node/Python readers, and an end-to-end `--engine-feature NAME=VALUE` path that resolves a feature name to the engine's real env var, validates it against the manifest, and emits it into `orderedEnvVars` → `do/config`. It also flips LMI's `env_var_prefix` from `LMI_` to `OPTION_`, adds LMI's `dimension_map`, and documents the lessons. The resolve/validate core and the manifest contract are sound and well-tested; the gaps are in the *interactive* feed into that core and in two places where a declared-field promise isn't actually enforced.

Watch for: (1) the interactive prompt emits a feature env var even when the user accepts the default/declines it — `radix_attention` left at its default writes `SGLANG_ENABLE_RADIX_CACHE=false` into `do/config` (confirmed); (2) `orderedEnvVars` is appended with no cross-source de-dup, so the same var supplied via both `--engine-feature` and `--server-env` emits two conflicting `export` lines (confirmed); (3) the schema does not enforce `type:"enum" ⇒ values`, so an enum feature declared without `values` validates but is then impossible to set (confirmed).

**Verdict**: NEEDS_CHANGES

## High-level view

The resolve-and-validate core (`resolveEngineFeatureVars` in `serve-manifest-reader.js`) is the right shape: it reads `engine_features` as data, never branches on engine name, and rejects unknown features, bad booleans, out-of-set enums, and non-integers before anything is emitted. The CLI path through `app.js` is correct — it throws on any validation error rather than emitting partial config.

The interactive path is where correctness slips. Engine-feature prompts are plain `confirm`/`list`/`input` widgets gated only by engine selection, and the prompt-runner normalizer captures *every* `__engine_feature__*` answer unconditionally. So a boolean feature left at its `false` default, or an enum left at `auto`, still flows into `engineFeatureVars` and gets emitted — unlike `--server-env`, which only emits vars the user actually passed. The user ends up with feature env vars in `do/config` they never asked for.

Emission into `orderedEnvVars` is a bare `.push()` across three independent sources (model env, server env, engine features) with no key de-dup, and the template renders one `export` line per array entry. Supplying the same underlying var two ways produces duplicate exports; bash takes the last, which is the engine-feature push.

The manifest contract is mostly enforced by real drift tests (env_var starts with the engine prefix; enum default ∈ values; vLLM declares none), but two promises aren't backed: the schema says enum requires `values` yet doesn't enforce it, and the catalog↔manifest drift test's per-feature verbatim check is an `assert.ok(true)` no-op for exactly the shipped features it claims to protect.

The LMI `LMI_`→`OPTION_` prefix flip is a deliberate, documented contract correction with its pinned tests updated to match; no working deployment regresses because the old `LMI_*` never matched the DJL container. The pre-existing double-prefix footgun (passing an already-qualified `OPTION_*` key to `--server-env` yields `OPTION_OPTION_*`) is unchanged and out of scope, but the new feature path is now the correct way to set those vars.

<details>
<summary>Issues (5)</summary>

1. **Interactive emits unrequested feature vars** — a feature left at its default (boolean `false`, enum `auto`) is still normalized and emitted, writing e.g. `SGLANG_ENABLE_RADIX_CACHE=false` into `do/config`. Skip emitting a feature whose interactive answer equals its declared `default` (or only emit features the user actively changed), matching `--server-env` semantics. (confirmed)
2. **No cross-source de-dup in `orderedEnvVars`** — `--engine-feature` and `--server-env` resolving to the same env var produce two `export` lines (engine-feature wins by push order). De-dup by key when merging the three env-var sources in `app.js`, or at minimum detect and reject the collision. (confirmed)
3. **Schema doesn't enforce `enum ⇒ values`** — a feature with `"type":"enum"` and no `values` passes `manifest.schema.json`; `resolveEngineFeatureVars` then sets `allowed=[]` and rejects every value, making the feature unsettable. Add an `if/then` requiring `values` when `type` is `enum`. (confirmed)
4. **Drift test's per-feature check is vacuous for shipped features** — in `engine-features-catalog-envvar-drift.test.js`, Case 1 is `assert.ok(true)` whenever the catalog has the exact var, which is true for both shipped features, so the claimed "verbatim agreement" assertion tests nothing on the happy path (the rename heuristic in Case 2 is the only live guard). Assert the match explicitly instead of returning on the exact-key branch. (confirmed)
5. **`int` feature path has no coverage** — no shipped feature is `type:"int"`, and the generation test only exercises boolean/enum, so the integer validation branch is untested behavior. Add a synthetic int-feature case or note it as a known gap. (possible)

</details>

<details>
<summary>Details</summary>

### Resolve/validate core is correctly data-driven

`resolveEngineFeatureVars` (`src/lib/serve-manifest-reader.js`) reads the engine's `engine_features`, and for each requested `name` rejects unknown features, booleans not in `{true,false}`, enum values outside the declared `values`, and non-integers, pushing an error (not a pair) on each failure. `app.js` (`src/app.js:386-396`) throws if `errors.length > 0`, so a bad value aborts generation rather than leaking partial config. Enum values accept hyphens (`tensorrt-llm`), and the KV parser splits on the first `=`, so `rolling_batch_backend=tensorrt-llm` round-trips.

### Interactive path emits features the user never set

`buildEngineFeaturePrompts` (`src/lib/prompts/model-prompts.js`) creates a `confirm` for booleans (`default: decl.default === 'true'`), a `list` for enums (`default: decl.default`), and an `input` otherwise, each gated by a `when()` that fires only for the selected engine. These prompts are not in the parameter matrix, so in `--auto` mode `_runPhase` skips them (`!paramConfig → return false`) and nothing is emitted. But in standard interactive mode there is no such skip: the prompt runs and returns a value even when the user accepts the default.

The normalizer in `prompt-runner.js` then captures the answer unconditionally:

```js
for (const key of Object.keys(combinedAnswers)) {
    if (key.startsWith(ENGINE_FEATURE_ANSWER_PREFIX)) {
        const name = key.slice(ENGINE_FEATURE_ANSWER_PREFIX.length);
        if (!(name in engineFeatureVars)) {
            const v = combinedAnswers[key];
            engineFeatureVars[name] = typeof v === 'boolean' ? String(v) : String(v);
        }
        ...
    }
}
```

There is no "did the user actually change this?" check. So an interactive SGLang run where the user declines RadixAttention still produces `engineFeatureVars = { radix_attention: 'false' }`, which `app.js` resolves and emits as `export SGLANG_ENABLE_RADIX_CACHE=${SGLANG_ENABLE_RADIX_CACHE:-false}` in `do/config`. For the LMI enum, declining to change it emits `OPTION_ROLLING_BATCH=auto`. This diverges from `--server-env`, which only emits what the user passed, and from the feature's own intent — an engine the user didn't opt into now carries an explicit feature var, and the `${KEY:-value}` default bakes in `false`/`auto` even if the container's own default later changes. The CLI path doesn't have this problem because the user only passes features they want. The fix is to drop any interactive feature whose answer equals its declared `default` before normalization, or to track which prompts the user actively changed.

### `orderedEnvVars` has no cross-source de-dup

`app.js` builds `orderedEnvVars` from `_getOrderedEnvVars(envVars)` (which de-dups within its own object) and then `.push()`es model env vars, prefixed server env vars, and resolved engine-feature vars in sequence:

```
orderedEnvVars = _getOrderedEnvVars(answers.envVars)   // de-duped map
  ↓ push modelEnvVars
  ↓ push resolvePrefixedEnvVars(engine, serverEnvVars)
  ↓ push resolveEngineFeatureVars(engine, engineFeatureVars).resolved
```

Nothing checks for a key already present. The `do/config` template emits one `export <key>=${<key>:-<value>}` per array entry, so a var supplied via two mechanisms produces two export lines. The realistic trigger is the feature-vs-server-env overlap: `--engine-feature rolling_batch_backend=vllm` resolves to `OPTION_ROLLING_BATCH=vllm`, and `--server-env ROLLING_BATCH=auto` resolves to `OPTION_ROLLING_BATCH=auto`. Both land in the array; bash sourcing `do/config` takes the last, which is the engine-feature push — silent and order-dependent rather than a clear error. De-dup by key (last-wins with a warning, or reject the collision) when assembling the three sources.

### Schema promises `enum ⇒ values` but doesn't enforce it

`manifest.schema.json`'s `engine_features` entry marks `values` as optional with the description "Required when type is 'enum'", but there is no conditional schema enforcing that. Verified against the shipped 2020-12 schema: a feature `{ env_var:"X_FOO", type:"enum", description:"..." }` with no `values` validates `true`. Downstream, `resolveEngineFeatureVars` computes `const allowed = Array.isArray(decl.values) ? decl.values : []` and then `allowed.includes(value)` — with no `values`, every value is rejected, so the feature can never be set via CLI, and the interactive `list` prompt offers empty choices. An authoring mistake that the schema advertises it will catch slips through to a dead feature. Add:

```jsonc
"if":   { "properties": { "type": { "const": "enum" } } },
"then": { "required": ["values"] }
```

inside the per-feature `additionalProperties` object.

### Catalog↔manifest drift test is vacuous on its own happy path

`engine-features-catalog-envvar-drift.test.js` guards the right thing (the feature env var is spelled in both the manifest and the catalog profiles) and has solid non-vacuous guards: it asserts at least one feature is declared and at least one overlaps a catalog profile. But the per-feature assertion itself:

```js
if (catalogKeys.has(envVar)) {
    assert.ok(true);   // ← happy path for BOTH shipped features
    return;
}
// Case 2: stem heuristic only runs when the exact var is ABSENT
```

Both shipped features (`SGLANG_ENABLE_RADIX_CACHE`, `OPTION_ROLLING_BATCH`) are present verbatim in the catalog, so every per-feature test lands in the `assert.ok(true)` branch and asserts nothing. The comment claims "a regression that renamed only one side flips this from pass to fail," which is true only via the Case 2 stem heuristic (`ROLLING`/`RADIX`) when the exact key disappears — the verbatim-agreement claim in Case 1 is a no-op. The live protection is the rename heuristic, which does work for the shipped names; the Case 1 branch should assert the match explicitly rather than returning early, so the test's stated invariant actually holds.

### LMI `LMI_`→`OPTION_` flip is a deliberate, covered contract change

The prefix flip touches the load-bearing `env_var_prefix` read by `engine-prefix-resolver.js`, `serveEngineRuntimeVarsUnion`, and `--server-env` prefixing. It's handled correctly: no production consumer hardcodes `LMI_` anymore (only tests, which were updated to assert `OPTION_` and to assert `LMI_` must NOT reappear in the runtime-vars union), the resolver derives the prefix from the manifest, and the DJL container genuinely reads `OPTION_*`, so the old `LMI_*` emission never worked — no functioning deployment regresses. The accompanying `dimension_map` (`QUANTIZE`, `TENSOR_PARALLEL_DEGREE`, `MAX_MODEL_LEN`) now lets `serveEngineRuntimeVarsUnion` preserve LMI's tunable vars through `mcc regenerate`, matching vLLM/SGLang.

One pre-existing footgun is adjacent but out of scope: `resolvePrefix` blindly prepends the prefix, so a user passing an already-qualified `--server-env OPTION_ROLLING_BATCH=x` on LMI gets `OPTION_OPTION_ROLLING_BATCH`. This was equally broken before (`LMI_OPTION_...`), so the flip introduces no new regression — but the new `--engine-feature` path is now the correct way to set these, which is worth telling users.

### Test coverage: strong on the core, thin on the seams

The manifest contract is well guarded by data-driven tests over `ALL_ENGINES`: env_var starts with the engine prefix, enum default ∈ values, SGLang declares `radix_attention`, vLLM declares none, and the schema accept/reject shapes. The generation test exercises resolve → validate → emit for the two shipped features and asserts the SGLang export uses the `${KEY:-value}` pattern.

Not tested: the interactive default-emission behavior above (the generation test feeds `resolveEngineFeatureVars` output directly into `orderedEnvVars`, bypassing the prompt-runner normalizer and the `app.js` merge, so neither the unrequested-emission nor the double-emission path is covered); the `type:"int"` validation branch (no shipped int feature, and the generation test only covers boolean/enum); and the `app.js` error-throw path on an invalid CLI value.

</details>

<details>
<summary>File map</summary>

- `src/lib/serve-manifest-reader.js` — `engineFeatures`/`engineFeature`/`resolveEngineFeatureVars` readers + generic validation (core of the feature; sound).
- `src/app.js` — resolve + emit engine-feature vars into `orderedEnvVars`; throws on validation error. No cross-source de-dup (issue 2).
- `src/lib/prompts/model-prompts.js` — `buildEngineFeaturePrompts`, widget derived from `type`, engine-gated `when()`.
- `src/lib/prompt-runner.js` — runs the engine-feature phase and normalizes `__engine_feature__*` answers; emits defaults unconditionally (issue 1).
- `src/lib/config-loader.js` / `config-manager.js` — parse `--engine-feature` into `engineFeatureVars`, round-trip through config.
- `src/lib/engine-prefix-resolver.js` — alias-table comment updated for LMI→`OPTION_`; prefix still manifest-sourced.
- `templates/code/serve.d/{sglang,lmi}/manifest.json` — the two shipped `engine_features`; LMI prefix flip + `dimension_map`.
- `templates/code/serve.d/manifest.schema.json` — `engine_features` schema; missing `enum ⇒ values` enforcement (issue 3).
- `templates/do/lib/python/serve_manifest.py` — Python `engine_features`/`engine_feature` readers + field printer.
- `config/parameter-schema-v2.json`, `src/lib/generated/*` — `engineFeature` CLI param + codegen output.
- `test/unit/engine-feature-generation.test.js` (new) — resolve/validate/emit + prompt-building; strong but seam-light.
- `test/unit/engine-features-catalog-envvar-drift.test.js` (new) — catalog↔manifest env-var drift; Case 1 vacuous (issue 4).
- `test/unit/{bl105-serve-manifest.test.js,test_bl105_serve_manifest.py,serve-manifest-reader.test.js,engine-prefix-resolver.test.js}` — manifest/prefix contract updated for the new field and the LMI flip.

Full diff: `git diff HEAD` plus the two untracked test files.

</details>
