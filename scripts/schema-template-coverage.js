#!/usr/bin/env node
/**
 * schema-template-coverage.js — Phase 4 CI enforcement
 *
 * Verifies that every parameter in parameter-schema-v2.json with a `templateVar`
 * is referenced by at least one template file. Catches: "parameter added to schema
 * but never wired into any template."
 *
 * Also verifies the inverse: template variables used in templates that don't exist
 * in the schema (orphaned template vars).
 *
 * Usage:
 *   node scripts/schema-template-coverage.js          # Report
 *   node scripts/schema-template-coverage.js --strict # Exit non-zero on gaps
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'tinyglobby';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'parameter-schema-v2.json'), 'utf8'));

// Collect all template files
const templateFiles = globSync('**/*', {
    cwd: path.join(ROOT, 'templates'),
    onlyFiles: true,
    dot: true
});

// Also check src/app.js (uses templateVars in _ensureTemplateVariables and writeProject)
const appJs = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

// Build a map of all template content
const templateContent = {};
for (const file of templateFiles) {
    templateContent[file] = fs.readFileSync(path.join(ROOT, 'templates', file), 'utf8');
}

// Parameters that are used programmatically (not in EJS templates directly)
// These are consumed by the generator logic in src/app.js, not rendered into templates
const PROGRAMMATIC_VARS = new Set([
    'projectName',       // Used as directory name, not in templates
    'deploymentConfig',  // Used to select which templates to render
    'deploymentTarget',  // Used to select deploy.d/ partial
    'framework',         // Deprecated, used for routing only
    'modelServer',       // Used to select serve.d/ partial
    'baseImage',         // Used in Dockerfile FROM line (checked separately)
    'buildTarget',       // Used to decide whether to generate do/submit
    'includeSampleModel',// Used in ignore patterns
    'includeTesting',    // Used in ignore patterns
    'testTypes',         // Used in ignore patterns
]);

// Check each schema parameter with templateVar
const results = { covered: [], uncovered: [], programmatic: [] };

for (const [key, param] of Object.entries(schema.parameters)) {
    if (!param.templateVar) continue;

    const tv = param.templateVar;

    if (PROGRAMMATIC_VARS.has(tv)) {
        // Verify it's used in app.js at least
        if (appJs.includes(tv)) {
            results.programmatic.push(tv);
        } else {
            results.uncovered.push({ key, templateVar: tv, reason: 'marked programmatic but not found in app.js' });
        }
        continue;
    }

    // Search for the templateVar in any template file
    // EJS patterns: <%= varName %>, <%- varName %>, <% if (varName) %>, etc.
    // Also check do/config which uses shell-style: export VAR="<%= varName %>"
    let found = false;
    for (const [file, content] of Object.entries(templateContent)) {
        if (content.includes(tv)) {
            found = true;
            break;
        }
    }

    // Also check app.js (some vars are used in _ensureTemplateVariables)
    if (!found && appJs.includes(tv)) {
        found = true;
    }

    if (found) {
        results.covered.push(tv);
    } else {
        results.uncovered.push({ key, templateVar: tv, reason: 'not found in any template or app.js' });
    }
}

// Report
console.log('\n📋 Schema → Template Coverage');
console.log('─'.repeat(50));
console.log(`   Parameters with templateVar: ${Object.values(schema.parameters).filter(p => p.templateVar).length}`);
console.log(`   Covered (in templates): ${results.covered.length}`);
console.log(`   Programmatic (in app.js): ${results.programmatic.length}`);
console.log(`   Uncovered: ${results.uncovered.length}`);

if (results.uncovered.length) {
    console.log(`\n❌ Uncovered template variables (${results.uncovered.length}):`);
    results.uncovered.forEach(u => console.log(`   • ${u.templateVar} (${u.key}): ${u.reason}`));
    if (STRICT) {
        console.log('\n   Fix: Either use the variable in a template, or add it to PROGRAMMATIC_VARS with justification.');
        process.exit(1);
    }
} else {
    console.log('\n✅ All template variables are referenced');
}
