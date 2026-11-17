// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Literal-bucket-name drift test (bucket consolidation R2.4; ADR-008 rule 4).
 *
 * Every MLCC bucket name is spelled exactly ONCE — in its owning stack's
 * infra/bootstrap-modules/<stack dir>/buckets.json — and consumers learn it only
 * through profile keys (coreS3Bucket, artifactsS3Bucket, benchmarkS3Bucket,
 * codebuildSourceS3Bucket, ...) that bootstrap writes from CloudFormation outputs.
 *
 *   1. Static scan: no forbidden bucket-name pattern anywhere in templates/, src/lib/
 *      (minus generated/), servers/, scripts/, infra/bootstrap-modules/ — comments
 *      included — except the exact allowlist below. Each allowlisted declaration must
 *      exist exactly once, and the allowlist must equal the discovered declarations,
 *      so a stale allowlist fails too.
 *   2. Behavioral: a profile with deliberately UNCONVENTIONAL bucket names flows
 *      through profile.sh, do/tune's output-bucket resolver, the notebook generator
 *      (read at run time) and provision-mlflow, and only those fake names appear.
 *      Dropping each key yields a fail-fast error naming the module to add.
 *   3. Conformance: every declared profile key maps CFN output → moduleOutputs →
 *      _denormalizeModuleOutputs → profile key → profile.sh env var, and the
 *      _require_bucket table, bin/app.ts adopt contexts and the runner agree.
 */
import { describe, it, after } from 'mocha';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const { allBucketDeclarations } = require('../../infra/bootstrap-modules/bucket-declarations.cjs');
const { CdkModuleRunner } = require('../../infra/bootstrap-modules/module-runner.cjs');
const { ensureMlflowApp, artifactsBucketFromMlflowApp } = require('../../infra/bootstrap-modules/training/provision-mlflow.cjs');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'infra/bootstrap-modules/module-manifest.json'), 'utf8'));

// ── 1. Static scan ──────────────────────────────────────────────────────────────

const SCAN_ROOTS = ['templates', 'src/lib', 'servers', 'scripts', 'infra/bootstrap-modules'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', '.hyperpod-helm-cache', '__pycache__', '.git']);
const SKIP_PATHS = new Set(['src/lib/generated']);
const SKIP_FILES = new Set(['package.json', 'package-lock.json', 'cdk.context.json']);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|pdf|zip|gz|tgz|pptx|woff2?|ttf|pyc)$/i;

/**
 * Forbidden: a bucket-family name followed by an account/region/profile placeholder,
 * a 12-digit account, a shell/f-string substitution, or string concatenation — i.e.
 * anything that BUILDS an MLCC bucket name. (Plain words like `mlcc-tune-tracking`
 * or `/tmp/.mlcc-benchmark-latest-*` are not bucket names and do not match.)
 */
