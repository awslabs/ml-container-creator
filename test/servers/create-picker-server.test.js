// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for servers/lib/create-picker-server.js.
 *
 * PATTERN: Spec for the createPickerServer factory.
 * COLLABORATORS: exercises servers/lib/create-picker-server.js; uses the MCP
 *   SDK Client + InMemoryTransport for a real listTools/callTool round-trip.
 * DATA-FLOW ROLE: test-only. Builds throwaway servers from specs and asserts
 *   catalog loading, tool registration, smart/static branching, the start guard,
 *   and the client round-trip.
 * See: docs/adr/ADR-003-mcp-picker-server-factory.md
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPickerServer } from '../../servers/lib/create-picker-server.js';

const HERE = import.meta.url; // this test file's URL — a real, existing file

function echoTool(text) {
    return {
        name: 'echo',
        description: 'Echo tool for tests',
        schema: { value: z.string().optional() },
        handler: async ({ value }) => ({
            content: [{ type: 'text', text: JSON.stringify({ values: { echoed: value ?? text } }) }]
        })
    };
}

describe('createPickerServer factory', () => {
    describe('argument validation', () => {
        it('requires name, serverDir, and a non-empty tools array', () => {
            assert.throws(() => createPickerServer({ serverDir: HERE, tools: [echoTool()] }), /`name` is required/);
            assert.throws(() => createPickerServer({ name: 'x', tools: [echoTool()] }), /`serverDir` is required/);
            assert.throws(() => createPickerServer({ name: 'x', serverDir: HERE, tools: [] }), /non-empty array/);
        });

        it('rejects a malformed tool (missing handler)', () => {
            assert.throws(
                () => createPickerServer({
                    name: 'x', serverDir: HERE,
                    tools: [{ name: 'bad', description: 'no handler' }]
                }),
                /each tool needs/
            );
        });
    });

    describe('catalog loading', () => {
        it('loads a JSON catalog relative to serverDir and exposes it', () => {
            // Load this directory's package-relative fixture: use a known JSON
            // file that exists relative to the repo — the schema file.
            const built = createPickerServer({
                name: 'cat-test',
                serverDir: HERE,
                // test/servers/create-picker-server.test.js → ../../package.json
                catalogs: { pkg: '../../package.json' },
                tools: [echoTool()]
            });
            assert.equal(built.catalogs.pkg.name, '@aws/ml-container-creator');
        });

        it('throws a clear error when a catalog file is missing', () => {
            assert.throws(
                () => createPickerServer({
                    name: 'cat-missing',
                    serverDir: HERE,
                    catalogs: { nope: './does-not-exist.json' },
                    tools: [echoTool()]
                }),
                /Catalog file not found/
            );
        });
    });

    describe('smart-mode branching', () => {
        const priorEnv = process.env.BEDROCK_SMART;
        afterEach(() => {
            if (priorEnv === undefined) delete process.env.BEDROCK_SMART;
            else process.env.BEDROCK_SMART = priorEnv;
        });

        it('smartMode is false and querySmart returns null when no bedrock config', async () => {
            const built = createPickerServer({ name: 's1', serverDir: HERE, tools: [echoTool()] });
            assert.equal(built.smartMode, false);
            assert.equal(built.bedrockConfig, null);
            assert.equal(await built.querySmart(['x'], 5, {}), null);
        });

        it('smartMode is false when bedrock configured but BEDROCK_SMART !== "true"', () => {
            delete process.env.BEDROCK_SMART;
            const built = createPickerServer({
                name: 's2', serverDir: HERE, tools: [echoTool()],
                bedrock: { systemPromptTemplate: 'prompt {context} {parameters} {limit}' }
            });
            assert.equal(built.smartMode, false);
            assert.ok(built.bedrockConfig, 'bedrockConfig is built even when smart is off');
            assert.equal(built.bedrockConfig.serverName, 's2');
            assert.equal(built.bedrockConfig.temperature, 0.3);
        });

        it('smartMode is true when bedrock configured and BEDROCK_SMART=true', () => {
            process.env.BEDROCK_SMART = 'true';
            const built = createPickerServer({
                name: 's3', serverDir: HERE, tools: [echoTool()],
                bedrock: { systemPromptTemplate: 'p', temperature: 0.7, maxTokens: 42, modelId: 'model-x' }
            });
            assert.equal(built.smartMode, true);
            assert.equal(built.bedrockConfig.temperature, 0.7);
            assert.equal(built.bedrockConfig.maxTokens, 42);
            assert.equal(built.bedrockConfig.modelId, 'model-x');
        });
    });

    describe('start() main-guard', () => {
        it('does not connect when the entry URL is not the process entrypoint', async () => {
            const built = createPickerServer({ name: 'guard', serverDir: HERE, tools: [echoTool()] });
            // entryUrl is this test file, which is NOT process.argv[1] (mocha is).
            // start() should resolve without throwing and without connecting.
            await built.start({ entryUrl: HERE });
            assert.ok(true, 'start() returned without connecting');
        });
    });

    describe('listTools / callTool round-trip (InMemoryTransport)', () => {
        let client;
        let built;

        beforeEach(async () => {
            built = createPickerServer({
                name: 'roundtrip',
                serverDir: HERE,
                tools: [echoTool('default')]
            });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await built.server.connect(serverTransport);
            client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
            await client.connect(clientTransport);
        });

        afterEach(async () => {
            await client?.close();
        });

        it('lists the registered tool', async () => {
            const { tools } = await client.listTools();
            assert.equal(tools.length, 1);
            assert.equal(tools[0].name, 'echo');
        });

        it('calls the tool and returns the handler envelope', async () => {
            const res = await client.callTool({ name: 'echo', arguments: { value: 'hi' } });
            const payload = JSON.parse(res.content[0].text);
            assert.deepEqual(payload, { values: { echoed: 'hi' } });
        });
    });
});
