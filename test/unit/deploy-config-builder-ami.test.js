// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * BL209 — InferenceAmiVersion is a deploy-time function of (instance family,
 * image default AMI), derived from the AWS AMI table in fleet-drivers.json.
 *
 * Behavioral and SKU-agnostic: instance types are picked from instances.json by
 * property (gpuArchitecture, AWS allow-list membership), AMIs from
 * fleet-drivers.json / model-servers.json — no pinned SKU or AMI literal.
 *
 *   1. resolveInferenceAmi (servers/lib/image-filter.js) precedence.
 *   2. deploy-config-builder run() wires it in where the instance is known.
 *   3. The Python twin used by do/lib/endpoint-config.sh
 *      (templates/do/lib/python/inference_ami.py) agrees with the JS resolver
 *      on every family x AMI combination (drift guard), and fails an empty
 *      pool intersection.
 */
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveInferenceAmi, parseInstanceFamily } from '../../servers/lib/image-filter.js';
import { run } from '../../src/lib/deploy-config-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const CATALOGS = join(REPO, 'servers', 'lib', 'catalogs');
const load = (name) => JSON.parse(readFileSync(join(CATALOGS, name), 'utf8'));
const instances = load('instances.json').catalog;
const fleet = load('fleet-drivers.json');
const modelServers = load('model-servers.json');
const PY_HELPER_DIR = join(REPO, 'templates', 'do', 'lib', 'python');

// ── Data-derived fixtures ────────────────────────────────────────────────────
const amiNames = Object.keys(fleet.ami_versions)
    .filter(n => !n.startsWith('_') && fleet.ami_versions[n] && typeof fleet.ami_versions[n] === 'object');
const allowedFor = (family) => amiNames.filter(n => [
    ...(fleet.ami_versions[n].default_families || []),
    ...(fleet.ami_versions[n].override_families || [])
].includes(family));
const driverMajor = (ami) => Number(String(fleet.ami_versions[ami].driver).split('.')[0]);

// The most common GPU image default AMI in model-servers.json.
const gpuImageAmiCounts = {};
for (const list of Object.values(modelServers)) {
    if (!Array.isArray(list)) continue;
    for (const img of list) {
        const ami = img.accelerator && img.accelerator.type === 'cuda' && img.defaults && img.defaults.inferenceAmiVersion;
        if (ami) gpuImageAmiCounts[ami] = (gpuImageAmiCounts[ami] || 0) + 1;
    }
}
const IMAGE_AMI = Object.entries(gpuImageAmiCounts).sort((a, b) => b[1] - a[1])[0][0];

const gpuTypes = Object.entries(instances)
    .filter(([, spec]) => spec.acceleratorType === 'cuda')
    .map(([type, spec]) => ({ type, spec, family: parseInstanceFamily(type) }));
const BLACKWELL = gpuTypes.find(t => /^Blackwell/.test(t.spec.gpuArchitecture || ''));
// A non-Blackwell GPU family AWS lists the image default for ("g5-class").
const KEEPS_IMAGE = gpuTypes.find(t => !/^Blackwell/.test(t.spec.gpuArchitecture || '') &&
    allowedFor(t.family).includes(IMAGE_AMI));
// A non-gpu (Trainium / Inferentia) family declared null in fleet-drivers.json.
const NON_GPU_FAMILY = Object.entries(fleet.instance_families).find(([, v]) => v === null)[0];
// An AMI AWS does not list for the Blackwell family.
const UNLISTED_FOR_BLACKWELL = amiNames.find(n => !allowedFor(BLACKWELL.family).includes(n));