const FAMILY = '(?:core|tune|training(?:-adapters)?|benchmark(?:-results)?|codebuild-source|models|hyperpod-tls|artifacts)';
const BUILD = '(?=\\$\\{|\\{|<|\\d{12}|\\$\\(|%s|[\'"`]\\s*\\+)';
const FORBIDDEN = [
    { id: 'mlcc-family-name', re: new RegExp(`\\bmlcc-${FAMILY}-${BUILD}`) },
    { id: 'bare-codebuild-source', re: /(?<![\w-])codebuild-source-/ },
    { id: 'retired-ml-container-creator-buckets', re: /\bml-container-creator-(?:benchmark|async|batch)-/ },
    { id: 's3-uri-family-literal', re: new RegExp(`s3://mlcc-${FAMILY}-`) },
    { id: 'arn-family-template', re: /arn:aws:s3:::mlcc-[a-z-]+-\$\{/ }
];

/**
 * EXACT allowlist: the one declaration line per bucket. Each must exist exactly once
 * and the list must equal the declarations discovered on disk.
 */
const ALLOWLIST = [
    { file: 'infra/bootstrap-modules/core/buckets.json', line: '"name": "mlcc-core-{account}-{region}",' },
    { file: 'infra/bootstrap-modules/training/buckets.json', line: '"name": "mlcc-tune-{account}-{region}",' },
    { file: 'infra/bootstrap-modules/training/buckets.json', line: '"name": "mlcc-training-{account}-{region}",' },
    { file: 'infra/bootstrap-modules/training/buckets.json', line: '"name": "mlcc-training-adapters-{account}-{region}",' },
    { file: 'infra/bootstrap-modules/benchmark/buckets.json', line: '"name": "mlcc-benchmark-results-{account}-{region}",' },
    { file: 'infra/bootstrap-modules/ci/buckets.json', line: '"name": "mlcc-codebuild-source-{account}-{region}",' },
    { file: 'infra/bootstrap-modules/hyperpod/stacks/buckets.json', line: '"name": "mlcc-hyperpod-tls-{profile}",' }
];

function walk(dir, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = relative(ROOT, full);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(rel)) continue;
            walk(full, out);
        } else if (entry.isFile() && !SKIP_FILES.has(entry.name) && !BINARY_EXT.test(entry.name)) {
            if (statSync(full).size > 4 * 1024 * 1024) continue;
            out.push(full);
        }
    }
    return out;
}

/** @returns {Array<{file: string, lineNo: number, line: string, pattern: string}>} */
function scanForLiterals(files) {
    const hits = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (text.includes('\u0000')) continue;
        text.split('\n').forEach((line, i) => {
            for (const { id, re } of FORBIDDEN) {
                if (re.test(line)) hits.push({ file: relative(ROOT, file), lineNo: i + 1, line: line.trim(), pattern: id });
            }
        });
    }
    return hits;
}

const isAllowlisted = (hit) => ALLOWLIST.some(a => a.file === hit.file && a.line === hit.line);

describe('no literal bucket names (R2.4) — static scan', () => {
    const files = SCAN_ROOTS.flatMap(r => walk(join(ROOT, r), []));
    const hits = scanForLiterals(files);

    it('scans a non-trivial file set (guards against a broken walker)', () => {
        assert.ok(files.length > 300, `only ${files.length} files scanned`);
        assert.ok(files.some(f => f.endsWith('templates/do/tune')), 'do/ scripts are scanned');
        assert.ok(files.some(f => f.endsWith('infra/bootstrap-modules/module-runner.cjs')), 'the runner is scanned');
    });

    it('no forbidden bucket-name pattern outside the declaration allowlist', () => {
        const offenders = hits.filter(h => !isAllowlisted(h));
        assert.deepStrictEqual(offenders.map(h => `${h.file}:${h.lineNo} [${h.pattern}] ${h.line}`), [],
            'Bucket names must come from profile keys (or, inside bootstrap, the stack\'s buckets.json). ' +
            'Do not spell or rebuild an MLCC bucket name.');
    });

    it('each allowlisted declaration exists exactly once', () => {
        for (const a of ALLOWLIST) {
            const n = hits.filter(h => h.file === a.file && h.line === a.line).length;
            assert.strictEqual(n, 1, `${a.file}: expected exactly one "${a.line}", found ${n}`);
        }
    });

    it('the allowlist equals the declarations on disk (no stale or missing entry)', () => {
        const onDisk = allBucketDeclarations()
            .map(d => `${relative(ROOT, d.file)}|"name": "${d.template}",`).sort();
        assert.deepStrictEqual(ALLOWLIST.map(a => `${a.file}|${a.line}`).sort(), onDisk);
    });

    it('the scanner catches a reintroduced literal (self-check on synthetic lines)', () => {
        const samples = [
            'TUNE_S3_BUCKET="${TUNE_S3_BUCKET:-mlcc-tune-${_PROFILE_accountId}-${AWS_REGION}}"',
            'return f"mlcc-training-{acct}-{region}"',
            'S3_BUCKET="codebuild-source-${AWS_ACCOUNT_ID}-${AWS_REGION}"',
            'const b = \'mlcc-core-\' + accountId;',
            '`arn:aws:s3:::mlcc-core-${this.account}-${this.region}`',
            's3://mlcc-tune-123456789012-us-east-1/output/'
        ];
        for (const s of samples) {
            assert.ok(FORBIDDEN.some(({ re }) => re.test(s)), `scanner must flag: ${s}`);
        }
        for (const ok of ['mlcc-tune-tracking', '/tmp/.mlcc-benchmark-latest-x', 'arn:aws:s3:::mlcc-*', 'mlcc-codebuild-source-*']) {
            assert.ok(!FORBIDDEN.some(({ re }) => re.test(ok)), `scanner must not flag: ${ok}`);
        }
    });
});

