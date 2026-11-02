from __future__ import annotations
"""Technique-aware tuning config builder (BL128).

Purpose: render / validate / resolve a technique's hyperparameter knobs from a
         Tune_Descriptor, for both the interactive `do/tune` flow and the
         non-interactive (flag/config) path.

The CORE (`build_config`) is descriptor-source-AGNOSTIC (Requirement 7): it takes a
`hyperparameters` map (the descriptor variant's synced block — the shared
`$defs/hyperparameter` entry shape from BL129) plus already-resolved supplied values,
and returns the resolved knob→value map + any validation errors. It knows nothing about
`tune.d/`, technique names, `_synced`, or `reward_source`. The ONLY `tune.d`-aware code
is the thin `build_from_tune_descriptor` adapter below; the user-authored `do/train`
plugin UX (BL154) will supply its own descriptor source and call the same core.

Precedence (Requirement 4.1): descriptor default < config file < interactive answer /
explicit flag (the user-supplied value wins). An interactive answer and a flag occupy
the same highest tier; a single run supplies a knob through at most one of them, so the
caller merges config + flags into `supplied` (flag-wins) and the core prompts only for
knobs NOT in `supplied`.

Callers: do/tune (via .tune_helper.py `build-config`). The interactive prompt layer is
`questionary` (wired in the do/tune adapter / helper, mirroring deploy_prompts.py); the
core's `prompter` is injectable so it is unit-testable without a TTY.
"""

# No third-party imports at module top — the CORE needs no questionary/pyarrow. The
# tune.d adapter imports tune_manifest lazily; the helper wires questionary.


# ── effective control / tier derivation (R2.3) ────────────────────────────────

_VALID_TIERS = ("primary", "advanced", "tertiary")
_VALID_CONTROLS = ("number_input", "dropdown", "text_input")


def effective_control(knob: dict) -> str:
    """The knob's EFFECTIVE input control: the descriptor `control` when present and
    valid, else derived — `enum` → dropdown, numeric bounds → number_input, else
    text_input. Never assumes `control` is present (MTRL's leaner schema omits it)."""
    control = knob.get("control")
    if control in _VALID_CONTROLS:
        return control
    if isinstance(knob.get("enum"), list) and knob["enum"]:
        return "dropdown"
    if knob.get("type") in ("integer", "number") or "min" in knob or "max" in knob:
        return "number_input"
    return "text_input"


def effective_tier(knob: dict) -> str:
    """The knob's EFFECTIVE disclosure tier: the descriptor `tier` when present and
    valid, else `primary` (so a tier-less MTRL knob is never silently dropped)."""
    tier = knob.get("tier")
    return tier if tier in _VALID_TIERS else "primary"


# ── value coercion + validation (R1.3) ────────────────────────────────────────

def _coerce(knob_name: str, knob: dict, value):
    """Coerce a string/whatever value to the knob's declared type. Returns
    (coerced, error_or_None). Non-fatal: a coercion failure is returned as an error
    string so the caller collects it rather than raising."""
    t = knob.get("type", "string")
    if value is None:
        return None, None
    try:
        if t == "integer":
            return int(str(value)), None
        if t == "number":
            return float(str(value)), None
        if t == "boolean":
            s = str(value).strip().lower()
            if s in ("true", "1", "yes"):
                return True, None
            if s in ("false", "0", "no"):
                return False, None
            return None, f"knob '{knob_name}' expects a boolean (true/false), got '{value}'"
        return str(value), None
    except (ValueError, TypeError):
        return None, f"knob '{knob_name}' expects type {t}, got '{value}'"


def _validate(knob_name: str, knob: dict, value) -> str | None:
    """Validate a coerced value against the knob's constraints. Returns an error
    string naming the knob + allowed range/choices, or None when valid."""
    enum = knob.get("enum")
    if isinstance(enum, list) and enum and value not in enum:
        return f"knob '{knob_name}' must be one of {enum}; got {value!r}"
    lo, hi = knob.get("min"), knob.get("max")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(lo, (int, float)) and value < lo:
            return f"knob '{knob_name}' must be >= {lo}; got {value}"
        if isinstance(hi, (int, float)) and value > hi:
            return f"knob '{knob_name}' must be <= {hi}; got {value}"
        # Step: enforce alignment ONLY for INTEGER knobs (where it is a meaningful,
        # exact constraint). For FLOAT knobs `step` is a UI increment HINT, not a hard
        # divisibility rule — the SMTJ SDK itself does not enforce it and even ships
        # defaults that are not an exact (value-min)/step multiple (e.g. learning_rate
        # default 0.0001 with min 1e-07, step 0.0001). Enforcing it rejected the SDK's
        # own valid default (BL180). Range (min/max) is still enforced for floats.
        step = knob.get("step")
        if (isinstance(step, int) and not isinstance(step, bool) and step > 0
                and isinstance(value, int) and not isinstance(value, bool)
                and lo is not None):
            if (value - lo) % step != 0:
                return f"knob '{knob_name}' must align to step {step} from {lo}; got {value}"
    return None


