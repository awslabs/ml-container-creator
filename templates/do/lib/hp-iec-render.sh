#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# hp-iec-render.sh — the shared InferenceEndpointConfig (IEC) render (Wave 11 R7.4).
#
# Moved VERBATIM out of do/deploy.d/hyperpod-eks so do/add-pod renders a second
# IEC from the SAME project template the base deployment uses. The base render
# output is byte-identical before and after the move (golden test:
# test/unit/hp-iec-render.test.js); the add-pod overrides below are inert unless
# their variable is set.
#
# Sourced by do/deploy.d/hyperpod-eks and do/add-pod (bash 3.2 safe).
#
# Inputs (environment, set by the caller before _hp_render_iec):
#   MODEL_SOURCE_CONFIG     multi-line modelSourceConfig YAML (__MODEL_SOURCE_CONFIG__)
#   HP_TIER1_ENVVARS        Tier-1 env block (__TIER1_ENVVARS__)
#   VLLM_EXTRA_ENVVARS      Tier-2 pass-through env block (__VLLM_EXTRA_ENVVARS__)
#   HP_MODEL_NAME_OVERRIDE  rewrites the top-level spec.modelName
#   add-pod overrides (each asserts EXACTLY ONE match, else exit 3):
#   HP_IEC_NAME             rewrites metadata.name, spec.endpointName and the `app:` label
#   HP_MODEL_LOCATION       rewrites modelLocation (the S3 key prefix of the weights)
#   HP_IEC_ROLE             adds labels mlcc.aws/project-name=<PROJECT_NAME>, mlcc.aws/role=<role>
#   HP_IEC_REPLICAS         rewrites spec.replicas (do/add-pod serves one replica)
#   HP_IEC_NODE_GROUP       replaces spec.instanceType with a nodeAffinity pinning the
#                           instance group (the CRD makes the two mutually exclusive)
#
# Output: one file per rendered manifest in <out-dir> (NNN-<name>.yaml); sets
# _HP_RENDER_N to the number of manifests written.

# Portable variable-substitution shim.
#
# GNU envsubst only expands bare ${VAR}/$VAR references and does NOT understand
# the ${VAR:-default} form — it would leave those placeholders verbatim, which
# produces invalid YAML for kubectl. The CRD template (BL096) uses ${VAR:-N}
# defaults for HP_INSTANCE_TYPE / HP_GPU_COUNT / HP_CPU_REQUEST / HP_MEM_REQUEST,
# so we always route substitution through a perl pass that resolves BOTH the
# ${VAR:-default} and the bare ${VAR} forms from the process environment. This is
# deterministic across macOS/Linux and independent of whether gettext is present.
envsubst() {
    perl -pe '
        # ${VAR:-default} → env value if set & non-empty, else the default.
        s/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/
            (defined $ENV{$1} && length $ENV{$1}) ? $ENV{$1} : $2/ge;
        # bare ${VAR} → env value if defined, else leave the placeholder intact
        # (so unrelated shell references are not silently dropped).
        s/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/
            defined $ENV{$1} ? $ENV{$1} : "\${$1}"/ge;
    '
}

