// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Bucket consolidation R3.2 / R3.5 / R3.6 drift guard (ADR-008 derive-dont-hardcode):
 * templates/do/lib/python/s3_layout.py is the ONE place that assembles servable
 * S3 paths (models/<org>/<base>/, .mlcc-adapters/<project>/<name>/,
 * models/mlcc-<project>/<name>/). Every producer and consumer calls it (directly,
 * or through do/lib/s3-layout.sh), so no script can drift to its own scheme the
 * way the two retired stage_adapter.py adapter schemes did.
 *
 * BL199: the content-addressed adapter version segment (<home>/v<hash12>/) is
 * composed ONLY there too (s3_layout.adapter_version / adapter_version_uri): no
 * other file slices a hash into a v-prefixed path segment or re-spells the
 * version pattern.
 *
 * Also conformance-checks the two copies that cannot import the module:
 *   - templates/code/serve (runs inside the image) excludes s3_layout.SERVE_SYNC_EXCLUDE;
 *   - each target descriptor's adapter_delivery.subdir equals s3_layout.ADAPTER_SUBDIR.
 * And the R3.6 / Wave 6.1 R1.7 rules: do/stage never syncs with --delete.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const LAYOUT = 'templates/do/lib/python/s3_layout.py';
const PY = process.env.MLCC_PYTHON || 'python3'; // s3_layout imports only the stdlib