// ── 2. Behavioral: unconventional fake names ────────────────────────────────────

const FAKE = {
    coreS3Bucket: 'zz-core-x',
    artifactsS3Bucket: 'zz-art-y',
    benchmarkS3Bucket: 'zz-bench-z',
    codebuildSourceS3Bucket: 'zz-src-w'
};
const PROFILE_SH = join(ROOT, 'templates/do/lib/profile.sh');
const BUCKET_ENV = ['CORE_S3_BUCKET', 'ARTIFACTS_S3_BUCKET', 'BENCHMARK_S3_BUCKET', 'CODEBUILD_SOURCE_S3_BUCKET',
    'MODELS_S3_BUCKET', 'TUNE_S3_BUCKET', 'S3_BUCKET', 'ADAPTER_S3_BUCKET'];

const TMP_DIRS = [];
after(() => { for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true }); });

function fakeHome(profileKeys) {
    const home = mkdtempSync(join(tmpdir(), 'mlcc-buckets-'));
    TMP_DIRS.push(home);
    mkdirSync(join(home, '.ml-container-creator'), { recursive: true });
    writeFileSync(join(home, '.ml-container-creator', 'config.json'), JSON.stringify({
        activeProfile: 'zz',
        profiles: { zz: { awsRegion: 'ap-south-2', accountId: '000011112222', ...profileKeys } }
    }));
    return home;
}

