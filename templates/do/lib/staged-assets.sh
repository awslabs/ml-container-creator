# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helper: read/write the .mlcc/staged-assets.json tracking file.
# Sourced by do/stage, do/submit, and other lifecycle scripts.
#
# ─── Schema (.mlcc/staged-assets.json) ───────────────────────────────────────
#
# {
#   "version": "1",
#   "models": {
#     "<ic-name>": {
#       "source":     "<HuggingFace model ID, e.g. google/gemma-4-31B-it>",
#       "staged_uri": "<S3 URI with trailing slash>",
#       "staged_at":  "<ISO 8601 timestamp>",
#       "region":     "<AWS region where the model was staged>",
#       "size_gb":    <numeric size in GB>
#     }
#   },
#   "adapters": {}
# }
#
# Notes:
#   - "version" is for forward-compatible schema evolution (start at "1")
#   - "models" is keyed by IC name; use "default" for single-model projects
#   - "adapters" is reserved for future LoRA adapter staging (BL-122)
#   - This file is git-ignored (.mlcc/ contains account-specific URIs)
#   - The file SHALL NOT be created unless a valid staging operation completes
# ──────────────────────────────────────────────────────────────────────────────

# Path to the staged-assets file (relative to project root)
STAGED_ASSETS_DIR=".mlcc"
STAGED_ASSETS_FILE="${STAGED_ASSETS_DIR}/staged-assets.json"

# _staged_assets_has_jq()
#   Check if jq is available on the system.
#   Returns 0 if available, 1 if not.
_staged_assets_has_jq() {
    command -v jq &>/dev/null
}

# _staged_assets_warn_no_jq()
#   Print a one-time warning when jq is not available.
_staged_assets_warn_no_jq() {
    if [ -z "${_STAGED_ASSETS_JQ_WARNED:-}" ]; then
        echo "⚠️  jq not found — using fallback parser (install jq for full functionality)" >&2
        _STAGED_ASSETS_JQ_WARNED=1
    fi
}

# staged_assets_read_model_uri()
#   Read the staged S3 URI for the default model from the staged-assets file.
#   Echoes the S3 URI if found, or an empty string if not available.
#
#   Uses jq when available; falls back to grep/sed extraction.
#
#   Arguments: none
#   Output:    S3 URI string (stdout) or empty string
staged_assets_read_model_uri() {
    local uri=""

    # No file → empty string
    if [ ! -f "${STAGED_ASSETS_FILE}" ]; then
        echo ""
        return 0
    fi

    if _staged_assets_has_jq; then
        uri=$(jq -r '.models.default.staged_uri // empty' "${STAGED_ASSETS_FILE}" 2>/dev/null) || uri=""
    else
        _staged_assets_warn_no_jq
        # Fallback: grep/sed extraction for the staged_uri field within the default model block
        # This handles the common single-model case reliably
        uri=$(grep -A 5 '"default"' "${STAGED_ASSETS_FILE}" 2>/dev/null \
            | grep '"staged_uri"' \
            | sed 's/.*"staged_uri"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' \
            | head -1) || uri=""
    fi

    echo "${uri}"
}

