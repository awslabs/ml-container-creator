#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MlccCiHarnessStack } from '../lib/ci-harness-stack';

const app = new cdk.App();

// Region and account can be configured via:
// 1. CDK context: -c region=us-east-1 -c account=123456789012
// 2. Environment variables: CDK_DEFAULT_REGION, CDK_DEFAULT_ACCOUNT
// 3. AWS CLI profile (automatic via CDK)
const region = app.node.tryGetContext('region')
    || process.env.CDK_DEFAULT_REGION
    || process.env.AWS_REGION;

const account = app.node.tryGetContext('account')
    || process.env.CDK_DEFAULT_ACCOUNT
    || process.env.AWS_ACCOUNT_ID;

new MlccCiHarnessStack(app, 'MlccCiHarnessStack', {
    env: {
        region,
        account,
    },
    description: 'ML Container Creator CI Integration Harness - automated lifecycle testing infrastructure',
});