# ── the CORE (descriptor-source-agnostic) ─────────────────────────────────────

def build_config(hyperparameters: dict, supplied: dict, *, interactive: bool,
                 include_advanced: bool = False, prompter=None) -> dict:
    """Resolve a technique's knobs from its `hyperparameters` map + supplied values.

    Args:
        hyperparameters: the descriptor variant's synced knob map (knob -> entry).
        supplied: already-resolved values from config file + flags (flag-wins merged by
            the caller). A knob present here is NOT prompted.
        interactive: True when a TTY is present and the user did not pass
            --non-interactive. When True and a primary/advanced knob is not in
            `supplied`, the user is prompted via `prompter`.
        include_advanced: the "advanced options" opt-in (R2.2). advanced knobs are
            prompted only when True; tertiary knobs are never prompted (R2.2).
        prompter: callable(name, knob, control, default) -> raw value, for interactive
            knobs. Injectable for tests; None forces the non-interactive path.

    Returns:
        {"resolved": {knob: coerced_value}, "sources": {knob: str}, "errors": [str, ...]}.
        `sources` records, per resolved knob, WHERE its value came from — one of
        "supplied" (config file / --set / legacy flag), "prompt" (interactively entered),
        or "default" (the knob's own default, neither supplied nor prompted). This lets
        do/tune show the user EVERY knob the job will receive and flag the ones it chose
        for them (Option A transparency) — including advanced/tertiary knobs that are
        resolved-at-default but never prompted. The caller decides fail-fast on a
        non-empty `errors`. A `required` knob that resolves to no value is an error
        (R4.3). Unknown supplied knobs (not in `hyperparameters`) are errors (R3.3).
    """
    resolved: dict = {}
    sources: dict = {}
    errors: list[str] = []

    # (R3.3) reject supplied knobs that are not in this technique's descriptor.
    for name in supplied:
        if name not in hyperparameters:
            known = ", ".join(sorted(hyperparameters)) or "(none)"
            errors.append(
                f"unknown hyperparameter '{name}' for this technique. "
                f"Valid knobs: {known}."
            )

    for name, knob in hyperparameters.items():
        tier = effective_tier(knob)
        has_default = "default" in knob
        value = None
        source = None

        if name in supplied:
            value = supplied[name]
            source = "supplied"
        elif interactive and prompter is not None and (
            tier == "primary" or (tier == "advanced" and include_advanced)
        ):
            # Prompt (R2.1/R2.2). tertiary is never prompted; advanced only on opt-in.
            raw = prompter(name, knob, effective_control(knob),
                           knob.get("default") if has_default else None)
            if raw is not None and str(raw) != "":
                value = raw
                source = "prompt"
            elif has_default:
                value = knob["default"]
                source = "default"
        elif has_default:
            value = knob["default"]
            source = "default"

        if value is None:
            # No supplied/prompted/default value. A required knob is an error (R4.3);
            # an optional knob with no default is simply omitted.
            if knob.get("required") is True:
                errors.append(
                    f"required hyperparameter '{name}' has no value "
                    f"(no default, config value, or flag/answer)."
                )
            continue

        # Coerce + validate every resolved value (identical for prompt/flag — R3.4).
        # A descriptor default is trusted (already valid) but coercing is harmless.
        coerced, cerr = _coerce(name, knob, value)
        if cerr:
            errors.append(cerr)
            continue
        verr = _validate(name, knob, coerced)
        if verr:
            errors.append(verr)
            continue
        resolved[name] = coerced
        sources[name] = source

    return {"resolved": resolved, "sources": sources, "errors": errors}


# ── tune.d adapter (the ONLY tune.d-aware entry) ──────────────────────────────

def build_from_tune_descriptor(technique, variant, supplied, *, interactive,
                               include_advanced=False, prompter=None, tune_dir=None,
                               skip_knobs=None):
    """Read the `tune.d/<technique>` descriptor's hyperparameters and run the core.

    This is the single place that knows about tune.d/ and technique names; the CORE
    (`build_config`) has no such coupling. BL154's do/train adapter is a sibling that
    reads a user-authored descriptor (with its own runtime schema validation) and calls
    the same core.

    DEPRECATED as the primary HP source for managed do/tune (BL180): the static
    descriptor's synced HP block is PER-TECHNIQUE but the SMTJ trainer's valid options
    are PER-MODEL (older vs newer models legitimately differ — e.g. qwen2.5 still lists
    `gradient_clipping`/a 16-start batch enum while gemma-4 does not). Prefer
    `build_from_sdk_specs` (resolve the actual model's `_specs` live). This path is kept
    as a FALLBACK for when the SDK/model cannot be resolved (offline, bad creds).
    """
    import tune_manifest
    hp = tune_manifest.read_hyperparameters(technique, variant, tune_dir)
    for _k in (skip_knobs or []):
        hp.pop(_k, None)
    return build_config(hp, supplied, interactive=interactive,
                        include_advanced=include_advanced, prompter=prompter)


