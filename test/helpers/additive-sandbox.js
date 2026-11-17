// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Sandbox helpers for the Wave 6 additive-deploy (ADR-013) shell tests.
 *
 * Builds a throwaway project tree (<tmp>/do/...) holding the REAL
 * templates/do/lib/script-contract.sh (and, on request, the real do/adapter /
 * do/add-ic), plus stubs for the external tools a test wants to control (aws,
 * kubectl, .register_helper.py, lora_vllm.py). Everything runs under /bin/bash,
 * which is bash 3.2 on macOS — the shell the do/ scripts must support.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, '../..');
export const DO_SRC = join(REPO, 'templates/do');
export const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

/**
 * Create a sandbox project. Returns { root, doDir, bin, write, cleanup }.
 * @param {object} opts
 * @param {string[]} [opts.scripts] do/ scripts to copy verbatim (e.g. ['adapter'])
 * @param {string} [opts.config] contents of do/config
 * @param {boolean} [opts.pyHelpers] copy the real do/lib/python helpers, descriptors and tune catalog
 * @param {boolean} [opts.realProfile] use the real do/lib/profile.sh (bucket names from writeProfile)
 */
export function makeSandbox({ scripts = [], config = '', pyHelpers = false, realProfile = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'mlcc-additive-'));
    const doDir = join(root, 'do');
    const libDir = join(doDir, 'lib');
    const pyDir = join(libDir, 'python');
    const bin = join(root, 'bin');
    mkdirSync(pyDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    // The real contract library + the libs the verb scripts source.
    writeFileSync(join(libDir, 'script-contract.sh'), readFileSync(join(DO_SRC, 'lib/script-contract.sh')));
    writeFileSync(join(libDir, 'wait.sh'), readFileSync(join(DO_SRC, 'lib/wait.sh')));
    writeFileSync(join(libDir, 'profile.sh'), '# stub profile.sh\n');
    // Bucket consolidation R3: the thin shell wrapper over s3_layout.py.
    writeFileSync(join(libDir, 's3-layout.sh'), readFileSync(join(DO_SRC, 'lib/s3-layout.sh')));
    // Wave 11 R7.4: the shared IEC render sourced by deploy.d/hyperpod-eks and do/add-pod.
    writeFileSync(join(libDir, 'hp-iec-render.sh'), readFileSync(join(DO_SRC, 'lib/hp-iec-render.sh')));
    // Wave 10 (ADR-014): do/deploy, do/status and do/add-ic source the scale-to-zero
    // helper; it reads the descriptors through scale_to_zero.py (and degrades to
    // "off" when they are absent, i.e. without pyHelpers).
    writeFileSync(join(libDir, 'scale-to-zero.sh'), readFileSync(join(DO_SRC, 'lib/scale-to-zero.sh')));
    for (const py of ['scale_to_zero.py', 'scale_to_zero_reference.json']) {
        writeFileSync(join(pyDir, py), readFileSync(join(DO_SRC, 'lib/python', py)));
    }
    // _require_python_env resolves <root>/.mlcc/hey-venv/bin/activate.
    mkdirSync(join(root, '.mlcc/hey-venv/bin'), { recursive: true });
    writeFileSync(join(root, '.mlcc/hey-venv/bin/activate'), '# stub venv\n');
    writeFileSync(join(doDir, 'config'), config);
    for (const s of scripts) {
        writeFileSync(join(doDir, s), readFileSync(join(DO_SRC, s)), { mode: 0o755 });
    }
    // Wave 6.1: the real Python helpers do/adapter / do/deploy.d call for adapter
    // delivery + right-sizing, plus the descriptors they read (targets.d under
    // do/, serve.d under .mlcc/ — the generated-project layout).
    if (pyHelpers) {
        // instance_sizer.py: right_sizing.py imports its weights-estimate constants (Wave 8, OQ-8.9).
        for (const py of ['adapter_delivery.py', 's3_layout.py', 'right_sizing.py', 'serve_manifest.py', 'target_manifest.py', 'hyperpod_ops.py', 'instance_sizer.py']) {
            writeFileSync(join(pyDir, py), readFileSync(join(DO_SRC, 'lib/python', py)));
        }
        cpSync(join(DO_SRC, 'targets.d'), join(doDir, 'targets.d'), { recursive: true });
        cpSync(join(REPO, 'templates/code/serve.d'), join(root, '.mlcc/serve.d'), { recursive: true });
        // The generated project's tune catalog (s3_layout maps a TUNE_MODEL_ID to its HF id).
        writeFileSync(join(doDir, '.tune_catalog.json'), readFileSync(join(REPO, 'config/tune-catalog.json')));
    }
    // realProfile: the REAL do/lib/profile.sh, so bucket names reach the script only
    // through the active bootstrap profile (<root>/.ml-container-creator/config.json
    // when HOME=<root>; write it with writeProfile) — never a literal.
    if (realProfile) {
        writeFileSync(join(libDir, 'profile.sh'), readFileSync(join(DO_SRC, 'lib/profile.sh')));
    }
    const write = (rel, content, mode = 0o755) => {
        const p = join(root, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, { mode });
        return p;
    };
    const cleanup = () => rmSync(root, { recursive: true, force: true });
    /** Write the active bootstrap profile read by the real profile.sh (HOME=<root>). */
    const writeProfile = (keys) => write('.ml-container-creator/config.json',
        JSON.stringify({ activeProfile: 'sandbox', profiles: { sandbox: keys } }), 0o644);
    return { root, doDir, bin, write, writeProfile, cleanup };
}

