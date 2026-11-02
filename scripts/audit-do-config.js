#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * audit-do-config.js — classifies every export in templates/do/config against
 * config/parameter-schema-v2.json (Wave 8 R7, OQ-8.5 / OQ-8.6).
 *
 * Every do/config var is exactly one of:
 *   user-input    a schema parameter declares it as `doConfigVar` (or it belongs to
 *                 an env-map parameter's `doConfigVarPrefix` family)
 *   secret        the claiming parameter is `sensitive` (exported as a $VAR reference)
 *   runtime-owned in the SAME sources `mcc regenerate` preserves: RUNTIME_OWNED_VARS
 *                 (targets.d runtime_owned_vars + serve.d dimension_map +
 *                 SHARED_RUNTIME_VARS) or an engine env-var prefix — no new list
 *   derived       declared in the schema's top-level `doConfig.derived` with a reason
 *
 * auditDoConfig() is pure (inputs passed in) so the drift test
 * (test/unit/do-config-schema-mapping.test.js) can also feed it synthetic drift.
 *
 * Usage: node scripts/audit-do-config.js [--markdown]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const DO_CONFIG_TEMPLATE = path.join(ROOT, 'templates', 'do', 'config');
export const SCHEMA_PATH = path.join(ROOT, 'config', 'parameter-schema-v2.json');

const STATIC_EXPORT = /^\s*(#\s*)?export\s+([A-Z_][A-Z0-9_]*)=/;
const COMMENTED_ASSIGN = /^#\s*([A-Z_][A-Z0-9_]*)=""/;
const DYNAMIC_EXPORT = /^\s*export\s+([A-Z_]*)<%=\s*\w+\s*%>=/;
const LOOP_SOURCE = /(?:Object\.(?:entries|keys)\((\w+)\)|(\w+)\.forEach)/;
const CONTROL_LINE = /^\s*<%(?!=|-)/;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse the do/config template into export occurrences.
 * @param {string} text - template source
 * @returns {{statics: Array, dynamics: Array}}
 */
export function parseTemplate(text) {
    const lines = text.split('\n');
    const statics = [];
    const dynamics = [];
    let lastControl = '';
    lines.forEach((line, idx) => {
        if (CONTROL_LINE.test(line)) {
            lastControl = line;
            return;
        }
        const dyn = line.match(DYNAMIC_EXPORT);
        if (dyn) {
            // The loop that feeds this export is the nearest preceding EJS loop.
            let source = null;
            for (let j = idx - 1; j >= 0 && source === null; j--) {
                const m = lines[j].match(LOOP_SOURCE);
                if (m && CONTROL_LINE.test(lines[j])) source = m[1] || m[2];
            }
            dynamics.push({ line: idx + 1, prefix: dyn[1], source, text: line });
            return;
        }
        const st = line.match(STATIC_EXPORT);
        if (st) {
            statics.push({ line: idx + 1, name: st[2], active: !st[1], text: line, control: lastControl });
            return;
        }
        const ca = line.match(COMMENTED_ASSIGN);
        if (ca) statics.push({ line: idx + 1, name: ca[1], active: false, text: line, control: lastControl });
    });
    return { statics, dynamics };
}

/**
 * Classify every do/config export and collect drift errors.
 * @param {object} args
 * @param {string} args.templateText - templates/do/config source
 * @param {object} args.schema - parsed parameter-schema-v2.json
 * @param {Set<string>} args.runtimeOwned - regenerate's RUNTIME_OWNED_VARS
 * @param {string[]} args.enginePrefixes - serve-engine env-var prefixes
 * @param {object} args.parameterMatrix - generated parameter matrix
 * @param {object} args.configKeyAliases - generated schema-key -> answer-key aliases
 * @returns {{rows: Array, errors: string[]}}
 */
export function auditDoConfig({ templateText, schema, runtimeOwned, enginePrefixes, parameterMatrix, configKeyAliases }) {
    const errors = [];
    const params = schema.parameters;
    const derived = (schema.doConfig && schema.doConfig.derived) || {};
    const derivedDynamic = (schema.doConfig && schema.doConfig.derivedDynamic) || {};
    const { statics, dynamics } = parseTemplate(templateText);

    // var -> claiming parameter keys
    const claims = new Map();
    const families = [];
    for (const [key, p] of Object.entries(params)) {
        if (p.doConfigVar) {
            if (!claims.has(p.doConfigVar)) claims.set(p.doConfigVar, []);
            claims.get(p.doConfigVar).push(key);
        }
        if (p.doConfigVarPrefix) families.push({ key, prefix: p.doConfigVarPrefix });
    }
    for (const [v, keys] of claims) {
        if (keys.length > 1) errors.push(`${v} is claimed by more than one parameter: ${keys.join(', ')}`);
        if (derived[v]) errors.push(`${v} is both a parameter's doConfigVar (${keys.join(', ')}) and doConfig.derived`);
    }

    const names = [...new Set(statics.map((s) => s.name))];
    const rows = [];
    for (const name of names) {
        const occurrences = statics.filter((s) => s.name === name);
        const isRuntime = runtimeOwned.has(name) || enginePrefixes.some((pre) => name.startsWith(pre));
        let cls = null;
        let source = '';
        const claimed = claims.get(name);
        if (claimed) {
            const p = params[claimed[0]];
            cls = p.sensitive ? 'secret' : 'user-input';
            source = `${claimed[0]} (${p.cliFlag || 'no flag'})${isRuntime ? '; also preserved by regenerate (runtime-owned source)' : ''}`;
        } else if (derived[name]) {
            cls = 'derived';
            source = derived[name];
            if (isRuntime) errors.push(`${name} is in doConfig.derived but is also runtime-owned; keep one classification`);
        } else {
            const fam = families.find((f) => name.startsWith(f.prefix));
            if (fam) {
                cls = 'user-input';
                source = `${fam.key} family (${fam.prefix}<KEY>)`;
            } else if (isRuntime) {
                cls = 'runtime-owned';
                source = runtimeOwned.has(name) ? 'RUNTIME_OWNED_VARS' : 'serve-engine env prefix';
            }
        }
        if (!cls) {
            errors.push(`${name} (templates/do/config:${occurrences[0].line}) is unclassified: give its parameter a ` +
                '`doConfigVar`, or declare it in the schema `doConfig.derived` with a reason');
            cls = 'UNCLASSIFIED';
        }
        rows.push({ name, cls, source, lines: occurrences.map((o) => o.line), active: occurrences.some((o) => o.active) });
    }

    // Stale derived entries are drift too.
    for (const v of Object.keys(derived)) {
        if (!names.includes(v)) errors.push(`doConfig.derived lists ${v}, which templates/do/config no longer exports`);
    }

    // Every claimed var must be filled from its parameter's templateVar.
    for (const [v, keys] of claims) {
        const p = params[keys[0]];
        const tv = p.templateVar;
        if (!tv) {
            errors.push(`${keys[0]} declares doConfigVar ${v} but has no templateVar`);
            continue;
        }
        const tvRe = new RegExp(`\\b${escapeRe(tv)}\\b`);
        if (p.doConfigShape === 'env-map') {
            if (!statics.some((s) => s.name === v && s.active)) {
                errors.push(`${keys[0]}: templates/do/config never writes its key list ${v}`);
            }
            if (!dynamics.some((d) => d.source === tv)) {
                errors.push(`${keys[0]}: templates/do/config has no export loop over ${tv}`);
            }
        } else {
            const active = statics.filter((s) => s.name === v && s.active);
            if (active.length === 0) {
                errors.push(`${keys[0]}: templates/do/config never exports ${v}`);
            }
            for (const occ of active) {
                if (occ.text.includes('<%') && !tvRe.test(occ.text)) {
                    errors.push(`${v} (templates/do/config:${occ.line}) is filled from a name other than ` +
                        `${keys[0]}.templateVar '${tv}': ${occ.text.trim()}`);
                }
            }
            if (p.doConfigUnsetValue !== undefined) {
                const unsetForm = `\${${v}:-${p.doConfigUnsetValue}}`;
                if (!active.some((o) => o.text.includes(unsetForm))) {
                    errors.push(`${keys[0]}.doConfigUnsetValue '${p.doConfigUnsetValue}' does not match a ` +
                        `\`${unsetForm}\` runtime default in templates/do/config`);
                }
            }
            if (active.length > 0 && !active.some((o) => tvRe.test(o.text) || tvRe.test(o.control))) {
                errors.push(`${v}: no export line (or its EJS guard) reads ${keys[0]}.templateVar '${tv}'`);
            }
            // The templateVar must be the answer key the generator populates.
            const configKey = p.configKey || keys[0];
            const answerKey = configKeyAliases[configKey] || configKey;
            if (tv !== answerKey) {
                errors.push(`${keys[0]}.templateVar '${tv}' is not the generator answer key '${answerKey}'`);
            }
            if (!parameterMatrix[answerKey]) {
                errors.push(`${keys[0]}: answer key '${answerKey}' is not in the generated parameter matrix`);
            }
        }
    }

    // Dynamic export loops must belong to an env-map parameter or be declared derived.
    const familySources = new Set(Object.values(params)
        .filter((p) => p.doConfigShape === 'env-map').map((p) => p.templateVar));
    for (const d of dynamics) {
        if (!familySources.has(d.source) && !derivedDynamic[d.source]) {
            errors.push(`dynamic export at templates/do/config:${d.line} iterates '${d.source}', which is neither an ` +
                'env-map parameter templateVar nor in doConfig.derivedDynamic');
        }
    }
    for (const d of new Set(dynamics.map((x) => x.source))) {
        const p = Object.entries(params).find(([, x]) => x.doConfigShape === 'env-map' && x.templateVar === d);
        rows.push({
            name: `<${d} keys> (dynamic)`,
            cls: p ? 'user-input' : 'derived',
            source: p ? `${p[0]} (${p[1].cliFlag}); key list in ${p[1].doConfigVar}` : derivedDynamic[d],
            lines: dynamics.filter((x) => x.source === d).map((x) => x.line),
            active: true
        });
    }
    return { rows, errors };
}

/**
 * Run the audit against the repository sources.
 */
export async function auditRepo() {
    const { RUNTIME_OWNED_VARS } = await import('../src/lib/regenerate-command-handler.js');
    const { serveEnginePrefixes } = await import('../src/lib/serve-manifest-reader.js');
    const { parameterMatrix, configKeyAliases } = await import('../src/lib/generated/parameter-matrix.js');
    return auditDoConfig({
        templateText: fs.readFileSync(DO_CONFIG_TEMPLATE, 'utf8'),
        schema: JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')),
        runtimeOwned: RUNTIME_OWNED_VARS,
        enginePrefixes: serveEnginePrefixes(),
        parameterMatrix,
        configKeyAliases
    });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const { rows, errors } = await auditRepo();
    if (process.argv.includes('--markdown')) {
        console.log('| do/config var | class | maps to / reason | template lines |');
        console.log('|---|---|---|---|');
        for (const r of rows) {
            console.log(`| \`${r.name}\`${r.active ? '' : ' (commented)'} | ${r.cls} | ${r.source.replace(/\|/g, '\\|')} | ${r.lines.join(', ')} |`);
        }
    } else {
        const counts = {};
        rows.forEach((r) => { counts[r.cls] = (counts[r.cls] || 0) + 1; });
        console.log(`do/config audit: ${rows.length} vars — ${JSON.stringify(counts)}`);
    }
    if (errors.length) {
        console.error(`\n❌ ${errors.length} drift error(s):`);
        errors.forEach((e) => console.error(`   • ${e}`));
        process.exit(1);
    }
}