# ── do/train adapter (BL154 — the ONLY train-manifest-aware entry) ────────────

# Source labels the train adapter reports per knob (R4.4). The core's generic
# "supplied" / "default" are relabeled to the precise tier the value came from.
TRAIN_SOURCE_LABELS = ("manifest", "defaults.yaml", "config.yaml", "flag", "prompt")


def _hp_str(value) -> str:
    """Stringify a hyperparameter value for SageMaker's string-only HyperParameters,
    exactly as do/train's legacy merge always has (str(v)) — so an unchanged value
    keeps its original form (e.g. '2e-4' stays '2e-4', never '0.0002')."""
    return str(value)


def _unknown_knob_error(name, technique, declared):
    import difflib
    close = difflib.get_close_matches(name, declared, n=1)
    hint = f" \u2014 did you mean '{close[0]}'?" if close else ""
    listing = ", ".join(declared) or "(none)"
    return (
        f"unknown knob '{name}' for technique '{technique}'{hint} "
        f"Declared: {listing} (use --allow-unknown to pass it to train.py anyway)"
    )


def build_from_train_descriptor(technique, supplied, *, interactive, include_advanced=False,
                                prompter=None, training_dir, defaults=None, config_hp=None,
                                allow_unknown=False):
    """Thin train-manifest adapter (BL154) over the descriptor-agnostic core.

    Loads + validates ``<training_dir>/<technique>/manifest.json`` via
    ``train_manifest.load_train_manifest`` (raises ``TrainManifestError`` when invalid).
    Returns None when the technique has NO manifest — the caller then uses the
    descriptor-less legacy merge (R6).

    The manifest carries knob METADATA; values come from the layers, overlaid onto each
    knob's ``default`` before calling ``build_config`` (R4.1, lowest -> highest):
    manifest ``default`` < ``defaults.yaml`` < ``config.yaml`` < flag/--set (supplied).
    Interactive mode prompts only knobs NOT supplied, offering the overlaid value as the
    prompt default (so config.yaml values are re-offered, R4.2).

    Then: (a) relabels sources — core "default" -> manifest | defaults.yaml | config.yaml,
    "supplied" -> flag, "prompt" stays; (b) passes through, stringified, keys from
    defaults.yaml / config.yaml that the manifest does not declare (listed in
    ``passthrough`` for the notice, R3.4); (c) rejects SUPPLIED keys the manifest does not
    declare with a difflib suggestion + the declared-knob list, unless ``allow_unknown``
    (then they pass through like (b)) (R3.6/R3.7).

    Returns {"resolved": {knob: str}, "typed": {knob: coerced}, "sources": {knob: label},
    "passthrough": [knob, ...], "prompted": {knob: str}, "errors": [...],
    "notes": [...], "descriptor": True}. ``resolved`` values are the ORIGINAL value
    forms stringified (not re-rendered from the coerced type) so unchanged values keep
    the exact string train.py has always parsed.
    """
    import copy
    import train_manifest

    manifest = train_manifest.load_train_manifest(training_dir, technique)
    if manifest is None:
        return None

    defaults = defaults or {}
    config_hp = config_hp or {}
    supplied = supplied or {}
    declared_hp = manifest.get("hyperparameters") or {}
    declared = sorted(declared_hp)

    # Value-layer overlay onto knob defaults (manifest < defaults.yaml < config.yaml).
    hp = copy.deepcopy(declared_hp)
    layer_source = {}
    for name, knob in hp.items():
        if "default" in knob and knob["default"] is not None:
            layer_source[name] = "manifest"
        for label, layer in (("defaults.yaml", defaults), ("config.yaml", config_hp)):
            if name in layer and layer[name] is not None:
                knob["default"] = layer[name]
                layer_source[name] = label

    errors = []
    notes = []
    declared_supplied = {k: v for k, v in supplied.items() if k in declared_hp}
    unknown_supplied = [k for k in supplied if k not in declared_hp]
    if not allow_unknown:
        for name in unknown_supplied:
            errors.append(_unknown_knob_error(name, technique, declared))

    # Capture the raw prompt answer so the original string form is preserved.
    prompted_raw = {}
    wrapped = None
    if prompter is not None:
        def wrapped(name, knob, control, default):
            raw = prompter(name, knob, control, default)
            if raw is not None and str(raw) != "":
                prompted_raw[name] = raw
            return raw

    core = build_config(hp, declared_supplied, interactive=interactive,
                        include_advanced=include_advanced, prompter=wrapped)
    errors.extend(core["errors"])

    resolved, sources, prompted = {}, {}, {}
    for name in core["resolved"]:
        src = core["sources"].get(name)
        if src == "supplied":
            raw, label = declared_supplied[name], "flag"
        elif src == "prompt":
            raw, label = prompted_raw.get(name, core["resolved"][name]), "prompt"
            prompted[name] = _hp_str(raw)
        else:
            raw, label = hp[name].get("default"), layer_source.get(name, "manifest")
        resolved[name] = _hp_str(raw)
        sources[name] = label

    # Pass-through: undeclared keys from defaults.yaml / config.yaml (deliberate edits
    # to files train.py's author owns), plus undeclared supplied keys when allowed.
    passthrough = []
    layers = [("defaults.yaml", defaults), ("config.yaml", config_hp)]
    if allow_unknown:
        layers.append(("flag", {k: supplied[k] for k in unknown_supplied}))
    for label, layer in layers:
        for name, value in layer.items():
            if name in declared_hp or value is None:
                continue
            resolved[str(name)] = _hp_str(value)
            sources[str(name)] = label
            if str(name) not in passthrough:
                passthrough.append(str(name))

    return {
        "resolved": resolved,
        "typed": core["resolved"],
        "sources": sources,
        "passthrough": passthrough,
        "prompted": prompted,
        "errors": errors,
        "notes": notes,
        "descriptor": True,
    }