/** Env with the sandbox bin/ first on PATH and no inherited venv / AWS profile. */
export function sandboxEnv(sb, extra = {}) {
    const env = { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, ...extra };
    delete env.VIRTUAL_ENV;
    delete env.AWS_PROFILE;
    return env;
}

/** Run `bash <file> args...` and return { code, stdout, stderr }. */
export function runBash(file, args, env, opts = {}) {
    const r = spawnSync(BASH, [file, ...args], {
        env,
        encoding: 'utf8',
        timeout: opts.timeout || 20000,
        input: opts.input || ''
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Run a snippet with script-contract.sh sourced (guard: none) inside a sandbox.
 * Returns { code, stdout, stderr }.
 */
export function runContract(sb, body, env = {}) {
    const script = sb.write('do/_snippet', [
        '#!/bin/bash',
        '# @mlcc-script',
        '# type: utility',
        '# guard: none',
        'set -e',
        'set -u',
        'set -o pipefail',
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'source "${SCRIPT_DIR}/lib/script-contract.sh"',
        body,
        ''
    ].join('\n'));
    return runBash(script, [], sandboxEnv(sb, env));
}

/** Parse the resolver's KEY=VALUE stdout by eval-ing it in bash (handles %q quoting). */
export function parseResolved(sb, stdout) {
    const r = runContract(sb, [
        `eval "$(cat <<'__RESOLVED__'\n${stdout}__RESOLVED__\n)"`,
        'for v in RESOLVED_SOURCE RESOLVED_URI RESOLVED_KIND RESOLVED_META_TECHNIQUE RESOLVED_META_VERSION_ARN RESOLVED_META_PARENT_ARN RESOLVED_META_MODEL_NAME RESOLVED_META_HF_REPO; do',
        '  printf "%s\\t%s\\n" "$v" "${!v:-}"',
        'done'
    ].join('\n'));
    const out = {};
    for (const line of r.stdout.split('\n')) {
        const i = line.indexOf('\t');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
}

/** Every deployment-target descriptor (templates/do/targets.d/<t>/manifest.json). */
export function loadDescriptors() {
    const base = join(DO_SRC, 'targets.d');
    return readdirSync(base)
        .filter(t => existsSync(join(base, t, 'manifest.json')))
        .map(t => JSON.parse(readFileSync(join(base, t, 'manifest.json'), 'utf8')));
}

/** Config lines making the deployment-active guard pass for every target. */
export const ACTIVE_STATUS_CONFIG = [
    'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
    'export DEPLOYMENT_TARGET_ASYNC_STATUS="InService"',
    'export DEPLOYMENT_TARGET_BATCH_STATUS="Completed"',
    'export DEPLOYMENT_TARGET_HP_STATUS="Running"',
    'export DEPLOYMENT_TARGET_EKS_STATUS="Running"'
].join('\n');
