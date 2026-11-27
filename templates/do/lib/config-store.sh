#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# config-store.sh — the ONE writer for `export KEY="value"` state files
# (do/config and the per-IC config files).
#
# PATTERN: shared helper of the do/ script contract (ADR-007).
# COLLABORATORS: sourced by lib/script-contract.sh (so every do/ script has it)
#   and self-sourced by libs designed to work without the contract
#   (lib/scale-to-zero.sh, lib/wait.sh, lib/resolve-instance.sh). The per-script
#   wrappers (_update_config, _update_config_var, _update_benchmark_var,
#   _stz_write_config, …) delegate here.
# DATA FLOW: runtime state → do/config; read back by `source do/config`, and
#   preserved across `mcc regenerate` for runtime-owned vars.
# See: docs/do-script-contract.md ("Writing state back to do/config").
#
# Replaces eight hand-rolled `sed -i "s|^export K=.*|…|"` copies that put values
# into the sed replacement unescaped (a `|`, `&`, `\` or `"` corrupted do/config)
# and mostly glued a new export onto a last line lacking a trailing newline. It:
#   - validates the key (shell identifier) and rejects multi-line values,
#   - escapes the value for a double-quoted bash string (\ " $ `),
#   - replaces the first `export KEY=` line and drops duplicates, else appends,
#   - always leaves the file newline-terminated,
#   - writes via temp file + mv (atomic; carries the file mode).
#
# Side-effect free when sourced (defines functions only). Bash 3.2 compatible.

# _config_set KEY VALUE [FILE]
#   FILE defaults to ${SCRIPT_DIR}/config. Creates FILE if it does not exist.
_config_set() {
    local key="$1" value="${2-}" file="${3:-${SCRIPT_DIR:-.}/config}"
    _config_valid_key "$key" || return 1
    case "$value" in
        *$'\n'*)
            echo "❌ _config_set: value for ${key} contains a newline (refusing to write ${file})" >&2
            return 1
            ;;
    esac
    local escaped
    escaped=$(printf '%s' "$value" | sed -e 's/[\\"$`]/\\&/g')
    _config_rewrite "$key" "export ${key}=\"${escaped}\"" "$file"
}

# _config_unset KEY [FILE]
#   Remove every `export KEY=` line. A missing FILE is not an error.
_config_unset() {
    local key="$1" file="${2:-${SCRIPT_DIR:-.}/config}"
    _config_valid_key "$key" || return 1
    [ -f "$file" ] || return 0
    _config_rewrite "$key" "" "$file"
}

# ── internals ──────────────────────────────────────────────────────────────

_config_valid_key() {
    case "$1" in
        ''|[0-9]*|*[!A-Za-z0-9_]*)
            echo "❌ config-store: invalid variable name '$1'" >&2
            return 1
            ;;
    esac
    return 0
}

# _config_rewrite KEY LINE FILE — replace (or, with empty LINE, delete) the
# `export KEY=` lines; append LINE when KEY was absent. Values travel through
# ENVIRON, not awk -v, so backslashes are not re-interpreted.
_config_rewrite() {
    local key="$1" line="$2" file="$3" tmp
    tmp=$(mktemp "${file}.XXXXXX") || {
        echo "❌ config-store: cannot create a temp file next to ${file}" >&2
        return 1
    }
    if [ -f "$file" ]; then
        cp -p "$file" "$tmp" 2>/dev/null || true   # best effort: carry the file mode
        if ! MLCC_CFG_KEY="$key" MLCC_CFG_LINE="$line" awk '
            BEGIN { k = ENVIRON["MLCC_CFG_KEY"]; l = ENVIRON["MLCC_CFG_LINE"]; done = 0 }
            index($0, "export " k "=") == 1 {
                if (!done && l != "") print l
                done = 1
                next
            }
            { print }
            END { if (!done && l != "") print l }
        ' "$file" > "$tmp"; then
            rm -f "$tmp"
            echo "❌ config-store: failed to rewrite ${file}" >&2
            return 1
        fi
    elif [ -n "$line" ]; then
        printf '%s\n' "$line" > "$tmp"
    else
        rm -f "$tmp"
        return 0
    fi
    mv -f "$tmp" "$file"
}