def rewrite_hyperparameters_block(text: str, mapping: dict) -> str:
    """TARGETED rewrite of a config.yaml's top-level ``hyperparameters:`` block (R4.5).

    Replaces only the span from the top-level ``hyperparameters:`` line through its last
    indented line with ``mapping`` (double-quoted string values, as the template uses);
    every other line is left exactly as it was. Appends the block when the key is
    absent. Handles the flow-style one-liner (``hyperparameters: {}``). Comments INSIDE
    the replaced span are not preserved. Never a full YAML round-trip."""
    def _q(value) -> str:
        s = str(value).replace("\\", "\\\\").replace('"', '\\"')
        return f'"{s}"'

    def _k(key) -> str:
        key = str(key)
        safe = key and all(c.isalnum() or c in "_-." for c in key)
        return key if safe else _q(key)

    lines = text.splitlines(keepends=True)
    newline = "\n"
    for ln in lines:
        if ln.endswith("\r\n"):
            newline = "\r\n"
            break
    if mapping:
        block = [f"hyperparameters:{newline}"] + [
            f"  {_k(k)}: {_q(v)}{newline}" for k, v in mapping.items()]
    else:
        block = [f"hyperparameters: {{}}{newline}"]

    start = None
    for i, ln in enumerate(lines):
        stripped = ln.rstrip("\r\n")
        if stripped.startswith("hyperparameters:") or stripped.startswith("hyperparameters :"):
            start = i
            break
    if start is None:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] = lines[-1] + newline
        return "".join(lines + block)

    end = start + 1
    for j in range(start + 1, len(lines)):
        body = lines[j].rstrip("\r\n")
        if body.strip() == "" or body.startswith("#"):
            continue  # tentatively inside; only consumed if more indented lines follow
        if body[0] in (" ", "\t"):
            end = j + 1
            continue
        break
    return "".join(lines[:start] + block + lines[end:])


# MLCC technique label → SMTJ trainer (module, class). Mirrors scripts/dump-tune-specs.py.
_TECHNIQUE_TO_TRAINER = {
    "sft": ("sagemaker.train.sft_trainer", "SFTTrainer"),
    "dpo": ("sagemaker.train.dpo_trainer", "DPOTrainer"),
    "rlvr": ("sagemaker.train.rlvr_trainer", "RLVRTrainer"),
    "rlaif": ("sagemaker.train.rlaif_trainer", "RLAIFTrainer"),
    "mtrl": ("sagemaker.train.multi_turn_rl_trainer", "MultiTurnRLTrainer"),
}