// Path-assembly forms: an interpolated models/ or adapters/ segment inside an s3://
// URI, a Python key f-string starting at models/ or adapters/, or the adapter subdir
// spelled as a literal / followed by interpolation.
const FORBIDDEN = [
    { id: 's3-uri-models-or-adapters', re: /s3:\/\/[^\s"'`]*\/(models|adapters)\/(\$\{|\{)/ },
    { id: 'py-key-models-or-adapters', re: /\bf["'](models|adapters)\/\{/ },
    { id: 'adapter-subdir-interpolated', re: /\.mlcc-adapters\/(\$\{|\{)/ },
    { id: 'adapter-subdir-literal', re: /["']\.mlcc-adapters["']/ },
    // BL199: a version segment built from a sliced hash (bash ${h:0:N}, Python {h[:N]},
    // JS ${h.slice(0, N)}) or the version pattern re-spelled as a regex.
    { id: 'adapter-version-composed', re: /v(\$\{[^}]*:0:\d+\}|\{[^}]*\[:\d+\]\}|\$\{[^}]*\.slice\(0,\s*\d+\)\})/ },
    { id: 'adapter-version-pattern', re: /v\[0-9a-f\]\{\d+\}/ }
];
const SCAN_DIRS = ['templates', 'src/lib', 'scripts', 'servers'];
const SKIP_DIRS = new Set(['node_modules', 'generated', '__pycache__', '.git']);
const SKIP_EXT = /\.(md|json|png|jpg|gif|svg|lock|csv|txt)$/;

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (!SKIP_EXT.test(name) && !/\.test\.(js|py)$|test_[^/]*\.py$/.test(name)) out.push(full);
    }
    return out;
}

function violations() {
    const hits = [];
    for (const d of SCAN_DIRS) {
        const abs = join(ROOT, d);
        if (!existsSync(abs)) continue;
        for (const f of walk(abs, [])) {
            const rel = relative(ROOT, f);
            if (rel === LAYOUT) continue;
            const lines = readFileSync(f, 'utf8').split('\n');
            lines.forEach((line, i) => {
                for (const p of FORBIDDEN) {
                    if (p.re.test(line)) hits.push(`${rel}:${i + 1} [${p.id}] ${line.trim().slice(0, 140)}`);
                }
            });
        }
    }
    return hits;
}

function layoutConst(name) {
    return execFileSync(PY, ['-c', `import sys; sys.path.insert(0, "templates/do/lib/python"); import s3_layout; print(s3_layout.${name})`],
        { cwd: ROOT, encoding: 'utf8' }).trim();
}

describe('s3_layout.py is the single S3 path composer (bucket consolidation R3.2)', () => {
    it('no file outside s3_layout.py assembles models/, adapters/ or .mlcc-adapters/ paths', () => {
        const hits = violations();
        assert.deepStrictEqual(hits, [], `path assembly outside ${LAYOUT}:\n${hits.join('\n')}`);
    });

    it('the patterns catch every retired scheme (the guard is not vacuous)', () => {
        const samples = [
            'MODEL_S3_URI="s3://${STAGE_S3_BUCKET}/models/${MODEL_NAME}/"',
            '    adapter_s3_uri = f"s3://{args.bucket}/{args.project}/adapters/{args.adapter_name}/"',
            '    adapter_s3_uri = f"s3://{args.bucket}/adapters/{args.project}/{args.adapter_name}/"',
            'local s3_path="s3://${s3_bucket}/adapters/${PROJECT_NAME}/${adapter_name}/adapter.tar.gz"',
            '    s3.head_object(Bucket=b, Key=f"models/{name}/config.json")',
            'dest="s3://${B}/${P}/.mlcc-adapters/${PROJECT_NAME}/${n}/"',
            'subdir = ".mlcc-adapters"',
            // BL199: hand-composed version segments / a copied version regex.
            'dest="${home}v${hash:0:12}/"',
            '    key = f"{home}v{digest[:12]}/"',
            'const url = `${home}v${h.slice(0, 12)}/`;',
            '    if re.match(r"^v[0-9a-f]{12}$", seg):'
        ];
        for (const s of samples) {
            assert.ok(FORBIDDEN.some(p => p.re.test(s)), `not caught: ${s}`);
        }
        // Not path assembly: local conf files, HF API URLs, placeholder help text.
        for (const ok of [
            'conf="${SCRIPT_DIR}/adapters/${adapter_name}.conf"',
            'local api_url="https://huggingface.co/api/models/${hf_repo_id}"',
            'echo "Destination: s3://<mlcc-core-bucket>/models/<model-name>/"',
            'echo "it lands in <home>/v<hash12>/ (same content → same version)"',
            'local _v="${version:-}"'
        ]) {
            assert.ok(!FORBIDDEN.some(p => p.re.test(ok)), `false positive: ${ok}`);
        }
    });

    it('every producer and consumer calls the layout module', () => {
        const read = p => readFileSync(join(ROOT, p), 'utf8');
        const expectations = [
            ['templates/do/tune', '_s3_layout_promote'],
            ['templates/do/train', '_s3_layout_promote'],
            ['templates/do/adapter', '_adapter_promote_canonical'],
            ['templates/do/adapter', 'adapter_delivery.py" deliver'],
            ['templates/do/adapter', 'adapter_delivery.py" remove-copy'],
            ['templates/do/adapter', 's3_layout.py" publish-local'],
            ['templates/do/stage', 's3_layout.py" base-uri'],
            ['templates/do/clean', '_s3_layout_clean_project'],
            ['templates/do/lib/s3-layout.sh', 'lib/python/s3_layout.py'],
            ['templates/do/lib/python/adapter_delivery.py', 'import s3_layout'],
            ['templates/do/lib/python/stage_model.py', 's3_layout.base_prefix'],
            ['templates/do/lib/python/stage_adapter.py', '_canonical_output_uri'],
            ['templates/do/lib/python/register_evaluator.py', 's3_layout.evaluator_key']
        ];
        for (const [file, needle] of expectations) {
            assert.ok(read(file).includes(needle), `${file} must use the layout module (${needle})`);
        }
        for (const file of ['templates/do/adapter', 'templates/do/lib/python/adapter_delivery.py']) {
            assert.ok(!read(file).includes('TODO(W6.1 Part B)'), `${file} still carries a Part B TODO marker`);
        }
    });
});

describe('BL199: the adapter version segment comes only from s3_layout', () => {
    it('s3_layout composes <home>/v<hash12>/ from the content hash and parses both forms', () => {
        const out = execFileSync(PY, ['-c', [
            'import sys, json; sys.path.insert(0, "templates/do/lib/python"); import s3_layout as L',
            'h = L.content_hash([{"Key": "p/adapter_config.json", "Size": 1, "ETag": "e"}], "p/")',
            'home = L.adapter_uri("zz-b", "org/m", "p", "n")',
            'v = L.adapter_version_uri(home, h)',
            'print(json.dumps({"h": h, "home": home, "v": v, "pv": L.parse_adapter_uri(v), "ph": L.parse_adapter_uri(home),',
            '                  "prefix": L.VERSION_PREFIX, "n": L.VERSION_HEX_LEN}))'
        ].join('\n')], { cwd: ROOT, encoding: 'utf8' });
        const d = JSON.parse(out);
        const digest = d.h.split(':')[1];
        assert.strictEqual(d.pv.version, d.prefix + digest.slice(0, d.n));
        assert.strictEqual(d.v, `${d.home}${d.pv.version}/`);
        assert.strictEqual(d.pv.home, d.ph.home);
        assert.strictEqual(d.ph.version, '', 'an unversioned (pre-BL199) home still parses');
    });
    it('the shell producers take the promoted location from s3_layout (never re-derive it)', () => {
        const read = p => readFileSync(join(ROOT, p), 'utf8');
        assert.ok(/PROMOTED_URI=\$\(_s3_layout_field "\$\{_out\}" dest\)/.test(read('templates/do/lib/s3-layout.sh')));
        const adapter = read('templates/do/adapter');
        assert.ok(adapter.includes('_dest=$(_adapter_json_get "${_out}" dest)'), 'do/adapter promote result');
        assert.ok(adapter.includes('s3_path=$(_adapter_json_get "${_pub_out}" dest)'), 'do/adapter --from-hub publish result');
        assert.ok(adapter.includes('_LORA_PATH=$(_adapter_json_get "${_deliver_out}" path)'), 'k8s delivery result');
    });
});
describe('copies of layout constants that cannot import s3_layout agree with it', () => {
    it('templates/code/serve excludes s3_layout.SERVE_SYNC_EXCLUDE from the model sync (R3.5)', () => {
        const glob = layoutConst('SERVE_SYNC_EXCLUDE');
        const serve = readFileSync(join(ROOT, 'templates/code/serve'), 'utf8');
        const syncs = serve.split('\n').filter(l => /aws s3 sync/.test(l) && !/^\s*#/.test(l));
        assert.ok(syncs.length > 0, 'serve has no aws s3 sync');
        for (const l of syncs) {
            assert.ok(l.includes(`--exclude "${glob}"`), `serve sync must exclude ${glob}: ${l.trim()}`);
        }
    });

    it('every target descriptor adapter_delivery.subdir equals s3_layout.ADAPTER_SUBDIR', () => {
        const subdir = layoutConst('ADAPTER_SUBDIR');
        const dir = join(ROOT, 'templates/do/targets.d');
        let checked = 0;
        for (const t of readdirSync(dir)) {
            const mf = join(dir, t, 'manifest.json');
            if (!existsSync(mf)) continue;
            const d = JSON.parse(readFileSync(mf, 'utf8'));
            if (d.adapter_delivery && d.adapter_delivery.subdir !== undefined) {
                assert.strictEqual(d.adapter_delivery.subdir, subdir, `${t} adapter_delivery.subdir`);
                checked += 1;
            }
        }
        assert.ok(checked >= 2, 'expected the hyperpod-eks and eks descriptors to declare adapter_delivery');
    });
});

describe('do/stage never deletes canonical adapters (Wave 6.1 R1.7, bucket R3.6)', () => {
    for (const file of ['templates/do/stage', 'templates/do/lib/python/stage_model.py']) {
        it(`${file} never runs aws s3 sync / rm with --delete`, () => {
            const src = readFileSync(join(ROOT, file), 'utf8');
            const syncs = src.split('\n').filter(l => /aws s3 (sync|rm)/.test(l));
            assert.ok(syncs.length > 0 || file.endsWith('.py'), `${file} has no aws s3 sync`);
            assert.ok(!/aws s3 rm/.test(src), `${file} must not rm objects`);
            // Collect each sync command's continuation lines and check none adds --delete.
            const lines = src.split('\n');
            lines.forEach((l, i) => {
                if (!/aws s3 sync/.test(l) || /^\s*#/.test(l)) return;
                let cmd = l;
                let j = i;
                while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) { j += 1; cmd += lines[j]; }
                assert.ok(!/--delete\b/.test(cmd), `${file}:${i + 1} syncs with --delete`);
            });
        });
    }
});