# _hp_render_iec <out-dir> [manifest-dir] — render every <manifest-dir>/*.yaml
# (default: hyperpod) into <out-dir>. Returns non-zero (3) when an add-pod
# override does not match exactly once.
_hp_render_iec() {
    local _out_dir="$1" _src_dir="${2:-hyperpod}" manifest RENDERED
    _HP_RENDER_N=0
    for manifest in "${_src_dir}"/*.yaml; do
        # envsubst first (expands ${ECR_IMAGE}, ${HP_INSTANCE_TYPE}, ${HP_*} defaults),
        # then splice the multi-line modelSourceConfig block in place of the marker,
        # preserving the marker line's indentation for every replacement line so the
        # rendered YAML stays well-formed.
        RENDERED=$(envsubst < "${manifest}")
        RENDERED=$(MODEL_SOURCE_CONFIG="${MODEL_SOURCE_CONFIG}" \
            HP_MODEL_NAME_OVERRIDE="${HP_MODEL_NAME_OVERRIDE}" \
            HP_TIER1_ENVVARS="${HP_TIER1_ENVVARS}" \
            printf '%s' "${RENDERED}" | \
            MODEL_SOURCE_CONFIG="${MODEL_SOURCE_CONFIG}" \
            HP_MODEL_NAME_OVERRIDE="${HP_MODEL_NAME_OVERRIDE}" \
            HP_TIER1_ENVVARS="${HP_TIER1_ENVVARS}" \
            HP_IEC_NAME="${HP_IEC_NAME:-}" \
            HP_MODEL_LOCATION="${HP_MODEL_LOCATION:-}" \
            HP_IEC_ROLE="${HP_IEC_ROLE:-}" \
            HP_IEC_NODE_GROUP="${HP_IEC_NODE_GROUP:-}" \
            HP_IEC_REPLICAS="${HP_IEC_REPLICAS:-}" \
            HP_IEC_PROJECT="${PROJECT_NAME:-}" \
            python3 -c '
import os, re, sys
repl = os.environ.get("MODEL_SOURCE_CONFIG", "")
extra_envvars = os.environ.get("VLLM_EXTRA_ENVVARS", "")
tier1_envvars = os.environ.get("HP_TIER1_ENVVARS", "")
name_override = os.environ.get("HP_MODEL_NAME_OVERRIDE", "")
marker = "__MODEL_SOURCE_CONFIG__"
envvars_marker = "__VLLM_EXTRA_ENVVARS__"
tier1_marker = "__TIER1_ENVVARS__"
# Rewrite the top-level spec.modelName only (2-space indent), leaving deeper
# keys such as huggingFaceModel.modelId untouched.
name_re = re.compile(r"^(  modelName:\s*).*$")
out = []
for line in sys.stdin.read().splitlines():
    pos = line.find(marker)
    epos = line.find(envvars_marker)
    tpos = line.find(tier1_marker)
    if pos >= 0:
        indent = line[:pos]
        for rl in repl.splitlines():
            out.append(indent + rl)
    elif tpos >= 0:
        # ADR-010: splice the manifest-DERIVED Tier-1 env block (model / TP /
        # LoRA-companion contract for the ACTIVE engine) at the marker indent.
        # When empty (resolver unavailable) drop the marker so the YAML list
        # stays well-formed.
        indent = line[:tpos]
        for rl in tier1_envvars.splitlines():
            if rl.strip():
                out.append(indent + rl)
    elif epos >= 0:
        # Splice Tier-2 prefix pass-through env vars at the marker indentation.
        # When there are none, drop the marker line entirely so the YAML list
        # stays well-formed.
        indent = line[:epos]
        for rl in extra_envvars.splitlines():
            if rl.strip():
                out.append(indent + rl)
    elif name_override and name_re.match(line):
        out.append("  modelName: \"%s\"" % name_override)
    else:
        out.append(line)

# Wave 11 (do/add-pod): name / location / role / group overrides. Each one must
# match EXACTLY once, or the template drifted and the render refuses (exit 3).
def _one(pattern, label):
    hits = [i for i, l in enumerate(out) if re.match(pattern, l)]
    if len(hits) != 1:
        sys.stderr.write("render: expected exactly one %s line, found %d\n" % (label, len(hits)))
        sys.exit(3)
    return hits[0]
iec_name = os.environ.get("HP_IEC_NAME", "")
if iec_name and any(l.startswith("kind: InferenceEndpointConfig") for l in out):
    i = _one(r"^  name:\s*\S", "metadata.name")
    out[i] = "  name: %s" % iec_name
    i = _one(r"^  endpointName:\s*", "spec.endpointName")
    out[i] = "  endpointName: \"%s\"" % iec_name
    i = _one(r"^    app:\s*\S", "metadata.labels.app")
    out[i] = "    app: %s" % iec_name
    location = os.environ.get("HP_MODEL_LOCATION", "")
    if location:
        i = _one(r"^\s+modelLocation:\s*", "modelLocation")
        indent = out[i][:len(out[i]) - len(out[i].lstrip())]
        out[i] = "%smodelLocation: %s" % (indent, location)
    role = os.environ.get("HP_IEC_ROLE", "")
    if role:
        i = _one(r"^  labels:\s*$", "metadata.labels")
        out[i + 1:i + 1] = ["    mlcc.aws/project-name: \"%s\"" % os.environ.get("HP_IEC_PROJECT", ""),
                            "    mlcc.aws/role: \"%s\"" % role]
    replicas = os.environ.get("HP_IEC_REPLICAS", "")
    if replicas:
        i = _one(r"^  replicas:\s*", "spec.replicas")
        out[i] = "  replicas: %s" % replicas
    group = os.environ.get("HP_IEC_NODE_GROUP", "")
    if group:
        i = _one(r"^  instanceType:\s*", "spec.instanceType")
        out[i:i + 1] = [
            "  nodeAffinity:",
            "    requiredDuringSchedulingIgnoredDuringExecution:",
            "      nodeSelectorTerms:",
            "        - matchExpressions:",
            "            - key: sagemaker.amazonaws.com/instance-group-name",
            "              operator: In",
            "              values: [\"%s\"]" % group,
        ]
sys.stdout.write("\n".join(out) + "\n")
') || return 3
        if echo "${RENDERED}" | grep -q '^kind:'; then
            _HP_RENDER_N=$((_HP_RENDER_N + 1))
            printf '%s\n' "${RENDERED}" > "${_out_dir}/$(printf '%03d' "${_HP_RENDER_N}")-$(basename "${manifest}")"
        fi
    done
}