describe('BL209: resolveInferenceAmi (AWS AMI table, fleet-drivers.json)', () => {
    it('derives the fixtures from the catalogs', () => {
        assert.ok(BLACKWELL, 'instances.json should contain a Blackwell instance');
        assert.ok(KEEPS_IMAGE, `some non-Blackwell GPU family should allow the image default ${IMAGE_AMI}`);
        assert.ok(UNLISTED_FOR_BLACKWELL, 'some AMI should be unlisted for the Blackwell family');
    });

    it('every Blackwell instance resolves to an AWS-listed AMI with driver major >= 570', () => {
        for (const t of gpuTypes.filter(g => /^Blackwell/.test(g.spec.gpuArchitecture || ''))) {
            const res = resolveInferenceAmi({ instanceType: t.type, imageAmi: IMAGE_AMI });
            assert.strictEqual(res.error, null);
            assert.ok(res.ami, `${t.type} resolved to no AMI`);
            assert.ok(allowedFor(t.family).includes(res.ami), `${res.ami} is not AWS-listed for ${t.family}`);
            assert.ok(driverMajor(res.ami) >= 570,
                `${t.type} (${t.spec.gpuArchitecture}) got ${res.ami} with driver ${fleet.ami_versions[res.ami].driver}; ` +
                'Blackwell needs CUDA 12.8+ (driver 570+)');
            if (!allowedFor(t.family).includes(IMAGE_AMI)) {
                assert.strictEqual(res.source, 'family');
            }
        }
    });

    it('a g5-class family keeps the image default when AWS lists it', () => {
        const res = resolveInferenceAmi({ instanceType: KEEPS_IMAGE.type, imageAmi: IMAGE_AMI });
        assert.strictEqual(res.ami, IMAGE_AMI);
        assert.strictEqual(res.source, 'image');
        assert.deepStrictEqual(res.warnings, []);
    });

    it('an unknown or empty family resolves to null (field omitted)', () => {
        for (const instanceType of ['ml.zz9.xlarge', 'not-an-instance', '', undefined]) {
            const res = resolveInferenceAmi({ instanceType, imageAmi: IMAGE_AMI });
            assert.strictEqual(res.ami, null, `${instanceType} should omit the AMI`);
            assert.strictEqual(res.error, null);
        }
        const nonGpu = resolveInferenceAmi({ instanceType: `ml.${NON_GPU_FAMILY}.xlarge`, imageAmi: IMAGE_AMI });
        assert.strictEqual(nonGpu.ami, null, 'a GPU image AMI must never be sent to a non-GPU family');
    });

    it('a user-set AMI AWS does not list for the family is kept with a loud warning', () => {
        const res = resolveInferenceAmi({ instanceType: BLACKWELL.type, userAmi: UNLISTED_FOR_BLACKWELL, imageAmi: IMAGE_AMI });
        assert.strictEqual(res.ami, UNLISTED_FOR_BLACKWELL);
        assert.strictEqual(res.source, 'user');
        assert.strictEqual(res.warnings.length, 1);
        assert.match(res.warnings[0], new RegExp(`not listed by AWS for ${BLACKWELL.family}`));
        assert.match(res.warnings[0], /docs\.aws\.amazon\.com/);
        const fixed = resolveInferenceAmi({ instanceType: BLACKWELL.type, imageAmi: IMAGE_AMI });
        assert.ok(res.warnings[0].includes(fixed.ami), 'the warning names the AMI to use instead');
    });

    it('a user-set AMI AWS lists for the family is kept silently', () => {
        const listed = allowedFor(BLACKWELL.family)[0];
        const res = resolveInferenceAmi({ instanceType: BLACKWELL.type, userAmi: listed, imageAmi: IMAGE_AMI });
        assert.strictEqual(res.ami, listed);
        assert.deepStrictEqual(res.warnings, []);
    });

    it('a pool mixing an image-default family with a Blackwell family resolves to an AMI both allow (driver >= 570)', () => {
        const res = resolveInferenceAmi({ instanceTypes: [KEEPS_IMAGE.type, BLACKWELL.type], imageAmi: IMAGE_AMI });
        assert.strictEqual(res.error, null);
        assert.ok(res.ami);
        assert.ok(allowedFor(KEEPS_IMAGE.family).includes(res.ami));
        assert.ok(allowedFor(BLACKWELL.family).includes(res.ami));
        assert.ok(driverMajor(res.ami) >= 570);
        assert.strictEqual(res.ami, fleet.instance_families[BLACKWELL.family].inference_ami_version);
    });

    it('a pool mixing a GPU family with a non-GPU family is an error', () => {
        const res = resolveInferenceAmi({ instanceTypes: [BLACKWELL.type, `ml.${NON_GPU_FAMILY}.xlarge`] });
        assert.match(res.error || '', /Cannot mix/);
        assert.ok(res.error.includes(BLACKWELL.type));
    });
});

