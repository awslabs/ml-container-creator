// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * PATTERN: Shared pure helper (single source of truth) — the one implementation
 *   of accelerator version compatibility ("major must match, minor must be >=").
 *   Every accelerator that versions this way derives from here instead of
 *   re-inlining the split/compare (ADR-006 / .kiro/steering/derive-dont-hardcode.md).
 * COLLABORATORS: used by SemverAcceleratorValidator (neuron, rocm) and by
 *   CudaValidator (which keeps its own distinct message + major.minor semantics
 *   but shares this comparison rather than re-implementing it).
 * DATA-FLOW ROLE: collapses the last copy of the version-compare logic (cuda had
 *   inlined it) into one tested place; each accelerator still owns its own label
 *   and mismatch guidance.
 * See: docs/architecture/validation.md, docs/adr/ADR-006-unified-validation-framework.md
 */

/**
 * Parse a dotted version string into numeric components. Missing segments are
 * `undefined` (e.g. "12.1" → { major: 12, minor: 1, patch: undefined }); the
 * compatibility rule below only reads major/minor, so a 2- or 3-segment version
 * compares identically.
 * @param {string} versionString - e.g. "12.1" or "2.15.0"
 * @returns {{ major: number, minor: number, patch: number|undefined }}
 */
export function parseAcceleratorVersion(versionString) {
    const [major, minor, patch] = versionString.split('.').map(Number);
    return { major, minor, patch };
}

/**
 * Compatibility rule shared by every semver-style accelerator: the provided
 * version's major must equal the required major, and its minor must be >= the
 * required minor.
 * @param {{ major: number, minor: number }} required - parsed required version
 * @param {{ major: number, minor: number }} provided - parsed provided version
 * @returns {boolean}
 */
export function isMajorMinorCompatible(required, provided) {
    return provided.major === required.major &&
        provided.minor >= required.minor;
}

/**
 * Return the provided version strings compatible with the required version under
 * the major-match/minor->= rule, in input order.
 * @param {string} requiredVersion - required version string
 * @param {Array<string>} providedVersions - candidate version strings
 * @returns {Array<string>} the subset of providedVersions that are compatible
 */
export function compatibleVersions(requiredVersion, providedVersions) {
    const required = parseAcceleratorVersion(requiredVersion);
    return (providedVersions || []).filter(v =>
        isMajorMinorCompatible(required, parseAcceleratorVersion(v))
    );
}
