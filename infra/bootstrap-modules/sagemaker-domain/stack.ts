// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface MlccSagemakerDomainStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * SageMaker Domain module: Studio domain + default user profile.
 */
export class MlccSagemakerDomainStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccSagemakerDomainStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'sagemaker-domain');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // Import core role
        const coreRoleArn = cdk.Fn.importValue(`mlcc-${profileName}-core-RoleArn`);

        // Use default VPC
        const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

        // SageMaker Domain
        const domain = new sagemaker.CfnDomain(this, 'StudioDomain', {
            domainName: `mlcc-studio-${profileName}`,
            authMode: 'IAM',
            defaultUserSettings: {
                executionRole: coreRoleArn,
            },
            vpcId: vpc.vpcId,
            subnetIds: vpc.publicSubnets.map(s => s.subnetId),
        });

        // Default user profile
        const userProfile = new sagemaker.CfnUserProfile(this, 'DefaultUser', {
            domainId: domain.attrDomainId,
            userProfileName: `mlcc-${profileName}-user`,
        });
        userProfile.addDependency(domain);

        // Outputs
        new cdk.CfnOutput(this, 'DomainId', {
            value: domain.attrDomainId,
            exportName: `mlcc-${profileName}-sagemaker-domain-DomainId`,
        });

        new cdk.CfnOutput(this, 'UserProfileName', {
            value: `mlcc-${profileName}-user`,
            exportName: `mlcc-${profileName}-sagemaker-domain-UserProfileName`,
        });
    }
}
