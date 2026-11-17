// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * BL203 — CUDA / GPU-driver catalog CONFORMANCE.
 *
 * CUDA/driver compatibility is enforced at project generation by
 * servers/lib/image-filter.js (base-image picker + src/lib/dlc-resolver.js),
 * which reads servers/lib/catalogs/fleet-drivers.json. That only works if the
 * catalogs agree with each other. This test asserts, deriving every set from
 * the catalog data itself (no hardcoded family / engine lists):
 *
 *   1. Every GPU instance family in instances.json (acceleratorType 'cuda' or
 *      a gpuMemoryGb figure) — family derived with image-filter's own
 *      parseInstanceFamily — has a non-null fleet-drivers.json
 *      instance_families entry with a driver. Without it the driver filter is
 *      silently skipped and DLC-direct hard-fails.
 *   2. parseInstanceFamily agrees with the instance's declared `family`
 *      (guards hyphenated families such as p6-b200).
 *   3. Every GPU model-server image (accelerator.type 'cuda') in
 *      model-servers.json carries min_driver_version; images without it pass
 *      the driver filter unconditionally. CPU images are excluded by data.
 *   4. Every inference_ami_version a family entry names resolves in
 *      fleet-drivers.json ami_versions.
 *   5. BL209: every GPU family resolves (resolveInferenceAmi, with every GPU
 *      image's default AMI) to an AMI AWS lists for that family, and the
 *      AWS allow-list data (default_families / override_families) is
 *      self-consistent.
 *
 * Known gaps (GPU images that pre-date min_driver_version) are listed in
 * KNOWN_MISSING_MIN_DRIVER and SKIPPED with a reason rather than given
 * invented values. The ledger is conformance-checked: an entry that gains
 * min_driver_version or leaves the catalog fails until it is removed, so the
 * list can only shrink.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInstanceFamily, resolveInferenceAmi } from '../../servers/lib/image-filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOGS = resolve(__dirname, '..', '..', 'servers', 'lib', 'catalogs');
const load = (name) => JSON.parse(readFileSync(join(CATALOGS, name), 'utf8'));

const instances = load('instances.json').catalog;
const modelServers = load('model-servers.json');
const fleet = load('fleet-drivers.json');

/**
 * GPU model-server images that have no min_driver_version yet (found by BL203,
 * 2026-10-26). Deriving one from labels.cuda_version would change which images
 * the driver filter excludes on older-driver families (a product decision), so
 * they are skipped, not back-filled. To re-enable: add a sourced
 * min_driver_version to the image in model-servers.json and delete its line.
 */
const KNOWN_MISSING_MIN_DRIVER = new Set([
    'tensorrt-llm@1.2.0rc8',
    'tensorrt-llm@1.1.0',
    'lmi@0.32.0-lmi14.0.0-cu126',
    'lmi@0.31.0-lmi13.0.0-cu124',
    'djl@0.36.0-pytorch-gpu',
    'djl@0.35.0-pytorch-gpu',
    'vllm-omni@v0.16.0',
    'vllm-omni@v0.14.0',
    'triton-fil@24.08',
    'triton-onnxruntime@24.08',
    'triton-tensorflow@24.08',
    'triton-pytorch@24.08',
    'triton-vllm@24.08',
    'triton-tensorrtllm@24.08',
    'triton-python@24.08',
    'llama-cpp@server-sagemaker-cuda-v1'
]);
const MISSING_MIN_DRIVER_REASON =
    'BL203 known gap: GPU image predates min_driver_version; no sourced value yet ' +
    '(see KNOWN_MISSING_MIN_DRIVER for re-enable steps)';

const isGpuInstance = (spec) =>
    spec.acceleratorType === 'cuda' || typeof spec.gpuMemoryGb === 'number';
const isGpuImage = (img) => Boolean(img.accelerator) && img.accelerator.type === 'cuda';
const imageKey = (engine, img) => `${engine}@${img.tag}`;

// Data-derived sets.
const gpuInstanceTypes = Object.entries(instances).filter(([, spec]) => isGpuInstance(spec));
const gpuFamilies = [...new Set(gpuInstanceTypes.map(([type]) => parseInstanceFamily(type)))];
const allImages = Object.entries(modelServers)
    .filter(([, list]) => Array.isArray(list))
    .flatMap(([engine, list]) => list.map((img) => ({ engine, img })));
