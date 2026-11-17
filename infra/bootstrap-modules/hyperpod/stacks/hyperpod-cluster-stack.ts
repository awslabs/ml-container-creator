// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import CORE_BUCKETS from '../../core/buckets.json';
import { renderBucketName } from '../../bucket-declarations';

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
        cdk.Tags.of(this).add('mlcc:module', 'hyperpod');
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
            || 'ml.c5.4xlarge';

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
            || `s3://${renderBucketName(
                CORE_BUCKETS.buckets.ModelsBucketResource,
                { account: this.account, region: this.region, profileName },
            )}/hyperpod-lifecycle/`;

        const cluster = new sagemaker.CfnCluster(this, 'HyperPodCluster', {
            clusterName,
            orchestrator: {
                eks: {
                    clusterArn: eksClusterArn,
                },
            },
            // The default-worker group is the PERMANENT FLOOR that runs the HyperPod
            // Inference Operator's control-plane pods (gateway controller, controller
            // manager, ALB, KEDA — ~13 pods per the AWS operator-install minimum). These
            // are CPU/orchestration workloads: they do NOT need a GPU. GPU compute for
            // model-serving endpoints comes from SEPARATE instance groups attached on
            // demand (add via `aws sagemaker update-cluster`), so the always-on floor is
            // a cheap CPU instance (ml.c5.4xlarge — the AWS-documented operator minimum),
            // not a GPU node. Validated live: the 7 operator pods run comfortably on
            // 2 × ml.c5.4xlarge.
            //
            // The floor of 2 is a HyperPod SETUP requirement, not a capacity one — a
            // 0-instance (and empirically a 1-instance) EKS-orchestrated cluster does not
            // finish setup. Overridable via `defaultWorkerCount` context, but DO NOT go
            // below 2. These 2 × ml.c5.4xlarge are BILLABLE and run for the life of the
            // hyperpod module (see the module's cost estimate).
            instanceGroups: [{
                instanceCount: parseInt(this.node.tryGetContext('defaultWorkerCount'), 10) || 2,
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
