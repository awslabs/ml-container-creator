---
paths:
  - "templates/do/**"
  - "templates/eks/**"
  - "templates/hyperpod/**"
  - "templates/buildspec.yml"
---
# Generated-project `do/` scripts

These files run in the **user's generated project**, on their machine or in CodeBuild. Some
are EJS-rendered at generate time (`do/config`, `do/register`, the `deploy.d/*` drivers, the
Dockerfile). Most are runtime-driven by `do/config`. The full contract is in
`docs/do-script-contract.md`; the structural map is in `docs/architecture/do-scripts.md`;
the decision is ADR-007.

## Contract
- Every script carries a `# @mlcc-script` header with `type:`, `guard:`, `lifecycle:` and
  `targets:` lines. It then sources `lib/script-contract.sh`, which sources `do/config` and
  `lib/profile.sh` and enforces the declared guard. Guards are defined as `_guard_<name>()`
  in `templates/do/lib/script-contract.sh`. An unknown guard name is a contract violation.
- Exit codes: `0` ok · `1` error · `2` usage · `3` contract violation (reserved — guard not
  met or target not supported) · `4` precondition not met (the message names the fix) ·
  `5` realtime deploy succeeded but scale-to-zero was rolled back.
- `--help` / `-h` must always work, including on a project with nothing deployed.
- Scripts that call `python3` must call `_require_python_env` (from `lib/script-contract.sh`)
  after sourcing it, so the project venv (`.mlcc/hey-venv`) auto-activates.
- AWS credential checks go through `lib/aws-preflight.sh` (`_aws_preflight`). Don't paste a
  credential-check block into a script.

## Writing state back to `do/config`
- Use `_config_set KEY VALUE [FILE]` / `_config_unset KEY [FILE]` from
  `templates/do/lib/config-store.sh`. The contract sources it, and so do libs that run
  without the contract. It escapes the value, keeps the file newline-terminated and writes
  atomically. **Never** write `sed -i "s|^export KEY=.*|…|"` against `do/config` or an IC
  conf file. `test/unit/do-config-store-and-contract.test.js` enforces this.
- Test sandboxes that copy `lib/script-contract.sh` must also copy `lib/config-store.sh`
  (see `test/helpers/additive-sandbox.js`).
  Unescaped `|`, `&`, `"` or `\` corrupts the file, and a missing trailing newline glues two
  exports together.
- A var a script writes at runtime is runtime-owned. Declare it in the target descriptor's
  `runtime_owned_vars` or the engine's `dimension_map` so `mcc regenerate` preserves it.

## Dispatch and descriptors
- Per-target branching belongs in `targets.d/<target>/manifest.json` plus the codegen'd
  `GENERATED` blocks, not in new hand-written `case "$DEPLOYMENT_TARGET"` arms. Aliases
  live in the descriptor's `aliases` field only.
- Read descriptor fields at runtime with `python3 lib/python/target_manifest.py <field> <target>`,
  not with ad-hoc `python3 -c` JSON parsing.

## Bash pitfalls in this tree
- **Bash 3.2 compatible** (macOS default): no `declare -A`, `mapfile`, `${var,,}` or
  `${var^^}`. Use the case-function lookup pattern already in `lib/script-contract.sh`.
- **`$(...)` runs in a subshell.** Anything a function exports inside command substitution
  never reaches the caller. In `deploy.d/hyperpod-eks`, set `HP_MODEL_SOURCE` explicitly
  before `envsubst`.
- `deploy.d/*` and `clean.d/*` are **sourced** by their dispatcher. Use `return`, not
  `exit 0`, to finish successfully, so the dispatcher's post-steps still run.
- Never splice shell values into `python3 -c "…'${VAR}'…"` source text. Pass them as `argv`
  or env vars.
- Never add `2>/dev/null` or `|| true` to commands whose failure matters. Swallowed errors
  are the most common bug class in this tree.
- Manifests rendered at deploy time (`lib/render-eks-manifests.cjs`, `lib/hp-iec-render.sh`)
  must not leave `${VAR}` or `__TOKEN__` placeholders unresolved.

## Product rules that bite here
- HyperPod serving goes through the inference operator (`templates/hyperpod/`, rendered by
  `lib/hp-iec-render.sh`). Engine-specific env vars come from the engine's
  `templates/code/serve.d/<engine>/manifest.json` (`env_var_prefix`, `dimension_map`), so
  never hardcode `VLLM_`.
- Don't advertise a verb, flag or target in usage/help text before it's implemented.