def read_sdk_specs(technique, model, *, training_type="lora"):
    """BL180/Option-1: read the SMTJ SDK's AUTHORITATIVE, PER-MODEL hyperparameter
    specs for (technique, model) by constructing the trainer and reading
    ``hyperparameters._specs`` — the recipe resolved + the trainer's per-technique/
    per-model mutations, i.e. exactly what the submit-time validator enforces.

    Returns the builder-shaped ``{knob: {type, required, default, enum, min, max,
    step, control, tier, display_name, description, hint}}`` for the ``category ==
    'hyperparameter'`` entries only (system/plumbing knobs excluded), renaming the
    SDK's ``control_type``→``control`` and ``visibility_tier``→``tier`` (the same
    mapping the Node sync applied). Raises on any failure so the caller can fall back
    to the static descriptor — this is a live SDK + AWS call (the trainer resolves the
    recipe), ~5s; do/tune already constructs this exact trainer to submit, so no new
    dependency is introduced.
    """
    import importlib
    entry = _TECHNIQUE_TO_TRAINER.get((technique or "").strip().lower())
    if entry is None:
        raise ValueError(f"unknown technique '{technique}'")
    module_name, class_name = entry
    trainer_cls = getattr(importlib.import_module(module_name), class_name)

    tt = (training_type or "lora").strip().lower()
    tt_arg = "FULL" if tt in ("full", "full-rank", "full_rank") else "LORA"
    kwargs = {"model": model, "model_package_group": "mlcc-spec-probe"}
    try:
        trainer = trainer_cls(training_type=tt_arg, **kwargs)
    except TypeError:
        # Some trainers (e.g. MTRL) do not accept training_type.
        trainer = trainer_cls(**kwargs)

    hp_obj = getattr(trainer, "hyperparameters", None)
    specs = getattr(hp_obj, "_specs", None)
    if not isinstance(specs, dict) or not specs:
        raise RuntimeError(f"{class_name} exposed no _specs for model '{model}'")

    # The recipe's sequence-length ceiling (prompt+response for RL, dataset_max_len
    # for SFT/DPO). The SDK enforces max_prompt_length + max_response_length <= this
    # AT SUBMIT — a cross-field rule no per-knob min/max can express. Capturing it
    # here lets the builder fail fast at RESOLVE time (before a full interactive
    # session + submit round-trip), instead of letting the user pick a 16384+4096
    # pair the recipe then rejects. Carried out-of-band under a reserved key the
    # builder strips before resolution (see build_from_sdk_specs).
    seq_len = getattr(hp_obj, "_sequence_length", None)

    out = {}
    for name, spec in specs.items():
        if not isinstance(spec, dict) or spec.get("category") != "hyperparameter":
            continue  # drop system/plumbing knobs the user never sets
        entry_out = {}
        for k in ("type", "required", "default", "enum", "min", "max", "step",
                  "display_name", "description", "hint"):
            if k in spec and spec[k] is not None:
                entry_out[k] = spec[k]
        # Normalize the SDK's raw type to the builder/schema vocabulary, else _coerce
        # (which only knows integer/number/boolean/string) leaves a 'float' value as a
        # STRING and the submit fails with "<knob> must be a number, got str". The SDK
        # uses 'float' for reals and occasionally 'array'; map them (mirrors the Node
        # sync's _normalizeKnobType).
        entry_out["type"] = _NORMALIZE_SDK_TYPE.get(
            str(entry_out.get("type", "string")).lower(), "string")
        # Canonical-key rename (SDK → descriptor/builder shape).
        if spec.get("control_type") is not None:
            entry_out["control"] = spec["control_type"]
        if spec.get("visibility_tier") is not None:
            entry_out["tier"] = spec["visibility_tier"]
        out[name] = entry_out
    _enrich_judge_model_knob(out)
    if isinstance(seq_len, int) and seq_len > 0:
        out[_SEQUENCE_LENGTH_KEY] = seq_len
    return out


# The judge-model knob (RLAIF) ships as free-text with enum=None in `_specs`, yet the
# SDK DOES enumerate the supported judge models — in constants._ALLOWED_REWARD_MODEL_IDS,
# region-gated — and even ships a DEFAULT (deepseek.v3.2) that is NOT in that allowed
# set. So the free-text knob both (a) can't be a dropdown and (b) defaults to a model
# the managed RLAIF path may reject. We enrich the knob from the SDK's own allowed list,
# filtered to the active region, turning it into a dropdown and fixing the default —
# derived from the SDK (no hardcoded model list), never invented here.
_JUDGE_MODEL_KNOB = "judge_model_id"


def _allowed_judge_models(region):
    """Region-filtered allowed judge models from the SDK constant, as
    'bedrock/<id>' strings (the form judge_model_id takes). Empty on any failure —
    enrichment is best-effort and must never break resolution."""
    try:
        from sagemaker.train.constants import _ALLOWED_REWARD_MODEL_IDS as allowed
    except Exception:  # noqa: BLE001 — older/newer SDK without the constant
        return []
    out = []
    for model_id, regions in (allowed or {}).items():
        if region is None or not regions or region in regions:
            out.append(f"bedrock/{model_id}")
    return sorted(out)