describe('BL209: deploy-config-builder run() resolves the AMI for the chosen instance', function () {
    this.timeout(30000);
    let dir;
    let logs;
    let origLog;

    before(() => { dir = mkdtempSync(join(tmpdir(), 'mlcc-bl209-')); });
    after(() => { rmSync(dir, { recursive: true, force: true }); });

    async function build(vars) {
        const config = join(dir, 'config');
        const out = join(dir, 'out.json');
        const base = {
            PROJECT_NAME: 'bl209', DEPLOYMENT_CONFIG: 'transformers-vllm', DEPLOYMENT_TARGET: 'realtime-inference',
            ENDPOINT_STRATEGY: 'new', SMAI_ENDPOINT_NAME: 'bl209-ep', IC_GPU_COUNT: '1', AWS_REGION: 'us-east-1'
        };
        const lines = Object.entries({ ...base, ...vars }).map(([k, v]) => `export ${k}="${v}"`);
        writeFileSync(config, `${lines.join('\n')}\n`);
        logs = [];
        origLog = console.log;
        console.log = (...a) => { logs.push(a.join(' ')); };
        try {
            await run({ configFile: config, outputFile: out });
        } finally {
            console.log = origLog;
        }
        return JSON.parse(readFileSync(out, 'utf8'));
    }

    it('a Blackwell instance gets an AWS-listed AMI with driver major >= 570, not the image default', async () => {
        const answers = await build({ INSTANCE_TYPE: BLACKWELL.type });
        assert.ok(answers.inference_ami_version, `no AMI resolved: ${logs.join('\n')}`);
        assert.ok(allowedFor(BLACKWELL.family).includes(answers.inference_ami_version));
        assert.ok(driverMajor(answers.inference_ami_version) >= 570);
    });

    it('a g5-class instance keeps the image default', async () => {
        const answers = await build({ INSTANCE_TYPE: KEEPS_IMAGE.type });
        assert.ok(allowedFor(KEEPS_IMAGE.family).includes(answers.inference_ami_version));
        // The registry image default for transformers-vllm is what was kept.
        const vllmDefault = modelServers.vllm[0].defaults.inferenceAmiVersion;
        if (allowedFor(KEEPS_IMAGE.family).includes(vllmDefault)) {
            assert.strictEqual(answers.inference_ami_version, vllmDefault);
        }
    });

    it('an unknown instance family omits the AMI', async () => {
        const answers = await build({ INSTANCE_TYPE: 'ml.zz9.xlarge' });
        assert.ok(!('inference_ami_version' in answers));
    });

    it('a user-set incompatible AMI in do/config is kept and warned about loudly', async () => {
        const answers = await build({ INSTANCE_TYPE: BLACKWELL.type, INFERENCE_AMI_VERSION: UNLISTED_FOR_BLACKWELL });
        assert.ok(!('inference_ami_version' in answers), 'the do/config value is not overwritten');
        assert.ok(logs.some(l => l.includes('WARNING') && l.includes(UNLISTED_FOR_BLACKWELL)),
            `expected a warning naming ${UNLISTED_FOR_BLACKWELL}: ${logs.join('\n')}`);
    });

    it('a heterogeneous pool with a Blackwell family resolves one AMI every pool family allows', async () => {
        const answers = await build({ ENDPOINT_STRATEGY: 'heterogeneous', INSTANCE_TYPE: `${KEEPS_IMAGE.type},${BLACKWELL.type}` });
        assert.strictEqual(answers.instance_types, `${KEEPS_IMAGE.type},${BLACKWELL.type}`);
        const ami = answers.inference_ami_version;
        assert.ok(allowedFor(KEEPS_IMAGE.family).includes(ami) && allowedFor(BLACKWELL.family).includes(ami));
        assert.ok(driverMajor(ami) >= 570);
    });

    it('a pool mixing GPU and non-GPU families fails with a clear error', async () => {
        const answers = await build({ ENDPOINT_STRATEGY: 'heterogeneous', INSTANCE_TYPE: `${BLACKWELL.type},ml.${NON_GPU_FAMILY}.xlarge` });
        assert.match(answers.error || '', /Cannot mix/);
    });

    it('non-endpoint targets (descriptor family) do not resolve an AMI', async () => {
        const answers = await build({
            DEPLOYMENT_TARGET: 'batch-transform', INSTANCE_TYPE: BLACKWELL.type,
            BATCH_INPUT_PATH: 's3://b/in', BATCH_OUTPUT_PATH: 's3://b/out', BATCH_SPLIT_TYPE: 'Line', BATCH_STRATEGY: 'MultiRecord'
        });
        assert.ok(!('inference_ami_version' in answers));
    });
});

