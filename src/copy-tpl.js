// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import ejs from 'ejs';
import { globSync } from 'tinyglobby';
import fs from 'fs';
import path from 'path';

/**
 * Binary file extensions that should be copied without EJS rendering.
 */
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.tiff', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.zip', '.tar', '.gz', '.bz2', '.7z',
    '.pdf',
    '.exe', '.dll', '.so', '.dylib',
    '.pyc', '.pyo', '.class', '.jar', '.war', '.ear'
]);

/**
 * Determines whether a file is binary based on its extension.
 *
 * @param {string} filePath - Path to the file
 * @returns {boolean} True if the file has a known binary extension
 */
function isBinaryFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/**
 * Copies template files from a source directory to a destination directory,
 * rendering EJS templates with the provided variables.
 *
 * Binary files (identified by extension) are copied without EJS rendering.
 * Directories are created as needed.
 *
 * @param {string} templateDir - Source directory containing template files
 * @param {string} destDir - Destination directory for rendered output
 * @param {object} vars - Variables to pass to EJS templates
 * @param {string[]} [ignorePatterns=[]] - Glob patterns for files to exclude
 */
export function copyTpl(templateDir, destDir, vars, ignorePatterns = []) {
    const files = globSync('**/*', {
        cwd: templateDir,
        ignore: ignorePatterns,
        dot: true,
        onlyFiles: true
    });

    for (const file of files) {
        const src = path.join(templateDir, file);
        const dest = path.join(destDir, file);

        fs.mkdirSync(path.dirname(dest), { recursive: true });

        if (isBinaryFile(file)) {
            fs.copyFileSync(src, dest);
            continue;
        }

        const content = fs.readFileSync(src, 'utf8');

        let rendered;
        try {
            rendered = ejs.render(content, vars, { filename: src });
        } catch (err) {
            const line = err.line ? ` (line ${err.line})` : '';
            throw new Error(
                `EJS rendering failed for "${file}"${line}: ${err.message}`
            );
        }

        fs.writeFileSync(dest, rendered);
    }
}