def _enrich_judge_model_knob(hp):
    """If the judge-model knob is present, give it an enum of SDK-allowed, region-valid
    models (so the UX renders a dropdown) and repoint a default that is not in that set
    to the first allowed model. Appends the current default as a last option when it is
    NOT in the allowed set, so a user who really wants it can still pick it (the managed
    path MAY accept more than the kwarg-validated list). No-op when the knob is absent
    or the SDK exposes no allowed list."""
    knob = hp.get(_JUDGE_MODEL_KNOB)
    if not isinstance(knob, dict):
        return
    import os
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    allowed = _allowed_judge_models(region)
    if not allowed:
        return  # leave the free-text knob as-is rather than invent a list
    current = knob.get("default")
    options = list(allowed)
    if current and current not in options:
        # Keep the SDK's (possibly unsupported) default selectable, flagged last.
        options.append(current)
    # Use `choices` (UI dropdown options), NOT `enum` (a HARD validation constraint):
    # the kwarg-validated allowed list gates the reward_model_id kwarg, but the
    # judge_model_id HYPERPARAMETER may accept more at the managed path, so a --set
    # custom value must not be rejected. The prompter renders `choices` as a dropdown.
    knob["choices"] = options
    knob["control"] = "dropdown"
    # Repoint a default that the SDK's own allowed list does not include.
    if current not in allowed:
        knob["default"] = allowed[0]


# Reserved, non-knob key under which read_sdk_specs carries the recipe's
# sequence-length ceiling in its returned map. It is NOT a hyperparameter — the
# builder reads it for the cross-field length check and strips it before resolving,
# so it never reaches build_config's knob loop or the submitted job.
_SEQUENCE_LENGTH_KEY = "__sequence_length__"


def _check_length_sum(resolved, sequence_length):
    """Return an error string if the RL length pair exceeds the recipe ceiling, else
    None. Mirrors the SDK's FineTuningOptions.validate_length_constraints so the
    failure surfaces at resolve time (fail-fast) rather than deep in submit. No-op
    unless BOTH max_prompt_length and max_response_length resolved and the ceiling
    is known."""
    if not isinstance(sequence_length, int) or sequence_length <= 0:
        return None
    prompt = resolved.get("max_prompt_length")
    response = resolved.get("max_response_length")
    if not isinstance(prompt, int) or not isinstance(response, int):
        return None
    total = prompt + response
    if total > sequence_length:
        return (
            f"max_prompt_length ({prompt}) + max_response_length ({response}) "
            f"= {total} exceeds the recipe's supported sequence length "
            f"({sequence_length}). Lower one or both so their sum is \u2264 "
            f"{sequence_length} (e.g. --set max_prompt_length={sequence_length // 2} "
            f"--set max_response_length={sequence_length // 2})."
        )
    return None


