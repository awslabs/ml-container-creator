// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * MLflow App provisioning — best-effort post-provision step for the training module.
 *
 * Ensures the MLCC MLflow App (mlcc-tune-tracking) exists for experiment tracking.
 * The App stays outside CloudFormation (owner decision D3), but its artifact store is
 * the training stack's declared, CloudFormation-owned artifacts bucket: the caller
 * passes that bucket's name from the stack output (moduleOutputs.training.
 * ArtifactsBucket). This module NEVER creates a bucket and NEVER builds a bucket name
 * (bucket consolidation R1.7 / R2.2).
 *
 * Non-fatal: if the MLflow service is unavailable in the region, the CLI version
 * doesn't support it, or no artifacts bucket was provided, returns null and the
 * training module still functions (MLFLOW_APP_ARN will be absent).
 *
 * This is a plain CommonJS file (.cjs) so the handler can import it directly.
 */
const { execFileSync } = require('child_process');

const MLFLOW_APP_NAME = 'mlcc-tune-tracking';

/**
 * Execute an AWS CLI command (argv form, no shell) and return parsed JSON output.
 * @param {string[]} args - AWS CLI arguments (without 'aws')
 * @param {string} profile - AWS profile name
 * @returns {object} Parsed JSON output
 */
function execAws(args, profile) {
    const argv = [...args, '--output', 'json'];
    if (profile) argv.push('--profile', profile);
    const output = execFileSync('aws', argv, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = output.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed);
}

/**
 * Extract the bucket from an S3 URI (`s3://bucket[/prefix]`).
 * @param {string} uri
 * @returns {string|null}
 */
function bucketFromS3Uri(uri) {
    const m = /^s3:\/\/([^/]+)/.exec(String(uri || ''));
    return m ? m[1] : null;
}

/**
 * Ensure an MLCC-owned MLflow App exists for experiment tracking, using the given
 * (CloudFormation-owned) artifacts bucket as its artifact store.
 *
 * Best-effort: returns null on failure rather than throwing.
 *
 * @param {object} opts
 * @param {string} opts.awsRegion - AWS region
 * @param {string} opts.awsProfile - AWS CLI profile name
 * @param {string} opts.roleArn - IAM role ARN for the MLflow App
 * @param {string} [opts.artifactsBucket] - artifacts bucket name from the training
 *   stack output. Required to CREATE an App; an existing App is returned as-is.
 * @param {Function} [opts.exec] - injectable execAws (tests)
 * @returns {string|null} MLflow App ARN, or null if provisioning failed/unavailable
 */
function ensureMlflowApp({ awsRegion, awsProfile, roleArn, artifactsBucket, exec = execAws }) {
    // Check if MLCC app already exists
    try {
        const apps = exec(['sagemaker', 'list-mlflow-apps', '--region', awsRegion], awsProfile);
        const existing = (apps.Summaries || []).find(a => a.Name === MLFLOW_APP_NAME);
        if (existing) {
            return existing.Arn;
        }
    } catch {
        // list-mlflow-apps may not be available in all CLI versions — proceed to create
    }
    if (!artifactsBucket) {
        // No declared artifacts bucket (training stack output missing) — never guess one.
        console.log('  ⚠  MLflow App not created: the training stack reported no ArtifactsBucket output.');
        console.log('     Re-run `ml-container-creator bootstrap update --module training`, then retry.');
        return null;
    }
    // Create the MLflow App on the declared artifacts bucket (no bucket is created here).
    try {
        const result = exec([
            'sagemaker', 'create-mlflow-app',
            '--name', MLFLOW_APP_NAME,
            '--artifact-store-uri', `s3://${artifactsBucket}`,
            '--role-arn', roleArn,
            '--model-registration-mode', 'AutoModelRegistrationEnabled',
            '--region', awsRegion
        ], awsProfile);
        return result.Arn || null;
    } catch (err) {
        // If app already exists (race condition), try to retrieve it
        if (err.message && (err.message.includes('ResourceLimitExceeded') || err.message.includes('already exists'))) {
            try {
                const apps = exec(['sagemaker', 'list-mlflow-apps', '--region', awsRegion], awsProfile);
                const found = (apps.Summaries || []).find(a => a.Name === MLFLOW_APP_NAME);
                if (found) return found.Arn;
            } catch {
                // Fall through to return null
            }
        }
        // Best-effort — return null instead of throwing
        return null;
    }
}

/**
 * Read the artifacts bucket an EXISTING MLflow App records as its artifact store
 * (`describe-mlflow-app` ArtifactStoreUri). Used to seed `artifactsS3Bucket` for
 * profiles created before the training stack exported ArtifactsBucket — a declared
 * source recorded by the App itself, never a name pattern (R1.7).
 *
 * @param {object} opts
 * @param {string} opts.mlflowAppArn
 * @param {string} opts.awsRegion
 * @param {string} [opts.awsProfile]
 * @param {Function} [opts.exec] - injectable execAws (tests)
 * @returns {string|null} bucket name, or null when it cannot be read
 */
function artifactsBucketFromMlflowApp({ mlflowAppArn, awsRegion, awsProfile, exec = execAws }) {
    if (!mlflowAppArn) return null;
    try {
        const app = exec(['sagemaker', 'describe-mlflow-app', '--arn', mlflowAppArn, '--region', awsRegion], awsProfile);
        return bucketFromS3Uri(app.ArtifactStoreUri);
    } catch {
        return null;
    }
}

module.exports = { ensureMlflowApp, artifactsBucketFromMlflowApp, bucketFromS3Uri, MLFLOW_APP_NAME };
