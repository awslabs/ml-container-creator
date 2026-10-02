# ADR-002: Consolidation & Self-Documenting Re-Architecture Program

## Status

Accepted — in progress (Wave 1)

## Context

`@aws/ml-container-creator` was built almost entirely by AI agents. It works and
is well tested, but the accretion shows: copy-pasted scaffolding (the ~15 MCP
picker servers each re-implement the same server skeleton), overlapping and
confusingly-named modules (`ConfigManager` vs `ConfigurationManager`; three
parallel "validation" subsystems with two independent plugin base classes), and
half-finished abstractions — most visibly the serve-engine plugin system, where
the `serve.d/<engine>/manifest.json` contract exists but vLLM hardcodes its own
prefix and speculative-decoding logic instead of consuming its manifest, and two
of four engines have no manifest at all.

Because the primary maintainer is (and will remain) an AI, the cost that matters
is **the cost to load the system into a model's context and edit it correctly**.
Duplication and leaky abstractions inflate that cost and cause regressions: an
agent editing one of 15 near-identical servers can't tell what is essential
versus incidental, and an agent adding a serve engine can't tell that the
manifest is the source of truth because vLLM demonstrates otherwise.

## Decision

Run a **consolidation-first**, wave-based program that re-architects the codebase
around explicit, self-documenting patterns. The organizing principles:

1. **Consolidation over new features.** The goal is architectural soundness for
   AI maintainability, not new capabilities and not (primarily) determinism.
2. **Self-documenting architecture.** Every pattern-participating module carries
   a standardized header docblock (see
   `docs/architecture/module-header-convention.md`) naming the pattern, its
   collaborators, its data-flow role, and a `See:` reference. Each structural
   decision gets an ADR here; each subsystem gets a `docs/architecture/*.md`
   explainer. Together these let an AI understand one file — and where it sits —
   without spidering the tree.
3. **Breaking changes allowed.** Internal renames and module merges are
   expected. Surface changes (CLI flags, file layout, generated contracts) are
   permitted when clearly justified, with a migration note and a CHANGELOG entry.
4. **One source of truth per fact.** Prefer deriving from the schema
   (`config/parameter-schema-v2.json`), the serve.d manifests, and the do/
   contracts over re-declaring the same fact in code.
5. **Verified per wave.** A wave ends only when `lint` + `test:all` (plus the
   relevant `test:servers` / pytest / codegen parity) are green **relative to the
   known pre-existing baseline** (see `docs/dev/test-inventory.md`) and the
   new/changed modules carry conforming headers.

### Waves

| Wave | Focus |
|---|---|
| 1 | Test-suite streamline (early) + architecture-doc convention (this ADR, the module-header convention, the seed corpus) |
| 2 | MCP picker-server consolidation — a `createPickerServer` factory replacing 15 copy-pasted scaffolds |
| 3 | Serve-engine plugin system — manifest as single source of truth; kill the duplicate prefix map; parity for all engines |
| 4 | Command-handler + do/config parser consolidation; resolve the `ConfigManager`/`ConfigurationManager` collision |
| 5 | Unify the three validation subsystems into one validator/finding framework |
| 6 | `do/` script conventions — full `@mlcc-script` conformance + shared bash/Python helper layer |
| 7 | Agent consolidation — goal-planner/chain-runner/config surface |
| 8 | Documentation — assemble the Developer Guide from the ADR + architecture corpus |
| 9 | Test-suite bookend, final duplication sweep, promote the header lint rule to error, and formalize the AI-maintainer entrypoint (`.kiro/steering.md`) |

### Conventions established in Wave 1

- **Module-header docblock** — `docs/architecture/module-header-convention.md`,
  enforced by the ESLint rule `property-test-rules/require-module-header`
  (warning during Waves 1–8, promoted to error in Wave 9).
- **Schema-derived test arbitraries** — `test/helpers/arbitraries.js` derives
  fast-check generators from the parameter schema so property tests track the
  schema automatically.
- **Baseline honesty** — the suite is not green on macOS at program start
  (environmental Python-spawn and timeout flakes + one real catalog-schema data
  drift). `docs/dev/test-inventory.md` records this so later waves diff against
  it rather than assuming all-green.

## Consequences

- **Positive:** smaller surface area, one source of truth per fact, and
  self-navigating files. Adding an MCP server, a serve engine, a validator, or a
  do/ script becomes a matter of following a documented pattern.
- **Cost:** significant internal churn and renames across waves; downstream
  callers and some tests change. Mitigated by per-wave verification against the
  recorded baseline and by CHANGELOG entries for every breaking/surface change.
- **Risk:** a rename or merge could silently change behavior. Mitigated by
  keeping each wave behavior-preserving where possible, migrating tests
  alongside code, and (in Wave 9) a final duplication sweep + header-lint gate.

## References

- `docs/architecture/README.md` — architecture corpus index
- `docs/architecture/system-overview.md` — the layer map
- `docs/architecture/module-header-convention.md`
- `docs/dev/test-inventory.md` — baseline + redundancy findings
- ADR-001 — the import metadata contract (pre-program)
