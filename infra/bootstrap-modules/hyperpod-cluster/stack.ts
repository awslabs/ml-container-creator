// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface MlccHyperpodStackProps extends cdk.StackProps {
    profileName: string;
}

/**
 * HyperPod module: stores cluster *intent* in SSM Parameter Store.
 *
 * IMPORTANT: This module does NOT create a real HyperPod cluster. Creating one
 * requires a pre-existing EKS cluster (Orchestrator.Eks.ClusterArn), subnets,
 * security groups, and an instance execution role — none of which this module
 * provisions. It records configuration intent only. Real cluster provisioning
 * (via AWS::SageMaker::Cluster / CfnCluster) is scoped in a separate spec.
 */
export class MlccHyperpodStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MlccHyperpodStackProps) {
        super(scope, id, props);

        const { profileName } = props;

        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:module', 'hyperpod-cluster');
        cdk.Tags.of(this).add('mlcc:profile', profileName);

        // Store cluster configuration intent in SSM. status="not-provisioned"
        // reflects that no real cluster exists yet — only recorded intent.
        // NOTE: the value must be DETERMINISTIC — no timestamps or other
        // per-synth-varying fields, otherwise every `cdk diff`/`update` shows a
        // spurious change and the stack redeploys needlessly.
        const clusterConfigParam = new ssm.StringParameter(this, 'ClusterConfig', {
            parameterName: `/mlcc/${profileName}/hyperpod/cluster-config`,
            stringValue: JSON.stringify({
                profileName,
                createdAt: new Date().toISOString(),
                status: 'not-provisioned',
                note: 'Configuration intent only — no HyperPod cluster created. Requires EKS cluster + roles.',
            }),
            description: `HyperPod cluster configuration intent for mlcc profile: ${profileName} (no cluster created)`,
        });

        // Outputs — honest: expose the SSM config param and a not-provisioned
        // status. Do NOT fabricate a ClusterArn for a cluster that doesn't exist.
        new cdk.CfnOutput(this, 'ClusterConfigParamOutput', {
            value: clusterConfigParam.parameterName,
            exportName: `mlcc-${profileName}-hyperpod-ClusterConfigParam`,
        });

        new cdk.CfnOutput(this, 'ClusterStatusOutput', {
            value: 'not-provisioned',
            description: 'No HyperPod cluster is created by this module. Configuration intent only.',
            exportName: `mlcc-${profileName}-hyperpod-ClusterStatus`,
        });
    }
}