# staged_assets_write_model()
#   Create or update the staged-assets file with model staging information.
#   Creates the .mlcc directory if it does not exist.
#
#   Arguments:
#     $1 - source:   HuggingFace model ID (e.g. "google/gemma-4-31B-it")
#     $2 - uri:      S3 URI where the model was staged (with trailing slash)
#     $3 - region:   AWS region where the model was staged
#     $4 - size_gb:  Total size of the staged model in GB (numeric)
staged_assets_write_model() {
    local source="$1"
    local uri="$2"
    local region="$3"
    local size_gb="$4"
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Ensure the .mlcc directory exists
    mkdir -p "${STAGED_ASSETS_DIR}"

    if _staged_assets_has_jq; then
        if [ -f "${STAGED_ASSETS_FILE}" ]; then
            # Update existing file — merge the new model entry
            local tmp_file="${STAGED_ASSETS_FILE}.tmp"
            jq --arg source "${source}" \
               --arg uri "${uri}" \
               --arg ts "${timestamp}" \
               --arg region "${region}" \
               --argjson size "${size_gb}" \
               '.models.default = {
                   "source": $source,
                   "staged_uri": $uri,
                   "staged_at": $ts,
                   "region": $region,
                   "size_gb": $size
               }' "${STAGED_ASSETS_FILE}" > "${tmp_file}" && mv "${tmp_file}" "${STAGED_ASSETS_FILE}"
        else
            # Create new file from scratch
            jq -n --arg source "${source}" \
                  --arg uri "${uri}" \
                  --arg ts "${timestamp}" \
                  --arg region "${region}" \
                  --argjson size "${size_gb}" \
                  '{
                      "version": "1",
                      "models": {
                          "default": {
                              "source": $source,
                              "staged_uri": $uri,
                              "staged_at": $ts,
                              "region": $region,
                              "size_gb": $size
                          }
                      },
                      "adapters": {}
                  }' > "${STAGED_ASSETS_FILE}"
        fi
    else
        _staged_assets_warn_no_jq
        # Fallback: write the JSON directly (create-only, no merge support without jq)
        cat > "${STAGED_ASSETS_FILE}" << EOF
{
  "version": "1",
  "models": {
    "default": {
      "source": "${source}",
      "staged_uri": "${uri}",
      "staged_at": "${timestamp}",
      "region": "${region}",
      "size_gb": ${size_gb}
    }
  },
  "adapters": {}
}
EOF
    fi
}

# staged_assets_status()
#   Print a human-readable table of all staged assets.
#   Shows models and adapters with their source, URI, region, size, and timestamp.
#
#   Arguments: none
#   Output:    formatted table to stdout
staged_assets_status() {
    if [ ! -f "${STAGED_ASSETS_FILE}" ]; then
        echo "No staged assets found."
        echo "  Run do/stage to stage model weights to S3."
        return 0
    fi

    echo "Staged Assets (.mlcc/staged-assets.json)"
    echo "─────────────────────────────────────────────────────────────────"

    if _staged_assets_has_jq; then
        # Print models section
        local model_count
        model_count=$(jq -r '.models | length' "${STAGED_ASSETS_FILE}" 2>/dev/null) || model_count=0

        if [ "${model_count}" -gt 0 ]; then
            echo ""
            echo "  Models:"
            echo "  ┌──────────────┬─────────────────────────────────┬──────────────────────────────────────────────────────┬────────────┬─────────┐"
            printf "  │ %-12s │ %-31s │ %-52s │ %-10s │ %-7s │\n" "IC Name" "Source" "S3 URI" "Region" "Size"
            echo "  ├──────────────┼─────────────────────────────────┼──────────────────────────────────────────────────────┼────────────┼─────────┤"

            jq -r '.models | to_entries[] | "\(.key)\t\(.value.source)\t\(.value.staged_uri)\t\(.value.region)\t\(.value.size_gb)"' "${STAGED_ASSETS_FILE}" 2>/dev/null | \
            while IFS=$'\t' read -r ic_name source staged_uri region size_gb; do
                printf "  │ %-12s │ %-31s │ %-52s │ %-10s │ %5s GB│\n" \
                    "${ic_name}" "${source}" "${staged_uri}" "${region}" "${size_gb}"
            done

            echo "  └──────────────┴─────────────────────────────────┴──────────────────────────────────────────────────────┴────────────┴─────────┘"
        fi

        # Print adapters section (future — show placeholder if empty)
        local adapter_count
        adapter_count=$(jq -r '.adapters | length' "${STAGED_ASSETS_FILE}" 2>/dev/null) || adapter_count=0

        if [ "${adapter_count}" -gt 0 ]; then
            echo ""
            echo "  Adapters:"
            jq -r '.adapters | to_entries[] | "    \(.key): \(.value.staged_uri // "not staged")"' "${STAGED_ASSETS_FILE}" 2>/dev/null
        fi
    else
        _staged_assets_warn_no_jq
        # Fallback: basic display without jq
        echo ""
        echo "  Raw contents:"
        echo ""
        cat "${STAGED_ASSETS_FILE}"
    fi

    echo ""
}
