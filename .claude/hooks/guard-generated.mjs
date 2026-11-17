#!/usr/bin/env node
// PreToolUse hook: block edits to generated code.
// Claude Code passes the tool call as JSON on stdin. Exit code 2 blocks the
// call and sends stderr back to Claude. Any other exit code lets it through.
//
// Guards:
//   1. Anything under src/lib/generated/ (generated from parameter-schema-v2.json)
//   2. Blocks delimited by ">>> GENERATED" and "<<< END GENERATED" in
//      templates/do/lib/script-contract.sh and templates/do/deploy
//      (produced by scripts/codegen-target-guard.js)
import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const BEGIN = '>>> GENERATED';
const END = '<<< END GENERATED';
const MARKER_FILES = [
    'templates/do/lib/script-contract.sh',
    'templates/do/deploy'
];

function block(reason) {
    process.stderr.write(
        `❌ Blocked: ${reason}\n` +
        '   Edit config/parameter-schema-v2.json or the target/engine descriptor, ' +
        'then run `npm run codegen`.\n'
    );
    process.exit(2);
}

let input;
try {
    input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
    process.exit(0); // unparseable input: do not get in the way
}

const toolInput = input.tool_input || {};
const filePath = toolInput.file_path;
if (!filePath) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = relative(root, resolve(root, filePath)).split('\\').join('/');

// 1. Generated source directory
if (rel.startsWith('src/lib/generated/')) {
    block(`${rel} is generated code.`);
}

// 2. Generated blocks inside shell templates
if (MARKER_FILES.includes(rel)) {
    // A full-file Write would clobber the generated blocks.
    if (input.tool_name === 'Write') {
        block(`${rel} contains GENERATED blocks; use a targeted Edit outside them.`);
    }

    const edits = Array.isArray(toolInput.edits)
        ? toolInput.edits
        : [{ old_string: toolInput.old_string, new_string: toolInput.new_string }];

    const text = existsSync(resolve(root, filePath))
        ? readFileSync(resolve(root, filePath), 'utf8')
        : '';

    for (const { old_string: oldStr, new_string: newStr } of edits) {
        // Touching a marker line directly
        for (const s of [oldStr, newStr]) {
            if (s && (s.includes(BEGIN) || s.includes(END))) {
                block(`edit touches a GENERATED marker in ${rel}.`);
            }
        }
        // old_string located inside a generated block
        if (oldStr) {
            const at = text.indexOf(oldStr);
            if (at !== -1) {
                const lastBegin = text.lastIndexOf(BEGIN, at);
                const lastEnd = text.lastIndexOf(END, at);
                if (lastBegin !== -1 && lastBegin > lastEnd) {
                    block(`edit falls inside a GENERATED block in ${rel}.`);
                }
            }
        }
    }
}

process.exit(0);
