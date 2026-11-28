// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Agent / Bedrock model-ID drift guard (improvement plan CLI-3; derive-don't-hardcode rule 4).
 *
 * config/agent.json is the single source for the advisory agent's model ID and
 * MCP server list. Code fallbacks exist (the agent must start even without the
 * file, and the MCP servers are self-contained packages), so they are duplicates
 * by necessity — this test makes them conformance-checked instead of silent:
 *
 *   - src/agent/config_loader.py _DEFAULTS (model_id, mcp_servers) == agent.json
 *   - servers/reasoning DEFAULT_REASONING_CONFIG.modelId == agent.json reasoning.modelId
 *   - every other hardcoded Bedrock default (picker factory, instance-sizer,
 *     do/optimize engine) == agent.json modelId
 *   - every Bedrock model ID carries an inference-profile prefix (global./us./eu./apac.)
 *     — newer Claude models cannot be invoked on-demand by bare foundation-model ID
 *   - every configured MCP server exists and ships in the npm package
 *
 * Before this guard the four copies named three different models, one ID lacked
 * its `-v1:0` suffix, and two lacked an inference-profile prefix.
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const agent = JSON.parse(read('config/agent.json'));
const PROFILE_PREFIX = /^(global|us|eu|apac)\.anthropic\./;

function pyDefault() {
    const src = read('src/agent/config_loader.py');
    const block = src.slice(src.indexOf('_DEFAULTS = AgentConfig('));
    return block;
}

describe('agent config drift (config/agent.json is the source)', () => {
    it('agent.json model IDs use an inference-profile prefix', () => {
        assert.match(agent.modelId, PROFILE_PREFIX);
        assert.match(agent.reasoning.modelId, PROFILE_PREFIX);
    });

    it('config_loader.py fallback model_id matches agent.json', () => {
        const m = pyDefault().match(/model_id="([^"]+)"/);
        assert.ok(m, 'model_id default not found');
        assert.strictEqual(m[1], agent.modelId);
    });

    it('config_loader.py fallback mcp_servers matches agent.json mcpServers', () => {
        const m = pyDefault().match(/mcp_servers=\[([\s\S]*?)\]/);
        assert.ok(m, 'mcp_servers default not found');
        const list = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        assert.deepStrictEqual(list, agent.mcpServers);
    });

    it('reasoning server default matches agent.json reasoning.modelId', () => {
        const m = read('servers/reasoning/index.js').match(/DEFAULT_REASONING_CONFIG = \{[\s\S]*?modelId: '([^']+)'/);
        assert.ok(m);
        assert.strictEqual(m[1], agent.reasoning.modelId);
    });

    it('hardcoded Bedrock defaults elsewhere match agent.json modelId', () => {
        const sites = {
            'servers/lib/create-picker-server.js': /DEFAULT_BEDROCK_MODEL = '([^']+)'/,
            'servers/instance-sizer/index.js': /BEDROCK_MODEL = process\.env\.BEDROCK_MODEL \|\| '([^']+)'/,
            'templates/do/.optimize_engine.py': /model_id = '([^']+anthropic[^']+)'/
        };
        for (const [file, re] of Object.entries(sites)) {
            const m = read(file).match(re);
            assert.ok(m, `${file}: default not found`);
            assert.strictEqual(m[1], agent.modelId, `${file} drifted from config/agent.json`);
        }
    });

    it('every configured MCP server exists and is published', () => {
        const files = JSON.parse(read('package.json')).files;
        for (const name of agent.mcpServers) {
            assert.ok(existsSync(join(ROOT, 'servers', name, 'index.js')), `servers/${name}/index.js missing`);
            assert.ok(files.includes(`servers/${name}/index.js`), `servers/${name}/index.js not in package.json files`);
        }
    });
});