def _fit_length_defaults(hyperparameters, sequence_length):
    """If the SDK's DEFAULT length pair over-budgets the recipe ceiling, rewrite the
    two knobs' ``default`` values IN THE SPEC so the fitted pair is what the user is
    shown (interactive) or resolves to (non-interactive). Mutates the knob dicts in
    ``hyperparameters`` in place and returns a human note (or None if nothing changed).

    This runs BEFORE resolution/prompting — deliberately. Keying off the resolved
    value's "source" does not work: accepting a prompted default records source
    "prompt", not "default", so a post-resolve fix would skip the interactive path
    (the one the user actually hits). Adjusting the spec default up front means the
    prompt shows a VALID starting pair; whatever the user then accepts or types is
    validated normally, and a deliberately-typed over-budget pair still fails fast via
    _check_length_sum.

    The SDK ships a self-contradictory default pair (max_prompt_length=16384 +
    max_response_length=4096 = 20480 against a 16384 ceiling). We preserve the SDK's
    prompt:response RATIO scaled to the ceiling, then clamp each to its own [min,max];
    if clamping breaks the sum we fall back to an even split.
    """
    if not isinstance(sequence_length, int) or sequence_length <= 0:
        return None
    p_knob = hyperparameters.get("max_prompt_length")
    r_knob = hyperparameters.get("max_response_length")
    if not isinstance(p_knob, dict) or not isinstance(r_knob, dict):
        return None
    p = p_knob.get("default")
    r = r_knob.get("default")
    if not isinstance(p, int) or not isinstance(r, int):
        return None
    if p + r <= sequence_length:
        return None

    def _bounds(knob):
        lo = knob.get("min")
        hi = knob.get("max")
        return (lo if isinstance(lo, int) else 1,
                hi if isinstance(hi, int) else sequence_length)

    p_lo, p_hi = _bounds(p_knob)
    r_lo, r_hi = _bounds(r_knob)

    # Preserve the SDK ratio, scaled to the ceiling.
    new_p = max(p_lo, min(round(sequence_length * p / (p + r)), p_hi))
    new_r = sequence_length - new_p
    # If the ratio split pushed response out of its bounds, clamp and reflow prompt.
    if new_r < r_lo or new_r > r_hi:
        new_r = max(r_lo, min(new_r, r_hi))
        new_p = max(p_lo, min(sequence_length - new_r, p_hi))
    # Last-resort even split if bounds still can't reconcile the sum.
    if new_p + new_r > sequence_length or new_p < p_lo or new_r < r_lo:
        new_p = max(p_lo, min(sequence_length // 2, p_hi))
        new_r = max(r_lo, min(sequence_length - new_p, r_hi))
        if new_p + new_r > sequence_length:
            return None  # cannot fit within both bounds — leave for _check_length_sum

    p_knob["default"] = new_p
    r_knob["default"] = new_r
    return (
        f"Adjusted the default max_prompt_length/max_response_length from "
        f"{p}/{r} (sum {p + r}) to {new_p}/{new_r} to fit the recipe's sequence "
        f"length ({sequence_length}). Enter different values to override."
    )


# SDK raw type → builder/schema type (string|integer|number|boolean). The core's
# _coerce understands only these, so float/double→number, int→integer, array/list→
# string, bool→boolean. Mirrors _OVERRIDE_PARAM_TYPE_MAP in scripts/sync-model-families.js.
_NORMALIZE_SDK_TYPE = {
    "string": "string", "integer": "integer", "number": "number", "boolean": "boolean",
    "float": "number", "double": "number", "int": "integer", "bool": "boolean",
    "array": "string", "list": "string",
}


def build_from_sdk_specs(technique, model, supplied, *, interactive,
                         include_advanced=False, prompter=None, training_type="lora",
                         skip_knobs=None):
    """Resolve the PER-MODEL SDK specs (read_sdk_specs) and run the core. The
    authoritative, staleness-free HP source for managed do/tune (BL180 Option 1).

    `skip_knobs` drops named knobs before resolution/prompting — used when a value
    is set elsewhere (e.g. judge_prompt_template when --reward-prompt was passed), so
    the user is not asked for the same thing twice."""
    hp = read_sdk_specs(technique, model, training_type=training_type)
    # Pull the out-of-band sequence-length ceiling (not a knob) before resolving.
    sequence_length = hp.pop(_SEQUENCE_LENGTH_KEY, None)
    for _k in (skip_knobs or []):
        hp.pop(_k, None)
    # Auto-fit the SDK's self-contradictory DEFAULT length pair (e.g. 16384+4096 >
    # 16384) BEFORE resolving/prompting, by rewriting the knobs' spec defaults —
    # preserving the SDK's prompt:response ratio, scaled to the ceiling. This way the
    # interactive prompt shows a VALID pair to accept, and the non-interactive path
    # resolves to it. A user who then TYPES an over-budget pair still fails fast below.
    note = _fit_length_defaults(hp, sequence_length)
    result = build_config(hp, supplied, interactive=interactive,
                          include_advanced=include_advanced, prompter=prompter)
    # Only surface the adjustment note if the fitted default actually reached the
    # user — i.e. at least one length knob resolved from the default (not fully
    # overridden by a --set/typed value). When the user supplied BOTH, the fit had
    # no visible effect and the note would be misleading.
    if note:
        srcs = result.get("sources", {})
        if srcs.get("max_prompt_length") != "supplied" or \
           srcs.get("max_response_length") != "supplied":
            result.setdefault("notes", []).append(note)
    # Cross-field fail-fast: an EXPLICIT (user-typed/supplied) length pair that still
    # exceeds the ceiling errors here — do/tune surfaces a non-empty `errors` as
    # fail-fast — instead of failing deep in submit after a full interactive session.
    length_err = _check_length_sum(result.get("resolved", {}), sequence_length)
    if length_err:
        result.setdefault("errors", []).append(length_err)
    return result


# ── questionary prompt layer (interactive) ────────────────────────────────────

def _questionary_prompter(name, knob, control, default):
    """Prompt for one knob via questionary, modeled on deploy_prompts.py. Returns the
    user's raw string (or None). A dropdown (enum) → questionary.select; numeric/text →
    questionary.text pre-filled with the default. Validation is re-done by the core, so
    this layer only needs to collect input.

    BL178: the prompt UI is rendered to STDERR (not stdout). do/tune invokes
    `build-config` inside a command substitution `bc_result=$(... build-config ...)`
    that CAPTURES stdout — the final {resolved,errors} JSON. prompt_toolkit's default
    output is stdout, so without this the prompt would draw into the captured pipe
    (invisible → the CLI appears to hang) and corrupt the JSON. Routing the prompt
    output to stderr keeps stdout clean (JSON only) and the prompt visible on the
    terminal; input still comes from the controlling tty. Mirrors deploy_prompts.py's
    stderr convention."""
    import sys
    import questionary
    # Render the prompt UI to stderr so it does not land in do/tune's captured stdout.
    _out = None
    try:
        from prompt_toolkit.output.defaults import create_output
        _out = create_output(stdout=sys.stderr)
    except Exception:  # noqa: BLE001 — if unavailable, fall back to default (stdout)
        _out = None
    _kw = {"output": _out} if _out is not None else {}
    label = knob.get("display_name") or name
    desc = knob.get("description") or knob.get("hint")
    message = f"{label}:" if not desc else f"{label} ({desc}):"
    # Dropdown options come from `choices` (soft UI list — e.g. the SDK-allowed judge
    # models, which must NOT hard-reject a custom --set) or `enum` (hard constraint).
    _options = knob.get("choices") if isinstance(knob.get("choices"), list) else knob.get("enum")
    if control == "dropdown" and isinstance(_options, list) and _options:
        choices = [str(c) for c in _options]
        default_str = str(default) if default is not None else None
        res = questionary.select(
            message, choices=choices,
            default=default_str if default_str in choices else None,
            **_kw,
        ).ask()
        return res
    # BL-UX: numeric (and any min/max-bounded) knob — SHOW the allowed range in the
    # message AND validate INLINE so an out-of-range value is rejected AT the prompt
    # (naming the range) instead of silently accepted and only caught by the core
    # after all prompts finish. The inline check reuses the core _coerce/_validate so
    # it agrees exactly with the authoritative validation.
    lo, hi = knob.get("min"), knob.get("max")
    if lo is not None or hi is not None:
        if lo is not None and hi is not None:
            message = f"{message[:-1]} [{lo}–{hi}]:" if message.endswith(":") else f"{message} [{lo}–{hi}]"
        elif lo is not None:
            message = f"{message[:-1]} [>= {lo}]:" if message.endswith(":") else f"{message} [>= {lo}]"
        else:
            message = f"{message[:-1]} [<= {hi}]:" if message.endswith(":") else f"{message} [<= {hi}]"

        def _validate_input(text):
            text = (text or "").strip()
            if text == "":
                return True  # empty → accept the default (handled by the caller)
            coerced, cerr = _coerce(name, knob, text)
            if cerr:
                return cerr
            verr = _validate(name, knob, coerced)
            return verr if verr else True

        return questionary.text(
            message, default=str(default) if default is not None else "",
            validate=_validate_input, **_kw,
        ).ask()
    return questionary.text(
        message, default=str(default) if default is not None else "",
        **_kw,
    ).ask()


def cmd_build_config(args):
    """`.tune_helper.py build-config` — resolve a technique's knobs and print
    {resolved, errors} as JSON for do/tune to consume. `--supplied` is the merged
    config-file + --set map (flag-wins) as JSON. Interactive unless --non-interactive
    or no TTY; prompts via questionary."""
    import json
    import sys
    from common import _output

    try:
        supplied = json.loads(args.supplied) if args.supplied else {}
    except (ValueError, TypeError):
        from common import _error_exit
        _error_exit("--supplied must be valid JSON (a {knob: value} object)")
    if not isinstance(supplied, dict):
        from common import _error_exit
        _error_exit("--supplied must be a JSON object")

    interactive = (not getattr(args, "non_interactive", False)) and sys.stdin.isatty()
    prompter = _questionary_prompter if interactive else None
    variant = getattr(args, "variant", None)
    model = getattr(args, "model", None)
    skip_knobs = getattr(args, "skip_knobs", None) or []

    # BL180 Option 1: when the model is known, resolve the AUTHORITATIVE per-model HP
    # specs live from the SMTJ SDK (read_sdk_specs) — correct-by-construction, never
    # stale, no per-technique descriptor divergence. Fall back to the static tune.d
    # descriptor only when the SDK/model cannot be resolved (offline / no creds / a
    # model the SDK rejects), so do/tune still works degraded rather than failing.
    result = None
    if model:
        try:
            result = build_from_sdk_specs(
                args.technique, model, supplied,
                interactive=interactive, include_advanced=getattr(args, "advanced", False),
                prompter=prompter,
                training_type=("full-rank" if (variant or "lora") in ("full", "full-rank") else "lora"),
                skip_knobs=skip_knobs,
            )
        except Exception as exc:  # noqa: BLE001 — degrade to the descriptor, with a note
            print(f"\u2139\ufe0f  Could not read live SMTJ specs for '{model}' "
                  f"({exc}); falling back to the tune descriptor.", file=sys.stderr)
            result = None

    if result is None:
        result = build_from_tune_descriptor(
            args.technique, variant, supplied,
            interactive=interactive, include_advanced=getattr(args, "advanced", False),
            prompter=prompter, tune_dir=getattr(args, "tune_dir", None),
            skip_knobs=skip_knobs,
        )
    _output(result)
