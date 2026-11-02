// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Docs inventory drift guard (derive-don't-hardcode, rule 4).
 *
 * A few user docs keep a hand-written list of things that have a single source
 * of truth in code: the bundled MCP servers (servers/<name>/ with an MCP SDK
 * dependency), the deployment targets (templates/do/targets.d/), and the
 * deployment configs (DeploymentConfigResolver). These checks fail loudly when
 * one of those sets changes and the doc list is not updated, instead of letting
 * the docs drift quietly.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listTargets } from '../../src/lib/target-manifest-reader.js';
import DeploymentConfigResolver from '../../src/lib/deployment-config-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Bundled MCP servers, discovered the same way `mcp --bundled list` does. */
function bundledServers() {
    const dir = path.join(ROOT, 'servers');
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .filter(e => {
            const pkg = path.join(dir, e.name, 'package.json');
            if (!fs.existsSync(pkg)) return false;
            const deps = JSON.parse(fs.readFileSync(pkg, 'utf8')).dependencies || {};
            return Boolean(deps['@modelcontextprotocol/sdk']);
        })
        .map(e => e.name)
        .sort();
}

/** Text between a `## <heading>` line and the next `## ` heading. */
function section(text, heading) {
    const start = text.indexOf(`\n## ${heading}\n`);
    assert.ok(start >= 0, `missing "## ${heading}" section`);
    const rest = text.slice(start + heading.length + 5);
    const end = rest.search(/\n## /);
    return end >= 0 ? rest.slice(0, end) : rest;
}

describe('Docs inventory drift', () => {
    const servers = bundledServers();

    it('finds the bundled MCP servers', () => {
        assert.ok(servers.length > 0);
    });

    it('docs/mcp-configuration.md has one section per bundled MCP server', () => {
        const bundled = section(read('docs/mcp-configuration.md'), 'Bundled Servers');
        const documented = [...bundled.matchAll(/^### ([a-z0-9-]+)\s*$/gm)].map(m => m[1]).sort();
        assert.deepStrictEqual(documented, servers);
    });

    it('docs/dev/mcp-server-development.md server table lists every bundled MCP server', () => {
        const table = section(read('docs/dev/mcp-server-development.md'), 'Bundled Servers');
        const rows = [...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(m => m[1]).sort();
        assert.deepStrictEqual(rows, servers);
    });

    for (const doc of ['README.md', 'docs/index.md', 'docs/how-it-works.md']) {
        it(`${doc} names every deployment target from targets.d`, () => {
            const text = read(doc);
            for (const target of listTargets()) {
                assert.ok(text.includes(`\`${target}\``), `${doc} does not mention \`${target}\``);
            }
        });
    }

    it('docs/configuration.md Deployment Configs table matches DeploymentConfigResolver', () => {
        const text = read('docs/configuration.md');
        const start = text.indexOf('### Deployment Configs');
        const end = text.indexOf('### Serving Engine Capabilities');
        const rows = [...text.slice(start, end).matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map(m => m[1]).sort();
        assert.deepStrictEqual(rows, new DeploymentConfigResolver().getAllConfigs().sort());
    });
});