describe('BL209: Python twin (do/lib/python/inference_ami.py) agrees with the JS resolver', function () {
    this.timeout(30000);

    function runPython(cases, catalogPath = join(CATALOGS, 'fleet-drivers.json')) {
        const script = [
            'import json, sys',
            `sys.path.insert(0, ${JSON.stringify(PY_HELPER_DIR)})`,
            'import inference_ami as m',
            `cat = m.load_catalog(${JSON.stringify(catalogPath)})`,
            'out = [m.resolve(cat, c["types"], c.get("user"), c.get("image")) for c in json.load(sys.stdin)]',
            'print(json.dumps(out))'
        ].join('\n');
        const res = spawnSync('python3', ['-c', script], { input: JSON.stringify(cases), encoding: 'utf8' });
        assert.strictEqual(res.status, 0, res.stderr);
        return JSON.parse(res.stdout);
    }

    it('returns the same ami / source / error / warning count for every family x AMI combination', () => {
        const families = [...Object.keys(fleet.instance_families), 'p5en', 'zz9'];
        const amis = ['', ...amiNames, 'al2023-ami-sagemaker-inference-cpu-0'];
        const cases = [];
        for (const fam of families) {
            const type = `ml.${fam}.xlarge`;
            for (const ami of amis) {
                cases.push({ types: [type], user: ami, image: '' });
                cases.push({ types: [type], user: '', image: ami });
            }
            cases.push({ types: [type, BLACKWELL.type], user: '', image: IMAGE_AMI });
        }
        const py = runPython(cases);
        cases.forEach((c, i) => {
            const js = resolveInferenceAmi({ instanceTypes: c.types, userAmi: c.user, imageAmi: c.image });
            const label = JSON.stringify(c);
            assert.strictEqual(py[i].ami, js.ami, `ami differs for ${label}`);
            assert.strictEqual(py[i].source, js.source, `source differs for ${label}`);
            assert.strictEqual(py[i].error === null, js.error === null, `error differs for ${label}`);
            assert.strictEqual(py[i].warnings.length, js.warnings.length, `warnings differ for ${label}`);
            assert.deepStrictEqual(py[i].allowed, js.allowed, `allowed differs for ${label}`);
        });
    });

    it('fails a pool whose families share no AWS-listed AMI (fixture catalog)', () => {
        // Synthetic families — tests the intersection rule, not AWS data.
        const fixture = join(mkdtempSync(join(tmpdir(), 'mlcc-bl209-cat-')), 'fleet-drivers.json');
        writeFileSync(fixture, JSON.stringify({
            instance_families: { aa1: { driver: '1' }, bb1: { driver: '2' } },
            ami_versions: {
                'ami-a': { driver: '1', default_families: ['aa1'], override_families: [] },
                'ami-b': { driver: '2', default_families: ['bb1'], override_families: [] }
            }
        }));
        const [res] = runPython([{ types: ['ml.aa1.xlarge', 'ml.bb1.xlarge'] }], fixture);
        assert.match(res.error || '', /Cannot mix ml\.aa1\.xlarge and ml\.bb1\.xlarge/);
        rmSync(dirname(fixture), { recursive: true, force: true });
    });
});
