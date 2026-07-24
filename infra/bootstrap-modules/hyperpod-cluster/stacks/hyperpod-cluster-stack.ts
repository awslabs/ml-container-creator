// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface MlccHyperPodClusterStackProps extends cdk.StackProps {
    profileName: string;
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

        // Validate required inputs — during destroy, context may be empty.
        // Return early (empty stack) so CDK can still find and destroy it.
        if (!eksClusterArn) {
            return;
        }

        // ─── HyperPod CfnCluster ───────────────────────────────────────────

        const clusterName = `mlcc-${profileName}-hyperpod`;

        // LifeCycleConfig is required for all EKS-orchestrated instance groups,
        // even at 0 instances. Use the core models bucket for the lifecycle script.
        const lifecycleS3Uri = this.node.tryGetContext('lifecycleS3Uri')
            || `s3://mlcc-core-${this.account}-${this.region}/hyperpod-lifecycle/`;

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
                lifeCycleConfig: {
                    sourceS3Uri: lifecycleS3Uri,
                    onCreate: 'on_create.sh',
                },
            }],
            vpcConfig: {
                subnets: privateSubnetIds.split(',').filter(Boolean),
                securityGroupIds: [clusterSecurityGroupId].filter(Boolean),
            },
            nodeRecovery: 'Automatic',
        });

        // RemovalPolicy.DESTROY — cluster is deleted with the stack.
        // Billable resources should not be silently retained.
        cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

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
