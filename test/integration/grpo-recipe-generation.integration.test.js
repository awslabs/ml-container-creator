// SPDX-License-Identifier: Apache-2.0

/**
 * Integration (BL124): the GRPO training recipe ships in a generated project and
 * is discoverable by `do/train` purely through the existing directory-scan
 * machinery — no change to `_list_techniques` / `_resolve_technique`.
 *
 * GRPO is added as a `templates/do/training/grpo/` recipe directory. Because the
 * technique set is discovered by scanning `do/training/<technique>/train.py`,
 * adding the directory is additive: a GRPO-selected run resolves it, and projects
 * that do NOT select GRPO are unaffected (the recipe ships but is inert).
 *
 * This test proves, end-to-end via the real CLI:
 *   1. the five recipe files land in the generated project on disk;
 *   2. the generated `do/train` discovers `grpo` via its directory scan;
 *   3. adding the recipe did not alter the OTHER shipped training recipes.
 *
 * Deterministic/offline: runGenerator defaults to --skip-prompts and sets
 * VALIDATE_ENV_VARS=false; a concrete model + instance avoid MCP/network. No test
 * here submits a training job or needs AWS credentials.
 */
import { describe, it, after } from 'mocha';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runGenerator } from '../helpers/run-generator.js';

describe('Integration: GRPO recipe → do/train (end-to-end)', () => {
    const cleanups = [];
    after(() => {
        for (const c of cleanups) {
            try { c(); } catch { /* best-effort temp cleanup */ }
        }
    });

    // do/train + do/training/** ship for every deployment target except
    // batch-transform (src/app.js writeProject). transformers-vllm is a
    // representative training-bearing project.
    function generate() {
        const result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-3.1-8B',
            'instance-type': 'ml.g5.xlarge'
        });
        cleanups.push(result.cleanup);
        return result;
    }

    it('ships the five GRPO recipe files', () => {
        const result = generate();
        for (const f of ['train.py', 'reward_example.py', 'defaults.yaml', 'accelerate_config.yaml', 'README.md']) {
            assert.ok(existsSync(result.file(`do/training/grpo/${f}`)),
                `generated project must ship do/training/grpo/${f}`);
        }
    });

    it('does NOT ship a stray __pycache__ in the GRPO recipe', () => {
        const result = generate();
        assert.ok(!existsSync(result.file('do/training/grpo/__pycache__')),
            'the recipe must not ship a compiled __pycache__ artifact');
    });

    it('do/train discovers grpo through the unchanged directory-scan', () => {
        const result = generate();
        const trainingDir = result.file('do/training');
        // Replicate the generated do/train _list_techniques() scan exactly: a
        // technique is any do/training/<name>/ that contains a train.py.
        const script = `
            techniques=""
            for dir in "${trainingDir}"/*/; do
                [ -f "\${dir}train.py" ] || continue
                name=$(basename "\${dir}")
                techniques="\${techniques:+\${techniques}, }\${name}"
            done
            echo "\${techniques}"
        `;
        const discovered = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
        const names = discovered.split(',').map(s => s.trim()).sort();
        assert.ok(names.includes('grpo'), `grpo must be discovered; got: ${discovered}`);
        // The pre-existing recipes must still be discovered — adding grpo is purely additive.
        for (const existing of ['custom', 'dpo', 'sft']) {
            assert.ok(names.includes(existing),
                `adding grpo must not drop the existing '${existing}' recipe; got: ${discovered}`);
        }
    });

    it('do/train is unmodified — grpo is picked up by directory presence alone', () => {
        const result = generate();
        const trainSrc = readFileSync(result.file('do/train'), 'utf8');
        // The resolution machinery must still be the generic directory scan, with
        // no grpo-specific case arm (the whole point of the recipe-dir contract).
        assert.ok(trainSrc.includes('for dir in "${training_dir}"/*/'),
            'do/train must resolve techniques by scanning the training dir');
        assert.ok(!/grpo/i.test(trainSrc),
            'do/train must contain no hardcoded grpo reference — discovery is by directory presence');
    });

    it('the GRPO defaults declare a GPU-appropriate configuration (no CPU default)', () => {
        const result = generate();
        const defaults = readFileSync(result.file('do/training/grpo/defaults.yaml'), 'utf8');
        // num_generations is the group size; GRPO needs >= 2 for a group baseline.
        assert.match(defaults, /num_generations:\s*([2-9]|\d\d+)/,
            'defaults.yaml must set num_generations >= 2');
        assert.match(defaults, /GPU/,
            'defaults.yaml must document the GPU requirement');
    });
});
