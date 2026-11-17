// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Contract test (derive-dont-hardcode rule 4, BL241): the do/deploy Python
 * helper (templates/do/lib/python/mcp_client.py mcp_recommend_instance) reads
 * the instance-sizer's response, which is produced by
 * servers/instance-sizer/index.js handleGetInstanceRecommendation. BL241 was
 * the two drifting apart silently: the client looked for an `instance_type`
 * key the server never returns, so every MCP recommendation was discarded.
 *
 * This drives the REAL server through the REAL Python subprocess transport
 * (offline: --no-discover) and asserts that what the client extracts equals
 * what the server put on the wire, for a sized model and an unsizable one.
 * If either side renames a key, this fails.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY_DIR = join(ROOT, 'templates', 'do', 'lib', 'python');
const SERVER = join(ROOT, 'servers', 'instance-sizer', 'index.js');

// Any shipped-catalog model with a size (picked from the catalog, not pinned).
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'servers', 'lib', 'catalogs', 'model-sizes.json'), 'utf8'));
const SIZED_MODEL = Object.entries(CATALOG.models)
    .find(([key, m]) => m.parameterCount > 0 && /^[^*]+\*?$/.test(key))[0].replace(/\*$/, '');
// Clearly synthetic; not in any catalog, and discovery is off.
const UNSIZABLE_MODEL = 'contract-test-org/not-a-real-model';

function runPython() {
    const script = [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(PY_DIR)})`,
        'import mcp_client as m',
        'cfg = {"mcpServers": {"instance-sizer": {"command": sys.argv[1], "args": [sys.argv[2], "--no-discover"]}}}',
        'c = m.MCPClient(transport="subprocess", server_config=cfg)',
        'out = {}',
        'for model in sys.argv[3:]:',
        '    raw = m.call_tool(c, "instance-sizer/recommend", {"model": model})',
        '    rec = m.mcp_recommend_instance(c, model, "float16")',
        '    out[model] = {"raw": raw, "rec": rec}',
        'print(json.dumps(out))'
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script, process.execPath, SERVER, SIZED_MODEL, UNSIZABLE_MODEL], {
        encoding: 'utf8',
        env: { ...process.env, DISCOVER_MODE: 'false', BEDROCK_SMART: 'false' },
        timeout: 60000
    }));
}

describe('instance-sizer response <-> mcp_client.mcp_recommend_instance contract (BL241)', function () {
    this.timeout(90000);
    let out;
    before(() => {
        out = runPython();
    });

    it('the Python subprocess transport reaches the real server and returns its payload', () => {
        const raw = out[SIZED_MODEL].raw;
        assert.ok(raw && typeof raw === 'object', 'call_tool returned the unwrapped tool payload');
        assert.ok(raw.values && 'instanceType' in raw.values, 'server payload has values.instanceType');
        assert.ok(raw.choices && Array.isArray(raw.choices.instanceType), 'server payload has choices.instanceType[]');
        assert.ok(raw.metadata && Array.isArray(raw.metadata.recommendations), 'server payload has metadata.recommendations[]');
    });

    it('sized model: the client returns exactly the server recommendation', () => {
        const { raw, rec } = out[SIZED_MODEL];
        assert.ok(raw.values.instanceType, `server sized ${SIZED_MODEL}`);
        assert.ok(rec, 'client did not fall back');
        assert.strictEqual(rec.instance_type, raw.values.instanceType);
        assert.deepStrictEqual(rec.instances, raw.choices.instanceType);
        assert.strictEqual(rec.gpu_count, raw.metadata.recommendations[0].gpuCount);
        assert.strictEqual(rec.sizing_unavailable, false);
    });

    it('unsizable model: the client reports sizing unavailable with the server message, no recommendation', () => {
        const { raw, rec } = out[UNSIZABLE_MODEL];
        assert.strictEqual(raw.values.instanceType, null);
        assert.strictEqual(raw.metadata.sizingUnavailable, true);
        assert.ok(rec, 'a server answer is not an MCP failure');
        assert.strictEqual(rec.instance_type, null);
        assert.strictEqual(rec.sizing_unavailable, true);
        assert.strictEqual(rec.message, raw.metadata.error);
        assert.match(rec.message, /--instance-type/);
    });
});