/** Run bash with profile.sh sourced under a fake HOME; returns { status, stdout, stderr }. */
function runWithProfile(profileKeys, body) {
    const home = fakeHome(profileKeys);
    const script = join(home, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash\nset -u\nsource "${PROFILE_SH}"\n${body}\n`);
    const env = { ...process.env, HOME: home, MLCC_SKIP_SECRET_DISCOVERY: '1' };
    for (const v of BUCKET_ENV) delete env[v];
    try {
        const stdout = execFileSync('/bin/bash', [script], { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
        return { status: 0, stdout, stderr: '' };
    } catch (e) {
        return { status: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
}

/** Extract a top-level bash function definition from a do/ script. */
function extractFunction(file, name) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(src);
    assert.ok(m, `${name}() not found in ${file}`);
    return m[0];
}

describe('no literal bucket names (R2.4) — behavioral, unconventional fake buckets', () => {
    it('profile.sh exports exactly the profile-provided names', () => {
        const r = runWithProfile(FAKE, BUCKET_ENV.map(v => `echo "${v}=\${${v}:-}"`).join('\n'));
        assert.strictEqual(r.status, 0, r.stderr);
        const out = Object.fromEntries(r.stdout.trim().split('\n').map(l => l.split('=')));
        assert.strictEqual(out.CORE_S3_BUCKET, 'zz-core-x');
        assert.strictEqual(out.MODELS_S3_BUCKET, 'zz-core-x', 'MODELS_S3_BUCKET is an alias of the core key');
        assert.strictEqual(out.ARTIFACTS_S3_BUCKET, 'zz-art-y');
        assert.strictEqual(out.TUNE_S3_BUCKET, 'zz-art-y', 'TUNE_S3_BUCKET is an alias of the artifacts key');
        assert.strictEqual(out.BENCHMARK_S3_BUCKET, 'zz-bench-z');
        assert.strictEqual(out.CODEBUILD_SOURCE_S3_BUCKET, 'zz-src-w');
        assert.strictEqual(out.S3_BUCKET, '', 'no training key → no guessed training bucket');
        assert.ok(!/mlcc-|000011112222/.test(r.stdout), `nothing derived from account/region: ${r.stdout}`);
    });

    it('TUNE_S3_BUCKET survives only as an override alias', () => {
        const r = runWithProfile(FAKE, 'echo "$ARTIFACTS_S3_BUCKET"');
        assert.strictEqual(r.stdout.trim(), 'zz-art-y');
        const home = fakeHome(FAKE);
        const script = join(home, 'o.sh');
        writeFileSync(script, `source "${PROFILE_SH}"\necho "$ARTIFACTS_S3_BUCKET"\n`);
        const env = { ...process.env, HOME: home, MLCC_SKIP_SECRET_DISCOVERY: '1', TUNE_S3_BUCKET: 'zz-override' };
        delete env.ARTIFACTS_S3_BUCKET;
        assert.strictEqual(execFileSync('/bin/bash', [script], { encoding: 'utf8', env }).trim(), 'zz-override');
    });

    const REQUIRED = [
        ['CORE_S3_BUCKET', 'coreS3Bucket', 'core'],
        ['ARTIFACTS_S3_BUCKET', 'artifactsS3Bucket', 'training'],
        ['BENCHMARK_S3_BUCKET', 'benchmarkS3Bucket', 'benchmark'],
        ['CODEBUILD_SOURCE_S3_BUCKET', 'codebuildSourceS3Bucket', 'ci']
    ];
    for (const [envVar, key, module] of REQUIRED) {
        it(`dropping ${key} makes _require_bucket ${envVar} fail fast naming module '${module}'`, () => {
            const rest = { ...FAKE };
            delete rest[key];
            const ok = runWithProfile(FAKE, `_require_bucket ${envVar} && echo OK`);
            assert.strictEqual(ok.stdout.trim(), 'OK');
            const r = runWithProfile(rest, `_require_bucket ${envVar} || exit 7`);
            assert.strictEqual(r.status, 7);
            assert.match(r.stderr, new RegExp(`bootstrap add-module ${module}\\b`));
            assert.match(r.stderr, new RegExp(key));
        });
    }

    it('do/tune output bucket resolves to the profile artifacts bucket, and fails without it', () => {
        const fn = extractFunction('templates/do/tune', '_resolve_output_bucket');
        const ok = runWithProfile(FAKE, `ARG_OUTPUT_BUCKET=""\n${fn}\n_resolve_output_bucket`);
        assert.strictEqual(ok.status, 0, ok.stderr);
        assert.strictEqual(ok.stdout.trim(), 'zz-art-y');
        const rest = { ...FAKE };
        delete rest.artifactsS3Bucket;
        const bad = runWithProfile(rest, `ARG_OUTPUT_BUCKET=""\n${fn}\nb=$(_resolve_output_bucket) || exit 9\necho "$b"`);
        assert.strictEqual(bad.status, 9, 'missing key is a hard error, not a guessed name');
        assert.match(bad.stderr, /bootstrap add-module training/);
        const flag = runWithProfile(rest, `ARG_OUTPUT_BUCKET="zz-flag"\n${fn}\n_resolve_output_bucket`);
        assert.strictEqual(flag.stdout.trim(), 'zz-flag', '--output-bucket still wins');
    });

    it('the generated notebook reads the artifacts bucket at RUN time (not baked)', function () {
        this.timeout(30000);
        const tpl = readFileSync(join(ROOT, 'templates/deploy_notebook_generator.py'), 'utf8');
        const py = ejs.render(tpl, {
            projectName: 'p', deploymentConfig: 'transformers-vllm', framework: 'transformers', modelServer: 'vllm',
            awsRegion: 'us-east-1', deploymentTarget: 'realtime-inference', instanceType: 'ml.g5.xlarge',
            modelName: 'm', hfToken: '', hfTokenArn: '', ngcApiKey: '', ngcTokenArn: '', orderedEnvVars: [],
            inferenceAmiVersion: '', enableLora: false, tuneSupported: true, existingEndpointName: null
        });
        const dir = mkdtempSync(join(tmpdir(), 'mlcc-nb-'));
        TMP_DIRS.push(dir);
        writeFileSync(join(dir, 'gen.py'), py);
        const genEnv = { ...process.env, PROJECT_NAME: 'p', AWS_REGION: 'us-east-1', INSTANCE_TYPE: 'ml.g5.xlarge',
            MODEL_SERVER: 'vllm', DEPLOYMENT_TARGET: 'realtime-inference', FRAMEWORK: 'transformers',
            IC_GPU_COUNT: '1', IC_MEMORY_SIZE: '1024', TUNE_S3_BUCKET: 'zz-generation-time-value' };
        execFileSync('python3', [join(dir, 'gen.py')], { cwd: dir, env: genEnv, stdio: 'pipe', timeout: 20000 });
        const nb = JSON.parse(readFileSync(join(dir, 'deploy_notebook.ipynb'), 'utf8'));
        const cell = nb.cells.map(c => c.source.join('')).find(src => src.includes('TUNE_OUTPUT_BUCKET ='));
        assert.ok(cell, 'tune cell present');
        assert.ok(!cell.includes('zz-generation-time-value'), 'bucket must not be baked at generation time');
        // Execute the cell's bucket-resolution code against a fake profile.
        const home = fakeHome(FAKE);
        const probe = join(dir, 'probe.py');
        writeFileSync(probe, `${cell.split('\n').filter(l => !l.startsWith('TECHNIQUE') && !l.startsWith('TRAINING_TYPE') && !l.startsWith('DATASET_S3_URI')).join('\n')}\nprint(TUNE_OUTPUT_BUCKET)\n`);
        const runEnv = { ...process.env, HOME: home };
        delete runEnv.ARTIFACTS_S3_BUCKET;
        delete runEnv.TUNE_S3_BUCKET;
        assert.strictEqual(execFileSync('python3', [probe], { env: runEnv, encoding: 'utf8' }).trim(), 'zz-art-y');
    });

    it('provision-mlflow creates the App on the declared artifacts bucket and creates no bucket', () => {
        const calls = [];
        const exec = (args) => {
            calls.push(args);
            if (args[1] === 'list-mlflow-apps') return { Summaries: [] };
            if (args[1] === 'create-mlflow-app') return { Arn: 'arn:aws:sagemaker:r:0:mlflow-app/app-1' };
            throw new Error(`unexpected ${args.join(' ')}`);
        };
        const quiet = console.log; console.log = () => {};
        let arn;
        try {
            arn = ensureMlflowApp({ awsRegion: 'r', roleArn: 'arn:role', artifactsBucket: 'zz-art-y', exec });
            assert.strictEqual(ensureMlflowApp({ awsRegion: 'r', roleArn: 'arn:role', exec }), null,
                'no artifacts bucket → no App and no guessed bucket');
        } finally { console.log = quiet; }
        assert.strictEqual(arn, 'arn:aws:sagemaker:r:0:mlflow-app/app-1');
        const create = calls.find(c => c[1] === 'create-mlflow-app');
        assert.strictEqual(create[create.indexOf('--artifact-store-uri') + 1], 's3://zz-art-y');
        assert.ok(!calls.some(c => c[0] === 's3api' || c.includes('create-bucket')), 'never creates a bucket');
    });

    it('existing profiles are seeded from describe-mlflow-app ArtifactStoreUri (never a pattern)', () => {
        const exec = (args) => {
            assert.deepStrictEqual(args.slice(0, 2), ['sagemaker', 'describe-mlflow-app']);
            return { ArtifactStoreUri: 's3://zz-recorded-store/some/prefix' };
        };
        assert.strictEqual(artifactsBucketFromMlflowApp({ mlflowAppArn: 'arn:x', awsRegion: 'r', exec }), 'zz-recorded-store');
        assert.strictEqual(artifactsBucketFromMlflowApp({ mlflowAppArn: '', awsRegion: 'r', exec }), null);
    });

    it('bootstrap migrate seeds artifactsS3Bucket via moduleOutputs → denormalize', async () => {
        const handler = new BootstrapCommandHandler({ promptFn: async () => ({ confirm: true }) });
        const config = { activeProfile: 'zz', profiles: { zz: { mlflowAppArn: 'arn:x', awsRegion: 'r', moduleOutputs: { training: { MlflowAppArn: 'arn:x' } } } } };
        let written = null;
        handler.config = { read: () => config, write: (c) => { written = c; } };
        handler._artifactsBucketFromMlflowApp = () => 'zz-recorded-store';
        const quiet = console.log; console.log = () => {};
        try { await handler._handleMigrate(); } finally { console.log = quiet; }
        assert.strictEqual(written.profiles.zz.artifactsS3Bucket, 'zz-recorded-store');
        assert.strictEqual(written.profiles.zz.moduleOutputs.training.ArtifactsBucket, 'zz-recorded-store');
    });
});

// ── 3. Conformance: profile key ↔ stack output ↔ profile.sh ─────────────────────

function moduleForStack(stack) {
    return Object.keys(MANIFEST.modules).find((m) => {
        const mod = MANIFEST.modules[m];
        return mod.stackNameSuffix === stack || (Array.isArray(mod.stacks) && mod.stacks.includes(stack));
    });
}

function stackSourceFor(decl) {
    return readFileSync(join(dirname(decl.file), decl.stack === 'inference-operator' ? 'inference-operator-stack.ts' : 'stack.ts'), 'utf8');
}

describe('no literal bucket names (R2.4) — conformance', () => {
    const decls = allBucketDeclarations();
    const profileSh = readFileSync(PROFILE_SH, 'utf8');

    it('the declared set covers the consolidated bucket families', () => {
        const keys = decls.map(d => d.profileKey).filter(Boolean).sort();
        assert.deepStrictEqual(keys, ['adapterS3Bucket', 'artifactsS3Bucket', 'benchmarkS3Bucket',
            'codebuildSourceS3Bucket', 'coreS3Bucket', 'trainingS3Bucket']);
    });

    for (const d of allBucketDeclarations()) {
        it(`${d.stack}/${d.logicalId}: stack constructs it from the declaration and emits output ${d.output}`, () => {
            const src = stackSourceFor(d);
            assert.match(src, new RegExp(`bucketDeclaration\\(BUCKETS, '${d.logicalId}'\\)`));
            assert.match(src, new RegExp(`declaredBucket\\(this, '${d.logicalId}'`));
            assert.match(src, new RegExp(`new cdk\\.CfnOutput\\(this, '${d.output}'`));
        });
    }

    for (const d of allBucketDeclarations().filter(x => x.profileKey)) {
        it(`${d.profileKey}: CFN output → moduleOutputs → _denormalizeModuleOutputs → profile.sh ${d.envVar}`, () => {
            const module = moduleForStack(d.stack);
            assert.ok(module, `stack ${d.stack} belongs to a manifest module`);
            const outputKey = d.output.replace(/Output$/, ''); // the runner strips a trailing 'Output'
            const profile = { moduleOutputs: { [module]: { [outputKey]: 'zz-sentinel' } } };
            new BootstrapCommandHandler()._denormalizeModuleOutputs(profile);
            assert.strictEqual(profile[d.profileKey], 'zz-sentinel',
                `_denormalizeModuleOutputs must map moduleOutputs.${module}.${outputKey} → ${d.profileKey}`);
            assert.match(profileSh, new RegExp(`^${d.envVar}="\\$\\{${d.envVar}:-[^\\n]*\\$\\{_PROFILE_${d.profileKey}:-`, 'm'),
                `profile.sh must export ${d.envVar} from _PROFILE_${d.profileKey}`);
            assert.ok((MANIFEST.modules[module].exports || []).includes(outputKey),
                `module-manifest ${module}.exports lists ${outputKey}`);
        });
    }

    it('every bucket profile key profile.sh reads is declared (or a documented alias of one)', () => {
        const ALIASES = { modelsS3Bucket: 'coreS3Bucket', ciBenchmarkResultsBucket: 'benchmarkS3Bucket' };
        const declared = new Set(decls.map(d => d.profileKey).filter(Boolean));
        const read = new Set([...profileSh.matchAll(/_PROFILE_(\w+(?:S3Bucket|ResultsBucket))\b/g)].map(m => m[1]));
        for (const k of read) {
            assert.ok(declared.has(k) || declared.has(ALIASES[k]), `profile.sh reads undeclared bucket key ${k}`);
        }
        // Aliases are written from the SAME output as their canonical key.
        const p = { moduleOutputs: { core: { ModelsBucket: 'zz-c' }, benchmark: { BenchmarkBucket: 'zz-b' } } };
        new BootstrapCommandHandler()._denormalizeModuleOutputs(p);
        assert.strictEqual(p.modelsS3Bucket, p.coreS3Bucket);
        assert.strictEqual(p.ciBenchmarkResultsBucket, p.benchmarkS3Bucket);
    });

    it('profile.sh _require_bucket table agrees with the declarations (env var → key → module)', () => {
        const arms = [...profileSh.matchAll(/^\s+([A-Z0-9_]+)\) _rb_key="(\w+)"; _rb_module="([\w-]+)" ;;/gm)]
            .map(m => ({ envVar: m[1], key: m[2], module: m[3] }));
        assert.ok(arms.length >= 4, `found ${arms.length} _require_bucket arms`);
        for (const arm of arms) {
            const d = decls.find(x => x.envVar === arm.envVar);
            assert.ok(d, `${arm.envVar} is declared in some buckets.json`);
            assert.strictEqual(arm.key, d.profileKey, `${arm.envVar} key`);
            assert.strictEqual(arm.module, moduleForStack(d.stack), `${arm.envVar} module`);
        }
    });

    it('bin/app.ts reads every declared adopt context, and the runner derives flags from the declaration', () => {
        const app = readFileSync(join(ROOT, 'infra/bootstrap-modules/bin/app.ts'), 'utf8');
        const profile = { accountId: '000011112222', awsRegion: 'ap-south-2', profileName: 'zz' };
        for (const d of decls) {
            assert.ok(app.includes(`tryGetContext('${d.adoptContext}')`), `bin/app.ts reads ${d.adoptContext}`);
        }
        for (const stack of new Set(decls.map(d => d.stack))) {
            const r = new CdkModuleRunner(moduleForStack(stack), stack);
            r._stackOwnedBucketNames = () => new Set();
            r._bucketExists = () => true;
            r._ecrRepoExists = () => false;
            r._iamRoleExists = () => false;
            const quiet = console.log; console.log = () => {};
            let flags;
            try { flags = r._computeAdoptFlags(profile); } finally { console.log = quiet; }
            const want = [...new Set(decls.filter(d => d.stack === stack).map(d => `--context ${d.adoptContext}=true`))].sort();
            assert.deepStrictEqual(flags.filter(f => want.includes(f)).sort(), want);
        }
    });
});
