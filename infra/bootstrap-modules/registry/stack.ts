// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface MlccRegistryStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * Registry module: Model Package Group + AI Registry Hub.
 * Supersedes hotfix-ai-registry-hub spec.
 */
export class MlccRegistryStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccRegistryStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'registry');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // Model Package Group
        const mpg = new sagemaker.CfnModelPackageGroup(this, 'ModelPackageGroup', {
            modelPackageGroupName: `mlcc-${profileName}-models`,
            modelPackageGroupDescription: `Model packages for ml-container-creator profile: ${profileName}`,
        });

        // AI Registry Hub (via custom resource — no L2 construct yet)
        const hubName = `mlcc-registry-${this.account}`;
        const createHub = new cr.AwsCustomResource(this, 'AiRegistryHub', {
            onCreate: {
                service: 'SageMaker',
                action: 'createHub',
                parameters: {
                    HubName: hubName,
                    // SageMaker HubDescription constraint: ^[a-zA-Z0-9](-*[a-zA-Z0-9 .,])*
                    // No parentheses or colons allowed.
                    HubDescription: `AI Registry Hub for ml-container-creator account ${this.account}`,
                },
                physicalResourceId: cr.PhysicalResourceId.of(hubName),
            },
            onDelete: {
                service: 'SageMaker',
                action: 'deleteHub',
                parameters: { HubName: hubName },
            },
            // createHub/deleteHub are in Lambda's built-in AWS SDK v3 — no need to
            // install the latest SDK at deploy time (faster cold start, pinned SDK).
            installLatestAwsSdk: false,
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: ['*'] }),
        });

        // Outputs
        new cdk.CfnOutput(this, 'ModelPackageGroupName', {
            value: mpg.modelPackageGroupName!,
            exportName: `mlcc-${profileName}-registry-ModelPackageGroupName`,
        });

        new cdk.CfnOutput(this, 'AiRegistryHubName', {
            value: hubName,
            exportName: `mlcc-${profileName}-registry-AiRegistryHubName`,
        });
    }
}
