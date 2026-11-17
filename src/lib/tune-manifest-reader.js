// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tune-Descriptor Reader (generation-time, Node side of BL129).
 *
 * Reads the per-technique tune descriptors at
 * templates/code/tune.d/<technique>/manifest.json as DATA, so the generator, the
 * do/tune config builder (BL128), and the register-side producer read technique
 * knowledge from the descriptor instead of a hardcoded per-technique table
 * (ADR-008: derive, don't hardcode). This is the generation-time counterpart of
 * templates/do/lib/python/tune_manifest.py (the runtime reader the do/tune
 * preflight uses); both read the SAME manifest files so the contract has a single
 * source of truth.
 *
 * Mirrors src/lib/serve-manifest-reader.js. Every getter is a pure data read that
 * NEVER branches on the technique name and NEVER throws — a missing/malformed
 * descriptor yields null/[]/{} so a caller can fail open.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');
const TUNE_D = path.join(GENERATOR_ROOT, 'templates', 'code', 'tune.d');

/** Read + parse a technique's manifest, or null when missing/unreadable. */
function readManifest(technique, tuneDir = TUNE_D) {
    if (!technique) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(tuneDir, technique, 'manifest.json'), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * List the technique names that have a descriptor, sorted.
 *
 * @param {string} [tuneDir] - Optional override for the tune.d root (tests).
 * @returns {string[]} Technique dir names (e.g. ['dpo', 'mtrl', 'rlaif', 'rlvr', 'sft']).
 */
export function listTuneTechniques(tuneDir = TUNE_D) {
    let entries;
    try {
        entries = fs.readdirSync(tuneDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isDirectory()
            && fs.existsSync(path.join(tuneDir, e.name, 'manifest.json')))
        .map(e => e.name)
        .sort();
}

/**
 * The reward_source for a technique (none|rule|preset|judge|agent_env), or null
 * when the technique has no descriptor.
 *
 * @param {string} technique
 * @param {string} [tuneDir]
 * @returns {string|null}
 */
export function rewardSource(technique, tuneDir = TUNE_D) {
    const m = readManifest(technique, tuneDir);
    return (m && typeof m.reward_source === 'string') ? m.reward_source : null;
}

/**
 * The variant keys declared for a technique (e.g. ['lora', 'full'] or ['lora']),
 * sorted; [] when the technique has no descriptor.
 *
 * @param {string} technique
 * @param {string} [tuneDir]
 * @returns {string[]}
 */
export function listVariants(technique, tuneDir = TUNE_D) {
    const m = readManifest(technique, tuneDir);
    if (!m || !m.variants || typeof m.variants !== 'object') return [];
    return Object.keys(m.variants).sort();
}

// do/tune's `--training-type` CLI values (and the tune catalog's trainingTypes)
// speak `lora` / `full-rank`, but the descriptor keys PEFT variants as `lora` /
// `full`. Normalize the alias so `full-rank` resolves the `full` variant instead of
// missing (returning null → empty capability/HP data). Mirrors the Python reader's
// `_VARIANT_ALIASES` in tune_manifest.py (kept in parity per derive-dont-hardcode).
const VARIANT_ALIASES = { 'full-rank': 'full', full_rank: 'full' };

/** Resolve a variant object, defaulting to the sole/`lora` variant when unspecified. */
function resolveVariant(manifest, variant) {
    if (!manifest || !manifest.variants || typeof manifest.variants !== 'object') return null;
    const variants = manifest.variants;
    if (variant) {
        const key = VARIANT_ALIASES[variant] || variant;
        return variants[key] || null;
    }
    // No variant requested: prefer 'lora', else the first declared.
    if (variants.lora) return variants.lora;
    const keys = Object.keys(variants);
    return keys.length ? variants[keys[0]] : null;
}

/**
 * The dataset_contract for a technique+variant, or null when absent. Carries
 * `format`, `schema`, `prompt_shape`, `verified`, and (verl-5field only)
 * `reward_model_style`.
 *
 * @param {string} technique
 * @param {string} [variant] - 'lora' | 'full'; omit for the default variant.
 * @param {string} [tuneDir]
 * @returns {object|null}
 */
export function readDatasetContract(technique, variant = null, tuneDir = TUNE_D) {
    const v = resolveVariant(readManifest(technique, tuneDir), variant);
    return (v && v.dataset_contract && typeof v.dataset_contract === 'object')
        ? v.dataset_contract
        : null;
}

/**
 * The synced hyperparameters map for a technique+variant (knob name → entry), or
 * {} when absent (e.g. a pre-sync descriptor).
 *
 * @param {string} technique
 * @param {string} [variant]
 * @param {string} [tuneDir]
 * @returns {Object<string, object>}
 */
export function readHyperparameters(technique, variant = null, tuneDir = TUNE_D) {
    const v = resolveVariant(readManifest(technique, tuneDir), variant);
    return (v && v.hyperparameters && typeof v.hyperparameters === 'object')
        ? v.hyperparameters
        : {};
}

/**
 * The artifact_kind for a technique+variant (lora_adapter|full_model), or null
 * when absent. DERIVED from `peft` and schema-enforced at author time; read here
 * for the later three-way deploy split (BL136/BL137/BL149).
 *
 * @param {string} technique
 * @param {string} [variant]
 * @param {string} [tuneDir]
 * @returns {string|null}
 */
export function artifactKind(technique, variant = null, tuneDir = TUNE_D) {
    const v = resolveVariant(readManifest(technique, tuneDir), variant);
    return (v && typeof v.artifact_kind === 'string') ? v.artifact_kind : null;
}
