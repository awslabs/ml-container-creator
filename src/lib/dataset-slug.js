// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dataset Slug Derivation
 *
 * Derives a deterministic, short slug from a dataset URI for use in
 * tuning-job-aware adapter naming conventions.
 *
 * Slugification rules:
 * - Lowercase
 * - Strip non-alphanumeric characters (keep hyphens)
 * - Truncate to 20 characters
 * - Replace consecutive hyphens with single hyphen
 * - Strip leading/trailing hyphens
 *
 * Examples:
 *   hf://org/name           -> "name"
 *   hf://tatsu-lab/alpaca   -> "alpaca"
 *   hf://Open-Orca/OpenOrca -> "openorca"
 *   s3://bucket/path/file.jsonl -> "file"
 *
 * Requirements: US-4 (AC-4.2)
 */

/**
 * Derive a dataset slug from a dataset URI.
 *
 * @param {string} datasetUri - Dataset URI (s3://... or hf://...)
 * @returns {string} The derived slug, or empty string if extraction fails
 */
export function deriveDatasetSlug(datasetUri) {
    if (!datasetUri || typeof datasetUri !== 'string') {
        return '';
    }

    let rawName = '';

    if (datasetUri.startsWith('hf://')) {
        // hf://org/name[/split][?file=pattern]
        // Extract the dataset name (second path component)
        const hfPath = datasetUri.slice(5); // remove "hf://"
        const withoutQuery = hfPath.split('?')[0]; // remove ?file=...
        const parts = withoutQuery.split('/');
        // parts[0] = org, parts[1] = name, parts[2+] = split
        rawName = parts[1] || parts[0] || '';
    } else if (datasetUri.startsWith('s3://')) {
        // s3://bucket/path/file.jsonl -> slug from filename (without extension)
        const s3Path = datasetUri.slice(5); // remove "s3://"
        const parts = s3Path.split('/');
        const filename = parts[parts.length - 1] || '';
        // Remove file extension
        const dotIndex = filename.lastIndexOf('.');
        rawName = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
    } else {
        // Unknown format — try to extract last path component
        const parts = datasetUri.split('/');
        rawName = parts[parts.length - 1] || '';
    }

    return slugify(rawName);
}

/**
 * Apply slugification rules to a raw name.
 *
 * @param {string} raw - Raw name to slugify
 * @returns {string} Slugified string
 */
export function slugify(raw) {
    if (!raw) return '';

    let slug = raw
        .toLowerCase()                      // lowercase
        .replace(/[^a-z0-9-]/g, '')         // strip non-alphanumeric (keep hyphens)
        .replace(/-{2,}/g, '-')             // replace consecutive hyphens
        .replace(/^-+/, '')                 // strip leading hyphens
        .replace(/-+$/, '');                // strip trailing hyphens

    // Truncate to 20 chars
    if (slug.length > 20) {
        slug = slug.substring(0, 20);
        // Don't end on a hyphen after truncation
        slug = slug.replace(/-+$/, '');
    }

    return slug;
}

/**
 * Resolve a --from-tune argument to the appropriate config variable name.
 *
 * Resolution rules:
 * - No arg (empty/null) -> TUNE_OUTPUT_PATH_LATEST
 * - technique only (e.g., "sft") -> TUNE_ADAPTER_PATH_SFT
 * - technique-dataset compound (e.g., "sft-alpaca") -> TUNE_ADAPTER_PATH_SFT_ALPACA
 *
 * @param {string} fromTuneArg - The --from-tune argument value
 * @param {function} configVarExists - Function that checks if a config var exists
 * @returns {{ varName: string, technique: string, slug: string, isCompound: boolean, fallback: string|null }}
 */
export function resolveFromTuneVar(fromTuneArg, configVarExists) {
    if (!fromTuneArg) {
        return {
            varName: 'TUNE_OUTPUT_PATH_LATEST',
            technique: '',
            slug: '',
            isCompound: false,
            fallback: null
        };
    }

    const upper = fromTuneArg.toUpperCase();

    // Check if argument contains a hyphen — potential compound key
    const hyphenIndex = fromTuneArg.indexOf('-');
    if (hyphenIndex > 0) {
        const technique = fromTuneArg.substring(0, hyphenIndex);
        const slug = fromTuneArg.substring(hyphenIndex + 1);
        const techniqueUpper = technique.toUpperCase();
        const slugUpper = slug.toUpperCase().replace(/-/g, '_');
        const compoundVar = `TUNE_ADAPTER_PATH_${techniqueUpper}_${slugUpper}`;

        if (configVarExists(compoundVar)) {
            return {
                varName: compoundVar,
                technique,
                slug,
                isCompound: true,
                fallback: null
            };
        }

        // Compound key doesn't exist — fallback to technique-only
        return {
            varName: `TUNE_ADAPTER_PATH_${techniqueUpper}`,
            technique,
            slug,
            isCompound: false,
            fallback: compoundVar // the compound var that was tried but didn't exist
        };
    }

    // No hyphen — technique-only
    return {
        varName: `TUNE_ADAPTER_PATH_${upper}`,
        technique: fromTuneArg,
        slug: '',
        isCompound: false,
        fallback: null
    };
}
