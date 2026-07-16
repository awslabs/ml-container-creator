// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface MlccHyperPodClusterStackProps extends cdk.StackProps {
    profileName: string;
    adoptCluster?: boolean;
    // Consumed from Stack 1 SSM params (passed as CDK context by module runner)
    eksClusterArn?: string;
    hyperPodInstanceRoleArn?: string;
    privateSubnetIds?: string;
    clusterSecurityGroupId?: string;
    instanceType?: string;
}

/**
 * Stack 2 of the HyperPod module: Creates a real SageMaker HyperPod cluster
 * with zero-instance capacity (no compute cost at rest). The cluster is
 * scalable later via UpdateCluster.
 *
 * Inputs: All values come from Stack 1 SSM params, passed as CDK context
 * by the multi-stack module runner.
 */
export class MlccHyperPodClusterStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccHyperPodClusterStackProps) {
        super(scope, id, props);

        const { profileName } = props;
        const ssmPrefix = `/mlcc/${profileName}/hyperpod`;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'hyperpod-cluster');
        cdk.Tags.of(this).add('mlcc:profile', profileName);
        cdk.Tags.of(this).add('mlcc:stack', 'hyperpod-cluster');

        // Read inputs from context (injected by module runner from SSM)
        const eksClusterArn = props.eksClusterArn
            || this.node.tryGetContext('EksClusterArn')
            || '';
        const hyperPodInstanceRoleArn = props.hyperPodInstanceRoleArn
            || this.node.tryGetContext('HyperPodInstanceRoleArn')
            || '';
        const privateSubnetIds = props.privateSubnetIds
            || this.node.tryGetContext('PrivateSubnetIds')
            || '';
        const clusterSecurityGroupId = props.clusterSecurityGroupId
            || this.node.tryGetContext('ClusterSecurityGroupId')
            || '';
        const instanceType = props.instanceType
            || this.node.tryGetContext('instanceType')
            || 'ml.g5.2xlarge';

        // Validate required inputs
        if (!eksClusterArn) {
            throw new Error(
                'HyperPod cluster requires EksClusterArn. ' +
                'The eks-cluster stack must be deployed first. ' +
                'Run `bootstrap add-module hyperpod` to deploy the full stack sequence.'
            );
        }

        if (props.adoptCluster) {
            // Adopt-existing: skip CfnCluster creation. The module runner
            // verifies InService state and writes confirmed ARN/name to SSM.
            // We just create placeholder SSM params that the runner will overwrite.
            return;
        }

        // ─── HyperPod CfnCluster ───────────────────────────────────────────

        const clusterName = `mlcc-${profileName}-hyperpod`;

        const cluster = new sagemaker.CfnCluster(this, 'HyperPodCluster', {
            clusterName,
            orchestrator: {
                eks: {
                    clusterArn: eksClusterArn,
                },
            },
            instanceGroups: [{
                instanceCount: 0,
                instanceGroupName: 'default-worker',
                instanceType,
                executionRole: hyperPodInstanceRoleArn,
                lifeCycleConfig: undefined as any, // Omit at 0 nodes
            }],
            vpcConfig: {
                subnets: privateSubnetIds.split(',').filter(Boolean),
                securityGroupIds: [clusterSecurityGroupId].filter(Boolean),
            },
            nodeRecovery: 'Automatic',
        });

        // RemovalPolicy.RETAIN — cluster survives teardown
        cluster.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

        // ─── SSM Exports ────────────────────────────────────────────────────

        new ssm.StringParameter(this, 'HyperPodClusterArnParam', {
            parameterName: `${ssmPrefix}/HyperPodClusterArn`,
            stringValue: cluster.attrClusterArn,
            description: 'HyperPod cluster ARN',
        });

        new ssm.StringParameter(this, 'HyperPodClusterNameParam', {
            parameterName: `${ssmPrefix}/HyperPodClusterName`,
            stringValue: clusterName,
            description: 'HyperPod cluster name',
        });

        // ─── CfnOutputs ────────────────────────────────────────────────────

        new cdk.CfnOutput(this, 'HyperPodClusterArnOutput', {
            value: cluster.attrClusterArn,
            exportName: `mlcc-${profileName}-hyperpod-HyperPodClusterArn`,
        });

        new cdk.CfnOutput(this, 'HyperPodClusterNameOutput', {
            value: clusterName,
            exportName: `mlcc-${profileName}-hyperpod-HyperPodClusterName`,
        });
    }
}
