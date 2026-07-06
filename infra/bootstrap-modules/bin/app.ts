#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK App entry point for modular bootstrap stacks.
 *
 * Reads context values (profileName, accountId, region) passed via
 * `--context` flags from the module-runner, and instantiates the
 * requested module stack.
 *
 * Usage:
 *   npx cdk deploy mlcc-<profile>-<module> \
 *     --context profileName=default \
 *     --context accountId=123456789012 \
 *     --context region=us-west-2
 */

import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as fs from 'fs';
import { MlccCoreStack } from '../core/stack';
import { MlccBenchmarkStack } from '../benchmark/stack';
import { MlccRegistryStack } from '../registry/stack';
import { MlccTrainingStack } from '../training/stack';
import { MlccCiStack } from '../ci/stack';
import { MlccSagemakerDomainStack } from '../sagemaker-domain/stack';
import { MlccHyperpodStack } from '../hyperpod-cluster/stack';

// Load module manifest
const manifestPath = path.resolve(__dirname, '..', 'module-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const app = new cdk.App();

// Read context
const profileName = app.node.tryGetContext('profileName') || 'default';
const accountId = app.node.tryGetContext('accountId');
const region = app.node.tryGetContext('region');
// When the runner detects a module's S3 bucket already exists (retained from a
// prior teardown), it passes adoptExistingBuckets=true so the stack adopts the
// bucket by reference instead of colliding on create.
const adoptExistingBuckets = app.node.tryGetContext('adoptExistingBuckets') === 'true';
// When the runner detects the core ECR repository already exists (retained from
// a prior teardown), it passes adoptExistingEcr=true so the core stack adopts
// the repo by reference instead of colliding on create.
const adoptExistingEcr = app.node.tryGetContext('adoptExistingEcr') === 'true';

const env: cdk.Environment = {
    account: accountId || process.env.CDK_DEFAULT_ACCOUNT,
    region: region || process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Stack name convention: mlcc-<profile>-<stackNameSuffix>
const stackName = (suffix: string) => `mlcc-${profileName}-${suffix}`;

// Instantiate all module stacks (CDK will only deploy the one specified on CLI)
new MlccCoreStack(app, stackName('core'), {
    env,
    profileName,
    adoptExistingEcr,
    description: `MLCC Core Infrastructure (profile: ${profileName})`,
});

new MlccBenchmarkStack(app, stackName('benchmark'), {
    env,
    profileName,
    adoptExistingBuckets,
    description: `MLCC Benchmark Infrastructure (profile: ${profileName})`,
});

new MlccRegistryStack(app, stackName('registry'), {
    env,
    profileName,
    description: `MLCC Model Registry (profile: ${profileName})`,
});

new MlccTrainingStack(app, stackName('training'), {
    env,
    profileName,
    adoptExistingBuckets,
    description: `MLCC Training Infrastructure (profile: ${profileName})`,
});

new MlccCiStack(app, stackName('ci'), {
    env,
    profileName,
    description: `MLCC CI/CD Pipeline (profile: ${profileName})`,
});

new MlccSagemakerDomainStack(app, stackName('sagemaker-domain'), {
    env,
    profileName,
    description: `MLCC SageMaker Studio Domain (profile: ${profileName})`,
});

new MlccHyperpodStack(app, stackName('hyperpod'), {
    env,
    profileName,
    description: `MLCC HyperPod Cluster (profile: ${profileName})`,
});
