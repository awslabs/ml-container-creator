// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MLflow App provisioning — best-effort post-provision step for the training module.
 *
 * Creates an MLflow App (mlcc-tune-tracking) with an artifact S3 bucket
 * for experiment tracking. Non-fatal: if the MLflow service is unavailable
 * in the region or the CLI version doesn't support it, returns null and
 * the training module still functions (MLFLOW_APP_ARN will be absent).
 *
 * This is a plain CommonJS file (.cjs) so the handler can import it directly.
 */

const { execSync } = require('child_process');

/**
 * Execute an AWS CLI command and return parsed JSON output.
 * @param {string} command - AWS CLI command (without 'aws' prefix)
 * @param {string} profile - AWS profile name
 * @returns {object} Parsed JSON output
 */
function execAws(command, profile) {
    const profileFlag = profile ? `--profile ${profile}` : '';
    const fullCommand = `aws ${command} ${profileFlag} --output json`.replace(/\s+/g, ' ').trim();
    const output = execSync(fullCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = output.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed);
}

/**
 * Ensure an MLCC-owned MLflow App exists for experiment tracking.
 * Creates one if it doesn't exist, using a dedicated artifact S3 bucket.
 *
 * Best-effort: returns null on failure rather than throwing.
 *
 * @param {object} opts
 * @param {string} opts.accountId - AWS account ID
 * @param {string} opts.awsRegion - AWS region
 * @param {string} opts.awsProfile - AWS CLI profile name
 * @param {string} opts.roleArn - IAM role ARN for the MLflow App
 * @returns {string|null} MLflow App ARN, or null if provisioning failed/unavailable
 */
function ensureMlflowApp({ accountId, awsRegion, awsProfile, roleArn }) {
    const appName = 'mlcc-tune-tracking';
    const artifactBucket = `mlcc-tune-${accountId}-${awsRegion}`;

    // Check if MLCC app already exists
    try {
        const apps = execAws(`sagemaker list-mlflow-apps --region ${awsRegion}`, awsProfile);
        const summaries = apps.Summaries || [];
        const existing = summaries.find(a => a.Name === appName);
        if (existing) {
            return existing.Arn;
        }
    } catch {
        // list-mlflow-apps may not be available in all CLI versions — proceed to create
    }

    // Ensure the artifact bucket exists
    try {
        execAws(`s3api head-bucket --bucket ${artifactBucket} --region ${awsRegion}`, awsProfile);
    } catch {
        // Bucket doesn't exist — create it
        try {
            if (awsRegion === 'us-east-1') {
                execAws(`s3api create-bucket --bucket ${artifactBucket} --region ${awsRegion}`, awsProfile);
            } else {
                execAws(
                    `s3api create-bucket --bucket ${artifactBucket} --region ${awsRegion} --create-bucket-configuration LocationConstraint=${awsRegion}`,
                    awsProfile
                );
            }
        } catch {
            // Bucket may already exist (BucketAlreadyOwnedByYou) — continue
        }
    }

    // Create the MLflow App
    try {
        const result = execAws(
            `sagemaker create-mlflow-app --name ${appName} --artifact-store-uri s3://${artifactBucket} --role-arn ${roleArn} --model-registration-mode AutoModelRegistrationEnabled --region ${awsRegion}`,
            awsProfile
        );
        return result.Arn || null;
    } catch (err) {
        // If app already exists (race condition), try to retrieve it
        if (err.message && (err.message.includes('ResourceLimitExceeded') || err.message.includes('already exists'))) {
            try {
                const apps = execAws(`sagemaker list-mlflow-apps --region ${awsRegion}`, awsProfile);
                const found = (apps.Summaries || []).find(a => a.Name === appName);
                if (found) return found.Arn;
            } catch {
                // Fall through to return null
            }
        }
        // Best-effort — return null instead of throwing
        return null;
    }
}

module.exports = { ensureMlflowApp };
