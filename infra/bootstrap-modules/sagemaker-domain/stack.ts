// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface MlccSagemakerDomainStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * SageMaker Domain module: Studio domain + default user profile.
 *
 * Creates a dedicated Studio execution role separate from the inference
 * execution role — Studio requires a broader set of permissions than
 * inference (Spaces, JupyterServer, KernelGateway, etc.).
 */
export class MlccSagemakerDomainStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccSagemakerDomainStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'sagemaker-domain');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // ── Studio Execution Role ─────────────────────────────────────────────
        // Separate from the inference execution role — Studio needs a broader
        // permission set including Spaces, JupyterServer, S3 for notebooks, etc.
        const studioRole = new iam.Role(this, 'StudioExecutionRole', {
            roleName: `mlcc-studio-execution-role-${profileName}`,
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            description: `SageMaker Studio execution role for MLCC profile ${profileName}`,
            managedPolicies: [
                // AWS managed policy for SageMaker full access — covers Studio UI requirements
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
                // S3 read/write for notebook artifacts and datasets
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
            ],
        });

        // Inline policy for Studio-specific operations not covered by the managed policy
        studioRole.addToPolicy(new iam.PolicyStatement({
            sid: 'StudioSpacesAndApps',
            effect: iam.Effect.ALLOW,
            actions: [
                // Spaces (required by new Studio UI)
                'sagemaker:ListSpaces',
                'sagemaker:CreateSpace',
                'sagemaker:DescribeSpace',
                'sagemaker:DeleteSpace',
                'sagemaker:UpdateSpace',
                // Apps
                'sagemaker:CreateApp',
                'sagemaker:DeleteApp',
                'sagemaker:DescribeApp',
                'sagemaker:ListApps',
                // User profiles
                'sagemaker:CreateUserProfile',
                'sagemaker:DescribeUserProfile',
                'sagemaker:ListUserProfiles',
                'sagemaker:UpdateUserProfile',
                // Domain
                'sagemaker:DescribeDomain',
                'sagemaker:ListDomains',
            ],
            resources: ['*'],
        }));

        // Tag the role
        cdk.Tags.of(studioRole).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(studioRole).add('mlcc:module', 'sagemaker-domain');

        // ── VPC ───────────────────────────────────────────────────────────────
        const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

        // ── SageMaker Domain ──────────────────────────────────────────────────
        const domain = new sagemaker.CfnDomain(this, 'StudioDomain', {
            domainName: `mlcc-studio-${profileName}`,
            authMode: 'IAM',
            defaultUserSettings: {
                executionRole: studioRole.roleArn,
                jupyterLabAppSettings: {
                    defaultResourceSpec: {
                        instanceType: 'ml.t3.medium',
                    },
                },
            },
            vpcId: vpc.vpcId,
            subnetIds: vpc.publicSubnets.map(s => s.subnetId),
        });

        // ── Default user profile ──────────────────────────────────────────────
        const userProfile = new sagemaker.CfnUserProfile(this, 'DefaultUser', {
            domainId: domain.attrDomainId,
            userProfileName: `mlcc-${profileName}-user`,
            userSettings: {
                executionRole: studioRole.roleArn,
            },
        });
        userProfile.addDependency(domain);

        // ── Outputs ───────────────────────────────────────────────────────────
        new cdk.CfnOutput(this, 'DomainId', {
            value: domain.attrDomainId,
            exportName: `mlcc-${profileName}-sagemaker-domain-DomainId`,
        });

        new cdk.CfnOutput(this, 'UserProfileName', {
            value: `mlcc-${profileName}-user`,
            exportName: `mlcc-${profileName}-sagemaker-domain-UserProfileName`,
        });

        new cdk.CfnOutput(this, 'StudioExecutionRoleArn', {
            value: studioRole.roleArn,
            exportName: `mlcc-${profileName}-sagemaker-domain-StudioRoleArn`,
        });
    }
}
