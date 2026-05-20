/**
 * E2E Summary Aggregator
 *
 * Pure function module that transforms raw e2e run results into
 * formatted output (JSON and markdown).
 */

/**
 * Aggregates an array of ConfigResult objects into a RunResult.
 *
 * @param {Array<{id: string, status: 'pass'|'fail', duration: number, error?: string, steps: Array}>} results
 * @param {{runId: string, tier: string, startTime: number}} meta
 * @returns {{runId: string, tier: string, duration: number, passed: number, failed: number, results: Array}}
 */
export function aggregateResults(results, meta) {
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const duration = Date.now() - meta.startTime;

    return {
        runId: meta.runId,
        tier: meta.tier,
        duration,
        passed,
        failed,
        results
    };
}

/**
 * Formats a RunResult as a markdown summary with tables.
 *
 * @param {{runId: string, tier: string, duration: number, passed: number, failed: number, results: Array}} runResult
 * @returns {string}
 */
export function formatMarkdown(runResult) {
    const lines = [];

    lines.push('# E2E Run Summary');
    lines.push('');
    lines.push(`**Run ID:** ${runResult.runId}`);
    lines.push(`**Tier:** ${runResult.tier}`);
    lines.push(`**Duration:** ${formatDuration(runResult.duration)}`);
    lines.push('');

    // Summary table
    lines.push('## Results');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Tier | ${runResult.tier} |`);
    lines.push(`| Passed | ${runResult.passed} |`);
    lines.push(`| Failed | ${runResult.failed} |`);
    lines.push(`| Total | ${runResult.passed + runResult.failed} |`);
    lines.push('');

    // Per-config table
    lines.push('## Per-Config Results');
    lines.push('');
    lines.push('| ID | Status | Duration |');
    lines.push('|----|--------|----------|');

    for (const config of runResult.results) {
        const statusIcon = config.status === 'pass' ? '✅' : '❌';
        lines.push(`| ${config.id} | ${statusIcon} ${config.status} | ${formatDuration(config.duration)} |`);
    }

    lines.push('');

    // Per-step details for each config
    lines.push('## Step Details');
    lines.push('');

    for (const config of runResult.results) {
        lines.push(`### ${config.id}`);
        lines.push('');
        lines.push('| Step | Status | Duration |');
        lines.push('|------|--------|----------|');

        for (const step of config.steps) {
            const stepIcon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : '⏭️';
            lines.push(`| ${step.name} | ${stepIcon} ${step.status} | ${formatDuration(step.duration)} |`);
        }

        if (config.error) {
            lines.push('');
            lines.push(`**Error:** ${config.error}`);
        }

        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Formats a RunResult as a JSON string.
 *
 * @param {{runId: string, tier: string, duration: number, passed: number, failed: number, results: Array}} runResult
 * @returns {string}
 */
export function formatJSON(runResult) {
    return JSON.stringify(runResult, null, 4);
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string}
 */
function formatDuration(ms) {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}
