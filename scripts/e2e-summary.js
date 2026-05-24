/**
 * E2E Summary Aggregator
 *
 * Pure function module that transforms raw e2e run results into
 * formatted output (JSON and markdown), and handles artifact persistence
 * (S3 upload with local fallback).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Aggregates an array of ConfigResult objects into a RunResult.
 *
 * @param {Array<{id: string, status: 'pass'|'fail', duration: number, error?: string, steps: Array}>} results
 * @param {{runId: string, tier: string, startTime: number}} meta
 * @returns {{runId: string, tier: string, timestamp: string, duration: number, passed: number, failed: number, results: Array}}
 */
export function aggregateResults(results, meta) {
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const duration = Date.now() - meta.startTime;

    return {
        runId: meta.runId,
        tier: meta.tier,
        timestamp: new Date().toISOString(),
        duration,
        passed,
        failed,
        results
    };
}

/**
 * Formats a RunResult as a JSON string with 2-space indentation.
 *
 * Serializes the full run result including runId, tier, duration,
 * passed/failed counts, and per-config results with per-step details.
 *
 * @param {{runId: string, tier: string, duration: number, passed: number, failed: number, results: Array}} runResult
 * @returns {string}
 */
export function formatJSON(runResult) {
    return JSON.stringify(runResult, null, 2);
}

/**
 * Formats a RunResult as a markdown summary with tables.
 *
 * Includes:
 * - Run metadata (tier, timestamp, duration)
 * - Pass/fail counts
 * - Per-config results table (id, status, duration)
 * - Failure details (stage name, error summary)
 *
 * @param {{runId: string, tier: string, timestamp?: string, duration: number, passed: number, failed: number, results: Array}} runResult
 * @returns {string}
 */
export function formatMarkdown(runResult) {
    const lines = [];

    lines.push('# E2E Run Summary');
    lines.push('');
    lines.push(`**Run ID:** ${runResult.runId}`);
    lines.push(`**Tier:** ${runResult.tier}`);
    lines.push(`**Timestamp:** ${runResult.timestamp || new Date().toISOString()}`);
    lines.push(`**Duration:** ${formatDuration(runResult.duration)}`);
    lines.push('');

    // Summary table
    lines.push('## Results');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
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

    // Failure details section (only if there are failures)
    const failures = runResult.results.filter(r => r.status === 'fail');
    if (failures.length > 0) {
        lines.push('## Failure Details');
        lines.push('');

        for (const config of failures) {
            lines.push(`### ${config.id}`);
            lines.push('');

            // Find the failing step(s)
            const failedSteps = config.steps.filter(s => s.status === 'fail');
            if (failedSteps.length > 0) {
                lines.push('| Stage | Error |');
                lines.push('|-------|-------|');
                for (const step of failedSteps) {
                    const errorSummary = step.error || config.error || 'Unknown error';
                    lines.push(`| ${step.name} | ${errorSummary} |`);
                }
            } else if (config.error) {
                lines.push(`**Error:** ${config.error}`);
            }

            lines.push('');
        }
    }

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
 * Save run artifacts (results.json and summary.md) to S3 and/or local directory.
 *
 * Strategy:
 * - If options.s3Bucket is configured, upload to S3 at runs/{tier}/{runId}/
 * - If options.saveLocal is specified OR no S3 bucket is configured,
 *   save to the specified directory (or .mlcc/e2e-results/{tier}/{runId}/ by default)
 * - S3 failures log a warning and continue (graceful degradation)
 * - Local save works independently of S3 status
 *
 * @param {object} runResult - The aggregated run result
 * @param {object} options - Save options
 * @param {string} [options.s3Bucket] - S3 bucket name for upload
 * @param {string} [options.saveLocal] - Local directory path (overrides default)
 * @param {string} [options.workspaceRoot='.'] - Workspace root for resolving relative paths
 * @returns {Promise<{s3: boolean, local: string|null}>} Result indicating what was saved
 */
export async function saveArtifacts(runResult, options = {}) {
    const jsonContent = formatJSON(runResult);
    const mdContent = formatMarkdown(runResult);
    const result = { s3: false, local: null };

    // S3 upload (when bucket is configured)
    if (options.s3Bucket) {
        try {
            const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
            const client = new S3Client();
            const prefix = `runs/${runResult.tier}/${runResult.runId}`;

            await client.send(new PutObjectCommand({
                Bucket: options.s3Bucket,
                Key: `${prefix}/results.json`,
                Body: jsonContent,
                ContentType: 'application/json'
            }));

            await client.send(new PutObjectCommand({
                Bucket: options.s3Bucket,
                Key: `${prefix}/summary.md`,
                Body: mdContent,
                ContentType: 'text/markdown'
            }));

            console.log(`📤 Artifacts uploaded to s3://${options.s3Bucket}/${prefix}/`);
            result.s3 = true;
        } catch (err) {
            console.warn(`⚠️  S3 upload failed: ${err.message}`);
            // Graceful degradation — continue to local save
        }
    }

    // Local save (explicit via --save-local, or fallback when no S3 bucket)
    const shouldSaveLocal = options.saveLocal || !options.s3Bucket;
    if (shouldSaveLocal) {
        const baseDir = options.saveLocal || '.mlcc/e2e-results';
        const workspaceRoot = options.workspaceRoot || '.';
        const dir = path.resolve(workspaceRoot, baseDir, runResult.tier, runResult.runId);

        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'results.json'), jsonContent);
        await writeFile(path.join(dir, 'summary.md'), mdContent);

        console.log(`📁 Artifacts saved to ${dir}`);
        result.local = dir;
    }

    return result;
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