const gpuImages = allImages.filter(({ img }) => isGpuImage(img));

function skip(ctx, reason) {
    // Mocha's skip has no reason argument; record it on the test title so it
    // shows up in the reporter output.
    ctx.test.title += ` [SKIPPED: ${reason}]`;
    ctx.skip();
}

describe('BL203 catalog driver conformance', () => {
    it('derives a non-empty GPU instance and GPU image set from the catalogs', () => {
        assert.ok(gpuInstanceTypes.length > 0, 'instances.json should contain GPU instances');
        assert.ok(gpuImages.length > 0, 'model-servers.json should contain GPU images');
    });

    describe('instances.json GPU families ↔ fleet-drivers.json instance_families', () => {
        for (const [type, spec] of gpuInstanceTypes) {
            it(`${type}: parseInstanceFamily matches the declared family`, () => {
                const family = parseInstanceFamily(type);
                assert.ok(family, `parseInstanceFamily could not parse ${type}`);
                if (spec.family) {
                    assert.strictEqual(family, spec.family,
                        `parseInstanceFamily('${type}') = '${family}' but instances.json says '${spec.family}'`);
                }
            });
        }

        for (const family of gpuFamilies) {
            it(`GPU family '${family}' has a fleet driver`, () => {
                assert.ok(family, 'every GPU instance type must parse to a family');
                const entry = fleet.instance_families[family];
                assert.ok(entry,
                    `GPU family '${family}' is in instances.json but has no non-null ` +
                    'fleet-drivers.json instance_families entry — the driver filter is ' +
                    'skipped for it and DLC-direct hard-fails');
                assert.match(String(entry.driver), /^\d+(\.\d+)*$/,
                    `fleet-drivers.json '${family}'.driver must be a dotted version`);
                assert.match(String(entry.cuda_native), /^\d+\.\d+$/,
                    `fleet-drivers.json '${family}'.cuda_native must be major.minor`);
            });
        }
    });

    describe('model-servers.json GPU images carry min_driver_version', () => {
        it('excludes CPU images by accelerator data', () => {
            const cpu = allImages.filter(({ img }) => img.accelerator && img.accelerator.type === 'cpu');
            for (const { engine, img } of cpu) {
                assert.ok(!gpuImages.some((g) => g.img === img),
                    `${imageKey(engine, img)} is a CPU image and must not be treated as GPU`);
            }
        });

        for (const { engine, img } of gpuImages) {
            const key = imageKey(engine, img);
            it(`${key} has min_driver_version`, function () {
                if (!img.min_driver_version && KNOWN_MISSING_MIN_DRIVER.has(key)) {
                    return skip(this, MISSING_MIN_DRIVER_REASON);
                }
                assert.ok(img.min_driver_version,
                    `GPU image ${key} has no min_driver_version — it passes the driver ` +
                    'filter on every instance family');
                assert.match(String(img.min_driver_version), /^\d+(\.\d+)*$/,
                    `${key} min_driver_version must be a dotted version`);
            });
        }

        it('KNOWN_MISSING_MIN_DRIVER only lists GPU images that still lack min_driver_version', () => {
            const byKey = new Map(gpuImages.map(({ engine, img }) => [imageKey(engine, img), img]));
            const stale = [...KNOWN_MISSING_MIN_DRIVER].filter((key) => {
                const img = byKey.get(key);
                return !img || Boolean(img.min_driver_version);
            });
            assert.deepStrictEqual(stale, [],
                'Remove these from KNOWN_MISSING_MIN_DRIVER (fixed or no longer in the catalog)');
        });
    });

    describe('AMI versions resolve in fleet-drivers.json ami_versions', () => {
        for (const [family, entry] of Object.entries(fleet.instance_families)) {
            if (!entry || !entry.inference_ami_version) continue;
            it(`family '${family}' inference_ami_version resolves and agrees on driver major`, () => {
                const ami = fleet.ami_versions[entry.inference_ami_version];
                assert.ok(ami, `'${family}' names unknown AMI '${entry.inference_ami_version}'`);
                // The family's driver comes from that AMI, so they must agree on the major.
                assert.strictEqual(String(entry.driver).split('.')[0], String(ami.driver).split('.')[0],
                    `'${family}' driver ${entry.driver} disagrees with AMI ${entry.inference_ami_version} driver ${ami.driver}`);
            });
        }
    });

    describe('BL209: every GPU family resolves to an AWS-listed AMI', () => {
        const amiEntries = Object.entries(fleet.ami_versions)
            .filter(([name, entry]) => !name.startsWith('_') && entry && typeof entry === 'object');
        const listedFor = (ami) => {
            const entry = fleet.ami_versions[ami] || {};
            return [...(entry.default_families || []), ...(entry.override_families || [])];
        };
        const driverMajor = (ami) => Number(String(fleet.ami_versions[ami].driver).split('.')[0]);
        const gpuImageAmis = [...new Set(gpuImages
            .map(({ img }) => img.defaults && img.defaults.inferenceAmiVersion)
            .filter(Boolean))];

        it('every AMI entry carries a sourced AWS allow-list', () => {
            assert.ok(amiEntries.length > 0);
            for (const [name, entry] of amiEntries) {
                assert.ok(Array.isArray(entry.default_families) && Array.isArray(entry.override_families),
                    `${name} needs default_families and override_families (AWS inference-gpu-drivers table)`);
                assert.ok(entry.default_families.length + entry.override_families.length > 0,
                    `${name} lists no instance family`);
                assert.match(String(entry._source || ''), /docs\.aws\.amazon\.com/,
                    `${name} allow-list must cite the AWS doc in _source`);
                const both = entry.default_families.filter(f => entry.override_families.includes(f));
                assert.deepStrictEqual(both, [], `${name} lists ${both} as both default and override`);
            }
        });

        it('every GPU image default AMI is a known ami_versions entry', () => {
            assert.ok(gpuImageAmis.length > 0, 'model-servers.json GPU images should declare a default AMI');
            for (const ami of gpuImageAmis) {
                assert.ok(fleet.ami_versions[ami], `GPU image default AMI '${ami}' is not in ami_versions`);
            }
        });

        it('no family is the AWS default of two different driver generations', () => {
            const defaultsByFamily = {};
            for (const [name, entry] of amiEntries) {
                for (const fam of entry.default_families) {
                    (defaultsByFamily[fam] = defaultsByFamily[fam] || new Set()).add(driverMajor(name));
                }
            }
            for (const [fam, majors] of Object.entries(defaultsByFamily)) {
                assert.strictEqual(majors.size, 1,
                    `family '${fam}' is the default of AMIs with driver majors ${[...majors]} — one AWS row only`);
            }
        });

        for (const [family, entry] of Object.entries(fleet.instance_families)) {
            if (!entry || !entry.inference_ami_version) continue;
            it(`family '${family}' inference_ami_version is its AWS default AMI`, () => {
                const ami = fleet.ami_versions[entry.inference_ami_version];
                assert.ok(ami && (ami.default_families || []).includes(family),
                    `'${family}' names ${entry.inference_ami_version} but that AMI does not list it as a default family`);
            });
        }

        for (const family of gpuFamilies) {
            const type = gpuInstanceTypes.find(([t]) => parseInstanceFamily(t) === family)[0];
            it(`GPU family '${family}' resolves to an AWS-listed AMI for every GPU image default`, () => {
                const allowed = amiEntries.filter(([name]) => listedFor(name).includes(family)).map(([name]) => name);
                assert.ok(allowed.length > 0,
                    `AWS lists no InferenceAmiVersion for '${family}' in fleet-drivers.json ami_versions`);
                for (const imageAmi of gpuImageAmis) {
                    const res = resolveInferenceAmi({ instanceType: type, imageAmi });
                    assert.strictEqual(res.error, null);
                    assert.ok(res.ami, `${type} with image AMI ${imageAmi} resolved to no AMI`);
                    assert.ok(allowed.includes(res.ami),
                        `${type} resolved to ${res.ami}, which AWS does not list for '${family}' (allowed: ${allowed})`);
                    if (allowed.includes(imageAmi)) {
                        assert.strictEqual(res.ami, imageAmi, 'an AWS-listed image default must be kept');
                    }
                }
            });
        }
    });
});
