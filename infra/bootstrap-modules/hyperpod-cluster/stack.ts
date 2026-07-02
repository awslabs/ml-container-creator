// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface MlccHyperpodStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * HyperPod module: Cluster configuration stored in SSM Parameter Store.
 * Lightweight — actual compute instances are provisioned on-demand by HyperPod.
 */
export class MlccHyperpodStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccHyperpodStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'hyperpod-cluster');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // Store cluster configuration in SSM (actual cluster is created via HyperPod API)
        const clusterConfigParam = new ssm.StringParameter(this, 'ClusterConfig', {
            parameterName: `/mlcc/${profileName}/hyperpod/cluster-config`,
            stringValue: JSON.stringify({
                profileName,
                createdAt: new Date().toISOString(),
                status: 'configured',
            }),
            description: `HyperPod cluster configuration for mlcc profile: ${profileName}`,
        });

        // Outputs (placeholder — actual ARN comes from HyperPod CreateCluster)
        new cdk.CfnOutput(this, 'ClusterArn', {
            value: `arn:aws:sagemaker:${this.region}:${this.account}:cluster/mlcc-${profileName}`,
            exportName: `mlcc-${profileName}-hyperpod-ClusterArn`,
        });

        new cdk.CfnOutput(this, 'ClusterName', {
            value: `mlcc-${profileName}`,
            exportName: `mlcc-${profileName}-hyperpod-ClusterName`,
        });
    }
}
