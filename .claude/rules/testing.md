---
paths:
  - "test/**"
  - "tests/**"
  - "servers/**/test.js"
  - "servers/**/*.test.js"
  - ".husky/**"
  - ".github/workflows/**"
---
# Tests and quality gates

## Layout
- `test/`: mocha + `node:assert` (no chai, no sinon), split into `unit/`, `property/`
  (fast-check), `integration/` and `input-parsing-and-generation/`. Python tests under `test/`
  and the `tests/` pytest suite run via `python3 -m pytest` (config in `pyproject.toml`).
- Property tests import `NUM_RUNS` / `PROPERTY_CONFIG` from `test/helpers/property-config.js`.
  A hardcoded `numRuns` is rejected by lint and by the pre-commit hook. Arbitraries derive from
  the schema (`test/helpers/arbitraries.js`).
- Mock patterns: bootstrap handlers override `handler._provisionModules`, `_execAws` and
  `_resourceExists`. Never shell out to real CDK or AWS.

## Tests that don't rot
1. **Assert behaviour, not snapshots.** Don't pin an instance SKU, model ID or catalog version
   when the intent is behavioural.
2. **Every test must run somewhere.** It must be reachable from a CI script (`npm test`,
   `test:node`, `test:property`, `test:servers` or pytest). Wire new locations into the runner.
3. **A failing test is evidence.** Decide whether the test or the code is wrong from the ADRs,
   specs and git history.
4. **Never fabricate data** to make a test pass. Use a documented skip with the re-enable
   condition.
5. **No side effects outside a temp dir.** Never write to the real `~/.ml-container-creator`,
   `~/.aws` or the repo tree. Point HOME or config paths at a temp dir.
6. **Network and AWS tests are opt-in** (`--include-network` / `NETWORK_DEPENDENT`). Their
   offline path must still pass.
7. **Drift tests are the backbone.** When you add a source-of-truth derivation or an
   unavoidable duplicate, add the conformance test in the same commit. Check that it actually
   matches something; a regex that counts 0 silently passes.

## Gates
- The live pre-commit gate is `.husky/pre-commit` (summarised in `CLAUDE.md`).
  `.githooks/` is not used.
- CI (`.github/workflows/ci.yml`): docs commands, lint, audit, CDK tests, `test:ci`,
  coverage, server validation and tests, pytest, then schema, manifest and template-coverage
  validators, plus an install-and-generate integration job.
- Known environmental flakes (macOS Python spawn, timeouts) are recorded in
  `docs/dev/test-inventory.md`. Compare against that baseline before calling something a
  regression.
