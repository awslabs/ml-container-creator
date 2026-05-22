#!/usr/bin/env node
/**
 * codegen-widget.js — Generates docs/data/cli-manifest.json from parameter-schema-v2.json
 *
 * Replaces the extraction logic in sync-command-generator.js with schema-driven generation.
 * The widget reads this manifest to render form fields.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'parameter-schema-v2.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const outDir = path.join(ROOT, 'docs', 'data');
fs.mkdirSync(outDir, { recursive: true });

// Build widget sections from schema
const sections = {};
for (const [key, param] of Object.entries(schema.parameters)) {
    if (!param.widget) continue;
    const section = param.widget.section;
    if (!sections[section]) sections[section] = [];
    sections[section].push({
        key,
        cliFlag: param.cliFlag,
        type: param.type,
        description: param.description,
        inputType: param.widget.inputType,
        placeholder: param.widget.placeholder || null,
        datalist: param.widget.datalist || null,
        default: param.default,
        validation: param.validation || null,
        group: param.group,
        appliesTo: param.appliesTo
    });
}

// Build full manifest
const manifest = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/codegen-widget.js',
    source: 'config/parameter-schema-v2.json',
    version: pkg.version,
    schemaVersion: schema.schemaVersion,
    widgetSections: sections,
    allParameters: Object.entries(schema.parameters).map(([key, p]) => ({
        key,
        cliFlag: p.cliFlag,
        description: p.description,
        type: p.type,
        group: p.group,
        phase: p.phase,
        deprecated: p.deprecated || false,
        hasWidget: !!p.widget
    })),
    deploymentConfigs: schema.parameters.deploymentConfig?.validation?.enum || [],
    deploymentTargets: schema.parameters.deploymentTarget?.validation?.enum || []
};

fs.writeFileSync(path.join(outDir, 'schema-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✅ Generated docs/data/schema-manifest.json`);
console.log(`   Widget sections: ${Object.keys(sections).length} (${Object.values(sections).flat().length} fields)`);
console.log(`   Total parameters: ${manifest.allParameters.length}`);
console.log(`   Deprecated: ${manifest.allParameters.filter(p => p.deprecated).length}`);
